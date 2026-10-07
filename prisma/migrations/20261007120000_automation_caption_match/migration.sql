-- A pending next-reel campaign can name text its reel's caption must contain,
-- so a different reel posted first is not bound to it. Null keeps the old
-- behavior (the earliest reel after creation).

-- AlterTable
ALTER TABLE "Automation" ADD COLUMN IF NOT EXISTS "captionMatch" TEXT;
