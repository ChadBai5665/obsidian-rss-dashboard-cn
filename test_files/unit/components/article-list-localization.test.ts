import { beforeEach, describe, expect, it, vi } from "vitest";
import { createActionButtons } from "../../../src/components/article-list/utils/article-actions";
import { ArticleFilterMenu } from "../../../src/components/article-filter-menu";
import { DEFAULT_SETTINGS, type FeedItem } from "../../../src/types/types";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";

describe("Article list Chinese localization", () => {
  beforeEach(() => installObsidianDomPolyfills());

  it("localizes filters and read/save/star action accessibility labels while preserving English", () => {
    const zhSettings = { ...DEFAULT_SETTINGS, locale: "zh-CN" };
    const toggle = document.body.createEl("button");
    new ArticleFilterMenu(zhSettings, new Set(), new Set(), "OR", {
      onFilterChange: vi.fn(),
    }).show(toggle);
    expect(document.body.textContent).toContain("未读");
    expect(document.body.textContent).toContain("应用");

    const toolbar = document.body.createDiv();
    const article = {
      guid: "one",
      read: false,
      starred: false,
      saved: false,
    } as FeedItem;
    createActionButtons({
      article,
      actionToolbar: toolbar,
      mode: "full",
      settings: zhSettings,
      callbacks: { onArticleUpdate: vi.fn() },
      deps: { showTagsDropdown: vi.fn() },
    });
    expect(
      toolbar
        .querySelector(".rss-dashboard-read-toggle")
        ?.getAttribute("aria-label"),
    ).toBe("标记为已读");
    expect(
      toolbar
        .querySelector(".rss-dashboard-save-toggle")
        ?.getAttribute("aria-label"),
    ).toBe("保存文章");
    expect(
      toolbar
        .querySelector(".rss-dashboard-star-toggle")
        ?.getAttribute("title"),
    ).toBe("加入星标");

    const englishToolbar = document.body.createDiv();
    createActionButtons({
      article: { ...article, guid: "english" },
      actionToolbar: englishToolbar,
      mode: "full",
      settings: { ...zhSettings, locale: "en" },
      callbacks: { onArticleUpdate: vi.fn() },
      deps: { showTagsDropdown: vi.fn() },
    });
    expect(
      englishToolbar
        .querySelector(".rss-dashboard-read-toggle")
        ?.getAttribute("aria-label"),
    ).toBe("Mark as read");
  });
});
