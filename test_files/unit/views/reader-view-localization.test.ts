import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReaderView } from "../../../src/views/reader-view";
import { DEFAULT_SETTINGS } from "../../../src/types/types";
import type { FeedItem } from "../../../src/types/types";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";

type ReaderInternals = {
  contentEl: HTMLElement;
  readingContainer: HTMLElement;
  readOrFetchExplicitArticleContent(item: FeedItem): Promise<{
    content: string;
    failureType: "none";
  }>;
  displayVideo(item: FeedItem): Promise<void>;
  prependFallbackHeroForSavedMarkdown(item: FeedItem, html: string): string;
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

  it("localizes video-podcast fallback, related heading, and empty state", async () => {
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
    expect(root.querySelector("video")?.textContent).toContain("您的浏览器不支持视频播放。");
    expect(root.querySelector("h4")?.textContent).toBe("来自同一频道");
    expect(root.querySelector(".rss-video-related-empty")?.textContent).toBe("未找到相关视频");
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
    expect(root.querySelector(".rss-reader-error")?.textContent).toBe(expected);
    expect(open).not.toHaveBeenCalled();
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
    expect(internal.readingContainer.querySelector(".rss-reader-fallback-hero")?.getAttribute("alt")).toBe("主图");
  });
});
