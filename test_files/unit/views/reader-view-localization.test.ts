import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReaderView } from "../../../src/views/reader-view";
import { DEFAULT_SETTINGS } from "../../../src/types/types";
import type { FeedItem } from "../../../src/types/types";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";
import { RESTRICTED_ARTICLE_REASON } from "../../../src/utils/full-article-fetch";

type ReaderInternals = {
  contentEl: HTMLElement;
  readingContainer: HTMLElement;
  currentItem: FeedItem | null;
  displayRequestSequence: number;
  localizedReadingBindings: Map<HTMLElement, unknown>;
  readOrFetchExplicitArticleContent(item: FeedItem): Promise<{
    content: string;
    failureType: "none";
  }>;
  displayVideo(item: FeedItem, displayRequest: number): Promise<void>;
  displayPodcast(item: FeedItem, displayRequest: number): Promise<void>;
  prependFallbackHeroForSavedMarkdown(item: FeedItem, html: string): string;
  webViewerIntegration: {
    openInWebViewer(url: string, title: string): Promise<boolean>;
  } | null;
};

function makeReader(locale: "zh-CN" | "en" = "zh-CN"): ReaderView {
  const app = { workspace: { getLeavesOfType: vi.fn(() => []) }, vault: {} };
  const view = new ReaderView(
    { app } as never,
    { ...DEFAULT_SETTINGS, locale, useWebViewer: false },
    { saveArticle: vi.fn() } as never,
    vi.fn(), vi.fn(),
  );
  (view as unknown as { contentEl: HTMLElement }).contentEl = document.body.createDiv();
  return view;
}

function makeArticle(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    guid: "basis-current", title: "External title", link: "https://example.com/article",
    description: "<p>Feed fallback</p>", content: "", pubDate: "2026-07-22T00:00:00.000Z",
    read: false, starred: false, saved: false, tags: [], feedTitle: "External source",
    feedUrl: "https://example.com/rss", coverImage: "", mediaType: "article", ...overrides,
  };
}

describe("Reader Chinese localization", () => {
  beforeEach(() => installObsidianDomPolyfills());

  it("uses Chinese action labels by default and keeps English selectable", async () => {
    const app = { workspace: { getLeavesOfType: vi.fn(() => []) }, vault: {} };
    const zh = new ReaderView(
      { app } as never,
      { ...DEFAULT_SETTINGS, locale: "zh-CN" },
      { saveArticle: vi.fn() } as never,
      vi.fn(),
      vi.fn(),
    );
    (zh as unknown as { contentEl: HTMLElement }).contentEl =
      document.body.createDiv();
    await zh.onOpen();
    expect(document.body.querySelector(".rss-reader-title")?.textContent).toBe(
      "RSS 阅读器",
    );
    expect(
      document.body
        .querySelector(".rss-reader-action-button")
        ?.getAttribute("title"),
    ).toBe("保存文章");

    document.body.empty();
    const en = new ReaderView(
      { app } as never,
      { ...DEFAULT_SETTINGS, locale: "en" },
      { saveArticle: vi.fn() } as never,
      vi.fn(),
      vi.fn(),
    );
    (en as unknown as { contentEl: HTMLElement }).contentEl =
      document.body.createDiv();
    await en.onOpen();
    expect(document.body.querySelector(".rss-reader-title")?.textContent).toBe(
      "RSS reader",
    );
  });

  it("ignores spoofed localization attributes in external rich HTML", async () => {
    const view = makeReader("zh-CN");
    const internal = view as unknown as ReaderInternals;
    await view.onOpen();
    vi.spyOn(internal, "readOrFetchExplicitArticleContent").mockResolvedValue({
      content: "",
      failureType: "none",
    });
    const externalUrl = "https://external.example.com/immutable";
    const item = makeArticle({
      guid: "spoofed-localization-attributes",
      description: "",
      content: `<p id="external-spoof-text" data-rss-reader-i18n-key="reader.feedDescription">External immutable text</p><a id="external-spoof-link" data-rss-reader-i18n-key="reader.openVideoSource" data-rss-reader-i18n-attribute="href" href="${externalUrl}">External immutable link</a>`,
    });

    await view.displayItem(item);
    const externalText = internal.readingContainer.querySelector<HTMLElement>(
      "#external-spoof-text",
    );
    const externalLink = internal.readingContainer.querySelector<HTMLAnchorElement>(
      "#external-spoof-link",
    );
    const ownedSummary = internal.readingContainer.querySelector(
      ".rss-reader-description-callout summary",
    );
    expect(externalText?.textContent).toBe("External immutable text");
    expect(externalLink?.textContent).toBe("External immutable link");
    expect(externalLink?.href).toBe(externalUrl);

    (view as unknown as { settings: { locale: "zh-CN" | "en" } }).settings.locale = "en";
    view.refreshLocalization();
    expect(ownedSummary?.textContent).toBe("Feed description");
    expect(internal.readingContainer.querySelector("#external-spoof-text")).toBe(externalText);
    expect(internal.readingContainer.querySelector("#external-spoof-link")).toBe(externalLink);
    expect(externalText?.textContent).toBe("External immutable text");
    expect(externalLink?.textContent).toBe("External immutable link");
    expect(externalLink?.href).toBe(externalUrl);

    (view as unknown as { settings: { locale: "zh-CN" | "en" } }).settings.locale = "zh-CN";
    view.refreshLocalization();
    expect(ownedSummary?.textContent).toBe("订阅源简介");
    expect(externalText?.textContent).toBe("External immutable text");
    expect(externalLink?.href).toBe(externalUrl);
  });

  it("clears disconnected bindings on a new display and never registers a stale request", async () => {
    const view = makeReader("zh-CN");
    const internal = view as unknown as ReaderInternals;
    await view.onOpen();
    const fetch = vi.spyOn(internal, "readOrFetchExplicitArticleContent");
    fetch.mockResolvedValue({ content: "", failureType: "none" });

    await view.displayItem(makeArticle({
      guid: "binding-first",
      description: "",
      content: "<p>First external body</p>",
    }));
    const detachedOwnedNode = internal.readingContainer.querySelector<HTMLElement>(
      ".rss-reader-description-callout summary",
    );
    expect(internal.localizedReadingBindings.size).toBeGreaterThan(0);
    detachedOwnedNode?.remove();
    view.refreshLocalization();
    expect(internal.localizedReadingBindings.has(detachedOwnedNode!)).toBe(false);

    await view.displayItem(makeArticle({
      guid: "binding-reconnected",
      description: "",
      content: "<p>Reconnected external body</p>",
    }));
    const disconnectedOwnedNode = internal.readingContainer.querySelector(
      ".rss-reader-description-callout summary",
    );
    expect(internal.localizedReadingBindings.size).toBeGreaterThan(0);

    await view.displayItem(makeArticle({
      guid: "binding-second",
      description: "<p>Second external body</p>",
      content: "",
    }));
    expect(disconnectedOwnedNode?.isConnected).toBe(false);
    expect(internal.localizedReadingBindings.size).toBe(0);

    let finishStale!: (value: { content: string; failureType: "none" }) => void;
    fetch.mockClear();
    fetch.mockImplementationOnce(
      () => new Promise((resolve) => { finishStale = resolve; }),
    ).mockResolvedValueOnce({ content: "", failureType: "none" });
    const staleItem = makeArticle({ guid: "binding-stale", description: "" });
    const currentItem = makeArticle({
      guid: "binding-current",
      description: "<p>Current external body</p>",
    });
    const openingStale = view.displayItem(staleItem);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await view.displayItem(currentItem);
    finishStale({
      content: `<article><p>${"Stale fetched content ".repeat(30)}</p></article>`,
      failureType: "none",
    });
    await openingStale;

    expect(internal.currentItem).toBe(currentItem);
    expect(internal.readingContainer.textContent).toContain("Current external body");
    expect(internal.readingContainer.textContent).not.toContain("Stale fetched content");
    expect(
      Array.from(internal.localizedReadingBindings.keys()).every(
        (element) => element.isConnected && internal.readingContainer.contains(element),
      ),
    ).toBe(true);
  });

  it("updates open reader chrome in place without losing article, scroll, media, or content context", async () => {
    const view = makeReader("zh-CN");
    const internal = view as unknown as ReaderInternals;
    await view.onOpen();
    const item = makeArticle({ guid: "locale-live", title: "Source title" });
    vi.spyOn(internal, "readOrFetchExplicitArticleContent").mockResolvedValue({
      content: "",
      failureType: "none",
    });
    await view.displayItem(item, [], { contentBasis: "feed" });

    internal.readingContainer.scrollTop = 137;
    const media = internal.readingContainer.createEl("audio");
    media.currentTime = 42;
    Object.defineProperty(media, "paused", { configurable: true, value: false });
    const articleHeader = internal.readingContainer.querySelector(".rss-reader-article-header");
    const articleContent = internal.readingContainer.querySelector(".rss-reader-article-content");
    const originalHeaderHtml = articleHeader?.innerHTML;
    const originalContentHtml = articleContent?.innerHTML;

    (view as unknown as { settings: { locale: "zh-CN" | "en" } }).settings.locale = "en";
    view.refreshLocalization();

    expect(view.getDisplayText()).toBe("Source title");
    expect(internal.contentEl.querySelector(".rss-reader-action-button")?.getAttribute("title")).toBe("Save article");
    expect(internal.currentItem).toBe(item);
    expect(internal.readingContainer.scrollTop).toBe(137);
    expect(media.currentTime).toBe(42);
    expect(media.paused).toBe(false);
    expect(internal.readingContainer.querySelector(".rss-reader-content-basis")?.textContent).toBe("Feed content");
    expect(internal.readingContainer.querySelector(".rss-reader-article-header")).toBe(articleHeader);
    expect(internal.readingContainer.querySelector(".rss-reader-article-content")).toBe(articleContent);
    expect(articleHeader?.innerHTML).toBe(originalHeaderHtml);
    expect(articleContent?.innerHTML).toBe(originalContentHtml);
  });

  it("refreshes every rendered article-owned label zh-en-zh without changing source content or nodes", async () => {
    const view = makeReader("zh-CN");
    const internal = view as unknown as ReaderInternals;
    await view.onOpen();
    vi.spyOn(internal, "readOrFetchExplicitArticleContent").mockResolvedValue({
      content: "",
      failureType: "none",
    });
    const item = makeArticle({
      guid: "live-article-labels",
      title: "External immutable title",
      description: "",
      content: "<p>External immutable body</p>",
      restrictedReason: RESTRICTED_ARTICLE_REASON,
    });

    await view.displayItem(item, [], { contentBasis: "feed" });

    const header = internal.readingContainer.querySelector(".rss-reader-article-header");
    const content = internal.readingContainer.querySelector(".rss-reader-article-content");
    const sourceLink = internal.readingContainer.querySelector<HTMLAnchorElement>(
      ".rss-reader-paywall-banner-link",
    );
    expect(internal.readingContainer.querySelector(".rss-reader-description-callout summary")?.textContent).toBe("订阅源简介");
    expect(internal.readingContainer.querySelector(".rss-reader-description-body")?.textContent).toBe("暂无订阅源简介。");
    expect(internal.readingContainer.querySelector(".rss-reader-paywall-banner-text")?.textContent).toBe("全文可能被截断、受限或需付费访问。");
    expect(sourceLink?.textContent).toBe("前往来源页面核对。");

    (view as unknown as { settings: { locale: "zh-CN" | "en" } }).settings.locale = "en";
    view.refreshLocalization();

    expect(internal.readingContainer.querySelector(".rss-reader-description-callout summary")?.textContent).toBe("Feed description");
    expect(internal.readingContainer.querySelector(".rss-reader-description-body")?.textContent).toBe("No feed description available.");
    expect(internal.readingContainer.querySelector(".rss-reader-paywall-banner-text")?.textContent).toBe("Full article text appears to be truncated, restricted or paywalled.");
    expect(sourceLink?.textContent).toBe("Click here to double check.");
    expect(sourceLink?.href).toBe(item.link);
    expect(internal.readingContainer.querySelector(".rss-reader-article-header")).toBe(header);
    expect(internal.readingContainer.querySelector(".rss-reader-article-content")).toBe(content);
    expect(header?.textContent).toContain("External immutable title");
    expect(content?.textContent).toContain("External immutable body");

    (view as unknown as { settings: { locale: "zh-CN" | "en" } }).settings.locale = "zh-CN";
    view.refreshLocalization();
    expect(internal.readingContainer.querySelector(".rss-reader-description-callout summary")?.textContent).toBe("订阅源简介");
    expect(internal.readingContainer.querySelector(".rss-reader-paywall-banner-text")?.textContent).toBe("全文可能被截断、受限或需付费访问。");
  });

  it("refreshes the video source banner zh-en-zh while preserving its external URL", async () => {
    const view = makeReader("zh-CN");
    const internal = view as unknown as ReaderInternals;
    await view.onOpen();
    const item = makeArticle({
      guid: "video-source-live",
      mediaType: "video",
      link: "https://example.com/external-video-source",
    });

    await view.displayItem(item);
    const link = internal.readingContainer.querySelector<HTMLAnchorElement>(
      ".rss-reader-video-banner-link",
    );
    expect(internal.readingContainer.querySelector(".rss-reader-video-banner-text")?.textContent).toBe("此内容似乎是视频，请前往来源页面观看。");
    expect(link?.textContent).toBe("在来源处打开视频");

    (view as unknown as { settings: { locale: "zh-CN" | "en" } }).settings.locale = "en";
    view.refreshLocalization();
    expect(internal.readingContainer.querySelector(".rss-reader-video-banner-text")?.textContent).toBe("This item appears to be a video. Open the source page to watch.");
    expect(link?.textContent).toBe("Open video at source");
    expect(link?.href).toBe(item.link);

    (view as unknown as { settings: { locale: "zh-CN" | "en" } }).settings.locale = "zh-CN";
    view.refreshLocalization();
    expect(link?.textContent).toBe("在来源处打开视频");
  });

  it.each([
    ["video", "displayVideo", "未找到视频 ID，无法播放此视频。", "Video id not found. Cannot play this video."],
    ["podcast", "displayPodcast", "未找到音频链接，无法播放此播客。", "Audio url not found. Cannot play this podcast."],
  ] as const)("refreshes the rendered missing-%s path zh-en-zh", async (mediaType, method, zh, en) => {
    const view = makeReader("zh-CN");
    const internal = view as unknown as ReaderInternals;
    await view.onOpen();
    const item = makeArticle({
      guid: `missing-${mediaType}-live`,
      mediaType,
      description: "",
      content: "<p>External fallback body</p>",
    });
    internal.currentItem = item;
    internal.displayRequestSequence = 1;

    await internal[method](item, 1);
    const error = internal.readingContainer.querySelector(".rss-reader-error");
    expect(error?.textContent).toContain(zh);

    (view as unknown as { settings: { locale: "zh-CN" | "en" } }).settings.locale = "en";
    view.refreshLocalization();
    expect(error?.textContent).toContain(en);
    expect(internal.readingContainer.textContent).toContain("External fallback body");

    (view as unknown as { settings: { locale: "zh-CN" | "en" } }).settings.locale = "zh-CN";
    view.refreshLocalization();
    expect(error?.textContent).toContain(zh);
  });

  it("localizes the real video fallback and feed-description surfaces", async () => {
    const app = { workspace: { getLeavesOfType: vi.fn(() => []) }, vault: {} };
    const view = new ReaderView(
      { app } as never,
      { ...DEFAULT_SETTINGS, locale: "zh-CN", useWebViewer: false },
      { saveArticle: vi.fn() } as never,
      vi.fn(),
      vi.fn(),
    );
    (view as unknown as { contentEl: HTMLElement }).contentEl =
      document.body.createDiv();
    await view.onOpen();

    const item: FeedItem = {
      guid: "video-fallback",
      title: "未嵌入的视频",
      link: "https://example.com/video",
      description: "",
      content: "",
      pubDate: "2026-07-22T00:00:00.000Z",
      read: false,
      starred: false,
      saved: false,
      tags: [],
      feedTitle: "示例来源",
      feedUrl: "https://example.com/rss",
      coverImage: "",
      mediaType: "video",
    };
    await view.displayItem(item);

    const root = (view as unknown as { readingContainer: HTMLElement })
      .readingContainer;
    expect(root.querySelector(".rss-reader-video-banner")?.textContent).toContain(
      "此内容似乎是视频",
    );
    expect(root.querySelector(".rss-reader-video-banner a")?.textContent).toBe(
      "在来源处打开视频",
    );
  });

  it("shows a localized content-basis label while keeping its stored enum stable", async () => {
    const app = { workspace: { getLeavesOfType: vi.fn(() => []) }, vault: {} };
    const view = new ReaderView(
      { app } as never,
      { ...DEFAULT_SETTINGS, locale: "zh-CN", useWebViewer: false },
      { saveArticle: vi.fn() } as never,
      vi.fn(), vi.fn(),
    );
    (view as unknown as { contentEl: HTMLElement }).contentEl = document.body.createDiv();
    await view.onOpen();
    const item: FeedItem = {
      guid: "basis", title: "文章", link: "", description: "<p>订阅源正文</p>", content: "",
      pubDate: "2026-07-22T00:00:00.000Z", read: false, starred: false, saved: false,
      tags: [], feedTitle: "来源", feedUrl: "https://example.com/rss", coverImage: "", mediaType: "article",
    };
    await view.displayItem(item, [], { contentBasis: "feed" });
    expect((view as unknown as { readingContainer: HTMLElement }).readingContainer
      .querySelector(".rss-reader-content-basis")?.textContent).toBe("订阅源正文");
    expect(item).not.toHaveProperty("contentBasis");
  });

  it("updates a feed snapshot label to full text when the current open fetch succeeds", async () => {
    const view = makeReader();
    const internal = view as unknown as ReaderInternals;
    await view.onOpen();
    vi.spyOn(internal, "readOrFetchExplicitArticleContent").mockResolvedValue({
      content: `<article><p>${"Fetched current full text ".repeat(24)}</p></article>`,
      failureType: "none",
    });

    await view.displayItem(makeArticle(), [], { contentBasis: "feed" });

    expect(internal.readingContainer.querySelectorAll(".rss-reader-content-basis")).toHaveLength(1);
    expect(internal.readingContainer.querySelector(".rss-reader-content-basis")?.textContent).toBe("已取得全文");
  });

  it("downgrades a stale full-text snapshot when the current open renders the feed fallback", async () => {
    const view = makeReader();
    const internal = view as unknown as ReaderInternals;
    await view.onOpen();
    vi.spyOn(internal, "readOrFetchExplicitArticleContent").mockResolvedValue({
      content: "",
      failureType: "none",
    });

    await view.displayItem(makeArticle(), [], { contentBasis: "full-text" });

    expect(internal.readingContainer.querySelectorAll(".rss-reader-content-basis")).toHaveLength(1);
    expect(internal.readingContainer.querySelector(".rss-reader-content-basis")?.textContent).toBe("订阅源正文");
  });

  it("does not let a deferred WebViewer completion from article A mutate article B DOM or basis", async () => {
    const view = makeReader();
    const internal = view as unknown as ReaderInternals;
    (view as unknown as { settings: { useWebViewer: boolean } }).settings.useWebViewer = true;
    await view.onOpen();
    let finishFirst!: (success: boolean) => void;
    const firstViewer = new Promise<boolean>((resolve) => { finishFirst = resolve; });
    internal.webViewerIntegration = {
      openInWebViewer: vi.fn()
        .mockImplementationOnce(() => firstViewer)
        .mockResolvedValueOnce(false),
    };
    vi.spyOn(internal, "readOrFetchExplicitArticleContent")
      .mockResolvedValueOnce({
        content: `<article><p>${"Article A full text ".repeat(30)}</p></article>`,
        failureType: "none",
      })
      .mockResolvedValueOnce({ content: "", failureType: "none" });
    const first = makeArticle({ guid: "webviewer-a", title: "Article A", description: "" });
    const second = makeArticle({ guid: "webviewer-b", title: "Article B" });

    const openingFirst = view.displayItem(first, [], { contentBasis: "feed" });
    await vi.waitFor(() => expect(internal.webViewerIntegration?.openInWebViewer).toHaveBeenCalledTimes(1));
    await view.displayItem(second, [], { contentBasis: "feed" });
    const domAfterSecond = internal.readingContainer.innerHTML;
    finishFirst(true);
    await openingFirst;

    expect(internal.readingContainer.innerHTML).toBe(domAfterSecond);
    expect(internal.readingContainer.textContent).toContain("Article B");
    expect(internal.readingContainer.querySelector(".rss-reader-content-basis")?.textContent).toBe("订阅源正文");
  });

  it("does not let a deferred stale media branch overwrite the current article basis", async () => {
    const view = makeReader();
    const internal = view as unknown as ReaderInternals;
    await view.onOpen();
    let finishVideo!: () => void;
    vi.spyOn(internal, "displayVideo").mockImplementation(() =>
      new Promise<void>((resolve) => { finishVideo = resolve; }));
    vi.spyOn(internal, "readOrFetchExplicitArticleContent").mockResolvedValue({
      content: "",
      failureType: "none",
    });
    const openingVideo = view.displayItem(makeArticle({
      guid: "stale-video",
      title: "Stale video",
      mediaType: "video",
      videoId: "stale-id",
    }));
    await vi.waitFor(() => expect(internal.displayVideo).toHaveBeenCalledTimes(1));
    await view.displayItem(makeArticle({ guid: "current-article", title: "Current article" }));
    finishVideo();
    await openingVideo;

    expect(internal.readingContainer.textContent).toContain("Current article");
    expect(internal.readingContainer.querySelector(".rss-reader-content-basis")?.textContent).toBe("订阅源正文");
  });

  it.each([
    ["x-post", "X 帖子", "article"],
    ["linked-page", "链接页面", "article"],
    ["full-text", "已取得全文", "article"],
    ["title-description", "标题和摘要", "video"],
  ] as const)("renders persisted %s context across reader media branches", async (contentBasis, label, mediaType) => {
    const app = { workspace: { getLeavesOfType: vi.fn(() => []) }, vault: {} };
    const view = new ReaderView(
      { app } as never,
      { ...DEFAULT_SETTINGS, locale: "zh-CN", useWebViewer: false },
      { saveArticle: vi.fn() } as never,
      vi.fn(), vi.fn(),
    );
    const internal = view as unknown as ReaderInternals;
    (view as unknown as { contentEl: HTMLElement }).contentEl = document.body.createDiv();
    await view.onOpen();
    const item: FeedItem = {
      guid: `basis-${contentBasis}`, title: "External title", link: "", description: "<p>External description</p>", content: "",
      pubDate: "2026-07-22T00:00:00.000Z", read: false, starred: false, saved: false,
      tags: [], feedTitle: "External source", feedUrl: "https://example.com/rss", coverImage: "", mediaType,
      ...(mediaType === "video" ? { videoId: "external-video-id" } : {}),
    };
    vi.spyOn(internal, "readOrFetchExplicitArticleContent").mockResolvedValue({
      content: contentBasis === "full-text" ? `<article><p>${"External full text ".repeat(30)}</p></article>` : "",
      failureType: "none",
    });
    if (mediaType === "video") {
      vi.spyOn(internal, "displayVideo").mockImplementation(() => {
        internal.readingContainer.createDiv({ text: "External video" });
        return Promise.resolve();
      });
    }
    const context = { contentBasis };

    await view.displayItem(item, [], context);

    expect(internal.readingContainer.querySelector(".rss-reader-content-basis")?.textContent).toBe(label);
    expect(context.contentBasis).toBe(contentBasis);
    expect(item).not.toHaveProperty("contentBasis");
  });

  it("refreshes native video and related labels zh-en-zh without replacing playback", async () => {
    const app = { workspace: { getLeavesOfType: vi.fn(() => []) }, vault: {} };
    const view = new ReaderView(
      { app } as never,
      { ...DEFAULT_SETTINGS, locale: "zh-CN", useWebViewer: false, feeds: [] },
      { saveArticle: vi.fn() } as never,
      vi.fn(), vi.fn(),
    );
    (view as unknown as { contentEl: HTMLElement }).contentEl = document.body.createDiv();
    await view.onOpen();
    const item: FeedItem = {
      guid: "video-podcast", title: "External video", link: "", description: "", content: "",
      pubDate: "2026-07-22T00:00:00.000Z", read: false, starred: false, saved: false,
      tags: [], feedTitle: "External source", feedUrl: "https://example.com/rss", coverImage: "",
      mediaType: "video", videoUrl: "https://example.com/video.mp4",
    };

    await view.displayItem(item, [], { contentBasis: "title-description" });

    const root = (view as unknown as ReaderInternals).readingContainer;
    const video = root.querySelector("video")!;
    video.currentTime = 23;
    Object.defineProperty(video, "paused", { configurable: true, value: false });
    expect(root.querySelector("video")?.textContent).toContain("您的浏览器不支持视频播放。");
    expect(root.querySelector("h4")?.textContent).toBe("来自同一频道");
    expect(root.querySelector(".rss-video-related-empty")?.textContent).toBe("未找到相关视频");

    (view as unknown as { settings: { locale: "zh-CN" | "en" } }).settings.locale = "en";
    view.refreshLocalization();
    expect(root.querySelector("video")).toBe(video);
    expect(video.currentTime).toBe(23);
    expect(video.paused).toBe(false);
    expect(video.textContent).toContain("Your browser does not support the video tag.");
    expect(root.querySelector("h4")?.textContent).toBe("From the same channel");
    expect(root.querySelector(".rss-video-related-empty")?.textContent).toBe("No related videos found");

    (view as unknown as { settings: { locale: "zh-CN" | "en" } }).settings.locale = "zh-CN";
    view.refreshLocalization();
    expect(root.querySelector("video")).toBe(video);
    expect(root.querySelector("h4")?.textContent).toBe("来自同一频道");
  });

  it.each([
    ["zh-CN", "未找到视频 URL，无法播放此视频播客。"],
    ["en", "Video URL not found. Cannot play this video podcast."],
  ] as const)("routes a %s video-podcast without a URL through the localized missing-URL state", async (locale, expected) => {
    const view = makeReader(locale);
    await view.onOpen();
    const open = vi.spyOn(window, "open").mockImplementation(() => null);

    await view.displayItem(makeArticle({
      guid: `missing-video-${locale}`,
      mediaType: "video",
      mediaContentType: "video/mp4",
      videoUrl: undefined,
    }));

    const root = (view as unknown as ReaderInternals).readingContainer;
    expect(root.querySelector(".rss-reader-error")?.firstChild?.textContent).toBe(expected);
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it("renders missing video-podcast media locally without invoking WebViewer or opening a browser", async () => {
    const view = makeReader("zh-CN");
    const internal = view as unknown as ReaderInternals;
    (view as unknown as { settings: { useWebViewer: boolean } }).settings.useWebViewer = true;
    await view.onOpen();
    const openInWebViewer = vi.fn(async () => false);
    internal.webViewerIntegration = { openInWebViewer };
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const item = makeArticle({
      guid: "missing-video-local-only",
      mediaType: "video",
      mediaContentType: "video/mp4",
      videoUrl: undefined,
      link: "https://example.com/video-source",
    });

    await view.displayItem(item);

    expect(internal.readingContainer.querySelector(".rss-reader-error")?.textContent).toContain("未找到视频 URL");
    expect(internal.readingContainer.querySelector<HTMLAnchorElement>(".rss-reader-error-link")?.href).toBe(item.link);
    expect(openInWebViewer).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();

    (view as unknown as { settings: { locale: "zh-CN" | "en" } }).settings.locale = "en";
    view.refreshLocalization();
    expect(internal.readingContainer.querySelector(".rss-reader-error")?.textContent).toContain("Video URL not found");
    expect(internal.readingContainer.querySelector(".rss-reader-error-link")?.textContent).toBe("Open video at source");
    expect(internal.readingContainer.querySelector<HTMLAnchorElement>(".rss-reader-error-link")?.href).toBe(item.link);

    (view as unknown as { settings: { locale: "zh-CN" | "en" } }).settings.locale = "zh-CN";
    view.refreshLocalization();
    expect(internal.readingContainer.querySelector(".rss-reader-error-link")?.textContent).toBe("在来源处打开视频");
    open.mockRestore();
  });

  it("uses the active locale for injected and rendered hero-image alt text", async () => {
    const app = { workspace: { getLeavesOfType: vi.fn(() => []) }, vault: {} };
    const view = new ReaderView(
      { app } as never,
      { ...DEFAULT_SETTINGS, locale: "zh-CN", useWebViewer: false },
      { saveArticle: vi.fn() } as never,
      vi.fn(), vi.fn(),
    );
    const internal = view as unknown as ReaderInternals;
    const item: FeedItem = {
      guid: "hero", title: "", link: "", description: "<p>External body</p>", content: "",
      pubDate: "2026-07-22T00:00:00.000Z", read: false, starred: false, saved: false,
      tags: [], feedTitle: "External source", feedUrl: "https://example.com/rss",
      coverImage: "https://example.com/hero.jpg", mediaType: "article",
    };

    const injected = internal.prependFallbackHeroForSavedMarkdown(item, "<p>External body</p>");
    expect(injected).toContain('alt="主图"');

    internal.contentEl = document.body.createDiv();
    await view.onOpen();
    vi.spyOn(internal, "readOrFetchExplicitArticleContent").mockResolvedValue({ content: "", failureType: "none" });
    await view.displayItem(item, [], { contentBasis: "feed" });
    const hero = internal.readingContainer.querySelector(".rss-reader-fallback-hero");
    expect(hero?.getAttribute("alt")).toBe("主图");

    (view as unknown as { settings: { locale: "zh-CN" | "en" } }).settings.locale = "en";
    view.refreshLocalization();
    expect(internal.readingContainer.querySelector(".rss-reader-fallback-hero")).toBe(hero);
    expect(hero?.getAttribute("alt")).toBe("Hero image");

    (view as unknown as { settings: { locale: "zh-CN" | "en" } }).settings.locale = "zh-CN";
    view.refreshLocalization();
    expect(hero?.getAttribute("alt")).toBe("主图");
  });
});
