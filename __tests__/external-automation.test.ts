/**
 * POST /api/automations/external — campaign creation for scripts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    instagramAccount: { findMany: vi.fn() },
    automation: { findMany: vi.fn(), create: vi.fn() },
  },
}));
vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

import { POST } from "../app/api/automations/external/route";

const KEY = "local-test-key";

function request(body: unknown, auth = `Bearer ${KEY}`) {
  return new NextRequest("http://localhost/api/automations/external", {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const BODY = {
  name: "EP13 claude",
  keywords: ["claude", "Claude"],
  publicReplyMessages: ["私訊你囉", "傳給你了", "看一下私訊"],
  dmMessage: "資料在這裡",
  linkUrl: "https://example.com/notes",
};

describe("POST /api/automations/external", () => {
  beforeEach(() => {
    process.env.AUTOMATION_API_KEY = KEY;
    mockPrisma.instagramAccount.findMany
      .mockReset()
      .mockResolvedValue([
        { id: "account_1", workspaceId: "ws_1", username: "jerret.ai.lens" },
      ]);
    mockPrisma.automation.findMany.mockReset().mockResolvedValue([]);
    mockPrisma.automation.create
      .mockReset()
      .mockImplementation(async ({ data }) => ({ id: "auto_1", ...data }));
  });

  it("rejects a missing or wrong key", async () => {
    expect((await POST(request(BODY, "Bearer nope"))).status).toBe(401);
    expect((await POST(request(BODY, ""))).status).toBe(401);
    delete process.env.AUTOMATION_API_KEY;
    expect((await POST(request(BODY, "Bearer "))).status).toBe(401);
    expect(mockPrisma.automation.create).not.toHaveBeenCalled();
  });

  it("creates a pending next-reel campaign with the house settings", async () => {
    const res = await POST(request(BODY));
    expect(res.status).toBe(201);

    const { data } = mockPrisma.automation.create.mock.calls[0][0];
    expect(data).toMatchObject({
      pendingNextReel: true,
      captionMatch: "留言「claude」",
      postId: null,
      matchAnyPost: false,
      keywords: ["claude", "Claude"],
      wholeWordMatch: false,
      openingDmEnabled: false,
      requireFollow: true,
      followPromptMessage: "先追蹤 @jerret.ai.lens，追蹤好按下面按鈕就傳給你 🙏",
      followPromptButtonLabel: "我追蹤了 ✅",
      linkButtonLabel: "打開資料頁",
      publicReplyEnabled: true,
      publicReplyMessages: ["私訊你囉", "傳給你了", "看一下私訊"],
      publicReplyMessage: "私訊你囉",
      workspaceId: "ws_1",
      instagramAccountId: "account_1",
    });
    expect(data.trackedLinks.create).toHaveLength(1);
    expect(data.trackedLinks.create[0].destinationUrl).toBe(
      "https://example.com/notes"
    );
  });

  it("uses an explicit captionMatch when given", async () => {
    await POST(request({ ...BODY, captionMatch: "#EP13" }));
    expect(mockPrisma.automation.create.mock.calls[0][0].data.captionMatch).toBe(
      "#EP13"
    );
  });

  it("stores anyMediaType so the campaign can bind a carousel (default reels only)", async () => {
    await POST(request(BODY));
    expect(mockPrisma.automation.create.mock.calls[0][0].data.bindAnyMediaType).toBe(false);
    mockPrisma.automation.create.mockClear();
    await POST(request({ ...BODY, anyMediaType: true }));
    expect(mockPrisma.automation.create.mock.calls[0][0].data.bindAnyMediaType).toBe(true);
  });

  it("returns 409 naming the campaign already waiting for the same caption", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      { id: "auto_0", name: "EP12 buff" },
    ]);

    const res = await POST(request(BODY));

    expect(res.status).toBe(409);
    expect((await res.json()).conflicts).toEqual(["EP12 buff"]);
    expect(mockPrisma.automation.findMany.mock.calls[0][0].where).toEqual({
      instagramAccountId: "account_1",
      pendingNextReel: true,
      captionMatch: "留言「claude」",
    });
    expect(mockPrisma.automation.create).not.toHaveBeenCalled();
  });

  it("rejects input without keywords or a link", async () => {
    expect((await POST(request({ ...BODY, keywords: [] }))).status).toBe(400);
    expect((await POST(request({ ...BODY, linkUrl: "nope" }))).status).toBe(400);
  });

  it("asks for instagramUsername when several accounts are connected", async () => {
    mockPrisma.instagramAccount.findMany.mockResolvedValue([
      { id: "a", workspaceId: "ws", username: "one" },
      { id: "b", workspaceId: "ws", username: "two" },
    ]);
    expect((await POST(request(BODY))).status).toBe(400);
  });
});
