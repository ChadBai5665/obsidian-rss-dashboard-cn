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
import { createCollectedItemId } from "../../../src/collection/item-identity";
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
});
