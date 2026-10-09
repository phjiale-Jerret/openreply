import { del } from "@vercel/blob";
import { prisma } from "@/lib/db/client";
import { getBaseUrl } from "@/lib/env";
import { decryptToken } from "@/lib/meta/oauth";
import {
  MetaApiError,
  RateLimitError,
  createCarouselContainer,
  createCarouselItemContainer,
  createMediaComment,
  createReelContainer,
  getContainerStatus,
  getMediaPermalink,
  publishContainer,
} from "@/lib/meta/client";

// Upload to Instagram this long before publishAt, so the video is processed
// and ready when the publish time comes.
const PREPARE_LEAD_MS = 15 * 60_000;
// Give up on a container still processing this long after publishAt.
const PROCESSING_TIMEOUT_MS = 60 * 60_000;
// A claimed post with no container after this long was interrupted mid-claim.
const STALE_CLAIM_MS = 5 * 60_000;
const MAX_ATTEMPTS = 3;

type PostWithAccount = Awaited<ReturnType<typeof loadPosts>>[number];

function loadPosts(where: Parameters<typeof prisma.scheduledPost.findMany>[0]) {
  return prisma.scheduledPost.findMany({
    ...where,
    include: { instagramAccount: true },
    orderBy: { publishAt: "asc" },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Rate limits and plain network failures are worth retrying; a Meta error
// such as a rejected video or a missing permission is not.
function isTransient(error: unknown): boolean {
  if (error instanceof RateLimitError) return true;
  return !(error instanceof MetaApiError);
}

// The worker has no mail key; the web app (which does) sends the email. The
// route reads the outcome from the database, so the call carries only the id.
async function notify(postId: string) {
  try {
    const response = await fetch(`${getBaseUrl()}/api/publish/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: postId }),
    });
    if (!response.ok) {
      console.error("[scheduled-posts] notify failed", response.status, await response.text());
    }
  } catch (error) {
    console.error("[scheduled-posts] notify failed", errorMessage(error));
  }
}

async function recordEvent(
  post: PostWithAccount,
  level: "INFO" | "ERROR",
  message: string
) {
  await prisma.operationalEvent
    .create({
      data: {
        workspaceId: post.instagramAccount.workspaceId,
        source: "WORKER",
        level,
        message,
        payload: { scheduledPostId: post.id, name: post.name },
      },
    })
    .catch(() => {});
}

async function deleteBlobs(post: PostWithAccount) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return;
  const urls = [post.videoUrl, post.coverUrl, ...post.imageUrls].filter(
    (url): url is string =>
      !!url && new URL(url).hostname.endsWith("blob.vercel-storage.com")
  );
  if (urls.length === 0) return;
  try {
    await del(urls);
  } catch (error) {
    console.error("[scheduled-posts] blob delete failed", errorMessage(error));
  }
}

// Image items usually finish at once; wait briefly so the parent container
// is not created over children Instagram is still fetching.
async function waitForItems(token: string, ids: string[]) {
  for (let i = 0; i < 10; i++) {
    const statuses = await Promise.all(ids.map((id) => getContainerStatus(token, id)));
    const bad = statuses.find((s) => s.status_code === "ERROR" || s.status_code === "EXPIRED");
    if (bad) {
      throw new MetaApiError(0, undefined, undefined, `carousel item ${bad.status_code}: ${bad.status ?? ""}`);
    }
    if (statuses.every((s) => s.status_code === "FINISHED")) return;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

async function fail(post: PostWithAccount, error: unknown, stage: string) {
  const attempts = post.attempts + 1;
  const message = `${stage}: ${errorMessage(error)}`;

  if (isTransient(error) && attempts < MAX_ATTEMPTS) {
    // Retry from scratch on the next tick.
    await prisma.scheduledPost.update({
      where: { id: post.id },
      data: { status: "PENDING", containerId: null, attempts, lastError: message },
    });
    console.warn(`[scheduled-posts] ${post.name} retry ${attempts}:`, message);
    return;
  }

  await prisma.scheduledPost.update({
    where: { id: post.id },
    data: { status: "FAILED", attempts, lastError: message },
  });
  await recordEvent(post, "ERROR", `Scheduled post failed: ${post.name}`);
  await notify(post.id);
}

async function prepare(post: PostWithAccount) {
  try {
    const token = decryptToken(post.instagramAccount.accessToken);
    const instagramId = post.instagramAccount.instagramId;
    let container: { id: string };
    if (post.imageUrls.length > 0) {
      const childIds: string[] = [];
      for (const imageUrl of post.imageUrls) {
        childIds.push((await createCarouselItemContainer(token, instagramId, imageUrl)).id);
      }
      await waitForItems(token, childIds);
      container = await createCarouselContainer(token, instagramId, {
        childIds,
        caption: post.caption,
      });
    } else {
      container = await createReelContainer(token, instagramId, {
        videoUrl: post.videoUrl!,
        caption: post.caption,
        coverUrl: post.coverUrl,
        thumbOffsetMs: post.thumbOffsetMs,
        shareToFeed: post.shareToFeed,
      });
    }
    await prisma.scheduledPost.update({
      where: { id: post.id },
      data: { containerId: container.id },
    });
  } catch (error) {
    await fail(post, error, "upload");
  }
}

async function publish(post: PostWithAccount, now: Date) {
  const token = decryptToken(post.instagramAccount.accessToken);
  const instagramId = post.instagramAccount.instagramId;

  let statusCode: string;
  try {
    const status = await getContainerStatus(token, post.containerId!);
    statusCode = status.status_code;
    if (statusCode === "ERROR" || statusCode === "EXPIRED") {
      await fail(post, new MetaApiError(0, undefined, undefined, `container ${statusCode}: ${status.status ?? ""}`), "processing");
      return;
    }
  } catch (error) {
    await fail(post, error, "status");
    return;
  }

  if (statusCode === "IN_PROGRESS") {
    if (now.getTime() - post.publishAt.getTime() > PROCESSING_TIMEOUT_MS) {
      await fail(post, new MetaApiError(0, undefined, undefined, "Instagram still processing the post after 60 minutes"), "processing");
    }
    return;
  }
  if (statusCode !== "FINISHED" || now < post.publishAt) return;

  let mediaId: string;
  try {
    mediaId = (await publishContainer(token, instagramId, post.containerId!)).id;
  } catch (error) {
    // The container stays valid for 24h, so a transient error keeps it and
    // retries the publish call on the next tick.
    const attempts = post.attempts + 1;
    if (isTransient(error) && attempts < MAX_ATTEMPTS) {
      await prisma.scheduledPost.update({
        where: { id: post.id },
        data: { attempts, lastError: `publish: ${errorMessage(error)}` },
      });
      return;
    }
    await fail(post, error, "publish");
    return;
  }

  const permalink = await getMediaPermalink(token, mediaId).catch(() => undefined);
  await prisma.scheduledPost.update({
    where: { id: post.id },
    data: { status: "PUBLISHED", mediaId, permalink, publishedAt: new Date(), lastError: null },
  });

  if (post.firstComment) {
    try {
      await createMediaComment(token, mediaId, post.firstComment);
    } catch (error) {
      await prisma.scheduledPost.update({
        where: { id: post.id },
        data: { lastError: `first comment: ${errorMessage(error)}` },
      });
    }
  }
  await deleteBlobs(post);
  await recordEvent(post, "INFO", `Scheduled post published: ${post.name}`);
  await notify(post.id);
}

export type ProcessScheduledPostsResult = { prepared: number; checked: number };

/**
 * One tick of the publisher: upload reels and carousels that are due soon, then publish the
 * ones whose time has come. Safe to run every minute; each post moves through
 * PENDING → PROCESSING (container uploaded) → PUBLISHED or FAILED.
 */
export async function processScheduledPosts(
  now = new Date()
): Promise<ProcessScheduledPostsResult> {
  // A claim that never got a container (worker restarted mid-call) goes back.
  await prisma.scheduledPost.updateMany({
    where: {
      status: "PROCESSING",
      containerId: null,
      updatedAt: { lt: new Date(now.getTime() - STALE_CLAIM_MS) },
    },
    data: { status: "PENDING" },
  });

  const due = await loadPosts({
    where: {
      status: "PENDING",
      publishAt: { lte: new Date(now.getTime() + PREPARE_LEAD_MS) },
    },
  });
  let prepared = 0;
  for (const post of due) {
    if (post.instagramAccount.provider !== "META") continue;
    const claim = await prisma.scheduledPost.updateMany({
      where: { id: post.id, status: "PENDING" },
      data: { status: "PROCESSING" },
    });
    if (claim.count === 0) continue;
    await prepare(post);
    prepared++;
  }

  const processing = await loadPosts({
    where: { status: "PROCESSING", containerId: { not: null } },
  });
  for (const post of processing) {
    await publish(post, now);
  }

  return { prepared, checked: processing.length };
}
