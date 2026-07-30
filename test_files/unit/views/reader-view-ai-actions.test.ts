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

const panelMocks = vi.hoisted(() => ({
  controllers: [] as Array<{
    show: ReturnType<typeof vi.fn>;
    collapse: ReturnType<typeof vi.fn>;
    expand: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("../../../src/components/inline-ai-panel", async () => {
  const actual = await vi.importActual<typeof import(
    "../../../src/components/inline-ai-panel"
  )>("../../../src/components/inline-ai-panel");
  return {
    ...actual,
    createInlineAiPanel: vi.fn(() => {
      const controller = {
        show: vi.fn(async () => undefined),
        collapse: vi.fn(),
        expand: vi.fn(),
        destroy: vi.fn(),
      };
      panelMocks.controllers.push(controller);
      return controller;
    }),
  };
});

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
  panelMocks.controllers.length = 0;
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

  it("opens operations in one reader-owned inline panel without a confirmation modal", async () => {
    const captured = captureMenus();
    const createAiPanelOptions = vi.fn(() => ({
      itemId: "c".repeat(64),
      connections: [],
      coordinator: {},
    }));
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
      { createAiPanelOptions },
    );
    (view as unknown as { contentEl: HTMLElement }).contentEl =
      document.body.createDiv();
    await view.onOpen();
    const selected = article();
    await view.displayItem(selected);
    expect(createAiPanelOptions).not.toHaveBeenCalled();
    expect(panelMocks.controllers).toHaveLength(0);

    const aiButton = document.body.querySelector<HTMLElement>(
      ".rss-reader-ai-button",
    );
    expect(aiButton?.getAttribute("title")).toBe("AI 操作");
    aiButton?.click();
    expect(captured.titles).toEqual(EXPECTED_ZH_OPERATIONS);
    captured.callbacks.get("生成摘要")?.();

    expect(createAiPanelOptions).toHaveBeenCalledWith(selected);
    expect(panelMocks.controllers).toHaveLength(1);
    const mount = document.body.querySelector<HTMLElement>(".rss-reader-ai-mount");
    expect(mount?.ownerDocument).toBe(
      (view as unknown as { readingContainer: HTMLElement }).readingContainer.ownerDocument,
    );
    expect(panelMocks.controllers[0].show).toHaveBeenCalledWith("summary");
    captured.callbacks.get("生成摘要")?.();
    expect(panelMocks.controllers).toHaveLength(1);
    expect(panelMocks.controllers[0].show).toHaveBeenCalledTimes(2);
    await view.onClose();
    expect(panelMocks.controllers[0].destroy).toHaveBeenCalledTimes(1);
  });

  it("destroys only panel UI on item switch/close and reattaches the active operation after locale refresh", async () => {
    const captured = captureMenus();
    const coordinatorAbort = vi.fn();
    const createAiPanelOptions = vi.fn((item: FeedItem) => ({
      itemId: item.rssDashboardId,
      connections: [],
      coordinator: { abort: coordinatorAbort },
    }));
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
      { createAiPanelOptions },
    );
    (view as unknown as { contentEl: HTMLElement }).contentEl =
      document.body.createDiv();
    await view.onOpen();

    const first = article();
    first.content = "<p>First body</p>";
    first.link = "https://first.substack.com/p/article";
    await view.displayItem(first);
    document.body.querySelector<HTMLElement>(".rss-reader-ai-button")?.click();
    captured.callbacks.get("Summarize")?.();
    expect(panelMocks.controllers[0].show).toHaveBeenCalledWith("summary");

    const settings = (view as unknown as { settings: typeof DEFAULT_SETTINGS }).settings;
    settings.locale = "zh-CN";
    view.refreshLocalization();
    await vi.waitFor(() => expect(panelMocks.controllers).toHaveLength(2));
    expect(panelMocks.controllers[0].destroy).toHaveBeenCalledTimes(1);
    expect(panelMocks.controllers[1].show).toHaveBeenCalledWith("summary");

    const second = { ...article(), guid: "second-guid", rssDashboardId: "d".repeat(64) };
    second.content = "<p>Second body</p>";
    second.link = "https://second.substack.com/p/article";
    await view.displayItem(second);
    expect(panelMocks.controllers[1].destroy).toHaveBeenCalledTimes(1);
    expect(panelMocks.controllers).toHaveLength(2);

    document.body.querySelector<HTMLElement>(".rss-reader-ai-button")?.click();
    captured.callbacks.get("生成摘要")?.();
    expect(panelMocks.controllers).toHaveLength(3);

    await view.onClose();
    expect(panelMocks.controllers[2].destroy).toHaveBeenCalledTimes(1);
    expect(coordinatorAbort).not.toHaveBeenCalled();
  });

  it("renders localized static guidance instead of constructing a panel for an untrusted item", async () => {
    const captured = captureMenus();
    const createAiPanelOptions = vi.fn(() => null);
    const app = {
      workspace: { getLeavesOfType: vi.fn(() => []), on: vi.fn(() => ({})) },
      vault: {},
      scope: {},
    };
    const view = new ReaderView(
      { app } as never,
      { ...DEFAULT_SETTINGS, locale: "en", useWebViewer: false },
      { saveArticle: vi.fn() } as never,
      vi.fn(),
      vi.fn(),
      { createAiPanelOptions },
    );
    (view as unknown as { contentEl: HTMLElement }).contentEl = document.body.createDiv();
    await view.onOpen();
    const untrusted = article();
    delete untrusted.rssDashboardId;
    untrusted.content = "<p>Body</p>";
    untrusted.link = "https://example.substack.com/p/untrusted";
    await view.displayItem(untrusted);
    expect(document.body.textContent).not.toContain("AI is unavailable for this item");
    document.body.querySelector<HTMLElement>(".rss-reader-ai-button")?.click();
    captured.callbacks.get("Summarize")?.();

    expect(panelMocks.controllers).toHaveLength(0);
    expect(document.body.textContent).toContain("AI is unavailable for this item");
  });
});
