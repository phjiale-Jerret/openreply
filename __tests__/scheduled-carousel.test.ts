/**
 * Scheduled carousels: one item container per image, then a CAROUSEL parent.
 * A post with a video still goes up as a reel.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, meta } = vi.hoisted(() => ({
  mockPrisma: {
    scheduledPost: { updateMany: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    operationalEvent: { create: vi.fn() },
  },
  meta: {
    createCarouselItemContainer: vi.fn(),
    createCarouselContainer: vi.fn(),
    createReelContainer: vi.fn(),
    getContainerStatus: vi.fn(),
  },
}));
vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: () => "token" }));
vi.mock("@vercel/blob", () => ({ del: vi.fn() }));
vi.mock("@/lib/meta/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/meta/client")>()),
  ...meta,
}));

import { processScheduledPosts } from "../lib/publishing/scheduled-posts";

const ACCOUNT = {
  id: "account_1",
  instagramId: "ig_1",
  accessToken: "x",
  provider: "META",
  workspaceId: "ws_1",
};

function post(fields: Record<string, unknown>) {
  return {
    id: "post_1",
    name: "test",
    caption: "caption",
    videoUrl: null,
    imageUrls: [],
    coverUrl: null,
    thumbOffsetMs: null,
    shareToFeed: true,
    attempts: 0,
    publishAt: new Date(Date.now() + 60_000),
    instagramAccount: ACCOUNT,
    ...fields,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.scheduledPost.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.scheduledPost.update.mockResolvedValue({});
  meta.getContainerStatus.mockResolvedValue({ status_code: "FINISHED" });
});

describe("processScheduledPosts", () => {
  it("builds a carousel from its images in order", async () => {
    mockPrisma.scheduledPost.findMany
      .mockResolvedValueOnce([post({ imageUrls: ["https://a/1.jpg", "https://a/2.jpg"] })])
      .mockResolvedValueOnce([]);
    meta.createCarouselItemContainer
      .mockResolvedValueOnce({ id: "child_1" })
      .mockResolvedValueOnce({ id: "child_2" });
    meta.createCarouselContainer.mockResolvedValue({ id: "parent_1" });

    await processScheduledPosts();

    expect(meta.createCarouselItemContainer).toHaveBeenNthCalledWith(1, "token", "ig_1", "https://a/1.jpg");
    expect(meta.createCarouselItemContainer).toHaveBeenNthCalledWith(2, "token", "ig_1", "https://a/2.jpg");
    expect(meta.createCarouselContainer).toHaveBeenCalledWith("token", "ig_1", {
      childIds: ["child_1", "child_2"],
      caption: "caption",
    });
    expect(meta.createReelContainer).not.toHaveBeenCalled();
    expect(mockPrisma.scheduledPost.update).toHaveBeenCalledWith({
      where: { id: "post_1" },
      data: { containerId: "parent_1" },
    });
  });

  it("still uploads a video post as a reel", async () => {
    mockPrisma.scheduledPost.findMany
      .mockResolvedValueOnce([post({ videoUrl: "https://a/v.mp4" })])
      .mockResolvedValueOnce([]);
    meta.createReelContainer.mockResolvedValue({ id: "reel_1" });

    await processScheduledPosts();

    expect(meta.createReelContainer).toHaveBeenCalled();
    expect(meta.createCarouselContainer).not.toHaveBeenCalled();
  });
});
