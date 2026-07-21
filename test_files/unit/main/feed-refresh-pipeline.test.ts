import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "obsidian";
import RssDashboardPlugin from "../../../main";
import { DEFAULT_SETTINGS, type Feed, type FeedItem } from "../../../src/types/types";
import { FEED_REQUEST_TIMEOUT_MS } from "../../../src/services/feed-timeout";

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

interface TestPlugin {
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
    expect(plugin.saveData).toHaveBeenCalledTimes(1);
    expect(sidebarRefreshSpy).toHaveBeenCalledTimes(2);
    expect(viewRefreshSpy).toHaveBeenCalledTimes(1);
    expect(plugin.feedParser.refreshAllFeeds).not.toHaveBeenCalled();

    const notices = getNoticeMessages(consoleLogSpy);
    expect(notices[0]).toBe("Refreshing 5 feeds...");
    expect(notices).toContain("Feeds refreshed: 5 feeds");
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

    await plugin.refreshFeeds([feedB]);

    expect(plugin.feedParser.refreshFeed).toHaveBeenCalledWith(feedB);
    expect(plugin.feedParser.refreshAllFeeds).not.toHaveBeenCalled();
    expect(plugin.settings.feeds[0].lastUpdated).toBe(100);
    expect(plugin.settings.feeds[1].lastUpdated).toBe(777);
    expect(plugin.saveData).toHaveBeenCalledTimes(1);

    const notices = getNoticeMessages(consoleLogSpy);
    expect(notices[0]).toBe("Refreshing Feed B...");
    expect(notices.some((m) => m.startsWith("Feeds refreshed:"))).toBe(false);
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
    expect(viewRefreshSpy).toHaveBeenCalledTimes(1);
    expect(plugin.activeRefreshState.size).toBe(0);

    const notices = getNoticeMessages(consoleLogSpy);
    expect(notices[0]).toBe("Refreshing 2 feeds...");
    expect(notices).toContain("Feeds refreshed: 2 feeds (1 timed out)");
  });

  it("swallows direct refresh errors and shows an error Notice", async () => {
    const plugin = createPluginWithSettings([createFeed()]);

    (plugin.feedParser.refreshFeed as unknown as { mockRejectedValue: (error: Error) => void }).mockRejectedValue(
      new Error("network down"),
    );

    await expect(plugin.refreshFeeds([plugin.settings.feeds[0]])).resolves.toBeUndefined();
    expect(plugin.saveData).not.toHaveBeenCalled();

    const notices = getNoticeMessages(consoleLogSpy);
    expect(notices[0]).toBe("Refreshing Feed A...");
    expect(notices).toContain("Error refreshing  network down");
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
});
