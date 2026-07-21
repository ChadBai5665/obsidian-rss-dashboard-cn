import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "obsidian";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";
import {
  DEFAULT_SETTINGS,
  type Feed,
  type RssDashboardSettings,
} from "../../../src/types/types";
import type { CollectedItem } from "../../../src/collection/collected-item";

vi.mock("../../../src/utils/platform-utils", () => ({
  robustFetch: vi.fn(),
  ensureUtf8Meta: (html: string) => html,
  shouldUseMobileSidebarLayout: () => false,
}));

vi.mock("../../../src/components/article-list", () => ({
  ArticleList: class ArticleListMock {
    constructor(..._args: unknown[]) {}
    render(): void {}
    destroy(): void {}
    setEmptyStateContext(): void {}
    updateRefreshButtonText(): void {}
  },
}));

vi.mock("../../../src/components/sidebar", () => ({
  Sidebar: class SidebarMock {
    constructor(..._args: unknown[]) {}
    render(): void {}
    clearFolderPathCache(): void {}
    destroy(): void {}
  },
}));

vi.mock("../../../src/services/article-saver", () => ({
  ArticleSaver: class ArticleSaverMock {
    constructor(..._args: unknown[]) {}
  },
}));

function settings(): RssDashboardSettings {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as RssDashboardSettings;
}

function feed(feedId: string): Feed {
  return {
    feedId,
    title: feedId,
    url: `https://example.com/${feedId}`,
    folder: "",
    items: [],
    lastUpdated: 0,
  };
}

function item(overrides: Partial<CollectedItem> = {}): CollectedItem {
  return {
    schemaVersion: 1,
    id: "item",
    sourceType: "rss",
    sourceId: "subscribed",
    sourceName: "Subscribed feed",
    sourceBucket: "subscription",
    title: "Collected item",
    fetchedAt: "2026-07-22T08:00:00.000Z",
    firstSeenAt: "2026-07-22T08:00:00.000Z",
    lastSeenAt: "2026-07-22T08:00:00.000Z",
    observationType: "new",
    topics: [],
    contentBasis: "feed",
    read: false,
    starred: false,
    saved: false,
    collectionStatus: "collected",
    ...overrides,
  };
}

interface CollectionDashboardTestApi {
  render: ReturnType<typeof vi.fn>;
  loadCollectionItems(): Promise<void>;
  onClose(): Promise<void>;
  setCollectionSection(section: "today" | "subscriptions" | "starred" | "saved"): void;
  getCollectionSectionItems(): CollectedItem[];
  setCollectionQueryText(text: string): void;
  actionRefreshAllSources(): Promise<void>;
  actionRefreshFailedSources(): Promise<void>;
  actionRefreshCollectionSource(sourceId: string): Promise<void>;
}

async function makeView(input: { items: CollectedItem[]; feeds?: Feed[] }) {
  const { RssDashboardView } = await import("../../../src/views/dashboard-view");
  const app = new App();
  const plugin = {
    settings: { ...settings(), feeds: input.feeds ?? [feed("subscribed")] },
    saveSettings: vi.fn(async () => {}),
    getCollectedItemsForDate: vi.fn(async () => input.items),
    refreshFeeds: vi.fn(async () => {}),
    refreshFailedSources: vi.fn(async () => {}),
    refreshSourceById: vi.fn(async () => {}),
  };
  const leaf = { app } as unknown as import("obsidian").WorkspaceLeaf;
  const view = new RssDashboardView(leaf, plugin as never) as unknown as CollectionDashboardTestApi;
  view.render = vi.fn();
  return { view, plugin };
}

describe("Dashboard collection sections", () => {
  beforeEach(() => {
    installObsidianDomPolyfills();
    document.body.empty();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T10:00:00+08:00"));
  });

  it("reads the complete local-day collection, then exposes Today and current subscriptions separately", async () => {
    const { view, plugin } = await makeView({
      items: [
        item({ id: "current", sourceId: "subscribed" }),
        item({ id: "deleted", sourceId: "deleted-source" }),
      ],
    });

    await view.loadCollectionItems();
    expect(plugin.getCollectedItemsForDate).toHaveBeenCalledWith("2026-07-22");
    expect(view.getCollectionSectionItems().map((entry) => entry.id)).toEqual([
      "current",
      "deleted",
    ]);

    view.setCollectionSection("subscriptions");
    expect(view.getCollectionSectionItems().map((entry) => entry.id)).toEqual([
      "current",
    ]);
  });

  it("uses durable collection flags for Starred and Saved, with neutral text filtering", async () => {
    const { view } = await makeView({
      items: [
        item({ id: "starred", starred: true, title: "AI field notes" }),
        item({ id: "saved", saved: true, title: "AI saved notes" }),
        item({ id: "plain", title: "Other" }),
      ],
    });
    await view.loadCollectionItems();

    view.setCollectionSection("starred");
    expect(view.getCollectionSectionItems().map((entry) => entry.id)).toEqual([
      "starred",
    ]);
    view.setCollectionSection("saved");
    view.setCollectionQueryText("AI");
    expect(view.getCollectionSectionItems().map((entry) => entry.id)).toEqual([
      "saved",
    ]);
  });

  it("routes all, failed, and a source-row refresh through the plugin pipeline", async () => {
    const { view, plugin } = await makeView({ items: [] });

    await view.actionRefreshAllSources();
    await view.actionRefreshFailedSources();
    await view.actionRefreshCollectionSource("subscribed");

    expect(plugin.refreshFeeds).toHaveBeenCalledTimes(1);
    expect(plugin.refreshFailedSources).toHaveBeenCalledTimes(1);
    expect(plugin.refreshSourceById).toHaveBeenCalledWith("subscribed");
  });

  it("does not render after a collection read completes for a closed dashboard", async () => {
    let resolveItems: ((items: CollectedItem[]) => void) | undefined;
    const itemsPromise = new Promise<CollectedItem[]>((resolve) => {
      resolveItems = resolve;
    });
    const { view, plugin } = await makeView({ items: [] });
    plugin.getCollectedItemsForDate.mockReturnValueOnce(itemsPromise);

    const loading = view.loadCollectionItems();
    await view.onClose();
    resolveItems?.([item({ id: "late" })]);
    await loading;

    expect(view.render).not.toHaveBeenCalled();
  });
});
