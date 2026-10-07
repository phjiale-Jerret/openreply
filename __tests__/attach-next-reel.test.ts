/**
 * Binding "next reel" campaigns, with and without a caption match.
 *
 * A campaign that names caption text must wait for the reel that carries it,
 * so a sponsored reel posted first is never bound to the wrong campaign.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, getUserMedia } = vi.hoisted(() => ({
  mockPrisma: {
    automation: { findMany: vi.fn(), update: vi.fn() },
  },
  getUserMedia: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/instagram/provider", () => ({
  createInstagramContext: async () => ({
    provider: "META",
    accessToken: "local-test",
  }),
  hasInstagramCredentials: () => true,
  getUserMedia,
}));

import { attachPendingNextReels } from "../lib/automation/attach-next-reel";

const ACCOUNT = { id: "account_1", accessToken: "x", provider: "META" };

function campaign(id: string, captionMatch: string | null, createdAt: string) {
  return {
    id,
    instagramAccountId: ACCOUNT.id,
    instagramAccount: ACCOUNT,
    captionMatch,
    createdAt: new Date(createdAt),
  };
}

function reel(id: string, caption: string, timestamp: string) {
  return {
    id,
    caption,
    timestamp,
    permalink: `https://www.instagram.com/reel/${id}/`,
    media_product_type: "REELS",
  };
}

function boundTo(): Record<string, string> {
  return Object.fromEntries(
    mockPrisma.automation.update.mock.calls.map(([args]) => [
      args.where.id,
      args.data.postId,
    ])
  );
}

describe("attachPendingNextReels", () => {
  beforeEach(() => {
    mockPrisma.automation.findMany.mockReset();
    mockPrisma.automation.update.mockReset().mockResolvedValue({});
    getUserMedia.mockReset();
  });

  it("does not bind a sponsored reel posted first to a captioned campaign", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      campaign("ep13", "留言「claude」", "2026-10-07T00:00:00Z"),
    ]);
    getUserMedia.mockResolvedValue([
      reel("videotto", "Videotto 業配，留言 otto", "2026-10-07T01:00:00Z"),
      reel("ep13_reel", "新的一集\n留言「claude」拿資料", "2026-10-07T03:00:00Z"),
    ]);

    const result = await attachPendingNextReels();

    expect(boundTo()).toEqual({ ep13: "ep13_reel" });
    expect(result.bound).toBe(1);
  });

  it("leaves a captioned campaign pending while only the sponsored reel is up", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      campaign("ep13", "留言「claude」", "2026-10-07T00:00:00Z"),
    ]);
    getUserMedia.mockResolvedValue([
      reel("videotto", "Videotto 業配，留言 otto", "2026-10-07T01:00:00Z"),
    ]);

    const result = await attachPendingNextReels();

    expect(mockPrisma.automation.update).not.toHaveBeenCalled();
    expect(result.bound).toBe(0);
  });

  it("binds two pending campaigns to their own reels regardless of posting order", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      campaign("a", "留言「cut」", "2026-10-07T00:00:00Z"),
      campaign("b", "留言「flow」", "2026-10-07T00:00:00Z"),
    ]);
    getUserMedia.mockResolvedValue([
      reel("reel_flow", "留言「flow」", "2026-10-07T01:00:00Z"),
      reel("reel_cut", "留言「cut」", "2026-10-07T02:00:00Z"),
    ]);

    await attachPendingNextReels();

    expect(boundTo()).toEqual({ a: "reel_cut", b: "reel_flow" });
  });

  it("does not bind when the reel has no caption", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      campaign("ep13", "留言「claude」", "2026-10-07T00:00:00Z"),
    ]);
    getUserMedia.mockResolvedValue([
      { ...reel("bare", "", "2026-10-07T01:00:00Z"), caption: undefined },
    ]);

    await attachPendingNextReels();

    expect(mockPrisma.automation.update).not.toHaveBeenCalled();
  });

  it("ignores a matching reel posted before the campaign was created", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      campaign("ep13", "留言「claude」", "2026-10-07T02:00:00Z"),
    ]);
    getUserMedia.mockResolvedValue([
      reel("old", "留言「claude」", "2026-10-07T01:00:00Z"),
    ]);

    await attachPendingNextReels();

    expect(mockPrisma.automation.update).not.toHaveBeenCalled();
  });

  it("keeps the old behavior without a caption match: earliest reel after creation", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      campaign("plain", null, "2026-10-07T00:00:00Z"),
    ]);
    getUserMedia.mockResolvedValue([
      reel("second", "anything", "2026-10-07T02:00:00Z"),
      reel("first", "Videotto 業配", "2026-10-07T01:00:00Z"),
    ]);

    await attachPendingNextReels();

    expect(boundTo()).toEqual({ plain: "first" });
    expect(mockPrisma.automation.update.mock.calls[0][0].data).toMatchObject({
      pendingNextReel: false,
      postUrl: "https://www.instagram.com/reel/first/",
    });
  });
});
