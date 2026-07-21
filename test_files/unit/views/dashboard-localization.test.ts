import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "obsidian";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";
import { DEFAULT_SETTINGS } from "../../../src/types/types";
import type { CollectedItem } from "../../../src/collection/collected-item";

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
  beforeEach(() => installObsidianDomPolyfills());

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
});
