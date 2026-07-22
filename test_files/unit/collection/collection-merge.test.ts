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

  it("preserves and merges additive X relationship metadata", () => {
    const merged = mergeCollectedItems(
      createItem({
        sourceType: "x-account",
        contentBasis: "x-post",
        sourceMetadata: {
          kind: "x-post",
          conversationId: "10",
          quoteOfId: "11",
          externalUrls: ["https://example.com/old"],
        },
      }),
      createItem({
        sourceType: "x-account",
        contentBasis: "x-post",
        sourceMetadata: {
          kind: "x-post",
          inReplyToId: "12",
          externalUrls: ["https://example.com/new"],
        },
      }),
    );

    expect(merged.sourceMetadata).toEqual({
      kind: "x-post",
      conversationId: "10",
      inReplyToId: "12",
      quoteOfId: "11",
      externalUrls: [
        "https://example.com/old",
        "https://example.com/new",
      ],
    });
  });

  it("never resets durable read, starred, or saved flags during observation merge", () => {
    const merged = mergeCollectedItems(
      createItem({ read: true, starred: true, saved: true }),
      createItem({ read: false, starred: false, saved: false }),
    );

    expect(merged).toMatchObject({ read: true, starred: true, saved: true });
  });

  it("unions account and topic observation sources deterministically in either arrival order", () => {
    const account = createItem({
      sourceType: "x-account",
      sourceId: "x-account-openai",
      sourceBucket: "X/Accounts",
      contentBasis: "x-post",
      sourceMetadata: {
        kind: "x-post",
        externalUrls: [],
        observedSources: [
          { type: "x-account", id: "x-account-openai", bucket: "X/Accounts" },
        ],
      } as unknown as CollectedItem["sourceMetadata"],
    });
    const topic = createItem({
      sourceType: "x-topic",
      sourceId: "ai-apps",
      sourceBucket: "X/Topics",
      contentBasis: "x-post",
      sourceMetadata: {
        kind: "x-post",
        externalUrls: [],
        observationTags: ["latest"],
        observedSources: [
          { type: "x-topic", id: "ai-apps", bucket: "X/Topics" },
        ],
      } as unknown as CollectedItem["sourceMetadata"],
    });

    const expected = [
      { type: "x-account", id: "x-account-openai", bucket: "X/Accounts" },
      { type: "x-topic", id: "ai-apps", bucket: "X/Topics" },
    ];
    expect(
      (mergeCollectedItems(account, topic).sourceMetadata as unknown as {
        observedSources: unknown[];
      }).observedSources,
    ).toEqual(expected);
    expect(
      (mergeCollectedItems(topic, account).sourceMetadata as unknown as {
        observedSources: unknown[];
      }).observedSources,
    ).toEqual(expected);
  });
});
