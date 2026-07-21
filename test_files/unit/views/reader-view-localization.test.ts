import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReaderView } from "../../../src/views/reader-view";
import { DEFAULT_SETTINGS } from "../../../src/types/types";
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
});
