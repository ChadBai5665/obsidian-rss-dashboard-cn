import { describe, expect, it } from "vitest";
import type { CollectedItem } from "../../../src/collection/collected-item";
import { CollectionQueryService } from "../../../src/collection/collection-query-service";

function item(overrides: Partial<CollectedItem> = {}): CollectedItem {
  return {
    schemaVersion: 1,
    id: "item-a",
    sourceType: "rss",
    sourceId: "source-a",
    sourceName: "McKinsey Insights",
    sourceBucket: "subscription",
    title: "AI strategy",
    fetchedAt: "2026-07-22T08:00:00.000Z",
    firstSeenAt: "2026-07-22T08:00:00.000Z",
    lastSeenAt: "2026-07-22T08:00:00.000Z",
    observationType: "new",
    topics: ["AI"],
    contentBasis: "feed",
    read: false,
    starred: false,
    saved: false,
    collectionStatus: "collected",
    ...overrides,
  };
}

describe("CollectionQueryService", () => {
  it("filters Unicode text across title, author, source, excerpt, and topics", () => {
    const service = new CollectionQueryService();
    const items = [
      item({ title: "人工智能实践", id: "title" }),
      item({ author: "王小明", id: "author" }),
      item({ sourceName: "波士顿咨询", id: "source" }),
      item({ excerpt: "关于新模型的观察", id: "excerpt" }),
      item({ topics: ["大模型方法论"], id: "topic" }),
      item({ title: "Unrelated", id: "other" }),
    ];

    expect(service.query({ items, text: "模型" }).map((entry) => entry.id)).toEqual([
      "excerpt",
      "topic",
    ]);
    expect(service.query({ items, text: "MCKINSEY" }).map((entry) => entry.id)).toContain(
      "other",
    );
  });

  it("composes text with source type, topic, and durable state filters", () => {
    const service = new CollectionQueryService();
    const items = [
      item({
        id: "match",
        sourceType: "youtube",
        topics: ["AI", "Methods"],
        read: false,
        starred: true,
        saved: true,
        title: "AI workflow",
      }),
      item({
        id: "wrong-topic",
        sourceType: "youtube",
        topics: ["Markets"],
        starred: true,
        saved: true,
        title: "AI workflow",
      }),
      item({
        id: "wrong-state",
        sourceType: "youtube",
        topics: ["AI"],
        read: true,
        starred: true,
        saved: true,
        title: "AI workflow",
      }),
    ];

    expect(
      service
        .query({
          items,
          text: "workflow",
          sourceTypes: ["youtube"],
          topics: ["AI"],
          read: false,
          starred: true,
          saved: true,
        })
        .map((entry) => entry.id),
    ).toEqual(["match"]);
  });

  it("sorts by parsed publishedAt-or-fetchedAt descending, then complete title and ID ties", () => {
    const service = new CollectionQueryService();
    const items = [
      item({ id: "z", title: "Same", publishedAt: "2026-07-21T10:00:00.000Z" }),
      item({ id: "a", title: "Same", publishedAt: "2026-07-21T10:00:00.000Z" }),
      item({ id: "earlier", title: "Earlier", publishedAt: "2026-07-20T10:00:00.000Z" }),
      item({ id: "invalid", title: "Invalid", publishedAt: "not a date" }),
      item({ id: "invalid-a", title: "Invalid", publishedAt: "also invalid" }),
      item({ id: "fetched", title: "Fetched", fetchedAt: "2026-07-22T12:00:00.000Z" }),
    ];

    expect(service.query({ items }).map((entry) => entry.id)).toEqual([
      "fetched",
      "a",
      "z",
      "earlier",
      "invalid",
      "invalid-a",
    ]);
  });

  it("does not mutate its input or truncate results into a Top 10", () => {
    const service = new CollectionQueryService();
    const items = Array.from({ length: 12 }, (_, index) =>
      item({ id: `item-${index}`, title: `Item ${index}` }),
    );
    const before = [...items];

    const result = service.query({ items });

    expect(items).toEqual(before);
    expect(result).toHaveLength(12);
  });
});
