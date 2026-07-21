import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "obsidian";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";
import { DEFAULT_SETTINGS } from "../../../src/types/types";
import type { CollectedItem } from "../../../src/collection/collected-item";
import type { Feed, FeedItem, KeywordFilterRule } from "../../../src/types/types";

type DashboardInternals = {
  collectionItems: CollectedItem[];
  renderCollectionResults(container: HTMLElement): void;
  render(): Promise<void>;
  openArticleInExternalBrowser(article: FeedItem): void;
  articleList: { updateArticleInPlace(): void; refilter(): void } | null;
  markPageArticlesAsRead(items: FeedItem[], page: number, pages: number, size: number, total: number): Promise<void>;
  handleUpdateFeed(feed: Feed): Promise<void>;
  buildKeywordFilterTooltip(
    logic: "AND" | "OR",
    rules: KeywordFilterRule[],
    feedRules: Array<{ feedTitle: string; includeLogic: "AND" | "OR"; rules: KeywordFilterRule[] }>,
    bypass: boolean,
  ): string;
  inlineArticle: FeedItem | null;
  renderInlineArticle(container: HTMLElement): void;
  resolveReaderContentContext(article: FeedItem): Promise<{ contentBasis: CollectedItem["contentBasis"] } | undefined>;
  currentFolder: string | null;
  activeStatusFilters: Set<string>;
  activeTagFilters: Set<string>;
  getViewFilterReasonLabel(): string | null;
};

vi.mock("../../../src/components/article-list", () => ({
  ArticleList: class {
    render() {}
    destroy() {}
    setEmptyStateContext() {}
    updateRefreshButtonText() {}
  },
}));
vi.mock("../../../src/components/sidebar", () => ({
  Sidebar: class {
    render() {}
    destroy() {}
    clearFolderPathCache() {}
  },
}));
vi.mock("../../../src/services/article-saver", () => ({
  ArticleSaver: class {},
}));

describe("Dashboard Chinese localization", () => {
  beforeEach(() => {
    installObsidianDomPolyfills();
    vi.restoreAllMocks();
    document.body.empty();
  });

  const article = (overrides: Partial<FeedItem> = {}): FeedItem => ({
    rssDashboardId: "a".repeat(64),
    guid: "article-1",
    title: "External article title",
    link: "",
    description: "External article description",
    pubDate: "2026-07-22T00:00:00.000Z",
    read: false,
    starred: false,
    saved: false,
    tags: [],
    feedTitle: "External feed name",
    feedUrl: "https://example.com/rss",
    coverImage: "",
    ...overrides,
  });

  const collected = (id: string, sourceBucket: string): CollectedItem => ({
    schemaVersion: 1,
    id,
    sourceType: "x-topic",
    sourceId: "topic-ai",
    sourceName: "AI 应用",
    sourceBucket,
    title: id,
    fetchedAt: "2026-07-22T00:00:00.000Z",
    firstSeenAt: "2026-07-22T00:00:00.000Z",
    lastSeenAt: "2026-07-22T00:00:00.000Z",
    observationType: "new",
    topics: ["AI"],
    contentBasis: "x-post",
    read: false,
    starred: false,
    saved: false,
    collectionStatus: "collected",
  });

  it("renders the collection information architecture and controls in Chinese by default", async () => {
    const { RssDashboardView } =
      await import("../../../src/views/dashboard-view");
    const app = new App();
    const plugin = {
      settings: { ...DEFAULT_SETTINGS, locale: "zh-CN" },
      getCollectedItemsForDate: vi.fn(async () => []),
      manualRefreshAllSources: vi.fn(),
      manualRefreshFailedSources: vi.fn(),
      manualRefreshSourceById: vi.fn(),
    };
    const view = new RssDashboardView(
      { app } as never,
      plugin as never,
    ) as unknown as {
      renderCollectionSections(container: HTMLElement): void;
    };
    const root = document.body.createDiv();
    view.renderCollectionSections(root);

    expect(root.textContent).toContain("今日采集");
    expect(root.textContent).toContain("我的订阅");
    expect(root.textContent).toContain("主题发现");
    expect(root.textContent).toContain("已加星标");
    expect(root.textContent).toContain("已保存");
    expect(root.querySelector("input")?.getAttribute("placeholder")).toBe(
      "搜索已采集内容",
    );
    expect(root.textContent).toContain("刷新全部");
  });

  it("shows topic candidates separately and states the platform-top boundary", async () => {
    const { RssDashboardView } =
      await import("../../../src/views/dashboard-view");
    const app = new App();
    const plugin = {
      settings: { ...DEFAULT_SETTINGS, locale: "zh-CN" },
      getCollectedItemsForDate: vi.fn(async () => []),
    };
    const view = new RssDashboardView(
      { app } as never,
      plugin as never,
    ) as unknown as {
      collectionItems: CollectedItem[];
      collectionSection: "topic-discovery";
      getCollectionSectionItems(): CollectedItem[];
      renderCollectionSections(container: HTMLElement): void;
    };
    view.collectionItems = [
      collected("subscribed", "subscribed"),
      collected("latest", "topic-latest"),
      collected("top", "topic-top"),
    ];

    view.collectionSection = "topic-discovery";
    expect(view.getCollectionSectionItems().map((item) => item.id)).toEqual([
      "latest",
      "top",
    ]);

    const root = document.body.createDiv();
    view.renderCollectionSections(root);
    expect(root.textContent).toContain("平台热门仅表示平台返回顺序");
  });

  it("keeps the same controls in English when explicitly selected", async () => {
    const { RssDashboardView } =
      await import("../../../src/views/dashboard-view");
    const app = new App();
    const plugin = { settings: { ...DEFAULT_SETTINGS, locale: "en" } };
    const view = new RssDashboardView(
      { app } as never,
      plugin as never,
    ) as unknown as {
      renderCollectionSections(container: HTMLElement): void;
    };
    const root = document.body.createDiv();
    view.renderCollectionSections(root);
    expect(root.textContent).toContain("Today's collection");
    expect(root.querySelector("input")?.getAttribute("placeholder")).toBe(
      "Search collected items",
    );
  });

  it("renders the persisted collection content basis on each collection row", async () => {
    const { RssDashboardView } = await import("../../../src/views/dashboard-view");
    const app = new App();
    const plugin = { settings: { ...DEFAULT_SETTINGS, locale: "zh-CN" } };
    const view = new RssDashboardView({ app } as never, plugin as never) as unknown as DashboardInternals;
    const stored = collected("stored", "subscribed");
    stored.contentBasis = "linked-page";
    view.collectionItems = [stored];
    const root = document.body.createDiv();
    view.renderCollectionResults(root);

    expect(root.querySelector(".rss-dashboard-collection-content-basis")?.textContent).toBe("链接页面");
    expect(stored.contentBasis).toBe("linked-page");
  });

  it("localizes real external-link, bulk-read, and feed-refresh lifecycle notices", async () => {
    const { RssDashboardView } = await import("../../../src/views/dashboard-view");
    const app = new App();
    const plugin = {
      settings: {
        ...DEFAULT_SETTINGS,
        locale: "zh-CN",
        feeds: [{
          title: "External feed name", url: "https://example.com/rss", folder: "", items: [], lastUpdated: 0,
        }],
      },
      updateArticlesReadBatch: vi.fn(async () => true),
      saveSettings: vi.fn(async () => {}),
      feedParser: { parseFeed: vi.fn(async () => null) },
    };
    const view = new RssDashboardView({ app } as never, plugin as never) as unknown as DashboardInternals;
    vi.spyOn(view, "render").mockResolvedValue(undefined);
    const notices: string[] = [];
    vi.spyOn(console, "debug").mockImplementation((_prefix, message) => notices.push(String(message)));

    view.openArticleInExternalBrowser(article());
    view.articleList = { updateArticleInPlace() {}, refilter() {} };
    await view.markPageArticlesAsRead([], 1, 1, 20, 0);
    await view.handleUpdateFeed(plugin.settings.feeds[0]);
    plugin.feedParser.parseFeed.mockRejectedValueOnce("External non-error failure" as never);
    await view.handleUpdateFeed(plugin.settings.feeds[0]);

    expect(notices).toEqual(expect.arrayContaining([
      "此条目没有可用的外部链接。",
      "当前页没有未读内容",
      "正在更新订阅源“External feed name”…",
      "订阅源“External feed name”已更新",
      "更新订阅源“External feed name”时出错：未知错误",
    ]));
  });

  it("localizes keyword-rule details while preserving external feed names and rule text", async () => {
    const { RssDashboardView } = await import("../../../src/views/dashboard-view");
    const view = new RssDashboardView(
      { app: new App() } as never,
      { settings: { ...DEFAULT_SETTINGS, locale: "zh-CN" } } as never,
    ) as unknown as DashboardInternals;
    const rule = {
      id: "external-rule", keyword: "External AI phrase", type: "include" as const, matchMode: "partial" as const,
      applyToTitle: true, applyToSummary: false, applyToContent: true,
      enabled: true, createdAt: 1,
    };
    const tooltip = view.buildKeywordFilterTooltip(
      "AND", [rule], [{ feedTitle: "External feed name", includeLogic: "OR", rules: [rule] }], true,
    );

    expect(tooltip).toContain("已启用绕过关键词规则");
    expect(tooltip).toContain("全局规则（包含逻辑：AND）");
    expect(tooltip).toContain("订阅源规则：");
    expect(tooltip).toContain("External feed name");
    expect(tooltip).toContain("External AI phrase");
    expect(tooltip).toContain("包含“External AI phrase”（部分匹配）[标题, 正文]");
    expect(tooltip).toContain("标题");
    expect(tooltip).toContain("正文");
  });

  it("localizes inline-reader browser title and accessibility label", async () => {
    const { RssDashboardView } = await import("../../../src/views/dashboard-view");
    const view = new RssDashboardView(
      { app: new App() } as never,
      { settings: { ...DEFAULT_SETTINGS, locale: "zh-CN" } } as never,
    ) as unknown as DashboardInternals;
    view.inlineArticle = article({ link: "https://example.com/article" });
    const root = document.body.createDiv();
    view.renderInlineArticle(root);
    const button = root.querySelector<HTMLElement>(".rss-reader-action-button[title='在浏览器中打开']");
    expect(button?.getAttribute("aria-label")).toBe("在浏览器中打开");
    expect(root.textContent).toContain("External article title");
  });

  it("resolves reader content context from the collected record by stable id", async () => {
    const { RssDashboardView } = await import("../../../src/views/dashboard-view");
    const stored = collected("a".repeat(64), "subscribed");
    stored.contentBasis = "x-post";
    const plugin = {
      settings: { ...DEFAULT_SETTINGS, locale: "zh-CN" },
      getCollectedItemById: vi.fn(async () => stored),
    };
    const view = new RssDashboardView({ app: new App() } as never, plugin as never) as unknown as DashboardInternals;
    const feedItem = article();
    view.collectionItems = [{ ...stored, contentBasis: "feed" }];

    await expect(view.resolveReaderContentContext(feedItem)).resolves.toEqual({ contentBasis: "x-post" });
    expect(plugin.getCollectedItemById).toHaveBeenCalledWith("a".repeat(64));
    expect(feedItem).not.toHaveProperty("contentBasis");
    expect(stored.contentBasis).toBe("x-post");
  });

  it("localizes real empty-state filter reasons and preserves external tag values", async () => {
    const { RssDashboardView } = await import("../../../src/views/dashboard-view");
    const view = new RssDashboardView(
      { app: new App() } as never,
      { settings: { ...DEFAULT_SETTINGS, locale: "zh-CN" } } as never,
    ) as unknown as DashboardInternals;

    view.currentFolder = "unread";
    expect(view.getViewFilterReasonLabel()).toBe("“未读”视图筛选条件");

    view.currentFolder = null;
    view.activeStatusFilters = new Set();
    view.activeTagFilters = new Set(["External tag"]);
    expect(view.getViewFilterReasonLabel()).toBe("“External tag”标签筛选条件");

    view.activeTagFilters = new Set(["External tag", "Another external tag"]);
    expect(view.getViewFilterReasonLabel()).toBe("当前视图筛选条件");
  });

  it("localizes the saved-article leaf failure through the real lifecycle", async () => {
    const { RssDashboardView } = await import("../../../src/views/dashboard-view");
    const app = new App();
    app.workspace.getLeaf = vi.fn(() => null as never);
    const view = new RssDashboardView(
      { app } as never,
      { settings: { ...DEFAULT_SETTINGS, locale: "zh-CN", savedArticleOpenLocation: "main" } } as never,
    );
    const notices: string[] = [];
    vi.spyOn(console, "debug").mockImplementation((_prefix, message) => notices.push(String(message)));

    await view.openSavedArticleFile({ basename: "External note" } as never);

    expect(notices).toContain("打开已保存文章时出错：没有可用于打开已保存文章的工作区窗格");
  });
});
