import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { isExternalApiAuthorized } from "@/lib/external-api-auth";

export const dynamic = "force-dynamic";

/** Cancel a queued post. Only a post not yet uploaded (PENDING) can be canceled. */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isExternalApiAuthorized(request)) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }
  const { id } = await params;
  const result = await prisma.scheduledPost.updateMany({
    where: { id, status: "PENDING" },
    data: { status: "CANCELED" },
  });
  if (result.count === 0) {
    return NextResponse.json(
      { success: false, error: "Not found or already uploading/published" },
      { status: 409 }
    );
  }
  // The caller deletes these temporary blobs; the worker never will now.
  const post = await prisma.scheduledPost.findUniqueOrThrow({
    where: { id },
    select: { videoUrl: true, coverUrl: true, imageUrls: true },
  });
  const blobUrls = [post.videoUrl, post.coverUrl, ...post.imageUrls].filter(Boolean);
  return NextResponse.json({ success: true, blobUrls });
}
