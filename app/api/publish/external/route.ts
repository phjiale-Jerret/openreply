import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { isExternalApiAuthorized } from "@/lib/external-api-auth";

/**
 * Queue a reel to publish at a set time (no dashboard session).
 *
 * The video must already sit at a public URL (the upload script puts it in
 * Vercel Blob). The worker uploads it to Instagram 15 minutes before
 * publishAt, publishes at publishAt, then deletes the blob.
 */

export const dynamic = "force-dynamic";

const scheduledPostSchema = z.object({
  name: z.string().trim().min(1).max(100),
  videoUrl: z.string().url(),
  caption: z.string().max(2200),
  publishAt: z.string().datetime({ offset: true }),
  coverUrl: z.string().url().optional(),
  thumbOffsetMs: z.number().int().min(0).optional(),
  shareToFeed: z.boolean().optional().default(true),
  firstComment: z.string().trim().min(1).max(2200).optional(),
  // Only needed when more than one Instagram account is connected.
  instagramUsername: z.string().trim().min(1).optional(),
});

function unauthorized() {
  return NextResponse.json(
    { success: false, error: "Unauthorized" },
    { status: 401 }
  );
}

export async function POST(request: NextRequest) {
  if (!isExternalApiAuthorized(request)) return unauthorized();

  const body = await request.json().catch(() => null);
  const parsed = scheduledPostSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const input = parsed.data;

  const accounts = await prisma.instagramAccount.findMany({
    where: input.instagramUsername
      ? {
          username: {
            equals: input.instagramUsername.replace(/^@/, ""),
            mode: "insensitive",
          },
        }
      : {},
    select: { id: true, username: true },
    take: 2,
  });
  if (accounts.length !== 1) {
    return NextResponse.json(
      {
        success: false,
        error:
          accounts.length === 0
            ? "Instagram account not found"
            : "More than one Instagram account is connected; pass instagramUsername",
      },
      { status: 400 }
    );
  }

  const post = await prisma.scheduledPost.create({
    data: {
      instagramAccountId: accounts[0].id,
      name: input.name,
      videoUrl: input.videoUrl,
      caption: input.caption,
      publishAt: new Date(input.publishAt),
      coverUrl: input.coverUrl,
      thumbOffsetMs: input.thumbOffsetMs,
      shareToFeed: input.shareToFeed,
      firstComment: input.firstComment,
    },
  });

  return NextResponse.json(
    { success: true, scheduledPost: post, instagramUsername: accounts[0].username },
    { status: 201 }
  );
}

export async function GET(request: NextRequest) {
  if (!isExternalApiAuthorized(request)) return unauthorized();

  const posts = await prisma.scheduledPost.findMany({
    orderBy: { publishAt: "desc" },
    take: 50,
    select: {
      id: true,
      name: true,
      publishAt: true,
      status: true,
      permalink: true,
      attempts: true,
      lastError: true,
      publishedAt: true,
    },
  });
  return NextResponse.json({ success: true, scheduledPosts: posts });
}
