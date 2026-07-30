import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "obsidian";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";
import {
  DEFAULT_SETTINGS,
  type Feed,
  type FeedItem,
} from "../../../src/types/types";
import type { OperationJournalUiPort } from "../../../src/components/operation-journal-panel";
import { RssDashboardView } from "../../../src/views/dashboard-view";

vi.mock("../../../src/components/article-list", () => ({
  ArticleList: class {
    render() {}
    destroy() {}
    setEmptyStateContext() {}
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
vi.mock("../../../src/modals/feed-manager-modal", () => ({
  FeedManagerModal: class FeedManagerModalMock {
    static opened = 0;
    open() {
      FeedManagerModalMock.opened += 1;
    }
  },
}));

type DashboardTestApi = {
  renderDashboardPrimaryActions(container: HTMLElement): void;
  renderOperationJournal(container: HTMLElement): boolean;
  openOperationJournal(): void;
  closeOperationJournal(): void;
  render(): void;
  onClose(): Promise<void>;
  primaryMode:
    | { kind: "articles" }
    | { kind: "reader"; itemId: string }
    | { kind: "operation-journal" };
  previousPrimaryMode:
    | { kind: "articles" }
    | { kind: "reader"; itemId: string };
  inlineArticle: FeedItem | null;
  inlineArticleContentContext: { contentBasis: "feed" } | undefined;
  selectedArticle: FeedItem | null;
  articleRenderer: { detachAiPanel(): void } | null;
  handleFeedClick(feed: Feed): void;
  refreshLocalization(): void;
  settings: typeof DEFAULT_SETTINGS;
};

function article(): FeedItem {
  return {
    rssDashboardId: "a".repeat(64),
    guid: "reader-item",
    title: "保留的文章",
    link: "",
    description: "",
    pubDate: "2026-07-30T00:00:00.000Z",
    read: false,
    starred: false,
    saved: false,
    tags: [],
    feedTitle: "来源",
    feedUrl: "https://example.com/feed",
    coverImage: "",
  };
}

function feed(url: string, items: FeedItem[] = []): Feed {
  return {
    title: url,
    url,
    folder: "",
    items,
    lastUpdated: 0,
  };
}

function createView(ui?: OperationJournalUiPort): {
  view: DashboardTestApi;
  plugin: {
    openAddSourceModal: ReturnType<typeof vi.fn>;
    getOperationJournalUi?: () => OperationJournalUiPort;
  };
} {
  const app = new App();
  const reader = article();
  const plugin = {
    settings: {
      ...DEFAULT_SETTINGS,
      locale: "zh-CN" as const,
      feeds: [feed(reader.feedUrl, [reader]), feed("https://other.example/feed")],
    },
    openAddSourceModal: vi.fn(),
    ...(ui ? { getOperationJournalUi: () => ui } : {}),
  };
  const leaf = { app } as never;
  return {
    view: new RssDashboardView(
      leaf,
      plugin as never,
    ) as unknown as DashboardTestApi,
    plugin,
  };
}

function uiPort(): OperationJournalUiPort & {
  subscribe: ReturnType<typeof vi.fn<OperationJournalUiPort["subscribe"]>>;
  unsubscribe: ReturnType<typeof vi.fn>;
} {
  const unsubscribe = vi.fn();
  return {
    load: vi.fn(async () => ({
      operations: [],
      incompleteDates: [],
      corruptDates: [],
      truncated: false,
      health: { writeIncomplete: false, maintenanceIncomplete: false },
    })),
    subscribe: vi.fn(() => unsubscribe),
    exportSafe: vi.fn(async () => {}),
    requestClear: vi.fn(),
    unsubscribe,
  };
}

describe("dashboard operation journal mode", () => {
  beforeEach(() => {
    installObsidianDomPolyfills();
    vi.restoreAllMocks();
    document.body.empty();
  });

  it("renders add, manage, and operation journal as three obvious peer entries", () => {
    const { view } = createView(uiPort());
    const root = document.body.createDiv();
    view.renderDashboardPrimaryActions(root);

    const labels = [...root.querySelectorAll<HTMLButtonElement>("button")].map(
      (button) => button.textContent,
    );
    expect(new Set(labels)).toEqual(
      new Set(["添加订阅源", "管理订阅源", "运行记录"]),
    );
    expect(root.querySelectorAll(".rss-dashboard-primary-action")).toHaveLength(
      3,
    );
    expect(
      root.querySelector(".rss-dashboard-primary-actions")?.closest(".modal"),
    ).toBeNull();
  });

  it("replaces primary content, opens idempotently, and preserves reader mode on close", async () => {
    const ui = uiPort();
    const { view } = createView(ui);
    const render = vi.spyOn(view, "render").mockImplementation(() => {});
    const detachAiPanel = vi.fn();
    view.articleRenderer = { detachAiPanel };
    view.inlineArticle = article();

    view.openOperationJournal();
    view.openOperationJournal();
    expect(view.primaryMode).toEqual({ kind: "operation-journal" });
    expect(view.previousPrimaryMode).toEqual({
      kind: "reader",
      itemId: "reader-item",
    });
    expect(detachAiPanel).toHaveBeenCalledTimes(1);

    const content = document.body.createDiv();
    expect(view.renderOperationJournal(content)).toBe(true);
    expect(view.renderOperationJournal(content)).toBe(true);
    await Promise.resolve();
    expect(ui.subscribe).toHaveBeenCalledTimes(1);
    expect(content.querySelector(".rss-operation-journal")).not.toBeNull();
    expect(content.querySelector(".modal")).toBeNull();

    content
      .querySelector<HTMLButtonElement>(".rss-operation-journal-close")
      ?.click();
    expect(view.primaryMode).toEqual({ kind: "reader", itemId: "reader-item" });
    expect(view.inlineArticle?.guid).toBe("reader-item");
    expect(render).toHaveBeenCalled();
    expect(ui.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("restores the captured reader after a real feed navigation clears current reader state", async () => {
    const ui = uiPort();
    const { view } = createView(ui);
    vi.spyOn(view, "render").mockImplementation(() => {});
    const reader = article();
    view.inlineArticle = reader;
    view.inlineArticleContentContext = { contentBasis: "feed" };
    view.selectedArticle = reader;
    view.openOperationJournal();
    view.renderOperationJournal(document.body.createDiv());
    await Promise.resolve();

    view.handleFeedClick(feed("https://other.example/feed"));
    expect(view.inlineArticle).toBeNull();
    expect(view.selectedArticle).toBeNull();
    view.closeOperationJournal();

    expect(view.primaryMode).toEqual({ kind: "reader", itemId: "reader-item" });
    expect(view.inlineArticle?.guid).toBe("reader-item");
    expect(view.inlineArticleContentContext).toEqual({ contentBasis: "feed" });
    expect(view.selectedArticle?.guid).toBe("reader-item");
  });

  it("restores the original source item when the current feed reuses its guid", () => {
    const original = {
      ...article(),
      rssDashboardId: "a".repeat(64),
      rssDashboardSourceId: "source-a",
      title: "来源 A 的文章",
      content: "source-a-content",
      feedUrl: "https://source-a.example/feed",
    };
    const collision = {
      ...article(),
      rssDashboardId: "b".repeat(64),
      rssDashboardSourceId: "source-b",
      title: "来源 B 的同 GUID 文章",
      content: "source-b-content",
      feedUrl: "https://source-b.example/feed",
    };
    const sourceA = {
      ...feed(original.feedUrl, [original]),
      feedId: "source-a",
    };
    const sourceB = {
      ...feed(collision.feedUrl, [collision]),
      feedId: "source-b",
    };
    const { view } = createView(uiPort());
    vi.spyOn(view, "render").mockImplementation(() => {});
    view.settings.feeds = [sourceA, sourceB];
    view.inlineArticle = original;
    view.selectedArticle = original;
    view.openOperationJournal();

    view.handleFeedClick(sourceB);
    view.closeOperationJournal();

    expect(view.inlineArticle).toBe(original);
    expect(view.inlineArticle?.title).toBe("来源 A 的文章");
    expect(view.inlineArticle?.content).toBe("source-a-content");
    expect(view.selectedArticle).toBe(original);
  });

  it("keeps articles mode as a list after journal-side navigation", () => {
    const { view } = createView(uiPort());
    vi.spyOn(view, "render").mockImplementation(() => {});
    view.inlineArticle = null;
    view.openOperationJournal();
    view.handleFeedClick(feed("https://other.example/feed"));
    view.closeOperationJournal();
    expect(view.primaryMode).toEqual({ kind: "articles" });
    expect(view.inlineArticle).toBeNull();
  });

  it("disposes the panel on dashboard close", async () => {
    const ui = uiPort();
    const { view } = createView(ui);
    vi.spyOn(view, "render").mockImplementation(() => {});
    view.openOperationJournal();
    view.renderOperationJournal(document.body.createDiv());
    await Promise.resolve();

    await view.onClose();
    expect(ui.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("survives an unsubscribe throw during dashboard close", async () => {
    const ui = uiPort();
    ui.subscribe.mockReturnValue(() => {
      throw new Error("unsubscribe failed");
    });
    const { view } = createView(ui);
    vi.spyOn(view, "render").mockImplementation(() => {});
    view.openOperationJournal();
    view.renderOperationJournal(document.body.createDiv());
    await Promise.resolve();
    await expect(view.onClose()).resolves.toBeUndefined();
  });

  it("refreshes the open panel locale without another subscription or load", async () => {
    const ui = uiPort();
    const { view, plugin } = createView(ui);
    const content = document.body.createDiv();
    vi.spyOn(view, "render").mockImplementation(() => {
      content.empty();
      view.renderOperationJournal(content);
    });
    view.openOperationJournal();
    await Promise.resolve();
    expect(content.textContent).toContain("运行记录");

    plugin.settings.locale = "en";
    view.refreshLocalization();
    expect(content.textContent).toContain("Operation journal");
    expect(ui.subscribe).toHaveBeenCalledTimes(1);
    expect(ui.load).toHaveBeenCalledTimes(1);
  });

  it("shows a controlled unavailable state when Task 11 has not injected the facade", () => {
    const { view } = createView();
    vi.spyOn(view, "render").mockImplementation(() => {});
    view.openOperationJournal();
    const content = document.body.createDiv();
    expect(() => view.renderOperationJournal(content)).not.toThrow();
    expect(content.textContent).toContain("运行记录服务暂不可用");
    expect(
      content.querySelector(".rss-operation-journal-unavailable"),
    ).not.toBeNull();
  });
});
