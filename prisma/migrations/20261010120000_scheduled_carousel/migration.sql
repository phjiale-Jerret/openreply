-- Scheduled posts can be carousels: a list of image URLs instead of a video.
ALTER TABLE "ScheduledPost" ALTER COLUMN "videoUrl" DROP NOT NULL;
ALTER TABLE "ScheduledPost" ADD COLUMN "imageUrls" TEXT[] DEFAULT ARRAY[]::TEXT[];
