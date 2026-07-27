import {
  vi,
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  type Mock,
} from "vitest";
import {
  Sidebar,
  SidebarOptions,
  SidebarCallbacks,
} from "../../../src/components/sidebar";
import * as ObsidianStubs from "../../stubs/obsidian";
import type { App } from "../../stubs/obsidian";
import {
  RssDashboardSettings,
  Folder,
  type Feed,
  type FeedRefreshState,
  type FeedMetadata,
} from "../../../src/types/types";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";
import type RssDashboardPlugin from "../../../main";
import { FeedManagerModal } from "../../../src/modals/feed-manager/feed-manager-modal";

installObsidianDomPolyfills();

interface TestApp extends App {
  workspace: App["workspace"];
}

/** Typed interface for the plugin surface under test */
interface TestPlugin extends Partial<RssDashboardPlugin> {
  settings: RssDashboardSettings;
  saveSettings: Mock<() => Promise<void>>;
  updateArticlesReadBatch: Mock<
    (targets: Array<{ articleGuid: string; feedUrl: string }>, read: boolean) =>
      Promise<boolean>
  >;
  activeRefreshState?: Map<string, FeedRefreshState>;
  backgroundImportQueue?: FeedMetadata[];
  openAddSourceModal: Mock;
  updateSubscription: Mock;
  removeSubscription: Mock;
  applySidebarOrdering: Mock;
  applyFolderMutation: Mock;
}

/** Typed interface for Sidebar private member access */
type TestSidebar = {
  app: App;
  container: HTMLElement;
  settings: RssDashboardSettings;
  options: SidebarOptions;
  renderFallbackFeedIcon: (el: HTMLElement) => void;
  cachedFolderPaths: string[] | null;
  getCachedFolderPaths: () => string[];
  renderHeader: (el: HTMLElement) => void;
  resizeObserver: ResizeObserver | null;
  destroy: () => void;
  render: () => void;
  clearFolderPathCache: () => void;
  focusSidebar: () => void;
  hasKeyboardFocus: () => boolean;
  moveFocusToNextItem: () => void;
  moveFocusToPreviousItem: () => void;
  jumpToNextFolder: () => void;
  jumpToPreviousFolder: () => void;
  openFocusedItem: () => void;
  focusedSidebarTarget: { type: string; path?: string; url?: string } | null;
  markAllUnreadAsRead: () => Promise<void>;
  markAllReadAsUnread: () => Promise<void>;
  markSelectionReadStatus: (read: boolean) => Promise<void>;
  markFeedsReadStatus: (feeds: Feed[], read: boolean) => Promise<number | null>;
  updateSubscriptionOptions: (
    feed: Feed,
    patch: { folder?: string; mediaType?: "article" | "video" | "podcast" },
  ) => Promise<boolean>;
  deleteFolderAndSubscriptions: (folderPath: string) => Promise<boolean>;
  renameFolderByPath: (oldPath: string, newName: string) => Promise<boolean>;
};

describe("Sidebar Core", () => {
  let app: App;
  let container: HTMLElement;
  let plugin: TestPlugin;
  let settings: RssDashboardSettings;
  let options: SidebarOptions;
  let callbacks: SidebarCallbacks;

  beforeEach(() => {
    app = ObsidianStubs.App.createMock() as TestApp;
    container = document.createElement("div");

    settings = {
      feeds: [],
      folders: [],
      display: {
        sidebarRowSpacing: 10,
        sidebarRowIndentation: 20,
        sidebarItemPaddingLeft: 2,
        sidebarItemPaddingRight: 2,
      },
      media: {
        useDomainIconsRss: false,
      },
    } as unknown as RssDashboardSettings;

    options = {
      currentFolder: null,
      currentFeed: null,
      selectedTags: [],
      tagsCollapsed: true,
      collapsedFolders: [],
      selectedFolders: [],
    };

    callbacks = {
      onFolderClick: vi.fn(),
      onFeedClick: vi.fn(),
      onTagToggle: vi.fn(),
      onClearTags: vi.fn(),
      onTagFilterModeChange: vi.fn(),
      onToggleTagsCollapse: vi.fn(),
      onToggleFolderCollapse: vi.fn(),
      onAddFolder: vi.fn(),
      onAddSubfolder: vi.fn(),
      onAddFeed: vi.fn(),
      onEditFeed: vi.fn(),
      onDeleteFeed: vi.fn(),
      onDeleteFolder: vi.fn(),
      onRefreshFeeds: vi.fn(),
      onUpdateFeed: vi.fn(),
      onImportOpml: vi.fn(),
      onExportOpml: vi.fn(),
      onToggleSidebar: vi.fn(),
    };

    plugin = {
      settings,
      saveSettings: vi.fn().mockResolvedValue(undefined),
      updateArticlesReadBatch: vi.fn().mockResolvedValue(true),
      openAddSourceModal: vi.fn(),
      updateSubscription: vi.fn().mockResolvedValue(true),
      removeSubscription: vi.fn().mockResolvedValue(true),
      applySidebarOrdering: vi.fn().mockResolvedValue({ ok: true }),
      applyFolderMutation: vi.fn().mockResolvedValue({ ok: true }),
    };
  });

  it("opens verified onboarding from the sidebar add entry", () => {
    const sidebar = new Sidebar(
      app,
      container,
      plugin as unknown as RssDashboardPlugin,
      settings,
      options,
      callbacks,
    );

    (sidebar as unknown as { showAddFeedModal(folder: string): void })
      .showAddFeedModal("Research");

    expect(plugin.openAddSourceModal).toHaveBeenCalledWith({
      initialFolder: "Research",
    });
  });

  it("routes sidebar subscription editing to the unified external manager", () => {
    const open = vi.spyOn(FeedManagerModal.prototype, "open")
      .mockImplementation(() => {});
    const sidebar = new Sidebar(
      app,
      container,
      plugin as unknown as RssDashboardPlugin,
      settings,
      options,
      callbacks,
    );
    const selected = {
      feedId: "feed-1",
      title: "Feed",
      url: "https://example.com/feed.xml",
      folder: "Research",
      items: [],
      lastUpdated: 0,
    } as Feed;

    sidebar.showEditFeedModal(selected);

    expect(open).toHaveBeenCalledTimes(1);
  });

  it("routes media and folder changes through typed subscription updates without mutating on failure", async () => {
    const rss = {
      feedId: "rss-id",
      title: "RSS",
      url: "https://example.com/feed.xml",
      folder: "Old",
      items: [],
      lastUpdated: 0,
      mediaType: "article",
      sourceKind: "feed",
      sourceConfig: { kind: "feed" },
    } as Feed;
    const xAccount = {
      feedId: "x-id",
      title: "OpenAI",
      url: "tikhub://x-account/openai",
      folder: "Old",
      items: [],
      lastUpdated: 0,
      sourceKind: "x-account",
      sourceConfig: {
        kind: "x-account",
        id: "x-id",
        handle: "openai",
        includeReplies: false,
        includeReposts: false,
        folder: "Old",
        topics: [],
      },
    } as Feed;
    settings.feeds = [rss, xAccount];
    plugin.updateSubscription.mockResolvedValue(false);
    const sidebar = new Sidebar(
      app,
      container,
      plugin as unknown as RssDashboardPlugin,
      settings,
      options,
      callbacks,
    ) as unknown as TestSidebar;

    await expect(sidebar.updateSubscriptionOptions(rss, { mediaType: "video" }))
      .resolves.toBe(false);
    await expect(sidebar.updateSubscriptionOptions(xAccount, { folder: "New" }))
      .resolves.toBe(false);

    expect(plugin.updateSubscription.mock.calls).toEqual([
      ["rss-id", { kind: "feed-options", mediaType: "video" }],
      ["x-id", { kind: "x-account-options", folder: "New" }],
    ]);
    expect(rss.mediaType).toBe("article");
    expect(rss.folder).toBe("Old");
    expect(xAccount.folder).toBe("Old");
    expect(plugin.saveSettings).not.toHaveBeenCalled();
  });

  it("routes folder deletion through the single subscription folder transaction", async () => {
    settings.folders = [{ name: "Tech", subfolders: [] }] as Folder[];
    plugin.applyFolderMutation.mockResolvedValueOnce({
      ok: false,
      reason: "dragged-folder-not-found",
    });
    const sidebar = new Sidebar(
      app,
      container,
      plugin as unknown as RssDashboardPlugin,
      settings,
      options,
      callbacks,
    ) as unknown as TestSidebar;

    await expect(sidebar.deleteFolderAndSubscriptions("Tech"))
      .resolves.toBe(false);

    expect(plugin.applyFolderMutation).toHaveBeenCalledWith({
      kind: "delete",
      folderPath: "Tech",
    });
    expect(plugin.removeSubscription).not.toHaveBeenCalled();
    expect(settings.folders.map((folder) => folder.name)).toContain("Tech");
    expect(plugin.saveSettings).not.toHaveBeenCalled();
  });

  it("returns success after the atomic folder deletion publishes", async () => {
    settings.folders = [{ name: "Tech", subfolders: [] }] as Folder[];
    settings.feeds = [{
      feedId: "rss-id",
      title: "RSS",
      url: "https://example.com/feed.xml",
      folder: "Tech",
      items: [],
      lastUpdated: 0,
    } as Feed];
    plugin.applyFolderMutation.mockImplementationOnce(async () => {
      settings.feeds = [];
      settings.folders = [];
      return {
        ok: true,
        removedSourceIds: ["rss-id"],
        topicDestinationFolder: "",
      };
    });
    const sidebar = new Sidebar(
      app,
      container,
      plugin as unknown as RssDashboardPlugin,
      settings,
      options,
      callbacks,
    ) as unknown as TestSidebar;

    await expect(sidebar.deleteFolderAndSubscriptions("Tech"))
      .resolves.toBe(true);

    expect(settings.folders.map((folder) => folder.name)).not.toContain("Tech");
    expect(plugin.applyFolderMutation).toHaveBeenCalledTimes(1);
    expect(plugin.removeSubscription).not.toHaveBeenCalled();
    expect(plugin.saveSettings).not.toHaveBeenCalled();
  });

  it("keeps controller state untouched when the atomic folder deletion fails", async () => {
    const originalFolders = [{ name: "Tech", subfolders: [] }] as Folder[];
    settings.folders = originalFolders;
    settings.feeds = [{
      feedId: "rss-id",
      title: "RSS",
      url: "https://example.com/feed.xml",
      folder: "Tech",
      items: [],
      lastUpdated: 0,
    } as Feed];
    plugin.applyFolderMutation.mockRejectedValueOnce(new Error("disk full"));
    const sidebar = new Sidebar(
      app,
      container,
      plugin as unknown as RssDashboardPlugin,
      settings,
      options,
      callbacks,
    ) as unknown as TestSidebar;

    await expect(sidebar.deleteFolderAndSubscriptions("Tech"))
      .resolves.toBe(false);

    expect(settings.folders).toBe(originalFolders);
    expect(settings.folders.map((folder) => folder.name)).toContain("Tech");
    expect(plugin.removeSubscription).not.toHaveBeenCalled();
    expect(plugin.saveSettings).not.toHaveBeenCalled();
  });

  it("keeps live feed ordering untouched while a drag transaction is pending", async () => {
    settings.folders = [
      { name: "Old", subfolders: [] },
      { name: "New", subfolders: [] },
    ] as Folder[];
    settings.feeds = [
      {
        feedId: "first",
        title: "First",
        url: "https://example.com/first.xml",
        folder: "Old",
        items: [],
        lastUpdated: 0,
      },
      {
        feedId: "target",
        title: "Target",
        url: "https://example.com/target.xml",
        folder: "New",
        items: [],
        lastUpdated: 0,
      },
    ] as Feed[];
    let release!: (value: { ok: true }) => void;
    plugin.applySidebarOrdering.mockImplementation(async () => await new Promise(
      (resolve) => { release = resolve; },
    ));
    const sidebar = new Sidebar(
      app,
      container,
      plugin as unknown as RssDashboardPlugin,
      settings,
      options,
      callbacks,
    );
    sidebar.render();
    const before = structuredClone(settings);
    const target = container.querySelector<HTMLElement>(
      '[data-feed-url="https://example.com/target.xml"]',
    )!;
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: {
        types: ["feed-url"],
        getData: (kind: string) => kind === "feed-url"
          ? "https://example.com/first.xml"
          : "",
      },
    });

    target.dispatchEvent(drop);

    expect(settings).toEqual(before);
    expect(plugin.applySidebarOrdering).toHaveBeenCalledWith({
      kind: "feed-insert",
      draggedUrl: "https://example.com/first.xml",
      targetUrl: "https://example.com/target.xml",
      placement: "after",
    });
    release({ ok: true });
    await Promise.resolve();
    await Promise.resolve();
  });

  it("routes folder rename through one atomic subscription folder mutation", async () => {
    settings.folders = [{ name: "Old", subfolders: [] }] as Folder[];
    settings.feeds = [
      {
        feedId: "first",
        title: "First",
        url: "https://example.com/first.xml",
        folder: "Old",
        items: [],
        lastUpdated: 0,
      },
      {
        feedId: "second",
        title: "Second",
        url: "https://example.com/second.xml",
        folder: "Old",
        items: [],
        lastUpdated: 0,
      },
    ] as Feed[];
    plugin.applyFolderMutation.mockResolvedValueOnce({
      ok: false,
      reason: "duplicate-folder-target",
    });
    const sidebar = new Sidebar(
      app,
      container,
      plugin as unknown as RssDashboardPlugin,
      settings,
      options,
      callbacks,
    ) as unknown as TestSidebar;

    await expect(sidebar.renameFolderByPath("Old", "New")).resolves.toBe(false);

    expect(plugin.applyFolderMutation).toHaveBeenCalledWith({
      kind: "rename",
      folderPath: "Old",
      newName: "New",
    });
    expect(plugin.updateSubscription).not.toHaveBeenCalled();
    expect(settings.feeds.map((feed) => feed.folder)).toEqual(["Old", "Old"]);
    expect(settings.folders[0].name).toBe("Old");
    expect(plugin.saveSettings).not.toHaveBeenCalled();
  });

  it("does not perform controller compensation when atomic rename rejects", async () => {
    const originalFolders = [{ name: "Old", subfolders: [] }] as Folder[];
    settings.folders = originalFolders;
    settings.feeds = [
      {
        feedId: "rss",
        title: "RSS",
        url: "https://example.com/feed.xml",
        folder: "Old",
        items: [],
        lastUpdated: 0,
      },
    ] as Feed[];
    plugin.applyFolderMutation.mockRejectedValueOnce(new Error("disk full"));
    const sidebar = new Sidebar(
      app,
      container,
      plugin as unknown as RssDashboardPlugin,
      settings,
      options,
      callbacks,
    ) as unknown as TestSidebar;

    await expect(sidebar.renameFolderByPath("Old", "New")).resolves.toBe(false);

    expect(settings.folders).toBe(originalFolders);
    expect(settings.feeds.map((feed) => feed.folder)).toEqual(["Old"]);
    expect(plugin.updateSubscription).not.toHaveBeenCalled();
    expect(plugin.saveSettings).not.toHaveBeenCalled();
  });

  it("renders the atomically published rename without local topic mutation", async () => {
    settings.folders = [{ name: "Old", subfolders: [] }] as Folder[];
    settings.collapsedFolders = ["Old"];
    settings.folderFeedSortOrders = {
      Old: { by: "custom", ascending: true },
    };
    settings.feeds = [{
      feedId: "topic",
      title: "Topic",
      url: "tikhub://x-topic/topic",
      folder: "Old",
      items: [],
      lastUpdated: 0,
      sourceKind: "x-topic",
      sourceConfig: { kind: "x-topic", id: "topic", name: "AI", folder: "Old" },
    } as Feed];
    plugin.applyFolderMutation.mockImplementationOnce(async () => {
      settings.folders = [{ name: "New", subfolders: [] }] as Folder[];
      settings.collapsedFolders = ["New"];
      settings.folderFeedSortOrders = {
        New: { by: "custom", ascending: true },
      };
      settings.feeds = [{
        ...settings.feeds[0],
        folder: "New",
        sourceConfig: {
          ...settings.feeds[0].sourceConfig,
          folder: "New",
        } as Feed["sourceConfig"],
      }];
      return { ok: true, newPath: "New" };
    });
    const sidebar = new Sidebar(
      app,
      container,
      plugin as unknown as RssDashboardPlugin,
      settings,
      options,
      callbacks,
    ) as unknown as TestSidebar;

    await expect(sidebar.renameFolderByPath("Old", "New")).resolves.toBe(true);

    expect(plugin.updateSubscription).not.toHaveBeenCalled();
    expect(plugin.applyFolderMutation).toHaveBeenCalledWith({
      kind: "rename",
      folderPath: "Old",
      newName: "New",
    });
    expect(settings.folders[0].name).toBe("New");
    expect(settings.feeds[0].folder).toBe("New");
    expect((settings.feeds[0].sourceConfig as { folder: string }).folder).toBe("New");
    expect(settings.collapsedFolders).toEqual(["New"]);
    expect(settings.folderFeedSortOrders?.New).toEqual({
      by: "custom",
      ascending: true,
    });
    expect(settings.folderFeedSortOrders?.Old).toBeUndefined();
    expect(plugin.saveSettings).not.toHaveBeenCalled();
  });

  it("routes all-feed read changes through the status transaction batch", async () => {
    const noticeSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const unread = {
      guid: "unread-guid",
      feedUrl: "https://example.com/feed.xml",
      read: false,
    };
    settings.feeds = [{
      title: "Feed",
      url: unread.feedUrl,
      folder: "News",
      items: [unread],
      lastUpdated: 0,
    }] as Feed[];
    plugin.updateArticlesReadBatch.mockResolvedValue(false);
    const sidebar = new Sidebar(
      app,
      container,
      plugin as unknown as RssDashboardPlugin,
      settings,
      options,
      callbacks,
    ) as unknown as TestSidebar;

    await sidebar.markAllUnreadAsRead();

    expect(plugin.updateArticlesReadBatch).toHaveBeenCalledWith(
      [{ articleGuid: unread.guid, feedUrl: unread.feedUrl }],
      true,
    );
    expect(unread.read).toBe(false);
    expect(plugin.saveSettings).not.toHaveBeenCalled();
    expect(noticeSpy.mock.calls.flat().join(" ")).not.toContain("No unread");
  });

  it("routes selected-feed unread changes through the same status batch", async () => {
    const noticeSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const readItem = {
      guid: "read-guid",
      feedUrl: "https://example.com/feed.xml",
      read: true,
    };
    settings.feeds = [{
      title: "Feed",
      url: readItem.feedUrl,
      folder: "News",
      items: [readItem],
      lastUpdated: 0,
    }] as Feed[];
    options.selectedFeeds = [readItem.feedUrl];
    plugin.updateArticlesReadBatch.mockResolvedValue(false);
    const sidebar = new Sidebar(
      app,
      container,
      plugin as unknown as RssDashboardPlugin,
      settings,
      options,
      callbacks,
    ) as unknown as TestSidebar;

    await sidebar.markSelectionReadStatus(false);

    expect(plugin.updateArticlesReadBatch).toHaveBeenCalledWith(
      [{ articleGuid: readItem.guid, feedUrl: readItem.feedUrl }],
      false,
    );
    expect(readItem.read).toBe(true);
    expect(plugin.saveSettings).not.toHaveBeenCalled();
    expect(noticeSpy.mock.calls.flat().join(" ")).not.toContain("No items");
  });

  it("routes folder and feed context-menu read changes through the status batch", async () => {
    const unread = {
      guid: "context-guid",
      feedUrl: "https://example.com/feed.xml",
      read: false,
    };
    const feed = {
      title: "Feed",
      url: unread.feedUrl,
      folder: "News",
      items: [unread],
      lastUpdated: 0,
    } as Feed;
    settings.feeds = [feed];
    const sidebar = new Sidebar(
      app,
      container,
      plugin as unknown as RssDashboardPlugin,
      settings,
      options,
      callbacks,
    ) as unknown as TestSidebar;

    await expect(sidebar.markFeedsReadStatus([feed], true)).resolves.toBe(1);

    expect(plugin.updateArticlesReadBatch).toHaveBeenCalledWith(
      [{ articleGuid: unread.guid, feedUrl: unread.feedUrl }],
      true,
    );
    expect(plugin.saveSettings).not.toHaveBeenCalled();
  });

  it("should initialize with correct properties", () => {
    const sidebar = new Sidebar(
      app,
      container,
      plugin as unknown as RssDashboardPlugin,
      settings,
      options,
      callbacks,
    );
    expect(sidebar).toBeDefined();
    const ts = sidebar as unknown as TestSidebar;
    // Accessing private members via typed boundary
    expect(ts.app).toBe(app);
    expect(ts.container).toBe(container);
    expect(ts.settings).toBe(settings);
    expect(ts.options).toBe(options);
  });

  describe("renderFallbackFeedIcon", () => {
    let sidebar: Sidebar;
    let iconEl: HTMLElement;

    beforeEach(() => {
      sidebar = new Sidebar(
        app,
        container,
        plugin as unknown as RssDashboardPlugin,
        settings,
        options,
        callbacks,
      );
      iconEl = document.createElement("div");
    });

    it("should add rss icon by default", () => {
      const ts = sidebar as unknown as TestSidebar;
      ts.renderFallbackFeedIcon(iconEl);
      expect(iconEl.dataset.icon).toBe("rss");
      expect(iconEl.classList.contains("rss-icon-hidden")).toBe(false);
    });

    it("should hide icon if setting enabled", () => {
      settings.display.hideDefaultRssIcon = true;
      const ts = sidebar as unknown as TestSidebar;
      ts.renderFallbackFeedIcon(iconEl);
      expect(iconEl.classList.contains("rss-icon-hidden")).toBe(true);
    });
  });

  describe("Folder path caching", () => {
    let sidebar: Sidebar;

    beforeEach(() => {
      sidebar = new Sidebar(
        app,
        container,
        plugin as unknown as RssDashboardPlugin,
        settings,
        options,
        callbacks,
      );
      settings.folders = [
        { name: "folder1", subfolders: [] },
        { name: "folder2", subfolders: [] },
      ] as Folder[];
    });

    it("should cache folder paths after first call", () => {
      const ts = sidebar as unknown as TestSidebar;
      expect(ts.cachedFolderPaths).toBeNull();
      const paths = ts.getCachedFolderPaths();
      expect(paths).toContain("folder1");
      expect(ts.cachedFolderPaths).not.toBeNull();
    });

    it("should clear cache when clearFolderPathCache is called", () => {
      const ts = sidebar as unknown as TestSidebar;
      ts.getCachedFolderPaths();
      sidebar.clearFolderPathCache();
      expect(ts.cachedFolderPaths).toBeNull();
    });
  });

  describe("renderHeader basics", () => {
    it("should render sidebar header container", () => {
      const sidebar = new Sidebar(
        app,
        container,
        plugin as unknown as RssDashboardPlugin,
        settings,
        options,
        callbacks,
      );
      const headerSurface = document.createElement("div");
      const ts = sidebar as unknown as TestSidebar;
      ts.renderHeader(headerSurface);

      const header = headerSurface.querySelector(
        ".rss-dashboard-sidebar-header",
      );
      expect(header).toBeDefined();
    });
  });

  describe("lifecycle", () => {
    it("should disconnect resizeObserver on destroy", () => {
      const sidebar = new Sidebar(
        app,
        container,
        plugin as unknown as RssDashboardPlugin,
        settings,
        options,
        callbacks,
      );
      const mockObserver = { disconnect: vi.fn() };
      const ts = sidebar as unknown as TestSidebar;
      ts.resizeObserver = mockObserver as unknown as ResizeObserver;

      sidebar.destroy();
      expect(mockObserver.disconnect).toHaveBeenCalled();
      expect(ts.resizeObserver).toBeNull();
    });
  });

  describe("sidebar keyboard navigation", () => {
    beforeEach(() => {
      document.body.appendChild(container);
      settings.folders = [
        { name: "Folder 1", subfolders: [] },
        { name: "Folder 2", subfolders: [] },
      ] as Folder[];
      settings.feeds = [
        {
          title: "Feed 1",
          url: "https://example.com/feed-1.xml",
          folder: "Folder 1",
          items: [{ read: false }],
        } as Feed,
        {
          title: "Feed 2",
          url: "https://example.com/feed-2.xml",
          folder: "Folder 2",
          items: [{ read: false }],
        } as Feed,
      ];
    });

    it("focuses the current feed by default and scrolls it into view", () => {
      options.currentFeed = settings.feeds[1];
      const scrollIntoViewSpy = vi.spyOn(Element.prototype, "scrollIntoView");
      const sidebar = new Sidebar(
        app,
        container,
        plugin as unknown as RssDashboardPlugin,
        settings,
        options,
        callbacks,
      );

      sidebar.render();
      const ts = sidebar as unknown as TestSidebar;
      ts.focusSidebar();

      expect(ts.hasKeyboardFocus()).toBe(true);
      expect(ts.focusedSidebarTarget).toEqual({
        type: "feed",
        url: "https://example.com/feed-2.xml",
      });
      expect(scrollIntoViewSpy).toHaveBeenCalledWith({
        block: "nearest",
        behavior: "auto",
      });
    });

    it("moves up and down visible rows and opens the focused feed", () => {
      const sidebar = new Sidebar(
        app,
        container,
        plugin as unknown as RssDashboardPlugin,
        settings,
        options,
        callbacks,
      );

      sidebar.render();
      const ts = sidebar as unknown as TestSidebar;
      ts.focusSidebar();
      ts.moveFocusToNextItem();
      ts.moveFocusToNextItem();
      ts.openFocusedItem();

      expect(ts.focusedSidebarTarget).toEqual({
        type: "feed",
        url: "https://example.com/feed-1.xml",
      });
      expect(callbacks.onFeedClick).toHaveBeenCalledWith(settings.feeds[0]);

      ts.moveFocusToPreviousItem();
      expect(ts.focusedSidebarTarget).toEqual({
        type: "folder",
        path: "Folder 1",
      });
    });

    it("jumps between folders from both folder and feed rows", () => {
      const sidebar = new Sidebar(
        app,
        container,
        plugin as unknown as RssDashboardPlugin,
        settings,
        options,
        callbacks,
      );

      sidebar.render();
      const ts = sidebar as unknown as TestSidebar;
      ts.focusSidebar();
      ts.jumpToNextFolder();

      expect(ts.focusedSidebarTarget).toEqual({
        type: "folder",
        path: "Folder 1",
      });

      ts.moveFocusToNextItem();
      expect(ts.focusedSidebarTarget).toEqual({
        type: "feed",
        url: "https://example.com/feed-1.xml",
      });

      ts.jumpToNextFolder();
      expect(ts.focusedSidebarTarget).toEqual({
        type: "folder",
        path: "Folder 2",
      });

      ts.jumpToPreviousFolder();
      expect(ts.focusedSidebarTarget).toEqual({
        type: "folder",
        path: "Folder 1",
      });
    });
  });

  describe("refresh progress rendering", () => {
    function createFeed(overrides: Partial<Feed> = {}): Feed {
      return {
        title: "Feed A",
        url: "https://example.com/a.xml",
        folder: "",
        items: [],
        lastUpdated: 0,
        mediaType: "article",
        ...overrides,
      };
    }

    it("shows the all-feeds spinner and per-feed queued/processing indicators from plugin refresh state", () => {
      const processingFeed = createFeed({
        title: "Processing Feed",
        url: "https://example.com/processing.xml",
      });
      const queuedFeed = createFeed({
        title: "Queued Feed",
        url: "https://example.com/queued.xml",
      });

      settings.feeds = [processingFeed, queuedFeed];
      plugin.activeRefreshState = new Map([
        [processingFeed.url, { status: "processing", startedAt: Date.now() }],
        [queuedFeed.url, { status: "pending", startedAt: Date.now() }],
      ]);

      const sidebar = new Sidebar(
        app,
        container,
        plugin as unknown as RssDashboardPlugin,
        settings,
        options,
        callbacks,
      );
      sidebar.render();

      const allFeedsIcon = container.querySelector(
        ".rss-dashboard-all-feeds-icon",
      );
      expect(allFeedsIcon?.classList.contains("refreshing")).toBe(true);

      const feedEls = Array.from(
        container.querySelectorAll(".rss-dashboard-feed"),
      );
      const processingEl = feedEls.find(
        (el) => el.getAttribute("data-feed-url") === processingFeed.url,
      );
      const queuedEl = feedEls.find(
        (el) => el.getAttribute("data-feed-url") === queuedFeed.url,
      );

      expect(
        processingEl
          ?.querySelector(".rss-dashboard-feed-icon")
          ?.getAttribute("data-icon"),
      ).toBe("loader-2");
      expect(processingEl?.classList.contains("processing-feed")).toBe(true);
      expect(
        queuedEl?.querySelector(".rss-dashboard-feed-processing-indicator")
          ?.textContent,
      ).toContain("⏳");
    });

    it("prefers import processing visuals over refresh visuals when both exist", () => {
      const feed = createFeed({
        title: "Imported Feed",
        url: "https://example.com/importing.xml",
      });

      settings.feeds = [feed];
      plugin.activeRefreshState = new Map([
        [feed.url, { status: "pending", startedAt: Date.now() }],
      ]);
      plugin.backgroundImportQueue = [
        {
          ...feed,
          importStatus: "processing",
        },
      ];

      const sidebar = new Sidebar(
        app,
        container,
        plugin as unknown as RssDashboardPlugin,
        settings,
        options,
        callbacks,
      );
      sidebar.render();

      const feedEl = container.querySelector(".rss-dashboard-feed");
      expect(
        feedEl
          ?.querySelector(".rss-dashboard-feed-icon")
          ?.getAttribute("data-icon"),
      ).toBe("loader-2");
      expect(
        feedEl?.querySelector(".rss-dashboard-feed-processing-indicator"),
      ).toBeNull();
    });
  });

  // ── RED: multi-folder ctrl+click selection ────────────────────────────────
  // Tests written BEFORE implementation (TDD red phase). These will fail until
  // SidebarOptions.selectedFolders and SidebarCallbacks.onFolderMultiSelect
  // are implemented in sidebar.ts.
  describe("multi-folder ctrl+click selection", () => {
    function makeSidebarWithFolders(
      folderNames: string[],
      selectedFolders: string[] = [],
    ): Sidebar {
      // Attach to DOM so click events propagate correctly.
      document.body.appendChild(container);
      settings.folders = folderNames.map(
        (name) => ({ name, subfolders: [] }) as Folder,
      );
      settings.feeds = [];
      options.selectedFolders = selectedFolders;
      callbacks.onFolderMultiSelect = vi.fn();
      return new Sidebar(
        app,
        container,
        plugin as unknown as RssDashboardPlugin,
        settings,
        options,
        callbacks,
      );
    }

    afterEach(() => {
      // Clean up DOM between tests.
      if (container.parentElement) {
        container.parentElement.removeChild(container);
      }
      container = document.createElement("div");
    });

    it("ctrl+click on a folder calls onFolderMultiSelect with that folder added to the selection", () => {
      const sidebar = makeSidebarWithFolders(["News", "Tech"]);
      sidebar.render();

      const folderHeader = container.querySelector(
        "[data-folder-path='News']",
      ) as HTMLElement;
      expect(folderHeader).not.toBeNull();

      // Dispatch a ctrl+click
      folderHeader.dispatchEvent(
        new MouseEvent("click", { bubbles: true, ctrlKey: true, button: 0 }),
      );

      expect(callbacks.onFolderMultiSelect).toHaveBeenCalledWith(["News"]);
      expect(callbacks.onFolderClick).not.toHaveBeenCalled();
    });

    it("ctrl+click a second folder appends it to the existing selection", () => {
      // Start with 'News' already selected
      const sidebar = makeSidebarWithFolders(["News", "Tech"], ["News"]);
      sidebar.render();

      const techHeader = container.querySelector(
        "[data-folder-path='Tech']",
      ) as HTMLElement;
      expect(techHeader).not.toBeNull();

      techHeader.dispatchEvent(
        new MouseEvent("click", { bubbles: true, ctrlKey: true, button: 0 }),
      );

      expect(callbacks.onFolderMultiSelect).toHaveBeenCalledWith([
        "News",
        "Tech",
      ]);
    });

    it("ctrl+click an already-selected folder removes it from the selection", () => {
      // Start with both folders selected
      const sidebar = makeSidebarWithFolders(
        ["News", "Tech"],
        ["News", "Tech"],
      );
      sidebar.render();

      const newsHeader = container.querySelector(
        "[data-folder-path='News']",
      ) as HTMLElement;
      newsHeader.dispatchEvent(
        new MouseEvent("click", { bubbles: true, ctrlKey: true, button: 0 }),
      );

      // After removing 'News', only 'Tech' should remain
      expect(callbacks.onFolderMultiSelect).toHaveBeenCalledWith(["Tech"]);
    });

    it("plain click on a folder calls onFolderClick (not onFolderMultiSelect)", () => {
      const sidebar = makeSidebarWithFolders(["News", "Tech"], ["News"]);
      sidebar.render();

      const techHeader = container.querySelector(
        "[data-folder-path='Tech']",
      ) as HTMLElement;
      techHeader.dispatchEvent(
        new MouseEvent("click", { bubbles: true, ctrlKey: false, button: 0 }),
      );

      expect(callbacks.onFolderMultiSelect).not.toHaveBeenCalled();
      expect(callbacks.onFolderClick).toHaveBeenCalledWith("Tech");
    });

    it("renders the multi-selected CSS class on folders in selectedFolders", () => {
      const sidebar = makeSidebarWithFolders(
        ["News", "Tech", "Science"],
        ["News", "Science"],
      );
      sidebar.render();

      const newsHeader = container.querySelector(
        "[data-folder-path='News']",
      ) as HTMLElement;
      const techHeader = container.querySelector(
        "[data-folder-path='Tech']",
      ) as HTMLElement;
      const scienceHeader = container.querySelector(
        "[data-folder-path='Science']",
      ) as HTMLElement;

      expect(newsHeader.classList.contains("multi-selected")).toBe(true);
      expect(scienceHeader.classList.contains("multi-selected")).toBe(true);
      expect(techHeader.classList.contains("multi-selected")).toBe(false);
    });

    it("does not add multi-selected class when selectedFolders is empty", () => {
      const sidebar = makeSidebarWithFolders(["News", "Tech"], []);
      sidebar.render();

      const allHeaders = Array.from(
        container.querySelectorAll(".rss-dashboard-feed-folder-header"),
      );
      expect(
        allHeaders.every((h) => !h.classList.contains("multi-selected")),
      ).toBe(true);
    });

    it("meta+click (macOS) also triggers multi-select", () => {
      const sidebar = makeSidebarWithFolders(["News"]);
      sidebar.render();

      const folderHeader = container.querySelector(
        "[data-folder-path='News']",
      ) as HTMLElement;
      folderHeader.dispatchEvent(
        new MouseEvent("click", { bubbles: true, metaKey: true, button: 0 }),
      );

      expect(callbacks.onFolderMultiSelect).toHaveBeenCalledWith(["News"]);
      expect(callbacks.onFolderClick).not.toHaveBeenCalled();
    });
  });
});
