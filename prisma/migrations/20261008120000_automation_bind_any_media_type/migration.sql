-- A pending campaign can opt in to binding a carousel or image post, not only
-- a reel. Default false keeps every existing next-reel campaign reels-only.

-- AlterTable
ALTER TABLE "Automation" ADD COLUMN IF NOT EXISTS "bindAnyMediaType" BOOLEAN NOT NULL DEFAULT false;
