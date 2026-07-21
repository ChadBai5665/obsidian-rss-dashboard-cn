import { beforeEach, describe, expect, it, vi } from "vitest";
import { Menu } from "obsidian";
import { Sidebar } from "../../../src/components/sidebar";
import { DEFAULT_SETTINGS } from "../../../src/types/types";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";

type SidebarInternals = {
  plugin: { activeRefreshState?: Map<string, { status: string; startedAt: number }> };
  options: { selectedFolders: string[]; selectedFeeds?: string[] };
  showFolderContextMenu(event: MouseEvent, folder: unknown, path: string, name: string): void;
  showFeedContextMenu(event: MouseEvent, feed: unknown): void;
  showTagContextMenu(event: MouseEvent, tag: unknown): void;
  markFeedsReadStatus: ReturnType<typeof vi.fn>;
  markAllUnreadAsRead(): Promise<void>;
  markAllReadAsUnread(): Promise<void>;
  showConfirmModal(message: string, onConfirm: () => void): void;
  showErrorDetailModal(error: string, feedTitle: string): void;
  deleteSelection(): void;
  sortFeedsInFolder(folder: string, by: "name", ascending: boolean): Promise<void>;
};

describe("Sidebar Chinese localization", () => {
  beforeEach(() => {
    installObsidianDomPolyfills();
    vi.restoreAllMocks();
    document.body.empty();
  });

  const makeSidebar = (locale: "zh-CN" | "en" = "zh-CN") => {
    const root = document.body.createDiv();
    const settings = {
      ...DEFAULT_SETTINGS,
      locale,
      feeds: [
        {
          title: "External feed name",
          url: "https://example.com/rss",
          folder: "External folder",
          items: [],
          lastUpdated: 0,
        },
      ],
      folders: [
        {
          name: "External folder",
          subfolders: [],
          createdAt: 1,
          modifiedAt: 2,
        },
      ],
      availableTags: [{ name: "External tag", color: "#000000" }],
    };
    const callbacks = {
      onFolderClick() {}, onFeedClick() {}, onTagToggle() {}, onClearTags() {},
      onTagFilterModeChange() {}, onToggleTagsCollapse() {}, onToggleFolderCollapse() {},
      onAddFolder() {}, onAddSubfolder() {}, onAddFeed: async () => {},
      onEditFeed() {}, onDeleteFeed() {}, onDeleteFolder() {}, onUpdateFeed() {},
      onRefreshFeeds: async () => {}, onImportOpml() {}, onExportOpml() {}, onToggleSidebar() {},
    };
    const sidebar = new Sidebar(
      { loadLocalStorage: () => "true", saveLocalStorage() {}, workspace: { trigger() {} } } as never,
      root,
      {
        settings,
        saveSettings: async () => {},
        refreshFeedsInFolder: async () => {},
        refreshFeeds: async () => {},
        cancelPendingStartupRefresh() {},
        isMultiFeedRefreshActive: false,
      } as never,
      settings,
      {
        currentFolder: null, currentFeed: null, selectedTags: [], tagsCollapsed: false,
        collapsedFolders: [], selectedFolders: [], selectedFeeds: [],
      },
      callbacks as never,
    );
    return { sidebar, root, settings };
  };

  const captureMenu = () => {
    const titles: string[] = [];
    const callbacks: Array<(event?: MouseEvent) => unknown> = [];
    vi.spyOn(Menu.prototype, "addItem").mockImplementation(function (configure) {
      const item = {
        setTitle(title: string) { titles.push(title); return this; },
        setIcon() { return this; },
        onClick(callback: (event?: MouseEvent) => unknown) { callbacks.push(callback); return this; },
      };
      configure(item as never);
      return this;
    });
    return { titles, callbacks };
  };

  it("shows the all-subscriptions navigation in Chinese by default and English on demand", () => {
    const app = { loadLocalStorage: () => "true", saveLocalStorage: () => {} };
    const callbacks = {
      onFolderClick() {},
      onFeedClick() {},
      onTagToggle() {},
      onClearTags() {},
      onTagFilterModeChange() {},
      onToggleTagsCollapse() {},
      onToggleFolderCollapse() {},
      onAddFolder() {},
      onAddSubfolder() {},
      onAddFeed: async () => {},
      onEditFeed() {},
      onDeleteFeed() {},
      onDeleteFolder() {},
      onRefreshFeeds: async () => {},
      onImportOpml() {},
      onExportOpml() {},
      onToggleSidebar() {},
    };
    const render = (locale: "zh-CN" | "en") => {
      const root = document.body.createDiv();
      const settings = { ...DEFAULT_SETTINGS, locale, feeds: [], folders: [] };
      new Sidebar(
        app as never,
        root,
        { settings, saveSettings: async () => {} } as never,
        settings,
        {
          currentFolder: null,
          currentFeed: null,
          selectedTags: [],
          tagsCollapsed: false,
          collapsedFolders: [],
          selectedFolders: [],
        },
        callbacks as never,
      ).render();
      return root;
    };
    expect(
      render("zh-CN").querySelector(".rss-dashboard-all-feeds-button")
        ?.textContent,
    ).toContain("我的订阅");
    document.body.empty();
    expect(
      render("en").querySelector(".rss-dashboard-all-feeds-button")
        ?.textContent,
    ).toContain("All Feeds");
  });

  it("localizes the real add-tag input and duplicate validation notice", () => {
    const app = {
      loadLocalStorage: () => "true",
      saveLocalStorage: () => {},
      workspace: { trigger() {} },
    };
    const root = document.body.createDiv();
    const settings = {
      ...DEFAULT_SETTINGS,
      locale: "zh-CN" as const,
      feeds: [],
      folders: [],
      availableTags: [{ name: "AI", color: "#000000" }],
    };
    const sidebar = new Sidebar(
      app as never,
      root,
      { settings, saveSettings: async () => {} } as never,
      settings,
      {
        currentFolder: null,
        currentFeed: null,
        selectedTags: [],
        tagsCollapsed: false,
        collapsedFolders: [],
        selectedFolders: [],
      },
      {
        onFolderClick() {}, onFeedClick() {}, onTagToggle() {}, onClearTags() {},
        onTagFilterModeChange() {}, onToggleTagsCollapse() {}, onToggleFolderCollapse() {},
        onAddFolder() {}, onAddSubfolder() {}, onAddFeed: async () => {},
        onEditFeed() {}, onDeleteFeed() {}, onDeleteFolder() {},
        onRefreshFeeds: async () => {}, onImportOpml() {}, onExportOpml() {}, onToggleSidebar() {},
      } as never,
    ) as unknown as { isTagsExpanded: boolean; isAddTagExpanded: boolean; render(): void };
    sidebar.isTagsExpanded = true;
    sidebar.isAddTagExpanded = true;
    sidebar.render();

    expect(root.querySelector<HTMLInputElement>(".rss-dashboard-sidebar-add-tag-input")?.placeholder).toBe("新标签…");
    expect(root.querySelector(".rss-dashboard-sidebar-add-tag-btn")?.textContent).toBe("确认");
  });

  it("localizes folder controls, toolbar accessibility, and sorting menus without translating external names", () => {
    const { sidebar, root } = makeSidebar("zh-CN");
    const menu = captureMenu();
    sidebar.render();

    expect(root.textContent).toContain("External folder");
    expect(root.querySelector(".rss-dashboard-feed-folder-toggle")?.getAttribute("aria-label")).toBe("收起文件夹");

    root.empty();
    sidebar.renderToolbar(root);
    const toolbarTitles = [...root.querySelectorAll<HTMLElement>(".rss-dashboard-toolbar-button")]
      .map((element) => [element.title, element.getAttribute("aria-label")]);
    expect(toolbarTitles).toEqual([
      ["添加文件夹", "添加文件夹"],
      ["排序文件夹", "排序文件夹"],
      ["折叠或展开所有文件夹", "折叠或展开所有文件夹"],
      ["搜索订阅源", "搜索订阅源"],
    ]);

    root.querySelectorAll<HTMLElement>(".rss-dashboard-toolbar-button")[1]?.click();
    expect(menu.titles).toEqual(expect.arrayContaining([
      "订阅源名称（A 到 Z）", "未读数量（从高到低）", "文件夹名称（A 到 Z）",
      "修改时间（从新到旧）", "创建时间（从旧到新）",
    ]));
  });

  it("localizes real folder/feed/tag/read menus and their callback notices", async () => {
    const { sidebar, settings } = makeSidebar("zh-CN");
    const internal = sidebar as unknown as SidebarInternals;
    const menu = captureMenu();
    const notices: string[] = [];
    vi.spyOn(console, "debug").mockImplementation((_prefix, message) => notices.push(String(message)));
    const event = new MouseEvent("contextmenu");

    internal.showFolderContextMenu(event, settings.folders[0], "External folder", "External folder");
    expect(menu.titles).toEqual(expect.arrayContaining([
      "刷新文件夹中的订阅源", "固定文件夹", "删除文件夹",
    ]));

    menu.titles.length = 0;
    menu.callbacks.length = 0;
    internal.showFeedContextMenu(event, settings.feeds[0]);
    const mediaAction = menu.callbacks[menu.titles.indexOf("更改媒体类型")];
    mediaAction?.(new MouseEvent("click"));
    expect(menu.titles).toEqual(expect.arrayContaining([
      "更改媒体类型", "文章", "播客", "视频", "移动到文件夹", "删除订阅源",
    ]));

    menu.titles.length = 0;
    menu.callbacks.length = 0;
    internal.showTagContextMenu(event, settings.availableTags[0]);
    expect(menu.titles).toEqual(expect.arrayContaining(["编辑标签", "删除标签"]));
    menu.callbacks[menu.titles.indexOf("编辑标签")]?.();
    expect(document.body.textContent).toContain("编辑标签");
    expect(document.body.querySelector<HTMLInputElement>(".rss-dashboard-tag-modal-name-input")?.placeholder).toBe("输入标签名称");
    expect(document.body.textContent).toContain("保存更改");

    internal.markFeedsReadStatus = vi.fn(async () => 2);
    await internal.markAllUnreadAsRead();
    await internal.markAllReadAsUnread();
    expect(notices).toEqual(expect.arrayContaining(["已将 2 条内容标记为已读", "已将 2 条内容标记为未读"]));
  });

  it("localizes real confirmation, error, and add-tag modals", () => {
    const { sidebar } = makeSidebar("zh-CN");
    const internal = sidebar as unknown as SidebarInternals;

    internal.showConfirmModal("External confirmation detail", vi.fn());
    expect(document.body.textContent).toContain("确认");
    expect(document.body.textContent).toContain("External confirmation detail");
    expect(document.body.textContent).toContain("取消");

    internal.showErrorDetailModal("External parser error", "External feed name");
    expect(document.body.textContent).toContain("订阅源错误：External feed name");
    expect(document.body.textContent).toContain("External parser error");

    sidebar.showAddTagModal();
    expect(document.body.textContent).toContain("添加新标签");
    expect(document.body.querySelector<HTMLInputElement>(".rss-dashboard-tag-modal-name-input")?.placeholder).toBe("输入标签名称");
    expect(document.body.textContent).toContain("添加标签");
  });

  it("localizes bulk deletion confirmation while preserving external names", () => {
    const { sidebar } = makeSidebar("zh-CN");
    const internal = sidebar as unknown as SidebarInternals;
    internal.options.selectedFolders = ["External folder"];
    internal.options.selectedFeeds = ["https://example.com/rss"];
    const showConfirm = vi.spyOn(internal, "showConfirmModal");
    internal.deleteSelection();
    expect(showConfirm).toHaveBeenCalledWith(
      "确定要删除 1 个文件夹和 1 个订阅源吗？",
      expect.any(Function),
    );
  });

  it("localizes tag deletion confirmation and feed-sort completion notices", async () => {
    const { sidebar, settings } = makeSidebar("zh-CN");
    const internal = sidebar as unknown as SidebarInternals;
    const menu = captureMenu();
    const showConfirm = vi.spyOn(internal, "showConfirmModal");
    const notices: string[] = [];
    vi.spyOn(console, "debug").mockImplementation((_prefix, message) => notices.push(String(message)));
    vi.spyOn(sidebar, "render").mockImplementation(() => {});

    internal.showTagContextMenu(new MouseEvent("contextmenu"), settings.availableTags[0]);
    const deleteAction = menu.callbacks[menu.titles.indexOf("删除标签")];
    deleteAction?.();
    expect(showConfirm).toHaveBeenCalledWith(
      "确定要删除标签“External tag”吗？此操作会从所有文章中移除该标签。",
      expect.any(Function),
    );

    await internal.sortFeedsInFolder("External folder", "name", true);
    expect(notices).toContain("“External folder”中的订阅源已按名称升序排列");
  });

  it("distinguishes a queued refresh from background import work", () => {
    const { sidebar, root } = makeSidebar("zh-CN");
    const internal = sidebar as unknown as SidebarInternals;
    internal.plugin.activeRefreshState = new Map([
      ["https://example.com/rss", { status: "pending", startedAt: Date.now() }],
    ]);
    sidebar.render();

    expect(root.querySelector(".rss-dashboard-feed-processing-indicator")?.getAttribute("title")).toBe("订阅源已加入刷新队列");
  });
});
