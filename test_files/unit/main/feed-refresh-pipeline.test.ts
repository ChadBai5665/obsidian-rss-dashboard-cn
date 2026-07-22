import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "crypto";
import { App } from "obsidian";
import RssDashboardPlugin from "../../../main";
import { DEFAULT_SETTINGS, type Feed, type FeedItem } from "../../../src/types/types";
import { FEED_REQUEST_TIMEOUT_MS } from "../../../src/services/feed-timeout";
import { CollectionService } from "../../../src/services/collection-service";
import { CollectionRepository } from "../../../src/collection/collection-repository";
import { RssDashboardView } from "../../../src/views/dashboard-view";
import { ReaderView } from "../../../src/views/reader-view";
import type { CollectedItem } from "../../../src/collection/collected-item";

let consoleLogSpy: ReturnType<typeof vi.spyOn>;

interface TestManifest {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  dir: string;
}

function createMockManifest(): TestManifest {
  return {
    id: "rss-dashboard",
    name: "RSS Dashboard",
    version: "1.0.0",
    author: "Test",
    description: "Test plugin",
    dir: ".",
  };
}

function createItem(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    title: "Test Article",
    link: "https://example.com/article",
    description: "<p>Desc</p>",
    pubDate: "2024-01-01T00:00:00.000Z",
    guid: "guid-1",
    read: false,
    starred: false,
    tags: [],
    feedTitle: "Feed A",
    feedUrl: "https://example.com/a.xml",
    coverImage: "",
    ...overrides,
  };
}

function createFeed(overrides: Partial<Feed> = {}): Feed {
  return {
    title: "Feed A",
    url: "https://example.com/a.xml",
    folder: "Uncategorized",
    items: [createItem()],
    lastUpdated: 1,
    mediaType: "article",
    ...overrides,
  };
}

interface TestFeedParser {
  refreshFeed: ReturnType<typeof vi.fn>;
  refreshAllFeeds: ReturnType<typeof vi.fn>;
}

interface AsyncVaultAdapter {
  write(path: string, contents: string): Promise<void>;
  read(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  rename?: (from: string, to: string) => Promise<void>;
}

interface TestPlugin {
  app: App;
  settings: typeof DEFAULT_SETTINGS;
  saveData: ReturnType<typeof vi.fn>;
  feedParser: TestFeedParser;
  refreshFeeds: (selectedFeeds?: Feed[]) => Promise<void>;
  activeRefreshState: Map<string, unknown>;
  getActiveDashboardView: ReturnType<typeof vi.fn>;
  validateSavedArticles: ReturnType<typeof vi.fn>;
  getSourceRefreshLedger: ReturnType<typeof vi.fn>;
  getCollectionService: ReturnType<typeof vi.fn>;
  refreshFailedSources: () => Promise<void>;
  refreshSelectedFeed: (feed: Feed) => Promise<void>;
  saveSettings: (options?: { forceAllShards?: boolean; forceMetadata?: boolean }) => Promise<void>;
}

function createPluginWithSettings(feeds: Feed[]): TestPlugin {
  const app = new App();
  const plugin = new RssDashboardPlugin(app as unknown as ConstructorParameters<typeof RssDashboardPlugin>[0], createMockManifest() as unknown as ConstructorParameters<typeof RssDashboardPlugin>[1]);

  const testPlugin = plugin as unknown as TestPlugin;

  testPlugin.settings = {
    ...DEFAULT_SETTINGS,
    feeds,
  };

  testPlugin.saveData = vi.fn().mockResolvedValue(undefined);

  testPlugin.feedParser = {
    refreshFeed: vi.fn(),
    refreshAllFeeds: vi.fn(),
  };

  testPlugin.getActiveDashboardView = vi.fn();
  testPlugin.validateSavedArticles = vi.fn();
  testPlugin.getSourceRefreshLedger = vi.fn(() => ({
    getSourceIdsWithStatus: vi.fn().mockResolvedValue([]),
    recordAttempt: vi.fn().mockResolvedValue(undefined),
    recordError: vi.fn().mockResolvedValue(undefined),
  }));
  testPlugin.getCollectionService = vi.fn(() => ({
    collectFeedRefresh: vi.fn().mockResolvedValue([]),
  }));

  return testPlugin;
}

function getNoticeMessages(spy: ReturnType<typeof vi.spyOn>): string[] {
  const calls = (spy as unknown as { mock: { calls: Array<Array<unknown>> } }).mock.calls;
  return calls
    .filter((call) => call[0] === "[Stub Notice]")
    .map((call) => String(call[1]));
}

function createTestSourceLocator(sourceId: string): string {
  return createHash("sha256").update(sourceId.trim()).digest("hex");
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  vi.restoreAllMocks();
  consoleLogSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("refreshFeeds() pipeline behavior", () => {
  it("restores vault metadata and its plugin pointer with feed files", async () => {
    const source = createFeed({ feedId: "source-transaction" });
    const plugin = createPluginWithSettings([source]);
    plugin.settings.storageMode = "vault-shards-v2";
    plugin.settings.storageFolder = "RSS Data/Feeds";
    plugin.settings.metadataStorageMode = "vault-location";
    plugin.settings.metadataStorageFolder = "RSS Metadata";
    plugin.saveData = vi.fn(async (data: unknown) => {
      await plugin.app.vault.adapter.write("data.json", JSON.stringify(data));
    });
    await plugin.saveSettings({ forceAllShards: true, forceMetadata: true });
    const paths = [
      "RSS Data/Feeds/source-transaction.json",
      "RSS Metadata/user-state.json",
      "RSS Metadata/data.json",
      "data.json",
    ];
    const oldBytes = new Map<string, string>();
    for (const path of paths) {
      oldBytes.set(path, await plugin.app.vault.adapter.read(path));
    }

    source.title = "Changed source";
    source.items[0].read = true;
    const adapter = plugin.app.vault.adapter as unknown as AsyncVaultAdapter;
    const originalWrite = adapter.write.bind(adapter);
    vi.spyOn(adapter, "write").mockImplementation(async (path, contents) => {
      if (
        path === "RSS Metadata/user-state.json" &&
        !contents.includes('"states": {}')
      ) {
        throw new Error("late user-state failure");
      }
      await originalWrite(path, contents);
    });

    await expect(
      plugin.saveSettings({ forceAllShards: true, forceMetadata: true }),
    ).rejects.toThrow("late user-state failure");

    for (const path of paths) {
      expect(await plugin.app.vault.adapter.read(path), path).toBe(
        oldBytes.get(path),
      );
    }
  });

  it("runs parser then the shared collection pipeline for a successful source", async () => {
    const source = createFeed({ feedId: "source-a" });
    const refreshed = {
      ...source,
      items: [...source.items, createItem({ guid: "article-2" })],
      lastUpdated: 2,
    };
    const plugin = createPluginWithSettings([source]);
    const events: string[] = [];
    const ledger = {
      getSourceIdsWithStatus: vi.fn().mockResolvedValue([]),
      recordAttempt: vi.fn(async () => events.push("attempt")),
      recordError: vi.fn(),
    };
    const collectFeedRefresh = vi.fn(async () => events.push("collect"));
    plugin.getSourceRefreshLedger = vi.fn(() => ledger);
    plugin.getCollectionService = vi.fn(() => ({ collectFeedRefresh }));
    (plugin.feedParser.refreshFeed as unknown as {
      mockImplementation: (fn: (feed: Feed) => Promise<Feed>) => void;
    }).mockImplementation(async () => {
      events.push("parser");
      return refreshed;
    });

    await plugin.refreshFeeds([source]);

    expect(events).toEqual(["attempt", "parser", "collect"]);
    expect(collectFeedRefresh).toHaveBeenCalledWith({
      feed: refreshed,
      previousItems: source.items,
      refreshedItems: refreshed.items,
      fetchedAt: expect.any(Date),
    });
    expect(ledger.recordError).not.toHaveBeenCalled();
  });

  it("records parser errors without touching collection persistence", async () => {
    const source = createFeed({ feedId: "source-a" });
    const plugin = createPluginWithSettings([source]);
    const ledger = {
      getSourceIdsWithStatus: vi.fn().mockResolvedValue([]),
      recordAttempt: vi.fn().mockResolvedValue(undefined),
      recordError: vi.fn().mockResolvedValue(undefined),
      recordSuccess: vi.fn().mockResolvedValue(undefined),
    };
    const collectFeedRefresh = vi.fn();
    plugin.getSourceRefreshLedger = vi.fn(() => ledger);
    plugin.getCollectionService = vi.fn(() => ({ collectFeedRefresh }));
    plugin.feedParser.refreshFeed.mockRejectedValue(new Error("offline"));

    await expect(plugin.refreshFeeds([source])).resolves.toBeUndefined();

    expect(collectFeedRefresh).not.toHaveBeenCalled();
    expect(ledger.recordError).toHaveBeenCalledWith(
      "source-a",
      expect.any(Date),
      { code: "refresh-failed", message: "Source refresh failed." },
    );
    expect(ledger.recordSuccess).not.toHaveBeenCalled();
  });

  it("treats a resolved feed with this-attempt lastFetchError as retryable failure", async () => {
    const source = createFeed({ feedId: "source-a" });
    const plugin = createPluginWithSettings([source]);
    const collectionPath = `${plugin.settings.collection.dataFolder}/collections/2026-07-20.jsonl`;
    await plugin.app.vault.adapter.write(collectionPath, "existing-observation\n");
    const ledger = {
      getSourceIdsWithStatus: vi.fn().mockResolvedValue([]),
      recordAttempt: vi.fn().mockResolvedValue(undefined),
      recordError: vi.fn().mockResolvedValue(undefined),
      recordSuccess: vi.fn().mockResolvedValue(undefined),
    };
    const repositoryUpsert = vi.fn(
      async (items: CollectedItem[]) => items,
    );
    const markdownWrite = vi.fn().mockResolvedValue("daily.md");
    const collectionService = new CollectionService({
      repository: {
        hasItemsForSource: vi.fn().mockResolvedValue(false),
        upsertDaily: repositoryUpsert,
      },
      dailyIndex: { writeDailyIndex: markdownWrite },
      ledger,
    });
    plugin.getSourceRefreshLedger = vi.fn(() => ledger);
    plugin.getCollectionService = vi.fn(() => collectionService);
    plugin.feedParser.refreshFeed
      .mockResolvedValueOnce({
        ...source,
        lastFetchError:
          "https://example.com/feed.xml?token=secret Authorization: Bearer hidden body-fragment",
      })
      .mockResolvedValueOnce({ ...source, lastFetchError: undefined });

    await plugin.refreshFeeds([source]);

    expect(repositoryUpsert).not.toHaveBeenCalled();
    expect(markdownWrite).not.toHaveBeenCalled();
    expect(ledger.recordError).toHaveBeenCalledWith(
      "source-a",
      expect.any(Date),
      { code: "refresh-failed", message: "Source refresh failed." },
    );
    expect(ledger.recordSuccess).not.toHaveBeenCalled();
    expect(await plugin.app.vault.adapter.read(collectionPath)).toBe(
      "existing-observation\n",
    );

    await plugin.refreshFeeds([source]);
    expect(plugin.feedParser.refreshFeed).toHaveBeenCalledTimes(2);
    expect(repositoryUpsert).toHaveBeenCalledTimes(1);
    expect(markdownWrite).toHaveBeenCalledTimes(1);
    expect(ledger.recordSuccess).toHaveBeenCalledTimes(1);
  });

  it("clears stale lastFetchError only on the isolated parser input", async () => {
    const source = createFeed({
      feedId: "source-a",
      lastFetchError: "Old failure",
    });
    const plugin = createPluginWithSettings([source]);
    const collectFeedRefresh = vi.fn().mockResolvedValue([]);
    plugin.getCollectionService = vi.fn(() => ({ collectFeedRefresh }));
    (plugin.feedParser.refreshFeed as unknown as {
      mockImplementation: (fn: (feed: Feed) => Promise<Feed>) => void;
    }).mockImplementation(async (parserInput) => {
      expect(parserInput).not.toBe(source);
      expect(parserInput.lastFetchError).toBeUndefined();
      return { ...parserInput, lastUpdated: 2 };
    });

    await plugin.refreshFeeds([source]);

    expect(collectFeedRefresh).toHaveBeenCalledTimes(1);
    expect(plugin.settings.feeds[0].lastUpdated).toBe(2);
  });

  it("snapshots previous material fields before a parser mutates items in place", async () => {
    const source = createFeed({ feedId: "source-a" });
    const plugin = createPluginWithSettings([source]);
    const collectFeedRefresh = vi.fn().mockResolvedValue([]);
    plugin.getCollectionService = vi.fn(() => ({ collectFeedRefresh }));
    (plugin.feedParser.refreshFeed as unknown as {
      mockImplementation: (fn: (feed: Feed) => Promise<Feed>) => void;
    }).mockImplementation(async (parsedFeed) => {
      parsedFeed.items[0].description = "Mutated description";
      return parsedFeed;
    });

    await plugin.refreshFeeds([source]);

    expect(collectFeedRefresh).toHaveBeenCalledWith(
      expect.objectContaining({
        previousItems: [expect.objectContaining({ description: "<p>Desc</p>" })],
        refreshedItems: [
          expect.objectContaining({ description: "Mutated description" }),
        ],
      }),
    );
  });

  it("keeps settings untouched when an in-place parser result later fails persistence", async () => {
    const source = createFeed({ feedId: "source-a" }) as Feed & {
      metadata?: { nested: string };
    };
    source.metadata = { nested: "original" };
    const sourceItem = source.items[0] as FeedItem & {
      metrics?: Record<string, number>;
    };
    sourceItem.metrics = { likes: 1 };
    const plugin = createPluginWithSettings([source]);
    plugin.getCollectionService = vi.fn(() => ({
      collectFeedRefresh: vi.fn().mockRejectedValue(new Error("disk full")),
    }));
    (plugin.feedParser.refreshFeed as unknown as {
      mockImplementation: (fn: (feed: Feed) => Promise<Feed>) => void;
    }).mockImplementation(async (parserInput) => {
      expect(parserInput).not.toBe(source);
      parserInput.title = "Mutated title";
      parserInput.items[0].description = "Mutated description";
      (parserInput.items[0] as FeedItem & { metrics: Record<string, number> })
        .metrics.likes = 999;
      (parserInput as Feed & { metadata: { nested: string } }).metadata.nested =
        "mutated";
      return parserInput;
    });

    await plugin.refreshFeeds([source]);

    expect(plugin.settings.feeds[0]).toBe(source);
    expect(source.title).toBe("Feed A");
    expect(source.items[0].description).toBe("<p>Desc</p>");
    expect(sourceItem.metrics).toEqual({ likes: 1 });
    expect(source.metadata).toEqual({ nested: "original" });
    expect(plugin.saveData).not.toHaveBeenCalled();
  });

  it("invalidates a late parser result after timeout before any write or merge", async () => {
    vi.useFakeTimers();
    const source = createFeed({ feedId: "source-a" });
    const plugin = createPluginWithSettings([source]);
    let resolveParser!: (feed: Feed) => void;
    const parserResult = new Promise<Feed>((resolve) => {
      resolveParser = resolve;
    });
    let parserInput!: Feed;
    (plugin.feedParser.refreshFeed as unknown as {
      mockImplementation: (fn: (feed: Feed) => Promise<Feed>) => void;
    }).mockImplementation((input) => {
      parserInput = input;
      return parserResult;
    });
    const ledger = {
      getSourceIdsWithStatus: vi.fn().mockResolvedValue([]),
      recordAttempt: vi.fn().mockResolvedValue(undefined),
      recordError: vi.fn().mockResolvedValue(undefined),
      recordSuccess: vi.fn().mockResolvedValue(undefined),
    };
    const repositoryUpsert = vi.fn(
      async (items: CollectedItem[]) => items,
    );
    const markdownWrite = vi.fn().mockResolvedValue("daily.md");
    const collectionService = new CollectionService({
      repository: {
        hasItemsForSource: vi.fn().mockResolvedValue(false),
        upsertDaily: repositoryUpsert,
      },
      dailyIndex: { writeDailyIndex: markdownWrite },
      ledger,
    });
    plugin.getSourceRefreshLedger = vi.fn(() => ledger);
    plugin.getCollectionService = vi.fn(() => collectionService);

    const refresh = plugin.refreshFeeds([source]);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(FEED_REQUEST_TIMEOUT_MS);
    await refresh;

    parserInput.items[0].description = "Late mutation";
    resolveParser(parserInput);
    await flushMicrotasks();

    expect(repositoryUpsert).not.toHaveBeenCalled();
    expect(markdownWrite).not.toHaveBeenCalled();
    expect(ledger.recordSuccess).not.toHaveBeenCalled();
    expect(source.items[0].description).toBe("<p>Desc</p>");
    expect(plugin.settings.feeds[0]).toBe(source);
    expect(plugin.saveData).not.toHaveBeenCalled();
  });

  it("never exposes raw parser secrets through ledger, console, or Notice", async () => {
    const source = createFeed({ feedId: "source-a" });
    const plugin = createPluginWithSettings([source]);
    const raw =
      "https://example.com/feed.xml?api_key=query-secret Authorization: Bearer auth-secret x-api-key=header-secret body-fragment";
    plugin.feedParser.refreshFeed.mockRejectedValue(new Error(raw));

    await plugin.refreshFeeds([source]);

    const renderedOutput = JSON.stringify({
      console: (console.error as unknown as { mock: { calls: unknown[][] } })
        .mock.calls,
      notices: getNoticeMessages(consoleLogSpy),
    });
    expect(renderedOutput).not.toContain("query-secret");
    expect(renderedOutput).not.toContain("auth-secret");
    expect(renderedOutput).not.toContain("header-secret");
    expect(renderedOutput).not.toContain("body-fragment");
    expect(renderedOutput).not.toContain("https://example.com/feed.xml");
  });

  it("records persistence errors, preserves the previous feed, and does not stop later sources", async () => {
    const sourceA = createFeed({ feedId: "source-a", url: "https://example.com/a.xml" });
    const sourceB = createFeed({
      feedId: "source-b",
      title: "Feed B",
      url: "https://example.com/b.xml",
      items: [createItem({ guid: "b-1", feedTitle: "Feed B", feedUrl: "https://example.com/b.xml" })],
    });
    const plugin = createPluginWithSettings([sourceA, sourceB]);
    const ledger = {
      getSourceIdsWithStatus: vi.fn().mockResolvedValue([]),
      recordAttempt: vi.fn().mockResolvedValue(undefined),
      recordError: vi.fn().mockResolvedValue(undefined),
    };
    const collectFeedRefresh = vi.fn(async ({ feed }: { feed: Feed }) => {
      if (feed.feedId === "source-a") throw new Error("disk full");
      return [];
    });
    plugin.getSourceRefreshLedger = vi.fn(() => ledger);
    plugin.getCollectionService = vi.fn(() => ({ collectFeedRefresh }));
    (plugin.feedParser.refreshFeed as unknown as {
      mockImplementation: (fn: (feed: Feed) => Promise<Feed>) => void;
    }).mockImplementation(async (source: Feed) => ({
        ...source,
        lastUpdated: source.feedId === "source-a" ? 10 : 20,
      }));

    await plugin.refreshFeeds();

    expect(plugin.settings.feeds[0].lastUpdated).toBe(1);
    expect(plugin.settings.feeds[1].lastUpdated).toBe(20);
    expect(ledger.recordError).toHaveBeenCalledWith(
      "source-a",
      expect.any(Date),
      { code: "collection-failed", message: "Collection persistence failed." },
    );
    expect(collectFeedRefresh).toHaveBeenCalledTimes(2);
  });

  it("routes all, failed-only, and selected-source refreshes through the same parser pipeline", async () => {
    const sourceA = createFeed({ feedId: "source-a", url: "https://example.com/a.xml" });
    const sourceB = createFeed({ feedId: "source-b", url: "https://example.com/b.xml" });
    const plugin = createPluginWithSettings([sourceA, sourceB]);
    const ledger = {
      getSourceIdsWithStatus: vi.fn().mockResolvedValue(["source-b", "deleted-source"]),
      recordAttempt: vi.fn().mockResolvedValue(undefined),
      recordError: vi.fn().mockResolvedValue(undefined),
    };
    const collectFeedRefresh = vi.fn().mockResolvedValue([]);
    plugin.getSourceRefreshLedger = vi.fn(() => ledger);
    plugin.getCollectionService = vi.fn(() => ({ collectFeedRefresh }));
    (plugin.feedParser.refreshFeed as unknown as {
      mockImplementation: (fn: (feed: Feed) => Promise<Feed>) => void;
    }).mockImplementation(async (source: Feed) => ({ ...source }));

    await plugin.refreshFeeds();
    await plugin.refreshFailedSources();
    await plugin.refreshSelectedFeed(sourceA);

    expect(plugin.feedParser.refreshFeed.mock.calls.map((call: unknown[]) => (call[0] as Feed).feedId)).toEqual([
      "source-a",
      "source-b",
      "source-b",
      "source-a",
    ]);
    expect(collectFeedRefresh).toHaveBeenCalledTimes(4);
  });

  it("refreshes multi-feed selections with bounded concurrency, incremental merges, and a final save + refresh", async () => {
    vi.useFakeTimers();
    const feedA = createFeed({
      title: "Feed A",
      url: "https://example.com/a.xml",
      items: [createItem({ guid: "a-1" })],
      lastUpdated: 100,
    });
    const feedB = createFeed({
      title: "Feed B",
      url: "https://example.com/b.xml",
      items: [createItem({ guid: "b-1", feedTitle: "Feed B", feedUrl: "https://example.com/b.xml" })],
      lastUpdated: 200,
    });
    const feedC = createFeed({
      title: "Feed C",
      url: "https://example.com/c.xml",
      items: [createItem({ guid: "c-1", feedTitle: "Feed C", feedUrl: "https://example.com/c.xml" })],
      lastUpdated: 300,
    });
    const feedD = createFeed({
      title: "Feed D",
      url: "https://example.com/d.xml",
      items: [createItem({ guid: "d-1", feedTitle: "Feed D", feedUrl: "https://example.com/d.xml" })],
      lastUpdated: 400,
    });
    const feedE = createFeed({
      title: "Feed E",
      url: "https://example.com/e.xml",
      items: [createItem({ guid: "e-1", feedTitle: "Feed E", feedUrl: "https://example.com/e.xml" })],
      lastUpdated: 500,
    });

    const plugin = createPluginWithSettings([feedA, feedB, feedC, feedD, feedE]);

    const updatedA = {
      ...feedA,
      lastUpdated: 999,
      items: [createItem({ guid: "a-1" }), createItem({ guid: "a-2" })],
    };
    const updatedB = {
      ...feedB,
      lastUpdated: 888,
      items: [createItem({ guid: "b-1", feedTitle: "Feed B", feedUrl: "https://example.com/b.xml" })],
    };
    const updatedC = {
      ...feedC,
      lastUpdated: 777,
      items: [createItem({ guid: "c-1", feedTitle: "Feed C", feedUrl: "https://example.com/c.xml" })],
    };
    const updatedD = {
      ...feedD,
      lastUpdated: 666,
      items: [createItem({ guid: "d-1", feedTitle: "Feed D", feedUrl: "https://example.com/d.xml" })],
    };
    const updatedE = {
      ...feedE,
      lastUpdated: 555,
      items: [createItem({ guid: "e-1", feedTitle: "Feed E", feedUrl: "https://example.com/e.xml" })],
    };

    const validateSpy = vi.spyOn(plugin, "validateSavedArticles");
    const viewRefreshSpy = vi.fn();
    const sidebarRefreshSpy = vi.fn();
    vi.spyOn(plugin, "getActiveDashboardView").mockResolvedValue({
      refreshSidebarOnly: sidebarRefreshSpy,
      refresh: viewRefreshSpy,
    } as unknown as Awaited<ReturnType<typeof RssDashboardPlugin.prototype.getActiveDashboardView>>);
    const refreshAllDashboards = vi
      .spyOn(plugin as unknown as RssDashboardPlugin, "refreshDashboardViews")
      .mockResolvedValue(undefined);

    const resolvers: Array<() => void> = [];
    (plugin.feedParser.refreshFeed as unknown as { mockImplementation: (fn: (feed: Feed) => Promise<Feed>) => void }).mockImplementation((feed: Feed) => {
      if (feed.url === feedE.url) {
        return Promise.resolve(updatedE);
      }

      return new Promise<Feed>((resolve) => {
        resolvers.push(() => {
          switch (feed.url) {
            case feedA.url:
              resolve(updatedA);
              break;
            case feedB.url:
              resolve(updatedB);
              break;
            case feedC.url:
              resolve(updatedC);
              break;
            case feedD.url:
              resolve(updatedD);
              break;
          }
        });
      });
    });

    const refreshPromise = plugin.refreshFeeds();
    await flushMicrotasks();

    expect(plugin.feedParser.refreshFeed.mock.calls.map((call: unknown[]) => (call[0] as Feed).url)).toEqual([
      "https://example.com/a.xml",
      "https://example.com/b.xml",
      "https://example.com/c.xml",
      "https://example.com/d.xml",
      "https://example.com/e.xml",
    ]);
    expect(sidebarRefreshSpy).toHaveBeenCalledTimes(1);
    expect(viewRefreshSpy).toHaveBeenCalledTimes(0);

    await vi.advanceTimersByTimeAsync(251);
    resolvers[0]?.();
    vi.runAllTicks();
    await Promise.resolve();

    resolvers[1]?.();
    resolvers[2]?.();
    resolvers[3]?.();
    await refreshPromise;

    expect(plugin.settings.feeds[0].url).toBe("https://example.com/a.xml");
    expect(plugin.settings.feeds[0].lastUpdated).toBe(999);
    expect(plugin.settings.feeds[0].items).toHaveLength(2);
    expect(plugin.settings.feeds[1].url).toBe("https://example.com/b.xml");
    expect(plugin.settings.feeds[1].lastUpdated).toBe(888);
    expect(plugin.settings.feeds[2].lastUpdated).toBe(777);
    expect(plugin.settings.feeds[3].lastUpdated).toBe(666);
    expect(plugin.settings.feeds[4].lastUpdated).toBe(555);
    expect(plugin.feedParser.refreshFeed.mock.calls.map((call: unknown[]) => (call[0] as Feed).url)).toEqual([
      "https://example.com/a.xml",
      "https://example.com/b.xml",
      "https://example.com/c.xml",
      "https://example.com/d.xml",
      "https://example.com/e.xml",
    ]);

    expect(validateSpy).toHaveBeenCalledTimes(1);
    expect(validateSpy).toHaveBeenCalledWith({
      suppressCollectionBroadcast: true,
    });
    expect(plugin.saveData).toHaveBeenCalledTimes(1);
    expect(sidebarRefreshSpy).toHaveBeenCalledTimes(2);
    expect(viewRefreshSpy).toHaveBeenCalledTimes(0);
    expect(refreshAllDashboards).toHaveBeenCalledTimes(1);
    expect(plugin.feedParser.refreshAllFeeds).not.toHaveBeenCalled();

    const notices = getNoticeMessages(consoleLogSpy);
    expect(notices[0]).toBe("正在刷新 5 个订阅…");
    expect(notices).toContain("已刷新：5 个订阅");
  });

  it("refreshes a single feed via the direct path and does not require an active dashboard view", async () => {
    const feedA = createFeed({
      title: "Feed A",
      url: "https://example.com/a.xml",
      lastUpdated: 100,
    });
    const feedB = createFeed({
      title: "Feed B",
      url: "https://example.com/b.xml",
      lastUpdated: 200,
    });

    const plugin = createPluginWithSettings([feedA, feedB]);

    const updatedB = {
      ...feedB,
      lastUpdated: 777,
    };
    (plugin.feedParser.refreshFeed as unknown as { mockResolvedValue: (value: Feed) => void }).mockResolvedValue(updatedB);

    vi.spyOn(plugin, "getActiveDashboardView").mockResolvedValue(null);
    const refreshAllDashboards = vi
      .spyOn(plugin as unknown as RssDashboardPlugin, "refreshDashboardViews")
      .mockResolvedValue(undefined);

    await plugin.refreshFeeds([feedB]);

    expect(plugin.feedParser.refreshFeed).toHaveBeenCalledWith(feedB);
    expect(plugin.feedParser.refreshAllFeeds).not.toHaveBeenCalled();
    expect(plugin.settings.feeds[0].lastUpdated).toBe(100);
    expect(plugin.settings.feeds[1].lastUpdated).toBe(777);
    expect(plugin.validateSavedArticles).toHaveBeenCalledWith({
      suppressCollectionBroadcast: true,
    });
    expect(plugin.saveData).toHaveBeenCalledTimes(1);
    expect(refreshAllDashboards).toHaveBeenCalledTimes(1);

    const notices = getNoticeMessages(consoleLogSpy);
    expect(notices[0]).toBe("正在刷新 Feed B…");
    expect(notices).toContain("已刷新：Feed B");
  });

  it("times out a stalled feed without blocking the rest of a multi-feed refresh", async () => {
    vi.useFakeTimers();
    const feedA = createFeed({
      title: "Feed A",
      url: "https://example.com/a.xml",
      lastUpdated: 100,
    });
    const feedB = createFeed({
      title: "Feed B",
      url: "https://example.com/b.xml",
      lastUpdated: 200,
    });
    const plugin = createPluginWithSettings([feedA, feedB]);
    const viewRefreshSpy = vi.fn();
    const sidebarRefreshSpy = vi.fn();
    vi.spyOn(plugin, "getActiveDashboardView").mockResolvedValue({
      refreshSidebarOnly: sidebarRefreshSpy,
      refresh: viewRefreshSpy,
    } as unknown as Awaited<ReturnType<typeof RssDashboardPlugin.prototype.getActiveDashboardView>>);
    const refreshAllDashboards = vi
      .spyOn(plugin as unknown as RssDashboardPlugin, "refreshDashboardViews")
      .mockResolvedValue(undefined);

    (plugin.feedParser.refreshFeed as unknown as { mockImplementation: (fn: (feed: Feed) => Promise<Feed>) => void }).mockImplementation((feed: Feed) => {
      if (feed.url === feedA.url) {
        return new Promise<Feed>(() => undefined);
      }

      return Promise.resolve({
        ...feedB,
        lastUpdated: 777,
      });
    });

    const refreshPromise = plugin.refreshFeeds();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(FEED_REQUEST_TIMEOUT_MS);
    await refreshPromise;

    expect(plugin.settings.feeds[0].lastUpdated).toBe(100);
    expect(plugin.settings.feeds[1].lastUpdated).toBe(777);
    expect(plugin.saveData).toHaveBeenCalledTimes(1);
    expect(sidebarRefreshSpy).toHaveBeenCalledTimes(1);
    expect(viewRefreshSpy).toHaveBeenCalledTimes(0);
    expect(refreshAllDashboards).toHaveBeenCalledTimes(1);
    expect(plugin.activeRefreshState.size).toBe(0);

    const notices = getNoticeMessages(consoleLogSpy);
    expect(notices[0]).toBe("正在刷新 2 个订阅…");
    expect(notices).toContain("已刷新：2 个订阅（1 个超时）");
  });

  it("swallows direct refresh errors and shows an error Notice", async () => {
    const plugin = createPluginWithSettings([createFeed()]);

    (plugin.feedParser.refreshFeed as unknown as { mockRejectedValue: (error: Error) => void }).mockRejectedValue(
      new Error("network down"),
    );

    await expect(plugin.refreshFeeds([plugin.settings.feeds[0]])).resolves.toBeUndefined();
    expect(plugin.saveData).not.toHaveBeenCalled();

    const notices = getNoticeMessages(consoleLogSpy);
    expect(notices[0]).toBe("正在刷新 Feed A…");
    expect(notices).toContain(
      "来源刷新失败，请查看来源状态了解详情。",
    );
  });

  it("skips refresh cleanly when there are no feeds", async () => {
    const plugin = createPluginWithSettings([]);

    await expect(plugin.refreshFeeds()).resolves.toBeUndefined();

    expect(plugin.feedParser.refreshFeed).not.toHaveBeenCalled();
    expect(plugin.feedParser.refreshAllFeeds).not.toHaveBeenCalled();
    expect(plugin.saveData).not.toHaveBeenCalled();
    expect(getNoticeMessages(consoleLogSpy)).toEqual([]);
  });

  it("skips refresh when feedParser is not initialized yet", async () => {
    const plugin = createPluginWithSettings([createFeed()]);
    plugin.feedParser = undefined as unknown as TestFeedParser;
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(plugin.refreshFeeds()).resolves.toBeUndefined();

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      "[RSS dashboard] Feed parser not initialized; skipping refresh.",
    );
    expect(plugin.saveData).not.toHaveBeenCalled();
    expect(getNoticeMessages(consoleLogSpy)).toEqual([]);
  });

  it("writes durable read/starred/saved cancellation flags by stable collection ID without a duplicate dashboard reload", async () => {
    const article = createItem({
      rssDashboardId: "a".repeat(64),
      read: true,
      starred: true,
      saved: false,
    });
    const source = createFeed({ feedId: "source-replay", items: [article] });
    const plugin = createPluginWithSettings([source]) as unknown as TestPlugin & {
      updateArticle: (
        guid: string,
        url: string,
        updates: Partial<FeedItem>,
      ) => Promise<void>;
      refreshDashboardViews: ReturnType<typeof vi.fn>;
    };
    const updateFlags = vi
      .spyOn(CollectionRepository.prototype, "updateFlags")
      .mockResolvedValue(undefined);
    vi.spyOn(CollectionRepository.prototype, "findById").mockResolvedValue({
      read: false,
      starred: false,
      saved: true,
      savedNotePath: "Information/Saved.md",
    } as never);
    plugin.refreshDashboardViews = vi.fn().mockResolvedValue(undefined);

    await plugin.updateArticle(article.guid, source.url, { saved: false });

    expect(updateFlags).toHaveBeenCalledWith("a".repeat(64), {
      read: true,
      starred: true,
      saved: false,
      savedNotePath: undefined,
    });
    expect(plugin.refreshDashboardViews).not.toHaveBeenCalled();
  });

  it("keeps feed state unchanged when durable collection status persistence fails", async () => {
    const stableId = "b".repeat(64);
    const article = createItem({ rssDashboardId: stableId, read: false });
    const source = createFeed({ items: [article] });
    const plugin = createPluginWithSettings([source]) as unknown as TestPlugin & {
      updateArticle: (
        guid: string,
        url: string,
        updates: Partial<FeedItem>,
      ) => Promise<boolean>;
    };
    vi.spyOn(CollectionRepository.prototype, "findById").mockResolvedValue({
      read: false,
      starred: false,
      saved: false,
    } as never);
    vi.spyOn(CollectionRepository.prototype, "updateFlags").mockRejectedValue(
      new Error("vault/private?token=secret"),
    );

    await expect(plugin.updateArticle(article.guid, source.url, { read: true })).resolves.toBe(false);

    expect(source.items[0].read).toBe(false);
    expect(plugin.saveData).not.toHaveBeenCalled();
    expect(getNoticeMessages(consoleLogSpy).join(" ")).not.toContain("secret");
  });

  it("returns durable success even when every post-commit UI observer fails", async () => {
    const article = createItem({ read: false });
    const source = createFeed({ items: [article] });
    const plugin = createPluginWithSettings([source]) as unknown as TestPlugin & {
      updateArticle: (
        guid: string,
        url: string,
        updates: Partial<FeedItem>,
      ) => Promise<boolean>;
      syncDashboardArticleUpdate: ReturnType<typeof vi.fn>;
      syncReaderArticleUpdate: ReturnType<typeof vi.fn>;
    };
    plugin.syncDashboardArticleUpdate = vi.fn().mockRejectedValue(
      new Error("dashboard observer failed"),
    );
    plugin.syncReaderArticleUpdate = vi.fn().mockRejectedValue(
      new Error("reader observer failed"),
    );

    await expect(
      plugin.updateArticle(article.guid, source.url, { read: true }),
    ).resolves.toBe(true);

    expect(article.read).toBe(true);
    expect(plugin.syncDashboardArticleUpdate).toHaveBeenCalledTimes(1);
    expect(plugin.syncReaderArticleUpdate).toHaveBeenCalledTimes(1);
  });

  it("continues notifying later dashboard and reader leaves after one leaf fails", async () => {
    const plugin = createPluginWithSettings([]);
    const dashboardPlugin = { settings: plugin.settings, saveSettings: vi.fn() };
    const firstDashboard = new RssDashboardView(
      { app: plugin.app } as unknown as import("obsidian").WorkspaceLeaf,
      dashboardPlugin as never,
    );
    const secondDashboard = new RssDashboardView(
      { app: plugin.app } as unknown as import("obsidian").WorkspaceLeaf,
      dashboardPlugin as never,
    );
    firstDashboard.applyExternalArticleUpdate = vi.fn(() => {
      throw new Error("first dashboard failed");
    });
    secondDashboard.applyExternalArticleUpdate = vi.fn();

    const readerArgs = [
      plugin.settings,
      { saveArticle: vi.fn() },
      vi.fn(),
      vi.fn(),
    ] as const;
    const firstReader = new ReaderView(
      { app: plugin.app } as unknown as import("obsidian").WorkspaceLeaf,
      ...readerArgs as never,
    );
    const secondReader = new ReaderView(
      { app: plugin.app } as unknown as import("obsidian").WorkspaceLeaf,
      ...readerArgs as never,
    );
    firstReader.applyExternalUpdate = vi.fn(() => {
      throw new Error("first reader failed");
    });
    secondReader.applyExternalUpdate = vi.fn();
    plugin.app.workspace.getLeavesOfType = vi.fn((type: string) => {
      const views = type === "rss-dashboard-view"
        ? [firstDashboard, secondDashboard]
        : [firstReader, secondReader];
      return views.map((view) => ({ view, loadIfDeferred: vi.fn() }));
    });
    const internals = plugin as unknown as {
      syncDashboardArticleUpdate: (
        guid: string,
        feedUrl: string,
        updates: Partial<FeedItem>,
        rerender: boolean,
      ) => Promise<void>;
      syncReaderArticleUpdate: (
        guid: string,
        updates: Partial<FeedItem>,
      ) => Promise<void>;
    };

    await expect(internals.syncDashboardArticleUpdate(
      "guid", "feed", { read: true }, false,
    )).resolves.toBeUndefined();
    await expect(internals.syncReaderArticleUpdate(
      "guid", { read: true },
    )).resolves.toBeUndefined();

    expect(secondDashboard.applyExternalArticleUpdate).toHaveBeenCalledTimes(1);
    expect(secondReader.applyExternalUpdate).toHaveBeenCalledTimes(1);
  });

  it("rejects an entire read batch when any requested target is missing", async () => {
    const article = createItem({ read: false });
    const source = createFeed({ items: [article] });
    const plugin = createPluginWithSettings([source]) as unknown as TestPlugin & {
      updateArticlesReadBatch: (
        targets: Array<{ articleGuid: string; feedUrl: string }>,
        read: boolean,
      ) => Promise<boolean>;
    };

    await expect(plugin.updateArticlesReadBatch([
      { articleGuid: article.guid, feedUrl: source.url },
      { articleGuid: "missing", feedUrl: source.url },
    ], true)).resolves.toBe(false);

    expect(article.read).toBe(false);
    expect(plugin.saveData).not.toHaveBeenCalled();
  });

  it("keeps valid stable-id items feed-only when no collection record exists", async () => {
    const article = createItem({ rssDashboardId: "7".repeat(64), read: false });
    const source = createFeed({ items: [article] });
    const plugin = createPluginWithSettings([source]) as unknown as TestPlugin & {
      updateArticlesReadBatch: (
        targets: Array<{ articleGuid: string; feedUrl: string }>,
        read: boolean,
      ) => Promise<boolean>;
    };
    vi.spyOn(CollectionRepository.prototype, "findById").mockResolvedValue(null);
    const collectionEvent = vi.spyOn(
      plugin as never,
      "emitCollectionFlagsUpdated" as never,
    );

    await expect(plugin.updateArticlesReadBatch([
      { articleGuid: article.guid, feedUrl: source.url },
    ], true)).resolves.toBe(true);

    expect(article.read).toBe(true);
    expect(plugin.saveData).toHaveBeenCalledTimes(1);
    expect(collectionEvent).not.toHaveBeenCalled();
  });

  it("contains collection lookup failures for read batches without mutation", async () => {
    const article = createItem({ rssDashboardId: "6".repeat(64), read: false });
    const source = createFeed({ items: [article] });
    const plugin = createPluginWithSettings([source]) as unknown as TestPlugin & {
      updateArticlesReadBatch: (
        targets: Array<{ articleGuid: string; feedUrl: string }>,
        read: boolean,
      ) => Promise<boolean>;
    };
    vi.spyOn(CollectionRepository.prototype, "findById").mockRejectedValue(
      new Error("vault/private?token=secret"),
    );

    await expect(plugin.updateArticlesReadBatch([
      { articleGuid: article.guid, feedUrl: source.url },
    ], true)).resolves.toBe(false);

    expect(article.read).toBe(false);
    expect(plugin.saveData).not.toHaveBeenCalled();
    expect(getNoticeMessages(consoleLogSpy).join(" ")).not.toContain("secret");
  });

  it("broadcasts one collection reload after validating multiple missing notes", async () => {
    const first = createItem({
      guid: "first",
      rssDashboardId: "1".repeat(64),
      saved: true,
      savedFilePath: "Information/Saved/First.md",
    });
    const second = createItem({
      guid: "second",
      rssDashboardId: "2".repeat(64),
      saved: true,
      savedFilePath: "Information/Saved/Second.md",
    });
    const source = createFeed({ items: [first, second] });
    const plugin = createPluginWithSettings([source]) as unknown as TestPlugin & {
      articleSaver: { checkSavedFileExists: ReturnType<typeof vi.fn> };
      updateArticleWithOutcome: ReturnType<typeof vi.fn>;
      validateSavedArticles: () => Promise<boolean>;
    };
    plugin.articleSaver = {
      checkSavedFileExists: vi.fn().mockResolvedValue(false),
    };
    plugin.updateArticleWithOutcome = vi.fn().mockResolvedValue("collection");
    delete (plugin as unknown as Record<string, unknown>).validateSavedArticles;
    const collectionLoad = vi.fn();
    const collectionEvent = vi
      .spyOn(plugin as never, "emitCollectionFlagsUpdated" as never)
      .mockImplementation(collectionLoad as never);

    await plugin.validateSavedArticles();

    expect(plugin.updateArticleWithOutcome).toHaveBeenCalledTimes(2);
    expect(collectionEvent).toHaveBeenCalledTimes(1);
    expect(collectionLoad).toHaveBeenCalledTimes(1);
  });

  it("does not broadcast collection reload for validation feed-only updates", async () => {
    const article = createItem({
      rssDashboardId: "5".repeat(64),
      saved: true,
      savedFilePath: "Information/Saved/Missing.md",
    });
    const source = createFeed({ items: [article] });
    const plugin = createPluginWithSettings([source]) as unknown as TestPlugin & {
      articleSaver: { checkSavedFileExists: ReturnType<typeof vi.fn> };
      updateArticleWithOutcome: ReturnType<typeof vi.fn>;
      validateSavedArticles: () => Promise<boolean>;
    };
    plugin.articleSaver = {
      checkSavedFileExists: vi.fn().mockResolvedValue(false),
    };
    plugin.updateArticleWithOutcome = vi.fn().mockResolvedValue("feed-only");
    delete (plugin as unknown as Record<string, unknown>).validateSavedArticles;
    const collectionEvent = vi.spyOn(
      plugin as never,
      "emitCollectionFlagsUpdated" as never,
    );

    await expect(plugin.validateSavedArticles()).resolves.toBe(false);

    expect(collectionEvent).not.toHaveBeenCalled();
  });

  it("keeps a safe prepared journal when collection persistence fails", async () => {
    const stableId = "c".repeat(64);
    const article = createItem({ rssDashboardId: stableId, read: false });
    const source = createFeed({ items: [article] });
    const plugin = createPluginWithSettings([source]) as unknown as TestPlugin & {
      updateArticle: (
        guid: string,
        url: string,
        updates: Partial<FeedItem>,
      ) => Promise<boolean>;
    };
    vi.spyOn(CollectionRepository.prototype, "findById").mockResolvedValue({
      read: false,
      starred: false,
      saved: false,
    } as never);
    vi.spyOn(CollectionRepository.prototype, "updateFlags").mockRejectedValue(
      new Error("write failed"),
    );

    await expect(plugin.updateArticle(article.guid, source.url, { read: true })).resolves.toBe(false);

    const adapter = plugin.app.vault.adapter as unknown as AsyncVaultAdapter;
    const journalPath = ".rss-dashboard-data/state/status-repair.json";
    expect(await adapter.exists(journalPath)).toBe(true);
    const journal = await adapter.read(journalPath);
    expect(journal).toContain('"phase":"prepared"');
    expect(journal).toContain(stableId);
    expect(journal).not.toContain("https://example.com");
    expect(journal).not.toContain("Desc");
  });

  it("verifies successful compensation before clearing its status journal", async () => {
    const article = createItem({ read: false });
    const source = createFeed({ feedId: "source-compensate", items: [article] });
    const plugin = createPluginWithSettings([source]) as unknown as TestPlugin & {
      saveSettings: ReturnType<typeof vi.fn>;
    };
    plugin.saveSettings = vi.fn()
      .mockRejectedValueOnce(new Error("primary write failed"))
      .mockResolvedValue(undefined);
    const canonical = ".rss-dashboard-data/state/status-repair.json";

    await expect(
      plugin.updateArticle(article.guid, source.url, { read: true }),
    ).resolves.toBe(false);

    expect(article.read).toBe(false);
    expect(plugin.saveSettings).toHaveBeenCalledTimes(2);
    expect(await plugin.app.vault.adapter.exists(canonical)).toBe(false);
    expect(await plugin.app.vault.adapter.exists(`${canonical}.tmp`)).toBe(false);
  });

  it("journals an explicitly undefined optional feed field without data loss", async () => {
    const article = createItem({ saved: true, savedFilePath: undefined });
    const source = createFeed({ feedId: "source-undefined", items: [article] });
    const plugin = createPluginWithSettings([source]) as unknown as TestPlugin & {
      updateArticle: (
        guid: string,
        url: string,
        updates: Partial<FeedItem>,
      ) => Promise<boolean>;
    };

    await expect(plugin.updateArticle(article.guid, source.url, {
      saved: false,
      savedFilePath: undefined,
    })).resolves.toBe(true);

    expect(article.saved).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(article, "savedFilePath")).toBe(true);
    expect(article.savedFilePath).toBeUndefined();
  });

  it("replays a prepared journal to the previous feed state before clearing it", async () => {
    const stableId = "d".repeat(64);
    const article = createItem({ rssDashboardId: stableId, read: true });
    const source = createFeed({ feedId: "source-replay", items: [article] });
    const plugin = createPluginWithSettings([source]) as unknown as TestPlugin & {
      replayStatusRepairJournalIfNeeded: () => Promise<boolean>;
      updateArticle: (
        guid: string,
        url: string,
        updates: Partial<FeedItem>,
      ) => Promise<boolean>;
      saveSettings: ReturnType<typeof vi.fn>;
    };
    plugin.saveSettings = vi.fn().mockResolvedValue(undefined);
    const collectionState = { read: true, starred: false, saved: false };
    vi.spyOn(CollectionRepository.prototype, "findById").mockImplementation(
      async () => collectionState as never,
    );
    vi.spyOn(CollectionRepository.prototype, "updateFlags").mockImplementation(
      async (_id, next) => { Object.assign(collectionState, next); },
    );
    const path = ".rss-dashboard-data/state/status-repair.json";
    await plugin.app.vault.adapter.write(path, JSON.stringify({
      version: 1, txId: "tx-4-safe", phase: "collection-written", items: [{
        feedIndex: 0, itemIndex: 0,
        sourceLocator: createTestSourceLocator("source-replay"), stableId,
        previousFeed: [{ key: "read", exists: true, value: false }],
        previousCollection: { read: false, starred: false, saved: false },
      }],
    }));
    const clearSpy = vi.spyOn(plugin as never, "clearStatusJournal" as never);
    await plugin.replayStatusRepairJournalIfNeeded();
    expect(article.read).toBe(false);
    expect(clearSpy).toHaveBeenCalled();
    expect(await plugin.app.vault.adapter.exists(path)).toBe(false);
  });

  it("retains conflicting canonical and temporary journals with different transactions", async () => {
    const stableId = "4".repeat(64);
    const article = createItem({ rssDashboardId: stableId, read: true });
    const source = createFeed({ feedId: "source-conflict", items: [article] });
    const plugin = createPluginWithSettings([source]) as unknown as TestPlugin & {
      replayStatusRepairJournalIfNeeded: () => Promise<boolean>;
      updateArticle: (
        guid: string,
        url: string,
        updates: Partial<FeedItem>,
      ) => Promise<boolean>;
      saveSettings: ReturnType<typeof vi.fn>;
    };
    plugin.saveSettings = vi.fn().mockResolvedValue(undefined);
    const canonical = ".rss-dashboard-data/state/status-repair.json";
    const item = {
      feedIndex: 0,
      itemIndex: 0,
      sourceLocator: createTestSourceLocator("source-conflict"),
      stableId,
      previousFeed: [{ key: "read", exists: true, value: false }],
    };
    const canonicalBytes = JSON.stringify({
      version: 1, txId: "tx-10-alpha", phase: "prepared", items: [item],
    });
    const temporaryBytes = JSON.stringify({
      version: 1, txId: "tx-11-beta", phase: "feed-written", items: [item],
    });
    await plugin.app.vault.adapter.write(canonical, canonicalBytes);
    await plugin.app.vault.adapter.write(`${canonical}.tmp`, temporaryBytes);

    await expect(plugin.replayStatusRepairJournalIfNeeded()).resolves.toBe(false);
    await expect(
      plugin.updateArticle(article.guid, source.url, { starred: true }),
    ).resolves.toBe(false);

    expect(article.read).toBe(true);
    expect(article.starred).toBe(false);
    expect(plugin.saveSettings).not.toHaveBeenCalled();
    expect(await plugin.app.vault.adapter.read(canonical)).toBe(canonicalBytes);
    expect(await plugin.app.vault.adapter.read(`${canonical}.tmp`)).toBe(temporaryBytes);
  });

  it("retains same-transaction journals when immutable payloads differ", async () => {
    const stableId = "3".repeat(64);
    const article = createItem({ rssDashboardId: stableId, read: true });
    const source = createFeed({ feedId: "source-payload", items: [article] });
    const plugin = createPluginWithSettings([source]) as unknown as TestPlugin & {
      replayStatusRepairJournalIfNeeded: () => Promise<boolean>;
      saveSettings: ReturnType<typeof vi.fn>;
    };
    plugin.saveSettings = vi.fn().mockResolvedValue(undefined);
    const canonical = ".rss-dashboard-data/state/status-repair.json";
    const baseItem = {
      feedIndex: 0,
      itemIndex: 0,
      sourceLocator: createTestSourceLocator("source-payload"),
      stableId,
    };
    const canonicalBytes = JSON.stringify({
      version: 1,
      txId: "tx-12-same",
      phase: "prepared",
      items: [{
        ...baseItem,
        previousFeed: [{ key: "read", exists: true, value: false }],
      }],
    });
    const temporaryBytes = JSON.stringify({
      version: 1,
      txId: "tx-12-same",
      phase: "collection-written",
      items: [{
        ...baseItem,
        previousFeed: [{ key: "read", exists: true, value: true }],
      }],
    });
    await plugin.app.vault.adapter.write(canonical, canonicalBytes);
    await plugin.app.vault.adapter.write(`${canonical}.tmp`, temporaryBytes);

    await expect(plugin.replayStatusRepairJournalIfNeeded()).resolves.toBe(false);

    expect(article.read).toBe(true);
    expect(plugin.saveSettings).not.toHaveBeenCalled();
    expect(await plugin.app.vault.adapter.read(canonical)).toBe(canonicalBytes);
    expect(await plugin.app.vault.adapter.read(`${canonical}.tmp`)).toBe(temporaryBytes);
  });

  it("chooses the more advanced phase for matching canonical and temporary journals", async () => {
    const stableId = "2".repeat(64);
    const article = createItem({ rssDashboardId: stableId, read: true });
    const source = createFeed({ feedId: "source-progress", items: [article] });
    const plugin = createPluginWithSettings([source]) as unknown as TestPlugin & {
      readRecoverableStatusJournal: () => Promise<{ phase: string } | null>;
      replayStatusRepairJournalIfNeeded: () => Promise<boolean>;
      saveSettings: ReturnType<typeof vi.fn>;
    };
    plugin.saveSettings = vi.fn().mockResolvedValue(undefined);
    const canonical = ".rss-dashboard-data/state/status-repair.json";
    const item = {
      feedIndex: 0,
      itemIndex: 0,
      sourceLocator: createTestSourceLocator("source-progress"),
      stableId,
      previousFeed: [{ key: "read", exists: true, value: false }],
    };
    await plugin.app.vault.adapter.write(canonical, JSON.stringify({
      version: 1, txId: "tx-13-progress", phase: "prepared", items: [item],
    }));
    await plugin.app.vault.adapter.write(`${canonical}.tmp`, JSON.stringify({
      version: 1, txId: "tx-13-progress", phase: "feed-written", items: [item],
    }));

    await expect(plugin.readRecoverableStatusJournal()).resolves.toMatchObject({
      phase: "feed-written",
    });
    await expect(plugin.replayStatusRepairJournalIfNeeded()).resolves.toBe(true);

    expect(article.read).toBe(false);
    expect(await plugin.app.vault.adapter.exists(canonical)).toBe(false);
    expect(await plugin.app.vault.adapter.exists(`${canonical}.tmp`)).toBe(false);
  });

  it("retains the journal when a replay record cannot be resolved", async () => {
    const source = createFeed({ items: [createItem()] });
    const plugin = createPluginWithSettings([source]) as unknown as TestPlugin & {
      replayStatusRepairJournalIfNeeded: () => Promise<boolean>;
      saveSettings: ReturnType<typeof vi.fn>;
    };
    plugin.saveSettings = vi.fn().mockResolvedValue(undefined);
    const path = ".rss-dashboard-data/state/status-repair.json";
    await plugin.app.vault.adapter.write(path, JSON.stringify({
      version: 1,
      txId: "tx-5-missing",
      phase: "prepared",
      items: [{
        feedIndex: 9,
        itemIndex: 9,
        sourceLocator: createTestSourceLocator("missing-source"),
        stableId: "b".repeat(64),
        previousFeed: [{ key: "read", exists: true, value: false }],
      }],
    }));

    await plugin.replayStatusRepairJournalIfNeeded();

    expect(await plugin.app.vault.adapter.exists(path)).toBe(true);
    expect(plugin.saveSettings).not.toHaveBeenCalled();
  });

  it("recovers a corrupt canonical journal from a valid temporary record", async () => {
    const stableId = "e".repeat(64);
    const article = createItem({ rssDashboardId: stableId, read: true });
    const source = createFeed({ feedId: "source-safe", items: [article] });
    const plugin = createPluginWithSettings([source]) as unknown as TestPlugin & {
      replayStatusRepairJournalIfNeeded: () => Promise<boolean>;
      saveSettings: ReturnType<typeof vi.fn>;
    };
    plugin.saveSettings = vi.fn().mockResolvedValue(undefined);
    const canonical = ".rss-dashboard-data/state/status-repair.json";
    await plugin.app.vault.adapter.write(canonical, "{broken");
    await plugin.app.vault.adapter.write(`${canonical}.tmp`, JSON.stringify({
      version: 1,
      txId: "tx-1-safe",
      phase: "prepared",
      items: [{
        feedIndex: 9,
        itemIndex: 9,
        sourceLocator: createTestSourceLocator("source-safe"),
        stableId,
        previousFeed: [{ key: "read", exists: true, value: false }],
      }],
    }));

    await expect(plugin.replayStatusRepairJournalIfNeeded()).resolves.toBe(true);

    expect(article.read).toBe(false);
    expect(await plugin.app.vault.adapter.exists(canonical)).toBe(false);
    expect(await plugin.app.vault.adapter.exists(`${canonical}.tmp`)).toBe(false);
  });

  it("relocates journal items by source and stable identity after reordering", async () => {
    const stableId = "9".repeat(64);
    const target = createItem({ guid: "target", rssDashboardId: stableId, read: true });
    const decoy = createItem({ guid: "decoy", rssDashboardId: "8".repeat(64), read: true });
    const source = createFeed({ feedId: "source-relocated", items: [decoy, target] });
    const plugin = createPluginWithSettings([source]) as unknown as TestPlugin & {
      replayStatusRepairJournalIfNeeded: () => Promise<boolean>;
      saveSettings: ReturnType<typeof vi.fn>;
    };
    plugin.saveSettings = vi.fn().mockResolvedValue(undefined);
    const canonical = ".rss-dashboard-data/state/status-repair.json";
    await plugin.app.vault.adapter.write(canonical, JSON.stringify({
      version: 1,
      txId: "tx-6-relocate",
      phase: "prepared",
      items: [{
        feedIndex: 99,
        itemIndex: 0,
        sourceLocator: createTestSourceLocator("source-relocated"),
        stableId,
        previousFeed: [{ key: "read", exists: true, value: false }],
      }],
    }));

    await expect(plugin.replayStatusRepairJournalIfNeeded()).resolves.toBe(true);

    expect(target.read).toBe(false);
    expect(decoy.read).toBe(true);
    expect(await plugin.app.vault.adapter.exists(canonical)).toBe(false);
  });

  it("keeps canonical evidence when temporary journal cleanup fails", async () => {
    const plugin = createPluginWithSettings([createFeed()]) as unknown as TestPlugin & {
      clearStatusJournal: () => Promise<void>;
    };
    const canonical = ".rss-dashboard-data/state/status-repair.json";
    await plugin.app.vault.adapter.write(canonical, "canonical");
    await plugin.app.vault.adapter.write(`${canonical}.tmp`, "temporary");
    const adapter = plugin.app.vault.adapter as unknown as AsyncVaultAdapter & {
      remove(path: string): Promise<void>;
    };
    const originalRemove = adapter.remove.bind(adapter);
    vi.spyOn(adapter, "remove").mockImplementation(async (path) => {
      if (path.endsWith(".tmp")) throw new Error("temporary cleanup failed");
      await originalRemove(path);
    });

    await expect(plugin.clearStatusJournal()).rejects.toThrow(
      "Status journal cleanup incomplete",
    );

    expect(await adapter.exists(canonical)).toBe(true);
  });

  it("refuses to overwrite an unresolved prior journal with a new mutation", async () => {
    const article = createItem({ read: false });
    const source = createFeed({ feedId: "source-safe", items: [article] });
    const plugin = createPluginWithSettings([source]) as unknown as TestPlugin & {
      updateArticle: (
        guid: string,
        url: string,
        updates: Partial<FeedItem>,
      ) => Promise<boolean>;
    };
    const canonical = ".rss-dashboard-data/state/status-repair.json";
    const unresolved = JSON.stringify({
      version: 1,
      txId: "tx-2-safe",
      phase: "prepared",
      items: [{
        feedIndex: 9,
        itemIndex: 9,
        sourceLocator: createTestSourceLocator("missing-source"),
        stableId: "f".repeat(64),
        previousFeed: [{ key: "read", exists: true, value: false }],
      }],
    });
    await plugin.app.vault.adapter.write(canonical, unresolved);

    await expect(
      plugin.updateArticle(article.guid, source.url, { read: true }),
    ).resolves.toBe(false);

    expect(article.read).toBe(false);
    expect(await plugin.app.vault.adapter.read(canonical)).toBe(unresolved);
  });

  it("rejects malicious journal fields without mutating identity", async () => {
    const stableId = "a".repeat(64);
    const article = createItem({ rssDashboardId: stableId, read: true });
    const source = createFeed({ feedId: "source-safe", items: [article] });
    const plugin = createPluginWithSettings([source]) as unknown as TestPlugin & {
      replayStatusRepairJournalIfNeeded: () => Promise<boolean>;
    };
    const canonical = ".rss-dashboard-data/state/status-repair.json";
    await plugin.app.vault.adapter.write(canonical, JSON.stringify({
      version: 1,
      txId: "tx-3-safe",
      phase: "prepared",
      items: [{
        feedIndex: 0,
        itemIndex: 0,
        sourceLocator: createTestSourceLocator("source-safe"),
        stableId,
        previousFeed: [{
          key: "feedUrl",
          exists: true,
          value: "https://attacker.invalid",
        }],
        __protoPollution: true,
      }],
    }));

    await expect(plugin.replayStatusRepairJournalIfNeeded()).resolves.toBe(false);

    expect(article.feedUrl).toBe(source.url);
    expect(article.read).toBe(true);
    expect(await plugin.app.vault.adapter.exists(canonical)).toBe(true);
  });

  it("rejects duplicate stable locators before writing a new journal", async () => {
    const stableId = "1".repeat(64);
    const first = createItem({ guid: "first", rssDashboardId: stableId, read: false });
    const duplicate = createItem({ guid: "duplicate", rssDashboardId: stableId, read: false });
    const source = createFeed({ feedId: "source-duplicate", items: [first, duplicate] });
    const plugin = createPluginWithSettings([source]) as unknown as TestPlugin & {
      updateArticle: (
        guid: string,
        url: string,
        updates: Partial<FeedItem>,
      ) => Promise<boolean>;
    };
    const canonical = ".rss-dashboard-data/state/status-repair.json";

    await expect(
      plugin.updateArticle(first.guid, source.url, { read: true }),
    ).resolves.toBe(false);

    expect(first.read).toBe(false);
    expect(duplicate.read).toBe(false);
    expect(plugin.saveData).not.toHaveBeenCalled();
    expect(await plugin.app.vault.adapter.exists(canonical)).toBe(false);
    expect(await plugin.app.vault.adapter.exists(`${canonical}.tmp`)).toBe(false);
  });

  it("rejects a journal containing duplicate source and item locators", async () => {
    const stableId = "0".repeat(64);
    const article = createItem({ rssDashboardId: stableId, read: true });
    const source = createFeed({ feedId: "source-parser-duplicate", items: [article] });
    const plugin = createPluginWithSettings([source]) as unknown as TestPlugin & {
      replayStatusRepairJournalIfNeeded: () => Promise<boolean>;
      saveSettings: ReturnType<typeof vi.fn>;
    };
    plugin.saveSettings = vi.fn().mockResolvedValue(undefined);
    const canonical = ".rss-dashboard-data/state/status-repair.json";
    const item = {
      feedIndex: 0,
      itemIndex: 0,
      sourceLocator: createTestSourceLocator("source-parser-duplicate"),
      stableId,
      previousFeed: [{ key: "read", exists: true, value: false }],
    };
    await plugin.app.vault.adapter.write(canonical, JSON.stringify({
      version: 1,
      txId: "tx-14-duplicate",
      phase: "prepared",
      items: [item, { ...item, itemIndex: 1 }],
    }));

    await expect(plugin.replayStatusRepairJournalIfNeeded()).resolves.toBe(false);

    expect(article.read).toBe(true);
    expect(plugin.saveSettings).not.toHaveBeenCalled();
    expect(await plugin.app.vault.adapter.exists(canonical)).toBe(true);
  });

  it("hashes arbitrary durable source identities in retained journal evidence", async () => {
    const sourceIdentity = "  中文 source: https://private.example/feed  ";
    const expectedLocator = createTestSourceLocator(sourceIdentity);
    const article = createItem({ read: false });
    const source = createFeed({ feedId: sourceIdentity, items: [article] });
    const plugin = createPluginWithSettings([source]) as unknown as TestPlugin & {
      updateArticle: (
        guid: string,
        url: string,
        updates: Partial<FeedItem>,
      ) => Promise<boolean>;
      saveSettings: ReturnType<typeof vi.fn>;
    };
    plugin.saveSettings = vi.fn().mockRejectedValue(new Error("retain journal"));
    const canonical = ".rss-dashboard-data/state/status-repair.json";

    await expect(
      plugin.updateArticle(article.guid, source.url, { read: true }),
    ).resolves.toBe(false);

    const journal = await plugin.app.vault.adapter.read(canonical);
    expect(journal).toContain(`"sourceLocator":"${expectedLocator}"`);
    expect(journal).not.toContain(sourceIdentity.trim());
    expect(journal).not.toContain(source.url);
    expect(journal).not.toContain('"sourceId"');
  });

  it("clears both journal files after success on an adapter without rename", async () => {
    const article = createItem({ read: false });
    const source = createFeed({ items: [article] });
    const plugin = createPluginWithSettings([source]) as unknown as TestPlugin & {
      updateArticle: (
        guid: string,
        url: string,
        updates: Partial<FeedItem>,
      ) => Promise<boolean>;
      saveSettings: ReturnType<typeof vi.fn>;
    };
    plugin.saveSettings = vi.fn().mockResolvedValue(undefined);
    const adapter = plugin.app.vault.adapter as unknown as AsyncVaultAdapter;
    adapter.rename = undefined;

    await expect(
      plugin.updateArticle(article.guid, source.url, { read: true }),
    ).resolves.toBe(true);

    expect(
      await adapter.exists(".rss-dashboard-data/state/status-repair.json"),
    ).toBe(false);
    expect(
      await adapter.exists(".rss-dashboard-data/state/status-repair.json.tmp"),
    ).toBe(false);
  });

  it("replays retained temp evidence after a no-rename canonical write failure", async () => {
    const article = createItem({ read: false });
    const source = createFeed({ feedId: "source-temp", items: [article] });
    const plugin = createPluginWithSettings([source]) as unknown as TestPlugin & {
      updateArticle: (
        guid: string,
        url: string,
        updates: Partial<FeedItem>,
      ) => Promise<boolean>;
      replayStatusRepairJournalIfNeeded: () => Promise<boolean>;
      saveSettings: ReturnType<typeof vi.fn>;
    };
    plugin.saveSettings = vi.fn().mockResolvedValue(undefined);
    const canonical = ".rss-dashboard-data/state/status-repair.json";
    const adapter = plugin.app.vault.adapter as unknown as AsyncVaultAdapter;
    adapter.rename = undefined;
    const originalWrite = adapter.write.bind(adapter);
    const writeSpy = vi.spyOn(adapter, "write").mockImplementation(
      async (path, contents) => {
        if (path === canonical) throw new Error("canonical unavailable");
        await originalWrite(path, contents);
      },
    );

    await expect(
      plugin.updateArticle(article.guid, source.url, { read: true }),
    ).resolves.toBe(false);
    expect(await adapter.exists(canonical)).toBe(false);
    expect(await adapter.exists(`${canonical}.tmp`)).toBe(true);

    writeSpy.mockRestore();
    await expect(plugin.replayStatusRepairJournalIfNeeded()).resolves.toBe(true);
    expect(article.read).toBe(false);
    expect(await adapter.exists(`${canonical}.tmp`)).toBe(false);
  });

  it("contains failed-source ledger errors without exposing raw source data", async () => {
    const plugin = createPluginWithSettings([createFeed()]);
    plugin.getSourceRefreshLedger = vi.fn(() => ({
      getSourceIdsWithStatus: vi.fn().mockRejectedValue(
        new Error("https://example.com/private?token=secret"),
      ),
    }));

    await expect(plugin.refreshFailedSources()).resolves.toBeUndefined();

    const notices = getNoticeMessages(consoleLogSpy);
    expect(notices).toContain(
      "无法刷新失败来源，请检查来源状态后重试。",
    );
    expect(notices.join(" ")).not.toContain("secret");
    expect(notices.join(" ")).not.toContain("example.com");
  });

  it("refreshes every open dashboard leaf after a completed collection update", async () => {
    const plugin = createPluginWithSettings([]);
    const dashboardPlugin = plugin as unknown as RssDashboardPlugin;
    const viewPlugin = { settings: plugin.settings, saveSettings: vi.fn() };
    const first = new RssDashboardView(
      { app: plugin.app } as unknown as import("obsidian").WorkspaceLeaf,
      viewPlugin as never,
    );
    const second = new RssDashboardView(
      { app: plugin.app } as unknown as import("obsidian").WorkspaceLeaf,
      viewPlugin as never,
    );
    first.refresh = vi.fn();
    second.refresh = vi.fn();
    plugin.app.workspace.getLeavesOfType = vi.fn(() => [
      { view: first, loadIfDeferred: vi.fn() },
      { view: second, loadIfDeferred: vi.fn() },
    ]);

    await dashboardPlugin.refreshDashboardViews();

    expect(first.refresh).toHaveBeenCalledTimes(1);
    expect(second.refresh).toHaveBeenCalledTimes(1);
  });
});
