import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReaderView } from "../../../src/views/reader-view";
import { DEFAULT_SETTINGS } from "../../../src/types/types";
import type { FeedItem } from "../../../src/types/types";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";

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
    await view.displayItem(item);
    expect((view as unknown as { readingContainer: HTMLElement }).readingContainer
      .querySelector(".rss-reader-content-basis")?.textContent).toBe("订阅源正文");
    expect("feed").toBe("feed");
  });
});
