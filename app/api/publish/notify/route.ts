import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";

/**
 * Email the owner the outcome of a scheduled post. Called by the worker,
 * which has no mail key. No auth on purpose: the body is only an id, the
 * content comes from the database, and each outcome is sent at most once, so
 * a stray call can at most deliver the email that was due anyway.
 */

export const dynamic = "force-dynamic";

function formatTaipei(date: Date): string {
  return date.toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const id = typeof body?.id === "string" ? body.id : null;
  if (!id) {
    return NextResponse.json({ success: false, error: "id required" }, { status: 400 });
  }

  // Claim the notification first so two calls cannot both send it.
  const claim = await prisma.scheduledPost.updateMany({
    where: { id, notifiedAt: null, status: { in: ["PUBLISHED", "FAILED"] } },
    data: { notifiedAt: new Date() },
  });
  if (claim.count === 0) {
    return NextResponse.json({ success: true, sent: false });
  }
  const post = await prisma.scheduledPost.findUniqueOrThrow({ where: { id } });

  const subject =
    post.status === "PUBLISHED" ? `✅ 已發片：${post.name}` : `❌ 發片失敗：${post.name}`;
  const text =
    post.status === "PUBLISHED"
      ? [
          `發布時間：${formatTaipei(post.publishedAt ?? new Date())}（預定 ${formatTaipei(post.publishAt)}）`,
          `連結：${post.permalink ?? post.mediaId}`,
          post.lastError ? `⚠️ ${post.lastError}` : "",
        ]
          .filter(Boolean)
          .join("\n")
      : `預定時間：${formatTaipei(post.publishAt)}\n錯誤：${post.lastError}\n\n沒有發出去，請回 Claude 處理。`;

  const apiKey = process.env.RESEND_API_KEY;
  const to =
    process.env.PUBLISH_NOTIFY_EMAIL ??
    (process.env.ALLOWED_EMAILS ?? "").split(",")[0]?.trim();
  if (!apiKey || !to) {
    return NextResponse.json(
      { success: false, error: "RESEND_API_KEY or recipient missing" },
      { status: 500 }
    );
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM ?? "OpenReply <login@example.com>",
      to: [to],
      subject,
      text,
    }),
  });
  if (!response.ok) {
    // Release the claim so a later call can retry.
    await prisma.scheduledPost.update({ where: { id }, data: { notifiedAt: null } });
    return NextResponse.json(
      { success: false, error: `Resend ${response.status}: ${await response.text()}` },
      { status: 502 }
    );
  }
  return NextResponse.json({ success: true, sent: true });
}
