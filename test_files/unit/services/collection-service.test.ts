import { describe, expect, it, vi } from "vitest";
import { App } from "obsidian";
import { CollectionService } from "../../../src/services/collection-service";
import type { CollectedItem } from "../../../src/collection/collected-item";
import { CollectionRepository } from "../../../src/collection/collection-repository";
import { DailyIndexService } from "../../../src/collection/daily-index-service";
import type { Feed, FeedItem } from "../../../src/types/types";

const NOW = new Date("2026-07-21T12:00:00.000Z");

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
    excerpt: source.summary?.trim()
      ? source.summary.trim()
      : source.description.trim() || undefined,
    contentBasis: "feed",
    read: source.read ?? false,
    starred: source.starred ?? false,
    saved: source.saved ?? false,
    savedNotePath: source.savedFilePath,
    collectionStatus: "collected",
  };
}

function harness(options: {
  bootstrapped?: boolean;
  stored?: boolean;
  isSourceActive?: (sourceId: string) => boolean;
} = {}) {
  const events: string[] = [];
  const repository = {
    upsertDaily: vi.fn(async (items: CollectedItem[]) => {
      events.push("jsonl");
      return items;
    }),
    hasItemsForSource: vi
      .fn()
      .mockResolvedValue(options.stored ?? options.bootstrapped ?? false),
    removeBySourceId: vi.fn(async () => []),
    restoreRemovedSource: vi.fn(async () => undefined),
  };
  const dailyIndex = {
    writeDailyIndex: vi.fn(async () => {
      events.push("markdown");
      return "信息收集/每日采集/2026-07-21.md";
    }),
    snapshotDailyIndex: vi.fn(async (localDate: string) => ({
      localDate,
      path: `信息收集/每日采集/${localDate}.md`,
      existed: true,
      content: `before:${localDate}`,
    })),
    restoreDailyIndex: vi.fn(async () => undefined),
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
    return {
      ...collected(sourceItem, now),
      sourceId: sourceFeed.feedId ?? sourceFeed.url,
      sourceName: sourceFeed.title,
      sourceBucket: sourceFeed.folder,
      ...(sourceFeed.sourceKind === "x-topic"
        ? { sourceType: "x-topic" as const, contentBasis: "x-post" as const }
        : {}),
    };
  });
  const dependencies = {
    repository,
    dailyIndex,
    ledger,
    normalize,
    ...(options.isSourceActive
      ? { isSourceActive: options.isSourceActive }
      : {}),
  };
  const service = new CollectionService(dependencies);

  return { service, repository, dailyIndex, ledger, normalize, events };
}

describe("CollectionService", () => {
  it("regenerates every affected daily index after an explicit source purge", async () => {
    const test = harness();
    const remaining = collected(item({ guid: "retained" }), NOW);
    test.repository.removeBySourceId.mockResolvedValue([
      { localDate: "2026-07-20", previousItems: [remaining], remainingItems: [remaining] },
      { localDate: "2026-07-21", previousItems: [], remainingItems: [] },
    ]);

    const removed = await test.service.removeSource("source-1");

    expect(removed.days).toEqual([
      { localDate: "2026-07-20", previousItems: [remaining], remainingItems: [remaining] },
      { localDate: "2026-07-21", previousItems: [], remainingItems: [] },
    ]);
    expect(test.repository.removeBySourceId).toHaveBeenCalledWith("source-1");
    expect(test.dailyIndex.writeDailyIndex.mock.calls).toEqual([
      [{ localDate: "2026-07-20", items: [remaining] }],
      [{ localDate: "2026-07-21", items: [] }],
    ]);
    expect(test.ledger.recordSuccess).not.toHaveBeenCalled();
  });

  it("holds the collection mutation queue until the purge owner commits its config", async () => {
    const test = harness();
    test.repository.removeBySourceId.mockResolvedValue([]);

    const removal = await test.service.removeSource("source-1");
    const collection = test.service.collectFeedRefresh({
      feed: feed([item({ guid: "after-purge" })]),
      previousItems: [],
      refreshedItems: [item({ guid: "after-purge" })],
      fetchedAt: NOW,
    });
    await Promise.resolve();

    expect(test.repository.upsertDaily).not.toHaveBeenCalled();
    await removal.commit();
    await collection;
    expect(test.repository.upsertDaily).toHaveBeenCalledOnce();
  });

  it("rejects a stale queued refresh after the purge owner removes its source config", async () => {
    let active = true;
    const test = harness({ isSourceActive: () => active });
    test.repository.removeBySourceId.mockResolvedValue([]);

    const removal = await test.service.removeSource("source-1");
    const staleCollection = test.service.collectFeedRefresh({
      feed: feed([item({ guid: "stale-after-purge" })]),
      previousItems: [],
      refreshedItems: [item({ guid: "stale-after-purge" })],
      fetchedAt: NOW,
    });
    active = false;
    await removal.commit();

    await expect(staleCollection).rejects.toThrow(
      "Collection source is no longer active",
    );
    expect(test.repository.upsertDaily).not.toHaveBeenCalled();
  });

  it("restores collection, item index, and every daily index when purge regeneration fails", async () => {
    const test = harness();
    const removedItem = collected(item({ guid: "removed" }), NOW);
    const days = [{
      localDate: "2026-07-21",
      previousItems: [removedItem],
      remainingItems: [],
    }];
    test.repository.removeBySourceId.mockResolvedValue(days);
    test.dailyIndex.writeDailyIndex.mockRejectedValueOnce(new Error("daily write failed"));

    await expect(test.service.removeSource("source-1")).rejects.toThrow(
      "daily write failed",
    );

    expect(test.repository.restoreRemovedSource).toHaveBeenCalledWith(days);
    expect(test.dailyIndex.restoreDailyIndex).toHaveBeenCalledWith({
      localDate: "2026-07-21",
      path: "信息收集/每日采集/2026-07-21.md",
      existed: true,
      content: "before:2026-07-21",
    });
  });

  it("surfaces a safe combined error when purge compensation is incomplete", async () => {
    const test = harness();
    const days = [{ localDate: "2026-07-21", previousItems: [], remainingItems: [] }];
    test.repository.removeBySourceId.mockResolvedValue(days);
    test.dailyIndex.writeDailyIndex.mockRejectedValueOnce(new Error("unsafe primary detail"));
    test.repository.restoreRemovedSource.mockRejectedValueOnce(
      new Error("unsafe rollback detail"),
    );

    const error = await test.service.removeSource("source-1").catch((caught) => caught);

    expect(error).toMatchObject({
      message: "Source purge failed and rollback was incomplete",
    });
    expect(String(error)).not.toContain("unsafe primary detail");
    expect(String(error)).not.toContain("unsafe rollback detail");
  });

  it("observes every in-window topic result so a later daily upsert can mark it rediscovered", async () => {
    const unchanged = item({
      guid: "200",
      link: "https://x.com/openai/status/200",
      feedUrl: "tikhub://x-topic/ai-apps",
    });
    const topicFeed: Feed = {
      ...feed([unchanged]),
      feedId: "ai-apps",
      sourceKind: "x-topic",
      sourceConfig: {
        kind: "x-topic",
        id: "ai-apps",
        name: "AI applications",
        includeKeywords: ["AI"],
        excludeKeywords: [],
        priorityAccounts: [],
        windowDays: 7,
        folder: "Topics",
      },
      url: "tikhub://x-topic/ai-apps",
    };
    const test = harness({ stored: true });

    const result = await test.service.collectFeedRefresh({
      feed: topicFeed,
      previousItems: [unchanged],
      refreshedItems: [unchanged],
      fetchedAt: new Date(2026, 6, 22, 10, 0, 0),
    });

    expect(result).toHaveLength(1);
    expect(test.repository.upsertDaily).toHaveBeenCalledWith(
      [expect.objectContaining({ id: "200", sourceId: "ai-apps" })],
      "2026-07-22",
    );
    expect(test.events.slice(-3)).toEqual(["jsonl", "markdown", "success"]);
  });

  it("marks an unchanged topic post rediscovered when it is observed on a later local date", async () => {
    const app = new App();
    const repository = new CollectionRepository(
      app.vault,
      ".task8-topic-rediscovery",
      () => new Date(2026, 6, 22, 10, 0, 0),
    );
    const ledger = { recordSuccess: vi.fn().mockResolvedValue(undefined) };
    const service = new CollectionService({
      repository,
      dailyIndex: new DailyIndexService(
        app.vault,
        "Task8 Topic Rediscovery",
      ),
      ledger,
    });
    const observed = item({
      guid: "200",
      link: "https://x.com/openai/status/200",
      feedUrl: "tikhub://x-topic/ai-apps",
    }) as FeedItem & {
      plainText: string;
      sourceMetadata: CollectedItem["sourceMetadata"];
    };
    observed.plainText = "Same provider observation";
    observed.sourceMetadata = {
      kind: "x-post",
      externalUrls: [],
      observationTags: ["latest"],
    };
    const topicFeed = {
      ...feed([observed]),
      feedId: "ai-apps",
      sourceKind: "x-topic" as const,
      sourceType: "x-topic" as const,
      sourceConfig: {
        kind: "x-topic" as const,
        id: "ai-apps",
        name: "AI applications",
        includeKeywords: ["AI"],
        excludeKeywords: [],
        priorityAccounts: [],
        windowDays: 7 as const,
        folder: "Topics",
      },
      url: "tikhub://x-topic/ai-apps",
    };

    await service.collectFeedRefresh({
      feed: topicFeed,
      previousItems: [],
      refreshedItems: [observed],
      fetchedAt: new Date(2026, 6, 21, 10, 0, 0),
    });
    await service.collectFeedRefresh({
      feed: topicFeed,
      previousItems: [observed],
      refreshedItems: [observed],
      fetchedAt: new Date(2026, 6, 22, 10, 0, 0),
    });

    const secondDay = await repository.listByDate("2026-07-22");
    expect(secondDay).toHaveLength(1);
    expect(secondDay[0]).toMatchObject({
      guid: "200",
      observationType: "rediscovered",
      topics: expect.arrayContaining(["x:latest"]),
    });
    expect(secondDay[0].id).toMatch(/^[a-f0-9]{64}$/u);
    expect(ledger.recordSuccess).toHaveBeenCalledTimes(2);
  });

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

  it("uses durable source observations as bootstrap truth when the ledger is missing", async () => {
    const unchanged = item();
    const test = harness({ bootstrapped: false, stored: true });

    const result = await test.service.collectFeedRefresh({
      feed: feed([unchanged]),
      previousItems: [unchanged],
      refreshedItems: [unchanged],
      fetchedAt: new Date(2026, 6, 21, 10, 0, 0),
    });

    expect(result).toEqual([]);
  });

  it("uses description when summary is blank while detecting material changes", async () => {
    const previous = item({ summary: "   ", description: "Old description" });
    const refreshed = { ...previous, description: "New description" };
    const test = harness({ stored: true });

    const result = await test.service.collectFeedRefresh({
      feed: feed([refreshed]),
      previousItems: [previous],
      refreshedItems: [refreshed],
      fetchedAt: new Date(2026, 6, 21, 10, 0, 0),
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      excerpt: "New description",
      observationType: "updated",
    });
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

  it("keeps durable JSONL and Markdown when success-ledger persistence fails", async () => {
    const current = item();
    const test = harness({ stored: false });
    test.ledger.recordSuccess.mockRejectedValueOnce(
      new Error("ledger unavailable"),
    );

    await expect(
      test.service.collectFeedRefresh({
        feed: feed([current]),
        previousItems: [],
        refreshedItems: [current],
        fetchedAt: new Date(2026, 6, 21, 10, 0, 0),
      }),
    ).rejects.toThrow("ledger unavailable");

    expect(test.repository.upsertDaily).toHaveBeenCalledTimes(1);
    expect(test.dailyIndex.writeDailyIndex).toHaveBeenCalledTimes(1);

    test.repository.hasItemsForSource.mockResolvedValue(true);
    const retry = await test.service.collectFeedRefresh({
      feed: feed([current]),
      previousItems: [current],
      refreshedItems: [current],
      fetchedAt: new Date(2026, 6, 21, 10, 5, 0),
    });
    expect(retry).toEqual([]);
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
