import { beforeEach, describe, expect, it, vi } from "vitest";
import { Menu } from "obsidian";
import { ReaderView } from "../../../src/views/reader-view";
import {
  createActionButtons,
  type CreateActionButtonArgs,
} from "../../../src/components/article-list/utils/article-actions";
import { showArticleContextMenu } from "../../../src/components/article-list/utils/article-context-menu";
import { DEFAULT_SETTINGS, type FeedItem } from "../../../src/types/types";
import type { AiOperation } from "../../../src/ai/prompts/prompt-types";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";

function article(): FeedItem {
  return {
    rssDashboardId: "c".repeat(64),
    rssDashboardSourceId: "source-id",
    title: "Selected article",
    link: "https://example.com/article",
    description: "Description",
    pubDate: "2026-07-23T00:00:00.000Z",
    guid: "selected-guid",
    read: false,
    starred: false,
    saved: false,
    tags: [],
    feedTitle: "Source",
    feedUrl: "https://example.com/feed",
    coverImage: "",
  };
}

function captureMenus() {
  const titles: string[] = [];
  const callbacks = new Map<string, () => unknown>();
  vi.spyOn(Menu.prototype, "addItem").mockImplementation(function (configure) {
    let title = "";
    const item = {
      setTitle(value: string) { title = value; titles.push(value); return this; },
      setIcon() { return this; },
      onClick(callback: () => unknown) { callbacks.set(title, callback); return this; },
    };
    configure(item as never);
    return this;
  });
  return { titles, callbacks };
}

const EXPECTED_ZH_OPERATIONS = [
  "生成摘要",
  "翻译为简体中文",
  "提取核心观点",
  "深度分析",
];

beforeEach(() => {
  installObsidianDomPolyfills();
  document.body.empty();
  vi.restoreAllMocks();
});

describe("manual AI item action surfaces", () => {
  it("exposes all four operations from the article toolbar without running one on render", () => {
    const captured = captureMenus();
    const onAiOperation = vi.fn();
    const actionToolbar = document.body.createDiv();
    const args: CreateActionButtonArgs = {
      article: article(),
      actionToolbar,
      mode: "full",
      settings: { locale: "zh-CN" },
      callbacks: { onAiOperation },
      deps: { showTagsDropdown: vi.fn() },
    };

    createActionButtons(args);

    expect(onAiOperation).not.toHaveBeenCalled();
    const aiButton = actionToolbar.querySelector<HTMLElement>(
      ".rss-dashboard-ai-toggle",
    );
    expect(aiButton?.getAttribute("title")).toBe("AI 操作");
    aiButton?.click();
    expect(captured.titles).toEqual(EXPECTED_ZH_OPERATIONS);
    captured.callbacks.get("深度分析")?.();
    expect(onAiOperation).toHaveBeenCalledWith(args.article, "deep-analysis");
  });

  it("exposes all four operations in the article context menu", () => {
    const captured = captureMenus();
    const onAiOperation = vi.fn();
    const selected = article();

    showArticleContextMenu(new MouseEvent("contextmenu"), selected, {
      callbacks: { onAiOperation },
      settings: {
        articleSaving: { saveFullContent: true },
        locale: "zh-CN",
      },
    });

    expect(captured.titles).toEqual(expect.arrayContaining(EXPECTED_ZH_OPERATIONS));
    const operationIds: AiOperation[] = [
      "summary",
      "translate-zh-cn",
      "core-points",
      "deep-analysis",
    ];
    EXPECTED_ZH_OPERATIONS.forEach((label) => captured.callbacks.get(label)?.());
    expect(onAiOperation.mock.calls.map((call) => call[1])).toEqual(operationIds);
    expect(onAiOperation.mock.calls.every((call) => call[0] === selected)).toBe(true);
  });

  it("exposes the same operations in ReaderView and forwards only the current item", async () => {
    const captured = captureMenus();
    const close = vi.fn();
    const onAiOperation = vi.fn(() => ({ close }));
    const app = {
      workspace: {
        getLeavesOfType: vi.fn(() => []),
        on: vi.fn(() => ({})),
      },
      vault: {},
      scope: {},
    };
    const view = new ReaderView(
      { app } as never,
      { ...DEFAULT_SETTINGS, locale: "zh-CN", useWebViewer: false },
      { saveArticle: vi.fn() } as never,
      vi.fn(),
      vi.fn(),
      { onAiOperation },
    );
    (view as unknown as { contentEl: HTMLElement }).contentEl =
      document.body.createDiv();
    await view.onOpen();
    const selected = article();
    (view as unknown as { currentItem: FeedItem }).currentItem = selected;

    const aiButton = document.body.querySelector<HTMLElement>(
      ".rss-reader-ai-button",
    );
    expect(aiButton?.getAttribute("title")).toBe("AI 操作");
    aiButton?.click();
    expect(captured.titles).toEqual(EXPECTED_ZH_OPERATIONS);
    captured.callbacks.get("生成摘要")?.();

    expect(onAiOperation).toHaveBeenCalledWith(selected, "summary");
    await view.onClose();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("does not invoke AI when reader has no current item", async () => {
    const captured = captureMenus();
    const onAiOperation = vi.fn();
    const app = {
      workspace: {
        getLeavesOfType: vi.fn(() => []),
        on: vi.fn(() => ({})),
      },
      vault: {},
      scope: {},
    };
    const view = new ReaderView(
      { app } as never,
      { ...DEFAULT_SETTINGS, locale: "en", useWebViewer: false },
      { saveArticle: vi.fn() } as never,
      vi.fn(),
      vi.fn(),
      { onAiOperation },
    );
    (view as unknown as { contentEl: HTMLElement }).contentEl =
      document.body.createDiv();
    await view.onOpen();

    document.body.querySelector<HTMLElement>(".rss-reader-ai-button")?.click();
    captured.callbacks.get("Summarize")?.();

    expect(onAiOperation).not.toHaveBeenCalled();
  });
});
