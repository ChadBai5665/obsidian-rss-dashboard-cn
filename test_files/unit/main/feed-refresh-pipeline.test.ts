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
import type { SourceRegistry } from "../../../src/sources/source-registry";
import type { FeedSourceConfig } from "../../../src/sources/source-config";
import { createTranslator } from "../../../src/i18n";
import { XTopicRefreshError } from "../../../src/sources/tikhub/x-topic-adapter";
import { createXPostCollectedItemId } from "../../../src/collection/item-identity";
import {
  SubscriptionService,
  createConfirmedCollectionPurge,
} from "../../../src/services/subscription-service";
import type {
  OperationBeginInput,
  OperationJournalPort,
  OperationJournalScope,
} from "../../../src/operation-journal/operation-journal-service";
import type {
  OperationDetails,
  OperationErrorCode,
  OperationStage,
} from "../../../src/operation-journal/operation-event";

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

function createActiveXImportFeed(feedId: string): Feed {
  return createFeed({
    feedId,
    sourceKind: "x-account",
    sourceConfig: {
      kind: "x-account",
      id: feedId,
      handle: "openai",
      includeReplies: false,
      includeReposts: false,
      folder: "X",
      topics: [],
    },
    url: "tikhub://x-account/openai",
    initialImportPolicy: { mode: "all-available" },
    initialImportProgress: {
      status: "running",
      pagesFetched: 1,
      itemsImported: 1,
      phase: "posts",
      nextCursor: "next-page",
    },
  });
}

interface TestFeedParser {
  refreshFeed: ReturnType<typeof vi.fn>;
  refreshAllFeeds: ReturnType<typeof vi.fn>;
}

interface AsyncVaultAdapter {
  write(path: string, contents: string): Promise<void>;
  read(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  process(
    path: string,
    update: (contents: string) => string,
  ): Promise<string>;
  rename?: (from: string, to: string) => Promise<void>;
}

interface TestPlugin {
  app: App;
  settings: typeof DEFAULT_SETTINGS;
  saveData: ReturnType<typeof vi.fn>;
  feedParser: TestFeedParser;
  refreshFeeds: (selectedFeeds?: Feed[]) => Promise<void>;
  runRefresh: (invocation: {
    trigger: "manual" | "startup" | "schedule";
    action: "all" | "failed" | "source" | "folder";
    feeds?: readonly Feed[];
  }) => Promise<void>;
  activeRefreshState: Map<string, unknown>;
  getActiveDashboardView: ReturnType<typeof vi.fn>;
  validateSavedArticles: ReturnType<typeof vi.fn>;
  getSourceRefreshLedger: ReturnType<typeof vi.fn>;
  getCollectionService: ReturnType<typeof vi.fn>;
  refreshFailedSources: () => Promise<void>;
  manualRefreshFailedSources: () => Promise<void>;
  refreshSelectedFeed: (feed: Feed) => Promise<void>;
  manualRefreshAllSources: () => Promise<void>;
  manualRefreshSourceById: (sourceId: string) => Promise<void>;
  refreshOnOpenIfNeeded: () => Promise<void>;
  refreshFeedsInFolder: (folderPath: string) => Promise<void>;
  getOperationJournalPort: () => OperationJournalPort | undefined;
  saveSettings: (options?: { forceAllShards?: boolean; forceMetadata?: boolean }) => Promise<void>;
  createSourceRegistryForRun: () => SourceRegistry;
  getSubscriptionService: () => import("../../../src/services/subscription-service").SubscriptionService;
}

type RecordedRefreshEvent =
  | { status: "started"; input: OperationBeginInput }
  | {
      status: "progress" | "succeeded";
      stage: OperationStage;
      details: OperationDetails;
    }
  | {
      status: "failed";
      stage: OperationStage;
      errorCode: OperationErrorCode;
      details?: OperationDetails;
    }
  | { status: "aborted"; stage: OperationStage };

function recordRefreshJournal(plugin: TestPlugin): RecordedRefreshEvent[] {
  const events: RecordedRefreshEvent[] = [];
  const begin = (input: OperationBeginInput): OperationJournalScope => {
    events.push({ status: "started", input });
    return {
      operationId: `refresh-${events.length}`,
      progress: async (stage, details) => {
        events.push({ status: "progress", stage, details });
      },
      succeed: async (stage, details) => {
        events.push({ status: "succeeded", stage, details });
      },
      fail: async (stage, errorCode, details) => {
        events.push({ status: "failed", stage, errorCode, details });
      },
      abort: async (stage) => {
        events.push({ status: "aborted", stage });
      },
    };
  };
  plugin.getOperationJournalPort = () => ({
    begin,
    attach: () => {
      throw new Error("refresh tests never attach journal scopes");
    },
  });
  return events;
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
  (
    testPlugin as unknown as {
      persistSubscriptionSettingsCandidate(
        candidate: unknown,
        publish: () => void,
      ): Promise<void>;
    }
  ).persistSubscriptionSettingsCandidate = async (_candidate, publish) => {
    publish();
  };

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
  it("journals every user refresh entry as an explicit manual action", async () => {
    const sourceA = createFeed({
      feedId: "source-a",
      title: "Source A",
      folder: "News/Tech",
      url: "https://secret.example/a.xml?token=never-log",
    });
    const sourceB = createFeed({
      feedId: "source-b",
      title: "Source B",
      folder: "Other",
      url: "https://example.com/b.xml",
    });
    const plugin = createPluginWithSettings([sourceA, sourceB]);
    const events = recordRefreshJournal(plugin);
    (plugin.feedParser.refreshFeed as unknown as {
      mockImplementation: (refresh: (feed: Feed) => Promise<Feed>) => void;
    }).mockImplementation(async (feed) => ({
        ...feed,
        lastUpdated: feed.lastUpdated + 1,
      }));
    plugin.getSourceRefreshLedger = vi.fn(() => ({
      getSourceIdsWithStatus: vi.fn().mockResolvedValue(["source-b"]),
      recordAttempt: vi.fn().mockResolvedValue(undefined),
      recordError: vi.fn().mockResolvedValue(undefined),
    }));

    await plugin.manualRefreshAllSources();
    await plugin.manualRefreshFailedSources();
    await plugin.manualRefreshSourceById("source-a");
    await plugin.refreshFeedsInFolder("News");

    const starts = events.filter(
      (event): event is Extract<RecordedRefreshEvent, { status: "started" }> =>
        event.status === "started",
    );
    expect(starts.map(({ input }) => [input.trigger, input.action])).toEqual([
      ["manual", "all"],
      ["manual", "failed"],
      ["manual", "source"],
      ["manual", "folder"],
    ]);
    expect(starts[2].input.subject).toEqual({
      sourceId: "source-a",
      label: "Source A",
    });
    expect(JSON.stringify(starts)).not.toContain("secret.example");
    expect(JSON.stringify(starts)).not.toContain("never-log");
    expect(starts[3].input.subject).toEqual({});
  });

  it("aggregates closed outcomes and counts only stable-identity additions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T10:00:00.000Z"));
    const unchanged = createItem({
      guid: "same-guid",
      link: "https://example.com/same?utm_source=old",
    });
    const sourceA = createFeed({
      feedId: "source-a",
      items: [unchanged],
      url: "https://example.com/a.xml",
    });
    const sourceB = createFeed({
      feedId: "source-b",
      title: "Source B",
      url: "https://example.com/b.xml",
    });
    const plugin = createPluginWithSettings([sourceA, sourceB]);
    const events = recordRefreshJournal(plugin);
    (plugin.feedParser.refreshFeed as unknown as {
      mockImplementation: (refresh: (feed: Feed) => Promise<Feed>) => void;
    }).mockImplementation(async (feed) => {
        if (feed.feedId === "source-b") {
          throw new Error("raw response https://private.example/body?token=secret");
        }
        return {
          ...feed,
          items: [
            { ...unchanged, link: "https://example.com/same?utm_source=new" },
            createItem({
              guid: "new-guid",
              link: "https://example.com/new",
              feedUrl: feed.url,
            }),
          ],
          lastUpdated: 2,
        };
      });

    const refresh = plugin.manualRefreshAllSources();
    await vi.advanceTimersByTimeAsync(25);
    await refresh;

    const terminal = events.at(-1);
    expect(terminal).toMatchObject({
      status: "failed",
      stage: "completed",
      errorCode: "refresh-failed",
      details: {
        total: 2,
        succeeded: 1,
        failed: 1,
        newItems: 1,
        elapsedMs: expect.any(Number),
      },
    });
    vi.useRealTimers();
  });

  it("uses only safe source identity and a standard code for single-source failure", async () => {
    const source = createFeed({
      feedId: "safe-source-id",
      title: "Safe source name",
      url: "https://private.example/feed.xml?api_key=secret",
    });
    const plugin = createPluginWithSettings([source]);
    const events = recordRefreshJournal(plugin);
    plugin.feedParser.refreshFeed.mockRejectedValue(
      new Error("Authorization: Bearer raw-secret response-body"),
    );

    await plugin.manualRefreshSourceById("safe-source-id");

    expect(events[0]).toMatchObject({
      status: "started",
      input: {
        trigger: "manual",
        action: "source",
        subject: { sourceId: "safe-source-id", label: "Safe source name" },
      },
    });
    expect(events.at(-1)).toMatchObject({
      status: "failed",
      stage: "completed",
      errorCode: "source-refresh-failed",
    });
    const rendered = JSON.stringify(events);
    expect(rendered).not.toContain("private.example");
    expect(rendered).not.toContain("raw-secret");
    expect(rendered).not.toContain("response-body");
  });

  it("closes empty, excluded, and occupied invocations without extra refresh work", async () => {
    const emptyPlugin = createPluginWithSettings([]);
    const emptyEvents = recordRefreshJournal(emptyPlugin);
    await emptyPlugin.manualRefreshAllSources();
    expect(emptyEvents).toHaveLength(2);
    expect(emptyEvents.at(-1)).toMatchObject({
      status: "succeeded",
      details: { total: 0, succeeded: 0, failed: 0, newItems: 0 },
    });

    const excluded = createFeed({
      feedId: "excluded",
      excludeFromRefresh: true,
    });
    const excludedPlugin = createPluginWithSettings([excluded]);
    const excludedEvents = recordRefreshJournal(excludedPlugin);
    await excludedPlugin.manualRefreshAllSources();
    expect(excludedEvents).toHaveLength(2);
    expect(excludedEvents.at(-1)).toMatchObject({
      status: "succeeded",
      details: { total: 0, succeeded: 0, failed: 0, newItems: 0 },
    });
    expect(excludedPlugin.feedParser.refreshFeed).not.toHaveBeenCalled();

    const source = createFeed({ feedId: "occupied" });
    const occupiedPlugin = createPluginWithSettings([source]);
    const occupiedEvents = recordRefreshJournal(occupiedPlugin);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    (occupiedPlugin.feedParser.refreshFeed as unknown as {
      mockImplementation: (refresh: (feed: Feed) => Promise<Feed>) => void;
    }).mockImplementation(async (feed) => {
        await blocked;
        return { ...feed, lastUpdated: 2 };
      });
    const first = occupiedPlugin.manualRefreshAllSources();
    await flushMicrotasks();
    await occupiedPlugin.manualRefreshAllSources();

    expect(occupiedPlugin.feedParser.refreshFeed).toHaveBeenCalledOnce();
    expect(occupiedEvents).toHaveLength(3);
    expect(occupiedEvents[1]).toMatchObject({
      status: "started",
      input: { trigger: "manual", action: "all" },
    });
    expect(occupiedEvents[2]).toMatchObject({
      status: "failed",
      stage: "completed",
      errorCode: "refresh-failed",
      details: { total: 0, succeeded: 0, failed: 0, newItems: 0 },
    });
    expect(getNoticeMessages(consoleLogSpy)).toContain(
      "已有多来源刷新正在进行。",
    );

    occupiedPlugin.getOperationJournalPort = () => {
      throw new Error("journal unavailable");
    };
    await occupiedPlugin.manualRefreshAllSources();
    expect(occupiedPlugin.feedParser.refreshFeed).toHaveBeenCalledOnce();
    expect(
      getNoticeMessages(consoleLogSpy).filter(
        (message) => message === "已有多来源刷新正在进行。",
      ),
    ).toHaveLength(2);
    expect(occupiedEvents).toHaveLength(3);

    release();
    await first;
    expect(occupiedEvents).toHaveLength(4);
  });

  it("distinguishes collection, settings, deletion, and stop terminal outcomes", async () => {
    const collectionSource = createFeed({ feedId: "collection-failure" });
    const collectionPlugin = createPluginWithSettings([collectionSource]);
    const collectionEvents = recordRefreshJournal(collectionPlugin);
    collectionPlugin.feedParser.refreshFeed.mockResolvedValue({
      ...collectionSource,
      lastUpdated: 2,
    });
    collectionPlugin.getCollectionService = vi.fn(() => ({
      collectFeedRefresh: vi.fn().mockRejectedValue(new Error("disk path secret")),
    }));
    await collectionPlugin.manualRefreshSourceById("collection-failure");
    expect(collectionEvents.at(-1)).toMatchObject({
      status: "failed",
      errorCode: "cache-save-failed",
    });

    const settingsSource = createFeed({ feedId: "settings-failure" });
    const settingsPlugin = createPluginWithSettings([settingsSource]);
    const settingsEvents = recordRefreshJournal(settingsPlugin);
    settingsPlugin.feedParser.refreshFeed.mockResolvedValue({
      ...settingsSource,
      lastUpdated: 2,
    });
    vi.spyOn(
      settingsPlugin as unknown as { saveSettingsUnlocked(): Promise<void> },
      "saveSettingsUnlocked",
    ).mockRejectedValue(new Error("settings write failed"));
    await settingsPlugin.manualRefreshSourceById("settings-failure");
    expect(settingsEvents.at(-1)).toMatchObject({
      status: "failed",
      errorCode: "settings-save-failed",
    });

    for (const terminalState of ["deleted", "stopped"] as const) {
      const source = createFeed({
        feedId: `source-${terminalState}`,
        sourceKind: terminalState === "stopped" ? "x-account" : "feed",
        sourceConfig: terminalState === "stopped"
          ? {
              kind: "x-account",
              id: "source-stopped",
              handle: "openai",
              includeReplies: false,
              includeReposts: false,
              folder: "X",
              topics: [],
            }
          : { kind: "feed" },
        initialImportProgress: terminalState === "stopped"
          ? { status: "running", pagesFetched: 1, itemsImported: 1 }
          : undefined,
        url: terminalState === "stopped"
          ? "tikhub://x-account/openai"
          : "https://example.com/deleted.xml",
      });
      const plugin = createPluginWithSettings([source]);
      const events = recordRefreshJournal(plugin);
      if (terminalState === "stopped") {
        plugin.settings.tikhub = {
          ...plugin.settings.tikhub,
          enabled: true,
          connectionId: "11111111-1111-4111-8111-111111111111",
        };
      }
      let release!: () => void;
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      plugin.createSourceRegistryForRun = vi.fn(() => ({
        refresh: vi.fn(async () => {
          markStarted();
          await blocked;
          return {
            feed: { ...source, lastUpdated: 3 },
            items: source.items,
            collectionItems: [],
            providerRequestCount: 0,
            warnings: [],
          };
        }),
      }) as unknown as SourceRegistry);
      const refresh = plugin.manualRefreshSourceById(source.feedId!);
      await started;
      if (terminalState === "deleted") {
        plugin.settings.feeds = [];
      } else {
        plugin.settings.feeds[0].initialImportProgress = {
          status: "stopped",
          pagesFetched: 1,
          itemsImported: 1,
        };
      }
      release();
      await refresh;
      expect(events.at(-1)).toMatchObject({
        status: "aborted",
        stage: "completed",
      });
    }
  });

  it.each(["getter-throws", "begin-throws", "invalid-scope", "terminal-rejects"] as const)(
    "keeps refresh behavior unchanged when the journal %s",
    async (failureMode) => {
      const source = createFeed({ feedId: `journal-${failureMode}` });
      const plugin = createPluginWithSettings([source]);
      const refreshed = { ...source, lastUpdated: 42 };
      plugin.feedParser.refreshFeed.mockResolvedValue(refreshed);
      const ledger = {
        getSourceIdsWithStatus: vi.fn().mockResolvedValue([]),
        recordAttempt: vi.fn().mockResolvedValue(undefined),
        recordError: vi.fn().mockResolvedValue(undefined),
      };
      const collectFeedRefresh = vi.fn().mockResolvedValue([]);
      plugin.getSourceRefreshLedger = vi.fn(() => ledger);
      plugin.getCollectionService = vi.fn(() => ({ collectFeedRefresh }));
      const refreshViews = vi.spyOn(
        plugin as unknown as RssDashboardPlugin,
        "refreshDashboardViews",
      ).mockResolvedValue(undefined);
      const rejected = Promise.reject(new Error("journal rejected"));
      void rejected.catch(() => undefined);
      plugin.getOperationJournalPort = () => {
        if (failureMode === "getter-throws") throw new Error("journal getter");
        return {
          begin: () => {
            if (failureMode === "begin-throws") throw new Error("journal begin");
            if (failureMode === "invalid-scope") return {} as OperationJournalScope;
            return {
              operationId: "refresh-test",
              progress: async () => undefined,
              succeed: () => rejected,
              fail: () => rejected,
              abort: () => rejected,
            };
          },
          attach: () => {
            throw new Error("unused");
          },
        };
      };

      await expect(
        plugin.manualRefreshSourceById(source.feedId!),
      ).resolves.toBeUndefined();

      expect(plugin.feedParser.refreshFeed).toHaveBeenCalledOnce();
      expect(ledger.recordAttempt).toHaveBeenCalledOnce();
      expect(collectFeedRefresh).toHaveBeenCalledOnce();
      expect(plugin.settings.feeds[0].lastUpdated).toBe(42);
      expect(await plugin.app.vault.adapter.exists("data.json")).toBe(true);
      expect(refreshViews).toHaveBeenCalledOnce();
      expect(getNoticeMessages(consoleLogSpy)).toContain("已刷新：Feed A");
    },
  );

  it("reports the exact enabled-X request estimate and caps before any provider call", async () => {
    const account = createFeed({
      feedId: "x-account-openai",
      sourceKind: "x-account",
      sourceConfig: {
        kind: "x-account",
        id: "x-account-openai",
        handle: "openai",
        includeReplies: true,
        includeReposts: false,
        folder: "X",
        topics: [],
      },
      url: "tikhub://x-account/openai",
    });
    const topic = createFeed({
      feedId: "ai-apps",
      sourceKind: "x-topic",
      sourceConfig: {
        kind: "x-topic",
        id: "ai-apps",
        name: "AI applications",
        includeKeywords: ["AI"],
        excludeKeywords: [],
        priorityAccounts: ["openai"],
        windowDays: 7,
        folder: "Topics",
      },
      url: "tikhub://x-topic/ai-apps",
    });
    const plugin = createPluginWithSettings([account, topic]);
    plugin.settings.tikhub = {
      ...plugin.settings.tikhub,
      enabled: true,
      connectionId: "11111111-1111-4111-8111-111111111111",
      maxRequestsPerRun: 8,
      maxRequestsPerDay: 21,
    };
    const expected = "正在刷新 2 个订阅… 本次 TikHub 请求预计 5 次（单次上限 8 次；每日上限 21 次）。";
    const expectedEnglish = "Refreshing 2 feeds… Estimated TikHub requests: 5 (per-run cap 8; daily cap 21).";
    const refresh = vi.fn(async (config: FeedSourceConfig) => {
      expect(
        getNoticeMessages(consoleLogSpy).some((message) =>
          message === expected || message === expectedEnglish,
        ),
      ).toBe(true);
      const feed = config.kind === "x-account" ? account : topic;
      return {
        feed,
        items: feed.items,
        providerRequestCount: config.kind === "x-account" ? 2 : 3,
        warnings: [],
      };
    });
    plugin.createSourceRegistryForRun = vi.fn(() => ({ refresh }) as unknown as SourceRegistry);

    await plugin.manualRefreshAllSources();

    expect(refresh).toHaveBeenCalledTimes(2);
    expect(getNoticeMessages(consoleLogSpy).filter((message) => message === expected)).toHaveLength(1);

    consoleLogSpy.mockClear();
    plugin.settings.locale = "en";
    await plugin.manualRefreshAllSources();
    expect(refresh).toHaveBeenCalledTimes(4);
    expect(getNoticeMessages(consoleLogSpy).filter((message) => message === expectedEnglish)).toHaveLength(1);
  });

  it.each([
    {
      label: "Chinese account without replies",
      locale: "zh-CN" as const,
      title: "@openai",
      url: "tikhub://x-account/openai",
      config: {
        kind: "x-account" as const,
        id: "x-account-openai",
        handle: "openai",
        includeReplies: false,
        includeReposts: true,
        folder: "X",
        topics: [],
      },
      count: 1,
      expected: "正在刷新 @openai… 本次 TikHub 请求预计 1 次（单次上限 8 次；每日上限 21 次）。",
    },
    {
      label: "English account with replies",
      locale: "en" as const,
      title: "@openai replies",
      url: "tikhub://x-account/openai",
      config: {
        kind: "x-account" as const,
        id: "x-account-openai",
        handle: "openai",
        includeReplies: true,
        includeReposts: false,
        folder: "X",
        topics: [],
      },
      count: 2,
      expected: "Refreshing @openai replies… Estimated TikHub requests: 2 (per-run cap 8; daily cap 21).",
    },
    {
      label: "Chinese topic without priority accounts",
      locale: "zh-CN" as const,
      title: "AI 应用",
      url: "tikhub://x-topic/ai-basic",
      config: {
        kind: "x-topic" as const,
        id: "ai-basic",
        name: "AI 应用",
        includeKeywords: ["AI"],
        excludeKeywords: [],
        priorityAccounts: [],
        windowDays: 7 as const,
        folder: "Topics",
      },
      count: 2,
      expected: "正在刷新 AI 应用… 本次 TikHub 请求预计 2 次（单次上限 8 次；每日上限 21 次）。",
    },
    {
      label: "English topic with priority accounts",
      locale: "en" as const,
      title: "AI methods",
      url: "tikhub://x-topic/ai-priority",
      config: {
        kind: "x-topic" as const,
        id: "ai-priority",
        name: "AI methods",
        includeKeywords: ["AI"],
        excludeKeywords: [],
        priorityAccounts: ["openai"],
        windowDays: 7 as const,
        folder: "Topics",
      },
      count: 3,
      expected: "Refreshing AI methods… Estimated TikHub requests: 3 (per-run cap 8; daily cap 21).",
    },
  ])("reports the exact single-source estimate before provider execution: $label", async ({
    locale,
    title,
    url,
    config,
    count,
    expected,
  }) => {
    const feed = createFeed({
      feedId: config.id,
      sourceKind: config.kind,
      sourceConfig: config,
      title,
      url,
    });
    const plugin = createPluginWithSettings([feed]);
    plugin.settings.locale = locale;
    plugin.settings.tikhub = {
      ...plugin.settings.tikhub,
      enabled: true,
      connectionId: "11111111-1111-4111-8111-111111111111",
      maxRequestsPerRun: 8,
      maxRequestsPerDay: 21,
    };
    const refresh = vi.fn(async () => {
      expect(getNoticeMessages(consoleLogSpy)).toContain(expected);
      return {
        feed,
        items: feed.items,
        providerRequestCount: count,
        warnings: [],
      };
    });
    plugin.createSourceRegistryForRun = vi.fn(() => ({ refresh }) as unknown as SourceRegistry);

    await plugin.manualRefreshSourceById(config.id);

    expect(refresh).toHaveBeenCalledOnce();
    expect(getNoticeMessages(consoleLogSpy).filter((message) => message === expected)).toHaveLength(1);
  });

  it("uses the ordinary single-source notice for pure RSS, disabled TikHub, or invalid X configuration", async () => {
    const rss = createFeed({ feedId: "rss-source" });
    const rssPlugin = createPluginWithSettings([rss]);
    rssPlugin.feedParser.refreshFeed.mockResolvedValue({ ...rss, lastUpdated: 2 });
    await rssPlugin.manualRefreshSourceById("rss-source");
    expect(getNoticeMessages(consoleLogSpy).filter((message) => message === "正在刷新 Feed A…")).toHaveLength(1);
    expect(getNoticeMessages(consoleLogSpy).some((message) => message.includes("TikHub 请求预计"))).toBe(false);

    consoleLogSpy.mockClear();
    const account = createFeed({
      feedId: "x-account-openai",
      sourceKind: "x-account",
      sourceConfig: {
        kind: "x-account",
        id: "x-account-openai",
        handle: "openai",
        includeReplies: false,
        includeReposts: false,
        folder: "X",
        topics: [],
      },
      url: "tikhub://x-account/openai",
    });
    const disabledPlugin = createPluginWithSettings([account]);
    disabledPlugin.createSourceRegistryForRun = vi.fn(() => ({
      refresh: vi.fn().mockResolvedValue({
        feed: account,
        items: account.items,
        providerRequestCount: 0,
        warnings: [],
      }),
    }) as unknown as SourceRegistry);
    await disabledPlugin.manualRefreshSourceById("x-account-openai");
    expect(getNoticeMessages(consoleLogSpy).filter((message) => message === "正在刷新 Feed A…")).toHaveLength(1);
    expect(getNoticeMessages(consoleLogSpy).some((message) => message.includes("TikHub 请求预计"))).toBe(false);

    consoleLogSpy.mockClear();
    const invalid = createFeed({
      feedId: "invalid-x",
      sourceKind: "x-account",
      sourceConfig: { kind: "x-account" } as unknown as Feed["sourceConfig"],
      url: "tikhub://x-account/invalid-x",
    });
    const invalidPlugin = createPluginWithSettings([invalid]);
    invalidPlugin.settings.tikhub = {
      ...invalidPlugin.settings.tikhub,
      enabled: true,
      connectionId: "11111111-1111-4111-8111-111111111111",
    };
    await invalidPlugin.manualRefreshSourceById("invalid-x");
    expect(getNoticeMessages(consoleLogSpy).filter((message) => message === "正在刷新 Feed A…")).toHaveLength(1);
    expect(getNoticeMessages(consoleLogSpy).some((message) => message.includes("TikHub 请求预计"))).toBe(false);
  });

  it("routes RSS and X through one refresh run without sending X synthetic URLs to the RSS parser", async () => {
    const rss = createFeed({
      feedId: "rss-source",
      sourceKind: "feed",
      sourceConfig: { kind: "feed" },
    });
    const accountConfig = {
      kind: "x-account" as const,
      id: "x-account-openai",
      handle: "openai",
      includeReplies: false,
      includeReposts: false,
      folder: "X",
      topics: ["AI"],
    };
    const topicConfig = {
      kind: "x-topic" as const,
      id: "ai-apps",
      name: "AI applications",
      includeKeywords: ["AI application"],
      excludeKeywords: [],
      priorityAccounts: ["openai"],
      windowDays: 7 as const,
      folder: "Topics",
    };
    const account = createFeed({
      feedId: accountConfig.id,
      sourceKind: "x-account",
      sourceConfig: accountConfig,
      url: "tikhub://x-account/openai",
      title: "@openai",
    });
    const topic = createFeed({
      feedId: topicConfig.id,
      sourceKind: "x-topic",
      sourceConfig: topicConfig,
      url: "tikhub://x-topic/ai-apps",
      title: topicConfig.name,
    });
    const plugin = createPluginWithSettings([rss, account, topic]);
    plugin.settings.tikhub = {
      ...plugin.settings.tikhub,
      enabled: true,
      connectionId: "11111111-1111-4111-8111-111111111111",
    };
    const refresh = vi.fn(async (
      config: { kind: "feed" } | typeof accountConfig | typeof topicConfig,
      context: { feed?: Feed },
    ) => {
      if (config.kind === "feed") {
        const updated = await plugin.feedParser.refreshFeed(context.feed);
        return {
          feed: { ...updated, sourceKind: "feed", sourceConfig: { kind: "feed" as const } },
          items: updated.items,
          providerRequestCount: 0,
          warnings: [],
        };
      }
      const source = config.kind === "x-account" ? account : topic;
      const observed = createItem({
        guid: config.kind === "x-account" ? "100" : "200",
        link: `https://x.com/openai/status/${config.kind === "x-account" ? "100" : "200"}`,
        feedUrl: source.url,
      });
      return {
        feed: { ...source, items: [observed], lastUpdated: 2 },
        items: [observed],
        providerRequestCount: config.kind === "x-account" ? 1 : 3,
        warnings: [],
      };
    });
    const registry = { refresh } as unknown as SourceRegistry;
    plugin.createSourceRegistryForRun = vi.fn(() => registry);
    const collectFeedRefresh = vi.fn().mockResolvedValue([]);
    plugin.getCollectionService = vi.fn(() => ({ collectFeedRefresh }));
    plugin.feedParser.refreshFeed.mockResolvedValue({
      ...rss,
      lastUpdated: 2,
    });

    await plugin.manualRefreshAllSources();

    expect(plugin.createSourceRegistryForRun).toHaveBeenCalledTimes(1);
    expect(plugin.feedParser.refreshFeed).toHaveBeenCalledTimes(1);
    expect(plugin.feedParser.refreshFeed).toHaveBeenCalledWith(
      expect.objectContaining({ feedId: "rss-source" }),
    );
    expect(refresh.mock.calls.map(([config]) => config.kind)).toEqual([
      "feed",
      "x-account",
      "x-topic",
    ]);
    expect(collectFeedRefresh).toHaveBeenCalledTimes(3);
  });

  it("records an actionable error for disabled X sources while RSS still refreshes", async () => {
    const rss = createFeed({ feedId: "rss-source" });
    const account = createFeed({
      feedId: "x-account-openai",
      sourceKind: "x-account",
      sourceConfig: {
        kind: "x-account",
        id: "x-account-openai",
        handle: "openai",
        includeReplies: false,
        includeReposts: false,
        folder: "X",
        topics: [],
      },
      url: "tikhub://x-account/openai",
    });
    const plugin = createPluginWithSettings([rss, account]);
    plugin.settings.tikhub = { ...plugin.settings.tikhub, enabled: false };
    plugin.settings.collection = { ...plugin.settings.collection, enabled: false };
    const ledger = {
      getSourceIdsWithStatus: vi.fn().mockResolvedValue([]),
      recordAttempt: vi.fn().mockResolvedValue(undefined),
      recordError: vi.fn().mockResolvedValue(undefined),
      recordSuccess: vi.fn().mockResolvedValue(undefined),
    };
    plugin.getSourceRefreshLedger = vi.fn(() => ledger);
    plugin.feedParser.refreshFeed.mockResolvedValue({
      ...rss,
      lastUpdated: 2,
    });

    await plugin.refreshFeeds();

    expect(plugin.feedParser.refreshFeed).toHaveBeenCalledTimes(1);
    expect(plugin.settings.feeds.find((feed) => feed.feedId === "rss-source")?.lastUpdated).toBe(2);
    expect(ledger.recordError).toHaveBeenCalledWith(
      "x-account-openai",
      expect.any(Date),
      expect.objectContaining({
        code: "tikhub-disabled",
        message: expect.stringContaining("TikHub"),
      }),
    );
    expect(ledger.recordSuccess).toHaveBeenCalledWith(
      "rss-source",
      expect.any(Date),
    );
  });

  it("includes enabled account and topic sources in the due daily-on-open set", async () => {
    const account = createFeed({
      feedId: "x-account-openai",
      sourceKind: "x-account",
      sourceConfig: {
        kind: "x-account",
        id: "x-account-openai",
        handle: "openai",
        includeReplies: false,
        includeReposts: false,
        folder: "X",
        topics: [],
      },
      url: "tikhub://x-account/openai",
    });
    const topic = createFeed({
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
    });
    const plugin = createPluginWithSettings([account, topic]);
    plugin.settings.refreshMode = "daily-on-open";
    plugin.settings.startupRefreshDelaySeconds = 0;
    plugin.getSourceRefreshLedger = vi.fn(() => ({
      getDueSourceIds: vi.fn().mockResolvedValue([
        "x-account-openai",
        "ai-apps",
      ]),
    }));
    plugin.runRefresh = vi.fn().mockResolvedValue(undefined);

    await plugin.refreshOnOpenIfNeeded();
    await flushMicrotasks();

    expect(plugin.runRefresh).toHaveBeenCalledWith({
      trigger: "startup",
      action: "all",
      feeds: [account, topic],
    });
  });

  it("contains a missing TikHub key to the X source while RSS completes", async () => {
    const rss = createFeed({ feedId: "rss-source" });
    const account = createFeed({
      feedId: "x-account-openai",
      sourceKind: "x-account",
      sourceConfig: {
        kind: "x-account",
        id: "x-account-openai",
        handle: "openai",
        includeReplies: false,
        includeReposts: false,
        folder: "X",
        topics: [],
      },
      url: "tikhub://x-account/openai",
    });
    const plugin = createPluginWithSettings([rss, account]);
    plugin.settings.collection = { ...plugin.settings.collection, enabled: false };
    plugin.settings.tikhub = {
      ...plugin.settings.tikhub,
      enabled: true,
      connectionId: "",
    };
    const ledger = {
      getSourceIdsWithStatus: vi.fn().mockResolvedValue([]),
      recordAttempt: vi.fn().mockResolvedValue(undefined),
      recordError: vi.fn().mockResolvedValue(undefined),
      recordSuccess: vi.fn().mockResolvedValue(undefined),
    };
    plugin.getSourceRefreshLedger = vi.fn(() => ledger);
    plugin.feedParser.refreshFeed.mockResolvedValue({
      ...rss,
      lastUpdated: 2,
    });

    await plugin.manualRefreshAllSources();

    expect(plugin.feedParser.refreshFeed).toHaveBeenCalledTimes(1);
    expect(ledger.recordSuccess).toHaveBeenCalledWith("rss-source", expect.any(Date));
    expect(ledger.recordError).toHaveBeenCalledWith(
      "x-account-openai",
      expect.any(Date),
      expect.objectContaining({ code: "missing-key" }),
    );
  });

  it("admits exactly one refresh session across overlapping single, all, failed, and startup entries", async () => {
    const account = createFeed({
      feedId: "x-account-openai",
      sourceKind: "x-account",
      sourceConfig: {
        kind: "x-account",
        id: "x-account-openai",
        handle: "openai",
        includeReplies: false,
        includeReposts: false,
        folder: "X",
        topics: [],
      },
      url: "tikhub://x-account/openai",
    });
    const plugin = createPluginWithSettings([account]);
    plugin.settings.collection = { ...plugin.settings.collection, enabled: false };
    plugin.settings.tikhub = {
      ...plugin.settings.tikhub,
      enabled: true,
      connectionId: "11111111-1111-4111-8111-111111111111",
    };
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refresh = vi.fn(async () => {
      await pending;
      return {
        feed: { ...account, lastUpdated: 2 },
        items: account.items,
        providerRequestCount: 1,
        warnings: [],
      };
    });
    plugin.createSourceRegistryForRun = vi.fn(() => ({ refresh }) as unknown as SourceRegistry);
    plugin.getSourceRefreshLedger = vi.fn(() => ({
      getDueSourceIds: vi.fn().mockResolvedValue(["x-account-openai"]),
      recordAttempt: vi.fn().mockResolvedValue(undefined),
      recordError: vi.fn().mockResolvedValue(undefined),
      recordSuccess: vi.fn().mockResolvedValue(undefined),
    }));
    plugin.settings.refreshMode = "daily-on-open";
    plugin.settings.startupRefreshDelaySeconds = 0;

    const startup = plugin.refreshOnOpenIfNeeded();
    await flushMicrotasks();
    expect(plugin.isMultiFeedRefreshActive).toBe(true);
    const single = plugin.manualRefreshSourceById("x-account-openai");
    const all = plugin.manualRefreshAllSources();
    const failed = plugin.manualRefreshFailedSources();
    await flushMicrotasks();

    expect(plugin.createSourceRegistryForRun).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(
      getNoticeMessages(consoleLogSpy).filter((message) =>
        message.includes("TikHub 请求预计 1 次"),
      ),
    ).toHaveLength(1);

    release();
    await Promise.all([single, all, failed, startup]);
  });

  it("records topic budget reservation failure without collection or daily success", async () => {
    const topic = createFeed({
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
    });
    const plugin = createPluginWithSettings([topic]);
    plugin.settings.tikhub = {
      ...plugin.settings.tikhub,
      enabled: true,
      connectionId: "11111111-1111-4111-8111-111111111111",
    };
    const ledger = {
      getSourceIdsWithStatus: vi.fn().mockResolvedValue([]),
      recordAttempt: vi.fn().mockResolvedValue(undefined),
      recordError: vi.fn().mockResolvedValue(undefined),
      recordSuccess: vi.fn().mockResolvedValue(undefined),
    };
    const collectFeedRefresh = vi.fn();
    plugin.getSourceRefreshLedger = vi.fn(() => ledger);
    plugin.getCollectionService = vi.fn(() => ({ collectFeedRefresh }));
    plugin.createSourceRegistryForRun = vi.fn(() => ({
      refresh: vi.fn().mockRejectedValue(
        new XTopicRefreshError(
          "budget-unavailable",
          "source.tikhubBudgetUnavailable",
          createTranslator("zh-CN"),
        ),
      ),
    }) as unknown as SourceRegistry);

    await plugin.manualRefreshAllSources();

    expect(collectFeedRefresh).not.toHaveBeenCalled();
    expect(ledger.recordSuccess).not.toHaveBeenCalled();
    expect(ledger.recordError).toHaveBeenCalledWith(
      "ai-apps",
      expect.any(Date),
      {
        code: "budget-unavailable",
        message: expect.stringContaining("预算"),
      },
    );
  });
  it("restores vault metadata and its plugin pointer with feed files", async () => {
    const source = createFeed({ feedId: "source-transaction" });
    const plugin = createPluginWithSettings([source]);
    plugin.settings.storageMode = "vault-shards-v2";
    plugin.settings.storageFolder = "RSS Data/Feeds";
    plugin.settings.metadataStorageMode = "vault-location";
    plugin.settings.metadataStorageFolder = "RSS Metadata";
    plugin.saveData = vi.fn(async (data: unknown) => {
      const contents = JSON.stringify(data);
      if (await plugin.app.vault.adapter.exists("data.json")) {
        await plugin.app.vault.adapter.write("data.json", contents);
        return;
      }
      await plugin.app.vault.create("data.json", contents);
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
    const originalProcess = adapter.process.bind(adapter);
    vi.spyOn(adapter, "process").mockImplementation(
      async (path, update) => {
        if (path !== "RSS Metadata/user-state.json") {
          return originalProcess(path, update);
        }
        return originalProcess(path, (contents) => {
          const next = update(contents);
          if (!next.includes('"states": {}')) {
            throw new Error("late user-state failure");
          }
          return next;
        });
      },
    );

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

  it("collects the complete X import batch while retaining the adapter cache snapshot", async () => {
    const config = {
      kind: "x-account" as const,
      id: "x-account-openai",
      handle: "openai",
      includeReplies: false,
      includeReposts: false,
      folder: "X",
      topics: [],
    };
    const source = createFeed({
      feedId: config.id,
      sourceKind: config.kind,
      sourceConfig: config,
      title: "@openai",
      url: "tikhub://x-account/openai",
      items: [createItem({ guid: "old", feedUrl: "tikhub://x-account/openai" })],
    });
    const completeBatch = ["3", "2", "1"].map((guid) => createItem({
      guid,
      link: `https://x.com/openai/status/${guid}`,
      feedTitle: "@openai",
      feedUrl: source.url,
    }));
    const retained = { ...source, items: [completeBatch[0]], lastUpdated: 2 };
    const plugin = createPluginWithSettings([source]);
    plugin.settings.tikhub = { ...plugin.settings.tikhub, enabled: true };
    const refresh = vi.fn(async (_config: FeedSourceConfig, context: { feed?: Feed }) => {
      expect(context.feed).toEqual({
        ...source,
        items: source.items.map((item) => ({
          ...item,
          rssDashboardSourceId: source.feedId,
        })),
      });
      expect(context.feed).not.toBe(source);
      expect(source.items[0].rssDashboardSourceId).toBeUndefined();
      return {
        feed: retained,
        items: retained.items,
        collectionItems: completeBatch,
        providerRequestCount: 2,
        warnings: [],
      };
    });
    plugin.createSourceRegistryForRun = vi.fn(() => ({ refresh }) as unknown as SourceRegistry);
    const collectFeedRefresh = vi.fn().mockResolvedValue([]);
    plugin.getCollectionService = vi.fn(() => ({ collectFeedRefresh }));

    await plugin.refreshFeeds([source]);

    expect(collectFeedRefresh).toHaveBeenCalledWith({
      feed: retained,
      previousItems: source.items.map((item) => ({
        ...item,
        rssDashboardSourceId: source.feedId,
      })),
      refreshedItems: completeBatch,
      fetchedAt: expect.any(Date),
    });
    expect(plugin.settings.feeds[0].items.map((entry) => entry.guid)).toEqual(["3"]);
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
    expect(await plugin.app.vault.adapter.exists("data.json")).toBe(true);
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
    expect(await plugin.app.vault.adapter.exists("data.json")).toBe(true);
    expect(refreshAllDashboards).toHaveBeenCalledTimes(1);

    const notices = getNoticeMessages(consoleLogSpy);
    expect(notices[0]).toBe("正在刷新 Feed B…");
    expect(notices).toContain("已刷新：Feed B");
  });

  it("publishes a completed single-source refresh only after an earlier subscription candidate commits", async () => {
    const source = createActiveXImportFeed("x-serialized-single");
    const originalItem = source.items[0];
    const refreshedItem = createItem({
      guid: "refreshed-single",
      feedUrl: source.url,
      feedTitle: source.title,
    });
    const plugin = createPluginWithSettings([source]);
    plugin.settings.tikhub = {
      ...plugin.settings.tikhub,
      enabled: true,
      connectionId: "11111111-1111-4111-8111-111111111111",
    };
    let markCandidateStarted!: () => void;
    let releaseCandidate!: () => void;
    const candidateStarted = new Promise<void>((resolve) => {
      markCandidateStarted = resolve;
    });
    const candidateBlocked = new Promise<void>((resolve) => {
      releaseCandidate = resolve;
    });
    (
      plugin as unknown as {
        persistSubscriptionSettingsCandidate(
          candidate: unknown,
          publish: () => void,
        ): Promise<void>;
      }
    ).persistSubscriptionSettingsCandidate = vi.fn(async (_candidate, publish) => {
      markCandidateStarted();
      await candidateBlocked;
      publish();
    });
    let markNetworkReturned!: () => void;
    const networkReturned = new Promise<void>((resolve) => {
      markNetworkReturned = resolve;
    });
    plugin.createSourceRegistryForRun = vi.fn(() => ({
      refresh: vi.fn(async () => {
        markNetworkReturned();
        return {
          feed: {
            ...source,
            items: [originalItem, refreshedItem],
            lastUpdated: 777,
            initialImportProgress: {
              status: "completed",
              pagesFetched: 2,
              itemsImported: 2,
            },
          },
          items: [originalItem, refreshedItem],
          collectionItems: [refreshedItem],
          providerRequestCount: 1,
          warnings: [],
        };
      }),
    }) as unknown as SourceRegistry);
    const saveUnlocked = vi.spyOn(
      plugin as unknown as {
        saveSettingsUnlocked(options?: unknown): Promise<void>;
      },
      "saveSettingsUnlocked",
    );

    const subscriptionMutation = plugin
      .getSubscriptionService()
      .setPaused(source.feedId!, false);
    await candidateStarted;
    const refresh = plugin.refreshSelectedFeed(source);
    await networkReturned;
    await flushMicrotasks();

    expect(plugin.settings.feeds[0].items).toEqual([originalItem]);
    expect(plugin.settings.feeds[0].lastUpdated).toBe(1);
    expect(plugin.settings.feeds[0].initialImportProgress?.status).toBe("running");
    expect(saveUnlocked).not.toHaveBeenCalled();

    releaseCandidate();
    await subscriptionMutation;
    await refresh;

    expect(plugin.settings.feeds[0].items.map((item) => item.guid)).toEqual([
      "guid-1",
      "refreshed-single",
    ]);
    expect(plugin.settings.feeds[0].lastUpdated).toBe(777);
    expect(plugin.settings.feeds[0].initialImportProgress).toEqual({
      status: "completed",
      pagesFetched: 2,
      itemsImported: 2,
    });
    expect(plugin.settings.lastRefreshTimestamp).toBeGreaterThan(0);
    expect(saveUnlocked).toHaveBeenCalledOnce();
  });

  it("publishes a completed batch once after an earlier subscription candidate commits", async () => {
    const sourceA = createFeed({
      feedId: "serialized-batch-a",
      url: "https://example.com/serialized-a.xml",
      lastUpdated: 10,
    });
    const sourceB = createFeed({
      feedId: "serialized-batch-b",
      title: "Feed B",
      url: "https://example.com/serialized-b.xml",
      lastUpdated: 20,
      items: [
        createItem({
          guid: "batch-b-old",
          feedTitle: "Feed B",
          feedUrl: "https://example.com/serialized-b.xml",
        }),
      ],
    });
    const plugin = createPluginWithSettings([sourceA, sourceB]);
    let markCandidateStarted!: () => void;
    let releaseCandidate!: () => void;
    const candidateStarted = new Promise<void>((resolve) => {
      markCandidateStarted = resolve;
    });
    const candidateBlocked = new Promise<void>((resolve) => {
      releaseCandidate = resolve;
    });
    (
      plugin as unknown as {
        persistSubscriptionSettingsCandidate(
          candidate: unknown,
          publish: () => void,
        ): Promise<void>;
      }
    ).persistSubscriptionSettingsCandidate = vi.fn(async (_candidate, publish) => {
      markCandidateStarted();
      await candidateBlocked;
      publish();
    });
    let returnedCount = 0;
    let markBothReturned!: () => void;
    const bothReturned = new Promise<void>((resolve) => {
      markBothReturned = resolve;
    });
    (plugin.feedParser.refreshFeed as unknown as {
      mockImplementation: (operation: (feed: Feed) => Promise<Feed>) => void;
    }).mockImplementation(async (feed: Feed) => {
      returnedCount += 1;
      if (returnedCount === 2) markBothReturned();
      return {
        ...feed,
        lastUpdated: feed.feedId === sourceA.feedId ? 110 : 220,
        items: [
          ...feed.items,
          createItem({
            guid: `${feed.feedId}-new`,
            feedTitle: feed.title,
            feedUrl: feed.url,
          }),
        ],
      };
    });
    const saveUnlocked = vi.spyOn(
      plugin as unknown as {
        saveSettingsUnlocked(options?: unknown): Promise<void>;
      },
      "saveSettingsUnlocked",
    );

    const subscriptionMutation = plugin
      .getSubscriptionService()
      .setPaused(sourceA.feedId!, false);
    await candidateStarted;
    const refresh = plugin.refreshFeeds();
    await bothReturned;
    await flushMicrotasks();

    expect(plugin.settings.feeds.map((feed) => feed.lastUpdated)).toEqual([10, 20]);
    expect(plugin.settings.feeds.map((feed) => feed.items.length)).toEqual([1, 1]);
    expect(saveUnlocked).not.toHaveBeenCalled();

    releaseCandidate();
    await subscriptionMutation;
    await refresh;

    expect(plugin.settings.feeds.map((feed) => feed.lastUpdated)).toEqual([
      110,
      220,
    ]);
    expect(plugin.settings.feeds.map((feed) => feed.items.length)).toEqual([2, 2]);
    expect(saveUnlocked).toHaveBeenCalledOnce();
  });

  it("lets a later subscription mutation retain history from a refresh publication that owns the queue first", async () => {
    const source = createFeed({
      feedId: "refresh-first",
      url: "https://example.com/refresh-first.xml",
    });
    const plugin = createPluginWithSettings([source]);
    const refreshedItem = createItem({
      guid: "refresh-first-new",
      feedUrl: source.url,
    });
    plugin.feedParser.refreshFeed.mockResolvedValue({
      ...source,
      items: [...source.items, refreshedItem],
      lastUpdated: 909,
    });
    const internals = plugin as unknown as {
      saveSettingsUnlocked(options?: unknown): Promise<void>;
    };
    const originalSaveUnlocked = internals.saveSettingsUnlocked.bind(plugin);
    let markRefreshSaveStarted!: () => void;
    let releaseRefreshSave!: () => void;
    const refreshSaveStarted = new Promise<void>((resolve) => {
      markRefreshSaveStarted = resolve;
    });
    const refreshSaveBlocked = new Promise<void>((resolve) => {
      releaseRefreshSave = resolve;
    });
    vi.spyOn(internals, "saveSettingsUnlocked").mockImplementation(async (options) => {
      markRefreshSaveStarted();
      await refreshSaveBlocked;
      await originalSaveUnlocked(options);
    });

    const refresh = plugin.refreshSelectedFeed(source);
    await refreshSaveStarted;
    const subscriptionMutation = plugin
      .getSubscriptionService()
      .setPaused(source.feedId!, false);
    let subscriptionSettled = false;
    void subscriptionMutation.finally(() => {
      subscriptionSettled = true;
    });
    await flushMicrotasks();

    expect(subscriptionSettled).toBe(false);

    releaseRefreshSave();
    await refresh;
    await subscriptionMutation;

    expect(plugin.settings.feeds[0].items.map((item) => item.guid)).toEqual([
      "guid-1",
      "refresh-first-new",
    ]);
    expect(plugin.settings.feeds[0].lastUpdated).toBe(909);
  });

  it.each([
    ["paused", async (plugin: TestPlugin, source: Feed) => {
      await plugin.getSubscriptionService().setPaused(source.feedId!, true);
    }],
    ["deleted", async (plugin: TestPlugin, source: Feed) => {
      await plugin.getSubscriptionService().remove(source.feedId!, {
        purgeCollection: false,
      });
    }],
  ] as const)(
    "does not publish a completed refresh after the source becomes %s",
    async (_state, mutateSource) => {
      const source = createFeed({
        feedId: `late-${_state}`,
        url: `https://example.com/late-${_state}.xml`,
        lastUpdated: 40,
      });
      const plugin = createPluginWithSettings([source]);
      let markNetworkStarted!: () => void;
      let releaseNetwork!: () => void;
      const networkStarted = new Promise<void>((resolve) => {
        markNetworkStarted = resolve;
      });
      const networkBlocked = new Promise<void>((resolve) => {
        releaseNetwork = resolve;
      });
      (plugin.feedParser.refreshFeed as unknown as {
        mockImplementation: (operation: () => Promise<Feed>) => void;
      }).mockImplementation(async () => {
        markNetworkStarted();
        await networkBlocked;
        return {
          ...source,
          items: [
            ...source.items,
            createItem({ guid: `late-${_state}-new`, feedUrl: source.url }),
          ],
          lastUpdated: 404,
        };
      });
      const saveUnlocked = vi.spyOn(
        plugin as unknown as {
          saveSettingsUnlocked(options?: unknown): Promise<void>;
        },
        "saveSettingsUnlocked",
      );
      const initialRefreshTimestamp = plugin.settings.lastRefreshTimestamp;

      const refresh = plugin.refreshSelectedFeed(source);
      await networkStarted;
      await mutateSource(plugin, source);
      releaseNetwork();
      await refresh;

      if (_state === "paused") {
        expect(plugin.settings.feeds).toHaveLength(1);
        expect(plugin.settings.feeds[0].subscriptionStatus).toBe("paused");
        expect(plugin.settings.feeds[0].items).toHaveLength(1);
        expect(plugin.settings.feeds[0].lastUpdated).toBe(40);
      } else {
        expect(plugin.settings.feeds).toEqual([]);
      }
      expect(plugin.settings.lastRefreshTimestamp).toBe(initialRefreshTimestamp);
      expect(saveUnlocked).not.toHaveBeenCalled();
    },
  );

  it("does not merge a completed refresh after the source identity changes while publication waits", async () => {
    const source = createFeed({
      feedId: "identity-switch",
      url: "https://example.com/identity-old.xml",
      lastUpdated: 50,
    });
    const plugin = createPluginWithSettings([source]);
    const internals = plugin as unknown as {
      enqueueSettingsOperation<T>(operation: () => Promise<T>): Promise<T>;
      saveSettingsUnlocked(options?: unknown): Promise<void>;
    };
    let markMutationStarted!: () => void;
    let releaseMutation!: () => void;
    const mutationStarted = new Promise<void>((resolve) => {
      markMutationStarted = resolve;
    });
    const mutationBlocked = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const identityMutation = internals.enqueueSettingsOperation(async () => {
      markMutationStarted();
      await mutationBlocked;
      plugin.settings.feeds[0].url = "https://example.com/identity-new.xml";
      await internals.saveSettingsUnlocked();
    });
    let markNetworkReturned!: () => void;
    const networkReturned = new Promise<void>((resolve) => {
      markNetworkReturned = resolve;
    });
    (plugin.feedParser.refreshFeed as unknown as {
      mockImplementation: (operation: () => Promise<Feed>) => void;
    }).mockImplementation(async () => {
      markNetworkReturned();
      return {
        ...source,
        items: [
          ...source.items,
          createItem({ guid: "identity-stale", feedUrl: source.url }),
        ],
        lastUpdated: 505,
      };
    });
    const initialRefreshTimestamp = plugin.settings.lastRefreshTimestamp;

    await mutationStarted;
    const refresh = plugin.refreshSelectedFeed(source);
    await networkReturned;
    await flushMicrotasks();
    expect(plugin.settings.feeds[0].items).toHaveLength(1);

    releaseMutation();
    await identityMutation;
    await refresh;

    expect(plugin.settings.feeds[0].url).toBe(
      "https://example.com/identity-new.xml",
    );
    expect(plugin.settings.feeds[0].items).toHaveLength(1);
    expect(plugin.settings.feeds[0].lastUpdated).toBe(50);
    expect(plugin.settings.lastRefreshTimestamp).toBe(initialRefreshTimestamp);
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
    expect(await plugin.app.vault.adapter.exists("data.json")).toBe(true);
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

  it("excludes paused subscriptions from automatic and manual refresh without deleting them", async () => {
    const paused = createFeed({
      feedId: "paused-source",
      subscriptionStatus: "paused",
    });
    const active = createFeed({
      feedId: "active-source",
      title: "Active",
      url: "https://example.com/active.xml",
    });
    const plugin = createPluginWithSettings([paused, active]);
    plugin.feedParser.refreshFeed.mockResolvedValue({ ...active });

    await plugin.refreshFeeds();

    expect(plugin.settings.feeds).toHaveLength(2);
    expect(plugin.feedParser.refreshFeed).toHaveBeenCalledTimes(1);
    expect(plugin.feedParser.refreshFeed).toHaveBeenCalledWith(
      expect.objectContaining({ feedId: "active-source" }),
    );
  });

  it("excludes a paused subscription from Dashboard single-source refresh", async () => {
    const paused = createFeed({
      feedId: "paused-source",
      subscriptionStatus: "paused",
    });
    const plugin = createPluginWithSettings([paused]);

    await plugin.manualRefreshSourceById("paused-source");

    expect(plugin.feedParser.refreshFeed).not.toHaveBeenCalled();
    expect(plugin.feedParser.refreshAllFeeds).not.toHaveBeenCalled();
    expect(plugin.saveData).not.toHaveBeenCalled();
  });

  it("does not let an ordinary feed refresh trim or replace a failed first-import checkpoint", async () => {
    const checkpointItems = [
      createItem({ guid: "checkpoint-new" }),
      createItem({ guid: "checkpoint-old", pubDate: "2020-01-01T00:00:00.000Z" }),
    ];
    const failed = createFeed({
      feedId: "failed-first-import",
      sourceKind: "feed",
      sourceConfig: { kind: "feed" },
      items: checkpointItems,
      initialImportPolicy: { mode: "all-available" },
      initialImportProgress: {
        status: "failed",
        pagesFetched: 0,
        itemsImported: 0,
      },
    });
    const plugin = createPluginWithSettings([failed]);
    plugin.feedParser.refreshFeed.mockResolvedValue({
      ...failed,
      items: [createItem({ guid: "replacement" })],
      initialImportProgress: undefined,
    });

    await plugin.manualRefreshSourceById("failed-first-import");

    expect(plugin.feedParser.refreshFeed).not.toHaveBeenCalled();
    expect(plugin.settings.feeds[0].items).toEqual(checkpointItems);
    expect(plugin.settings.feeds[0].initialImportProgress?.status).toBe("failed");
  });

  it("aborts an in-flight X history run and rejects a late completed generation over stopped", async () => {
    const source = createFeed({
      feedId: "x-history",
      sourceKind: "x-account",
      sourceConfig: {
        kind: "x-account",
        id: "x-history",
        handle: "openai",
        includeReplies: false,
        includeReposts: false,
        folder: "X",
        topics: [],
      },
      url: "tikhub://x-account/openai",
      initialImportPolicy: { mode: "all-available" },
      initialImportProgress: {
        status: "running",
        pagesFetched: 1,
        itemsImported: 1,
        phase: "posts",
        nextCursor: "next-page",
      },
    });
    const plugin = createPluginWithSettings([source]);
    plugin.settings.tikhub = {
      ...plugin.settings.tikhub,
      enabled: true,
      connectionId: "11111111-1111-4111-8111-111111111111",
    };
    let observedStopSignal: AbortSignal | undefined;
    let markStarted!: () => void;
    let finishLate!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const late = new Promise<void>((resolve) => { finishLate = resolve; });
    plugin.createSourceRegistryForRun = vi.fn(() => ({
      refresh: vi.fn(async (_config, context) => {
        observedStopSignal = context.stopSignal;
        markStarted();
        await late;
        return {
          feed: {
            ...source,
            items: [
              ...source.items,
              createItem({ guid: "late-stopped-item", feedUrl: source.url }),
            ],
            lastUpdated: 999,
            initialImportProgress: {
              status: "completed",
              pagesFetched: 9,
              itemsImported: 9,
            },
          },
          items: source.items,
          collectionItems: [],
          providerRequestCount: 1,
          warnings: [],
        };
      }),
    }) as unknown as SourceRegistry);

    const refresh = plugin.refreshSelectedFeed(source);
    await started;
    await plugin.getSubscriptionService().stopInitialImport("x-history");

    expect(observedStopSignal?.aborted).toBe(true);
    expect(plugin.settings.feeds[0].initialImportProgress?.status).toBe("stopped");

    finishLate();
    await refresh;
    expect(plugin.settings.feeds[0].initialImportProgress?.status).toBe("stopped");
    expect(plugin.settings.feeds[0].items).toHaveLength(1);
    expect(plugin.settings.feeds[0].lastUpdated).toBe(1);
  });

  it("registers the X history stop before refresh-state persistence can yield", async () => {
    const source = createFeed({
      feedId: "x-history-before-ledger",
      sourceKind: "x-account",
      sourceConfig: {
        kind: "x-account",
        id: "x-history-before-ledger",
        handle: "openai",
        includeReplies: false,
        includeReposts: false,
        folder: "X",
        topics: [],
      },
      url: "tikhub://x-account/openai",
      initialImportPolicy: { mode: "all-available" },
      initialImportProgress: {
        status: "running",
        pagesFetched: 1,
        itemsImported: 1,
        phase: "posts",
        nextCursor: "next-page",
      },
    });
    const plugin = createPluginWithSettings([source]);
    plugin.settings.tikhub = {
      ...plugin.settings.tikhub,
      enabled: true,
      connectionId: "11111111-1111-4111-8111-111111111111",
    };
    let releaseAttempt!: () => void;
    const attemptBlocked = new Promise<void>((resolve) => {
      releaseAttempt = resolve;
    });
    plugin.getSourceRefreshLedger = vi.fn(() => ({
      getSourceIdsWithStatus: vi.fn().mockResolvedValue([]),
      recordAttempt: vi.fn(async () => await attemptBlocked),
      recordError: vi.fn().mockResolvedValue(undefined),
    }));
    const paidRefresh = vi.fn().mockResolvedValue({
      feed: source,
      items: source.items,
      collectionItems: [],
      providerRequestCount: 1,
      warnings: [],
    });
    plugin.createSourceRegistryForRun = vi.fn(() => ({
      refresh: paidRefresh,
    }) as unknown as SourceRegistry);

    const refresh = plugin.refreshSelectedFeed(source);
    await flushMicrotasks();
    await plugin.getSubscriptionService().stopInitialImport(source.feedId!);
    releaseAttempt();
    await refresh;

    expect(paidRefresh).not.toHaveBeenCalled();
    expect(plugin.settings.feeds[0].initialImportProgress?.status).toBe("stopped");
  });

  it("does not persist refresh completion when default removal deletes the source during the ledger gate", async () => {
    const source = createActiveXImportFeed("x-history-default-delete");
    const plugin = createPluginWithSettings([source]);
    const initialRefreshTimestamp = plugin.settings.lastRefreshTimestamp;
    const candidatePersistenceSpy = vi.spyOn(
      plugin as unknown as {
        persistSubscriptionSettingsCandidate(
          candidate: unknown,
          publish: () => void,
        ): Promise<void>;
      },
      "persistSubscriptionSettingsCandidate",
    );
    plugin.settings.tikhub = {
      ...plugin.settings.tikhub,
      enabled: true,
      connectionId: "11111111-1111-4111-8111-111111111111",
    };
    let markAttemptStarted!: () => void;
    let releaseAttempt!: () => void;
    const attemptStarted = new Promise<void>((resolve) => {
      markAttemptStarted = resolve;
    });
    const attemptBlocked = new Promise<void>((resolve) => {
      releaseAttempt = resolve;
    });
    plugin.getSourceRefreshLedger = vi.fn(() => ({
      getSourceIdsWithStatus: vi.fn().mockResolvedValue([]),
      recordAttempt: vi.fn(async () => {
        markAttemptStarted();
        await attemptBlocked;
      }),
      recordError: vi.fn().mockResolvedValue(undefined),
    }));
    const paidRefresh = vi.fn().mockResolvedValue({
      feed: source,
      items: source.items,
      collectionItems: source.items,
      providerRequestCount: 1,
      warnings: [],
    });
    plugin.createSourceRegistryForRun = vi.fn(() => ({
      refresh: paidRefresh,
    }) as unknown as SourceRegistry);
    const collectFeedRefresh = vi.fn().mockResolvedValue([]);
    plugin.getCollectionService = vi.fn(() => ({
      collectFeedRefresh,
      removeSource: vi.fn(),
    }));

    const refresh = plugin.refreshSelectedFeed(source);
    await attemptStarted;
    await plugin.getSubscriptionService().remove(source.feedId!, {
      purgeCollection: false,
    });
    releaseAttempt();
    await refresh;

    expect(paidRefresh).not.toHaveBeenCalled();
    expect(collectFeedRefresh).not.toHaveBeenCalled();
    expect(plugin.validateSavedArticles).not.toHaveBeenCalled();
    expect(candidatePersistenceSpy).toHaveBeenCalledOnce();
    expect(plugin.settings.lastRefreshTimestamp).toBe(initialRefreshTimestamp);
    expect(plugin.settings.feeds).toEqual([]);
  });

  it("does not call the X provider when purge removal finishes before provider start", async () => {
    const source = createActiveXImportFeed("x-history-purge-delete");
    const plugin = createPluginWithSettings([source]);
    plugin.settings.tikhub = {
      ...plugin.settings.tikhub,
      enabled: true,
      connectionId: "11111111-1111-4111-8111-111111111111",
    };
    const collectFeedRefresh = vi.fn().mockResolvedValue([]);
    const commit = vi.fn().mockResolvedValue(undefined);
    const removeSource = vi.fn().mockResolvedValue({
      days: [],
      commit,
      rollback: vi.fn().mockResolvedValue(undefined),
    });
    plugin.getCollectionService = vi.fn(() => ({
      collectFeedRefresh,
      removeSource,
    }));
    plugin.getSourceRefreshLedger = vi.fn(() => ({
      getSourceIdsWithStatus: vi.fn().mockResolvedValue([]),
      recordAttempt: vi.fn(async () => {
        await plugin.getSubscriptionService().remove(source.feedId!, {
          purgeCollection: true,
          confirmation: createConfirmedCollectionPurge(source.feedId!),
        });
      }),
      recordError: vi.fn().mockResolvedValue(undefined),
    }));
    const paidRefresh = vi.fn().mockResolvedValue({
      feed: source,
      items: source.items,
      collectionItems: source.items,
      providerRequestCount: 1,
      warnings: [],
    });
    plugin.createSourceRegistryForRun = vi.fn(() => ({
      refresh: paidRefresh,
    }) as unknown as SourceRegistry);

    await plugin.refreshSelectedFeed(source);

    expect(removeSource).toHaveBeenCalledWith(source.feedId);
    expect(commit).toHaveBeenCalledOnce();
    expect(paidRefresh).not.toHaveBeenCalled();
    expect(collectFeedRefresh).not.toHaveBeenCalled();
    expect(plugin.settings.feeds).toEqual([]);
  });

  it.each([
    { label: "default", purgeCollection: false },
    { label: "purge", purgeCollection: true },
  ])(
    "blocks a queue-delayed $label removal before the refresh registers its X controller",
    async ({ purgeCollection }) => {
      const source = createActiveXImportFeed(
        `x-history-queued-${purgeCollection ? "purge" : "default"}`,
      );
      const plugin = createPluginWithSettings([source]);
      plugin.settings.tikhub = {
        ...plugin.settings.tikhub,
        enabled: true,
        connectionId: "11111111-1111-4111-8111-111111111111",
      };
      let markSaveStarted!: () => void;
      let releaseSave!: () => void;
      const saveStarted = new Promise<void>((resolve) => {
        markSaveStarted = resolve;
      });
      const saveBlocked = new Promise<void>((resolve) => {
        releaseSave = resolve;
      });
      (
        plugin as unknown as {
          persistSubscriptionSettingsCandidate(
            candidate: unknown,
            publish: () => void,
          ): Promise<void>;
        }
      ).persistSubscriptionSettingsCandidate = vi.fn()
        .mockImplementationOnce(async (_candidate, publish) => {
          markSaveStarted();
          await saveBlocked;
          publish();
        })
        .mockImplementation(async (_candidate, publish) => { publish(); });
      const paidRefresh = vi.fn().mockResolvedValue({
        feed: source,
        items: source.items,
        collectionItems: source.items,
        providerRequestCount: 1,
        warnings: [],
      });
      plugin.createSourceRegistryForRun = vi.fn(() => ({
        refresh: paidRefresh,
      }) as unknown as SourceRegistry);
      const collectFeedRefresh = vi.fn().mockResolvedValue([]);
      const commit = vi.fn().mockResolvedValue(undefined);
      const removeSource = vi.fn().mockResolvedValue({
        days: [],
        commit,
        rollback: vi.fn().mockResolvedValue(undefined),
      });
      plugin.getCollectionService = vi.fn(() => ({
        collectFeedRefresh,
        removeSource,
      }));
      const firstService = plugin.getSubscriptionService();
      const removingService = plugin.getSubscriptionService();

      const priorMutation = firstService.setPaused(source.feedId!, false);
      await saveStarted;
      const removal = removingService.remove(
        source.feedId!,
        purgeCollection
          ? {
              purgeCollection: true,
              confirmation: createConfirmedCollectionPurge(source.feedId!),
            }
          : { purgeCollection: false },
      );
      const refresh = plugin.refreshSelectedFeed(source);
      await flushMicrotasks();

      expect(paidRefresh).not.toHaveBeenCalled();
      expect(collectFeedRefresh).not.toHaveBeenCalled();

      releaseSave();
      await priorMutation;
      await removal;
      await refresh;

      expect(paidRefresh).not.toHaveBeenCalled();
      expect(collectFeedRefresh).not.toHaveBeenCalled();
      expect(removeSource).toHaveBeenCalledTimes(purgeCollection ? 1 : 0);
      expect(commit).toHaveBeenCalledTimes(purgeCollection ? 1 : 0);
      expect(plugin.settings.feeds).toEqual([]);
    },
  );

  it("allows refresh again after a queue-delayed removal fails and clears its intent", async () => {
    const source = createActiveXImportFeed("x-history-failed-removal");
    const plugin = createPluginWithSettings([source]);
    plugin.settings.tikhub = {
      ...plugin.settings.tikhub,
      enabled: true,
      connectionId: "11111111-1111-4111-8111-111111111111",
    };
    let markSaveStarted!: () => void;
    let releaseSave!: () => void;
    const saveStarted = new Promise<void>((resolve) => {
      markSaveStarted = resolve;
    });
    const saveBlocked = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    (
      plugin as unknown as {
        persistSubscriptionSettingsCandidate(
          candidate: unknown,
          publish: () => void,
        ): Promise<void>;
      }
    ).persistSubscriptionSettingsCandidate = vi.fn()
      .mockImplementationOnce(async (_candidate, publish) => {
        markSaveStarted();
        await saveBlocked;
        publish();
      })
      .mockRejectedValueOnce(new Error("removal save failed"))
      .mockImplementation(async (_candidate, publish) => { publish(); });
    const paidRefresh = vi.fn().mockResolvedValue({
      feed: source,
      items: source.items,
      collectionItems: source.items,
      providerRequestCount: 1,
      warnings: [],
    });
    plugin.createSourceRegistryForRun = vi.fn(() => ({
      refresh: paidRefresh,
    }) as unknown as SourceRegistry);
    const collectFeedRefresh = vi.fn().mockResolvedValue([]);
    plugin.getCollectionService = vi.fn(() => ({
      collectFeedRefresh,
      removeSource: vi.fn(),
    }));
    const firstService = plugin.getSubscriptionService();
    const removingService = plugin.getSubscriptionService();

    const priorMutation = firstService.setPaused(source.feedId!, false);
    await saveStarted;
    const removal = removingService.remove(source.feedId!, {
      purgeCollection: false,
    });
    const blockedRefresh = plugin.refreshSelectedFeed(source);
    await flushMicrotasks();

    expect(paidRefresh).not.toHaveBeenCalled();
    expect(collectFeedRefresh).not.toHaveBeenCalled();

    releaseSave();
    await priorMutation;
    await expect(removal).rejects.toThrow("removal save failed");
    await blockedRefresh;
    expect(plugin.settings.feeds).toHaveLength(1);

    await plugin.refreshSelectedFeed(plugin.settings.feeds[0]);

    expect(paidRefresh).toHaveBeenCalledOnce();
    expect(collectFeedRefresh).toHaveBeenCalledOnce();
    expect(plugin.settings.feeds).toHaveLength(1);
  });

  it("rechecks a cross-instance removal intent after the ledger before provider work", async () => {
    const source = createActiveXImportFeed("x-history-ledger-removal-intent");
    const plugin = createPluginWithSettings([source]);
    plugin.settings.tikhub = {
      ...plugin.settings.tikhub,
      enabled: true,
      connectionId: "11111111-1111-4111-8111-111111111111",
    };
    let markSaveStarted!: () => void;
    let releaseSave!: () => void;
    const saveStarted = new Promise<void>((resolve) => {
      markSaveStarted = resolve;
    });
    const saveBlocked = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    (
      plugin as unknown as {
        persistSubscriptionSettingsCandidate(
          candidate: unknown,
          publish: () => void,
        ): Promise<void>;
      }
    ).persistSubscriptionSettingsCandidate = vi.fn()
      .mockImplementationOnce(async (_candidate, publish) => {
        markSaveStarted();
        await saveBlocked;
        publish();
      })
      .mockImplementation(async (_candidate, publish) => { publish(); });
    let markAttemptStarted!: () => void;
    let releaseAttempt!: () => void;
    const attemptStarted = new Promise<void>((resolve) => {
      markAttemptStarted = resolve;
    });
    const attemptBlocked = new Promise<void>((resolve) => {
      releaseAttempt = resolve;
    });
    plugin.getSourceRefreshLedger = vi.fn(() => ({
      getSourceIdsWithStatus: vi.fn().mockResolvedValue([]),
      recordAttempt: vi.fn(async () => {
        markAttemptStarted();
        await attemptBlocked;
      }),
      recordError: vi.fn().mockResolvedValue(undefined),
    }));
    const paidRefresh = vi.fn();
    plugin.createSourceRegistryForRun = vi.fn(() => ({
      refresh: paidRefresh,
    }) as unknown as SourceRegistry);
    const collectFeedRefresh = vi.fn();
    const collectionService = {
      collectFeedRefresh,
      removeSource: vi.fn().mockResolvedValue({
        days: [],
        commit: vi.fn().mockResolvedValue(undefined),
        rollback: vi.fn().mockResolvedValue(undefined),
      }),
    };
    plugin.getCollectionService = vi.fn(() => collectionService);
    const queueOwner = plugin.getSubscriptionService();
    const removingService = new SubscriptionService({
      settings: plugin.settings,
      getSettings: () => plugin.settings,
      enqueueMutation: async (operation) => await (
        plugin as unknown as {
          enqueueSettingsOperation<T>(operation: () => Promise<T>): Promise<T>;
        }
      ).enqueueSettingsOperation(operation),
      defaults: {
        autoDeleteDuration: plugin.settings.defaultAutoDeleteDuration,
        maxItems: plugin.settings.maxItems,
      },
      parseFeed: vi.fn(),
      collectionService,
      ensureFolder: vi.fn(),
      saveSettings: async () => await plugin.saveSettings(),
      saveSettingsCandidate: async (_candidate, publish) => { publish(); },
    });

    const priorMutation = queueOwner.setPaused(source.feedId!, false);
    await saveStarted;
    const refresh = plugin.refreshSelectedFeed(source);
    await attemptStarted;
    const removal = removingService.remove(source.feedId!, {
      purgeCollection: false,
    });
    releaseAttempt();
    await refresh;

    expect(paidRefresh).not.toHaveBeenCalled();
    expect(collectFeedRefresh).not.toHaveBeenCalled();
    expect(plugin.settings.feeds).toHaveLength(1);

    releaseSave();
    await priorMutation;
    await removal;
    expect(plugin.settings.feeds).toEqual([]);
  });

  it("does not start an unpersisted active X initial-import snapshot", async () => {
    const source = createActiveXImportFeed("x-history-unpersisted");
    const plugin = createPluginWithSettings([]);
    plugin.settings.tikhub = {
      ...plugin.settings.tikhub,
      enabled: true,
      connectionId: "11111111-1111-4111-8111-111111111111",
    };
    const paidRefresh = vi.fn();
    const collectFeedRefresh = vi.fn();
    plugin.createSourceRegistryForRun = vi.fn(() => ({
      refresh: paidRefresh,
    }) as unknown as SourceRegistry);
    plugin.getCollectionService = vi.fn(() => ({ collectFeedRefresh }));

    await plugin.refreshSelectedFeed(source);

    expect(paidRefresh).not.toHaveBeenCalled();
    expect(collectFeedRefresh).not.toHaveBeenCalled();
    expect(plugin.settings.feeds).toEqual([]);
  });

  it("does not fall back to stale X input after a persisted source disappears at the ledger gate", async () => {
    const source = createActiveXImportFeed("x-history-disappeared");
    const plugin = createPluginWithSettings([source]);
    plugin.settings.tikhub = {
      ...plugin.settings.tikhub,
      enabled: true,
      connectionId: "11111111-1111-4111-8111-111111111111",
    };
    plugin.getSourceRefreshLedger = vi.fn(() => ({
      getSourceIdsWithStatus: vi.fn().mockResolvedValue([]),
      recordAttempt: vi.fn(async () => {
        plugin.settings.feeds = [];
      }),
      recordError: vi.fn().mockResolvedValue(undefined),
    }));
    const paidRefresh = vi.fn();
    const collectFeedRefresh = vi.fn();
    plugin.createSourceRegistryForRun = vi.fn(() => ({
      refresh: paidRefresh,
    }) as unknown as SourceRegistry);
    plugin.getCollectionService = vi.fn(() => ({ collectFeedRefresh }));

    await plugin.refreshSelectedFeed(source);

    expect(paidRefresh).not.toHaveBeenCalled();
    expect(collectFeedRefresh).not.toHaveBeenCalled();
    expect(plugin.settings.feeds).toEqual([]);
  });

  it("keeps refreshing an unpersisted legacy RSS snapshot passed explicitly", async () => {
    const source = createFeed({
      feedId: undefined,
      sourceKind: undefined,
      sourceConfig: undefined,
      initialImportPolicy: undefined,
      initialImportProgress: undefined,
    });
    const plugin = createPluginWithSettings([]);
    const refreshed = { ...source, lastUpdated: 2 };
    plugin.feedParser.refreshFeed.mockResolvedValue(refreshed);
    const collectFeedRefresh = vi.fn().mockResolvedValue([]);
    plugin.getCollectionService = vi.fn(() => ({ collectFeedRefresh }));

    await plugin.refreshSelectedFeed(source);

    expect(plugin.feedParser.refreshFeed).toHaveBeenCalledOnce();
    expect(collectFeedRefresh).toHaveBeenCalledWith({
      feed: refreshed,
      previousItems: source.items,
      refreshedItems: refreshed.items,
      fetchedAt: expect.any(Date),
    });
    expect(plugin.settings.feeds).toEqual([]);
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

  it.each([
    ["present A to B", true, { rssDashboardId: "b".repeat(64) }],
    ["missing to arbitrary", false, { rssDashboardId: "b".repeat(64) }],
    [
      "identity combined with flags",
      true,
      { rssDashboardId: "b".repeat(64), read: true, starred: true },
    ],
  ] as const)(
    "rejects public article identity mutation: %s",
    async (_scenario, initiallyPresent, updates) => {
      const originalId = "a".repeat(64);
      const article = createItem({ read: false, starred: false });
      if (initiallyPresent) article.rssDashboardId = originalId;
      const source = createFeed({ feedId: "source-public-id", items: [article] });
      const plugin = createPluginWithSettings([source]) as unknown as TestPlugin & {
        updateArticle: (
          guid: string,
          url: string,
          updates: Partial<FeedItem>,
        ) => Promise<boolean>;
      };

      await expect(
        plugin.updateArticle(article.guid, source.url, updates),
      ).resolves.toBe(false);

      expect(article.rssDashboardId).toBe(
        initiallyPresent ? originalId : undefined,
      );
      expect(article.read).toBe(false);
      expect(article.starred).toBe(false);
      expect(plugin.saveData).not.toHaveBeenCalled();
      expect(await plugin.app.vault.adapter.exists(
        ".rss-dashboard-data/state/status-repair.json",
      )).toBe(false);
    },
  );

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
    expect(await plugin.app.vault.adapter.exists("data.json")).toBe(true);
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

  it("replays a missing canonical X ID by explicit journal locator after restart", async () => {
    const guid = "1901234567890123456";
    const expectedId = createXPostCollectedItemId(guid);
    const article = createItem({
      guid,
      link: `https://x.com/example/status/${guid}`,
      saved: true,
      savedFilePath: "Notes/interrupted-x.md",
    });
    delete article.rssDashboardId;
    const source = createFeed({
      feedId: "source-x-restart",
      sourceType: "x-account",
      items: [article],
    } as Partial<Feed>);
    const plugin = createPluginWithSettings([source]) as unknown as TestPlugin & {
      replayStatusRepairJournalIfNeeded: () => Promise<boolean>;
      saveSettings: ReturnType<typeof vi.fn>;
    };
    plugin.saveSettings = vi.fn().mockResolvedValue(undefined);
    const path = ".rss-dashboard-data/state/status-repair.json";
    await plugin.app.vault.adapter.write(path, JSON.stringify({
      version: 2,
      txId: "tx-15-xrestart",
      phase: "feed-write-uncertain",
      items: [{
        feedIndex: 0,
        itemIndex: 0,
        sourceLocator: createTestSourceLocator("source-x-restart"),
        stableId: expectedId,
        previousFeed: [
          { key: "rssDashboardId", exists: false },
          { key: "saved", exists: true, value: false },
          { key: "savedFilePath", exists: false },
        ],
      }],
    }));

    await expect(plugin.replayStatusRepairJournalIfNeeded()).resolves.toBe(true);

    expect(article.rssDashboardId).toBeUndefined();
    expect(article.saved).toBe(false);
    expect(article.savedFilePath).toBeUndefined();
    expect(plugin.saveSettings).toHaveBeenCalledWith({
      forceAllShards: true,
      forceMetadata: true,
    });
    expect(await plugin.app.vault.adapter.exists(path)).toBe(false);
  });

  it("rejects a journal that rewrites stable locator A to unrelated ID B", async () => {
    const stableId = "a".repeat(64);
    const unrelatedId = "b".repeat(64);
    const target = createItem({
      guid: "target-a",
      rssDashboardId: stableId,
      read: true,
    });
    const unrelated = createItem({
      guid: "unrelated-b",
      rssDashboardId: unrelatedId,
      read: true,
    });
    const source = createFeed({
      feedId: "source-hostile-identity",
      items: [target, unrelated],
    });
    const plugin = createPluginWithSettings([source]) as unknown as TestPlugin & {
      replayStatusRepairJournalIfNeeded: () => Promise<boolean>;
      saveSettings: ReturnType<typeof vi.fn>;
    };
    plugin.saveSettings = vi.fn().mockResolvedValue(undefined);
    const path = ".rss-dashboard-data/state/status-repair.json";
    await plugin.app.vault.adapter.write(path, JSON.stringify({
      version: 2,
      txId: "tx-16-hostile",
      phase: "feed-write-uncertain",
      items: [{
        feedIndex: 0,
        itemIndex: 0,
        sourceLocator: createTestSourceLocator("source-hostile-identity"),
        stableId,
        previousFeed: [
          { key: "rssDashboardId", exists: true, value: unrelatedId },
          { key: "read", exists: true, value: false },
        ],
      }],
    }));

    await expect(plugin.replayStatusRepairJournalIfNeeded()).resolves.toBe(false);

    expect(target.rssDashboardId).toBe(stableId);
    expect(target.read).toBe(true);
    expect(unrelated.rssDashboardId).toBe(unrelatedId);
    expect(plugin.saveSettings).not.toHaveBeenCalled();
    expect(await plugin.app.vault.adapter.exists(path)).toBe(true);
  });

  it.each([
    [
      "missing identity record",
      [{ key: "read", exists: true, value: false }],
    ],
    [
      "missing identity with a value",
      [{ key: "rssDashboardId", exists: false, value: "a".repeat(64) }],
    ],
    [
      "present identity without a value",
      [{ key: "rssDashboardId", exists: true }],
    ],
    [
      "duplicate identity records",
      [
        { key: "rssDashboardId", exists: true, value: "a".repeat(64) },
        { key: "rssDashboardId", exists: true, value: "a".repeat(64) },
      ],
    ],
  ] as const)("rejects malformed v2 journal identity: %s", async (
    _scenario,
    previousFeed,
  ) => {
    const stableId = "a".repeat(64);
    const article = createItem({ rssDashboardId: stableId, read: true });
    const source = createFeed({
      feedId: "source-malformed-v2",
      items: [article],
    });
    const plugin = createPluginWithSettings([source]) as unknown as TestPlugin & {
      replayStatusRepairJournalIfNeeded: () => Promise<boolean>;
      saveSettings: ReturnType<typeof vi.fn>;
    };
    plugin.saveSettings = vi.fn().mockResolvedValue(undefined);
    const path = ".rss-dashboard-data/state/status-repair.json";
    await plugin.app.vault.adapter.write(path, JSON.stringify({
      version: 2,
      txId: "tx-17-malformed",
      phase: "feed-write-uncertain",
      items: [{
        feedIndex: 0,
        itemIndex: 0,
        sourceLocator: createTestSourceLocator("source-malformed-v2"),
        stableId,
        previousFeed,
      }],
    }));

    await expect(plugin.replayStatusRepairJournalIfNeeded()).resolves.toBe(false);

    expect(article.rssDashboardId).toBe(stableId);
    expect(article.read).toBe(true);
    expect(plugin.saveSettings).not.toHaveBeenCalled();
    expect(await plugin.app.vault.adapter.exists(path)).toBe(true);
  });

  it("does not position-fallback a v2 identity recorded as present", async () => {
    const stableId = "a".repeat(64);
    const article = createItem({ read: true });
    delete article.rssDashboardId;
    const source = createFeed({
      feedId: "source-present-no-fallback",
      items: [article],
    });
    const plugin = createPluginWithSettings([source]) as unknown as TestPlugin & {
      replayStatusRepairJournalIfNeeded: () => Promise<boolean>;
      saveSettings: ReturnType<typeof vi.fn>;
    };
    plugin.saveSettings = vi.fn().mockResolvedValue(undefined);
    const path = ".rss-dashboard-data/state/status-repair.json";
    await plugin.app.vault.adapter.write(path, JSON.stringify({
      version: 2,
      txId: "tx-18-present",
      phase: "feed-write-uncertain",
      items: [{
        feedIndex: 0,
        itemIndex: 0,
        sourceLocator: createTestSourceLocator("source-present-no-fallback"),
        stableId,
        previousFeed: [
          { key: "rssDashboardId", exists: true, value: stableId },
          { key: "read", exists: true, value: false },
        ],
      }],
    }));

    await expect(plugin.replayStatusRepairJournalIfNeeded()).resolves.toBe(false);

    expect(article.rssDashboardId).toBeUndefined();
    expect(article.read).toBe(true);
    expect(plugin.saveSettings).not.toHaveBeenCalled();
    expect(await plugin.app.vault.adapter.exists(path)).toBe(true);
  });

  it("replays a valid v2 present identity only through stable locator A", async () => {
    const stableId = "a".repeat(64);
    const article = createItem({ rssDashboardId: stableId, read: true });
    const source = createFeed({ feedId: "source-valid-v2", items: [article] });
    const plugin = createPluginWithSettings([source]) as unknown as TestPlugin & {
      replayStatusRepairJournalIfNeeded: () => Promise<boolean>;
      saveSettings: ReturnType<typeof vi.fn>;
    };
    plugin.saveSettings = vi.fn().mockResolvedValue(undefined);
    const path = ".rss-dashboard-data/state/status-repair.json";
    await plugin.app.vault.adapter.write(path, JSON.stringify({
      version: 2,
      txId: "tx-19-valid",
      phase: "feed-write-uncertain",
      items: [{
        feedIndex: 99,
        itemIndex: 99,
        sourceLocator: createTestSourceLocator("source-valid-v2"),
        stableId,
        previousFeed: [
          { key: "rssDashboardId", exists: true, value: stableId },
          { key: "read", exists: true, value: false },
        ],
      }],
    }));

    await expect(plugin.replayStatusRepairJournalIfNeeded()).resolves.toBe(true);

    expect(article.rssDashboardId).toBe(stableId);
    expect(article.read).toBe(false);
    expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
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
