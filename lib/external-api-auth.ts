import { timingSafeEqual } from "crypto";
import type { NextRequest } from "next/server";

/** Bearer-key check for the script-facing APIs (AUTOMATION_API_KEY). */
export function isExternalApiAuthorized(request: NextRequest): boolean {
  const key = process.env.AUTOMATION_API_KEY;
  if (!key) return false;
  const header = request.headers.get("authorization") ?? "";
  const expected = Buffer.from(`Bearer ${key}`);
  const actual = Buffer.from(header);
  return (
    actual.length === expected.length && timingSafeEqual(actual, expected)
  );
}
