import { describe, expect, it } from "vitest";
import { mergeCollectedItems } from "../../../src/collection/collection-merge";
import type { CollectedItem } from "../../../src/collection/collected-item";

function createItem(overrides: Partial<CollectedItem> = {}): CollectedItem {
  return {
    schemaVersion: 1,
    id: "item-1",
    sourceType: "rss",
    sourceId: "feed-1",
    sourceName: "Example feed",
    sourceBucket: "Reading",
    title: "Example item",
    fetchedAt: "2026-07-21T08:00:00.000Z",
    firstSeenAt: "2026-07-21T08:00:00.000Z",
    lastSeenAt: "2026-07-21T08:00:00.000Z",
    observationType: "new",
    topics: ["typescript"],
    excerpt: "Original excerpt",
    contentPath: ".rss-dashboard-data/content/item-1.md",
    contentBasis: "feed",
    metrics: { likes: 2, replies: 1 },
    read: false,
    starred: true,
    saved: true,
    savedNotePath: "Saved/item-1.md",
    collectionStatus: "collected",
    ...overrides,
  };
}

describe("mergeCollectedItems", () => {
  it("keeps durable state while applying the latest observation", () => {
    const merged = mergeCollectedItems(
      createItem(),
      createItem({
        title: "Updated title",
        fetchedAt: "2026-07-21T09:00:00.000Z",
        firstSeenAt: "2026-07-21T09:00:00.000Z",
        lastSeenAt: "2026-07-21T09:00:00.000Z",
        topics: ["architecture", "typescript"],
        excerpt: "  ",
        contentPath: "",
        metrics: { likes: 5, shares: 3 },
        read: true,
        starred: false,
        saved: false,
        savedNotePath: "",
      }),
    );

    expect(merged).toMatchObject({
      title: "Updated title",
      firstSeenAt: "2026-07-21T08:00:00.000Z",
      lastSeenAt: "2026-07-21T09:00:00.000Z",
      topics: ["typescript", "architecture"],
      excerpt: "Original excerpt",
      contentPath: ".rss-dashboard-data/content/item-1.md",
      metrics: { likes: 5, replies: 1, shares: 3 },
      read: true,
      starred: true,
      saved: true,
      savedNotePath: "Saved/item-1.md",
    });
  });

  it("uses the earliest first-seen time regardless of argument order", () => {
    const merged = mergeCollectedItems(
      createItem({ firstSeenAt: "2026-07-21T10:00:00.000Z" }),
      createItem({ firstSeenAt: "2026-07-20T10:00:00.000Z" }),
    );

    expect(merged.firstSeenAt).toBe("2026-07-20T10:00:00.000Z");
  });
});
