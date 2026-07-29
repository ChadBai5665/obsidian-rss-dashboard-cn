import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  App,
  Platform,
  WorkspaceLeaf,
  type PluginManifest,
} from "obsidian";

const secretState = vi.hoisted(() => ({
  reads: [] as string[],
  constructed: 0,
  get: vi.fn<(connectionId: string) => Promise<string | undefined>>(),
}));

vi.mock("../../../src/security/desktop-secret-store", () => ({
  DesktopSecretStore: class DesktopSecretStoreMock {
    constructor() {
      secretState.constructed += 1;
    }

    async get(connectionId: string): Promise<string | undefined> {
      return await secretState.get(connectionId);
    }
  },
}));

import RssDashboardPlugin from "../../../main";
import { TikHubClient } from "../../../src/sources/tikhub/tikhub-client";
import {
  TikHubRequestLedger,
  TikHubRequestLedgerError,
} from "../../../src/sources/tikhub/request-ledger";
import {
  TikHubCaptionJobRepository,
  type TikHubCaptionJobRecord,
} from "../../../src/youtube-transcript/tikhub-caption-job-repository";
import { TikHubTranscriptProvider } from "../../../src/youtube-transcript/tikhub-transcript-provider";
import {
  YouTubeTranscriptError,
  type TranscriptProviderRegistration,
} from "../../../src/youtube-transcript/transcript-types";
import { InnerTubeTranscriptProvider } from "../../../src/youtube-transcript/innertube-transcript-provider";
import { YtDlpTranscriptProvider } from "../../../src/youtube-transcript/yt-dlp-transcript-provider";
import { RssDashboardView, RSS_DASHBOARD_VIEW_TYPE } from "../../../src/views/dashboard-view";
import { ReaderView, RSS_READER_VIEW_TYPE } from "../../../src/views/reader-view";
import { createAiConnection } from "../../../src/ai/provider-presets";
import type { AiContentSelector } from "../../../src/ai/content/ai-content-selector";
import type { CollectionService } from "../../../src/services/collection-service";
import {
  DEFAULT_SETTINGS,
  type Feed,
  type FeedItem,
  type RssDashboardSettings,
} from "../../../src/types/types";
import type { YouTubeTranscriptService } from "../../../src/youtube-transcript/youtube-transcript-service";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";

const ITEM_ID = "a".repeat(64);
const VIDEO_ID = "dQw4w9WgXcQ";
const FIRST_CONNECTION_ID = "123e4567-e89b-42d3-a456-426614174000";
const CURRENT_CONNECTION_ID = "223e4567-e89b-42d3-a456-426614174000";
const JOB_ID = "323e4567-e89b-42d3-a456-426614174000";

interface TranscriptRuntime {
  service: YouTubeTranscriptService;
  contentRepository: {
    write(content: {
      schemaVersion: 2;
      contentBasis: "youtube-transcript";
      itemId: string;
      fetchedAt: string;
      videoId: string;
      languageCode: string;
      languageName: string;
      isGenerated: boolean;
      provider: "innertube" | "tikhub" | "yt-dlp";
      text: string;
    }): Promise<string>;
  };
}

interface ProviderOptions {
  createClient(settings: RssDashboardSettings["tikhub"]): TikHubClient;
}

function manifest(): PluginManifest {
  return {
    id: "rss-dashboard",
    name: "RSS Dashboard",
    version: "1.0.0",
    author: "Test",
    description: "Test plugin",
    dir: ".",
  };
}

function createPlugin(): RssDashboardPlugin {
  const plugin = new RssDashboardPlugin(App.createMock(), manifest());
  plugin.settings = structuredClone(DEFAULT_SETTINGS);
  plugin.settings.tikhub = {
    ...plugin.settings.tikhub,
    enabled: true,
    youtubeTranscriptFallbackEnabled: true,
    connectionId: FIRST_CONNECTION_ID,
  };
  return plugin;
}

function prepareOnload(plugin: RssDashboardPlugin): void {
  plugin.loadData = vi.fn().mockResolvedValue(structuredClone(plugin.settings));
  plugin.saveData = vi.fn().mockResolvedValue(undefined);
  plugin.registerView = vi.fn();
  plugin.addRibbonIcon = vi.fn().mockReturnValue({ onClick: vi.fn() });
  plugin.addCommand = vi.fn();
  plugin.addSettingTab = vi.fn();
  plugin.registerInterval = vi.fn((id: number) => id);
  plugin.registerObsidianProtocolHandler = vi.fn();
}

function watchTikHubClient(): Array<ReturnType<typeof vi.spyOn>> {
  return [
    vi.spyOn(TikHubClient.prototype, "fetchYouTubeCaptions"),
    vi.spyOn(TikHubClient.prototype, "fetchYouTubeCaptionResult"),
    vi.spyOn(TikHubClient.prototype, "fetchUserPosts"),
    vi.spyOn(TikHubClient.prototype, "fetchUserReplies"),
    vi.spyOn(TikHubClient.prototype, "fetchSearchTimeline"),
  ];
}

function expectPassiveTikHubIsolation(
  methods: readonly { mock: { calls: unknown[][] } }[],
): void {
  expect(secretState.reads).toEqual([]);
  expect(secretState.get).not.toHaveBeenCalled();
  for (const method of methods) expect(method).not.toHaveBeenCalled();
}

function runtimeFor(plugin: RssDashboardPlugin): TranscriptRuntime {
  return (plugin as unknown as {
    getYouTubeTranscriptRuntime(): TranscriptRuntime;
  }).getYouTubeTranscriptRuntime();
}

function providerRegistrations(
  service: YouTubeTranscriptService,
): readonly TranscriptProviderRegistration[] {
  return (service as unknown as {
    providers: readonly TranscriptProviderRegistration[];
  }).providers;
}

function tikhubProvider(service: YouTubeTranscriptService): TikHubTranscriptProvider {
  const registration = providerRegistrations(service).find(
    ({ source }) => source === "tikhub",
  );
  if (!(registration?.provider instanceof TikHubTranscriptProvider)) {
    throw new Error("TikHub transcript provider is not registered");
  }
  return registration.provider;
}

function captionTracksResponse() {
  return {
    data: {
      video_id: VIDEO_ID,
      captions: [{ language_code: "en", language_name: "English" }],
    },
  };
}

function captionContentResponse() {
  return {
    data: {
      video_id: VIDEO_ID,
      language_code: "en",
      language_name: "English",
      format: "txt",
      content: "Synthetic caption text.",
    },
  };
}

function innerTubeTrack() {
  return {
    videoId: VIDEO_ID,
    languageCode: "en",
    languageName: "English",
    isGenerated: false,
    source: "innertube" as const,
    format: "json3" as const,
    url: "https://example.com/innertube-caption",
  };
}

function ytDlpTrack() {
  return {
    ...innerTubeTrack(),
    source: "yt-dlp" as const,
  };
}

function transcript(provider: "innertube" | "yt-dlp") {
  return {
    videoId: VIDEO_ID,
    languageCode: "en",
    languageName: "English",
    isGenerated: false,
    provider,
    text: "Synthetic free-provider caption.",
  };
}

function processingJob(): TikHubCaptionJobRecord {
  return {
    schemaVersion: 1,
    itemId: ITEM_ID,
    videoId: VIDEO_ID,
    stage: "tracks",
    format: "txt",
    jobId: JOB_ID,
    connectionId: CURRENT_CONNECTION_ID,
    createdAt: "2026-07-30T00:00:00.000Z",
    lastCheckedAt: "2026-07-30T00:00:00.000Z",
    status: "processing",
  };
}

function article(): FeedItem {
  return {
    guid: "passive-article",
    title: "Passive article",
    link: "https://example.substack.com/passive-article",
    description: "No transcript action was requested.",
    content: '<p class="image-link image2 is-viewable-img">Passive article body.</p>',
    pubDate: "2026-07-30T00:00:00.000Z",
    feedUrl: "https://example.com/feed.xml",
    feedTitle: "Example feed",
    coverImage: "",
    tags: [],
  };
}

function passiveFeed(item = article()): Feed {
  return {
    feedId: "passive-feed",
    sourceKind: "feed",
    sourceConfig: { kind: "feed" },
    title: "Passive feed",
    url: item.feedUrl,
    folder: "Research",
    items: [item],
    lastUpdated: 1,
    mediaType: "article",
  };
}

function registeredViewFactory<T>(
  plugin: RssDashboardPlugin,
  viewType: string,
): (leaf: WorkspaceLeaf) => T {
  const registration = vi.mocked(plugin.registerView).mock.calls.find(
    ([registeredType]) => registeredType === viewType,
  );
  if (!registration) throw new Error(`Missing registered view: ${viewType}`);
  return registration[1] as (leaf: WorkspaceLeaf) => T;
}

function collectionService(plugin: RssDashboardPlugin): CollectionService {
  return (plugin as unknown as {
    getCollectionService(): CollectionService;
  }).getCollectionService();
}

let previousDesktopApp = false;

beforeEach(() => {
  installObsidianDomPolyfills();
  vi.restoreAllMocks();
  previousDesktopApp = (Platform as typeof Platform & { isDesktopApp: boolean })
    .isDesktopApp;
  (Platform as typeof Platform & { isDesktopApp: boolean }).isDesktopApp = true;
  secretState.reads = [];
  secretState.constructed = 0;
  secretState.get.mockReset();
  secretState.get.mockImplementation(async (connectionId) => {
    secretState.reads.push(connectionId);
    return `synthetic-key-for-${connectionId}`;
  });
});

afterEach(() => {
  (Platform as typeof Platform & { isDesktopApp: boolean }).isDesktopApp =
    previousDesktopApp;
});

describe("TikHub transcript runtime wiring", () => {
  it("registers the explicit fallback order without reading a secret", () => {
    const runtime = runtimeFor(createPlugin());

    expect(providerRegistrations(runtime.service).map(({ source }) => source)).toEqual([
      "innertube",
      "tikhub",
      "yt-dlp",
    ]);
    expect(secretState.reads).toEqual([]);
  });

  it("loads the real plugin lifecycle without reading a TikHub key or making a request", async () => {
    const plugin = createPlugin();
    prepareOnload(plugin);
    const clientMethods = watchTikHubClient();

    await plugin.onload();

    expect(secretState.constructed).toBeGreaterThan(0);
    expectPassiveTikHubIsolation(clientMethods);
    plugin.onunload();
  });

  it("renders a real registered dashboard with populated feed content without TikHub activity", async () => {
    const plugin = createPlugin();
    plugin.settings.feeds = [passiveFeed()];
    prepareOnload(plugin);
    const clientMethods = watchTikHubClient();

    await plugin.onload();
    const leaf = new WorkspaceLeaf(plugin.app);
    const dashboard = registeredViewFactory<RssDashboardView>(
      plugin,
      RSS_DASHBOARD_VIEW_TYPE,
    )(leaf);
    leaf.view = dashboard;
    (leaf as WorkspaceLeaf & { loadIfDeferred(): Promise<void> }).loadIfDeferred =
      vi.fn().mockResolvedValue(undefined);
    vi.spyOn(plugin.app.workspace, "getLeavesOfType").mockImplementation(
      (viewType) => viewType === RSS_DASHBOARD_VIEW_TYPE ? [leaf] : [],
    );

    await dashboard.onOpen();
    await plugin.refreshDashboardViews();

    expect(dashboard.containerEl.textContent).toContain("Passive article");
    expectPassiveTikHubIsolation(clientMethods);
    await dashboard.onClose();
  });

  it("opens a persisted matching article in the real registered reader without TikHub activity", async () => {
    const plugin = createPlugin();
    const item = article();
    const feed = passiveFeed(item);
    plugin.settings.feeds = [feed];
    prepareOnload(plugin);
    const clientMethods = watchTikHubClient();

    await plugin.onload();
    const [persisted] = await collectionService(plugin).collectFeedRefresh({
      feed,
      previousItems: [],
      refreshedItems: [item],
      fetchedAt: new Date("2026-07-30T00:00:00.000Z"),
    });
    expect(await plugin.getCollectedItemById(persisted.id)).toMatchObject({
      id: persisted.id,
      sourceId: "passive-feed",
    });
    const reader = registeredViewFactory<ReaderView>(
      plugin,
      RSS_READER_VIEW_TYPE,
    )(new WorkspaceLeaf(plugin.app));
    (reader as unknown as { contentEl: HTMLElement }).contentEl =
      reader.containerEl;

    await reader.onOpen();
    await reader.displayItem(item);

    expect(reader.containerEl.textContent).toContain("Passive article");
    expectPassiveTikHubIsolation(clientMethods);
    await reader.onClose();
  });

  it("runs a due populated RSS refresh through the real parser without TikHub activity", async () => {
    const plugin = createPlugin();
    const feed = passiveFeed();
    plugin.settings.feeds = [feed];
    plugin.settings.refreshMode = "daily-on-open";
    plugin.settings.startupRefreshDelaySeconds = 0;
    prepareOnload(plugin);
    const clientMethods = watchTikHubClient();
    const rssRequest = vi.fn().mockResolvedValue({
      status: 200,
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
      json: {},
      text: `<?xml version="1.0"?><rss version="2.0"><channel><title>Passive feed</title><link>https://example.com</link><description>test</description><item><title>Refreshed article</title><link>https://example.substack.com/refreshed</link><guid>refreshed-guid</guid><pubDate>Wed, 30 Jul 2026 00:00:00 GMT</pubDate><description><![CDATA[<p>Refreshed body</p>]]></description></item></channel></rss>`,
    });
    const obsidian = await import("obsidian");
    vi.spyOn(obsidian, "requestUrl").mockImplementation(rssRequest);

    await plugin.onload();
    await (plugin as unknown as {
      refreshOnOpenIfNeeded(): Promise<void>;
    }).refreshOnOpenIfNeeded();

    expect(rssRequest).toHaveBeenCalledWith(expect.objectContaining({
      url: feed.url,
      method: "GET",
    }));
    expect(plugin.settings.feeds[0].items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: "Refreshed article",
        link: "https://example.substack.com/refreshed",
      }),
    ]));
    expectPassiveTikHubIsolation(clientMethods);
  });

  it("selects populated matching feed content for AI without TikHub activity", async () => {
    const plugin = createPlugin();
    const item = article();
    const feed = passiveFeed(item);
    plugin.settings.feeds = [feed];
    plugin.settings.ai.connections = [createAiConnection({
      id: CURRENT_CONNECTION_ID,
      name: "Local selection connection",
      providerKind: "kimi",
      model: "local-test-model",
    })];
    plugin.settings.ai.defaultConnectionId = CURRENT_CONNECTION_ID;
    prepareOnload(plugin);
    const clientMethods = watchTikHubClient();

    await plugin.onload();
    const [persisted] = await collectionService(plugin).collectFeedRefresh({
      feed,
      previousItems: [],
      refreshedItems: [item],
      fetchedAt: new Date("2026-07-30T00:00:00.000Z"),
    });
    const options = plugin.createAiPanelOptionsForItem(item);
    expect(options?.createStartInput("summary", CURRENT_CONNECTION_ID)).toMatchObject({
      item: { id: persisted.id },
      fetchFullText: false,
    });
    const selector = (plugin as unknown as {
      aiRuntime: { contentSelector: AiContentSelector };
    }).aiRuntime.contentSelector;

    await expect(selector.select({
      item: persisted,
      fetchFullText: false,
      maxInputCharacters: 4_000,
    })).resolves.toMatchObject({
      basis: "feed",
      title: "Passive article",
      content: expect.stringContaining("No transcript action was requested"),
    });
    expectPassiveTikHubIsolation(clientMethods);
  });

  it("uses the public service's InnerTube success without touching TikHub", async () => {
    const plugin = createPlugin();
    const runtime = runtimeFor(plugin);
    const tikhubRequest = vi.spyOn(TikHubClient.prototype, "fetchYouTubeCaptions");
    const ytDlpTracks = vi.spyOn(YtDlpTranscriptProvider.prototype, "listTracks");
    vi.spyOn(InnerTubeTranscriptProvider.prototype, "listTracks")
      .mockResolvedValue([innerTubeTrack()]);
    vi.spyOn(InnerTubeTranscriptProvider.prototype, "fetchTrack")
      .mockResolvedValue(transcript("innertube"));

    await expect(runtime.service.get({ itemId: ITEM_ID, videoId: VIDEO_ID }))
      .resolves.toMatchObject({ status: "ready", source: "fresh" });

    expect(secretState.constructed).toBe(0);
    expect(secretState.reads).toEqual([]);
    expect(tikhubRequest).not.toHaveBeenCalled();
    expect(ytDlpTracks).not.toHaveBeenCalled();
  });

  it("serves a persisted transcript cache hit through service.get without probing providers", async () => {
    const plugin = createPlugin();
    const runtime = runtimeFor(plugin);
    const clientMethods = watchTikHubClient();
    const innerTube = vi.spyOn(InnerTubeTranscriptProvider.prototype, "listTracks");
    const ytDlp = vi.spyOn(YtDlpTranscriptProvider.prototype, "listTracks");
    await runtime.contentRepository.write({
      schemaVersion: 2,
      contentBasis: "youtube-transcript",
      itemId: ITEM_ID,
      fetchedAt: "2026-07-30T00:00:00.000Z",
      videoId: VIDEO_ID,
      languageCode: "en",
      languageName: "English",
      isGenerated: false,
      provider: "innertube",
      text: "Persisted synthetic transcript.",
    });

    await expect(runtime.service.get({ itemId: ITEM_ID, videoId: VIDEO_ID }))
      .resolves.toMatchObject({ status: "ready", source: "cache" });

    expectPassiveTikHubIsolation(clientMethods);
    expect(innerTube).not.toHaveBeenCalled();
    expect(ytDlp).not.toHaveBeenCalled();
  });

  it("uses yt-dlp when TikHub is disabled without reading a key", async () => {
    const plugin = createPlugin();
    plugin.settings.tikhub = {
      ...plugin.settings.tikhub,
      enabled: false,
      youtubeTranscriptFallbackEnabled: false,
    };
    const runtime = runtimeFor(plugin);
    const tikhubRequest = vi.spyOn(TikHubClient.prototype, "fetchYouTubeCaptions");
    vi.spyOn(InnerTubeTranscriptProvider.prototype, "listTracks")
      .mockRejectedValue(new YouTubeTranscriptError("no-captions"));
    vi.spyOn(YtDlpTranscriptProvider.prototype, "isAvailable")
      .mockResolvedValue(true);
    vi.spyOn(YtDlpTranscriptProvider.prototype, "listTracks")
      .mockResolvedValue([ytDlpTrack()]);
    vi.spyOn(YtDlpTranscriptProvider.prototype, "fetchTrack")
      .mockResolvedValue(transcript("yt-dlp"));

    await expect(runtime.service.get({ itemId: ITEM_ID, videoId: VIDEO_ID }))
      .resolves.toMatchObject({ status: "ready", source: "fresh" });

    expect(secretState.constructed).toBe(0);
    expect(secretState.reads).toEqual([]);
    expect(tikhubRequest).not.toHaveBeenCalled();
  });

  it("reads only current settings and the current key when an explicit TikHub operation reaches the provider", async () => {
    const plugin = createPlugin();
    const runtime = runtimeFor(plugin);
    const provider = tikhubProvider(runtime.service);
    const options = (provider as unknown as { options: ProviderOptions }).options;
    const createClient = vi.spyOn(options, "createClient");
    const fetchCaptions = vi.spyOn(TikHubClient.prototype, "fetchYouTubeCaptions")
      .mockResolvedValue(captionTracksResponse());

    plugin.settings.tikhub = {
      ...plugin.settings.tikhub,
      connectionId: CURRENT_CONNECTION_ID,
      baseUrl: "https://api.tikhub.dev",
      timeoutMs: 12_345,
      maxRequestsPerRun: 7,
      maxRequestsPerDay: 9,
    };

    const tracks = await provider.listTracks(VIDEO_ID, undefined, {
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
    });

    expect(secretState.reads).toEqual([CURRENT_CONNECTION_ID]);
    expect(createClient).toHaveBeenCalledWith({
      enabled: true,
      youtubeTranscriptFallbackEnabled: true,
      connectionId: CURRENT_CONNECTION_ID,
      baseUrl: "https://api.tikhub.dev",
      timeoutMs: 12_345,
      maxRequestsPerRun: 7,
      maxRequestsPerDay: 9,
    });
    expect(fetchCaptions).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: `synthetic-key-for-${CURRENT_CONNECTION_ID}`,
      videoId: VIDEO_ID,
    }));
    expect(tracks).toMatchObject({
      value: [{ source: "tikhub", languageCode: "en" }],
    });
  });

  it("uses the X daily ledger instead of creating a separate YouTube allowance", async () => {
    const plugin = createPlugin();
    plugin.settings.tikhub = {
      ...plugin.settings.tikhub,
      connectionId: CURRENT_CONNECTION_ID,
      maxRequestsPerRun: 2,
      maxRequestsPerDay: 1,
    };
    const provider = tikhubProvider(runtimeFor(plugin).service);
    const options = (provider as unknown as { options: ProviderOptions }).options;
    const client = options.createClient(plugin.settings.tikhub) as unknown as {
      budget: { reserve(count: number): Promise<{ markAttempted(): void }> };
    };
    const reservation = await client.budget.reserve(1);
    reservation.markAttempted();
    const registry = (plugin as unknown as {
      createSourceRegistryForRun(): {
        get(kind: "x-account"): {
          refresh(config: unknown, context: { now: Date }): Promise<unknown>;
        };
      };
    }).createSourceRegistryForRun();

    await expect(registry.get("x-account").refresh({
      kind: "x-account",
      id: "openai",
      handle: "openai",
      includeReplies: false,
      includeReposts: false,
      folder: "X",
      topics: [],
    }, { now: new Date("2026-07-30T00:00:00.000Z") }))
      .rejects.toMatchObject<TikHubRequestLedgerError>({ code: "daily-limit" });
  });

  it("serializes an old X reservation and a new-connection transcript reservation against one daily cap", async () => {
    const plugin = createPlugin();
    plugin.settings.tikhub = {
      ...plugin.settings.tikhub,
      maxRequestsPerRun: 2,
      maxRequestsPerDay: 3,
    };
    const runtime = runtimeFor(plugin);
    const registry = (plugin as unknown as {
      createSourceRegistryForRun(): {
        get(kind: "x-account"): {
          refresh(config: unknown, context: { now: Date }): Promise<unknown>;
        };
      };
    }).createSourceRegistryForRun();
    const adapter = plugin.app.vault.adapter as {
      write(path: string, content: string): Promise<void>;
    };
    const originalWrite = adapter.write.bind(adapter);
    let releaseOldWrite!: () => void;
    const oldWriteReleased = new Promise<void>((resolve) => {
      releaseOldWrite = resolve;
    });
    let oldWriteStarted!: () => void;
    const oldWriteStartedPromise = new Promise<void>((resolve) => {
      oldWriteStarted = resolve;
    });
    let holdFirstLedgerWrite = true;
    let oldWriteHasReleased = false;
    let newConnectionWriteOvertookOld = false;
    adapter.write = async (path, content) => {
      if (holdFirstLedgerWrite && path.includes("state/tikhub-requests.json.tmp-")) {
        holdFirstLedgerWrite = false;
        oldWriteStarted();
        await oldWriteReleased;
      } else if (
        path.includes("state/tikhub-requests.json.tmp-") &&
        !oldWriteHasReleased
      ) {
        newConnectionWriteOvertookOld = true;
      }
      await originalWrite(path, content);
    };
    vi.spyOn(TikHubClient.prototype, "fetchUserPosts")
      .mockImplementation(async function (this: TikHubClient) {
        const budget = (this as unknown as {
          budget: { reserve(count: number): Promise<{ markAttempted(): void }> };
        }).budget;
        const reservation = await budget.reserve(1);
        reservation.markAttempted();
        return { data: { instructions: [] } };
      });
    vi.spyOn(InnerTubeTranscriptProvider.prototype, "listTracks")
      .mockRejectedValue(new YouTubeTranscriptError("no-captions"));
    vi.spyOn(TikHubClient.prototype, "fetchYouTubeCaptions")
      .mockImplementation(async function (this: TikHubClient, input) {
        const budget = (this as unknown as {
          budget: { reserve(count: number): Promise<{ markAttempted(): void }> };
        }).budget;
        const reservation = await budget.reserve(1);
        reservation.markAttempted();
        return input.languageCode === undefined
          ? captionTracksResponse()
          : captionContentResponse();
      });

    const oldXRefresh = registry.get("x-account").refresh({
      kind: "x-account",
      id: "openai",
      handle: "openai",
      includeReplies: false,
      includeReposts: false,
      folder: "X",
      topics: [],
    }, { now: new Date("2026-07-30T00:00:00.000Z") }).catch(() => undefined);
    await oldWriteStartedPromise;
    plugin.settings.tikhub = {
      ...plugin.settings.tikhub,
      connectionId: CURRENT_CONNECTION_ID,
    };
    const transcript = runtime.service.get({ itemId: ITEM_ID, videoId: VIDEO_ID });
    window.setTimeout(() => {
      oldWriteHasReleased = true;
      releaseOldWrite();
    }, 25);

    await expect(transcript).resolves.toMatchObject({ status: "ready" });
    await oldXRefresh;
    expect(newConnectionWriteOvertookOld).toBe(false);
    const ledger = new TikHubRequestLedger(
      plugin.app.vault,
      plugin.settings.collection.dataFolder,
      { storageIdentity: "test:observer" },
    );
    await expect(ledger.getSnapshot()).resolves.toMatchObject({ count: 3 });
  });

  it("does not read a key for cache-only work, and disposal aborts a poll without deleting its job", async () => {
    vi.useFakeTimers();
    const plugin = createPlugin();
    plugin.settings.tikhub = {
      ...plugin.settings.tikhub,
      connectionId: CURRENT_CONNECTION_ID,
    };
    const runtime = runtimeFor(plugin);
    const jobs = new TikHubCaptionJobRepository(
      plugin.app.vault,
      plugin.settings.collection.dataFolder,
    );
    await jobs.write(processingJob());
    const innerTube = vi.spyOn(InnerTubeTranscriptProvider.prototype, "listTracks")
      .mockRejectedValue(new YouTubeTranscriptError("no-captions"));
    let abortObserved = false;
    let startNetwork!: () => void;
    const networkStarted = new Promise<void>((resolve) => {
      startNetwork = resolve;
    });
    vi.spyOn(TikHubClient.prototype, "fetchYouTubeCaptionResult")
      .mockImplementation(async ({ signal }) => await new Promise((_, reject) => {
        startNetwork();
        signal?.addEventListener("abort", () => {
          abortObserved = true;
          reject(new Error("synthetic poll aborted"));
        }, { once: true });
      }));

    await expect(runtime.service.readCached({ itemId: ITEM_ID, videoId: VIDEO_ID }))
      .resolves.toBeNull();
    expect(secretState.reads).toEqual([]);

    const operation = runtime.service.get({ itemId: ITEM_ID, videoId: VIDEO_ID });
    await vi.advanceTimersByTimeAsync(3_000);
    await networkStarted;
    runtime.service.dispose();

    await expect(operation).rejects.toMatchObject({ code: "aborted" });
    expect(abortObserved).toBe(true);
    await expect(jobs.read(`${ITEM_ID}:${VIDEO_ID}:tracks`)).resolves.toMatchObject({
      jobId: JOB_ID,
      connectionId: CURRENT_CONNECTION_ID,
      status: "processing",
    });
    expect(innerTube).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
