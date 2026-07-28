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

vi.mock("../../../src/ai/providers/streaming-ai-transport", async () => {
  const actual = await vi.importActual<typeof import(
    "../../../src/ai/providers/streaming-ai-transport"
  )>("../../../src/ai/providers/streaming-ai-transport");
  const obsidianModule = await import("obsidian");
  return {
    ...actual,
    createNodeAiStreamingTransport: () => async (
      request: {
        url: string;
        method: "POST";
        headers: Record<string, string>;
        body: string;
      },
    ) => {
      const response = await obsidianModule.requestUrl({
        url: request.url,
        method: request.method,
        headers: request.headers,
        body: request.body,
        throw: false,
      });
      return {
        status: response.status,
        headers: response.headers,
        contentType: "application/json",
        bodyText: response.text,
      };
    },
  };
});
import RssDashboardPlugin from "../../../main";
import { AnalysisRepository } from "../../../src/ai/analysis-repository";
import { createAiConnection } from "../../../src/ai/provider-presets";
import { createCollectedItemId } from "../../../src/collection/item-identity";
import { ContentRepository } from "../../../src/collection/content-repository";
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
const UNRELATED_CANARY = "UNRELATED_ITEM_BODY_CANARY";

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
const DEFAULT_SECRET_PATH_CANARY =
  "/Users/privacy/Library/Application Support/rss-dashboard-cn/secrets.json";

function item(guid: string, title: string, description: string): FeedItem {
  return {
    title,
    link: `https://articles.example.invalid/${guid}`,
    description,
    pubDate: "2026-07-23T00:00:00.000Z",
    guid,
    read: false,
    starred: false,
    saved: false,
    tags: [],
    feedTitle: "Selected source",
    feedUrl: "https://feeds.example.invalid/selected.xml",
    coverImage: "",
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

function harness() {
  const app = App.createMock();
  installAtomicAdapter(app);
  const plugin = new RssDashboardPlugin(app, {
    id: "rss-dashboard",
    name: "RSS Dashboard",
    version: "2.5.0",
  });
  const settings: RssDashboardSettings = structuredClone(DEFAULT_SETTINGS);
  const selected = item(
    "selected-guid",
    "SELECTED_ITEM_TITLE_CANARY",
    "SELECTED_ITEM_DESCRIPTION_CANARY",
  );
  const unrelated = item(
    "unrelated-guid",
    "UNRELATED_ITEM_TITLE_CANARY",
    UNRELATED_CANARY,
  );
  const feed: Feed = {
    feedId: "selected-feed-id",
    sourceKind: "feed",
    sourceConfig: { kind: "feed" },
    title: "SELECTED_SOURCE_TITLE_CANARY",
    url: selected.feedUrl,
    folder: "Research",
    items: [selected, unrelated],
    lastUpdated: Date.now(),
  };
  settings.feeds = [feed];
  settings.ai.connections = [
    createAiConnection({
      id: SELECTED_CONNECTION_ID,
      name: "Selected connection",
      providerKind: "kimi",
      model: "selected-model",
    }),
    createAiConnection({
      id: OTHER_CONNECTION_ID,
      name: "Unrelated connection",
      providerKind: "kimi",
      model: "unrelated-model",
    }),
  ];
  settings.ai.defaultConnectionId = SELECTED_CONNECTION_ID;
  plugin.settings = settings;
  secretState.values.set(SELECTED_CONNECTION_ID, SELECTED_SECRET);
  secretState.values.set(OTHER_CONNECTION_ID, OTHER_SECRET);
  return { app, plugin, settings, selected, unrelated };
}

function outboundBody(requestUrl: ReturnType<typeof vi.spyOn>): string {
  const request = requestUrl.mock.calls[0]?.[0] as { body?: string } | undefined;
  return request?.body ?? "";
}

beforeEach(() => {
  installObsidianDomPolyfills();
  secretState.reads.length = 0;
  secretState.values.clear();
  vi.restoreAllMocks();
});

describe("inline AI privacy boundary", () => {
  it("does not read any key or provider endpoint while composing panel dependencies", () => {
    const test = harness();
    const requestUrl = vi.spyOn(obsidian, "requestUrl");

    const options = test.plugin.createAiPanelOptionsForItem(test.selected);

    expect(options).not.toBeNull();
    expect(secretState.reads).toEqual([]);
    expect(requestUrl).not.toHaveBeenCalled();
    expect(JSON.stringify({
      itemId: options?.itemId,
      connections: options?.connections,
      defaultConnectionId: options?.defaultConnectionId,
    })).not.toContain(SELECTED_SECRET);
  });

  it("after explicit start sends only the selected item and selected connection secret", async () => {
    const test = harness();
    const requestUrl = vi.spyOn(obsidian, "requestUrl")
      .mockResolvedValue(responseWithText("Safe analysis"));
    const options = test.plugin.createAiPanelOptionsForItem(test.selected)!;

    const terminal = await options.coordinator.start(
      options.createStartInput("summary", SELECTED_CONNECTION_ID),
    );

    expect(terminal.status).toBe("complete");
    expect(secretState.reads).toEqual([SELECTED_CONNECTION_ID]);
    expect(outboundBody(requestUrl)).toContain("SELECTED_ITEM_TITLE_CANARY");
    expect(outboundBody(requestUrl)).toContain("SELECTED_ITEM_DESCRIPTION_CANARY");
    expect(outboundBody(requestUrl)).not.toContain(UNRELATED_CANARY);
    expect(outboundBody(requestUrl)).not.toContain(OTHER_SECRET);
    const outbound = requestUrl.mock.calls[0]?.[0] as {
      headers?: Record<string, string>;
    };
    expect(outbound.headers?.Authorization).toBe(`Bearer ${SELECTED_SECRET}`);
  });

  it("does not serialize unrelated vault, cache, settings, or connection data", async () => {
    const test = harness();
    await test.app.vault.createFolder("Notes");
    await test.app.vault.create(
      "Notes/unrelated.md",
      `UNRELATED_NOTE_CANARY\n${DEFAULT_SECRET_PATH_CANARY}`,
    );
    const unrelatedId = createCollectedItemId({
      sourceId: "selected-feed-id",
      guid: test.unrelated.guid,
      url: test.unrelated.link,
      title: test.unrelated.title,
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
      text: "UNRELATED_CACHE_CANARY",
    });
    test.settings.folders = [{
      name: `UNRELATED_FOLDER_CANARY ${DEFAULT_SECRET_PATH_CANARY}`,
      subfolders: [],
    }];
    test.settings.tikhub.connectionId = "UNRELATED_TIKHUB_CANARY";
    const requestUrl = vi.spyOn(obsidian, "requestUrl")
      .mockResolvedValue(responseWithText("Safe selected analysis"));
    const options = test.plugin.createAiPanelOptionsForItem(test.selected)!;

    await options.coordinator.start(
      options.createStartInput("summary", SELECTED_CONNECTION_ID),
    );

    const body = outboundBody(requestUrl);
    for (const canary of [
      "UNRELATED_NOTE_CANARY",
      "UNRELATED_CACHE_CANARY",
      "UNRELATED_FOLDER_CANARY",
      "UNRELATED_TIKHUB_CANARY",
      DEFAULT_SECRET_PATH_CANARY,
      OTHER_SECRET,
    ]) {
      expect(body).not.toContain(canary);
    }
  });

  it("fails closed on a mismatched stored stable ID before key access", () => {
    const test = harness();
    test.selected.rssDashboardId = createCollectedItemId({
      sourceId: "selected-feed-id",
      guid: test.unrelated.guid,
      url: test.unrelated.link,
      title: test.unrelated.title,
      publishedAt: test.unrelated.pubDate,
    });
    const requestUrl = vi.spyOn(obsidian, "requestUrl");

    expect(test.plugin.createAiPanelOptionsForItem(test.selected)).toBeNull();
    expect(secretState.reads).toEqual([]);
    expect(requestUrl).not.toHaveBeenCalled();
  });

  it("never invokes a hostile own source-identity accessor", () => {
    const test = harness();
    const detached = structuredClone(test.selected);
    let getterCalls = 0;
    Object.defineProperty(detached, "rssDashboardSourceId", {
      configurable: true,
      get() {
        getterCalls += 1;
        throw new Error("source identity getter must not run");
      },
    });

    expect(test.plugin.createAiPanelOptionsForItem(detached)).toBeNull();
    expect(getterCalls).toBe(0);
    expect(secretState.reads).toEqual([]);
  });

  it.each(["removed", "mutated", "ambiguous"] as const)(
    "revalidates the exact source before save-first insertion: %s",
    async (scenario) => {
      const test = harness();
      const saver = installArticleSaver(test);
      vi.spyOn(obsidian, "requestUrl")
        .mockResolvedValue(responseWithText("Safe revalidation analysis"));
      const options = test.plugin.createAiPanelOptionsForItem(test.selected)!;
      const terminal = await options.coordinator.start(
        options.createStartInput("summary", SELECTED_CONNECTION_ID),
      );

      if (scenario === "removed") test.settings.feeds[0].items = [];
      if (scenario === "mutated") test.selected.title = "MUTATED_TARGET_CANARY";
      if (scenario === "ambiguous") {
        test.settings.feeds[0].items.push(structuredClone(test.selected));
      }

      await expect(options.insertArtifact(terminal.artifactPath!)).rejects
        .toThrow();
      expect(saver.saveArticle).not.toHaveBeenCalled();
      expect(saver.saveArticleWithFullContent).not.toHaveBeenCalled();
      expect(test.selected.saved).toBe(false);
    },
  );

  it("saves the trusted source first, inserts the verified result, and persists canonical flags", async () => {
    const test = harness();
    test.settings.storageMode = "legacy-json";
    await test.app.vault.createFolder("Notes");
    const savedFile = await test.app.vault.create(
      "Notes/source.md",
      "Trusted source bytes",
    );
    const saver = installArticleSaver(test, savedFile);
    test.plugin.saveData = vi.fn(async () => undefined);
    vi.spyOn(obsidian, "requestUrl")
      .mockResolvedValue(responseWithText("Safe insertable analysis"));
    vi.spyOn(
      test.plugin as unknown as { openAiVaultFile(): Promise<void> },
      "openAiVaultFile",
    ).mockResolvedValue(undefined);
    const options = test.plugin.createAiPanelOptionsForItem(test.selected)!;
    const terminal = await options.coordinator.start(
      options.createStartInput("summary", SELECTED_CONNECTION_ID),
    );

    await options.insertArtifact(terminal.artifactPath!);

    expect(saver.saveArticleWithFullContent).toHaveBeenCalledTimes(1);
    expect(test.selected).toMatchObject({
      rssDashboardId: options.itemId,
      saved: true,
      savedFilePath: savedFile.path,
    });
    expect(await test.app.vault.read(savedFile)).toContain(
      "RSS-DASHBOARD-CN:AI:",
    );
  });

  it("keeps a MiniMax key only in the outbound authorization header", async () => {
    const test = harness();
    const minimaxSecret = "PRIVATE_MINIMAX_API_KEY_CANARY";
    test.settings.ai.connections = [createAiConnection({
      id: SELECTED_CONNECTION_ID,
      name: "MiniMax default",
      providerKind: "minimax-global",
      model: "",
    })];
    secretState.values.set(SELECTED_CONNECTION_ID, minimaxSecret);
    const save = vi.spyOn(AnalysisRepository.prototype, "save");
    const requestUrl = vi.spyOn(obsidian, "requestUrl")
      .mockResolvedValue(responseWithText("Safe MiniMax analysis"));
    const options = test.plugin.createAiPanelOptionsForItem(test.selected)!;

    const terminal = await options.coordinator.start(
      options.createStartInput("summary", SELECTED_CONNECTION_ID),
    );

    const outbound = requestUrl.mock.calls[0]?.[0] as {
      url?: string;
      headers?: Record<string, string>;
      body?: string;
    };
    const safeHeaders = { ...outbound.headers };
    delete safeHeaders.Authorization;
    const requestBody = JSON.parse(outbound.body ?? "{}") as Record<string, unknown>;
    const persistedResult = save.mock.calls[0]?.[0];
    const markdown = await test.app.vault.adapter.read(terminal.artifactPath!);
    expect(outbound.headers?.Authorization).toBe(`Bearer ${minimaxSecret}`);
    expect(requestBody).toMatchObject({
      model: "MiniMax-M3",
      max_completion_tokens: 4096,
    });
    expect(JSON.stringify({
      url: outbound.url,
      headers: safeHeaders,
      body: outbound.body,
      persistedResult,
      markdown,
    })).not.toContain(minimaxSecret);
  });

  it("never persists or publishes a raw provider failure containing the key", async () => {
    const test = harness();
    const save = vi.spyOn(AnalysisRepository.prototype, "save");
    vi.spyOn(obsidian, "requestUrl").mockResolvedValue(
      responseWithText(`provider rejected ${SELECTED_SECRET}`, 500),
    );
    const options = test.plugin.createAiPanelOptionsForItem(test.selected)!;

    const terminal = await options.coordinator.start(
      options.createStartInput("summary", SELECTED_CONNECTION_ID),
    );

    expect(terminal.status).toBe("failed");
    expect(JSON.stringify(terminal)).not.toContain(SELECTED_SECRET);
    expect(save).not.toHaveBeenCalled();
  });
});
