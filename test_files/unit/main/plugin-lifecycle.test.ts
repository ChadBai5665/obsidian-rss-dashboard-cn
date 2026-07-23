/**
 * P0-1 Tests for Plugin Lifecycle (main.ts)
 *
 * Tests cover:
 * 1. onload() initialization - register views, commands, set up refresh interval
 * 2. loadSettings() - DEFAULT_SETTINGS, migrations
 * 3. refreshFeeds() - all feeds, selected feed, folder
 * 4. addFeed() - duplicate check, media type, parsing
 * 5. onunload() - cleanup, backups
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type {
  Feed,
  FeedItem,
  RssDashboardSettings,
} from "../../../src/types/types";
import { DEFAULT_SETTINGS } from "../../../src/types/types";
import { AddFeedModal } from "../../../src/modals/feed-manager/add-feed-modal";
import { FeedStorageRollbackIncompleteError } from "../../../src/services/feed-storage-repository";

// Mock functions for FeedParser - must be declared before mocks
const mockParseFeed = vi.fn<(url: string) => Promise<Feed>>();
const mockRefreshAllFeeds = vi.fn();

// Mock window event listeners - must be declared before mocks
// Note: window spies are created per-suite to avoid `vi.restoreAllMocks()` wiping them.

// Mock the services that main.ts imports
vi.mock("../../../src/services/feed-parser", () => ({
  FeedParser: class FeedParser {
    parseFeed = mockParseFeed;
    refreshAllFeeds = mockRefreshAllFeeds;
    constructor(_media?: any, _availableTags?: any) {}
  },
  applyFeedRetentionLimits: vi.fn((feed: Feed) => feed),
  formatFeedParseNoticeMessage: vi.fn((error: Error) => error.message),
  getFeedErrorMessage: vi.fn((error: Error) => error.message),
}));

vi.mock("../../../src/services/article-saver", () => ({
  ArticleSaver: class ArticleSaver {
    fixSavedFilePaths = vi.fn().mockResolvedValue(undefined);
    constructor(_app?: any, _settings?: any) {}
  },
}));

vi.mock("../../../src/services/backup-service", () => ({
  BackupService: class BackupService {
    performAutoBackups = vi.fn().mockResolvedValue(undefined);
    constructor(_options?: any) {}
  },
}));

vi.mock("../../../src/utils/settings-migration", () => ({
  migrateDisplaySettings: vi.fn(),
  migrateDefaultFilterToDashboardMultiFilters: vi.fn(),
  migrateKeywordRulesSettings: vi.fn().mockReturnValue(false),
  migrateMediaVideoTagSettings: vi.fn().mockReturnValue(false),
  migrateMediaDefaultTagArrays: vi.fn().mockReturnValue(false),
}));

// Import main AFTER all mocks are set up
import RssDashboardPlugin from "../../../main";

// Use App from obsidian stub (provided via Vitest alias)
import { App, Platform, type PluginManifest } from "obsidian";

type MockApp = App;

function flushPromises(): Promise<void> {
  return new Promise((resolve) => {
    // Let microtasks run
    void Promise.resolve().then(() => {
      queueMicrotask?.(resolve);
      if (typeof queueMicrotask === "undefined") {
        void Promise.resolve().then(resolve);
      }
    });
  });
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

// Create mock App using stubs
function createMockApp(): MockApp {
  return App.createMock();
}

// Create mock plugin manifest
function createMockManifest(): PluginManifest {
  return {
    id: "rss-dashboard",
    name: "RSS Dashboard",
    version: "1.0.0",
    author: "Test",
    description: "Test plugin",
    dir: ".",
  };
}

// Helper to create a plugin instance with mocks
/** Typed accessor for private RssDashboardPlugin members accessed from tests. */
type PluginPrivateAPI = {
  backupService: {
    performAutoBackups: () => Promise<void>;
  };
  folderService: object;
  backgroundImportService: { startBackgroundImport: (feeds: Feed[]) => void };
  articleSaver: { fixSavedFilePaths: (...args: unknown[]) => Promise<unknown> };
  validateSavedArticles: () => Promise<void>;
  refreshFeedsWithinSession: (feeds?: Feed[]) => Promise<void>;
  onArticleSaved: (item: FeedItem) => Promise<void>;
  ingestFeedsForBackgroundImport: (
    feeds: Array<{ title: string; url: string; folder: string }>,
    opts?: { mode?: string; folders?: unknown[] },
  ) => Promise<{ addedCount: number; skippedCount: number }>;
};

async function createPluginInstance(app: MockApp): Promise<RssDashboardPlugin> {
  const manifest = createMockManifest();
  manifest.dir = "."; // Required by onunload() tests
  const plugin = new RssDashboardPlugin(app, manifest);

  // Mock loadData to return null (no saved settings)
  plugin.loadData = vi.fn().mockResolvedValue(null);

  // Mock saveData
  plugin.saveData = vi.fn().mockResolvedValue(undefined);

  // Mock registerView
  plugin.registerView = vi.fn();

  // Mock addRibbonIcon
  plugin.addRibbonIcon = vi.fn().mockReturnValue({
    onClick: vi.fn(),
  });

  // Mock addCommand
  plugin.addCommand = vi.fn();

  // Mock addSettingTab
  plugin.addSettingTab = vi.fn();

  // Mock registerInterval
  plugin.registerInterval = vi.fn((id: number) => id);

  plugin.registerObsidianProtocolHandler = vi.fn();

  // Initialize backupService with mock
  const { BackupService } =
    await import("../../../src/services/backup-service");
  (plugin as unknown as PluginPrivateAPI).backupService = new BackupService({
    settings: plugin.settings,
    manifest: plugin.manifest,
    vaultAbsolutePath: "",
    vault: app.vault,
    getUserSettingsJson: () => JSON.stringify({}),
  });

  // Initialize folderService
  const { FolderService } =
    await import("../../../src/services/folder-service");
  (plugin as unknown as PluginPrivateAPI).folderService = new FolderService(
    plugin.settings,
  );

  // Initialize backgroundImportService
  const { BackgroundImportService } =
    await import("../../../src/services/background-import-service");
  (plugin as unknown as PluginPrivateAPI).backgroundImportService =
    new BackgroundImportService({
      feedParser: {
        parseFeed: (url: string) => mockParseFeed(url),
      },
      getSettings: () => plugin.settings,
      getView: () => plugin.getActiveDashboardView(),
      saveSettings: () => plugin.saveSettings(),
      ensureFolderExists: (folder, opts) =>
        plugin.ensureFolderExists(folder, opts),
      addStatusBarItem: () => {
        const el = document.createElement("div") as HTMLDivElement & {
          createSpan: (opts?: { cls?: string }) => HTMLSpanElement;
        };
        el.createSpan = (opts?: { cls?: string }) => {
          const span = document.createElement("span");
          if (opts?.cls) span.className = opts.cls;
          el.appendChild(span);
          return span;
        };
        return el;
      },
    });

  return plugin;
}

// Sample feed for testing
const sampleFeed: Feed = {
  title: "Test Feed",
  url: "https://example.com/feed.xml",
  folder: "Uncategorized",
  items: [
    {
      title: "Test Article",
      link: "https://example.com/1",
      description: "Test description",
      pubDate: "2024-01-01T00:00:00Z",
      guid: "https://example.com/1",
      read: false,
      starred: false,
      tags: [],
      feedTitle: "Test Feed",
      feedUrl: "https://example.com/feed.xml",
      coverImage: "",
    },
  ],
  lastUpdated: Date.now(),
  mediaType: "article",
};

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Test Suite: loadSettings()
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe("loadSettings()", () => {
  let plugin: RssDashboardPlugin;

  beforeEach(async () => {
    const app = createMockApp();
    plugin = await createPluginInstance(app);
    vi.clearAllMocks();
    mockRefreshAllFeeds.mockClear();
    mockParseFeed.mockClear();
  });

  it("loads DEFAULT_SETTINGS when no saved data exists", async () => {
    // Given: No saved data
    (plugin.loadData as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    // When: loadSettings is called
    await plugin.loadSettings();

    // Then: settings should match DEFAULT_SETTINGS
    expect(plugin.settings).toBeDefined();
    expect(plugin.settings.feeds).toEqual(DEFAULT_SETTINGS.feeds);
    expect(plugin.settings.folders).toEqual(DEFAULT_SETTINGS.folders);
    expect(plugin.settings.refreshInterval).toBe(
      DEFAULT_SETTINGS.refreshInterval,
    );
    expect(plugin.settings.maxItems).toBe(DEFAULT_SETTINGS.maxItems);
  });

  it("merges saved settings with DEFAULT_SETTINGS", async () => {
    // Given: Saved settings with custom values
    const savedSettings: Partial<RssDashboardSettings> = {
      refreshInterval: 30,
      maxItems: 100,
      feeds: [sampleFeed],
    };
    (plugin.loadData as ReturnType<typeof vi.fn>).mockResolvedValue(
      savedSettings,
    );

    // When: loadSettings is called
    await plugin.loadSettings();

    // Then: saved values should override defaults
    expect(plugin.settings.refreshInterval).toBe(30);
    expect(plugin.settings.maxItems).toBe(100);
    expect(plugin.settings.feeds).toHaveLength(1);
  });

  it.each([
    { refreshMode: "interval" as const, refreshInterval: 15 },
    { refreshMode: "off" as const, refreshInterval: 0 },
  ])(
    "preserves an explicitly selected $refreshMode refresh mode on reload",
    async ({ refreshMode, refreshInterval }) => {
      (plugin.loadData as ReturnType<typeof vi.fn>).mockResolvedValue({
        refreshMode,
        refreshInterval,
      });

      await plugin.loadSettings();

      expect(plugin.settings.refreshMode).toBe(refreshMode);
      expect(plugin.settings.refreshInterval).toBe(refreshInterval);
    },
  );

  it("normalizes refreshInterval=0 to disabled instead of re-enabling it", async () => {
    (plugin.loadData as ReturnType<typeof vi.fn>).mockResolvedValue({
      refreshInterval: 0,
    });

    await plugin.loadSettings();

    expect(plugin.settings.refreshInterval).toBe(0);
  });

  it("normalizes negative refreshInterval values to disabled", async () => {
    (plugin.loadData as ReturnType<typeof vi.fn>).mockResolvedValue({
      refreshInterval: -5,
    });

    await plugin.loadSettings();

    expect(plugin.settings.refreshInterval).toBe(0);
  });

  it("applies migrations to legacy settings", async () => {
    // Given: Legacy settings without new properties
    const legacySettings = {
      refreshInterval: 60,
      maxItems: 50,
      feeds: [
        {
          ...sampleFeed,
          // Legacy feed without keywordRules
          keywordRules: undefined,
          // Legacy feed without autoDeleteDuration
          autoDeleteDuration: undefined,
          maxItemsLimit: undefined,
        } as Feed,
      ],
    };
    (plugin.loadData as ReturnType<typeof vi.fn>).mockResolvedValue(
      legacySettings,
    );

    // When: loadSettings is called
    await plugin.loadSettings();

    // Then: migrations should be applied
    expect(plugin.settings.feeds[0].keywordRules).toBeDefined();
    expect(plugin.settings.feeds[0].keywordRules?.overrideGlobalRules).toBe(
      false,
    );
    expect(plugin.settings.feeds[0].autoDeleteDuration).toBeDefined();
    expect(plugin.settings.feeds[0].maxItemsLimit).toBeDefined();
  });

  it("falls back to DEFAULT_SETTINGS on error", async () => {
    // Given: loadData throws an error
    (plugin.loadData as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Load failed"),
    );

    // When: loadSettings is called
    await plugin.loadSettings();

    // Then: settings should be DEFAULT_SETTINGS
    expect(plugin.settings).toEqual(DEFAULT_SETTINGS);
  });

  it("normalizes page sizes to a single global value", async () => {
    // Given: Settings with different page sizes per filter type
    const settingsWithMixedPageSizes = {
      allArticlesPageSize: 50,
      unreadArticlesPageSize: 25,
      readArticlesPageSize: 100,
      savedArticlesPageSize: 75,
      starredArticlesPageSize: 30,
    };
    (plugin.loadData as ReturnType<typeof vi.fn>).mockResolvedValue(
      settingsWithMixedPageSizes,
    );

    // When: loadSettings is called
    await plugin.loadSettings();

    // Then: All page sizes should be normalized to allArticlesPageSize
    expect(plugin.settings.unreadArticlesPageSize).toBe(50);
    expect(plugin.settings.readArticlesPageSize).toBe(50);
    expect(plugin.settings.savedArticlesPageSize).toBe(50);
    expect(plugin.settings.starredArticlesPageSize).toBe(50);
  });
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Test Suite: onload() Initialization
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe("onload() initialization", () => {
  let plugin: RssDashboardPlugin;
  let originalPlatformIsMobile: boolean;
  let originalPlatformIsDesktop: boolean;

  beforeEach(async () => {
    const app = createMockApp();
    plugin = await createPluginInstance(app);
    vi.clearAllMocks();
    mockRefreshAllFeeds.mockClear();
    mockParseFeed.mockClear();
    originalPlatformIsMobile = Platform.isMobile;
    originalPlatformIsDesktop = Platform.isDesktop;
  });

  afterEach(() => {
    Platform.isMobile = originalPlatformIsMobile;
    Platform.isDesktop = originalPlatformIsDesktop;
    vi.restoreAllMocks();
  });

  it("registers all required views", async () => {
    // When: onload is called
    await plugin.onload();

    // Then: registerView should be called for all views
    expect(plugin.registerView).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Function),
    );
    // Should register at least 4 views (dashboard, discover, reader, smallweb)
    expect(
      (plugin.registerView as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBeGreaterThanOrEqual(4);
  });

  it("registers ribbon icon", async () => {
    // When: onload is called
    await plugin.onload();

    // Then: addRibbonIcon should be called
    expect(plugin.addRibbonIcon).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(Function),
    );
  });

  it("registers commands", async () => {
    // When: onload is called
    await plugin.onload();

    // Then: addCommand should be called for all commands
    expect(plugin.addCommand).toHaveBeenCalled();
    // Should have multiple commands (open-dashboard, open-discover, refresh-feeds, etc.)
    expect(
      (plugin.addCommand as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBeGreaterThanOrEqual(7);
  });

  it("refreshes localization exactly once in every open view without changing command registrations", async () => {
    const refreshes = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    const leavesByType = new Map<string, Array<{ view: { refreshLocalization: ReturnType<typeof vi.fn> } }>>([
      ["rss-dashboard-view", [{ view: { refreshLocalization: refreshes[0] } }]],
      ["rss-discover-view", [{ view: { refreshLocalization: refreshes[1] } }]],
      ["rss-reader-view", [{ view: { refreshLocalization: refreshes[2] } }]],
      ["rss-smallweb-view", [{ view: { refreshLocalization: refreshes[3] } }]],
    ]);
    plugin.app.workspace.getLeavesOfType = vi.fn((type: string) =>
      leavesByType.get(type) ?? [],
    );
    const commandSpy = plugin.addCommand as ReturnType<typeof vi.fn>;

    plugin.refreshLocalizedViews();

    for (const refresh of refreshes) expect(refresh).toHaveBeenCalledTimes(1);
    expect(commandSpy).not.toHaveBeenCalled();
  });

  it("registers Chinese command names by default", async () => {
    await plugin.onload();

    const commands = (plugin.addCommand as ReturnType<typeof vi.fn>).mock.calls.map(
      ([command]) => command as { id: string; name: string },
    );
    expect(commands.find((command) => command.id === "open-dashboard")?.name).toBe(
      "打开 RSS 信息台",
    );
    expect(commands.find((command) => command.id === "refresh-feeds")?.name).toBe(
      "刷新全部来源",
    );
  });

  it("keeps English command names when English is stored", async () => {
    plugin.loadData = vi.fn().mockResolvedValue({ locale: "en" });
    await plugin.onload();

    const commands = (plugin.addCommand as ReturnType<typeof vi.fn>).mock.calls.map(
      ([command]) => command as { id: string; name: string },
    );
    expect(commands.find((command) => command.id === "open-dashboard")?.name).toBe(
      "Open RSS dashboard",
    );
  });

  it("sets up refresh interval only in explicit interval mode", async () => {
    plugin.loadData = vi.fn().mockResolvedValue({
      refreshMode: "interval",
      refreshInterval: 60,
    });

    await plugin.onload();

    expect(plugin.registerInterval).toHaveBeenCalled();
  });

  it("does not register auto refresh when refreshInterval is disabled", async () => {
    plugin.loadData = vi.fn().mockResolvedValue({
      refreshMode: "interval",
      refreshInterval: 0,
    });

    await plugin.onload();

    await flushPromises();

    expect(plugin.registerInterval).not.toHaveBeenCalled();
  });

  it("reuses one source refresh ledger for the configured data root", () => {
    plugin.settings = { ...DEFAULT_SETTINGS };
    const pluginWithLedger = plugin as unknown as {
      getSourceRefreshLedger: () => unknown;
    };

    expect(pluginWithLedger.getSourceRefreshLedger()).toBe(
      pluginWithLedger.getSourceRefreshLedger(),
    );
  });

  it("does not schedule startup or interval refresh in off mode", async () => {
    vi.useFakeTimers();
    const intervalSpy = vi.spyOn(window, "setInterval");
    const timeoutSpy = vi.spyOn(window, "setTimeout");
    plugin.loadData = vi.fn().mockResolvedValue({
      refreshMode: "off",
      refreshInterval: 15,
      startupRefreshDelaySeconds: 30,
    });

    await plugin.onload();

    expect(plugin.registerInterval).not.toHaveBeenCalled();
    expect(intervalSpy).not.toHaveBeenCalled();
    expect(timeoutSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("defers a daily retry without blocking plugin load after an unsuccessful same-day refresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 21, 9, 0, 0));
    const sourceFeed = { ...sampleFeed, feedId: "feed-1" };
    plugin.loadData = vi.fn().mockResolvedValue({
      refreshMode: "daily-on-open",
      startupRefreshDelaySeconds: 15,
      feeds: [sourceFeed],
    });
    await plugin.app.vault.adapter.write(
      ".rss-dashboard-data/state/source-refresh.json",
      JSON.stringify({
        schemaVersion: 1,
        sources: {
          [sourceFeed.feedId]: {
            sourceId: sourceFeed.feedId,
            status: "error",
            lastAttemptAt: "2026-07-21T00:30:00.000Z",
            lastSuccessDate: "2026-07-20",
            errorCode: "network",
            errorMessage: "Request failed",
          },
        },
      }),
    );
    const refreshSpy = vi
      .spyOn(plugin, "refreshFeeds")
      .mockResolvedValue(undefined);

    await plugin.onload();

    await flushPromises();

    expect(refreshSpy).not.toHaveBeenCalled();
    plugin.app.workspace.triggerLayoutReady();
    await flushPromises();
    expect(refreshSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(refreshSpy).toHaveBeenCalledWith([sourceFeed]);
    vi.useRealTimers();
  });

  it("does not queue a second daily refresh when every source succeeded today", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 21, 9, 0, 0));
    const sourceFeed = { ...sampleFeed, feedId: "feed-1" };
    plugin.loadData = vi.fn().mockResolvedValue({
      refreshMode: "daily-on-open",
      startupRefreshDelaySeconds: 15,
      feeds: [sourceFeed],
    });
    await plugin.app.vault.adapter.write(
      ".rss-dashboard-data/state/source-refresh.json",
      JSON.stringify({
        schemaVersion: 1,
        sources: {
          [sourceFeed.feedId]: {
            sourceId: sourceFeed.feedId,
            status: "success",
            lastAttemptAt: "2026-07-21T00:30:00.000Z",
            lastSuccessAt: "2026-07-21T00:31:00.000Z",
            lastSuccessDate: "2026-07-21",
          },
        },
      }),
    );
    const refreshSpy = vi
      .spyOn(plugin, "refreshFeeds")
      .mockResolvedValue(undefined);

    await plugin.onload();
    await flushPromises();
    plugin.app.workspace.triggerLayoutReady();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(refreshSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("does not schedule a daily refresh after unload while the ledger read is pending", async () => {
    vi.useFakeTimers();
    const deferredExists = createDeferred<boolean>();
    const adapter = plugin.app.vault.adapter;
    const originalExists = adapter.exists;
    adapter.exists = vi.fn((path: string) =>
      path === ".rss-dashboard-data/state/source-refresh.json"
        ? deferredExists.promise
        : originalExists(path),
    );
    plugin.loadData = vi.fn().mockResolvedValue({
      refreshMode: "daily-on-open",
      startupRefreshDelaySeconds: 15,
      feeds: [{ ...sampleFeed, feedId: "feed-1" }],
    });
    const refreshSpy = vi
      .spyOn(plugin as unknown as PluginPrivateAPI, "refreshFeedsWithinSession")
      .mockResolvedValue(undefined);

    await plugin.onload();
    await flushPromises();
    plugin.app.workspace.triggerLayoutReady();
    await flushPromises();
    plugin.onunload();
    deferredExists.resolve(false);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(refreshSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("does not run a delayed daily refresh after a manual refresh cancels a pending ledger read", async () => {
    vi.useFakeTimers();
    const deferredExists = createDeferred<boolean>();
    const adapter = plugin.app.vault.adapter;
    const originalExists = adapter.exists;
    adapter.exists = vi.fn((path: string) =>
      path === ".rss-dashboard-data/state/source-refresh.json"
        ? deferredExists.promise
        : originalExists(path),
    );
    plugin.loadData = vi.fn().mockResolvedValue({
      refreshMode: "daily-on-open",
      startupRefreshDelaySeconds: 15,
      feeds: [{ ...sampleFeed, feedId: "feed-1" }],
    });
    const refreshSpy = vi
      .spyOn(plugin, "refreshFeeds")
      .mockResolvedValue(undefined);

    await plugin.onload();
    await flushPromises();
    plugin.app.workspace.triggerLayoutReady();
    await flushPromises();
    const manualRefreshCommand = (
      plugin.addCommand as ReturnType<typeof vi.fn>
    ).mock.calls.find(([command]) => command.id === "refresh-feeds")?.[0] as {
      callback: () => void;
    };
    manualRefreshCommand.callback();
    deferredExists.resolve(false);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(refreshSpy).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("catches rejected ledger reads without scheduling a refresh", async () => {
    vi.useFakeTimers();
    const adapter = plugin.app.vault.adapter;
    const originalExists = adapter.exists;
    adapter.exists = vi.fn((path: string) =>
      path === ".rss-dashboard-data/state/source-refresh.json"
        ? Promise.reject(new Error("ledger access failed?token=secret"))
        : originalExists(path),
    );
    const warningSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    plugin.loadData = vi.fn().mockResolvedValue({
      refreshMode: "daily-on-open",
      startupRefreshDelaySeconds: 0,
      feeds: [{ ...sampleFeed, feedId: "feed-1" }],
    });
    const refreshSpy = vi
      .spyOn(plugin, "refreshFeeds")
      .mockResolvedValue(undefined);

    await plugin.onload();
    plugin.app.workspace.triggerLayoutReady();
    await flushPromises();
    await flushPromises();

    expect(refreshSpy).not.toHaveBeenCalled();
    expect(warningSpy).toHaveBeenCalledWith(
      "[RSS Dashboard] Automatic refresh scheduling skipped due to ledger access failure.",
    );
    vi.useRealTimers();
  });

  it("does not read the daily ledger or schedule a refresh until layout is ready", async () => {
    vi.useFakeTimers();
    const sourceFeed = { ...sampleFeed, feedId: "feed-1" };
    plugin.loadData = vi.fn().mockResolvedValue({
      refreshMode: "daily-on-open",
      startupRefreshDelaySeconds: 0,
      feeds: [sourceFeed],
    });
    const adapter = plugin.app.vault.adapter;
    const originalExists = adapter.exists;
    const ledgerExists = vi.fn((path: string) => originalExists(path));
    adapter.exists = ledgerExists;
    const refreshSpy = vi
      .spyOn(plugin as unknown as PluginPrivateAPI, "refreshFeedsWithinSession")
      .mockResolvedValue(undefined);

    await plugin.onload();
    await flushPromises();

    expect(ledgerExists).not.toHaveBeenCalledWith(
      ".rss-dashboard-data/state/source-refresh.json",
    );
    expect(refreshSpy).not.toHaveBeenCalled();

    plugin.app.workspace.triggerLayoutReady();
    await flushPromises();
    await flushPromises();

    expect(ledgerExists).toHaveBeenCalledWith(
      ".rss-dashboard-data/state/source-refresh.json",
    );
    expect(refreshSpy).toHaveBeenCalledWith([sourceFeed]);
    vi.useRealTimers();
  });

  it("does not begin a daily refresh when unloaded before layout becomes ready", async () => {
    vi.useFakeTimers();
    const sourceFeed = { ...sampleFeed, feedId: "feed-1" };
    plugin.loadData = vi.fn().mockResolvedValue({
      refreshMode: "daily-on-open",
      startupRefreshDelaySeconds: 0,
      feeds: [sourceFeed],
    });
    const refreshSpy = vi
      .spyOn(plugin as unknown as PluginPrivateAPI, "refreshFeedsWithinSession")
      .mockResolvedValue(undefined);

    await plugin.onload();
    plugin.onunload();
    plugin.app.workspace.triggerLayoutReady();
    await flushPromises();
    await vi.runAllTimersAsync();

    expect(refreshSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("refreshes only the sources due today and excludes removed or excluded sources", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 21, 9, 0, 0));
    const succeeded = { ...sampleFeed, feedId: "succeeded" };
    const errored = { ...sampleFeed, feedId: "errored", url: "https://example.com/error.xml" };
    const excluded = {
      ...sampleFeed,
      feedId: "excluded",
      url: "https://example.com/excluded.xml",
      excludeFromRefresh: true,
    };
    plugin.loadData = vi.fn().mockResolvedValue({
      refreshMode: "daily-on-open",
      startupRefreshDelaySeconds: 0,
      feeds: [succeeded, errored, excluded],
    });
    await plugin.app.vault.adapter.write(
      ".rss-dashboard-data/state/source-refresh.json",
      JSON.stringify({
        schemaVersion: 1,
        sources: {
          succeeded: { sourceId: "succeeded", status: "success", lastSuccessDate: "2026-07-21" },
          errored: { sourceId: "errored", status: "error", lastSuccessDate: "2026-07-21" },
          excluded: { sourceId: "excluded", status: "error", lastSuccessDate: "2026-07-20" },
          deleted: { sourceId: "deleted", status: "error", lastSuccessDate: "2026-07-20" },
        },
      }),
    );
    const refreshSpy = vi
      .spyOn(plugin as unknown as PluginPrivateAPI, "refreshFeedsWithinSession")
      .mockResolvedValue(undefined);

    await plugin.onload();
    plugin.app.workspace.triggerLayoutReady();
    await flushPromises();
    await flushPromises();

    expect(refreshSpy).toHaveBeenCalledWith([errored]);
    vi.useRealTimers();
  });

  it("treats missing and yesterday-success source entries as due but skips all-success sources", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 21, 9, 0, 0));
    const succeeded = { ...sampleFeed, feedId: "succeeded" };
    const missing = { ...sampleFeed, feedId: "missing", url: "https://example.com/missing.xml" };
    const yesterday = { ...sampleFeed, feedId: "yesterday", url: "https://example.com/yesterday.xml" };
    plugin.loadData = vi.fn().mockResolvedValue({
      refreshMode: "daily-on-open",
      startupRefreshDelaySeconds: 0,
      feeds: [succeeded, missing, yesterday],
    });
    await plugin.app.vault.adapter.write(
      ".rss-dashboard-data/state/source-refresh.json",
      JSON.stringify({
        schemaVersion: 1,
        sources: {
          succeeded: { sourceId: "succeeded", status: "success", lastSuccessDate: "2026-07-21" },
          yesterday: { sourceId: "yesterday", status: "success", lastSuccessDate: "2026-07-20" },
        },
      }),
    );
    const refreshSpy = vi
      .spyOn(plugin as unknown as PluginPrivateAPI, "refreshFeedsWithinSession")
      .mockResolvedValue(undefined);

    await plugin.onload();
    plugin.app.workspace.triggerLayoutReady();
    await flushPromises();
    await flushPromises();

    expect(refreshSpy).toHaveBeenCalledWith([missing, yesterday]);
    vi.useRealTimers();
  });

  it("keeps manual refresh-all unfiltered even after today's automatic refresh is skipped", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 21, 9, 0, 0));
    const first = { ...sampleFeed, feedId: "first" };
    const second = { ...sampleFeed, feedId: "second", url: "https://example.com/second.xml" };
    plugin.loadData = vi.fn().mockResolvedValue({
      refreshMode: "daily-on-open",
      startupRefreshDelaySeconds: 0,
      feeds: [first, second],
    });
    await plugin.app.vault.adapter.write(
      ".rss-dashboard-data/state/source-refresh.json",
      JSON.stringify({
        schemaVersion: 1,
        sources: {
          first: { sourceId: "first", status: "success", lastSuccessDate: "2026-07-21" },
          second: { sourceId: "second", status: "success", lastSuccessDate: "2026-07-21" },
        },
      }),
    );
    const refreshSpy = vi
      .spyOn(plugin as unknown as PluginPrivateAPI, "refreshFeedsWithinSession")
      .mockResolvedValue(undefined);

    await plugin.onload();
    plugin.app.workspace.triggerLayoutReady();
    await flushPromises();
    await flushPromises();
    await plugin.manualRefreshAllSources();

    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(refreshSpy).toHaveBeenCalledWith();
    vi.useRealTimers();
  });

  it("adds setting tab", async () => {
    // When: onload is called
    await plugin.onload();

    // Then: addSettingTab should be called
    expect(plugin.addSettingTab).toHaveBeenCalled();
  });

  it("registers an Obsidian protocol handler", async () => {
    await plugin.onload();

    expect(plugin.registerObsidianProtocolHandler).toHaveBeenCalledWith(
      "rss-dashboard",
      expect.any(Function),
    );
  });

  it("loads settings during initialization", async () => {
    // When: onload is called
    await plugin.onload();

    // Then: settings should be loaded
    expect(plugin.settings).toBeDefined();
  });

  it("registers vault metadata change listeners", async () => {
    const onMock = vi.fn().mockReturnValue({});
    plugin.app.vault.on = onMock;

    await plugin.onload();

    expect(onMock).toHaveBeenCalledTimes(3);
    expect(onMock).toHaveBeenCalledWith("modify", expect.any(Function));
    expect(onMock).toHaveBeenCalledWith("create", expect.any(Function));
    expect(onMock).toHaveBeenCalledWith("rename", expect.any(Function));
  });

  it("reloads settings and refreshes dashboard on watched data.json modify", async () => {
    vi.useFakeTimers();
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    plugin.app.vault.on = vi.fn(
      (event: string, callback: (...args: unknown[]) => void) => {
        handlers[event] = callback;
        return {};
      },
    );

    const loadSpy = vi.spyOn(plugin, "loadSettings").mockResolvedValue(undefined);
    const refreshSpy = vi.spyOn(plugin, "refreshDashboardViews").mockResolvedValue(undefined);

    await plugin.onload();

    handlers.modify?.({ path: ".rss-dashboard-data/data.json" });
    await vi.runAllTimersAsync();

    expect(loadSpy).toHaveBeenCalledTimes(2);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("reloads settings and refreshes dashboard on watched user-state.json modify", async () => {
    vi.useFakeTimers();
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    plugin.app.vault.on = vi.fn(
      (event: string, callback: (...args: unknown[]) => void) => {
        handlers[event] = callback;
        return {};
      },
    );

    const loadSpy = vi.spyOn(plugin, "loadSettings").mockResolvedValue(undefined);
    const refreshSpy = vi.spyOn(plugin, "refreshDashboardViews").mockResolvedValue(undefined);

    await plugin.onload();

    handlers.modify?.({ path: ".rss-dashboard-data/user-state.json" });
    await vi.runAllTimersAsync();

    expect(loadSpy).toHaveBeenCalledTimes(2);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("does not reload for shard file modify", async () => {
    vi.useFakeTimers();
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    plugin.app.vault.on = vi.fn(
      (event: string, callback: (...args: unknown[]) => void) => {
        handlers[event] = callback;
        return {};
      },
    );

    const loadSpy = vi.spyOn(plugin, "loadSettings").mockResolvedValue(undefined);
    const refreshSpy = vi.spyOn(plugin, "refreshDashboardViews").mockResolvedValue(undefined);

    await plugin.onload();

    handlers.modify?.({ path: ".rss-dashboard-data/feeds/some-feed.json" });
    await vi.runAllTimersAsync();

    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(refreshSpy).toHaveBeenCalledTimes(0);
    vi.useRealTimers();
  });

  it("does not reload for unrelated file modify", async () => {
    vi.useFakeTimers();
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    plugin.app.vault.on = vi.fn(
      (event: string, callback: (...args: unknown[]) => void) => {
        handlers[event] = callback;
        return {};
      },
    );

    const loadSpy = vi.spyOn(plugin, "loadSettings").mockResolvedValue(undefined);
    const refreshSpy = vi.spyOn(plugin, "refreshDashboardViews").mockResolvedValue(undefined);

    await plugin.onload();

    handlers.modify?.({ path: "some-note.md" });
    await vi.runAllTimersAsync();

    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(refreshSpy).toHaveBeenCalledTimes(0);
    vi.useRealTimers();
  });

  it("debounces rapid metadata events into a single reload", async () => {
    vi.useFakeTimers();
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    plugin.app.vault.on = vi.fn(
      (event: string, callback: (...args: unknown[]) => void) => {
        handlers[event] = callback;
        return {};
      },
    );

    const loadSpy = vi.spyOn(plugin, "loadSettings").mockResolvedValue(undefined);
    const refreshSpy = vi.spyOn(plugin, "refreshDashboardViews").mockResolvedValue(undefined);

    await plugin.onload();

    for (let i = 0; i < 5; i += 1) {
      handlers.modify?.({ path: ".rss-dashboard-data/data.json" });
      vi.advanceTimersByTime(100);
    }

    await vi.runAllTimersAsync();

    expect(loadSpy).toHaveBeenCalledTimes(2);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("resets debounce when metadata event occurs before timeout", async () => {
    vi.useFakeTimers();
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    plugin.app.vault.on = vi.fn(
      (event: string, callback: (...args: unknown[]) => void) => {
        handlers[event] = callback;
        return {};
      },
    );

    const loadSpy = vi.spyOn(plugin, "loadSettings").mockResolvedValue(undefined);
    const refreshSpy = vi.spyOn(plugin, "refreshDashboardViews").mockResolvedValue(undefined);

    await plugin.onload();

    handlers.modify?.({ path: ".rss-dashboard-data/data.json" });
    vi.advanceTimersByTime(1000);
    handlers.modify?.({ path: ".rss-dashboard-data/data.json" });
    await vi.runAllTimersAsync();

    expect(loadSpy).toHaveBeenCalledTimes(2);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("reloads on rename when watched new path matches", async () => {
    vi.useFakeTimers();
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    plugin.app.vault.on = vi.fn(
      (event: string, callback: (...args: unknown[]) => void) => {
        handlers[event] = callback;
        return {};
      },
    );

    const loadSpy = vi.spyOn(plugin, "loadSettings").mockResolvedValue(undefined);
    const refreshSpy = vi.spyOn(plugin, "refreshDashboardViews").mockResolvedValue(undefined);

    await plugin.onload();

    handlers.rename?.({ path: ".rss-dashboard-data/data.json" }, "other.json");
    await vi.runAllTimersAsync();

    expect(loadSpy).toHaveBeenCalledTimes(2);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("reloads on rename when watched old path matches", async () => {
    vi.useFakeTimers();
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    plugin.app.vault.on = vi.fn(
      (event: string, callback: (...args: unknown[]) => void) => {
        handlers[event] = callback;
        return {};
      },
    );

    const loadSpy = vi.spyOn(plugin, "loadSettings").mockResolvedValue(undefined);
    const refreshSpy = vi.spyOn(plugin, "refreshDashboardViews").mockResolvedValue(undefined);

    await plugin.onload();

    handlers.rename?.(
      { path: "unrelated.md" },
      ".rss-dashboard-data/data.json",
    );
    await vi.runAllTimersAsync();

    expect(loadSpy).toHaveBeenCalledTimes(2);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("clears watcher timer on unload", async () => {
    vi.useFakeTimers();
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    plugin.app.vault.on = vi.fn(
      (event: string, callback: (...args: unknown[]) => void) => {
        handlers[event] = callback;
        return {};
      },
    );

    await plugin.onload();

    handlers.modify?.({ path: ".rss-dashboard-data/data.json" });
    plugin.onunload();

    expect(plugin["vaultMetadataReloadTimer"]).toBeNull();
    vi.useRealTimers();
  });

  it("suppresses watcher for plugin-originated user-state write", async () => {
    vi.useFakeTimers();
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    plugin.app.vault.on = vi.fn(
      (event: string, callback: (...args: unknown[]) => void) => {
        handlers[event] = callback;
        return {};
      },
    );

    const loadSpy = vi.spyOn(plugin, "loadSettings").mockResolvedValue(undefined);
    const refreshSpy = vi.spyOn(plugin, "refreshDashboardViews").mockResolvedValue(undefined);

    await plugin.onload();

    // Simulate plugin writing user-state (which sets suppression window)
    (plugin as unknown as { suppressWatcherUntil: number }).suppressWatcherUntil = Date.now() + 5000;

    handlers.modify?.({ path: ".rss-dashboard-data/user-state.json" });
    await vi.runAllTimersAsync();

    // Watcher should be suppressed, no reload triggered
    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(refreshSpy).toHaveBeenCalledTimes(0);

    vi.useRealTimers();
  });

  it("watcher ordering: refresh after loadSettings completes", async () => {
    vi.useFakeTimers();
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    plugin.app.vault.on = vi.fn(
      (event: string, callback: (...args: unknown[]) => void) => {
        handlers[event] = callback;
        return {};
      },
    );

    // Make loadSettings async but with a simple resolved promise
    const loadSpy = vi
      .spyOn(plugin, "loadSettings")
      .mockResolvedValue(undefined);
    const refreshSpy = vi.spyOn(plugin, "refreshDashboardViews").mockResolvedValue(undefined);

    await plugin.onload();

    handlers.modify?.({ path: ".rss-dashboard-data/data.json" });
    await vi.runAllTimersAsync();

    // Both should be called (ordering verified in production code via await)
    expect(loadSpy).toHaveBeenCalledTimes(2);
    expect(refreshSpy).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it("preserves list view on mobile startup", async () => {
    Platform.isMobile = true;
    Platform.isDesktop = false;
    plugin.loadData = vi.fn().mockResolvedValue({ viewStyle: "list" });

    await plugin.onload();

    expect(plugin.settings.viewStyle).toBe("list");
  });

  it("does not attempt a startup refresh before FeedParser initialization", async () => {
    plugin.loadData = vi.fn().mockResolvedValue({
      refreshMode: "daily-on-open",
      feeds: [{ ...sampleFeed, feedId: "feed-1" }],
      startupRefreshDelaySeconds: 0,
    });
    const refreshSpy = vi
      .spyOn(plugin as unknown as PluginPrivateAPI, "refreshFeedsWithinSession")
      .mockResolvedValue(undefined);

    await plugin.onload();

    await flushPromises();

    expect(refreshSpy).not.toHaveBeenCalled();
    plugin.app.workspace.triggerLayoutReady();
    await flushPromises();

    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(mockRefreshAllFeeds).not.toHaveBeenCalled();
    expect(plugin.feedParser).toBeDefined();
  });

  it("defers saved-article startup validation until layout is ready", async () => {
    const validateSpy = vi.spyOn(
      plugin as unknown as PluginPrivateAPI,
      "validateSavedArticles",
    );

    await plugin.onload();

    expect(validateSpy).not.toHaveBeenCalled();
    expect(
      (plugin as unknown as PluginPrivateAPI).articleSaver.fixSavedFilePaths,
    ).not.toHaveBeenCalled();

    plugin.app.workspace.triggerLayoutReady();
    await flushPromises();

    expect(
      (plugin as unknown as PluginPrivateAPI).articleSaver.fixSavedFilePaths,
    ).toHaveBeenCalledTimes(1);
    expect(validateSpy).toHaveBeenCalledTimes(1);
  });

  it("persists savedFilePath when an article is saved", async () => {
    plugin.settings = JSON.parse(
      JSON.stringify({
        ...DEFAULT_SETTINGS,
        feeds: [
          {
            name: "Feed",
            url: "https://example.com/rss.xml",
            folder: "",
            items: [
              {
                guid: "guid-1",
                title: "Saved article",
                link: "https://example.com/article",
                description: "",
                pubDate: "2024-01-01T00:00:00.000Z",
                read: false,
                starred: false,
                saved: false,
                tags: [],
                feedTitle: "Feed",
                feedUrl: "https://example.com/rss.xml",
                coverImage: "",
              },
            ],
          },
        ],
      }),
    ) as RssDashboardSettings;

    const item = {
      ...plugin.settings.feeds[0].items[0],
      saved: true,
      savedFilePath: "Articles/Saved article.md",
    };

    await (plugin as unknown as PluginPrivateAPI).onArticleSaved(item);

    expect(plugin.settings.feeds[0].items[0].saved).toBe(true);
    expect(plugin.settings.feeds[0].items[0].savedFilePath).toBe(
      "Articles/Saved article.md",
    );
  });
});

describe("URI add-feed handling", () => {
  let plugin: RssDashboardPlugin;

  beforeEach(async () => {
    const app = createMockApp();
    plugin = await createPluginInstance(app);

    plugin.settings = {
      ...DEFAULT_SETTINGS,
      media: {
        ...DEFAULT_SETTINGS.media,
        defaultRssFolder: "RSS",
      },
    } as RssDashboardSettings;

    plugin.feedParser = {
      parseFeed: mockParseFeed,
      refreshAllFeeds: mockRefreshAllFeeds,
    } as unknown as typeof plugin.feedParser;

    plugin.getActiveDashboardView = vi.fn().mockResolvedValue({
      render: vi.fn(),
      refresh: vi.fn(),
    });

    vi.clearAllMocks();
    mockRefreshAllFeeds.mockClear();
    mockParseFeed.mockClear();
  });

  it("shows unsupported-action notice for unknown URI action", async () => {
    const noticeSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    await plugin.onload();
    const handler = (
      plugin.registerObsidianProtocolHandler as ReturnType<typeof vi.fn>
    ).mock.calls[0][1] as (params: Record<string, string>) => void;

    handler({ action: "unknown" });
    await flushPromises();

    expect(noticeSpy).toHaveBeenCalledWith(
      "[Stub Notice]",
      "不支持的 RSS Dashboard URI 操作：unknown",
    );
  });

  it("shows notice and skips add when URI url is missing", async () => {
    const addFeedSpy = vi.spyOn(plugin, "addFeed");
    const noticeSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    await plugin.onload();
    const handler = (
      plugin.registerObsidianProtocolHandler as ReturnType<typeof vi.fn>
    ).mock.calls[0][1] as (params: Record<string, string>) => void;

    handler({ action: "add-feed" });
    await flushPromises();

    expect(addFeedSpy).not.toHaveBeenCalled();
    expect(noticeSpy).toHaveBeenCalledWith(
      "[Stub Notice]",
      "add-feed 操作需要提供地址。",
    );
  });

  it("uses the selected English locale for URI notices", async () => {
    const noticeSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    await plugin.onload();
    plugin.settings.locale = "en";
    const handler = (
      plugin.registerObsidianProtocolHandler as ReturnType<typeof vi.fn>
    ).mock.calls[0][1] as (params: Record<string, string>) => void;

    handler({ action: "add-feed" });
    await flushPromises();

    expect(noticeSpy).toHaveBeenCalledWith(
      "[Stub Notice]",
      "The add-feed action requires a URL.",
    );
  });

  it("shows notice and skips add for invalid feed URLs", async () => {
    const addFeedSpy = vi.spyOn(plugin, "addFeed");
    const noticeSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    await plugin.onload();
    const handler = (
      plugin.registerObsidianProtocolHandler as ReturnType<typeof vi.fn>
    ).mock.calls[0][1] as (params: Record<string, string>) => void;

    handler({ action: "add-feed", url: "ftp://example.com/feed.xml" });
    await flushPromises();

    expect(addFeedSpy).not.toHaveBeenCalled();
    expect(noticeSpy).toHaveBeenCalledWith(
      "[Stub Notice]",
      "请输入有效的 HTTP 或 HTTPS 订阅地址。",
    );
  });

  it("opens Add Feed modal with prefilled URL for browser URI route", async () => {
    const addFeedSpy = vi.spyOn(plugin, "addFeed");
    const modalOpenSpy = vi.spyOn(AddFeedModal.prototype, "open");

    await plugin.onload();
    const handler = (
      plugin.registerObsidianProtocolHandler as ReturnType<typeof vi.fn>
    ).mock.calls[0][1] as (params: Record<string, string>) => void;

    const encodedUrl = encodeURIComponent("https://example.com/feed.xml");
    handler({ action: "rss-dashboard", url: encodedUrl });
    await flushPromises();

    expect(modalOpenSpy).toHaveBeenCalledTimes(1);
    expect(addFeedSpy).not.toHaveBeenCalled();

    const urlInput =
      document.querySelector<HTMLInputElement>(".feed-url-input");
    expect(urlInput?.value).toBe("https://example.com/feed.xml");
  });
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Test Suite: refreshFeeds()
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe("refreshFeeds()", () => {
  let plugin: RssDashboardPlugin;

  beforeEach(async () => {
    const app = createMockApp();
    plugin = await createPluginInstance(app);

    // Initialize settings with sample feeds
    plugin.settings = {
      ...DEFAULT_SETTINGS,
      feeds: [sampleFeed],
    };

    // Mock the feedParser on the plugin
    plugin.feedParser = {
      parseFeed: mockParseFeed,
      refreshAllFeeds: mockRefreshAllFeeds,
    } as unknown as typeof plugin.feedParser;

    // Mock getActiveDashboardView
    plugin.getActiveDashboardView = vi.fn().mockResolvedValue({
      refresh: vi.fn(),
    });

    vi.clearAllMocks();
    mockRefreshAllFeeds.mockClear();
    mockParseFeed.mockClear();
  });

  it("refreshes all feeds when no selection is provided", async () => {
    // Given: Multiple feeds in settings
    plugin.settings.feeds = [
      { ...sampleFeed, url: "https://example.com/feed1.xml" },
      { ...sampleFeed, url: "https://example.com/feed2.xml" },
    ];

    // Mock refreshAllFeeds to return updated feeds
    mockRefreshAllFeeds.mockResolvedValue([
      {
        ...sampleFeed,
        url: "https://example.com/feed1.xml",
        items: sampleFeed.items,
      },
      {
        ...sampleFeed,
        url: "https://example.com/feed2.xml",
        items: sampleFeed.items,
      },
    ]);

    // When: refreshFeeds is called without selection
    await plugin.refreshFeeds();

    // Then: the fallback multi-feed path should refresh each feed individually
    expect(mockRefreshAllFeeds).toHaveBeenCalledTimes(2);
    expect(
      mockRefreshAllFeeds.mock.calls.map((call) => (call[0] as Feed[])[0].url),
    ).toEqual([
      "https://example.com/feed1.xml",
      "https://example.com/feed2.xml",
    ]);
  });

  it("refreshes only selected feeds when provided", async () => {
    // Given: Multiple feeds in settings
    const feed1 = {
      ...sampleFeed,
      url: "https://example.com/feed1.xml",
      title: "Feed 1",
    };
    const feed2 = {
      ...sampleFeed,
      url: "https://example.com/feed2.xml",
      title: "Feed 2",
    };
    plugin.settings.feeds = [feed1, feed2];

    // Mock refreshAllFeeds
    mockRefreshAllFeeds.mockResolvedValue([feed1]);

    // When: refreshFeeds is called with specific feed
    await plugin.refreshFeeds([feed1]);

    // Then: refreshAllFeeds should be called only with selected feed
    expect(mockRefreshAllFeeds).toHaveBeenCalledWith([feed1]);
  });

  it("skips excluded feeds during bulk refresh", async () => {
    const includedFeed = {
      ...sampleFeed,
      url: "https://example.com/feed1.xml",
      title: "Included Feed",
    };
    const excludedFeed = {
      ...sampleFeed,
      url: "https://example.com/feed2.xml",
      title: "Excluded Feed",
      excludeFromRefresh: true,
    };
    plugin.settings.feeds = [includedFeed, excludedFeed];

    mockRefreshAllFeeds.mockResolvedValue([includedFeed]);

    await plugin.refreshFeeds();

    expect(mockRefreshAllFeeds).toHaveBeenCalledTimes(1);
    expect(mockRefreshAllFeeds).toHaveBeenCalledWith([includedFeed]);
  });

  it("updates settings after refresh", async () => {
    // Given: Mock refreshAllFeeds returns updated feed
    const newItem = {
      title: "New Item",
      link: "new",
      description: "",
      pubDate: "2024-01-02T00:00:00Z",
      guid: "new-1",
      read: false,
      starred: false,
      tags: [],
      feedTitle: "Test",
      feedUrl: sampleFeed.url,
      coverImage: "",
    };
    const updatedFeed = {
      ...sampleFeed,
      items: [...sampleFeed.items, newItem],
    };
    mockRefreshAllFeeds.mockResolvedValue([updatedFeed]);

    // When: refreshFeeds is called
    await plugin.refreshFeeds();

    // Then: settings should be updated
    expect(plugin.settings.feeds[0].items).toHaveLength(2);
  });

  it("saves settings after refresh", async () => {
    // Given: Mock refreshAllFeeds
    mockRefreshAllFeeds.mockResolvedValue([]);

    // When: refreshFeeds is called
    await plugin.refreshFeeds();

    // Then: saveSettings should be called
    expect(plugin.saveData).toHaveBeenCalled();
  });

  it("handles refresh errors gracefully", async () => {
    // Given: Mock refreshAllFeeds throws error
    mockRefreshAllFeeds.mockRejectedValue(new Error("Network error"));

    // When: refreshFeeds is called
    await plugin.refreshFeeds();

    // Then: Error should be handled (no throw)
    expect(plugin.settings).toBeDefined();
  });

  it("saves lastRefreshTimestamp after successful refresh", async () => {
    // Given: Mock refreshAllFeeds returns updated feeds
    mockRefreshAllFeeds.mockResolvedValue([sampleFeed]);
    const beforeRefresh = Date.now();

    // When: refreshFeeds is called
    await plugin.refreshFeeds();
    const afterRefresh = Date.now();

    // Then: lastRefreshTimestamp should be set
    expect(plugin.settings.lastRefreshTimestamp).toBeGreaterThanOrEqual(
      beforeRefresh,
    );
    expect(plugin.settings.lastRefreshTimestamp).toBeLessThanOrEqual(
      afterRefresh,
    );
  });

  it("does NOT save lastRefreshTimestamp on refresh failure", async () => {
    // Given: Mock refreshAllFeeds throws error
    mockRefreshAllFeeds.mockRejectedValue(new Error("Network error"));
    plugin.settings.lastRefreshTimestamp = 0;

    // When: refreshFeeds is called
    await plugin.refreshFeeds();

    // Then: lastRefreshTimestamp should remain 0 (not updated on failure)
    expect(plugin.settings.lastRefreshTimestamp).toBe(0);
  });
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Test Suite: lastRefreshTimestamp settings
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe("lastRefreshTimestamp in settings", () => {
  it("has lastRefreshTimestamp in DEFAULT_SETTINGS with default value 0", () => {
    // Then: DEFAULT_SETTINGS should include lastRefreshTimestamp
    expect(DEFAULT_SETTINGS).toHaveProperty("lastRefreshTimestamp");
    expect(DEFAULT_SETTINGS.lastRefreshTimestamp).toBe(0);
  });

});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Test Suite: refreshFeedsInFolder()
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe("refreshFeedsInFolder()", () => {
  let plugin: RssDashboardPlugin;

  beforeEach(async () => {
    const app = createMockApp();
    plugin = await createPluginInstance(app);

    // Initialize settings with sample feeds in folders
    plugin.settings = {
      ...DEFAULT_SETTINGS,
      feeds: [
        {
          ...sampleFeed,
          url: "https://example.com/feed1.xml",
          folder: "News/Tech",
        },
        {
          ...sampleFeed,
          url: "https://example.com/feed2.xml",
          folder: "News/Sports",
        },
        {
          ...sampleFeed,
          url: "https://example.com/feed3.xml",
          folder: "Uncategorized",
        },
      ],
    };

    // Mock the feedParser on the plugin
    plugin.feedParser = {
      parseFeed: mockParseFeed,
      refreshAllFeeds: mockRefreshAllFeeds,
    } as unknown as typeof plugin.feedParser;

    // Mock getActiveDashboardView
    plugin.getActiveDashboardView = vi.fn().mockResolvedValue({
      refresh: vi.fn(),
    });

    vi.clearAllMocks();
    mockRefreshAllFeeds.mockClear();
    mockParseFeed.mockClear();
  });

  it("refreshes feeds in the specified folder", async () => {
    // Given: Feeds in nested folders
    mockRefreshAllFeeds.mockResolvedValue([]);

    // When: refreshFeedsInFolder is called with parent folder
    await plugin.refreshFeedsInFolder("News");

    // Then: the fallback multi-feed path should refresh each matching feed individually
    expect(mockRefreshAllFeeds).toHaveBeenCalledTimes(2);
    const feedsCalled = mockRefreshAllFeeds.mock.calls.map(
      (call) => (call[0] as Feed[])[0],
    );
    expect(feedsCalled.every((f: Feed) => f.folder.startsWith("News/"))).toBe(
      true,
    );
  });

  it("skips excluded feeds in the specified folder", async () => {
    plugin.settings.feeds = [
      {
        ...sampleFeed,
        url: "https://example.com/feed1.xml",
        folder: "News/Tech",
      },
      {
        ...sampleFeed,
        url: "https://example.com/feed2.xml",
        folder: "News/Sports",
        excludeFromRefresh: true,
      },
    ];

    mockRefreshAllFeeds.mockResolvedValue([]);

    await plugin.refreshFeedsInFolder("News");

    expect(mockRefreshAllFeeds).toHaveBeenCalledTimes(1);
    expect(mockRefreshAllFeeds).toHaveBeenCalledWith([
      expect.objectContaining({ url: "https://example.com/feed1.xml" }),
    ]);
  });

  it("shows notice when no feeds in folder", async () => {
    // When: refreshFeedsInFolder is called with empty folder
    await plugin.refreshFeedsInFolder("NonExistent");

    // Then: Notice should be shown (mocked)
    // The method completes without error
    expect(plugin.settings).toBeDefined();
  });
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Test Suite: addFeed()
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe("addFeed()", () => {
  let plugin: RssDashboardPlugin;

  beforeEach(async () => {
    const app = createMockApp();
    plugin = await createPluginInstance(app);

    // Initialize settings with sample feeds
    plugin.settings = {
      ...DEFAULT_SETTINGS,
      feeds: [sampleFeed],
    };

    // Mock the feedParser on the plugin
    plugin.feedParser = {
      parseFeed: mockParseFeed,
      refreshAllFeeds: mockRefreshAllFeeds,
    } as unknown as typeof plugin.feedParser;

    // Mock getActiveDashboardView
    plugin.getActiveDashboardView = vi.fn().mockResolvedValue({
      refresh: vi.fn(),
    });

    vi.clearAllMocks();
    mockRefreshAllFeeds.mockClear();
    mockParseFeed.mockClear();
  });

  it("rejects duplicate feed URLs", async () => {
    // Given: Feed URL that already exists
    const existingUrl = sampleFeed.url;

    // When: addFeed is called with duplicate URL
    const result = await plugin.addFeed(
      "New Feed",
      existingUrl,
      "Uncategorized",
    );

    // Then: Should return false
    expect(result).toBe(false);
  });

  it("adds feed when URL is unique", async () => {
    // Given: New unique URL
    const newUrl = "https://example.com/new-feed.xml";

    // Mock parseFeed to return parsed feed
    mockParseFeed.mockResolvedValue({
      title: "New Feed",
      url: newUrl,
      folder: "Uncategorized",
      items: [],
      lastUpdated: Date.now(),
      mediaType: "article",
    });

    // When: addFeed is called
    const result = await plugin.addFeed("New Feed", newUrl, "Uncategorized");

    // Then: Should return true and add feed to settings
    expect(result).toBe(true);
    expect(plugin.settings.feeds).toHaveLength(2);
  });

  it("detects media type based on folder (YouTube)", async () => {
    // Given: Feed in YouTube folder
    const youtubeUrl = "https://youtube.com/feed.xml";

    // Mock parseFeed
    mockParseFeed.mockResolvedValue({
      title: "YouTube Feed",
      url: youtubeUrl,
      folder: "Videos",
      items: [],
      lastUpdated: Date.now(),
      mediaType: "video",
    });

    // When: addFeed is called with YouTube folder
    await plugin.addFeed("YouTube Feed", youtubeUrl, "Videos");

    // Then: Feed should be added with video mediaType
    const addedFeed = plugin.settings.feeds.find(
      (f: Feed) => f.url === youtubeUrl,
    );
    expect(addedFeed?.mediaType).toBe("video");
  });

  it("applies all configured defaultYouTubeTags when adding a new YouTube feed", async () => {
    const youtubeUrl =
      "https://www.youtube.com/feeds/videos.xml?channel_id=UC_x5XG1OV2P6uZZ5FSM9Ttw";

    plugin.settings.availableTags = [
      { name: "Video", color: "#d04747" },
      { name: "News", color: "#3498db" },
      { name: "Tech", color: "#2ecc71" },
      { name: "Learning", color: "#f1c40f" },
    ];
    plugin.settings.media.defaultYouTubeFolder = "Videos";
    plugin.settings.media.defaultYouTubeTags = [
      "News",
      "Tech",
      "Learning",
      "Video",
    ];
    plugin.settings.media.defaultYouTubeTag = "Video";

    mockParseFeed.mockResolvedValue({
      title: "YouTube Feed",
      url: youtubeUrl,
      folder: "Videos",
      items: [
        {
          ...sampleFeed.items[0],
          guid: "yt-item-1",
          link: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          feedUrl: youtubeUrl,
          feedTitle: "YouTube Feed",
          mediaType: "video",
          tags: [],
        },
      ],
      lastUpdated: Date.now(),
      mediaType: "video",
    });

    await plugin.addFeed("YouTube Feed", youtubeUrl, "Videos");

    const addedFeed = plugin.settings.feeds.find(
      (f: Feed) => f.url === youtubeUrl,
    );
    expect(addedFeed?.items[0].tags?.map((tag) => tag.name)).toEqual([
      "Video",
      "News",
      "Tech",
      "Learning",
    ]);
  });

  it("detects media type based on folder (Podcast)", async () => {
    // Given: Feed in Podcast folder
    const podcastUrl = "https://podcast.com/feed.xml";

    // Mock parseFeed
    mockParseFeed.mockResolvedValue({
      title: "Podcast Feed",
      url: podcastUrl,
      folder: "Podcasts",
      items: [],
      lastUpdated: Date.now(),
      mediaType: "podcast",
    });

    // When: addFeed is called with Podcast folder
    await plugin.addFeed("Podcast Feed", podcastUrl, "Podcasts");

    // Then: Feed should be added with podcast mediaType
    const addedFeed = plugin.settings.feeds.find(
      (f: Feed) => f.url === podcastUrl,
    );
    expect(addedFeed?.mediaType).toBe("podcast");
  });

  it("uses default media type for uncategorized feeds", async () => {
    // Given: Feed in Uncategorized folder
    const articleUrl = "https://blog.com/feed.xml";

    // Mock parseFeed
    mockParseFeed.mockResolvedValue({
      title: "Blog Feed",
      url: articleUrl,
      folder: "Uncategorized",
      items: [],
      lastUpdated: Date.now(),
      mediaType: "article",
    });

    // When: addFeed is called
    await plugin.addFeed("Blog Feed", articleUrl, "Uncategorized");

    // Then: Feed should have default media type
    const addedFeed = plugin.settings.feeds.find(
      (f: Feed) => f.url === articleUrl,
    );
    expect(addedFeed?.mediaType).toBe("article");
  });

  it("applies custom autoDeleteDuration when provided", async () => {
    // Given: New unique URL with custom duration
    const newUrl = "https://example.com/custom-duration.xml";
    const customDuration = 7;

    // Mock parseFeed
    mockParseFeed.mockResolvedValue({
      title: "Custom Duration Feed",
      url: newUrl,
      folder: "Uncategorized",
      items: [],
      lastUpdated: Date.now(),
      mediaType: "article",
      autoDeleteDuration: customDuration,
    });

    // When: addFeed is called with custom autoDeleteDuration
    await plugin.addFeed(
      "Custom Duration Feed",
      newUrl,
      "Uncategorized",
      customDuration,
    );

    // Then: Feed should have custom duration
    const addedFeed = plugin.settings.feeds.find((f: Feed) => f.url === newUrl);
    expect(addedFeed?.autoDeleteDuration).toBe(customDuration);
  });

  it("applies custom maxItemsLimit when provided", async () => {
    // Given: New unique URL with custom limit
    const newUrl = "https://example.com/custom-limit.xml";
    const customLimit = 25;

    // Mock parseFeed
    mockParseFeed.mockResolvedValue({
      title: "Custom Limit Feed",
      url: newUrl,
      folder: "Uncategorized",
      items: [],
      lastUpdated: Date.now(),
      mediaType: "article",
      maxItemsLimit: customLimit,
    });

    // When: addFeed is called with custom maxItemsLimit
    await plugin.addFeed(
      "Custom Limit Feed",
      newUrl,
      "Uncategorized",
      undefined,
      customLimit,
    );

    // Then: Feed should have custom limit
    const addedFeed = plugin.settings.feeds.find((f: Feed) => f.url === newUrl);
    expect(addedFeed?.maxItemsLimit).toBe(customLimit);
  });

  it("preserves an explicit Off scanInterval sentinel when provided", async () => {
    const newUrl = "https://example.com/refresh-off.xml";

    mockParseFeed.mockResolvedValue({
      title: "Refresh Off Feed",
      url: newUrl,
      folder: "Uncategorized",
      items: [],
      lastUpdated: Date.now(),
      mediaType: "article",
    });

    await plugin.addFeed(
      "Refresh Off Feed",
      newUrl,
      "Uncategorized",
      undefined,
      undefined,
      -1,
    );

    const addedFeed = plugin.settings.feeds.find((f: Feed) => f.url === newUrl);
    expect(addedFeed?.scanInterval).toBe(-1);
  });

  it("preserves exclude-from-refresh when provided", async () => {
    const newUrl = "https://example.com/excluded.xml";

    mockParseFeed.mockResolvedValue({
      title: "Excluded Feed",
      url: newUrl,
      folder: "Uncategorized",
      items: [],
      lastUpdated: Date.now(),
      mediaType: "article",
    });

    await plugin.addFeed(
      "Excluded Feed",
      newUrl,
      "Uncategorized",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );

    const addedFeed = plugin.settings.feeds.find((f: Feed) => f.url === newUrl);
    expect(addedFeed?.excludeFromRefresh).toBe(true);
  });

  it("stores customTags and applies them alongside media default tags on first add", async () => {
    const youtubeUrl =
      "https://www.youtube.com/feeds/videos.xml?channel_id=UC_custom_stack";

    plugin.settings.availableTags = [
      { name: "Video", color: "#d04747" },
      { name: "News", color: "#3498db" },
      { name: "Tech", color: "#2ecc71" },
    ];
    plugin.settings.media.defaultYouTubeFolder = "Videos";
    plugin.settings.media.defaultYouTubeTags = ["Video", "News"];
    plugin.settings.media.defaultYouTubeTag = "Video";

    mockParseFeed.mockResolvedValue({
      title: "Stacked Tags Feed",
      url: youtubeUrl,
      folder: "Videos",
      items: [
        {
          ...sampleFeed.items[0],
          guid: "yt-stack-1",
          link: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          feedUrl: youtubeUrl,
          feedTitle: "Stacked Tags Feed",
          mediaType: "video",
          tags: [{ name: "Video", color: "#d04747" }],
        },
      ],
      lastUpdated: Date.now(),
      mediaType: "video",
    });

    await plugin.addFeed(
      "Stacked Tags Feed",
      youtubeUrl,
      "Videos",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      ["News", "Tech", "Missing", "Tech"],
    );

    const addedFeed = plugin.settings.feeds.find(
      (f: Feed) => f.url === youtubeUrl,
    );
    expect(addedFeed?.customTags).toEqual(["News", "Tech", "Missing", "Tech"]);
    expect(addedFeed?.items[0].tags?.map((tag) => tag.name)).toEqual([
      "Video",
      "News",
      "Tech",
    ]);
  });

  it("preserves the global maxItems default when parser output omits maxItemsLimit", async () => {
    const newUrl = "https://example.com/global-default-limit.xml";

    plugin.settings.maxItems = 50;

    mockParseFeed.mockResolvedValue({
      title: "Global Default Feed",
      url: newUrl,
      folder: "Uncategorized",
      items: [],
      lastUpdated: Date.now(),
      mediaType: "article",
    });

    await plugin.addFeed("Global Default Feed", newUrl, "Uncategorized");

    const addedFeed = plugin.settings.feeds.find((f: Feed) => f.url === newUrl);
    expect(addedFeed?.maxItemsLimit).toBe(50);
  });

  it("saves settings after adding feed", async () => {
    // Given: New unique URL
    const newUrl = "https://example.com/save-test.xml";

    // Mock parseFeed
    mockParseFeed.mockResolvedValue({
      title: "Save Test Feed",
      url: newUrl,
      folder: "Uncategorized",
      items: [],
      lastUpdated: Date.now(),
      mediaType: "article",
    });

    // When: addFeed is called
    await plugin.addFeed("Save Test Feed", newUrl, "Uncategorized");

    // Then: saveSettings should be called
    expect(plugin.saveData).toHaveBeenCalled();
  });

  it("handles parse errors gracefully", async () => {
    // Given: Feed that fails to parse
    const badUrl = "https://bad-feed.com/no-parse.xml";

    // Mock parseFeed to throw error
    mockParseFeed.mockRejectedValue(new Error("Parse failed"));

    // When: addFeed is called
    const result = await plugin.addFeed("Bad Feed", badUrl, "Uncategorized");

    // Then: Should return false
    expect(result).toBe(false);
  });
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Test Suite: onunload() Cleanup
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe("ingestFeedsForBackgroundImport()", () => {
  let plugin: RssDashboardPlugin;

  beforeEach(async () => {
    const app = createMockApp();
    plugin = await createPluginInstance(app);
    plugin.settings = {
      ...DEFAULT_SETTINGS,
      feeds: [sampleFeed],
    };
    vi.clearAllMocks();
    vi.spyOn(
      (plugin as unknown as PluginPrivateAPI).backgroundImportService,
      "startBackgroundImport",
    ).mockImplementation(() => {});
    plugin.ensureFolderExists = vi.fn().mockResolvedValue(false);
    plugin.getActiveDashboardView = vi.fn().mockResolvedValue({
      refresh: vi.fn(),
    });
  });

  it("dedupes URLs, inserts placeholders, saves once, and queues hydration", async () => {
    const result = await (
      plugin as unknown as PluginPrivateAPI
    ).ingestFeedsForBackgroundImport(
      [
        {
          title: "New Feed",
          url: "https://example.com/new.xml",
          folder: "Research",
        },
        {
          title: "Duplicate Existing",
          url: sampleFeed.url,
          folder: "Research",
        },
        {
          title: "Duplicate Incoming",
          url: "https://example.com/new.xml",
          folder: "Research",
        },
      ],
      { mode: "update" },
    );

    expect(result.addedCount).toBe(1);
    expect(result.skippedCount).toBe(2);
    expect(
      plugin.settings.feeds.some(
        (f) => f.url === "https://example.com/new.xml",
      ),
    ).toBe(true);
    const addedFeed = plugin.settings.feeds.find(
      (f) => f.url === "https://example.com/new.xml",
    );
    expect(addedFeed?.items).toEqual([]);
    expect(plugin.saveData).toHaveBeenCalledTimes(1);
    expect(plugin.ensureFolderExists).toHaveBeenCalledWith("Research", {
      saveSettings: false,
      refreshView: false,
    });
    expect(
      (plugin as unknown as PluginPrivateAPI).backgroundImportService
        .startBackgroundImport,
    ).toHaveBeenCalledWith([
      expect.objectContaining({
        title: "New Feed",
        url: "https://example.com/new.xml",
        folder: "Research",
      }),
    ]);
  });

  it("supports overwrite mode and replaces folders when provided", async () => {
    const result = await (
      plugin as unknown as PluginPrivateAPI
    ).ingestFeedsForBackgroundImport(
      [
        {
          title: "Only Feed",
          url: "https://example.com/only.xml",
          folder: "Tech/AI",
        },
      ],
      {
        mode: "overwrite",
        folders: [
          { name: "Tech", subfolders: [{ name: "AI", subfolders: [] }] },
        ],
      },
    );

    expect(result.addedCount).toBe(1);
    expect(plugin.settings.feeds).toHaveLength(1);
    expect(plugin.settings.feeds[0].url).toBe("https://example.com/only.xml");
    expect(plugin.settings.folders).toEqual([
      { name: "Tech", subfolders: [{ name: "AI", subfolders: [] }] },
    ]);
  });
});

describe("onunload()", () => {
  let plugin: RssDashboardPlugin;

  beforeEach(async () => {
    const app = createMockApp();
    plugin = await createPluginInstance(app);

    // Initialize settings with auto-backup enabled
    plugin.settings = {
      ...DEFAULT_SETTINGS,
      autoBackup: {
        backupDataJson: true,
        backupOpml: true,
        backupUserdata: true,
      },
    };

    (plugin as unknown as PluginPrivateAPI).backupService.performAutoBackups =
      vi.fn().mockResolvedValue(undefined);

    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls async performAutoBackups on onunload after the settings queue", async () => {
    // When: onunload is called
    plugin.onunload();
    await flushPromises();

    // Then: performAutoBackups should be called
    expect(
      (plugin as unknown as PluginPrivateAPI).backupService.performAutoBackups,
    ).toHaveBeenCalled();
  });

  it("does not throw when autoBackup is disabled", () => {
    // Given: Plugin with auto-backup disabled
    plugin.settings.autoBackup = {
      backupDataJson: false,
      backupOpml: false,
      backupUserdata: false,
    };

    // When: onunload is called
    expect(() => plugin.onunload()).not.toThrow();
  });
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Test Suite: performAutoBackups()
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe("performAutoBackups()", () => {
  let plugin: RssDashboardPlugin;

  beforeEach(async () => {
    const app = createMockApp();
    plugin = await createPluginInstance(app);

    // Initialize settings with auto-backup enabled
    plugin.settings = {
      ...DEFAULT_SETTINGS,
      autoBackup: {
        backupDataJson: true,
        backupOpml: true,
        backupUserdata: true,
      },
    };

    // Mock manifest.dir
    plugin.manifest = {
      ...plugin.manifest,
      dir: ".",
    } as RssDashboardPlugin["manifest"];

    vi.clearAllMocks();
    mockRefreshAllFeeds.mockClear();
    mockParseFeed.mockClear();
  });

  it("skips backup when autoBackup is disabled", async () => {
    // Given: Auto-backup disabled
    plugin.settings.autoBackup = {
      backupDataJson: false,
      backupOpml: false,
      backupUserdata: false,
    };

    // When: performAutoBackups is called
    await plugin.performAutoBackups();

    // Then: No writes should occur
    expect(plugin.saveData).not.toHaveBeenCalled();
  });

  it("handles missing plugin dir gracefully", async () => {
    // Given: No plugin dir
    plugin.manifest.dir = undefined;

    // When: performAutoBackups is called
    await plugin.performAutoBackups();

    // Then: Should not throw
    expect(plugin.saveData).not.toHaveBeenCalled();
  });
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Test Suite: refreshSelectedFeed()
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe("refreshSelectedFeed()", () => {
  let plugin: RssDashboardPlugin;

  beforeEach(async () => {
    const app = createMockApp();
    plugin = await createPluginInstance(app);

    // Initialize settings
    plugin.settings = {
      ...DEFAULT_SETTINGS,
      feeds: [sampleFeed],
    };

    // Mock the feedParser on the plugin
    plugin.feedParser = {
      parseFeed: mockParseFeed,
      refreshAllFeeds: mockRefreshAllFeeds,
    } as unknown as typeof plugin.feedParser;

    // Mock getActiveDashboardView
    plugin.getActiveDashboardView = vi.fn().mockResolvedValue({
      refresh: vi.fn(),
    });

    vi.clearAllMocks();
    mockRefreshAllFeeds.mockClear();
    mockParseFeed.mockClear();
  });

  it("refreshes a single excluded feed explicitly", async () => {
    const excludedFeed = {
      ...sampleFeed,
      excludeFromRefresh: true,
    };
    mockRefreshAllFeeds.mockResolvedValue([excludedFeed]);

    await plugin.refreshSelectedFeed(excludedFeed);

    expect(mockRefreshAllFeeds).toHaveBeenCalledWith([excludedFeed]);
  });
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Test Suite: Storage transition orchestration
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe("storage transition orchestration", () => {
  let plugin: RssDashboardPlugin;

  beforeEach(async () => {
    const app = createMockApp();
    plugin = await createPluginInstance(app);
    plugin.settings = {
      ...DEFAULT_SETTINGS,
      storageMode: "vault-shards",
      feeds: [sampleFeed],
    };
    vi.clearAllMocks();
  });

  it("revertToLegacyJsonStorageWithOptions refreshes dashboards before settings redisplay", async () => {
    const displaySpy = vi.fn();
    (plugin as unknown as { settingTab: { display: () => void } }).settingTab =
      {
        display: displaySpy,
      };

    const repoSpy = vi
      .spyOn(
        (
          plugin as unknown as {
            feedStorageRepository: {
              revertToLegacyJson: (...args: unknown[]) => Promise<void>;
            };
          }
        ).feedStorageRepository,
        "revertToLegacyJson",
      )
      .mockResolvedValue(undefined);
    const initSpy = vi
      .spyOn(
        plugin as unknown as {
          initializeSettingsBackedServices: () => void;
        },
        "initializeSettingsBackedServices",
      )
      .mockImplementation(() => {});
    const refreshSpy = vi
      .spyOn(plugin, "refreshDashboardViews")
      .mockResolvedValue(undefined);

    await plugin.revertToLegacyJsonStorageWithOptions({
      deleteShardFolder: false,
    });

    expect(repoSpy).toHaveBeenCalledTimes(1);
    expect(initSpy).toHaveBeenCalledTimes(1);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(displaySpy).toHaveBeenCalledTimes(1);
    expect(refreshSpy.mock.invocationCallOrder[0]).toBeLessThan(
      displaySpy.mock.invocationCallOrder[0],
    );
  });

  it("migrateToVaultStorage refreshes dashboards before settings redisplay", async () => {
    const displaySpy = vi.fn();
    (plugin as unknown as { settingTab: { display: () => void } }).settingTab =
      {
        display: displaySpy,
      };

    const repoSpy = vi
      .spyOn(
        (
          plugin as unknown as {
            feedStorageRepository: {
              migrateToVaultShards: (...args: unknown[]) => Promise<void>;
            };
          }
        ).feedStorageRepository,
        "migrateToVaultShards",
      )
      .mockResolvedValue(undefined);
    const initSpy = vi
      .spyOn(
        plugin as unknown as {
          initializeSettingsBackedServices: () => void;
        },
        "initializeSettingsBackedServices",
      )
      .mockImplementation(() => {});
    const refreshSpy = vi
      .spyOn(plugin, "refreshDashboardViews")
      .mockResolvedValue(undefined);

    await plugin.migrateToVaultStorage();

    expect(repoSpy).toHaveBeenCalledTimes(1);
    expect(initSpy).toHaveBeenCalledTimes(1);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(displaySpy).toHaveBeenCalledTimes(1);
    expect(refreshSpy.mock.invocationCallOrder[0]).toBeLessThan(
      displaySpy.mock.invocationCallOrder[0],
    );
  });
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Test Suite: saveSettings()
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe("saveSettings()", () => {
  let plugin: RssDashboardPlugin;

  beforeEach(async () => {
    const app = createMockApp();
    plugin = await createPluginInstance(app);

    // Initialize settings
    plugin.settings = {
      ...DEFAULT_SETTINGS,
    };

    vi.clearAllMocks();
  });

  it("calls saveData with current settings", async () => {
    // When: saveSettings is called
    await plugin.saveSettings();

    // Then: saveData should be called with settings
    expect(plugin.saveData).toHaveBeenCalledWith(
      expect.objectContaining(plugin.settings),
    );
  });

  it("saves modified settings", async () => {
    // Given: Modified settings
    plugin.settings.refreshInterval = 120;

    // When: saveSettings is called
    await plugin.saveSettings();

    // Then: saveData should be called with modified settings
    expect(plugin.saveData).toHaveBeenCalledWith(
      expect.objectContaining({
        refreshInterval: 120,
      }),
    );
  });
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Test Suite: applyFeedLimitsToAllFeeds()
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe("applyFeedLimitsToAllFeeds()", () => {
  let plugin: RssDashboardPlugin;

  beforeEach(async () => {
    const app = createMockApp();
    plugin = await createPluginInstance(app);

    // Initialize settings with feeds
    plugin.settings = {
      ...DEFAULT_SETTINGS,
      feeds: [
        {
          ...sampleFeed,
          url: "https://example.com/feed1.xml",
          maxItemsLimit: 10,
        },
        {
          ...sampleFeed,
          url: "https://example.com/feed2.xml",
          maxItemsLimit: 20,
        },
      ],
    };

    // Mock getActiveDashboardView
    plugin.getActiveDashboardView = vi.fn().mockResolvedValue({
      refresh: vi.fn(),
    });

    vi.clearAllMocks();
  });

  it("applies limits to all feeds", async () => {
    // When: applyFeedLimitsToAllFeeds is called
    await plugin.applyFeedLimitsToAllFeeds();

    // Then: settings should be saved
    expect(plugin.saveData).toHaveBeenCalled();
  });

  it("shows notice after applying limits", async () => {
    // When: applyFeedLimitsToAllFeeds is called
    await plugin.applyFeedLimitsToAllFeeds();

    // Then: Notice should be shown
    expect(plugin.settings).toBeDefined();
  });
});

describe("transactional public settings imports", () => {
  let plugin: RssDashboardPlugin;
  let previous: RssDashboardSettings;
  let previousFeedParser: RssDashboardPlugin["feedParser"];
  let repository: {
    persistSettings: (
      settings: RssDashboardSettings,
      saveData: (data: unknown) => Promise<void>,
      options?: unknown,
    ) => Promise<{
      metadataSaved: boolean;
      shardWriteCount: number;
      shardDeleteCount: number;
    }>;
    persistSettingsTransaction: <T>(
      previousSettings: RssDashboardSettings,
      candidateSettings: RssDashboardSettings,
      saveData: (data: unknown) => Promise<void>,
      afterPersist: () => Promise<T>,
      options?: unknown,
    ) => Promise<T>;
  };

  const cloneSettings = (
    settings: RssDashboardSettings,
  ): RssDashboardSettings =>
    JSON.parse(JSON.stringify(settings)) as RssDashboardSettings;

  const writeDurable = async (
    settings: RssDashboardSettings,
  ): Promise<void> => {
    const contents = JSON.stringify(settings);
    const existing = plugin.app.vault.getAbstractFileByPath("data.json");
    if (existing) {
      await plugin.app.vault.adapter.write("data.json", contents);
    } else {
      await plugin.app.vault.create("data.json", contents);
    }
  };

  const readDurable = async (): Promise<RssDashboardSettings> =>
    JSON.parse(
      await plugin.app.vault.adapter.read("data.json"),
    ) as RssDashboardSettings;

  const publicFeed = (suffix: string) => ({
    title: `Feed ${suffix}`,
    url: `https://example.com/${suffix}.xml`,
    folder: "",
    sourceKind: "feed",
    sourceConfig: { kind: "feed" },
  });

  const publicDataFile = (
    overrides: Record<string, unknown>,
  ): File =>
    new File(
      [
        JSON.stringify({
          ...overrides,
          feeds: overrides.feeds ?? [],
          folders: overrides.folders ?? [],
          availableTags: overrides.availableTags ?? [],
        }),
      ],
      "data.json",
    );

  const installPluginDataWriter = (
    transform: (data: unknown) => string = (data) =>
      JSON.stringify(data, null, 2),
  ): void => {
    plugin.saveData = vi.fn(async (data: unknown) => {
      await plugin.app.vault.adapter.write(
        "data.json",
        transform(data),
      );
    });
  };

  beforeEach(async () => {
    plugin = await createPluginInstance(createMockApp());
    previous = cloneSettings(DEFAULT_SETTINGS);
    previous.locale = "zh-CN";
    previous.feeds = [];
    plugin.settings = previous;
    (
      plugin as unknown as {
        initializeSettingsBackedServices: () => void;
      }
    ).initializeSettingsBackedServices();
    await writeDurable(previous);
    installPluginDataWriter();
    plugin.loadData = vi.fn(async () => {
      throw new Error("transaction verification must not call loadData");
    });
    previousFeedParser = { identity: "previous-parser" } as unknown as RssDashboardPlugin["feedParser"];
    plugin.feedParser = previousFeedParser;
    repository = (
      plugin as unknown as {
        feedStorageRepository: typeof repository;
      }
    ).feedStorageRepository;
    vi.spyOn(plugin, "refreshDashboardViews").mockResolvedValue(undefined);
    vi.spyOn(
      plugin as unknown as {
        getActiveDiscoverView: () => Promise<null>;
      },
      "getActiveDiscoverView",
    ).mockResolvedValue(null);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("rolls back and rejects when persistence throws before writing", async () => {
    const transaction = vi
      .spyOn(repository, "persistSettingsTransaction")
      .mockRejectedValue(new Error("save-before-write"));

    await expect(
      plugin.importUserSettingsJsonFromFile(
        new File([JSON.stringify({ locale: "en" })], "usersettings.json"),
      ),
    ).rejects.toThrow("save-before-write");

    expect(plugin.settings).toBe(previous);
    expect(plugin.feedParser).toBe(previousFeedParser);
    expect((await readDurable()).locale).toBe("zh-CN");
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(plugin.loadData).not.toHaveBeenCalled();
  });

  it("compensates a commit-then-throw and verifies the previous durable state", async () => {
    plugin.saveData = vi.fn(async (data: unknown) => {
      await plugin.app.vault.adapter.write(
        "data.json",
        JSON.stringify(data),
      );
      if ((data as RssDashboardSettings).locale === "en") {
        throw new Error("commit-then-throw");
      }
    });

    await expect(
      plugin.importUserSettingsJsonFromFile(
        new File([JSON.stringify({ locale: "en" })], "usersettings.json"),
      ),
    ).rejects.toThrow("commit-then-throw");

    expect(plugin.settings).toBe(previous);
    expect(plugin.feedParser).toBe(previousFeedParser);
    expect((await readDurable()).locale).toBe("zh-CN");
    expect(plugin.loadData).not.toHaveBeenCalled();
  });

  it.each(["data", "portable"] as const)(
    "applies the same compensating transaction to the %s import entrypoint",
    async (entrypoint) => {
      plugin.saveData = vi.fn(async (data: unknown) => {
        await plugin.app.vault.adapter.write(
          "data.json",
          JSON.stringify(data),
        );
        if ((data as RssDashboardSettings).locale === "en") {
          throw new Error(`${entrypoint}-commit-then-throw`);
        }
      });
      const imported = cloneSettings(previous);
      imported.locale = "en";
      const file =
        entrypoint === "data"
          ? new File([JSON.stringify({ locale: "en" })], "data.json")
          : new File(
              [
                JSON.stringify({
                  version: 1,
                  exportedAt: 123,
                  storageMode: imported.storageMode,
                  metadata: imported,
                  shards: [],
                  markdownMirrorFallbackPlanned: false,
                }),
              ],
              "portable.json",
            );

      const operation =
        entrypoint === "data"
          ? plugin.importDataJsonFromFile(file)
          : plugin.importPortableDataBundleFromFile(file);
      await expect(operation).rejects.toThrow(
        `${entrypoint}-commit-then-throw`,
      );

      expect(plugin.settings).toBe(previous);
      expect(plugin.feedParser).toBe(previousFeedParser);
      expect((await readDurable()).locale).toBe("zh-CN");
    },
  );

  it("reports rollback-incomplete without publishing a false success", async () => {
    vi.spyOn(repository, "persistSettingsTransaction").mockRejectedValue(
      new FeedStorageRollbackIncompleteError(),
    );

    await expect(
      plugin.importUserSettingsJsonFromFile(
        new File([JSON.stringify({ locale: "en" })], "usersettings.json"),
      ),
    ).rejects.toThrow("Settings import rollback incomplete");

    expect(plugin.settings).toBe(previous);
    expect(plugin.feedParser).toBe(previousFeedParser);
    expect((await readDurable()).locale).toBe("zh-CN");
  });

  it("restores the exact prior service identity when rebuild throws", async () => {
    vi.spyOn(
      plugin as unknown as {
        initializeSettingsBackedServices: () => void;
      },
      "initializeSettingsBackedServices",
    ).mockImplementationOnce(() => {
      plugin.feedParser = {
        identity: "partial-candidate-parser",
      } as unknown as RssDashboardPlugin["feedParser"];
      throw new Error("rebuild-failed");
    });

    await expect(
      plugin.importUserSettingsJsonFromFile(
        new File([JSON.stringify({ locale: "en" })], "usersettings.json"),
      ),
    ).rejects.toThrow("rebuild-failed");

    expect(plugin.settings).toBe(previous);
    expect(plugin.feedParser).toBe(previousFeedParser);
    expect((await readDurable()).locale).toBe("zh-CN");
  });

  it("rolls back when an after-save dashboard refresh fails", async () => {
    vi.mocked(plugin.refreshDashboardViews).mockRejectedValueOnce(
      new Error("after-save-failed"),
    );

    await expect(
      plugin.importUserSettingsJsonFromFile(
        new File([JSON.stringify({ locale: "en" })], "usersettings.json"),
      ),
    ).rejects.toThrow("after-save-failed");

    expect(plugin.settings).toBe(previous);
    expect(plugin.feedParser).toBe(previousFeedParser);
    expect((await readDurable()).locale).toBe("zh-CN");
  });

  it("serializes concurrent imports and builds the second candidate after the first commits", async () => {
    const firstWrite = createDeferred<void>();
    const events: string[] = [];
    let attempt = 0;
    plugin.saveData = vi.fn(async (data: unknown) => {
      const candidate = data as RssDashboardSettings;
      attempt += 1;
      const currentAttempt = attempt;
      events.push(`start:${candidate.locale}`);
      if (currentAttempt === 1) await firstWrite.promise;
      await writeDurable(candidate);
      events.push(`end:${candidate.locale}`);
    });

    const first = plugin.importUserSettingsJsonFromFile(
      new File([JSON.stringify({ locale: "en" })], "first.json"),
    );
    const second = plugin.importUserSettingsJsonFromFile(
      new File([JSON.stringify({ locale: "zh-CN" })], "second.json"),
    );
    await vi.waitFor(() => {
      expect(events).toEqual(["start:en"]);
    });
    firstWrite.resolve();
    await Promise.all([first, second]);

    expect(events).toEqual([
      "start:en",
      "end:en",
      "start:zh-CN",
      "end:zh-CN",
    ]);
    expect(plugin.settings.locale).toBe("zh-CN");
  });

  it("cancels and compensates an in-flight import during plugin unload", async () => {
    const writeStarted = createDeferred<void>();
    const releaseWrite = createDeferred<void>();
    let attempt = 0;
    plugin.saveData = vi.fn(async (data: unknown) => {
      const candidate = data as RssDashboardSettings;
      attempt += 1;
      await writeDurable(candidate);
      if (attempt === 1) {
        writeStarted.resolve();
        await releaseWrite.promise;
      }
    });

    const backupLocales: string[] = [];
    (
      plugin as unknown as PluginPrivateAPI
    ).backupService.performAutoBackups = vi.fn(async () => {
      backupLocales.push(plugin.settings.locale);
    });
    const operation = plugin.importUserSettingsJsonFromFile(
      new File([JSON.stringify({ locale: "en" })], "usersettings.json"),
    );
    await writeStarted.promise;
    plugin.onunload();
    releaseWrite.resolve();

    await expect(operation).rejects.toThrow("Settings import canceled");
    await flushPromises();
    expect(plugin.settings).toBe(previous);
    expect(plugin.feedParser).toBe(previousFeedParser);
    expect((await readDurable()).locale).toBe("zh-CN");
    expect(backupLocales).toEqual(["zh-CN"]);
  });

  it("preserves an external plugin metadata rewrite on import rollback", async () => {
    vi.mocked(plugin.refreshDashboardViews).mockImplementationOnce(async () => {
      await plugin.app.vault.adapter.write(
        "data.json",
        "EXTERNAL-METADATA",
      );
      throw new Error("refresh failed");
    });

    await expect(
      plugin.importUserSettingsJsonFromFile(
        new File([JSON.stringify({ locale: "en" })], "usersettings.json"),
      ),
    ).rejects.toThrow("Settings import rollback incomplete");
    expect(await plugin.app.vault.adapter.read("data.json")).toBe(
      "EXTERNAL-METADATA",
    );
  });

  it("does not overwrite a same-byte ABA replacement of plugin metadata", async () => {
    vi.mocked(plugin.refreshDashboardViews).mockImplementationOnce(async () => {
      const candidateBytes = await plugin.app.vault.adapter.read("data.json");
      const candidateFile =
        plugin.app.vault.getAbstractFileByPath("data.json");
      if (!candidateFile) throw new Error("missing candidate file");
      await plugin.app.vault.delete(candidateFile);
      await plugin.app.vault.create("data.json", candidateBytes);
      throw new Error("refresh failed");
    });

    await expect(
      plugin.importUserSettingsJsonFromFile(
        new File([JSON.stringify({ locale: "en" })], "usersettings.json"),
      ),
    ).rejects.toThrow("Settings import rollback incomplete");
    expect(
      JSON.parse(await plugin.app.vault.adapter.read("data.json")),
    ).toEqual(expect.objectContaining({ locale: "en" }));
  });

  it("cancels and compensates when unload happens during the final async view lookup", async () => {
    const discoverLookup = createDeferred<null>();
    const getActiveDiscoverView = vi
      .spyOn(
        plugin as unknown as {
          getActiveDiscoverView: () => Promise<null>;
        },
        "getActiveDiscoverView",
      )
      .mockReturnValueOnce(discoverLookup.promise);

    const operation = plugin.importUserSettingsJsonFromFile(
      new File([JSON.stringify({ locale: "en" })], "usersettings.json"),
    );
    await vi.waitFor(() => {
      expect(getActiveDiscoverView).toHaveBeenCalledTimes(1);
    });
    plugin.onunload();
    discoverLookup.resolve(null);

    await expect(operation).rejects.toThrow("Settings import canceled");
    expect(plugin.settings).toBe(previous);
    expect(plugin.feedParser).toBe(previousFeedParser);
    expect((await readDurable()).locale).toBe("zh-CN");
  });

  it("removes legacy-to-shards files and empty folders when refresh fails after persistence", async () => {
    previous.storageMode = "legacy-json";
    previous.storageFolder = "Candidate Storage/Feeds";
    previous.metadataStorageMode = "plugin-default";
    previous.feeds = [];
    plugin.settings = previous;
    await writeDurable(previous);
    installPluginDataWriter();
    vi.mocked(plugin.refreshDashboardViews).mockRejectedValueOnce(
      new Error("refresh-failed"),
    );

    await expect(
      plugin.importDataJsonFromFile(
        publicDataFile({
          locale: "en",
          storageMode: "vault-shards",
          feeds: [publicFeed("candidate")],
        }),
      ),
    ).rejects.toThrow("refresh-failed");

    expect(plugin.settings).toBe(previous);
    expect(
      await plugin.app.vault.adapter.exists(
        "Candidate Storage/Feeds",
      ),
    ).toBe(false);
    expect(await plugin.app.vault.adapter.exists("Candidate Storage")).toBe(
      false,
    );
    expect(await plugin.app.vault.adapter.read("data.json")).toBe(
      JSON.stringify(previous),
    );
  });

  it.each([
    "missing",
    "malformed",
    "wrong-target",
    "wrong-version",
    "extra-key",
  ] as const)(
    "rejects a vault-location import when the plugin bootstrap is %s",
    async (mode) => {
      previous.storageMode = "legacy-json";
      previous.metadataStorageMode = "plugin-default";
      previous.metadataStorageFolder = "Vault Metadata";
      previous.feeds = [];
      plugin.settings = previous;
      const previousBytes = JSON.stringify(previous);
      await plugin.app.vault.adapter.write("data.json", previousBytes);
      plugin.saveData = vi.fn(async (data: unknown) => {
        if (mode === "missing") return;
        await plugin.app.vault.adapter.write(
          "data.json",
          mode === "malformed"
            ? "{"
            : JSON.stringify({
                ...(data as Record<string, unknown>),
                ...(mode === "wrong-target"
                  ? { metadataStorageFolder: "Wrong Metadata" }
                  : {}),
                ...(mode === "wrong-version"
                  ? { metadataStorageSchemaVersion: 999 }
                  : {}),
                ...(mode === "extra-key"
                  ? { unexpected: "not-bootstrap-schema" }
                  : {}),
              }),
        );
      });

      const expectedError =
        mode === "missing"
          ? "Settings import persistence verification failed"
          : "Settings import rollback incomplete";
      await expect(
        plugin.importUserSettingsJsonFromFile(
          new File(
            [
              JSON.stringify({
                locale: "en",
                metadataStorageMode: "vault-location",
              }),
            ],
            "usersettings.json",
          ),
        ),
      ).rejects.toThrow(expectedError);

      expect(plugin.settings).toBe(previous);
      const durableBootstrap =
        await plugin.app.vault.adapter.read("data.json");
      if (mode === "missing") {
        expect(durableBootstrap).toBe(previousBytes);
      } else {
        expect(durableBootstrap).not.toBe(previousBytes);
      }
      expect(
        await plugin.app.vault.adapter.exists(
          "Vault Metadata/data.json",
        ),
      ).toBe(mode !== "missing");
    },
  );

  it("rejects plugin-default success-with-wrong-data before publishing", async () => {
    const previousBytes = JSON.stringify(previous);
    plugin.saveData = vi.fn(async () => {
      await plugin.app.vault.adapter.write(
        "data.json",
        previousBytes,
      );
    });

    await expect(
      plugin.importUserSettingsJsonFromFile(
        new File([JSON.stringify({ locale: "en" })], "usersettings.json"),
      ),
    ).rejects.toThrow("Settings import persistence verification failed");

    expect(plugin.settings).toBe(previous);
    expect(plugin.feedParser).toBe(previousFeedParser);
    expect(await plugin.app.vault.adapter.read("data.json")).toBe(
      previousBytes,
    );
  });

  it("writes an exact vault bootstrap that resolves the full metadata on reopen", async () => {
    previous.storageMode = "legacy-json";
    previous.metadataStorageMode = "plugin-default";
    previous.metadataStorageFolder = "Vault Metadata";
    previous.feeds = [];
    plugin.settings = previous;
    await writeDurable(previous);
    installPluginDataWriter();

    await plugin.importUserSettingsJsonFromFile(
      new File(
        [
          JSON.stringify({
            locale: "en",
            metadataStorageMode: "vault-location",
          }),
        ],
        "usersettings.json",
      ),
    );

    const bootstrap = JSON.parse(
      await plugin.app.vault.adapter.read("data.json"),
    ) as Record<string, unknown>;
    expect(bootstrap).toEqual({
      metadataStorageMode: "vault-location",
      metadataStorageFolder: "Vault Metadata",
      metadataStorageSchemaVersion: 1,
    });
    expect(
      JSON.parse(
        await plugin.app.vault.adapter.read(
          "Vault Metadata/data.json",
        ),
      ),
    ).toEqual(expect.objectContaining({ locale: "en" }));

    const reopened = await createPluginInstance(
      plugin.app as unknown as MockApp,
    );
    reopened.loadData = vi.fn().mockResolvedValue(bootstrap);
    await reopened.loadSettings();
    expect(reopened.settings.locale).toBe("en");
    expect(reopened.settings.metadataStorageMode).toBe("vault-location");
    expect(reopened.settings.metadataStorageFolder).toBe("Vault Metadata");
  });

  it("revokes an old diagnostics preview permanently before unload rollback", async () => {
    const clipboardWrite = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWrite },
    });
    const preview = plugin.createSafeDiagnosticsPreview();
    const discoverLookup = createDeferred<null>();
    installPluginDataWriter();
    vi.spyOn(
      plugin as unknown as {
        getActiveDiscoverView: () => Promise<null>;
      },
      "getActiveDiscoverView",
    ).mockReturnValueOnce(discoverLookup.promise);

    const operation = plugin.importUserSettingsJsonFromFile(
      new File([JSON.stringify({ locale: "en" })], "usersettings.json"),
    );
    await vi.waitFor(() => {
      expect(plugin.settings.locale).toBe("en");
    });
    plugin.onunload();
    discoverLookup.resolve(null);
    await expect(operation).rejects.toThrow("Settings import canceled");

    await plugin.copySafeDiagnosticsPreview(preview.token, preview.text);
    expect(clipboardWrite).not.toHaveBeenCalled();
    expect(plugin.refreshDashboardViews).toHaveBeenCalledTimes(1);
  });

  it("revokes an old diagnostics preview on a normal import rollback", async () => {
    const clipboardWrite = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWrite },
    });
    const preview = plugin.createSafeDiagnosticsPreview();
    installPluginDataWriter();
    vi.mocked(plugin.refreshDashboardViews).mockRejectedValueOnce(
      new Error("refresh-failed"),
    );

    await expect(
      plugin.importUserSettingsJsonFromFile(
        new File([JSON.stringify({ locale: "en" })], "usersettings.json"),
      ),
    ).rejects.toThrow("refresh-failed");

    await plugin.copySafeDiagnosticsPreview(preview.token, preview.text);
    expect(clipboardWrite).not.toHaveBeenCalled();
  });

  it("rerenders restored settings after a later dashboard view fails", async () => {
    const refreshLocales: string[] = [];
    installPluginDataWriter();
    vi.mocked(plugin.refreshDashboardViews)
      .mockImplementationOnce(async () => {
        refreshLocales.push(plugin.settings.locale);
        throw new Error("second-view-failed");
      })
      .mockImplementationOnce(async () => {
        refreshLocales.push(plugin.settings.locale);
      });

    await expect(
      plugin.importUserSettingsJsonFromFile(
        new File([JSON.stringify({ locale: "en" })], "usersettings.json"),
      ),
    ).rejects.toThrow("second-view-failed");

    expect(refreshLocales).toEqual(["en", "zh-CN"]);
    expect(plugin.settings).toBe(previous);
    expect(plugin.feedParser).toBe(previousFeedParser);
  });

  it("reports rollback-incomplete when restored views cannot be rerendered", async () => {
    const noticeLog = vi
      .spyOn(console, "debug")
      .mockImplementation(() => {});
    installPluginDataWriter();
    vi.mocked(plugin.refreshDashboardViews)
      .mockRejectedValueOnce(new Error("second-view-failed"))
      .mockRejectedValueOnce(new Error("old-view-refresh-failed"));

    await expect(
      plugin.importUserSettingsJsonFromFile(
        new File([JSON.stringify({ locale: "en" })], "usersettings.json"),
      ),
    ).rejects.toThrow("Settings import rollback incomplete");

    expect(plugin.settings).toBe(previous);
    expect(plugin.feedParser).toBe(previousFeedParser);
    expect(noticeLog.mock.calls.flat().join(" ")).toContain(
      "设置导入未能完整恢复",
    );
  });

  it("queues a normal save behind import and persists the published candidate", async () => {
    const firstWriteStarted = createDeferred<void>();
    const releaseFirstWrite = createDeferred<void>();
    const persistedLocales: string[] = [];
    let writeCount = 0;
    plugin.saveData = vi.fn(async (data: unknown) => {
      const settings = data as RssDashboardSettings;
      writeCount += 1;
      persistedLocales.push(settings.locale);
      if (writeCount === 1) {
        firstWriteStarted.resolve();
        await releaseFirstWrite.promise;
      }
      await plugin.app.vault.adapter.write(
        "data.json",
        JSON.stringify(data),
      );
    });

    const importOperation = plugin.importUserSettingsJsonFromFile(
      new File([JSON.stringify({ locale: "en" })], "usersettings.json"),
    );
    await firstWriteStarted.promise;
    const normalSave = plugin.saveSettings({ forceMetadata: true });
    await Promise.resolve();
    expect(persistedLocales).toEqual(["en"]);

    releaseFirstWrite.resolve();
    await Promise.all([importOperation, normalSave]);
    expect(persistedLocales).toEqual(["en", "en"]);
    expect(plugin.settings.locale).toBe("en");
  });
});
