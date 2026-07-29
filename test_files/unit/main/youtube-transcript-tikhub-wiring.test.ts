import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, Platform, type PluginManifest } from "obsidian";

const secretState = vi.hoisted(() => ({
  reads: [] as string[],
  constructed: 0,
}));

vi.mock("../../../src/security/desktop-secret-store", () => ({
  DesktopSecretStore: class DesktopSecretStoreMock {
    constructor() {
      secretState.constructed += 1;
    }

    async get(connectionId: string): Promise<string | undefined> {
      secretState.reads.push(connectionId);
      return `synthetic-key-for-${connectionId}`;
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
import {
  DEFAULT_SETTINGS,
  type FeedItem,
  type RssDashboardSettings,
} from "../../../src/types/types";
import type { YouTubeTranscriptService } from "../../../src/youtube-transcript/youtube-transcript-service";

const ITEM_ID = "a".repeat(64);
const VIDEO_ID = "dQw4w9WgXcQ";
const FIRST_CONNECTION_ID = "123e4567-e89b-42d3-a456-426614174000";
const CURRENT_CONNECTION_ID = "223e4567-e89b-42d3-a456-426614174000";
const JOB_ID = "323e4567-e89b-42d3-a456-426614174000";

interface TranscriptRuntime {
  service: YouTubeTranscriptService;
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
    link: "https://example.com/passive-article",
    description: "No transcript action was requested.",
    pubDate: "2026-07-30T00:00:00.000Z",
    feedUrl: "https://example.com/feed.xml",
    feedTitle: "Example feed",
    coverImage: "",
    tags: [],
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  (Platform as typeof Platform & { isDesktopApp: boolean }).isDesktopApp = true;
  secretState.reads = [];
  secretState.constructed = 0;
});

afterEach(() => {
  (Platform as typeof Platform & { isDesktopApp: boolean }).isDesktopApp = false;
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

  it("does not read a TikHub key for dashboard, article, daily-refresh, or AI setup", async () => {
    const plugin = createPlugin();

    await plugin.refreshDashboardViews();
    await plugin.getCollectedItemById(ITEM_ID);
    plugin.createAiPanelOptionsForItem(article());
    await (plugin as unknown as {
      refreshOnOpenIfNeeded(): Promise<void>;
    }).refreshOnOpenIfNeeded();

    expect(secretState.reads).toEqual([]);
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
