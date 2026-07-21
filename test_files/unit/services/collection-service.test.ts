import { describe, expect, it, vi } from "vitest";
import { CollectionService } from "../../../src/services/collection-service";
import type { CollectedItem } from "../../../src/collection/collected-item";
import type { Feed, FeedItem } from "../../../src/types/types";

function item(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    title: "Article",
    link: "https://example.com/article",
    description: "Description",
    pubDate: "2026-07-20T08:00:00.000Z",
    guid: "article-1",
    read: false,
    starred: false,
    tags: [],
    feedTitle: "Example",
    feedUrl: "https://example.com/feed.xml",
    coverImage: "",
    ...overrides,
  };
}

function feed(items: FeedItem[]): Feed {
  return {
    feedId: "source-1",
    title: "Example",
    url: "https://example.com/feed.xml",
    folder: "Research",
    items,
    lastUpdated: 1,
    mediaType: "article",
  };
}

function collected(source: FeedItem, fetchedAt: Date): CollectedItem {
  return {
    schemaVersion: 1,
    id: source.guid,
    sourceType: "rss",
    sourceId: "source-1",
    sourceName: "Example",
    sourceBucket: "Research",
    title: source.title,
    publishedAt: source.pubDate,
    fetchedAt: fetchedAt.toISOString(),
    firstSeenAt: fetchedAt.toISOString(),
    lastSeenAt: fetchedAt.toISOString(),
    url: source.link,
    guid: source.guid,
    observationType: "new",
    topics: [],
    excerpt: source.summary || source.description,
    contentBasis: "feed",
    read: source.read ?? false,
    starred: source.starred ?? false,
    saved: source.saved ?? false,
    savedNotePath: source.savedFilePath,
    collectionStatus: "collected",
  };
}

function harness(options: { bootstrapped?: boolean; stored?: boolean } = {}) {
  const events: string[] = [];
  const repository = {
    upsertDaily: vi.fn(async (items: CollectedItem[]) => {
      events.push("jsonl");
      return items;
    }),
    hasItemsForSource: vi
      .fn()
      .mockResolvedValue(options.stored ?? options.bootstrapped ?? false),
  };
  const dailyIndex = {
    writeDailyIndex: vi.fn(async () => {
      events.push("markdown");
      return "信息收集/每日采集/2026-07-21.md";
    }),
  };
  const ledger = {
    getState: vi.fn(async () =>
      options.bootstrapped
        ? {
            sourceId: "source-1",
            status: "success" as const,
            lastSuccessAt: "2026-07-20T00:00:00.000Z",
            lastSuccessDate: "2026-07-20",
          }
        : undefined,
    ),
    recordSuccess: vi.fn(async () => {
      events.push("success");
    }),
  };
  const normalize = vi.fn((sourceFeed: Feed, sourceItem: FeedItem, now: Date) => {
    events.push("normalize");
    return collected(sourceItem, now);
  });
  const service = new CollectionService({
    repository,
    dailyIndex,
    ledger,
    normalize,
  });

  return { service, repository, dailyIndex, ledger, normalize, events };
}

describe("CollectionService", () => {
  it("bootstraps every refreshed item and durably orders JSONL, Markdown, then success", async () => {
    const first = item();
    const second = item({ guid: "article-2", link: "https://example.com/2" });
    const test = harness();
    const fetchedAt = new Date(2026, 6, 21, 9, 30, 0);

    const result = await test.service.collectFeedRefresh({
      feed: feed([first, second]),
      previousItems: [first],
      refreshedItems: [first, second],
      fetchedAt,
    });

    expect(result.map((entry) => entry.id)).toEqual(["article-1", "article-2"]);
    expect(test.events).toEqual([
      "normalize",
      "normalize",
      "jsonl",
      "markdown",
      "success",
    ]);
    expect(test.repository.upsertDaily).toHaveBeenCalledWith(result, "2026-07-21");
    expect(test.dailyIndex.writeDailyIndex).toHaveBeenCalledWith({
      localDate: "2026-07-21",
      items: result,
    });
    expect(test.ledger.recordSuccess).toHaveBeenCalledWith("source-1", fetchedAt);
  });

  it("later collects only new stable IDs and materially changed observations", async () => {
    const unchanged = item();
    const changedBefore = item({
      guid: "article-2",
      link: "https://example.com/2",
      title: "Old title",
    });
    const changedAfter = { ...changedBefore, title: "New title" };
    const added = item({ guid: "article-3", link: "https://example.com/3" });
    const test = harness({ bootstrapped: true });

    const result = await test.service.collectFeedRefresh({
      feed: feed([unchanged, changedAfter, added]),
      previousItems: [unchanged, changedBefore],
      refreshedItems: [unchanged, changedAfter, added],
      fetchedAt: new Date(2026, 6, 21, 10, 0, 0),
    });

    expect(result.map((entry) => [entry.id, entry.observationType])).toEqual([
      ["article-2", "updated"],
      ["article-3", "new"],
    ]);
  });

  it("bootstraps after collection is enabled even if refresh success was recorded earlier", async () => {
    const current = item();
    const test = harness({ bootstrapped: true, stored: false });

    const result = await test.service.collectFeedRefresh({
      feed: feed([current]),
      previousItems: [current],
      refreshedItems: [current],
      fetchedAt: new Date(2026, 6, 21, 10, 0, 0),
    });

    expect(result).toHaveLength(1);
    expect(result[0].observationType).toBe("new");
  });

  it.each([
    ["excerpt", { description: "Changed description" }],
    ["content", { content: "Changed full content" }],
    ["publication time", { pubDate: "2026-07-21T09:00:00.000Z" }],
    ["metrics", { metrics: { likes: 2 } }],
  ])("treats changed %s as a material update", async (_label, change) => {
    const previous = item();
    const refreshed = { ...previous, ...change } as FeedItem;
    const test = harness({ bootstrapped: true });

    const result = await test.service.collectFeedRefresh({
      feed: feed([refreshed]),
      previousItems: [previous],
      refreshedItems: [refreshed],
      fetchedAt: new Date(2026, 6, 21, 10, 0, 0),
    });

    expect(result).toHaveLength(1);
    expect(result[0].observationType).toBe("updated");
  });

  it("does not treat read, starred, or saved state alone as a material change", async () => {
    const previous = item({ read: false, starred: false, saved: false });
    const refreshed = item({
      read: true,
      starred: true,
      saved: true,
      savedFilePath: "Saved/Article.md",
    });
    const test = harness({ bootstrapped: true });

    const result = await test.service.collectFeedRefresh({
      feed: feed([refreshed]),
      previousItems: [previous],
      refreshedItems: [refreshed],
      fetchedAt: new Date(2026, 6, 21, 10, 0, 0),
    });

    expect(result).toEqual([]);
    expect(test.repository.upsertDaily).toHaveBeenCalledWith([], "2026-07-21");
    expect(test.dailyIndex.writeDailyIndex).toHaveBeenCalled();
    expect(test.ledger.recordSuccess).toHaveBeenCalled();
  });

  it("does not write Markdown or success when the JSONL upsert fails", async () => {
    const test = harness();
    test.repository.upsertDaily.mockRejectedValueOnce(new Error("disk full"));

    await expect(
      test.service.collectFeedRefresh({
        feed: feed([item()]),
        previousItems: [],
        refreshedItems: [item()],
        fetchedAt: new Date(2026, 6, 21, 10, 0, 0),
      }),
    ).rejects.toThrow("disk full");

    expect(test.dailyIndex.writeDailyIndex).not.toHaveBeenCalled();
    expect(test.ledger.recordSuccess).not.toHaveBeenCalled();
  });

  it("does not advance success when the daily Markdown write fails", async () => {
    const test = harness();
    test.dailyIndex.writeDailyIndex.mockRejectedValueOnce(new Error("read only"));

    await expect(
      test.service.collectFeedRefresh({
        feed: feed([item()]),
        previousItems: [],
        refreshedItems: [item()],
        fetchedAt: new Date(2026, 6, 21, 10, 0, 0),
      }),
    ).rejects.toThrow("read only");

    expect(test.repository.upsertDaily).toHaveBeenCalled();
    expect(test.ledger.recordSuccess).not.toHaveBeenCalled();
  });

  it("serializes concurrent source persistence through the complete durable sequence", async () => {
    const test = harness();
    let releaseFirst!: () => void;
    const firstWriteGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    test.repository.upsertDaily.mockImplementationOnce(async (items) => {
      test.events.push("jsonl");
      await firstWriteGate;
      return items;
    });
    const fetchedAt = new Date(2026, 6, 21, 10, 0, 0);

    const first = test.service.collectFeedRefresh({
      feed: feed([item()]),
      previousItems: [],
      refreshedItems: [item()],
      fetchedAt,
    });
    const second = test.service.collectFeedRefresh({
      feed: feed([item({ guid: "article-2" })]),
      previousItems: [],
      refreshedItems: [item({ guid: "article-2" })],
      fetchedAt,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(test.repository.upsertDaily).toHaveBeenCalledTimes(1);

    releaseFirst();
    await Promise.all([first, second]);

    expect(test.repository.upsertDaily).toHaveBeenCalledTimes(2);
    expect(test.events).toEqual([
      "normalize",
      "jsonl",
      "markdown",
      "success",
      "normalize",
      "jsonl",
      "markdown",
      "success",
    ]);
  });
});
