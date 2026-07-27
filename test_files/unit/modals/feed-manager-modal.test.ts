import { beforeEach, describe, expect, it, vi } from "vitest";
import * as obsidian from "obsidian";
import { FeedManagerModal } from "../../../src/modals/feed-manager/feed-manager-modal";
import { ImportOpmlModal } from "../../../src/modals/import-opml-modal";
import {
  createXAccountSourceConfig,
  createXTopicSourceConfig,
} from "../../../src/sources/source-config";
import {
  DEFAULT_SETTINGS,
  type Feed,
  type RssDashboardSettings,
} from "../../../src/types/types";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";
import type RssDashboardPlugin from "../../../main";

function cloneSettings(): RssDashboardSettings {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as RssDashboardSettings;
}

function feed(overrides: Partial<Feed> & Pick<Feed, "title" | "url">): Feed {
  return {
    folder: "",
    items: [],
    lastUpdated: Date.UTC(2026, 6, 27, 8, 30),
    ...overrides,
  };
}

function makePlugin(feeds: Feed[] = []) {
  const app = obsidian.App.createMock();
  const settings = cloneSettings();
  settings.feeds = feeds;
  return {
    app,
    settings,
    saveSettings: vi.fn(async () => {}),
    getActiveDashboardView: vi.fn(async () => null),
    exportOpml: vi.fn(),
    addFeed: vi.fn(async () => true),
    openAddSourceModal: vi.fn(),
    manualRefreshSourceById: vi.fn(async () => {}),
    updateSubscription: vi.fn(async () => true),
    setSubscriptionPaused: vi.fn(async () => true),
    stopSubscriptionInitialImport: vi.fn(async () => true),
    resumeSubscriptionInitialImport: vi.fn(async () => true),
    removeSubscription: vi.fn(async () => true),
  };
}

function button(container: ParentNode, text: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll("button"))
    .find((candidate) => candidate.textContent?.trim() === text);
  if (!match) throw new Error(`Missing button: ${text}`);
  return match;
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  installObsidianDomPolyfills();
  document.body.empty();
  Object.defineProperty(window, "innerWidth", {
    value: 1400,
    configurable: true,
  });
  vi.restoreAllMocks();
});

describe("FeedManagerModal", () => {
  it("closes after the OPML import modal reports import started", () => {
    const plugin = makePlugin();
    const { app } = plugin;

    const openSpy = vi
      .spyOn(ImportOpmlModal.prototype, "open")
      .mockImplementation(function (this: ImportOpmlModal) {
        (
          this as unknown as { onImportStarted?: () => void }
        ).onImportStarted?.();
      });

    const modal = new FeedManagerModal(
      app as unknown as obsidian.App,
      plugin as unknown as RssDashboardPlugin,
    );
    const closeSpy = vi.spyOn(modal, "close");
    modal.open();

    const importButton = modal.contentEl.querySelector(
      ".feed-manager-import-button",
    ) as HTMLButtonElement;
    importButton.click();

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("opens verified onboarding from its add button", () => {
    const plugin = makePlugin();
    const { app } = plugin;
    const modal = new FeedManagerModal(
      app as unknown as obsidian.App,
      plugin as unknown as RssDashboardPlugin,
    );
    modal.open();

    (modal.contentEl.querySelector(".feed-manager-add-button") as HTMLButtonElement).click();

    expect(plugin.openAddSourceModal).toHaveBeenCalledWith();
  });

  it("renders every subscription kind except X topics with stable row keys and type filtering", () => {
    const plugin = makePlugin([
      feed({
        feedId: "rss-mckinsey",
        title: "McKinsey",
        url: "https://example.com/feed.xml",
        sourceKind: "feed",
        sourceConfig: { kind: "feed" },
      }),
      feed({
        title: "Legacy podcast",
        url: "https://podcasts.example/show.xml",
        mediaType: "podcast",
      }),
      feed({
        feedId: "youtube-ai",
        title: "AI channel",
        url: "https://www.youtube.com/feeds/videos.xml?channel_id=UC123",
        mediaType: "video",
        sourceKind: "feed",
        sourceConfig: { kind: "feed" },
      }),
      feed({
        feedId: "mastodon-account",
        title: "Mastodon account",
        url: "https://mastodon.social/@news.rss",
      }),
      feed({
        feedId: "x-account-openai",
        title: "OpenAI",
        url: "tikhub://x-account/openai",
        sourceKind: "x-account",
        sourceConfig: createXAccountSourceConfig({
          id: "x-account-openai",
          handle: "openai",
          displayName: "OpenAI",
        }),
      }),
      feed({
        feedId: "x-topic-ai",
        title: "AI topic",
        url: "tikhub://x-topic/ai",
        sourceKind: "x-topic",
        sourceConfig: createXTopicSourceConfig({
          id: "x-topic-ai",
          name: "AI",
        }),
      }),
    ]);
    const modal = new FeedManagerModal(
      plugin.app as unknown as obsidian.App,
      plugin as unknown as RssDashboardPlugin,
    );
    modal.open();

    const rows = Array.from(
      modal.contentEl.querySelectorAll<HTMLElement>(".rss-subscription-row"),
    );
    expect(rows.map((row) => row.dataset.sourceId)).toEqual([
      "rss-mckinsey",
      "https://podcasts.example/show.xml",
      "youtube-ai",
      "mastodon-account",
      "x-account-openai",
    ]);
    expect(rows.map((row) => row.dataset.sourceKind)).toEqual([
      "feed",
      "feed",
      "feed",
      "feed",
      "x-account",
    ]);
    expect(rows.map((row) => row.dataset.sourceType)).toEqual([
      "rss-website",
      "podcast",
      "youtube",
      "mastodon",
      "x-account",
    ]);
    expect(modal.contentEl.textContent).toContain("RSS / 网站");
    expect(modal.contentEl.textContent).toContain("YouTube");
    expect(modal.contentEl.textContent).toContain("播客");
    expect(modal.contentEl.textContent).toContain("Mastodon");
    expect(modal.contentEl.textContent).toContain("X 账号");
    expect(modal.contentEl.textContent).not.toContain("AI topic");

    const filter = modal.contentEl.querySelector<HTMLSelectElement>(
      ".rss-subscription-type-filter",
    )!;
    filter.value = "youtube";
    filter.dispatchEvent(new Event("change"));
    expect(rows.map((row) => row.hidden)).toEqual([true, true, false, true, true]);
  });

  it("shows lifecycle state, safe progress, last success, and a redacted error without diagnostics", () => {
    const plugin = makePlugin([
      feed({
        feedId: "normal",
        title: "Normal",
        url: "https://normal.example/feed",
        initialImportProgress: {
          status: "completed",
          pagesFetched: 2,
          itemsImported: 18,
          nextCursor: "secret-next-cursor",
        },
      }),
      feed({
        feedId: "failed",
        title: "Failed",
        url: "https://failed.example/feed",
        lastFetchError:
          "GET https://api.tikhub.io/api/v1/twitter/web/fetch_user_post_tweet?handle=openai request_id=req-secret cursor=cursor-secret Authorization: Bearer sk-secret",
      }),
      feed({
        feedId: "paused",
        title: "Paused",
        url: "https://paused.example/feed",
        subscriptionStatus: "paused",
      }),
      feed({
        feedId: "history-paused",
        title: "History paused",
        url: "tikhub://x-account/anthropicai",
        sourceKind: "x-account",
        sourceConfig: createXAccountSourceConfig({
          id: "history-paused",
          handle: "anthropicai",
        }),
        initialImportProgress: {
          status: "paused-limit",
          pagesFetched: 4,
          itemsImported: 71,
          phase: "replies",
          nextCursor: "do-not-show-next",
          replyCursor: "do-not-show-reply",
        },
      }),
    ]);
    const modal = new FeedManagerModal(
      plugin.app as unknown as obsidian.App,
      plugin as unknown as RssDashboardPlugin,
    );
    modal.open();

    const rows = Array.from(
      modal.contentEl.querySelectorAll<HTMLElement>(".rss-subscription-row"),
    );
    expect(rows.map((row) => row.dataset.status)).toEqual([
      "normal",
      "failed",
      "paused",
      "initial-import-paused",
    ]);
    expect(rows[0].textContent).toContain("2 页 · 18 条");
    expect(rows[3].textContent).toContain("4 页 · 71 条");
    expect(rows[0].textContent).toContain("2026");
    expect(rows[1].textContent).toContain("最近刷新失败");
    expect(modal.contentEl.textContent).not.toContain("secret-next-cursor");
    expect(modal.contentEl.textContent).not.toContain("do-not-show");
    expect(modal.contentEl.textContent).not.toContain("api.tikhub.io");
    expect(modal.contentEl.textContent).not.toContain("openai");
    expect(modal.contentEl.textContent).not.toContain("req-secret");
    expect(modal.contentEl.textContent).not.toContain("sk-secret");
  });

  it("routes refresh, pause, resume, stop history, and continue history through subscription commands", async () => {
    const plugin = makePlugin([
      feed({
        feedId: "active",
        title: "Active",
        url: "https://active.example/feed",
        initialImportProgress: {
          status: "running",
          pagesFetched: 1,
          itemsImported: 5,
        },
      }),
      feed({
        feedId: "paused",
        title: "Paused",
        url: "https://paused.example/feed",
        subscriptionStatus: "paused",
      }),
      feed({
        feedId: "stopped",
        title: "Stopped",
        url: "tikhub://x-account/openai",
        sourceKind: "x-account",
        sourceConfig: createXAccountSourceConfig({
          id: "stopped",
          handle: "openai",
        }),
        initialImportProgress: {
          status: "stopped",
          pagesFetched: 3,
          itemsImported: 30,
          nextCursor: "resume-me",
        },
      }),
    ]);
    const modal = new FeedManagerModal(
      plugin.app as unknown as obsidian.App,
      plugin as unknown as RssDashboardPlugin,
    );
    modal.open();
    const row = (id: string) => modal.contentEl.querySelector<HTMLElement>(
      `.rss-subscription-row[data-source-id="${id}"]`,
    )!;

    button(row("active"), "刷新").click();
    button(row("active"), "暂停").click();
    button(row("paused"), "继续订阅").click();
    button(row("active"), "停止历史导入").click();
    button(row("stopped"), "继续历史导入").click();
    await flushPromises();

    expect(plugin.manualRefreshSourceById).toHaveBeenCalledWith("active");
    expect(plugin.setSubscriptionPaused).toHaveBeenCalledWith("active", true);
    expect(plugin.setSubscriptionPaused).toHaveBeenCalledWith("paused", false);
    expect(plugin.stopSubscriptionInitialImport).toHaveBeenCalledWith("active");
    expect(plugin.resumeSubscriptionInitialImport).toHaveBeenCalledWith("stopped");
  });

  it("routes identity edits back through onboarding and saves X options without re-verification", async () => {
    const plugin = makePlugin([
      feed({
        feedId: "youtube-ai",
        title: "AI channel",
        url: "https://www.youtube.com/feeds/videos.xml?channel_id=UC123",
        folder: "Videos",
        mediaType: "video",
      }),
      feed({
        feedId: "x-account-openai",
        title: "OpenAI",
        url: "tikhub://x-account/openai",
        folder: "AI",
        customTags: ["模型"],
        sourceKind: "x-account",
        sourceConfig: createXAccountSourceConfig({
          id: "x-account-openai",
          handle: "openai",
          displayName: "OpenAI",
          includeReplies: false,
          includeReposts: false,
          folder: "AI",
          topics: ["模型"],
        }),
      }),
    ]);
    const modal = new FeedManagerModal(
      plugin.app as unknown as obsidian.App,
      plugin as unknown as RssDashboardPlugin,
    );
    modal.open();
    const youtube = modal.contentEl.querySelector<HTMLElement>(
      '.rss-subscription-row[data-source-id="youtube-ai"]',
    )!;
    button(youtube, "更改地址").click();
    expect(plugin.openAddSourceModal).toHaveBeenCalledWith(
      {
        initialKind: "youtube",
        initialInput: "https://www.youtube.com/feeds/videos.xml?channel_id=UC123",
        initialFolder: "Videos",
      },
      "youtube-ai",
    );

    const xRow = modal.contentEl.querySelector<HTMLElement>(
      '.rss-subscription-row[data-source-id="x-account-openai"]',
    )!;
    button(xRow, "编辑选项").click();
    const editor = document.body.querySelector<HTMLElement>(
      ".rss-dashboard-x-account-options-modal",
    )!;
    const folder = Array.from(editor.querySelectorAll(".setting-item"))
      .find((item) => item.querySelector(".setting-item-name")?.textContent === "文件夹")!
      .querySelector<HTMLInputElement>("input")!;
    folder.value = "Research";
    folder.dispatchEvent(new Event("input"));
    const replies = Array.from(editor.querySelectorAll(".setting-item"))
      .find((item) => item.querySelector(".setting-item-name")?.textContent === "包含回复")!
      .querySelector<HTMLInputElement>("input")!;
    replies.click();
    button(editor, "保存").click();
    await flushPromises();

    expect(plugin.updateSubscription).toHaveBeenCalledWith(
      "x-account-openai",
      expect.objectContaining({
        kind: "x-account-options",
        folder: "Research",
        tags: ["模型"],
        includeReplies: true,
        includeReposts: false,
      }),
    );
    expect(plugin.openAddSourceModal).toHaveBeenCalledTimes(1);
  });

  it("defaults deletion to retaining collected content and requires a second confirmation to purge", async () => {
    const plugin = makePlugin([
      feed({
        feedId: "x-account-openai",
        title: "OpenAI",
        url: "tikhub://x-account/openai",
        sourceKind: "x-account",
        sourceConfig: createXAccountSourceConfig({
          id: "x-account-openai",
          handle: "openai",
        }),
      }),
    ]);
    const modal = new FeedManagerModal(
      plugin.app as unknown as obsidian.App,
      plugin as unknown as RssDashboardPlugin,
    );
    modal.open();
    const row = modal.contentEl.querySelector<HTMLElement>(
      '.rss-subscription-row[data-source-id="x-account-openai"]',
    )!;

    button(row, "删除").click();
    let confirmation = document.body.querySelector<HTMLElement>(
      ".rss-subscription-delete-confirm",
    )!;
    expect(confirmation.textContent).toContain("保留已经采集的历史内容");
    button(confirmation, "确认删除").click();
    await flushPromises();
    expect(plugin.removeSubscription).toHaveBeenCalledWith(
      "x-account-openai",
      { purgeCollection: false },
    );

    plugin.removeSubscription.mockClear();
    button(row, "删除").click();
    confirmation = document.body.querySelector<HTMLElement>(
      ".rss-subscription-delete-confirm",
    )!;
    const purge = confirmation.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )!;
    purge.click();
    button(confirmation, "确认删除").click();
    expect(plugin.removeSubscription).not.toHaveBeenCalled();
    const second = document.body.querySelector<HTMLElement>(
      ".rss-subscription-purge-confirm",
    )!;
    expect(second.textContent).toContain("不可恢复");
    button(second, "永久删除").click();
    await flushPromises();
    expect(plugin.removeSubscription).toHaveBeenCalledTimes(1);
    const [sourceId, options] = plugin.removeSubscription.mock.calls[0];
    expect(sourceId).toBe("x-account-openai");
    expect(options.purgeCollection).toBe(true);
    expect(options.confirmation.matches("x-account-openai")).toBe(true);
  });

  it("deletes all visible subscriptions through the same retention-safe service path", async () => {
    const plugin = makePlugin([
      feed({ feedId: "rss", title: "RSS", url: "https://example.com/feed" }),
      feed({
        feedId: "x-account-openai",
        title: "OpenAI",
        url: "tikhub://x-account/openai",
        sourceKind: "x-account",
        sourceConfig: createXAccountSourceConfig({
          id: "x-account-openai",
          handle: "openai",
        }),
      }),
      feed({
        feedId: "x-topic-ai",
        title: "AI topic",
        url: "tikhub://x-topic/ai",
        sourceKind: "x-topic",
        sourceConfig: createXTopicSourceConfig({ id: "x-topic-ai", name: "AI" }),
      }),
    ]);
    const modal = new FeedManagerModal(
      plugin.app as unknown as obsidian.App,
      plugin as unknown as RssDashboardPlugin,
    );
    modal.open();

    button(modal.contentEl, "删除全部订阅").click();
    const confirmation = document.body.querySelector<HTMLElement>(
      ".rss-subscription-delete-confirm",
    )!;
    expect(confirmation.textContent).toContain("2");
    button(confirmation, "确认删除").click();
    await flushPromises();

    expect(plugin.removeSubscription.mock.calls).toEqual([
      ["rss", { purgeCollection: false }],
      ["x-account-openai", { purgeCollection: false }],
    ]);
  });
});
