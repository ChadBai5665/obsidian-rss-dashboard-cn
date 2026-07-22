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
  return {
    ...JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
    locale: "en",
  } as RssDashboardSettings;
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
  setCollectionSection(
    section: "today" | "subscriptions" | "starred" | "saved",
  ): void;
  getCollectionSectionItems(): CollectedItem[];
  setCollectionQueryText(text: string): void;
  renderCollectionSections(container: HTMLElement): void;
  actionRefreshAllSources(): Promise<void>;
  actionRefreshFailedSources(): Promise<void>;
  actionRefreshCollectionSource(sourceId: string): Promise<void>;
}

async function makeView(input: { items: CollectedItem[]; feeds?: Feed[] }) {
  const { RssDashboardView } =
    await import("../../../src/views/dashboard-view");
  const app = new App();
  const plugin = {
    settings: { ...settings(), feeds: input.feeds ?? [feed("subscribed")] },
    saveSettings: vi.fn(async () => {}),
    getCollectedItemsForDate: vi.fn(async () => input.items),
    manualRefreshAllSources: vi.fn(async () => {}),
    manualRefreshFailedSources: vi.fn(async () => {}),
    manualRefreshSourceById: vi.fn(async () => {}),
  };
  const leaf = { app } as unknown as import("obsidian").WorkspaceLeaf;
  const view = new RssDashboardView(
    leaf,
    plugin as never,
  ) as unknown as CollectionDashboardTestApi;
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

  it("reflects a reloaded durable flag snapshot in the active section immediately", async () => {
    const { view, plugin } = await makeView({
      items: [item({ id: "stable", starred: false })],
    });
    await view.loadCollectionItems();
    view.setCollectionSection("starred");
    expect(view.getCollectionSectionItems()).toEqual([]);

    plugin.getCollectedItemsForDate.mockResolvedValueOnce([
      item({ id: "stable", starred: true }),
    ]);
    await view.loadCollectionItems();

    expect(view.getCollectionSectionItems().map((entry) => entry.id)).toEqual([
      "stable",
    ]);
  });

  it("routes all, failed, and a source-row refresh through the plugin pipeline", async () => {
    const { view, plugin } = await makeView({ items: [] });

    await view.actionRefreshAllSources();
    await view.actionRefreshFailedSources();
    await view.actionRefreshCollectionSource("subscribed");

    expect(plugin.manualRefreshAllSources).toHaveBeenCalledTimes(1);
    expect(plugin.manualRefreshFailedSources).toHaveBeenCalledTimes(1);
    expect(plugin.manualRefreshSourceById).toHaveBeenCalledWith("subscribed");
  });

  it("does not render after a collection read completes for a closed dashboard", async () => {
    let resolveItems: ((items: CollectedItem[]) => void) | undefined;
    const itemsPromise = new Promise<CollectedItem[]>((resolve) => {
      resolveItems = resolve;
    });
    const { view, plugin } = await makeView({ items: [] });
    plugin.getCollectedItemsForDate.mockReturnValueOnce(itemsPromise);

    const loading = view.loadCollectionItems();
    view.render.mockClear();
    await view.onClose();
    resolveItems?.([item({ id: "late" })]);
    await loading;

    expect(view.render).not.toHaveBeenCalled();
  });

  it("renders source type, topic, and read controls that compose with text filtering", async () => {
    const { view } = await makeView({
      items: [
        item({
          id: "youtube-read",
          sourceType: "youtube",
          topics: ["AI"],
          read: true,
          title: "AI video",
        }),
        item({
          id: "youtube-unread",
          sourceType: "youtube",
          topics: ["Markets"],
          read: false,
          title: "AI market video",
        }),
        item({
          id: "rss-read",
          sourceType: "rss",
          topics: ["AI"],
          read: true,
          title: "AI RSS",
        }),
      ],
    });
    await view.loadCollectionItems();
    view.render.mockClear();
    const root = document.body.createDiv();
    view.renderCollectionSections(root);

    root
      .querySelector<HTMLButtonElement>(
        '[data-collection-source-type="youtube"]',
      )
      ?.click();
    root
      .querySelector<HTMLButtonElement>('[data-collection-topic="AI"]')
      ?.click();
    const read = root.querySelector<HTMLSelectElement>(
      ".rss-dashboard-collection-read-filter",
    );
    expect(read).not.toBeNull();
    if (read) {
      read.value = "read";
      read.dispatchEvent(new Event("change"));
    }

    expect(view.getCollectionSectionItems().map((entry) => entry.id)).toEqual([
      "youtube-read",
    ]);
  });

  it("composes account, topic, observation, date, starred, saved, and read filters", async () => {
    const matching = item({
      id: "match",
      sourceType: "x-topic",
      sourceId: "ai-apps",
      sourceName: "AI applications",
      author: "OpenAI",
      url: "https://x.com/openai/status/200",
      fetchedAt: "2026-07-22T08:00:00.000Z",
      topics: ["AI applications", "x:latest"],
      starred: true,
      saved: true,
      read: false,
      sourceMetadata: {
        kind: "x-post",
        externalUrls: [],
        observationTags: ["latest"],
      },
    });
    const { view } = await makeView({
      items: [
        matching,
        item({
          id: "other-account",
          sourceType: "x-topic",
          sourceId: "ai-apps",
          author: "Anthropic",
          url: "https://x.com/anthropicai/status/201",
          topics: ["AI applications", "x:latest"],
          starred: true,
          saved: true,
          sourceMetadata: {
            kind: "x-post",
            externalUrls: [],
            observationTags: ["latest"],
          },
        }),
        item({
          id: "other-category",
          sourceType: "x-topic",
          sourceId: "ai-apps",
          author: "OpenAI",
          url: "https://x.com/openai/status/202",
          topics: ["AI applications", "x:platform-top"],
          starred: true,
          saved: true,
          sourceMetadata: {
            kind: "x-post",
            externalUrls: [],
            observationTags: ["platform-top"],
          },
        }),
      ],
    });
    await view.loadCollectionItems();
    const root = document.body.createDiv();
    view.renderCollectionSections(root);

    root.querySelector<HTMLButtonElement>('[data-collection-account="openai"]')?.click();
    root.querySelector<HTMLButtonElement>('[data-collection-topic="AI applications"]')?.click();
    root.querySelector<HTMLButtonElement>('[data-collection-observation="latest"]')?.click();
    const date = root.querySelector<HTMLInputElement>(".rss-dashboard-collection-date-filter");
    expect(date?.value).toBe("2026-07-22");
    for (const [selector, value] of [
      [".rss-dashboard-collection-starred-filter", "yes"],
      [".rss-dashboard-collection-saved-filter", "yes"],
      [".rss-dashboard-collection-read-filter", "unread"],
    ] as const) {
      const control = root.querySelector<HTMLSelectElement>(selector);
      expect(control).not.toBeNull();
      if (control) {
        control.value = value;
        control.dispatchEvent(new Event("change"));
      }
    }

    expect(view.getCollectionSectionItems().map((entry) => entry.id)).toEqual([
      "match",
    ]);
  });

  it("updates collection search results without destroying the active input or its cursor", async () => {
    const { view } = await makeView({
      items: [
        item({ id: "one", title: "AI field note" }),
        item({ id: "two", title: "AI workflow" }),
      ],
    });
    await view.loadCollectionItems();
    view.render.mockClear();
    const root = document.body.createDiv();
    view.renderCollectionSections(root);
    const search = root.querySelector<HTMLInputElement>(
      ".rss-dashboard-collection-search",
    );
    expect(search).not.toBeNull();
    if (!search) return;

    search.focus();
    search.value = "AI";
    search.setSelectionRange(2, 2);
    search.dispatchEvent(new Event("input"));
    search.value = "AI w";
    search.setSelectionRange(4, 4);
    search.dispatchEvent(new Event("input"));

    expect(root.querySelector(".rss-dashboard-collection-search")).toBe(search);
    expect(document.activeElement).toBe(search);
    expect(search.selectionStart).toBe(4);
    expect(view.render).not.toHaveBeenCalled();
    expect(root.querySelectorAll(".rss-dashboard-collection-row")).toHaveLength(
      1,
    );
  });

  it("shows a visible loading state immediately and gives the collection area independent layout classes", async () => {
    let resolveItems: ((items: CollectedItem[]) => void) | undefined;
    const pending = new Promise<CollectedItem[]>((resolve) => {
      resolveItems = resolve;
    });
    const { view, plugin } = await makeView({ items: [] });
    plugin.getCollectedItemsForDate.mockReturnValueOnce(pending);
    view.render.mockClear();

    const loading = view.loadCollectionItems();
    expect(view.render).toHaveBeenCalledTimes(1);
    const loadingRoot = document.body.createDiv();
    view.renderCollectionSections(loadingRoot);
    expect(loadingRoot.textContent).toContain("Loading today's collection…");
    resolveItems?.([]);
    await loading;

    const root = document.body.createDiv();
    view.renderCollectionSections(root);
    expect(
      root.querySelector(".rss-dashboard-collection-sections"),
    ).not.toBeNull();
    expect(
      root.querySelector(".rss-dashboard-collection-collapse"),
    ).not.toBeNull();
    expect(root.querySelector(".rss-dashboard-collection-list")).not.toBeNull();
  });

  it("renders external collection text as text and leaves no stale rows after local result refreshes", async () => {
    const { view } = await makeView({
      items: [
        item({
          id: "safe",
          title: "<img src=x onerror=alert(1)>",
          sourceName: "<script>bad</script>",
        }),
        item({ id: "other", title: "Other" }),
      ],
    });
    await view.loadCollectionItems();
    const root = document.body.createDiv();
    view.renderCollectionSections(root);
    const search = root.querySelector<HTMLInputElement>(
      ".rss-dashboard-collection-search",
    );
    if (!search) return;

    expect(root.querySelector("img, script")).toBeNull();
    expect(root.textContent).toContain("<img src=x onerror=alert(1)>");
    search.value = "Other";
    search.dispatchEvent(new Event("input"));

    expect(root.querySelectorAll(".rss-dashboard-collection-row")).toHaveLength(
      1,
    );
    expect(root.textContent).not.toContain("<script>bad</script>");
  });
});
