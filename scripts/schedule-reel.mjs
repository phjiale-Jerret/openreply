#!/usr/bin/env node
// Queue a reel or a carousel from this Mac: upload the video (and cover) or
// the images to Vercel Blob, then register the post with OpenReply, whose
// worker publishes it at --at.
//
//   node scripts/schedule-reel.mjs --name "EP13 xxx" --video <mp4> \
//     --caption-file <txt> --at 2026-10-12T19:00:00+08:00 \
//     [--cover <jpg>] [--thumb-offset-ms 6200] [--first-comment-file <txt>]
//   node scripts/schedule-reel.mjs --name "IMG08 xxx" --images <成品 dir> \
//     --caption-file <txt> --at ... [--first-comment-file <txt>]
//       (takes P01.png, P02.png… in order, 2–10 pages; PNG is converted to
//        JPEG quality 95 because Instagram only accepts JPEG)
//   node scripts/schedule-reel.mjs --list
//   node scripts/schedule-reel.mjs --cancel <id>   (also deletes its blobs)
//
// Keys come from .env.blob (BLOB_READ_WRITE_TOKEN) and .env.automation-api
// (AUTOMATION_API_KEY); they are never printed.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { del, put } from "@vercel/blob";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = process.env.OPENREPLY_URL ?? "https://jerretreply.vercel.app";

function readEnv(file, name) {
  const text = readFileSync(join(root, file), "utf8");
  const line = text.split("\n").find((l) => l.startsWith(`${name}=`));
  if (!line) throw new Error(`${name} missing in ${file}`);
  return line.slice(name.length + 1).trim().replace(/^["']|["']$/g, "");
}

const { values } = parseArgs({
  options: {
    name: { type: "string" },
    video: { type: "string" },
    images: { type: "string" },
    "caption-file": { type: "string" },
    at: { type: "string" },
    cover: { type: "string" },
    "thumb-offset-ms": { type: "string" },
    "first-comment-file": { type: "string" },
    list: { type: "boolean" },
    cancel: { type: "string" },
  },
});

const apiKey = readEnv(".env.automation-api", "AUTOMATION_API_KEY");
const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

async function call(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}

if (values.list) {
  const { scheduledPosts } = await call("GET", "/api/publish/external");
  console.table(scheduledPosts);
  process.exit(0);
}
const blobToken = readEnv(".env.blob", "BLOB_READ_WRITE_TOKEN");

if (values.cancel) {
  const { blobUrls = [] } = await call("DELETE", `/api/publish/external/${values.cancel}`);
  if (blobUrls.length) await del(blobUrls, { token: blobToken });
  console.log(`canceled ${values.cancel}, deleted ${blobUrls.length} blob(s)`);
  process.exit(0);
}

for (const key of ["name", "caption-file", "at"]) {
  if (!values[key]) throw new Error(`--${key} is required`);
}
if (!values.video === !values.images) throw new Error("pass --video or --images");
const publishAt = new Date(values.at);
if (Number.isNaN(publishAt.getTime()) || !/[+-]\d\d:\d\d$|Z$/.test(values.at)) {
  throw new Error("--at needs a timezone, e.g. 2026-10-12T19:00:00+08:00");
}
if (publishAt.getTime() < Date.now() + 2 * 60_000) {
  throw new Error("--at must be at least 2 minutes from now");
}

async function upload(file, contentType) {
  const sizeMb = (statSync(file).size / 1e6).toFixed(1);
  console.log(`uploading ${basename(file)} (${sizeMb} MB)…`);
  const blob = await put(`ig-publish/${Date.now()}_${basename(file)}`, readFileSync(file), {
    access: "public",
    contentType,
    token: blobToken,
    multipart: true,
  });
  return blob.url;
}

// Carousel pages: P01.png, P02.png… (the 00_總覽 overview is skipped).
function carouselPages(dir) {
  const pages = readdirSync(dir)
    .filter((f) => /^P\d+\.(png|jpe?g)$/i.test(f))
    .sort()
    .map((f) => join(dir, f));
  if (pages.length < 2 || pages.length > 10) {
    throw new Error(`${dir}: need 2–10 pages named P01.png…, found ${pages.length}`);
  }
  const out = mkdtempSync(join(tmpdir(), "carousel-"));
  return pages.map((file) => {
    if (/\.jpe?g$/i.test(file)) return file;
    const jpg = join(out, basename(file).replace(/\.png$/i, ".jpg"));
    execFileSync("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "95", file, "--out", jpg], {
      stdio: "ignore",
    });
    return jpg;
  });
}

let videoUrl, imageUrls, coverUrl;
if (values.images) {
  imageUrls = [];
  for (const page of carouselPages(values.images)) imageUrls.push(await upload(page, "image/jpeg"));
} else {
  videoUrl = await upload(values.video, "video/mp4");
  coverUrl = values.cover ? await upload(values.cover, "image/jpeg") : undefined;
}

const { scheduledPost } = await call("POST", "/api/publish/external", {
  name: values.name,
  videoUrl,
  imageUrls,
  caption: readFileSync(values["caption-file"], "utf8").trim(),
  publishAt: publishAt.toISOString(),
  coverUrl,
  thumbOffsetMs: values["thumb-offset-ms"] ? Number(values["thumb-offset-ms"]) : undefined,
  firstComment: values["first-comment-file"]
    ? readFileSync(values["first-comment-file"], "utf8").trim()
    : undefined,
});
console.log(
  `queued ${scheduledPost.id}: "${scheduledPost.name}" at ${publishAt.toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false })}`
);
