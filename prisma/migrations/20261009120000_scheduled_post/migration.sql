-- Reels queued to publish at a set time (the Instagram API cannot schedule).

-- CreateEnum
CREATE TYPE "ScheduledPostStatus" AS ENUM ('PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED', 'CANCELED');

-- CreateTable
CREATE TABLE "ScheduledPost" (
    "id" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "videoUrl" TEXT NOT NULL,
    "caption" TEXT NOT NULL,
    "coverUrl" TEXT,
    "thumbOffsetMs" INTEGER,
    "shareToFeed" BOOLEAN NOT NULL DEFAULT true,
    "firstComment" TEXT,
    "publishAt" TIMESTAMP(3) NOT NULL,
    "status" "ScheduledPostStatus" NOT NULL DEFAULT 'PENDING',
    "containerId" TEXT,
    "mediaId" TEXT,
    "permalink" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "publishedAt" TIMESTAMP(3),
    "notifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduledPost_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScheduledPost_status_publishAt_idx" ON "ScheduledPost"("status", "publishAt");

-- CreateIndex
CREATE INDEX "ScheduledPost_instagramAccountId_idx" ON "ScheduledPost"("instagramAccountId");

-- AddForeignKey
ALTER TABLE "ScheduledPost" ADD CONSTRAINT "ScheduledPost_instagramAccountId_fkey" FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
