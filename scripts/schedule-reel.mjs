#!/usr/bin/env node
// Queue a reel from this Mac: upload the video (and cover) to Vercel Blob,
// then register it with OpenReply, whose worker publishes it at --at.
//
//   node scripts/schedule-reel.mjs --name "EP13 xxx" --video <mp4> \
//     --caption-file <txt> --at 2026-10-12T19:00:00+08:00 \
//     [--cover <jpg>] [--thumb-offset-ms 6200] [--first-comment-file <txt>]
//   node scripts/schedule-reel.mjs --list
//   node scripts/schedule-reel.mjs --cancel <id>
//
// Keys come from .env.blob (BLOB_READ_WRITE_TOKEN) and .env.automation-api
// (AUTOMATION_API_KEY); they are never printed.
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { put } from "@vercel/blob";

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
if (values.cancel) {
  await call("DELETE", `/api/publish/external/${values.cancel}`);
  console.log("canceled", values.cancel);
  process.exit(0);
}

for (const key of ["name", "video", "caption-file", "at"]) {
  if (!values[key]) throw new Error(`--${key} is required`);
}
const publishAt = new Date(values.at);
if (Number.isNaN(publishAt.getTime()) || !/[+-]\d\d:\d\d$|Z$/.test(values.at)) {
  throw new Error("--at needs a timezone, e.g. 2026-10-12T19:00:00+08:00");
}
if (publishAt.getTime() < Date.now() + 2 * 60_000) {
  throw new Error("--at must be at least 2 minutes from now");
}

const blobToken = readEnv(".env.blob", "BLOB_READ_WRITE_TOKEN");
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

const videoUrl = await upload(values.video, "video/mp4");
const coverUrl = values.cover ? await upload(values.cover, "image/jpeg") : undefined;

const { scheduledPost } = await call("POST", "/api/publish/external", {
  name: values.name,
  videoUrl,
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
