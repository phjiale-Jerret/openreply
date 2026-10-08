import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { buildInitialCampaignLinks } from "@/lib/campaigns/links";
import { generateReportShareSlug } from "@/lib/reports/share";
import { isExternalApiAuthorized } from "@/lib/external-api-auth";

/**
 * Create a campaign from a script (no dashboard session).
 *
 * Auth is a bearer key in AUTOMATION_API_KEY. Every campaign made here waits
 * for the next reel (or any post with anyMediaType) and binds only to one whose caption contains captionMatch
 * (default: 留言「<first keyword>」), so publishing a different reel first does
 * not steal it. The follow gate, link button and no-opening-DM settings are
 * fixed to the channel's house style.
 */

export const dynamic = "force-dynamic";

const FOLLOW_PROMPT_MESSAGE =
  "先追蹤 @jerret.ai.lens，追蹤好按下面按鈕就傳給你 🙏";
const FOLLOW_PROMPT_BUTTON_LABEL = "我追蹤了 ✅";
const LINK_BUTTON_LABEL = "打開資料頁";

const externalAutomationSchema = z.object({
  name: z.string().trim().min(1).max(100),
  keywords: z.array(z.string().trim().min(1).max(50)).min(1).max(10),
  // Chinese keywords are usually glued to other text, so partial match is the
  // default here (the dashboard defaults to whole word).
  wholeWordMatch: z.boolean().optional().default(false),
  // Rotating public replies, one per array item (the dashboard's format).
  publicReplyMessages: z.array(z.string().trim().min(1).max(1000)).min(1).max(10),
  dmMessage: z.string().trim().min(1).max(1000),
  linkUrl: z.string().url(),
  linkButtonLabel: z.string().trim().min(1).max(20).optional(),
  captionMatch: z.string().trim().min(1).max(200).optional(),
  // true: also bind a carousel or image post (default: reels only).
  anyMediaType: z.boolean().optional().default(false),
  // Only needed when more than one Instagram account is connected.
  instagramUsername: z.string().trim().min(1).optional(),
});

export async function POST(request: NextRequest) {
  if (!isExternalApiAuthorized(request)) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const body = await request.json().catch(() => null);
  const parsed = externalAutomationSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        error: "Invalid input",
        details: parsed.error.flatten(),
      },
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
    select: { id: true, workspaceId: true, username: true },
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
  const account = accounts[0];

  const captionMatch = input.captionMatch ?? `留言「${input.keywords[0]}」`;

  // Two pending campaigns with the same caption text would race for one reel.
  const conflicts = await prisma.automation.findMany({
    where: {
      instagramAccountId: account.id,
      pendingNextReel: true,
      captionMatch,
    },
    select: { id: true, name: true },
  });
  if (conflicts.length > 0) {
    return NextResponse.json(
      {
        success: false,
        error: `Another pending campaign already waits for a caption containing "${captionMatch}"`,
        conflicts: conflicts.map((c) => c.name),
      },
      { status: 409 }
    );
  }

  const linkCreates = buildInitialCampaignLinks({
    workspaceId: account.workspaceId,
    primaryUrl: input.linkUrl,
  });

  const automation = await prisma.automation.create({
    data: {
      name: input.name,
      postId: null,
      postUrl: null,
      pendingNextReel: true,
      captionMatch,
      bindAnyMediaType: input.anyMediaType,
      matchAnyPost: false,
      keywords: input.keywords,
      matchAnyWord: false,
      wholeWordMatch: input.wholeWordMatch,
      dmMessage: input.dmMessage,
      openingDmEnabled: false,
      openingDmMessage: null,
      openingDmButtonLabel: null,
      linkButtonLabel: input.linkButtonLabel ?? LINK_BUTTON_LABEL,
      requireFollow: true,
      followPromptMessage: FOLLOW_PROMPT_MESSAGE,
      followPromptButtonLabel: FOLLOW_PROMPT_BUTTON_LABEL,
      publicReplyEnabled: true,
      publicReplyMessages: input.publicReplyMessages,
      publicReplyMessage: input.publicReplyMessages[0],
      isActive: true,
      workspaceId: account.workspaceId,
      instagramAccountId: account.id,
      reportShareSlug: generateReportShareSlug(),
      trackedLinks: { create: linkCreates },
    },
    include: { trackedLinks: true },
  });

  return NextResponse.json(
    { success: true, data: automation },
    { status: 201 }
  );
}
