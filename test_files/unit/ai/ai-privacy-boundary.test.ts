import { beforeEach, describe, expect, it, vi } from "vitest";
import { App, type RequestUrlResponse } from "obsidian";
import * as obsidian from "obsidian";

const secretState = vi.hoisted(() => ({
  reads: [] as string[],
  values: new Map<string, string>(),
}));

vi.mock("../../../src/security/desktop-secret-store", () => ({
  DesktopSecretStore: class DesktopSecretStoreMock {
    async get(connectionId: string): Promise<string | undefined> {
      secretState.reads.push(connectionId);
      return secretState.values.get(connectionId);
    }
  },
}));

import RssDashboardPlugin from "../../../main";
import { AnalysisRepository } from "../../../src/ai/analysis-repository";
import { createAiConnection } from "../../../src/ai/provider-presets";
import {
  cloneAiSourceItem,
  resolveAndSnapshotAiSource,
} from "../../../src/ai/ai-source-snapshot";
import { ContentRepository } from "../../../src/collection/content-repository";
import { CollectionRepository } from "../../../src/collection/collection-repository";
import { normalizeFeedItem } from "../../../src/collection/feed-normalizer";
import {
  createCollectedItemId,
  createXPostCollectedItemId,
} from "../../../src/collection/item-identity";
import {
  DEFAULT_SETTINGS,
  type Feed,
  type FeedItem,
  type RssDashboardSettings,
} from "../../../src/types/types";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";

const SELECTED_CONNECTION_ID = "9a76f539-c9ec-4c45-a8e5-156cc6740a8d";
const OTHER_CONNECTION_ID = "b2e6a5d6-f3ad-4330-8781-4c621773e77d";
const SELECTED_SECRET = "selected-provider-credential-canary";
const OTHER_SECRET = "unrelated-provider-credential-canary";
const DUPLICATE_FEED_URL = "https://feeds.example.invalid/shared.xml";
const UNRELATED_FEED_TITLE = "UNRELATED_FEED_TITLE_CANARY";
const SELECTED_FEED_TITLE = "SELECTED_FEED_TITLE_CANARY";
const LATE_CACHE_TEXT = "LATE_CACHE_UPDATE_CANARY";
const DEFAULT_SECRET_PATH_CANARY =
  "/Users/privacy/Library/Application Support/rss-dashboard-cn/secrets.json";

const UNRELATED_CANARIES = [
  "UNRELATED_NOTE_BODY_CANARY",
  "UNRELATED_SAVED_ARTICLE_CANARY",
  "COLLECTION_SHARD_BODY_CANARY",
  "COLLECTION_INDEX_BODY_CANARY",
  "COLLECTION_STATE_BODY_CANARY",
  "UNRELATED_ITEM_TITLE_CANARY",
  "UNRELATED_ITEM_URL_CANARY",
  "UNRELATED_ITEM_AUTHOR_CANARY",
  "UNRELATED_ITEM_DESCRIPTION_CANARY",
  "UNRELATED_ITEM_FULL_TEXT_CANARY",
  "UNRELATED_CONTENT_REPOSITORY_CANARY",
  UNRELATED_FEED_TITLE,
  "UNRELATED_SOURCE_FOLDER_CANARY",
  "UNRELATED_GLOBAL_FOLDER_CANARY",
  "WATCHED_X_ACCOUNT_CANARY",
  "TIKHUB_TOPIC_KEYWORD_CANARY",
  "TIKHUB_TOPIC_IDENTIFIER_CANARY",
  "TIKHUB_CONNECTION_IDENTIFIER_CANARY",
  ".rss-dashboard-data/collection/UNRELATED_PATH_CANARY",
  DEFAULT_SECRET_PATH_CANARY,
  OTHER_SECRET,
  "UNRELATED_AI_CONNECTION_CANARY",
  "UNRELATED_AI_MODEL_CANARY",
  LATE_CACHE_TEXT,
] as const;

function responseWithText(text: string, status = 200): RequestUrlResponse {
  return {
    status,
    headers: {},
    arrayBuffer: new ArrayBuffer(0),
    json: {},
    text: JSON.stringify({
      id: "safe-request-id",
      choices: [{ message: { content: text } }],
    }),
  };
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === label,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`Missing button: ${label}`);
  }
  return match;
}

function feedItem(
  guid: string,
  title: string,
  sourceId: string,
): FeedItem {
  return {
    rssDashboardSourceId: sourceId,
    title,
    link: `https://articles.example.invalid/${guid}`,
    description: `${title} description`,
    pubDate: "2026-07-23T00:00:00.000Z",
    guid,
    read: false,
    starred: false,
    saved: false,
    tags: [],
    feedTitle: sourceId,
    feedUrl: DUPLICATE_FEED_URL,
    coverImage: "",
  };
}

function createFeed(
  feedId: string,
  title: string,
  items: FeedItem[],
): Feed {
  return {
    feedId,
    sourceKind: "feed",
    sourceConfig: { kind: "feed" },
    title,
    url: DUPLICATE_FEED_URL,
    folder: `${title}_FOLDER`,
    items,
    lastUpdated: Date.now(),
  };
}

function installAtomicAdapter(app: App): void {
  const adapter = app.vault.adapter;
  adapter.copy = async (from: string, to: string) => {
    if (await adapter.exists(to)) throw new Error(`Destination exists: ${to}`);
    await adapter.write(to, await adapter.read(from));
  };
  adapter.process = async (
    path: string,
    update: (current: string) => string,
  ) => {
    const current = await adapter.read(path);
    const next = update(current);
    await adapter.write(path, next);
    return next;
  };
}

function outboundBody(
  requestUrl: ReturnType<typeof vi.spyOn>,
): Record<string, unknown> {
  const request = requestUrl.mock.calls[0]?.[0] as { body?: string } | undefined;
  return JSON.parse(request?.body ?? "{}") as Record<string, unknown>;
}

function outboundUserPayload(
  requestUrl: ReturnType<typeof vi.spyOn>,
): Record<string, unknown> {
  const body = outboundBody(requestUrl);
  const messages = body.messages as Array<{ role: string; content: string }>;
  return JSON.parse(messages[1]?.content ?? "{}") as Record<string, unknown>;
}

function harness() {
  const app = App.createMock();
  const plugin = new RssDashboardPlugin(app, {
    id: "rss-dashboard",
    name: "RSS Dashboard",
    version: "2.5.0",
  });
  const settings: RssDashboardSettings = structuredClone(DEFAULT_SETTINGS);
  const unrelated = feedItem(
    "unrelated-guid",
    "UNRELATED_ITEM_TITLE_CANARY",
    "unrelated-feed-id",
  );
  const selected = feedItem(
    "selected-guid",
    "SELECTED_ITEM_TITLE_CANARY",
    "selected-feed-id",
  );
  const unrelatedFeed = createFeed(
    "unrelated-feed-id",
    UNRELATED_FEED_TITLE,
    [unrelated],
  );
  const selectedFeed = createFeed(
    "selected-feed-id",
    SELECTED_FEED_TITLE,
    [selected],
  );
  settings.feeds = [unrelatedFeed, selectedFeed];
  settings.ai.connections = [createAiConnection({
    id: SELECTED_CONNECTION_ID,
    name: "Selected connection",
    providerKind: "kimi",
    model: "selected-model",
  })];
  settings.ai.defaultConnectionId = SELECTED_CONNECTION_ID;
  plugin.settings = settings;
  secretState.values.set(SELECTED_CONNECTION_ID, SELECTED_SECRET);
  selected.rssDashboardId = createCollectedItemId({
    sourceId: "selected-feed-id",
    guid: selected.guid,
    url: selected.link,
    title: selected.title,
    publishedAt: selected.pubDate,
  });
  return { app, plugin, settings, selected, selectedFeed, unrelated };
}

function installArticleSaver(
  test: ReturnType<typeof harness>,
  savedFile?: Awaited<ReturnType<App["vault"]["create"]>>,
) {
  const saveArticle = vi.fn(async () => savedFile ?? null);
  const saveArticleWithFullContent = vi.fn(async () => savedFile ?? null);
  test.plugin.articleSaver = {
    saveArticle,
    saveArticleWithFullContent,
  } as unknown as RssDashboardPlugin["articleSaver"];
  return { saveArticle, saveArticleWithFullContent };
}

async function seedSelectedCollectionItem(test: ReturnType<typeof harness>) {
  const clock = new Date("2026-07-23T02:00:00.000Z");
  const repository = new CollectionRepository(
    test.app.vault,
    test.settings.collection.dataFolder,
    () => clock,
  );
  const item = normalizeFeedItem(
    test.selectedFeed,
    structuredClone(test.selected),
    clock,
  );
  await repository.upsertDaily([item], "2026-07-23");
  return { repository, item };
}

async function seedHostileState(test: ReturnType<typeof harness>): Promise<void> {
  installAtomicAdapter(test.app);
  await test.app.vault.createFolder("Notes");
  await test.app.vault.create(
    "Notes/unrelated.md",
    `UNRELATED_NOTE_BODY_CANARY\n${DEFAULT_SECRET_PATH_CANARY}`,
  );
  await test.app.vault.create(
    "Notes/unrelated-saved-article.md",
    "UNRELATED_SAVED_ARTICLE_CANARY",
  );
  await test.app.vault.createFolder(".rss-dashboard-data/collection");
  await test.app.vault.createFolder(".rss-dashboard-data/content");
  await test.app.vault.adapter.write(
    ".rss-dashboard-data/collection/shard-canary.json",
    "COLLECTION_SHARD_BODY_CANARY UNRELATED_ITEM_FULL_TEXT_CANARY",
  );
  await test.app.vault.adapter.write(
    ".rss-dashboard-data/collection/index-canary.json",
    "COLLECTION_INDEX_BODY_CANARY .rss-dashboard-data/collection/UNRELATED_PATH_CANARY",
  );
  await test.app.vault.adapter.write(
    ".rss-dashboard-data/collection/state-canary.json",
    "COLLECTION_STATE_BODY_CANARY",
  );

  test.unrelated.link =
    "https://articles.example.invalid/UNRELATED_ITEM_URL_CANARY";
  test.unrelated.author = "UNRELATED_ITEM_AUTHOR_CANARY";
  test.unrelated.description = "UNRELATED_ITEM_DESCRIPTION_CANARY";
  const unrelatedId = createCollectedItemId({
    sourceId: "unrelated-feed-id",
    guid: test.unrelated.guid,
    url: test.unrelated.link,
    title: test.unrelated.title,
    author: test.unrelated.author,
    publishedAt: test.unrelated.pubDate,
  });
  await new ContentRepository(
    test.app.vault,
    test.settings.collection.dataFolder,
    () => new Date("2026-07-23T02:00:00.000Z"),
  ).write({
    schemaVersion: 1,
    itemId: unrelatedId,
    sourceUrl: test.unrelated.link,
    fetchedAt: "2026-07-23T02:00:00.000Z",
    contentBasis: "full-text",
    text: "UNRELATED_CONTENT_REPOSITORY_CANARY",
  });
  test.settings.folders = [{
    name: "UNRELATED_GLOBAL_FOLDER_CANARY",
    subfolders: [],
  }];
  test.settings.tikhub.connectionId = "TIKHUB_CONNECTION_IDENTIFIER_CANARY";
  test.settings.feeds.push(
    {
      feedId: "x-account-canary",
      sourceKind: "x-account",
      sourceConfig: {
        kind: "x-account",
        id: "x-account-canary",
        handle: "watchcanary",
        displayName: "WATCHED_X_ACCOUNT_CANARY",
        includeReplies: false,
        includeReposts: false,
        folder: "UNRELATED_SOURCE_FOLDER_CANARY",
        topics: [],
      },
      title: "WATCHED_X_ACCOUNT_CANARY",
      url: "tikhub://x-account/watchcanary",
      folder: "UNRELATED_SOURCE_FOLDER_CANARY",
      items: [],
      lastUpdated: 0,
    },
    {
      feedId: "TIKHUB_TOPIC_IDENTIFIER_CANARY",
      sourceKind: "x-topic",
      sourceConfig: {
        kind: "x-topic",
        id: "tikhub-topic-canary",
        name: "TIKHUB_TOPIC_IDENTIFIER_CANARY",
        includeKeywords: ["TIKHUB_TOPIC_KEYWORD_CANARY"],
        excludeKeywords: [],
        priorityAccounts: [],
        windowDays: 7,
        folder: "UNRELATED_SOURCE_FOLDER_CANARY",
      },
      title: "TIKHUB_TOPIC_IDENTIFIER_CANARY",
      url: "tikhub://x-topic/tikhub-topic-canary",
      folder: "UNRELATED_SOURCE_FOLDER_CANARY",
      items: [],
      lastUpdated: 0,
    },
  );
  test.settings.ai.connections.push(createAiConnection({
    id: OTHER_CONNECTION_ID,
    name: "UNRELATED_AI_CONNECTION_CANARY",
    providerKind: "claude",
    model: "UNRELATED_AI_MODEL_CANARY",
  }));
  secretState.values.set(OTHER_CONNECTION_ID, OTHER_SECRET);
}

beforeEach(() => {
  installObsidianDomPolyfills();
  document.body.empty();
  secretState.reads.length = 0;
  secretState.values.clear();
  vi.restoreAllMocks();
});

describe("AI privacy boundary", () => {
  it("rejects a valid but unrelated cached-content ID before opening the modal", async () => {
    const test = harness();
    installAtomicAdapter(test.app);
    const unrelatedId = createCollectedItemId({
      sourceId: "unrelated-feed-id",
      guid: test.unrelated.guid,
      url: test.unrelated.link,
      title: test.unrelated.title,
      publishedAt: test.unrelated.pubDate,
    });
    test.selected.rssDashboardId = unrelatedId;
    await new ContentRepository(
      test.app.vault,
      test.settings.collection.dataFolder,
      () => new Date("2026-07-23T02:00:00.000Z"),
    ).write({
      schemaVersion: 1,
      itemId: unrelatedId,
      sourceUrl: test.unrelated.link,
      fetchedAt: "2026-07-23T02:00:00.000Z",
      contentBasis: "full-text",
      text: "UNRELATED_VALID_ID_CACHE_CANARY",
    });
    const requestUrl = vi.spyOn(obsidian, "requestUrl");
    const saver = installArticleSaver(test);

    const modal = test.plugin.openAiOperationForItem(test.selected, "summary");

    modal?.close();
    expect(modal).toBeNull();
    expect(requestUrl).not.toHaveBeenCalled();
    expect(secretState.reads).toEqual([]);
    expect(saver.saveArticle).not.toHaveBeenCalled();
    expect(saver.saveArticleWithFullContent).not.toHaveBeenCalled();
  });

  it("derives a missing stable ID without mutating the source item", async () => {
    const test = harness();
    installAtomicAdapter(test.app);
    delete test.selected.rssDashboardId;
    const requestUrl = vi.spyOn(obsidian, "requestUrl")
      .mockResolvedValue(responseWithText("safe missing-id analysis"));

    const modal = test.plugin.openAiOperationForItem(test.selected, "summary");
    await vi.waitFor(() => expect(modal?.contentEl.textContent).toContain(
      SELECTED_FEED_TITLE,
    ));
    button(modal!.contentEl, "确认发送").click();
    await vi.waitFor(() => expect(requestUrl).toHaveBeenCalledTimes(1));

    expect(test.selected.rssDashboardId).toBeUndefined();
    expect(outboundUserPayload(requestUrl).title).toBe(
      "SELECTED_ITEM_TITLE_CANARY",
    );
    modal?.close();
  });

  it("derives the canonical X post ID from the numeric post ID", async () => {
    const test = harness();
    installAtomicAdapter(test.app);
    (test.selectedFeed as Feed & { sourceType?: string }).sourceType = "x-account";
    test.selected.guid = "1901234567890123456";
    test.selected.link = "https://x.com/example/status/1901234567890123456";
    delete test.selected.rssDashboardId;
    const expectedId = createXPostCollectedItemId(test.selected.guid);
    const requestUrl = vi.spyOn(obsidian, "requestUrl")
      .mockResolvedValue(responseWithText("safe x analysis"));

    const modal = test.plugin.openAiOperationForItem(test.selected, "summary");
    await vi.waitFor(() => expect(modal?.contentEl.textContent).toContain(
      SELECTED_FEED_TITLE,
    ));
    button(modal!.contentEl, "确认发送").click();
    await vi.waitFor(() => expect(requestUrl).toHaveBeenCalledTimes(1));

    expect(expectedId).toMatch(/^[a-f0-9]{64}$/u);
    expect(test.selected.rssDashboardId).toBeUndefined();
    expect(outboundUserPayload(requestUrl)).toMatchObject({
      contentBasis: "x-post",
      sourceUrl: "https://x.com/example/status/1901234567890123456",
    });
    modal?.close();
  });

  it("fails closed when two items in the owner have the same canonical identity", () => {
    const test = harness();
    const duplicate = structuredClone(test.selected);
    delete duplicate.rssDashboardId;
    test.selectedFeed.items.push(duplicate);
    const requestUrl = vi.spyOn(obsidian, "requestUrl");

    const modal = test.plugin.openAiOperationForItem(test.selected, "summary");

    modal?.close();
    expect(modal).toBeNull();
    expect(requestUrl).not.toHaveBeenCalled();
    expect(secretState.reads).toEqual([]);
  });

  it.each([
    ["over-depth data", () => {
      let value: Record<string, unknown> = { leaf: "safe" };
      for (let depth = 0; depth < 65; depth += 1) value = { child: value };
      return value;
    }],
    ["over-wide data", () => Object.fromEntries(
      Array.from({ length: 20_001 }, (_, index) => [`field${index}`, index]),
    )],
    ["huge string data", () => ({ text: "x".repeat(2_000_001) })],
    ["huge UTF-8 byte data", () => ({ text: "汉".repeat(1_400_000) })],
    ["cyclic data", () => {
      const value: Record<string, unknown> = {};
      value.self = value;
      return value;
    }],
  ] as const)("fails closed for %s before modal construction", (_name, create) => {
    const test = harness();
    (test.selected as FeedItem & { hostileShape?: unknown }).hostileShape = create();
    const requestUrl = vi.spyOn(obsidian, "requestUrl");
    const saver = installArticleSaver(test);

    const modal = test.plugin.openAiOperationForItem(test.selected, "summary");

    modal?.close();
    expect(modal).toBeNull();
    expect(requestUrl).not.toHaveBeenCalled();
    expect(secretState.reads).toEqual([]);
    expect(saver.saveArticle).not.toHaveBeenCalled();
  });

  it("rejects a shared object graph instead of expanding it repeatedly", () => {
    const test = harness();
    const shared = { text: "shared" };
    (test.selected as FeedItem & { hostileShape?: unknown }).hostileShape = {
      left: shared,
      right: shared,
    };
    const requestUrl = vi.spyOn(obsidian, "requestUrl");

    const modal = test.plugin.openAiOperationForItem(test.selected, "summary");

    modal?.close();
    expect(modal).toBeNull();
    expect(requestUrl).not.toHaveBeenCalled();
    expect(secretState.reads).toEqual([]);
  });

  it("bounds total ownership comparisons across large unrelated item arrays", () => {
    const test = harness();
    let getterCalls = 0;
    const unrelated = structuredClone(test.unrelated);
    Object.defineProperty(unrelated, "neverRead", {
      configurable: true,
      get() {
        getterCalls += 1;
        throw new Error("ownership scan must not invoke item getters");
      },
    });
    const firstItems = Array.from({ length: 60_000 }, () => unrelated);
    const secondItems = Array.from({ length: 60_000 }, () => unrelated);
    test.settings.feeds.unshift(
      createFeed("large-one", "Large one", firstItems),
      createFeed("large-two", "Large two", secondItems),
    );
    const requestUrl = vi.spyOn(obsidian, "requestUrl");

    const modal = test.plugin.openAiOperationForItem(test.selected, "summary");

    modal?.close();
    expect(modal).toBeNull();
    expect(getterCalls).toBe(0);
    expect(requestUrl).not.toHaveBeenCalled();
    expect(secretState.reads).toEqual([]);
  });

  it("accepts the documented feed-count boundary and rejects one feed over it", () => {
    const atBoundary = harness();
    atBoundary.settings.feeds = [
      ...Array.from({ length: 4_095 }, (_, index) =>
        createFeed(`empty-${index}`, `Empty ${index}`, [])),
      atBoundary.selectedFeed,
    ];

    const accepted = atBoundary.plugin.openAiOperationForItem(
      atBoundary.selected,
      "summary",
    );

    expect(accepted).not.toBeNull();
    accepted?.close();
    expect(secretState.reads).toEqual([]);

    const overBoundary = harness();
    overBoundary.settings.feeds = [
      ...Array.from({ length: 4_096 }, (_, index) =>
        createFeed(`empty-over-${index}`, `Empty over ${index}`, [])),
      overBoundary.selectedFeed,
    ];

    const rejected = overBoundary.plugin.openAiOperationForItem(
      overBoundary.selected,
      "summary",
    );

    rejected?.close();
    expect(rejected).toBeNull();
    expect(secretState.reads).toEqual([]);
  });

  it("deep-freezes an isolated snapshot and returns a fresh mutable save clone", () => {
    const test = harness();
    const nested = { labels: [{ name: "opening" }] };
    (test.selected as FeedItem & { nested?: typeof nested }).nested = nested;

    const snapshot = resolveAndSnapshotAiSource(
      test.settings.feeds,
      test.selected,
    );
    const snapshotNested = (snapshot?.item as FeedItem & {
      nested?: typeof nested;
    }).nested!;
    const saveClone = cloneAiSourceItem(snapshot!.item) as FeedItem & {
      nested?: typeof nested;
    };

    expect(snapshot).toBeDefined();
    expect(Object.isFrozen(snapshot?.item)).toBe(true);
    expect(Object.isFrozen(snapshotNested)).toBe(true);
    expect(Object.isFrozen(snapshotNested.labels)).toBe(true);
    expect(Object.isFrozen(snapshotNested.labels[0])).toBe(true);
    expect(snapshotNested).not.toBe(nested);
    expect(saveClone.nested).not.toBe(snapshotNested);
    expect(Object.isFrozen(saveClone.nested)).toBe(false);
    nested.labels[0].name = "mutated source";
    saveClone.nested!.labels[0].name = "mutable save clone";
    expect(snapshotNested.labels[0].name).toBe("opening");
  });

  it("fails closed when a detached item source ID matches more than one feed", () => {
    const test = harness();
    const saver = installArticleSaver(test);
    const detached = structuredClone(test.selected);
    test.settings.feeds[0].feedId = "selected-feed-id";
    const requestUrl = vi.spyOn(obsidian, "requestUrl");

    const modal = test.plugin.openAiOperationForItem(detached, "summary");

    expect(modal).toBeNull();
    expect(requestUrl).not.toHaveBeenCalled();
    expect(secretState.reads).toEqual([]);
    expect(saver.saveArticle).not.toHaveBeenCalled();
    expect(saver.saveArticleWithFullContent).not.toHaveBeenCalled();
  });

  it("fails closed when the same FeedItem object is held by more than one feed", () => {
    const test = harness();
    const saver = installArticleSaver(test);
    test.settings.feeds[0].items.push(test.selected);
    const requestUrl = vi.spyOn(obsidian, "requestUrl");

    const modal = test.plugin.openAiOperationForItem(test.selected, "summary");

    expect(modal).toBeNull();
    expect(requestUrl).not.toHaveBeenCalled();
    expect(secretState.reads).toEqual([]);
    expect(saver.saveArticle).not.toHaveBeenCalled();
    expect(saver.saveArticleWithFullContent).not.toHaveBeenCalled();
  });

  it.each(["reference", "source-id", "url"] as const)(
    "sends the selected source only when the %s identity is unique",
    async (identity) => {
      const test = harness();
      installAtomicAdapter(test.app);
      let selected = test.selected;
      if (identity !== "reference") selected = structuredClone(test.selected);
      if (identity === "url") {
        delete selected.rssDashboardSourceId;
        test.settings.feeds[0].url =
          "https://feeds.example.invalid/unrelated-only.xml";
      }
      const requestUrl = vi.spyOn(obsidian, "requestUrl")
        .mockResolvedValue(responseWithText(`safe ${identity} analysis`));

      const modal = test.plugin.openAiOperationForItem(selected, "summary");
      await vi.waitFor(() => expect(modal?.contentEl.textContent).toContain(
        SELECTED_FEED_TITLE,
      ));
      button(modal!.contentEl, "确认发送").click();
      await vi.waitFor(() => expect(requestUrl).toHaveBeenCalledTimes(1));

      expect(outboundUserPayload(requestUrl)).toMatchObject({
        title: "SELECTED_ITEM_TITLE_CANARY",
        sourceName: SELECTED_FEED_TITLE,
        content: "SELECTED_ITEM_TITLE_CANARY description",
      });
      expect(requestUrl.mock.calls[0]?.[0].body).not.toContain(
        UNRELATED_FEED_TITLE,
      );
      modal?.close();
    },
  );

  it.each([
    "feedId",
    "url",
    "title",
    "folder",
    "customTemplate",
  ] as const)(
    "fails closed without invoking an own selected-feed %s accessor",
    (field) => {
      const test = harness();
      const saver = installArticleSaver(test);
      let getterCalls = 0;
      Object.defineProperty(test.selectedFeed, field, {
        configurable: true,
        get() {
          getterCalls += 1;
          throw new Error(`selected feed ${field} getter must not run`);
        },
      });
      const requestUrl = vi.spyOn(obsidian, "requestUrl");

      const modal = test.plugin.openAiOperationForItem(test.selected, "summary");

      expect(modal).toBeNull();
      expect(getterCalls).toBe(0);
      expect(requestUrl).not.toHaveBeenCalled();
      expect(secretState.reads).toEqual([]);
      expect(saver.saveArticle).not.toHaveBeenCalled();
      expect(saver.saveArticleWithFullContent).not.toHaveBeenCalled();
    },
  );

  it.each([
    "feedId",
    "url",
    "title",
    "folder",
    "customTemplate",
  ] as const)(
    "rejects inherited selected-feed %s data",
    (field) => {
      const test = harness();
      const inheritedValue = field === "customTemplate"
        ? "inherited-template"
        : test.selectedFeed[field];
      delete test.selectedFeed[field];
      Object.setPrototypeOf(test.selectedFeed, {
        [field]: inheritedValue,
      });
      const requestUrl = vi.spyOn(obsidian, "requestUrl");

      const modal = test.plugin.openAiOperationForItem(test.selected, "summary");

      expect(modal).toBeNull();
      expect(requestUrl).not.toHaveBeenCalled();
      expect(secretState.reads).toEqual([]);
    },
  );

  it.each([
    "feedId",
    "url",
    "title",
    "folder",
    "customTemplate",
  ] as const)(
    "rejects an inherited selected-feed %s accessor without invoking it",
    (field) => {
      const test = harness();
      let getterCalls = 0;
      delete test.selectedFeed[field];
      const prototype = {};
      Object.defineProperty(prototype, field, {
        configurable: true,
        get() {
          getterCalls += 1;
          throw new Error(`inherited selected feed ${field} getter must not run`);
        },
      });
      Object.setPrototypeOf(test.selectedFeed, prototype);
      const requestUrl = vi.spyOn(obsidian, "requestUrl");

      const modal = test.plugin.openAiOperationForItem(test.selected, "summary");

      expect(modal).toBeNull();
      expect(getterCalls).toBe(0);
      expect(requestUrl).not.toHaveBeenCalled();
      expect(secretState.reads).toEqual([]);
    },
  );

  it.each([
    "title",
    "link",
    "guid",
    "content",
    "description",
    "feedUrl",
    "feedTitle",
    "rssDashboardId",
  ] as const)(
    "fails closed without invoking an own selected-item %s accessor",
    (field) => {
      const test = harness();
      let getterCalls = 0;
      Object.defineProperty(test.selected, field, {
        configurable: true,
        get() {
          getterCalls += 1;
          throw new Error(`selected item ${field} getter must not run`);
        },
      });
      const requestUrl = vi.spyOn(obsidian, "requestUrl");

      const modal = test.plugin.openAiOperationForItem(test.selected, "summary");

      expect(modal).toBeNull();
      expect(getterCalls).toBe(0);
      expect(requestUrl).not.toHaveBeenCalled();
      expect(secretState.reads).toEqual([]);
    },
  );

  it.each([
    "title",
    "link",
    "guid",
    "content",
    "description",
    "feedUrl",
    "feedTitle",
    "rssDashboardId",
  ] as const)(
    "rejects inherited selected-item %s data",
    (field) => {
      const test = harness();
      const inheritedValue = field === "content"
        ? "inherited content"
        : test.selected[field];
      delete test.selected[field];
      Object.setPrototypeOf(test.selected, {
        [field]: inheritedValue,
      });
      const requestUrl = vi.spyOn(obsidian, "requestUrl");

      const modal = test.plugin.openAiOperationForItem(test.selected, "summary");

      expect(modal).toBeNull();
      expect(requestUrl).not.toHaveBeenCalled();
      expect(secretState.reads).toEqual([]);
    },
  );

  it.each([
    "title",
    "link",
    "guid",
    "content",
    "description",
    "feedUrl",
    "feedTitle",
    "rssDashboardId",
  ] as const)(
    "rejects an inherited selected-item %s accessor without invoking it",
    (field) => {
      const test = harness();
      let getterCalls = 0;
      delete test.selected[field];
      const prototype = {};
      Object.defineProperty(prototype, field, {
        configurable: true,
        get() {
          getterCalls += 1;
          throw new Error(`inherited selected item ${field} getter must not run`);
        },
      });
      Object.setPrototypeOf(test.selected, prototype);
      const requestUrl = vi.spyOn(obsidian, "requestUrl");

      const modal = test.plugin.openAiOperationForItem(test.selected, "summary");

      expect(modal).toBeNull();
      expect(getterCalls).toBe(0);
      expect(requestUrl).not.toHaveBeenCalled();
      expect(secretState.reads).toEqual([]);
    },
  );

  it("rejects a selected feed items index accessor without invoking it", () => {
    const test = harness();
    let getterCalls = 0;
    Object.defineProperty(test.selectedFeed.items, "0", {
      configurable: true,
      get() {
        getterCalls += 1;
        throw new Error("selected feed item index getter must not run");
      },
    });
    const requestUrl = vi.spyOn(obsidian, "requestUrl");

    const modal = test.plugin.openAiOperationForItem(test.selected, "summary");

    expect(modal).toBeNull();
    expect(getterCalls).toBe(0);
    expect(requestUrl).not.toHaveBeenCalled();
    expect(secretState.reads).toEqual([]);
  });

  it("does not invoke accessors on an unrelated candidate while resolving a safe reference", async () => {
    const test = harness();
    installAtomicAdapter(test.app);
    let getterCalls = 0;
    Object.defineProperty(test.settings.feeds[0].items, "0", {
      configurable: true,
      get() {
        getterCalls += 1;
        throw new Error("unrelated candidate item getter must not run");
      },
    });
    for (const field of ["feedId", "url", "customTemplate"] as const) {
      Object.defineProperty(test.settings.feeds[0], field, {
        configurable: true,
        get() {
          getterCalls += 1;
          throw new Error(`unrelated candidate ${field} getter must not run`);
        },
      });
    }
    const requestUrl = vi.spyOn(obsidian, "requestUrl")
      .mockResolvedValue(responseWithText("safe unrelated-accessor analysis"));

    const modal = test.plugin.openAiOperationForItem(test.selected, "summary");
    await vi.waitFor(() => expect(modal?.contentEl.textContent).toContain(
      SELECTED_FEED_TITLE,
    ));
    button(modal!.contentEl, "确认发送").click();
    await vi.waitFor(() => expect(requestUrl).toHaveBeenCalledTimes(1));

    expect(getterCalls).toBe(0);
    expect(outboundUserPayload(requestUrl).sourceName).toBe(SELECTED_FEED_TITLE);
    modal?.close();
  });

  it("uses the immutable AI snapshot but refuses save-first after source replacement", async () => {
    const test = harness();
    const detached = structuredClone(test.selected);
    detached.content = "SELECTED_ORIGINAL_CONTENT_CANARY";
    installAtomicAdapter(test.app);
    await test.app.vault.createFolder("Notes");
    const savedFile = await test.app.vault.create(
      "Notes/selected-source.md",
      "saved selected source",
    );
    test.settings.feeds[0].customTemplate = "unrelated-template";
    test.selectedFeed.customTemplate = "selected-template";
    test.settings.articleSaving.savedTemplates = [
      {
        id: "unrelated-template",
        name: "Unrelated template",
        template: "UNRELATED_SAVE_TEMPLATE_CANARY",
      },
      {
        id: "selected-template",
        name: "Selected template",
        template: "SELECTED_SAVE_TEMPLATE_CANARY",
      },
    ];
    test.settings.collection.savedNoteFolder = "Notes/Snapshot Folder";
    const saver = installArticleSaver(test, savedFile);
    const requestUrl = vi.spyOn(obsidian, "requestUrl")
      .mockResolvedValue(responseWithText("safe save-first analysis"));

    const modal = test.plugin.openAiOperationForItem(detached, "summary");
    await vi.waitFor(() => expect(modal?.contentEl.textContent).toContain(
      SELECTED_FEED_TITLE,
    ));
    const replacement = structuredClone(test.selected);
    replacement.saved = false;
    test.selectedFeed.feedId = "mutated-feed-id";
    test.selectedFeed.url = "https://feeds.example.invalid/mutated.xml";
    test.selectedFeed.title = "MUTATED_FEED_TITLE_CANARY";
    test.selectedFeed.folder = "MUTATED_FEED_FOLDER_CANARY";
    test.selectedFeed.customTemplate = "unrelated-template";
    test.selectedFeed.items = [replacement];
    test.settings.articleSaving.savedTemplates[1].template =
      "MUTATED_SELECTED_TEMPLATE_CANARY";
    test.settings.collection.savedNoteFolder = "Notes/Mutated Folder";
    Object.assign(detached, {
      rssDashboardSourceId: "mutated-feed-id",
      guid: "mutated-guid",
      link: "https://articles.example.invalid/mutated",
      title: "MUTATED_ITEM_TITLE_CANARY",
      content: "MUTATED_ITEM_CONTENT_CANARY",
      description: "MUTATED_ITEM_DESCRIPTION_CANARY",
      feedUrl: "https://feeds.example.invalid/mutated.xml",
      feedTitle: "MUTATED_FEED_TITLE_CANARY",
    });
    button(modal!.contentEl, "确认发送").click();
    await vi.waitFor(() => expect(requestUrl).toHaveBeenCalledTimes(1));
    expect(outboundUserPayload(requestUrl)).toMatchObject({
      title: "SELECTED_ITEM_TITLE_CANARY",
      sourceName: SELECTED_FEED_TITLE,
      sourceUrl: "https://articles.example.invalid/selected-guid",
      content: "SELECTED_ITEM_TITLE_CANARY description",
    });
    await vi.waitFor(() => expect(modal?.contentEl.textContent).toContain(
      "先保存原文",
    ));
    button(modal!.contentEl, "先保存原文").click();
    await vi.waitFor(() => expect(modal?.contentEl.textContent).toContain(
      "无法保存原文",
    ));

    expect(requestUrl).toHaveBeenCalledTimes(1);
    expect(saver.saveArticleWithFullContent).not.toHaveBeenCalled();
    expect(saver.saveArticle).not.toHaveBeenCalled();
    expect(test.selected.saved).toBe(false);
    expect(test.selected.savedFilePath).toBeUndefined();
    expect(replacement.saved).toBe(false);
    modal?.close();
  });

  it.each(["removed", "mutated", "ambiguous"] as const)(
    "revalidates the exact save target before ArticleSaver: %s",
    async (scenario) => {
      const test = harness();
      installAtomicAdapter(test.app);
      await test.app.vault.createFolder("Notes");
      const savedFile = await test.app.vault.create(
        "Notes/revalidate-source.md",
        "saved selected source",
      );
      const saver = installArticleSaver(test, savedFile);
      const requestUrl = vi.spyOn(obsidian, "requestUrl")
        .mockResolvedValue(responseWithText("safe revalidation analysis"));
      const modal = test.plugin.openAiOperationForItem(test.selected, "summary");
      await vi.waitFor(() => expect(modal?.contentEl.textContent).toContain(
        SELECTED_FEED_TITLE,
      ));
      button(modal!.contentEl, "确认发送").click();
      await vi.waitFor(() => expect(modal?.contentEl.textContent).toContain(
        "先保存原文",
      ));

      if (scenario === "removed") test.selectedFeed.items = [];
      if (scenario === "mutated") test.selected.title = "MUTATED_TARGET_CANARY";
      if (scenario === "ambiguous") {
        test.selectedFeed.items.push(structuredClone(test.selected));
      }
      button(modal!.contentEl, "先保存原文").click();
      await vi.waitFor(() => expect(modal?.contentEl.textContent).toContain(
        "无法保存原文",
      ));

      expect(saver.saveArticle).not.toHaveBeenCalled();
      expect(saver.saveArticleWithFullContent).not.toHaveBeenCalled();
      expect(test.selected.saved).toBe(false);
      expect(requestUrl).toHaveBeenCalledTimes(1);
      modal?.close();
    },
  );

  it("persists the exact save target transactionally with restrictedReason", async () => {
    const test = harness();
    installAtomicAdapter(test.app);
    test.settings.storageMode = "legacy-json";
    test.selected.content = "SELECTED_SAVE_CONTENT_CANARY";
    await test.app.vault.createFolder("Notes");
    const savedFile = await test.app.vault.create(
      "Notes/persisted-source.md",
      "saved selected source",
    );
    const saver = installArticleSaver(test, savedFile);
    saver.saveArticleWithFullContent.mockImplementation(async (item) => {
      item.restrictedReason = "RESTRICTED_SAVE_REASON_CANARY";
      return savedFile;
    });
    const collection = await seedSelectedCollectionItem(test);
    const requestUrl = vi.spyOn(obsidian, "requestUrl")
      .mockResolvedValue(responseWithText("safe persistent analysis"));

    const modal = test.plugin.openAiOperationForItem(test.selected, "summary");
    await vi.waitFor(() => expect(modal?.contentEl.textContent).toContain(
      SELECTED_FEED_TITLE,
    ));
    button(modal!.contentEl, "确认发送").click();
    await vi.waitFor(() => expect(modal?.contentEl.textContent).toContain(
      "先保存原文",
    ));
    button(modal!.contentEl, "先保存原文").click();
    await vi.waitFor(() => expect(modal?.contentEl.textContent).toContain(
      "插入已保存原文",
    ));

    expect(saver.saveArticleWithFullContent).toHaveBeenCalledTimes(1);
    expect(requestUrl).toHaveBeenCalledTimes(1);
    const [savedItem] = saver.saveArticleWithFullContent.mock.calls[0];
    expect(savedItem).not.toBe(test.selected);
    expect(savedItem.content).toBe("SELECTED_SAVE_CONTENT_CANARY");
    expect(test.selected).toMatchObject({
      saved: true,
      savedFilePath: savedFile.path,
      restrictedReason: "RESTRICTED_SAVE_REASON_CANARY",
    });
    const persisted = JSON.parse(
      await test.app.vault.adapter.read("data.json"),
    ) as RssDashboardSettings;
    const reloaded = persisted.feeds[1]?.items[0];
    expect(reloaded).toMatchObject({
      guid: test.selected.guid,
      saved: true,
      savedFilePath: savedFile.path,
      restrictedReason: "RESTRICTED_SAVE_REASON_CANARY",
    });
    expect(test.settings.feeds[0].items[0].saved).toBe(false);
    await expect(collection.repository.findById(collection.item.id)).resolves
      .toMatchObject({ saved: true, savedNotePath: savedFile.path });
    modal?.close();
  });

  it("persists one canonical X ID from saver input through reload", async () => {
    const test = harness();
    installAtomicAdapter(test.app);
    test.settings.storageMode = "legacy-json";
    (test.selectedFeed as Feed & { sourceType?: string }).sourceType = "x-account";
    test.selected.guid = "1901234567890123456";
    test.selected.link = "https://x.com/example/status/1901234567890123456";
    delete test.selected.rssDashboardId;
    const expectedId = createXPostCollectedItemId(test.selected.guid);
    const genericId = createCollectedItemId({
      sourceId: "selected-feed-id",
      guid: test.selected.guid,
      url: test.selected.link,
      title: test.selected.title,
      publishedAt: test.selected.pubDate,
    });
    expect(genericId).not.toBe(expectedId);
    await test.app.vault.createFolder("Notes");
    const savedFile = await test.app.vault.create(
      "Notes/canonical-x-source.md",
      "pending",
    );
    const saver = installArticleSaver(test, savedFile);
    saver.saveArticleWithFullContent.mockImplementation(async (item) => {
      await test.app.vault.adapter.write(
        savedFile.path,
        `rssDashboardId: ${item.rssDashboardId}`,
      );
      return savedFile;
    });
    const collection = await seedSelectedCollectionItem(test);
    vi.spyOn(obsidian, "requestUrl")
      .mockResolvedValue(responseWithText("safe canonical X analysis"));

    const modal = test.plugin.openAiOperationForItem(test.selected, "summary");
    await vi.waitFor(() => expect(modal?.contentEl.textContent).toContain(
      SELECTED_FEED_TITLE,
    ));
    button(modal!.contentEl, "确认发送").click();
    await vi.waitFor(() => expect(modal?.contentEl.textContent).toContain(
      "先保存原文",
    ));
    button(modal!.contentEl, "先保存原文").click();
    await vi.waitFor(() => expect(modal?.contentEl.textContent).toContain(
      "插入已保存原文",
    ));

    const [savedItem] = saver.saveArticleWithFullContent.mock.calls[0];
    expect(savedItem.rssDashboardId).toBe(expectedId);
    expect(test.selected.rssDashboardId).toBe(expectedId);
    const persisted = JSON.parse(
      await test.app.vault.adapter.read("data.json"),
    ) as RssDashboardSettings;
    expect(persisted.feeds[1]?.items[0].rssDashboardId).toBe(expectedId);
    expect(await test.app.vault.adapter.read(savedFile.path)).toContain(expectedId);
    expect(await test.app.vault.adapter.read(savedFile.path)).not.toContain(genericId);
    await expect(collection.repository.findById(expectedId)).resolves.toMatchObject({
      id: expectedId,
      saved: true,
      savedNotePath: savedFile.path,
    });

    const reloadedSettings = structuredClone(persisted);
    test.plugin.settings = reloadedSettings;
    const reloadedItem = reloadedSettings.feeds[1].items[0];
    const reopened = test.plugin.openAiOperationForItem(reloadedItem, "summary");
    expect(reopened).not.toBeNull();
    expect(reloadedItem.rssDashboardId).toBe(expectedId);
    reopened?.close();
    modal?.close();
  });

  it("rolls a newly assigned canonical X ID back when settings persistence fails", async () => {
    const test = harness();
    installAtomicAdapter(test.app);
    test.settings.storageMode = "legacy-json";
    (test.selectedFeed as Feed & { sourceType?: string }).sourceType = "x-account";
    test.selected.guid = "1901234567890123456";
    test.selected.link = "https://x.com/example/status/1901234567890123456";
    delete test.selected.rssDashboardId;
    const expectedId = createXPostCollectedItemId(test.selected.guid);
    await test.app.vault.createFolder("Notes");
    const savedFile = await test.app.vault.create(
      "Notes/rollback-canonical-x-source.md",
      "recoverable",
    );
    installArticleSaver(test, savedFile);
    const collection = await seedSelectedCollectionItem(test);
    const originalCreate = test.app.vault.create.bind(test.app.vault);
    vi.spyOn(test.app.vault, "create").mockImplementation(
      async (path, contents) => {
        if (path === "data.json") {
          throw new Error("X_ID_PERSISTENCE_FAILURE_CANARY");
        }
        return originalCreate(path, contents);
      },
    );
    vi.spyOn(obsidian, "requestUrl")
      .mockResolvedValue(responseWithText("safe canonical X rollback analysis"));

    const modal = test.plugin.openAiOperationForItem(test.selected, "summary");
    await vi.waitFor(() => expect(modal?.contentEl.textContent).toContain(
      SELECTED_FEED_TITLE,
    ));
    button(modal!.contentEl, "确认发送").click();
    await vi.waitFor(() => expect(modal?.contentEl.textContent).toContain(
      "先保存原文",
    ));
    button(modal!.contentEl, "先保存原文").click();
    await vi.waitFor(() => expect(modal?.contentEl.textContent).toContain(
      "无法保存原文",
    ));

    expect(test.selected.rssDashboardId).toBeUndefined();
    expect(test.selected.saved).toBe(false);
    expect(test.selected.savedFilePath).toBeUndefined();
    const rolledBackCollection = await collection.repository.findById(expectedId);
    expect(rolledBackCollection).toMatchObject({ id: expectedId, saved: false });
    expect(rolledBackCollection).not.toHaveProperty("savedNotePath");
    const retainedJournal = JSON.parse(await test.app.vault.adapter.read(
      ".rss-dashboard-data/state/status-repair.json",
    )) as {
      version: number;
      items: Array<{
        stableId: string;
        previousFeed: Array<{ key: string; exists: boolean }>;
      }>;
    };
    expect(retainedJournal.version).toBe(2);
    expect(retainedJournal.items[0]).toMatchObject({
      stableId: expectedId,
      previousFeed: expect.arrayContaining([
        { key: "rssDashboardId", exists: false },
      ]),
    });
    expect(test.app.vault.getAbstractFileByPath(savedFile.path)).toBe(savedFile);
    modal?.close();
  });

  it.each([
    ["matching X", "x-account", "matching"],
    ["missing non-X", "feed", "missing"],
  ] as const)(
    "keeps the authoritative ID for a %s save-first transaction",
    async (_scenario, sourceType, initialId) => {
      const test = harness();
      installAtomicAdapter(test.app);
      test.settings.storageMode = "legacy-json";
      (test.selectedFeed as Feed & { sourceType?: string }).sourceType = sourceType;
      if (sourceType === "x-account") {
        test.selected.guid = "1901234567890123456";
        test.selected.link = "https://x.com/example/status/1901234567890123456";
      }
      const expectedId = sourceType === "x-account"
        ? createXPostCollectedItemId(test.selected.guid)
        : createCollectedItemId({
            sourceId: "selected-feed-id",
            guid: test.selected.guid,
            url: test.selected.link,
            title: test.selected.title,
            publishedAt: test.selected.pubDate,
          });
      if (initialId === "matching") test.selected.rssDashboardId = expectedId;
      else delete test.selected.rssDashboardId;
      await test.app.vault.createFolder("Notes");
      const savedFile = await test.app.vault.create(
        `Notes/${sourceType}-identity-source.md`,
        "saved source",
      );
      installArticleSaver(test, savedFile);
      test.plugin.saveData = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(obsidian, "requestUrl")
        .mockResolvedValue(responseWithText("safe identity analysis"));

      const modal = test.plugin.openAiOperationForItem(test.selected, "summary");
      await vi.waitFor(() => expect(modal?.contentEl.textContent).toContain(
        SELECTED_FEED_TITLE,
      ));
      button(modal!.contentEl, "确认发送").click();
      await vi.waitFor(() => expect(modal?.contentEl.textContent).toContain(
        "先保存原文",
      ));
      button(modal!.contentEl, "先保存原文").click();
      await vi.waitFor(() => expect(modal?.contentEl.textContent).toContain(
        "插入已保存原文",
      ));

      expect(test.selected.rssDashboardId).toBe(expectedId);
      expect(test.selected.savedFilePath).toBe(savedFile.path);
      modal?.close();
    },
  );

  it("fails closed for a present mismatching X ID", () => {
    const test = harness();
    (test.selectedFeed as Feed & { sourceType?: string }).sourceType = "x-account";
    test.selected.guid = "1901234567890123456";
    test.selected.link = "https://x.com/example/status/1901234567890123456";
    const expectedId = createXPostCollectedItemId(test.selected.guid);
    expect(test.selected.rssDashboardId).not.toBe(expectedId);
    const saver = installArticleSaver(test);
    const requestUrl = vi.spyOn(obsidian, "requestUrl");

    const modal = test.plugin.openAiOperationForItem(test.selected, "summary");

    expect(modal).toBeNull();
    expect(requestUrl).not.toHaveBeenCalled();
    expect(saver.saveArticle).not.toHaveBeenCalled();
    expect(saver.saveArticleWithFullContent).not.toHaveBeenCalled();
  });

  it("rolls back feed state when persistence fails after note creation", async () => {
    const test = harness();
    installAtomicAdapter(test.app);
    test.settings.storageMode = "legacy-json";
    await test.app.vault.createFolder("Notes");
    const savedFile = await test.app.vault.create(
      "Notes/recoverable-source.md",
      "recoverable saved source",
    );
    const saver = installArticleSaver(test, savedFile);
    const collection = await seedSelectedCollectionItem(test);
    const originalCreate = test.app.vault.create.bind(test.app.vault);
    vi.spyOn(test.app.vault, "create").mockImplementation(
      async (path, contents) => {
        if (path === "data.json") {
          throw new Error("PERSISTENCE_FAILURE_CANARY");
        }
        return originalCreate(path, contents);
      },
    );
    const requestUrl = vi.spyOn(obsidian, "requestUrl")
      .mockResolvedValue(responseWithText("safe rollback analysis"));

    const modal = test.plugin.openAiOperationForItem(test.selected, "summary");
    await vi.waitFor(() => expect(modal?.contentEl.textContent).toContain(
      SELECTED_FEED_TITLE,
    ));
    button(modal!.contentEl, "确认发送").click();
    await vi.waitFor(() => expect(modal?.contentEl.textContent).toContain(
      "先保存原文",
    ));
    button(modal!.contentEl, "先保存原文").click();
    await vi.waitFor(() => expect(modal?.contentEl.textContent).toContain(
      "无法保存原文",
    ));

    expect(saver.saveArticleWithFullContent).toHaveBeenCalledTimes(1);
    expect(requestUrl).toHaveBeenCalledTimes(1);
    expect(test.selected.saved).toBe(false);
    expect(test.selected.savedFilePath).toBeUndefined();
    expect(test.selected.tags).toEqual([]);
    expect(test.settings.feeds[0].items[0].saved).toBe(false);
    const rolledBackCollection = await collection.repository.findById(
      collection.item.id,
    );
    expect(rolledBackCollection?.saved).toBe(false);
    expect(rolledBackCollection?.savedNotePath).toBeUndefined();
    expect(test.app.vault.getAbstractFileByPath(savedFile.path)).toBe(savedFile);
    modal?.close();
  });

  it("never invokes an own source-identity accessor and fails closed", () => {
    const test = harness();
    installAtomicAdapter(test.app);
    const detached = structuredClone(test.selected);
    delete detached.rssDashboardSourceId;
    test.settings.feeds[0].url =
      "https://feeds.example.invalid/unrelated-only.xml";
    let getterCalls = 0;
    Object.defineProperty(detached, "rssDashboardSourceId", {
      configurable: true,
      get() {
        getterCalls += 1;
        throw new Error("source identity getter must not run");
      },
    });
    const requestUrl = vi.spyOn(obsidian, "requestUrl");

    const modal = test.plugin.openAiOperationForItem(detached, "summary");

    expect(modal).toBeNull();
    expect(getterCalls).toBe(0);
    expect(requestUrl).not.toHaveBeenCalled();
    expect(secretState.reads).toEqual([]);
  });

  it("never invokes candidate feed identity accessors", async () => {
    const test = harness();
    installAtomicAdapter(test.app);
    const detached = structuredClone(test.selected);
    detached.rssDashboardSourceId = "selected-feed-id";
    let getterCalls = 0;
    Object.defineProperty(test.settings.feeds[0], "feedId", {
      configurable: true,
      get() {
        getterCalls += 1;
        throw new Error("candidate feed ID getter must not run");
      },
    });
    Object.defineProperty(test.settings.feeds[0], "url", {
      configurable: true,
      get() {
        getterCalls += 1;
        throw new Error("candidate feed URL getter must not run");
      },
    });
    const requestUrl = vi.spyOn(obsidian, "requestUrl")
      .mockResolvedValue(responseWithText("safe candidate-accessor analysis"));

    const modal = test.plugin.openAiOperationForItem(detached, "summary");
    await vi.waitFor(() => expect(modal?.contentEl.textContent).toContain(
      SELECTED_FEED_TITLE,
    ));
    button(modal!.contentEl, "确认发送").click();
    await vi.waitFor(() => expect(requestUrl).toHaveBeenCalledTimes(1));

    expect(getterCalls).toBe(0);
    expect(outboundUserPayload(requestUrl).sourceName).toBe(SELECTED_FEED_TITLE);
    modal?.close();
  });

  it("fails closed for an unbound detached item when duplicate feed URLs are ambiguous", () => {
    const test = harness();
    const detached = structuredClone(test.selected);
    delete detached.rssDashboardSourceId;
    const requestUrl = vi.spyOn(obsidian, "requestUrl");

    const modal = test.plugin.openAiOperationForItem(detached, "summary");

    expect(modal).toBeNull();
    expect(requestUrl).not.toHaveBeenCalled();
    expect(secretState.reads).toEqual([]);
    expect(detached.rssDashboardSourceId).toBeUndefined();
  });

  it("rejects an inherited source identity on a detached duplicate-URL item", () => {
    const test = harness();
    const detached = structuredClone(test.selected);
    delete detached.rssDashboardSourceId;
    Object.setPrototypeOf(detached, {
      rssDashboardSourceId: "selected-feed-id",
    });
    const requestUrl = vi.spyOn(obsidian, "requestUrl");

    const modal = test.plugin.openAiOperationForItem(detached, "summary");

    expect(modal).toBeNull();
    expect(requestUrl).not.toHaveBeenCalled();
    expect(secretState.reads).toEqual([]);
    expect(Object.hasOwn(detached, "rssDashboardSourceId")).toBe(false);
  });

  it("serializes only the confirmed selected-item snapshot from a hostile vault", async () => {
    const test = harness();
    await seedHostileState(test);
    const save = vi.spyOn(AnalysisRepository.prototype, "save");
    const requestUrl = vi.spyOn(obsidian, "requestUrl")
      .mockResolvedValue(responseWithText("safe analysis"));

    const modal = test.plugin.openAiOperationForItem(test.selected, "summary");
    await vi.waitFor(() => expect(modal?.contentEl.textContent).toContain(
      SELECTED_FEED_TITLE,
    ));
    expect(requestUrl).not.toHaveBeenCalled();
    expect(secretState.reads).toEqual([]);
    expect(save).not.toHaveBeenCalled();

    await test.app.vault.adapter.write(
      `${test.settings.collection.dataFolder}/content/${test.selected.rssDashboardId}.md`,
      [
        "---",
        "schemaVersion: 1",
        `itemId: ${JSON.stringify(test.selected.rssDashboardId)}`,
        `sourceUrl: ${JSON.stringify(test.selected.link)}`,
        `fetchedAt: ${JSON.stringify("2026-07-23T02:00:00.000Z")}`,
        `contentBasis: ${JSON.stringify("full-text")}`,
        "---",
        "",
        LATE_CACHE_TEXT,
      ].join("\n"),
    );

    button(modal!.contentEl, "确认发送").click();
    button(modal!.contentEl, "重试").click();
    await vi.waitFor(() => expect(requestUrl).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));

    const outbound = requestUrl.mock.calls[0]?.[0] as {
      url?: string;
      headers?: Record<string, string>;
      body?: string;
    };
    const serialized = outbound.body ?? "";
    const body = outboundBody(requestUrl);
    const messages = body.messages as Array<{ role: string; content: string }>;
    const userPayload = outboundUserPayload(requestUrl);

    expect(Object.keys(body).sort()).toEqual([
      "max_tokens",
      "messages",
      "model",
      "stream",
    ]);
    expect(body).toMatchObject({
      model: "selected-model",
      max_tokens: 4096,
      stream: false,
    });
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "system" });
    expect(messages[0].content).toContain("操作 ID：summary");
    expect(messages[1]).toMatchObject({ role: "user" });
    expect(userPayload).toEqual({
      schema: "rss-dashboard-cn.ai-reference.v1",
      operationId: "summary",
      dataClassification: "untrusted-reference-text",
      title: "SELECTED_ITEM_TITLE_CANARY",
      sourceName: SELECTED_FEED_TITLE,
      sourceUrl: "https://articles.example.invalid/selected-guid",
      contentBasis: "feed",
      truncated: false,
      content: "SELECTED_ITEM_TITLE_CANARY description",
    });
    expect(outbound.url).toBe("https://api.moonshot.cn/v1/chat/completions");
    expect(outbound.headers?.Authorization).toBe(`Bearer ${SELECTED_SECRET}`);
    expect(serialized).not.toContain(SELECTED_SECRET);
    for (const canary of UNRELATED_CANARIES) {
      expect(serialized, `outbound body leaked ${canary}`).not.toContain(canary);
    }
    expect(secretState.reads).toEqual([SELECTED_CONNECTION_ID]);
    expect(test.selected.rssDashboardSourceId).toBe("selected-feed-id");
    modal?.close();
  });

  it("invalidates the old preview when switching connections and binds the new preview to the new model", async () => {
    const test = harness();
    installAtomicAdapter(test.app);
    test.selected.description = "N".repeat(50);
    const first = test.settings.ai.connections[0];
    first.maxInputCharacters = 15;
    const second = createAiConnection({
      id: OTHER_CONNECTION_ID,
      name: "Second selected connection",
      providerKind: "deepseek",
      model: "second-selected-model",
    });
    second.maxInputCharacters = 80;
    test.settings.ai.connections = [first, second];
    secretState.values.set(OTHER_CONNECTION_ID, OTHER_SECRET);
    const requestUrl = vi.spyOn(obsidian, "requestUrl")
      .mockResolvedValue(responseWithText("safe switched analysis"));

    const modal = test.plugin.openAiOperationForItem(test.selected, "summary");
    await vi.waitFor(() => expect(modal?.contentEl.textContent).toContain(
      "约 15 个字符",
    ));
    const connectionSelect = modal!.contentEl.querySelector<HTMLSelectElement>(
      ".rss-dashboard-ai-connection-select",
    )!;
    connectionSelect.value = OTHER_CONNECTION_ID;
    connectionSelect.dispatchEvent(new Event("change"));

    expect(button(modal!.contentEl, "确认发送").disabled).toBe(true);
    expect(requestUrl).not.toHaveBeenCalled();
    expect(secretState.reads).toEqual([]);
    await vi.waitFor(() => expect(modal?.contentEl.textContent).toContain(
      "Second selected connection",
    ));
    await vi.waitFor(() => expect(modal?.contentEl.textContent).toContain(
      "约 50 个字符",
    ));

    button(modal!.contentEl, "确认发送").click();
    await vi.waitFor(() => expect(requestUrl).toHaveBeenCalledTimes(1));

    expect(outboundBody(requestUrl).model).toBe("second-selected-model");
    expect(outboundUserPayload(requestUrl).content).toBe("N".repeat(50));
    expect(requestUrl.mock.calls[0]?.[0].body).not.toContain(
      '"model":"selected-model"',
    );
    expect(secretState.reads).toEqual([OTHER_CONNECTION_ID]);
    modal?.close();
  });

  it("uses only a YouTube title and description without reading cached transcript-like data", async () => {
    const test = harness();
    installAtomicAdapter(test.app);
    test.selectedFeed.mediaType = "video";
    test.selected.mediaType = "video";
    test.selected.videoId = "video-canary";
    test.selected.description = "YOUTUBE_DESCRIPTION_CANARY";
    const cachePath =
      `${test.settings.collection.dataFolder}/content/${test.selected.rssDashboardId}.md`;
    await test.app.vault.createFolder(".rss-dashboard-data/content");
    await test.app.vault.adapter.write(cachePath, "YOUTUBE_TRANSCRIPT_CANARY");
    const read = vi.spyOn(test.app.vault.adapter, "read");
    const requestUrl = vi.spyOn(obsidian, "requestUrl")
      .mockResolvedValue(responseWithText("safe YouTube analysis"));

    const modal = test.plugin.openAiOperationForItem(test.selected, "summary");
    await vi.waitFor(() => expect(modal?.contentEl.textContent).toContain(
      "标题和摘要",
    ));

    expect(modal?.contentEl.querySelector(
      ".rss-dashboard-ai-full-text-toggle",
    )).toBeNull();
    expect(read).not.toHaveBeenCalledWith(cachePath);
    expect(requestUrl).not.toHaveBeenCalled();
    button(modal!.contentEl, "确认发送").click();
    await vi.waitFor(() => expect(requestUrl).toHaveBeenCalledTimes(1));

    expect(outboundUserPayload(requestUrl)).toMatchObject({
      contentBasis: "title-description",
      content: "SELECTED_ITEM_TITLE_CANARY YOUTUBE_DESCRIPTION_CANARY",
    });
    expect(requestUrl.mock.calls[0]?.[0].body).not.toContain(
      "YOUTUBE_TRANSCRIPT_CANARY",
    );
    expect(read).not.toHaveBeenCalledWith(cachePath);
    modal?.close();
  });

  it.each([
    ["missing credential", undefined, undefined, "当前连接尚未配置 API 密钥。", 0],
    ["invalid credential", SELECTED_SECRET, 401, "API 密钥无效或已过期。", 1],
    ["provider failure", SELECTED_SECRET, 500, "AI 操作失败，没有创建分析文档。", 1],
  ] as const)(
    "%s creates no artifact and never falls back to another connection",
    async (_scenario, selectedSecret, status, expectedMessage, requestCount) => {
      const test = harness();
      installAtomicAdapter(test.app);
      const fallback = createAiConnection({
        id: OTHER_CONNECTION_ID,
        name: "Fallback must not run",
        providerKind: "deepseek",
        model: "fallback-model-canary",
      });
      test.settings.ai.connections.push(fallback);
      secretState.values.set(OTHER_CONNECTION_ID, OTHER_SECRET);
      if (selectedSecret === undefined) {
        secretState.values.delete(SELECTED_CONNECTION_ID);
      }
      const save = vi.spyOn(AnalysisRepository.prototype, "save");
      const requestUrl = vi.spyOn(obsidian, "requestUrl");
      if (status !== undefined) {
        requestUrl.mockResolvedValue(responseWithText("provider error", status));
      }

      const modal = test.plugin.openAiOperationForItem(test.selected, "summary");
      await vi.waitFor(() => expect(button(
        modal!.contentEl,
        "确认发送",
      ).disabled).toBe(false));
      button(modal!.contentEl, "确认发送").click();
      await vi.waitFor(() => expect(modal?.contentEl.textContent).toContain(
        expectedMessage,
      ));

      expect(requestUrl).toHaveBeenCalledTimes(requestCount);
      expect(save).not.toHaveBeenCalled();
      expect(secretState.reads).toEqual([SELECTED_CONNECTION_ID]);
      expect(secretState.reads).not.toContain(OTHER_CONNECTION_ID);
      if (requestCount === 1) {
        expect(outboundBody(requestUrl).model).toBe("selected-model");
      }
      modal?.close();
    },
  );

  it("keeps a MiniMax key in the outbound header and out of the body, result, and Markdown artifact", async () => {
    const minimaxSecret = "PRIVATE_MINIMAX_API_KEY_CANARY";
    const test = harness();
    installAtomicAdapter(test.app);
    test.settings.ai.connections = [createAiConnection({
      id: SELECTED_CONNECTION_ID,
      name: "MiniMax 默认模型",
      providerKind: "minimax-global",
      model: "",
    })];
    secretState.values.set(SELECTED_CONNECTION_ID, minimaxSecret);
    const save = vi.spyOn(AnalysisRepository.prototype, "save");
    const requestUrl = vi.spyOn(obsidian, "requestUrl")
      .mockResolvedValue(responseWithText("safe MiniMax analysis"));

    const modal = test.plugin.openAiOperationForItem(test.selected, "summary");
    await vi.waitFor(() => expect(modal?.contentEl.textContent).toContain(
      "MiniMax-M3",
    ));
    button(modal!.contentEl, "确认发送").click();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const savedPath = await save.mock.results[0].value;

    const outbound = requestUrl.mock.calls[0]?.[0] as {
      headers?: Record<string, string>;
      body?: string;
    };
    const result = save.mock.calls[0]?.[0];
    const markdown = await test.app.vault.adapter.read(savedPath);

    expect(outbound.headers?.Authorization).toBe(`Bearer ${minimaxSecret}`);
    expect(outbound.body).not.toContain(minimaxSecret);
    expect(outboundBody(requestUrl)).toMatchObject({
      model: "MiniMax-M3",
      max_completion_tokens: 4096,
    });
    expect(JSON.stringify(result)).not.toContain(minimaxSecret);
    expect(result).toMatchObject({
      providerKind: "minimax-global",
      model: "MiniMax-M3",
    });
    expect(markdown).toContain('providerKind: "minimax-global"');
    expect(markdown).toContain('model: "MiniMax-M3"');
    expect(markdown).not.toContain(minimaxSecret);
    expect(modal?.contentEl.textContent).not.toContain(minimaxSecret);
    modal?.close();
  });

  it("does not echo a MiniMax key from a failed provider response", async () => {
    const minimaxSecret = "PRIVATE_MINIMAX_API_KEY_CANARY";
    const test = harness();
    installAtomicAdapter(test.app);
    test.settings.ai.connections = [createAiConnection({
      id: SELECTED_CONNECTION_ID,
      name: "MiniMax 默认模型",
      providerKind: "minimax-cn",
      model: "",
    })];
    secretState.values.set(SELECTED_CONNECTION_ID, minimaxSecret);
    const save = vi.spyOn(AnalysisRepository.prototype, "save");
    const requestUrl = vi.spyOn(obsidian, "requestUrl")
      .mockResolvedValue(responseWithText(minimaxSecret, 500));

    const modal = test.plugin.openAiOperationForItem(test.selected, "summary");
    await vi.waitFor(() => expect(button(
      modal!.contentEl,
      "确认发送",
    ).disabled).toBe(false));
    button(modal!.contentEl, "确认发送").click();
    await vi.waitFor(() => expect(modal?.contentEl.textContent).toContain(
      "AI 操作失败，没有创建分析文档。",
    ));

    const outbound = requestUrl.mock.calls[0]?.[0] as {
      headers?: Record<string, string>;
      body?: string;
    };
    expect(outbound.headers?.Authorization).toBe(`Bearer ${minimaxSecret}`);
    expect(outbound.body).not.toContain(minimaxSecret);
    expect(modal?.contentEl.textContent).not.toContain(minimaxSecret);
    expect(save).not.toHaveBeenCalled();
    modal?.close();
  });
});
