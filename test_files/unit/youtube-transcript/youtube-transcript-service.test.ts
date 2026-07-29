import { describe, expect, it, vi } from "vitest";
import type {
  CachedItemContent,
  YouTubeTranscriptCachedItemContent,
} from "../../../src/collection/content-repository";
import {
  YouTubeTranscriptService,
  YouTubeTranscriptServiceError,
  type TranscriptCacheRepository,
  type TranscriptMetadataRepository,
} from "../../../src/youtube-transcript/youtube-transcript-service";
import {
  YouTubeTranscriptError,
  type TranscriptProvider,
  type TranscriptProviderOperationContext,
  type TranscriptProviderRegistration,
  type YouTubeCaptionTrack,
  type YouTubeTranscript,
  type YouTubeTranscriptProgress,
  type YouTubeTranscriptProvider,
} from "../../../src/youtube-transcript/transcript-types";

const ITEM_ID = "a".repeat(64);
const OTHER_ITEM_ID = "b".repeat(64);
const VIDEO_ID = "dQw4w9WgXcQ";
const CONTENT_PATH = `.rss-dashboard-data/content/${ITEM_ID}.md`;

function track(
  overrides: Partial<YouTubeCaptionTrack> = {},
): YouTubeCaptionTrack {
  const { source = "innertube", format, ...details } = overrides;
  const base = {
    languageCode: "en",
    languageName: "English",
    isGenerated: false,
    url: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en",
    ...details,
  };
  if (source === "tikhub") return { ...base, source, format: "txt" };
  return {
    ...base,
    source,
    format: format === "srv3" || format === "vtt" ? format : "json3",
  };
}

function runtimeTrack(
  source: YouTubeTranscriptProvider,
  format: "json3" | "srv3" | "vtt" | "txt",
  overrides: Partial<YouTubeCaptionTrack> = {},
): YouTubeCaptionTrack {
  const candidate = track(overrides);
  Reflect.set(candidate, "source", source);
  Reflect.set(candidate, "format", format);
  return candidate;
}

function transcript(
  selectedTrack: YouTubeCaptionTrack,
  overrides: Partial<YouTubeTranscript> = {},
): YouTubeTranscript {
  return {
    videoId: VIDEO_ID,
    languageCode: selectedTrack.languageCode,
    languageName: selectedTrack.languageName,
    isGenerated: selectedTrack.isGenerated,
    provider: selectedTrack.source,
    text: "A complete public subtitle transcript.",
    ...overrides,
  };
}

function cached(
  overrides: Partial<YouTubeTranscriptCachedItemContent> = {},
): YouTubeTranscriptCachedItemContent {
  return {
    schemaVersion: 2,
    contentBasis: "youtube-transcript",
    itemId: ITEM_ID,
    sourceUrl: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
    fetchedAt: "2026-07-28T06:00:00.000Z",
    videoId: VIDEO_ID,
    languageCode: "en",
    languageName: "English",
    isGenerated: false,
    provider: "innertube",
    text: "Cached transcript.",
    ...overrides,
  };
}

class FakeProvider implements TranscriptProvider {
  listCalls = 0;
  fetchCalls = 0;

  constructor(
    private readonly tracks:
      | YouTubeCaptionTrack[]
      | YouTubeTranscriptError = [track()],
    private readonly fetchResult:
      | YouTubeTranscript
      | YouTubeTranscriptError = transcript(track()),
  ) {}

  async listTracks(): Promise<YouTubeCaptionTrack[]> {
    this.listCalls += 1;
    if (this.tracks instanceof YouTubeTranscriptError) throw this.tracks;
    return this.tracks;
  }

  async fetchTrack(selectedTrack: YouTubeCaptionTrack): Promise<YouTubeTranscript> {
    this.fetchCalls += 1;
    if (this.fetchResult instanceof YouTubeTranscriptError) {
      throw this.fetchResult;
    }
    return {
      ...this.fetchResult,
      languageCode: selectedTrack.languageCode,
      languageName: selectedTrack.languageName,
      isGenerated: selectedTrack.isGenerated,
      provider: selectedTrack.source,
    };
  }
}

class FakeOptionalProvider extends FakeProvider {
  availabilityChecks = 0;

  constructor(
    private readonly availability: boolean | Error,
    tracks?: YouTubeCaptionTrack[] | YouTubeTranscriptError,
    fetchResult?: YouTubeTranscript | YouTubeTranscriptError,
  ) {
    super(tracks, fetchResult);
  }

  async isAvailable(): Promise<boolean> {
    this.availabilityChecks += 1;
    if (this.availability instanceof Error) throw this.availability;
    return this.availability;
  }
}

class PersistTrackingOptionalProvider extends FakeOptionalProvider {
  readonly persisted: Array<{
    track: YouTubeCaptionTrack;
    transcript: YouTubeTranscript;
  }> = [];

  async onPersisted(
    savedTrack: YouTubeCaptionTrack,
    savedTranscript: YouTubeTranscript,
  ): Promise<void> {
    this.persisted.push({ track: savedTrack, transcript: savedTranscript });
  }
}

class FakeContentRepository implements TranscriptCacheRepository {
  value: CachedItemContent | null;
  readonly writes: YouTubeTranscriptCachedItemContent[] = [];
  readCalls = 0;
  private transactionTail: Promise<void> = Promise.resolve();

  constructor(initial: CachedItemContent | null = null) {
    this.value = initial;
  }

  async read(): Promise<CachedItemContent | null> {
    this.readCalls += 1;
    return this.value;
  }

  async write(value: CachedItemContent): Promise<string> {
    if (value.contentBasis !== "youtube-transcript") {
      throw new Error("Only transcript writes belong in this fake");
    }
    this.writes.push(value);
    this.value = value;
    return CONTENT_PATH;
  }

  pathFor(): string {
    return CONTENT_PATH;
  }

  async transaction<T>(
    _itemId: string,
    operation: (transaction: {
      read(): Promise<CachedItemContent | null>;
      write(value: CachedItemContent): Promise<string>;
      pathFor(): string;
    }) => Promise<T>,
  ): Promise<T> {
    const prior = this.transactionTail;
    let release!: () => void;
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await operation({
        read: async () => await this.read(),
        write: async (value) => await this.write(value),
        pathFor: () => this.pathFor(),
      });
    } finally {
      release();
    }
  }
}

class FailingWriteContentRepository extends FakeContentRepository {
  override async write(_value: CachedItemContent): Promise<string> {
    throw new Error("local content write failed");
  }
}

class FailingTransactionContentRepository extends FakeContentRepository {
  override async transaction<T>(
    _itemId: string,
    _operation: (transaction: {
      read(): Promise<CachedItemContent | null>;
      write(value: CachedItemContent): Promise<string>;
      pathFor(): string;
    }) => Promise<T>,
  ): Promise<T> {
    throw new Error("local content transaction failed");
  }
}

class FakeMetadataRepository implements TranscriptMetadataRepository {
  readonly updates: Array<{
    id: string;
    path: string;
    basis: "youtube-transcript";
  }> = [];
  failuresRemaining = 0;

  async updateContentMetadata(
    id: string,
    path: string,
    basis: "youtube-transcript",
  ): Promise<void> {
    this.updates.push({ id, path, basis });
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error("metadata unavailable");
    }
  }
}

function createService(options: {
  innerTube?: TranscriptProvider;
  tikHub?: FakeOptionalProvider;
  ytDlp?: FakeOptionalProvider;
  providers?: TranscriptProviderRegistration[];
  content?: FakeContentRepository;
  metadata?: FakeMetadataRepository;
  clock?: () => Date;
  choiceTtlMs?: number;
  maxPendingChoiceSets?: number;
} = {}): {
  service: YouTubeTranscriptService;
  innerTube: TranscriptProvider;
  tikHub: FakeOptionalProvider;
  ytDlp: FakeOptionalProvider;
  content: FakeContentRepository;
  metadata: FakeMetadataRepository;
} {
  const innerTube = options.innerTube ?? new FakeProvider();
  const tikHub = options.tikHub ?? new FakeOptionalProvider(false);
  const ytDlp = options.ytDlp ?? new FakeOptionalProvider(true);
  const content = options.content ?? new FakeContentRepository();
  const metadata = options.metadata ?? new FakeMetadataRepository();
  return {
    service: new YouTubeTranscriptService({
      providers: options.providers ?? [
        { source: "innertube", provider: innerTube },
        {
          source: "tikhub",
          provider: tikHub,
          isAvailable: async () => await tikHub.isAvailable(),
        },
        {
          source: "yt-dlp",
          provider: ytDlp,
          isAvailable: async () => await ytDlp.isAvailable(),
        },
      ],
      contentRepository: content,
      metadataRepository: metadata,
      clock: options.clock ?? (() => new Date("2026-07-28T06:00:00.000Z")),
      choiceTtlMs: options.choiceTtlMs,
      maxPendingChoiceSets: options.maxPendingChoiceSets,
    }),
    innerTube,
    tikHub,
    ytDlp,
    content,
    metadata,
  };
}

describe("YouTubeTranscriptService", () => {
  it("rejects empty and duplicate-source provider chains", () => {
    expect(() => createService({ providers: [] })).toThrow(
      "Invalid transcript provider chain",
    );
    expect(() => createService({
      providers: [
        { source: "innertube", provider: new FakeProvider() },
        { source: "innertube", provider: new FakeProvider() },
      ],
    })).toThrow("Invalid transcript provider chain");
  });

  it("rejects unbounded pending-choice retention settings", () => {
    expect(() => createService({ choiceTtlMs: 60 * 60 * 1_000 })).toThrow(
      "Invalid choice TTL",
    );
    expect(() => createService({ maxPendingChoiceSets: 1_000 })).toThrow(
      "Invalid pending choice capacity",
    );
  });

  it("tries available providers in registration order and skips unavailable ones", async () => {
    const events: string[] = [];
    const innerTube: TranscriptProvider = {
      async listTracks() {
        events.push("innertube:list");
        throw new YouTubeTranscriptError("temporarily-unavailable");
      },
      async fetchTrack(selectedTrack) {
        return transcript(selectedTrack);
      },
    };
    const tikHub = new FakeOptionalProvider(false, [track({ source: "tikhub" })]);
    const localTrack = track({ source: "yt-dlp" });
    const ytDlp: TranscriptProvider = {
      async listTracks() {
        events.push("yt-dlp:list");
        return [localTrack];
      },
      async fetchTrack(selectedTrack) {
        events.push("yt-dlp:fetch");
        return transcript(selectedTrack);
      },
    };
    const { service } = createService({
      providers: [
        { source: "innertube", provider: innerTube },
        {
          source: "tikhub",
          provider: tikHub,
          isAvailable: async () => {
            events.push("tikhub:available");
            return false;
          },
        },
        {
          source: "yt-dlp",
          provider: ytDlp,
          isAvailable: async () => {
            events.push("yt-dlp:available");
            return true;
          },
        },
      ],
    });

    await expect(
      service.get({ itemId: ITEM_ID, videoId: VIDEO_ID }),
    ).resolves.toMatchObject({
      status: "ready",
      content: { provider: "yt-dlp" },
      usage: { tikhubPaidRequests: 0 },
    });
    expect(events).toEqual([
      "innertube:list",
      "tikhub:available",
      "yt-dlp:available",
      "yt-dlp:list",
      "yt-dlp:fetch",
    ]);
  });

  it("passes one frozen operation context through a fresh provider lifecycle", async () => {
    const observed: Array<{
      phase: "list" | "fetch" | "persist";
      context: TranscriptProviderOperationContext;
    }> = [];
    const selected = track();
    const innerTube: TranscriptProvider = {
      async listTracks(_videoId, _signal, context) {
        observed.push({ phase: "list", context });
        return [selected];
      },
      async fetchTrack(selectedTrack, _signal, context) {
        observed.push({ phase: "fetch", context });
        return transcript(selectedTrack);
      },
      async onPersisted(_savedTrack, _savedTranscript, context) {
        observed.push({ phase: "persist", context });
      },
    };
    const { service } = createService({ innerTube });

    await expect(
      service.get({ itemId: ITEM_ID, videoId: VIDEO_ID, refresh: true }),
    ).resolves.toMatchObject({ status: "ready" });

    expect(observed.map(({ phase }) => phase)).toEqual([
      "list",
      "fetch",
      "persist",
    ]);
    expect(observed[0].context).toEqual({
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
    });
    expect(observed[1].context).toBe(observed[0].context);
    expect(observed[2].context).toBe(observed[0].context);
    expect(Object.isFrozen(observed[0].context)).toBe(true);
  });

  it("keeps persistence and later hooks isolated from provider context mutation", async () => {
    const mutations: boolean[] = [];
    const observed: TranscriptProviderOperationContext[] = [];
    const content = new FakeContentRepository();
    const selected = track();
    const innerTube: TranscriptProvider = {
      async listTracks(_videoId, _signal, context) {
        observed.push(context);
        mutations.push(Reflect.set(context, "itemId", OTHER_ITEM_ID));
        return [selected];
      },
      async fetchTrack(selectedTrack, _signal, context) {
        observed.push(context);
        mutations.push(Reflect.set(context, "videoId", "abcdefghijk"));
        return transcript(selectedTrack);
      },
      async onPersisted(_savedTrack, _savedTranscript, context) {
        observed.push(context);
      },
    };
    const { service } = createService({ innerTube, content });

    await expect(
      service.get({ itemId: ITEM_ID, videoId: VIDEO_ID, refresh: true }),
    ).resolves.toMatchObject({
      status: "ready",
      content: { itemId: ITEM_ID, videoId: VIDEO_ID },
    });

    expect(mutations).toEqual([false, false]);
    expect(observed).toEqual([
      { itemId: ITEM_ID, videoId: VIDEO_ID },
      { itemId: ITEM_ID, videoId: VIDEO_ID },
      { itemId: ITEM_ID, videoId: VIDEO_ID },
    ]);
    expect(content.value).toMatchObject({ itemId: ITEM_ID, videoId: VIDEO_ID });
  });

  it("restores the original operation context for a selected choice", async () => {
    const listContexts: TranscriptProviderOperationContext[] = [];
    const fetchContexts: TranscriptProviderOperationContext[] = [];
    const persistContexts: TranscriptProviderOperationContext[] = [];
    const tracks = [
      track({ languageName: "English", url: "innertube:caption/en" }),
      track({
        languageName: "English (United States)",
        url: "innertube:caption/en-us",
      }),
    ];
    const innerTube: TranscriptProvider = {
      async listTracks(_videoId, _signal, context) {
        listContexts.push(context);
        return tracks;
      },
      async fetchTrack(selectedTrack, _signal, context) {
        fetchContexts.push(context);
        return transcript(selectedTrack);
      },
      async onPersisted(_savedTrack, _savedTranscript, context) {
        persistContexts.push(context);
      },
    };
    const { service } = createService({ innerTube });
    const choices = await service.get({
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      refresh: true,
    });
    if (choices.status !== "selection-required") {
      throw new Error("expected choices");
    }

    await expect(
      service.get({
        itemId: OTHER_ITEM_ID,
        videoId: VIDEO_ID,
        refresh: true,
        trackId: choices.tracks[0].id,
      }),
    ).rejects.toMatchObject({ code: "temporarily-unavailable" });
    expect(fetchContexts).toEqual([]);

    await expect(
      service.get({
        itemId: ITEM_ID,
        videoId: VIDEO_ID,
        refresh: true,
        trackId: choices.tracks[0].id,
      }),
    ).resolves.toMatchObject({
      status: "ready",
      content: { itemId: ITEM_ID, videoId: VIDEO_ID },
    });
    expect(listContexts).toEqual([{ itemId: ITEM_ID, videoId: VIDEO_ID }]);
    expect(fetchContexts).toEqual([{ itemId: ITEM_ID, videoId: VIDEO_ID }]);
    expect(persistContexts).toEqual([{ itemId: ITEM_ID, videoId: VIDEO_ID }]);
    expect(fetchContexts[0]).toBe(persistContexts[0]);
    expect(Object.isFrozen(fetchContexts[0])).toBe(true);
  });

  it("keeps providers with legacy method arity usable through the legacy constructor", async () => {
    const content = new FakeContentRepository();
    const metadata = new FakeMetadataRepository();
    const innerTube = new FakeProvider([track()]);
    const ytDlp = new FakeOptionalProvider(true);
    const service = new YouTubeTranscriptService({
      innerTube,
      ytDlp,
      contentRepository: content,
      metadataRepository: metadata,
      clock: () => new Date("2026-07-28T06:00:00.000Z"),
    });

    await expect(
      service.get({ itemId: ITEM_ID, videoId: VIDEO_ID, refresh: true }),
    ).resolves.toMatchObject({
      status: "ready",
      content: { provider: "innertube" },
    });
    expect(innerTube.listCalls).toBe(1);
    expect(innerTube.fetchCalls).toBe(1);
    expect(ytDlp.availabilityChecks).toBe(0);
  });

  it.each([
    { registrationSource: "innertube", trackSource: "innertube", format: "json3", accepted: true },
    { registrationSource: "innertube", trackSource: "innertube", format: "srv3", accepted: true },
    { registrationSource: "innertube", trackSource: "innertube", format: "vtt", accepted: true },
    { registrationSource: "innertube", trackSource: "innertube", format: "txt", accepted: false },
    { registrationSource: "yt-dlp", trackSource: "yt-dlp", format: "json3", accepted: true },
    { registrationSource: "yt-dlp", trackSource: "yt-dlp", format: "srv3", accepted: true },
    { registrationSource: "yt-dlp", trackSource: "yt-dlp", format: "vtt", accepted: true },
    { registrationSource: "yt-dlp", trackSource: "yt-dlp", format: "txt", accepted: false },
    { registrationSource: "tikhub", trackSource: "tikhub", format: "json3", accepted: false },
    { registrationSource: "tikhub", trackSource: "tikhub", format: "srv3", accepted: false },
    { registrationSource: "tikhub", trackSource: "tikhub", format: "vtt", accepted: false },
    { registrationSource: "tikhub", trackSource: "tikhub", format: "txt", accepted: true },
    { registrationSource: "tikhub", trackSource: "innertube", format: "json3", accepted: false },
  ] as const)(
    "accepts=$accepted for $registrationSource registration returning $trackSource/$format",
    async ({ registrationSource, trackSource, format, accepted }) => {
      const candidate = runtimeTrack(trackSource, format);
      let fetchCalls = 0;
      let persistedCalls = 0;
      const provider: TranscriptProvider = {
        async listTracks() {
          return [candidate];
        },
        async fetchTrack(selectedTrack) {
          fetchCalls += 1;
          return transcript(selectedTrack);
        },
        async onPersisted() {
          persistedCalls += 1;
        },
      };
      const content = new FakeContentRepository();
      const { service } = createService({
        content,
        providers: [{ source: registrationSource, provider }],
      });
      const request = service.get({
        itemId: ITEM_ID,
        videoId: VIDEO_ID,
        refresh: true,
      });

      if (accepted) {
        await expect(request).resolves.toMatchObject({
          status: "ready",
          content: { provider: registrationSource },
        });
        expect(fetchCalls).toBe(1);
        expect(persistedCalls).toBe(1);
        expect(content.writes).toHaveLength(1);
      } else {
        await expect(request).rejects.toBeInstanceOf(
          YouTubeTranscriptServiceError,
        );
        expect(fetchCalls).toBe(0);
        expect(persistedCalls).toBe(0);
        expect(content.writes).toEqual([]);
      }
    },
  );

  it("persists a selected TikHub txt choice without exposing its locator", async () => {
    const tracks = [
      runtimeTrack("tikhub", "txt", {
        languageName: "English",
        url: "tikhub:caption/en",
      }),
      runtimeTrack("tikhub", "txt", {
        languageName: "English (United States)",
        url: "tikhub:caption/en-us",
      }),
    ];
    let persistedTrack: YouTubeCaptionTrack | undefined;
    const provider: TranscriptProvider = {
      async listTracks() {
        return tracks;
      },
      async fetchTrack(selectedTrack) {
        return transcript(selectedTrack);
      },
      async onPersisted(selectedTrack) {
        persistedTrack = selectedTrack;
      },
    };
    const content = new FakeContentRepository();
    const { service } = createService({
      content,
      providers: [{ source: "tikhub", provider }],
    });
    const choices = await service.get({
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      refresh: true,
    });
    if (choices.status !== "selection-required") {
      throw new Error("expected TikHub choices");
    }
    expect(choices.tracks[0]).not.toHaveProperty("url");
    expect(choices.tracks[0]).not.toHaveProperty("format");

    await expect(
      service.get({
        itemId: ITEM_ID,
        videoId: VIDEO_ID,
        refresh: true,
        trackId: choices.tracks[1].id,
      }),
    ).resolves.toMatchObject({
      status: "ready",
      content: { provider: "tikhub", languageName: "English (United States)" },
    });
    expect(persistedTrack).toBe(tracks[1]);
    expect(persistedTrack?.format).toBe("txt");
    expect(content.writes).toHaveLength(1);
  });

  it.each([
    { field: "format", value: "json3" },
    { field: "source", value: "yt-dlp" },
  ] as const)(
    "rejects a selected TikHub choice whose retained $field is modified",
    async ({ field, value }) => {
      const tracks = [
        runtimeTrack("tikhub", "txt", { url: "tikhub:caption/en" }),
        runtimeTrack("tikhub", "txt", {
          languageName: "English (United States)",
          url: "tikhub:caption/en-us",
        }),
      ];
      let fetchCalls = 0;
      let persistedCalls = 0;
      const provider: TranscriptProvider = {
        async listTracks() {
          return tracks;
        },
        async fetchTrack(selectedTrack) {
          fetchCalls += 1;
          return transcript(selectedTrack, { provider: "tikhub" });
        },
        async onPersisted() {
          persistedCalls += 1;
        },
      };
      const content = new FakeContentRepository();
      const { service } = createService({
        content,
        providers: [{ source: "tikhub", provider }],
      });
      const choices = await service.get({
        itemId: ITEM_ID,
        videoId: VIDEO_ID,
        refresh: true,
      });
      if (choices.status !== "selection-required") {
        throw new Error("expected TikHub choices");
      }
      Reflect.set(tracks[0], field, value);

      await expect(
        service.get({
          itemId: ITEM_ID,
          videoId: VIDEO_ID,
          refresh: true,
          trackId: choices.tracks[0].id,
        }),
      ).rejects.toBeInstanceOf(YouTubeTranscriptServiceError);
      expect(fetchCalls).toBe(0);
      expect(persistedCalls).toBe(0);
      expect(content.writes).toEqual([]);
    },
  );

  it("revalidates a TikHub txt track after provider fetch before persistence", async () => {
    const selected = runtimeTrack("tikhub", "txt");
    let fetchCalls = 0;
    let persistedCalls = 0;
    const provider: TranscriptProvider = {
      async listTracks() {
        return [selected];
      },
      async fetchTrack(selectedTrack) {
        fetchCalls += 1;
        Reflect.set(selectedTrack, "format", "json3");
        return transcript(selectedTrack, { provider: "tikhub" });
      },
      async onPersisted() {
        persistedCalls += 1;
      },
    };
    const content = new FakeContentRepository();
    const { service } = createService({
      content,
      providers: [{ source: "tikhub", provider }],
    });

    await expect(
      service.get({ itemId: ITEM_ID, videoId: VIDEO_ID, refresh: true }),
    ).rejects.toBeInstanceOf(YouTubeTranscriptServiceError);
    expect(fetchCalls).toBe(1);
    expect(persistedCalls).toBe(0);
    expect(content.writes).toEqual([]);
  });

  it("continues from a failed TikHub provider to local yt-dlp", async () => {
    const innerTube = new FakeProvider(
      new YouTubeTranscriptError("temporarily-unavailable"),
    );
    const tikHub = new FakeOptionalProvider(
      true,
      new YouTubeTranscriptError("tikhub-rate-limited"),
    );
    const ytDlp = new FakeOptionalProvider(true, [track({ source: "yt-dlp" })]);
    const { service } = createService({ innerTube, tikHub, ytDlp });

    await expect(
      service.get({ itemId: ITEM_ID, videoId: VIDEO_ID, refresh: true }),
    ).resolves.toMatchObject({
      status: "ready",
      content: { provider: "yt-dlp" },
      usage: { tikhubPaidRequests: 0 },
    });
    expect(tikHub.listCalls).toBe(1);
    expect(ytDlp.listCalls).toBe(1);
  });

  it("stops the chain while TikHub processing is resumable", async () => {
    const tikHub = new FakeOptionalProvider(
      true,
      new YouTubeTranscriptError("tikhub-processing"),
    );
    const ytDlp = new FakeOptionalProvider(true, [track({ source: "yt-dlp" })]);
    const progress: YouTubeTranscriptProgress[] = [];
    const { service } = createService({
      innerTube: new FakeProvider(
        new YouTubeTranscriptError("temporarily-unavailable"),
      ),
      tikHub,
      ytDlp,
    });

    await expect(
      service.get({
        itemId: ITEM_ID,
        videoId: VIDEO_ID,
        refresh: true,
        onProgress: (entry) => progress.push(entry),
      }),
    ).rejects.toMatchObject({
      code: "tikhub-processing",
      usage: { tikhubPaidRequests: 0 },
    });
    expect(progress[progress.length - 1]).toEqual({
      stage: "waiting-tikhub",
      usage: { tikhubPaidRequests: 0 },
    });
    expect(ytDlp.availabilityChecks).toBe(0);
    expect(ytDlp.listCalls).toBe(0);
  });

  it("prefers actionable TikHub failures over generic local unavailability", async () => {
    const secret = "provider-secret-that-must-not-survive";
    const tikHub = new FakeOptionalProvider(
      true,
      new YouTubeTranscriptError("tikhub-missing-key"),
    );
    const ytDlp = new FakeOptionalProvider(false);
    const { service } = createService({
      innerTube: new FakeProvider(
        new YouTubeTranscriptError("temporarily-unavailable"),
      ),
      tikHub,
      ytDlp,
    });

    let failure: unknown;
    try {
      await service.get({ itemId: ITEM_ID, videoId: VIDEO_ID, refresh: true });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: "tikhub-missing-key",
      usage: { tikhubPaidRequests: 0 },
      failures: [
        { source: "innertube", code: "temporarily-unavailable" },
        { source: "tikhub", code: "tikhub-missing-key" },
        { source: "yt-dlp", code: "fallback-unavailable" },
      ],
    });
    expect(JSON.stringify(failure)).not.toContain(secret);
    expect((failure as Error).message).toBe("tikhub-missing-key");
  });

  it("keeps TikHub choices bound to TikHub and reports two valid paid responses", async () => {
    const tracks = [
      track({
        source: "tikhub",
        languageName: "English",
        url: "tikhub:caption/en/one",
      }),
      track({
        source: "tikhub",
        languageName: "English (United States)",
        url: "tikhub:caption/en/two",
      }),
    ];
    const tikHub = new FakeOptionalProvider(true, tracks);
    const ytDlp = new FakeOptionalProvider(true, [track({ source: "yt-dlp" })]);
    const { service } = createService({
      innerTube: new FakeProvider(new YouTubeTranscriptError("no-captions")),
      tikHub,
      ytDlp,
    });

    const choices = await service.get({
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      refresh: true,
    });
    if (choices.status !== "selection-required") {
      throw new Error("expected TikHub choices");
    }
    expect(choices.tracks.map(({ provider }) => provider)).toEqual([
      "tikhub",
      "tikhub",
    ]);

    await expect(
      service.get({
        itemId: ITEM_ID,
        videoId: VIDEO_ID,
        refresh: true,
        trackId: choices.tracks[1].id,
      }),
    ).resolves.toMatchObject({
      status: "ready",
      content: { provider: "tikhub", languageName: "English (United States)" },
      usage: { tikhubPaidRequests: 2 },
    });
    expect(tikHub.listCalls).toBe(1);
    expect(tikHub.fetchCalls).toBe(1);
    expect(ytDlp.availabilityChecks).toBe(0);
  });

  it("coalesces duplicate TikHub track selections without double usage", async () => {
    const tracks = [
      track({ source: "tikhub", languageName: "English", url: "tikhub:en" }),
      track({ source: "tikhub", languageName: "English US", url: "tikhub:en-us" }),
    ];
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    let fetchCalls = 0;
    const tikHub: TranscriptProvider = {
      async listTracks() {
        return tracks;
      },
      async fetchTrack(selectedTrack) {
        fetchCalls += 1;
        await fetchGate;
        return transcript(selectedTrack);
      },
    };
    const { service } = createService({
      innerTube: new FakeProvider(new YouTubeTranscriptError("no-captions")),
      providers: [
        {
          source: "innertube",
          provider: new FakeProvider(new YouTubeTranscriptError("no-captions")),
        },
        { source: "tikhub", provider: tikHub },
      ],
    });
    const choices = await service.get({
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      refresh: true,
    });
    if (choices.status !== "selection-required") throw new Error("expected choices");
    const request = {
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      refresh: true,
      trackId: choices.tracks[0].id,
    } as const;

    const first = service.get(request);
    const second = service.get(request);
    await Promise.resolve();
    releaseFetch();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ usage: { tikhubPaidRequests: 2 } }),
      expect.objectContaining({ usage: { tikhubPaidRequests: 2 } }),
    ]);
    expect(fetchCalls).toBe(1);
  });

  it("reports exact TikHub usage after valid empty-list and content responses", async () => {
    const emptyTikHub = new FakeOptionalProvider(true, []);
    const local = new FakeOptionalProvider(true, [track({ source: "yt-dlp" })]);
    const emptyResult = createService({
      innerTube: new FakeProvider(new YouTubeTranscriptError("no-captions")),
      tikHub: emptyTikHub,
      ytDlp: local,
    });
    await expect(
      emptyResult.service.get({ itemId: ITEM_ID, videoId: VIDEO_ID, refresh: true }),
    ).resolves.toMatchObject({ usage: { tikhubPaidRequests: 1 } });

    const oneTrackTikHub = new FakeOptionalProvider(
      true,
      [track({ source: "tikhub", url: "tikhub:caption/en" })],
    );
    const success = createService({
      innerTube: new FakeProvider(new YouTubeTranscriptError("no-captions")),
      tikHub: oneTrackTikHub,
    });
    await expect(
      success.service.get({ itemId: ITEM_ID, videoId: VIDEO_ID, refresh: true }),
    ).resolves.toMatchObject({ usage: { tikhubPaidRequests: 2 } });
  });

  it("preserves one paid TikHub request when choice registration fails locally", async () => {
    const tikHub = new PersistTrackingOptionalProvider(true, [
      track({
        source: "tikhub",
        languageName: "English",
        url: "tikhub:caption/en",
      }),
      track({
        source: "tikhub",
        languageName: "English (United States)",
        url: "tikhub:caption/en-us",
      }),
    ]);
    const ytDlp = new FakeOptionalProvider(true, [track({ source: "yt-dlp" })]);
    let clockCalls = 0;
    const { service } = createService({
      innerTube: new FakeProvider(new YouTubeTranscriptError("no-captions")),
      tikHub,
      ytDlp,
      clock: () => {
        clockCalls += 1;
        if (clockCalls === 2) throw new Error("local choice clock failed");
        return new Date("2026-07-28T06:00:00.000Z");
      },
    });

    await expect(
      service.get({ itemId: ITEM_ID, videoId: VIDEO_ID, refresh: true }),
    ).rejects.toMatchObject({
      code: "temporarily-unavailable",
      usage: { tikhubPaidRequests: 1 },
    });
    expect(tikHub.fetchCalls).toBe(0);
    expect(tikHub.persisted).toEqual([]);
    expect(ytDlp.availabilityChecks).toBe(0);
    expect(ytDlp.listCalls).toBe(0);
  });

  it("preserves two paid TikHub requests when a fresh write fails locally", async () => {
    const tikHub = new PersistTrackingOptionalProvider(true, [
      track({ source: "tikhub", url: "tikhub:caption/en" }),
    ]);
    const ytDlp = new FakeOptionalProvider(true, [track({ source: "yt-dlp" })]);
    const { service } = createService({
      innerTube: new FakeProvider(new YouTubeTranscriptError("no-captions")),
      tikHub,
      ytDlp,
      content: new FailingWriteContentRepository(),
    });

    await expect(
      service.get({ itemId: ITEM_ID, videoId: VIDEO_ID, refresh: true }),
    ).rejects.toMatchObject({
      code: "temporarily-unavailable",
      usage: { tikhubPaidRequests: 2 },
    });
    expect(tikHub.fetchCalls).toBe(1);
    expect(tikHub.persisted).toEqual([]);
    expect(ytDlp.availabilityChecks).toBe(0);
    expect(ytDlp.listCalls).toBe(0);
  });

  it("preserves leased TikHub usage when a selected choice cannot be persisted", async () => {
    const tikHub = new PersistTrackingOptionalProvider(true, [
      track({
        source: "tikhub",
        languageName: "English",
        url: "tikhub:caption/en",
      }),
      track({
        source: "tikhub",
        languageName: "English (United States)",
        url: "tikhub:caption/en-us",
      }),
    ]);
    const ytDlp = new FakeOptionalProvider(true, [track({ source: "yt-dlp" })]);
    const { service } = createService({
      innerTube: new FakeProvider(new YouTubeTranscriptError("no-captions")),
      tikHub,
      ytDlp,
      content: new FailingWriteContentRepository(),
    });
    const choices = await service.get({
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      refresh: true,
    });
    if (choices.status !== "selection-required") {
      throw new Error("expected TikHub choices");
    }

    await expect(
      service.get({
        itemId: ITEM_ID,
        videoId: VIDEO_ID,
        refresh: true,
        trackId: choices.tracks[0].id,
      }),
    ).rejects.toMatchObject({
      code: "temporarily-unavailable",
      usage: { tikhubPaidRequests: 2 },
    });
    expect(tikHub.listCalls).toBe(1);
    expect(tikHub.fetchCalls).toBe(1);
    expect(tikHub.persisted).toEqual([]);
    expect(ytDlp.availabilityChecks).toBe(0);
    expect(ytDlp.listCalls).toBe(0);
  });

  it("guards progress callbacks and invokes cleanup only after a durable write", async () => {
    const stages: string[] = [];
    const persisted: Array<{ track: YouTubeCaptionTrack; value: CachedItemContent | null }> = [];
    const content = new FakeContentRepository();
    const selected = track();
    const innerTube: TranscriptProvider = {
      async listTracks() {
        return [selected];
      },
      async fetchTrack(selectedTrack) {
        return transcript(selectedTrack);
      },
      async onPersisted(savedTrack) {
        persisted.push({ track: savedTrack, value: content.value });
      },
    };
    const { service } = createService({ innerTube, content });

    await expect(
      service.get({
        itemId: ITEM_ID,
        videoId: VIDEO_ID,
        onProgress: (entry) => {
          stages.push(entry.stage);
          throw new Error("UI callback failed");
        },
      }),
    ).resolves.toMatchObject({
      status: "ready",
      usage: { tikhubPaidRequests: 0 },
    });
    expect(stages).toEqual(["checking-cache", "trying-innertube", "saving"]);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].track).toBe(selected);
    expect(persisted[0].value).toMatchObject({ contentBasis: "youtube-transcript" });

    const failedPersist: YouTubeCaptionTrack[] = [];
    const providerAfterFailedWrite: TranscriptProvider = {
      async listTracks() {
        return [selected];
      },
      async fetchTrack(selectedTrack) {
        return transcript(selectedTrack);
      },
      async onPersisted(savedTrack) {
        failedPersist.push(savedTrack);
      },
    };
    const failed = createService({
      innerTube: providerAfterFailedWrite,
      content: new FailingWriteContentRepository(),
    });
    await expect(
      failed.service.get({ itemId: ITEM_ID, videoId: VIDEO_ID, refresh: true }),
    ).rejects.toMatchObject({ code: "temporarily-unavailable" });
    expect(failedPersist).toEqual([]);
  });

  it("returns a matching cache and repairs metadata without provider calls", async () => {
    const content = new FakeContentRepository(cached());
    const metadata = new FakeMetadataRepository();
    const innerTube = new FakeProvider();
    const ytDlp = new FakeOptionalProvider(true);
    const { service } = createService({ content, metadata, innerTube, ytDlp });

    const result = await service.get({ itemId: ITEM_ID, videoId: VIDEO_ID });

    expect(result).toEqual({
      status: "ready",
      source: "cache",
      content: cached(),
      usage: { tikhubPaidRequests: 0 },
    });
    expect(content.writes).toEqual([]);
    expect(metadata.updates).toEqual([
      { id: ITEM_ID, path: CONTENT_PATH, basis: "youtube-transcript" },
    ]);
    expect(innerTube.listCalls).toBe(0);
    expect(ytDlp.listCalls).toBe(0);
  });

  it("reads a matching cache through the cache-only API and repairs metadata without providers", async () => {
    const content = new FakeContentRepository(cached());
    const metadata = new FakeMetadataRepository();
    const innerTube = new FakeProvider();
    const ytDlp = new FakeOptionalProvider(true);
    const { service } = createService({ content, metadata, innerTube, ytDlp });

    await expect(
      service.readCached({ itemId: ITEM_ID, videoId: VIDEO_ID }),
    ).resolves.toEqual(cached());

    expect(metadata.updates).toEqual([
      { id: ITEM_ID, path: CONTENT_PATH, basis: "youtube-transcript" },
    ]);
    expect(content.writes).toEqual([]);
    expect(innerTube.listCalls).toBe(0);
    expect(innerTube.fetchCalls).toBe(0);
    expect(ytDlp.availabilityChecks).toBe(0);
    expect(ytDlp.listCalls).toBe(0);
    expect(ytDlp.fetchCalls).toBe(0);
  });

  it("returns null from the cache-only API on a miss without probing either provider", async () => {
    const innerTube = new FakeProvider();
    const ytDlp = new FakeOptionalProvider(true);
    const { service, metadata } = createService({ innerTube, ytDlp });

    await expect(
      service.readCached({ itemId: ITEM_ID, videoId: VIDEO_ID }),
    ).resolves.toBeNull();

    expect(metadata.updates).toEqual([]);
    expect(innerTube.listCalls).toBe(0);
    expect(innerTube.fetchCalls).toBe(0);
    expect(ytDlp.availabilityChecks).toBe(0);
    expect(ytDlp.listCalls).toBe(0);
    expect(ytDlp.fetchCalls).toBe(0);
  });

  it("returns cache when metadata repair fails and retries repair on the next cache-only read", async () => {
    const content = new FakeContentRepository(cached());
    const metadata = new FakeMetadataRepository();
    metadata.failuresRemaining = 1;
    const { service } = createService({ content, metadata });

    await expect(
      service.readCached({ itemId: ITEM_ID, videoId: VIDEO_ID }),
    ).resolves.toEqual(cached());
    await expect(
      service.readCached({ itemId: ITEM_ID, videoId: VIDEO_ID }),
    ).resolves.toEqual(cached());

    expect(metadata.updates).toHaveLength(2);
    expect(content.value).toEqual(cached());
  });

  it("aborts an in-progress cache-only read without starting provider work", async () => {
    let releaseRead!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let continueRead!: () => void;
    const readGate = new Promise<void>((resolve) => {
      continueRead = resolve;
    });
    const content: TranscriptCacheRepository = {
      transaction: async (_itemId, operation) => await operation({
        read: async () => {
          releaseRead();
          await readGate;
          return cached();
        },
        write: async () => CONTENT_PATH,
        pathFor: () => CONTENT_PATH,
      }),
    };
    const innerTube = new FakeProvider();
    const ytDlp = new FakeOptionalProvider(true);
    const { service, metadata } = createService({
      content: content as FakeContentRepository,
      innerTube,
      ytDlp,
    });
    const controller = new AbortController();
    const pending = service.readCached({
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      signal: controller.signal,
    });
    await readStarted;

    controller.abort();
    continueRead();

    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    expect(metadata.updates).toEqual([]);
    expect(innerTube.listCalls).toBe(0);
    expect(ytDlp.availabilityChecks).toBe(0);
  });

  it("dispose invalidates an in-progress cache-only read and rejects future cache reads", async () => {
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    let continueRead!: () => void;
    const readGate = new Promise<void>((resolve) => {
      continueRead = resolve;
    });
    const content: TranscriptCacheRepository = {
      transaction: async (_itemId, operation) => await operation({
        read: async () => {
          markReadStarted();
          await readGate;
          return cached();
        },
        write: async () => CONTENT_PATH,
        pathFor: () => CONTENT_PATH,
      }),
    };
    const { service, metadata } = createService({
      content: content as FakeContentRepository,
    });
    const pending = service.readCached({ itemId: ITEM_ID, videoId: VIDEO_ID });
    await readStarted;

    service.dispose();
    continueRead();

    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    await expect(
      service.readCached({ itemId: ITEM_ID, videoId: VIDEO_ID }),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(metadata.updates).toEqual([]);
  });

  it("preserves a valid cache when metadata repair fails and retries on the next read", async () => {
    const content = new FakeContentRepository(cached());
    const metadata = new FakeMetadataRepository();
    metadata.failuresRemaining = 1;
    const { service } = createService({ content, metadata });

    await expect(
      service.get({ itemId: ITEM_ID, videoId: VIDEO_ID }),
    ).resolves.toMatchObject({ status: "ready", source: "cache" });
    await expect(
      service.get({ itemId: ITEM_ID, videoId: VIDEO_ID }),
    ).resolves.toMatchObject({ status: "ready", source: "cache" });

    expect(metadata.updates).toHaveLength(2);
    expect(content.value).toEqual(cached());
  });

  it("explicit refresh replaces the valid cache only after a complete transcript", async () => {
    const selected = track();
    const content = new FakeContentRepository(cached({ text: "Old cache." }));
    const innerTube = new FakeProvider(
      [selected],
      transcript(selected, { text: "Fresh complete transcript." }),
    );
    const { service, metadata } = createService({ content, innerTube });

    const result = await service.get({
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      refresh: true,
    });

    expect(result).toMatchObject({
      status: "ready",
      source: "fresh",
      content: { text: "Fresh complete transcript.", provider: "innertube" },
    });
    expect(content.writes).toHaveLength(1);
    expect(metadata.updates).toHaveLength(1);
  });

  it("prefers a manual track over an auto-generated track", async () => {
    const generated = track({ isGenerated: true });
    const manual = track({
      url: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&manual=1",
    });
    const innerTube = new FakeProvider([generated, manual]);
    const { service } = createService({ innerTube });

    const result = await service.get({
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      refresh: true,
    });

    expect(result).toMatchObject({
      status: "ready",
      content: { isGenerated: false },
    });
    expect(innerTube.fetchCalls).toBe(1);
  });

  it("applies the preferred language before generation priority", async () => {
    const englishManual = track();
    const chineseGenerated = track({
      languageCode: "zh-CN",
      languageName: "中文（自动生成）",
      isGenerated: true,
      url: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=zh-CN",
    });
    const innerTube = new FakeProvider([englishManual, chineseGenerated]);
    const { service } = createService({ innerTube });

    const result = await service.get({
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      refresh: true,
      preferredLanguage: "zh-CN",
    });

    expect(result).toMatchObject({
      status: "ready",
      content: { languageCode: "zh-CN", isGenerated: true },
    });
  });

  it("returns compact choices for equal-priority tracks and fetches only the selected track", async () => {
    const first = track({ languageName: "English" });
    const second = track({
      languageName: "English (United States)",
      url: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en-US",
    });
    const innerTube = new FakeProvider([first, second]);
    const { service, content } = createService({ innerTube });

    const choice = await service.get({
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      refresh: true,
    });

    expect(choice.status).toBe("selection-required");
    if (choice.status !== "selection-required") throw new Error("expected choices");
    expect(choice.tracks).toHaveLength(2);
    expect(choice.tracks[0]).not.toHaveProperty("url");
    expect(innerTube.fetchCalls).toBe(0);
    expect(content.writes).toEqual([]);

    const selected = await service.get({
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      refresh: true,
      trackId: choice.tracks[1].id,
    });

    expect(selected).toMatchObject({
      status: "ready",
      content: { languageName: "English (United States)" },
    });
    expect(innerTube.listCalls).toBe(1);
    expect(innerTube.fetchCalls).toBe(1);
  });

  it("uses no yt-dlp work when InnerTube succeeds", async () => {
    const ytDlp = new FakeOptionalProvider(true);
    const { service } = createService({ ytDlp });

    await service.get({ itemId: ITEM_ID, videoId: VIDEO_ID, refresh: true });

    expect(ytDlp.availabilityChecks).toBe(0);
    expect(ytDlp.listCalls).toBe(0);
  });

  it.each(["no-captions", "temporarily-unavailable", "timeout"] as const)(
    "uses yt-dlp once after fallback-eligible InnerTube %s",
    async (code) => {
      const innerTube = new FakeProvider(new YouTubeTranscriptError(code));
      const fallbackTrack = track({
        source: "yt-dlp",
        url: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&fallback=1",
      });
      const ytDlp = new FakeOptionalProvider(true, [fallbackTrack]);
      const { service } = createService({ innerTube, ytDlp });

      const result = await service.get({
        itemId: ITEM_ID,
        videoId: VIDEO_ID,
        refresh: true,
      });

      expect(result).toMatchObject({
        status: "ready",
        content: { provider: "yt-dlp" },
      });
      expect(ytDlp.availabilityChecks).toBe(1);
      expect(ytDlp.listCalls).toBe(1);
      expect(ytDlp.fetchCalls).toBe(1);
    },
  );

  it.each([
    {
      name: "unknown list failure",
      createProvider: (): TranscriptProvider => ({
        async listTracks() {
          throw new Error("unknown provider failure");
        },
        async fetchTrack(selectedTrack) {
          return transcript(selectedTrack);
        },
      }),
    },
    {
      name: "structurally invalid list response",
      createProvider: (): TranscriptProvider => ({
        async listTracks() {
          return null as unknown as YouTubeCaptionTrack[];
        },
        async fetchTrack(selectedTrack) {
          return transcript(selectedTrack);
        },
      }),
    },
    {
      name: "temporary fetch failure",
      createProvider: (): TranscriptProvider =>
        new FakeProvider(
          [track()],
          new YouTubeTranscriptError("temporarily-unavailable"),
        ),
    },
  ])(
    "keeps provider-stage fallback for $name",
    async ({ createProvider }) => {
      const fallbackTrack = track({ source: "yt-dlp" });
      const ytDlp = new FakeOptionalProvider(true, [fallbackTrack]);
      const { service } = createService({
        innerTube: createProvider(),
        ytDlp,
      });

      await expect(
        service.get({ itemId: ITEM_ID, videoId: VIDEO_ID, refresh: true }),
      ).resolves.toMatchObject({
        status: "ready",
        content: { provider: "yt-dlp" },
      });
      expect(ytDlp.availabilityChecks).toBe(1);
      expect(ytDlp.listCalls).toBe(1);
      expect(ytDlp.fetchCalls).toBe(1);
    },
  );

  it("does not fall back when the local clock fails after a valid InnerTube transcript", async () => {
    let clockCalls = 0;
    const clock = () => {
      clockCalls += 1;
      if (clockCalls === 2) throw new Error("local clock failed");
      return new Date("2026-07-28T06:00:00.000Z");
    };
    const ytDlp = new FakeOptionalProvider(false);
    const { service } = createService({ ytDlp, clock });

    await expect(
      service.get({ itemId: ITEM_ID, videoId: VIDEO_ID, refresh: true }),
    ).rejects.toMatchObject({ code: "temporarily-unavailable" });
    expect(ytDlp.availabilityChecks).toBe(0);
    expect(ytDlp.listCalls).toBe(0);
    expect(ytDlp.fetchCalls).toBe(0);
  });

  it("does not fall back when a valid InnerTube transcript cannot start its local transaction", async () => {
    const ytDlp = new FakeOptionalProvider(false);
    const content = new FailingTransactionContentRepository();
    const { service } = createService({ ytDlp, content });

    await expect(
      service.get({ itemId: ITEM_ID, videoId: VIDEO_ID, refresh: true }),
    ).rejects.toMatchObject({ code: "temporarily-unavailable" });
    expect(ytDlp.availabilityChecks).toBe(0);
    expect(ytDlp.listCalls).toBe(0);
    expect(ytDlp.fetchCalls).toBe(0);
  });

  it("does not fall back when a valid InnerTube transcript fails its local write", async () => {
    const ytDlp = new FakeOptionalProvider(false);
    const content = new FailingWriteContentRepository();
    const { service } = createService({ ytDlp, content });

    await expect(
      service.get({ itemId: ITEM_ID, videoId: VIDEO_ID, refresh: true }),
    ).rejects.toMatchObject({ code: "temporarily-unavailable" });
    expect(ytDlp.availabilityChecks).toBe(0);
    expect(ytDlp.listCalls).toBe(0);
    expect(ytDlp.fetchCalls).toBe(0);
  });

  it.each(["clock", "write"] as const)(
    "does not fall back when a selected InnerTube transcript fails local %s work",
    async (failure) => {
      const first = track({ languageName: "English" });
      const second = track({
        languageName: "English (United States)",
        url: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en-US",
      });
      let clockCalls = 0;
      const clock = () => {
        clockCalls += 1;
        if (failure === "clock" && clockCalls === 4) {
          throw new Error("local clock failed");
        }
        return new Date("2026-07-28T06:00:00.000Z");
      };
      const ytDlp = new FakeOptionalProvider(false);
      const content =
        failure === "write"
          ? new FailingWriteContentRepository()
          : new FakeContentRepository();
      const { service } = createService({
        innerTube: new FakeProvider([first, second]),
        ytDlp,
        content,
        clock,
      });

      const choice = await service.get({
        itemId: ITEM_ID,
        videoId: VIDEO_ID,
        refresh: true,
      });
      if (choice.status !== "selection-required") {
        throw new Error("expected choices");
      }

      await expect(
        service.get({
          itemId: ITEM_ID,
          videoId: VIDEO_ID,
          refresh: true,
          trackId: choice.tracks[0].id,
        }),
      ).rejects.toMatchObject({ code: "temporarily-unavailable" });
      expect(ytDlp.availabilityChecks).toBe(0);
      expect(ytDlp.listCalls).toBe(0);
      expect(ytDlp.fetchCalls).toBe(0);
    },
  );

  it.each(["aborted", "invalid-video-id", "login-required"] as const)(
    "does not fall back after InnerTube %s",
    async (code) => {
      const innerTube = new FakeProvider(new YouTubeTranscriptError(code));
      const ytDlp = new FakeOptionalProvider(true);
      const { service, content } = createService({ innerTube, ytDlp });

      await expect(
        service.get({ itemId: ITEM_ID, videoId: VIDEO_ID, refresh: true }),
      ).rejects.toMatchObject({ code });

      expect(ytDlp.availabilityChecks).toBe(0);
      expect(ytDlp.listCalls).toBe(0);
      expect(content.writes).toEqual([]);
    },
  );

  it("preserves authoritative no-captions when the optional fallback is absent", async () => {
    const ytDlp = new FakeOptionalProvider(false);
    const missing = createService({
      innerTube: new FakeProvider(new YouTubeTranscriptError("no-captions")),
      ytDlp,
    });
    await expect(
      missing.service.get({ itemId: ITEM_ID, videoId: VIDEO_ID, refresh: true }),
    ).rejects.toMatchObject({ code: "no-captions" });
    expect(ytDlp.availabilityChecks).toBe(1);
    expect(ytDlp.listCalls).toBe(0);
    expect(ytDlp.fetchCalls).toBe(0);
  });

  it("preserves authoritative no-captions when fallback discovery fails", async () => {
    const ytDlp = new FakeOptionalProvider(new Error("ENOENT"));
    const { service } = createService({
      innerTube: new FakeProvider(new YouTubeTranscriptError("no-captions")),
      ytDlp,
    });
    await expect(
      service.get({ itemId: ITEM_ID, videoId: VIDEO_ID, refresh: true }),
    ).rejects.toMatchObject({ code: "no-captions" });
    expect(ytDlp.availabilityChecks).toBe(1);
    expect(ytDlp.listCalls).toBe(0);
  });

  it.each([
    {
      name: "no supported tracks",
      tracks: [] as YouTubeCaptionTrack[],
      fetchResult: undefined,
      expectedFetchCalls: 0,
    },
    {
      name: "temporary track-list failure",
      tracks: new YouTubeTranscriptError("temporarily-unavailable"),
      fetchResult: undefined,
      expectedFetchCalls: 0,
    },
    {
      name: "temporary selected-track failure",
      tracks: [track({ source: "yt-dlp" })],
      fetchResult: new YouTubeTranscriptError("temporarily-unavailable"),
      expectedFetchCalls: 1,
    },
  ])(
    "preserves authoritative no-captions after fallback $name",
    async ({ tracks, fetchResult, expectedFetchCalls }) => {
      const ytDlp = new FakeOptionalProvider(true, tracks, fetchResult);
      const { service } = createService({
        innerTube: new FakeProvider(new YouTubeTranscriptError("no-captions")),
        ytDlp,
      });

      await expect(
        service.get({ itemId: ITEM_ID, videoId: VIDEO_ID, refresh: true }),
      ).rejects.toMatchObject({ code: "no-captions" });
      expect(ytDlp.availabilityChecks).toBe(1);
      expect(ytDlp.listCalls).toBe(1);
      expect(ytDlp.fetchCalls).toBe(expectedFetchCalls);
    },
  );

  it("does not report no-captions after a valid fallback transcript fails local persistence", async () => {
    const fallbackTrack = track({ source: "yt-dlp" });
    const ytDlp = new FakeOptionalProvider(true, [fallbackTrack]);
    const content = new FailingWriteContentRepository();
    const { service } = createService({
      innerTube: new FakeProvider(new YouTubeTranscriptError("no-captions")),
      ytDlp,
      content,
    });

    await expect(
      service.get({ itemId: ITEM_ID, videoId: VIDEO_ID, refresh: true }),
    ).rejects.toMatchObject({ code: "temporarily-unavailable" });
    expect(ytDlp.availabilityChecks).toBe(1);
    expect(ytDlp.listCalls).toBe(1);
    expect(ytDlp.fetchCalls).toBe(1);
  });

  it.each([
    "login-required",
    "video-unavailable",
    "invalid-video-id",
    "aborted",
  ] as const)(
    "propagates explicit fallback %s after primary no-captions",
    async (code) => {
      const ytDlp = new FakeOptionalProvider(
        true,
        new YouTubeTranscriptError(code),
      );
      const { service } = createService({
        innerTube: new FakeProvider(new YouTubeTranscriptError("no-captions")),
        ytDlp,
      });

      await expect(
        service.get({ itemId: ITEM_ID, videoId: VIDEO_ID, refresh: true }),
      ).rejects.toMatchObject({ code });
      expect(ytDlp.availabilityChecks).toBe(1);
      expect(ytDlp.listCalls).toBe(1);
      expect(ytDlp.fetchCalls).toBe(0);
    },
  );

  it("preserves authoritative no-captions when a selected fallback track later fails", async () => {
    const first = track({
      source: "yt-dlp",
      languageName: "English",
      url: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&track=1",
    });
    const second = track({
      source: "yt-dlp",
      languageName: "English (United States)",
      url: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en-US&track=2",
    });
    const ytDlp = new FakeOptionalProvider(
      true,
      [first, second],
      new YouTubeTranscriptError("temporarily-unavailable"),
    );
    const { service } = createService({
      innerTube: new FakeProvider(new YouTubeTranscriptError("no-captions")),
      ytDlp,
    });

    const choice = await service.get({
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      refresh: true,
    });
    expect(choice.status).toBe("selection-required");
    if (choice.status !== "selection-required") throw new Error("expected choices");

    await expect(
      service.get({
        itemId: ITEM_ID,
        videoId: VIDEO_ID,
        refresh: true,
        trackId: choice.tracks[0].id,
      }),
    ).rejects.toMatchObject({ code: "no-captions" });
    expect(ytDlp.availabilityChecks).toBe(1);
    expect(ytDlp.listCalls).toBe(1);
    expect(ytDlp.fetchCalls).toBe(1);
  });

  it("does not report no-captions when a selected fallback transcript fails local persistence", async () => {
    const first = track({
      source: "yt-dlp",
      languageName: "English",
      url: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&track=1",
    });
    const second = track({
      source: "yt-dlp",
      languageName: "English (United States)",
      url: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en-US&track=2",
    });
    const ytDlp = new FakeOptionalProvider(true, [first, second]);
    const content = new FailingWriteContentRepository();
    const { service } = createService({
      innerTube: new FakeProvider(new YouTubeTranscriptError("no-captions")),
      ytDlp,
      content,
    });

    const choice = await service.get({
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      refresh: true,
    });
    if (choice.status !== "selection-required") throw new Error("expected choices");

    await expect(
      service.get({
        itemId: ITEM_ID,
        videoId: VIDEO_ID,
        refresh: true,
        trackId: choice.tracks[0].id,
      }),
    ).rejects.toMatchObject({ code: "temporarily-unavailable" });
    expect(ytDlp.availabilityChecks).toBe(1);
    expect(ytDlp.listCalls).toBe(1);
    expect(ytDlp.fetchCalls).toBe(1);
  });

  it.each([
    "login-required",
    "video-unavailable",
    "invalid-video-id",
    "aborted",
  ] as const)(
    "propagates an explicit selected fallback %s state",
    async (code) => {
      const first = track({
        source: "yt-dlp",
        languageName: "English",
        url: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&track=1",
      });
      const second = track({
        source: "yt-dlp",
        languageName: "English (United States)",
        url: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en-US&track=2",
      });
      const ytDlp = new FakeOptionalProvider(
        true,
        [first, second],
        new YouTubeTranscriptError(code),
      );
      const { service } = createService({
        innerTube: new FakeProvider(new YouTubeTranscriptError("no-captions")),
        ytDlp,
      });

      const choice = await service.get({
        itemId: ITEM_ID,
        videoId: VIDEO_ID,
        refresh: true,
      });
      if (choice.status !== "selection-required") {
        throw new Error("expected choices");
      }

      await expect(
        service.get({
          itemId: ITEM_ID,
          videoId: VIDEO_ID,
          refresh: true,
          trackId: choice.tracks[0].id,
        }),
      ).rejects.toMatchObject({ code });
      expect(ytDlp.fetchCalls).toBe(1);
    },
  );

  it("reserves fallback-unavailable for a temporary primary failure with no local tool", async () => {
    const ytDlp = new FakeOptionalProvider(false);
    const { service } = createService({
      innerTube: new FakeProvider(
        new YouTubeTranscriptError("temporarily-unavailable"),
      ),
      ytDlp,
    });
    await expect(
      service.get({
        itemId: ITEM_ID,
        videoId: VIDEO_ID,
        refresh: true,
      }),
    ).rejects.toMatchObject({
      code: "fallback-unavailable",
      primaryCode: "temporarily-unavailable",
    });
    expect(ytDlp.availabilityChecks).toBe(1);
    expect(ytDlp.listCalls).toBe(0);
  });

  it("does not write an invalid or empty provider transcript", async () => {
    const selected = track();
    const innerTube = new FakeProvider(
      [selected],
      transcript(selected, { text: "   " }),
    );
    const ytDlp = new FakeOptionalProvider(
      true,
      new YouTubeTranscriptError("temporarily-unavailable"),
    );
    const { service, content } = createService({ innerTube, ytDlp });

    await expect(
      service.get({ itemId: ITEM_ID, videoId: VIDEO_ID, refresh: true }),
    ).rejects.toBeInstanceOf(YouTubeTranscriptServiceError);
    expect(content.writes).toEqual([]);
  });

  it("does not invoke yt-dlp twice when an InnerTube fetch and fallback both fail", async () => {
    const selected = track();
    const innerTube = new FakeProvider(
      [selected],
      transcript(selected, { text: "   " }),
    );
    const ytDlp = new FakeOptionalProvider(
      true,
      new YouTubeTranscriptError("temporarily-unavailable"),
    );
    const { service } = createService({ innerTube, ytDlp });

    await expect(
      service.get({ itemId: ITEM_ID, videoId: VIDEO_ID, refresh: true }),
    ).rejects.toMatchObject({ code: "temporarily-unavailable" });

    expect(ytDlp.availabilityChecks).toBe(1);
    expect(ytDlp.listCalls).toBe(1);
  });

  it("does not cache when cancellation happens while a provider is fetching", async () => {
    const controller = new AbortController();
    const selected = track();
    const innerTube: TranscriptProvider = {
      async listTracks() {
        return [selected];
      },
      async fetchTrack() {
        controller.abort();
        return transcript(selected);
      },
    };
    const ytDlp = new FakeOptionalProvider(true);
    const content = new FakeContentRepository();
    const { service } = createService({ innerTube, ytDlp, content });

    await expect(
      service.get({
        itemId: ITEM_ID,
        videoId: VIDEO_ID,
        refresh: true,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "aborted" });

    expect(content.writes).toEqual([]);
    expect(ytDlp.listCalls).toBe(0);
  });

  it("deduplicates concurrent work by exact itemId and videoId", async () => {
    let release!: (tracks: YouTubeCaptionTrack[]) => void;
    const pending = new Promise<YouTubeCaptionTrack[]>((resolve) => {
      release = resolve;
    });
    const innerTube: TranscriptProvider & { listCalls: number; fetchCalls: number } = {
      listCalls: 0,
      fetchCalls: 0,
      async listTracks() {
        this.listCalls += 1;
        return await pending;
      },
      async fetchTrack(selectedTrack) {
        this.fetchCalls += 1;
        return transcript(selectedTrack);
      },
    };
    const content = new FakeContentRepository();
    const { service } = createService({ innerTube, content });

    const first = service.get({
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      refresh: true,
    });
    const second = service.get({
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      refresh: true,
    });
    await Promise.resolve();
    release([track()]);

    const [left, right] = await Promise.all([first, second]);
    expect(left).toEqual(right);
    expect(innerTube.listCalls).toBe(1);
    expect(innerTube.fetchCalls).toBe(1);
    expect(content.writes).toHaveLength(1);
  });

  it("does not let a cache read swallow an explicit refresh", async () => {
    const content = new FakeContentRepository(cached());
    const innerTube = new FakeProvider(
      [track()],
      transcript(track(), { text: "Explicitly refreshed transcript." }),
    );
    const { service } = createService({ content, innerTube });

    const [cacheResult, refreshResult] = await Promise.all([
      service.get({ itemId: ITEM_ID, videoId: VIDEO_ID }),
      service.get({ itemId: ITEM_ID, videoId: VIDEO_ID, refresh: true }),
    ]);

    expect(cacheResult).toMatchObject({ status: "ready", source: "cache" });
    expect(refreshResult).toMatchObject({
      status: "ready",
      source: "fresh",
      content: { text: "Explicitly refreshed transcript." },
    });
    expect(innerTube.listCalls).toBe(1);
    expect(innerTube.fetchCalls).toBe(1);
    expect(content.writes).toHaveLength(1);
  });

  it("makes a newer refresh current over an earlier track selection", async () => {
    const first = track({ languageName: "English A" });
    const second = track({
      languageName: "English B",
      url: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en-B",
    });
    const innerTube = new FakeProvider([first, second]);
    const { service, content } = createService({ innerTube });
    const choice = await service.get({
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      refresh: true,
    });
    if (choice.status !== "selection-required") throw new Error("expected choices");

    const selection = service.get({
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      trackId: choice.tracks[0].id,
    });
    const refresh = service.get({
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      refresh: true,
    });

    await expect(selection).rejects.toMatchObject({
      code: "temporarily-unavailable",
    });
    await expect(refresh).resolves.toMatchObject({
      status: "selection-required",
    });
    expect(innerTube.listCalls).toBe(2);
    expect(innerTube.fetchCalls).toBe(1);
    expect(content.writes).toEqual([]);
  });

  it("lets only the latest of two different track selections write", async () => {
    const first = track({ languageName: "English A" });
    const second = track({
      languageName: "English B",
      url: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en-B",
    });
    const innerTube = new FakeProvider([first, second]);
    const { service, content } = createService({ innerTube });
    const choice = await service.get({
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      refresh: true,
    });
    if (choice.status !== "selection-required") throw new Error("expected choices");

    const left = service.get({
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      trackId: choice.tracks[0].id,
    });
    const right = service.get({
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      trackId: choice.tracks[1].id,
    });

    await expect(left).rejects.toMatchObject({
      code: "temporarily-unavailable",
    });
    await expect(right).resolves.toMatchObject({
      content: { languageName: "English B" },
    });
    expect(innerTube.fetchCalls).toBe(2);
    expect(content.writes).toHaveLength(1);
    expect(content.writes[0]?.languageName).toBe("English B");
  });

  it("shares one provider fetch and write for the same track selection", async () => {
    const tracks = [
      track({ languageName: "English A" }),
      track({
        languageName: "English B",
        url: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en-B",
      }),
    ];
    let fetchCalls = 0;
    const innerTube: TranscriptProvider = {
      async listTracks() {
        return tracks;
      },
      async fetchTrack(selectedTrack) {
        fetchCalls += 1;
        await Promise.resolve();
        return transcript(selectedTrack);
      },
    };
    const content = new FakeContentRepository();
    const { service } = createService({ innerTube, content });
    const choice = await service.get({
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      refresh: true,
    });
    if (choice.status !== "selection-required") throw new Error("expected choices");
    const request = {
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      trackId: choice.tracks[0].id,
    };

    const [left, right] = await Promise.all([
      service.get(request),
      service.get(request),
    ]);

    expect(left).toEqual(right);
    expect(fetchCalls).toBe(1);
    expect(content.writes).toHaveLength(1);
  });

  it("keeps shared refresh work alive when only one caller aborts", async () => {
    let release!: (tracks: YouTubeCaptionTrack[]) => void;
    let reject!: (error: YouTubeTranscriptError) => void;
    const pending = new Promise<YouTubeCaptionTrack[]>((resolve, rejectPromise) => {
      release = resolve;
      reject = rejectPromise;
    });
    let underlyingAborts = 0;
    const innerTube: TranscriptProvider = {
      async listTracks(_videoId, signal) {
        signal?.addEventListener("abort", () => {
          underlyingAborts += 1;
          reject(new YouTubeTranscriptError("aborted"));
        }, { once: true });
        return await pending;
      },
      async fetchTrack(selectedTrack) {
        return transcript(selectedTrack);
      },
    };
    const { service, content } = createService({ innerTube });
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = service.get({
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      refresh: true,
      signal: firstController.signal,
    });
    const second = service.get({
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      refresh: true,
      signal: secondController.signal,
    });
    await Promise.resolve();
    await Promise.resolve();
    firstController.abort();
    await expect(first).rejects.toMatchObject({ code: "aborted" });
    expect(underlyingAborts).toBe(0);
    release([track()]);

    await expect(second).resolves.toMatchObject({ status: "ready" });
    expect(underlyingAborts).toBe(0);
    expect(content.writes).toHaveLength(1);
  });

  it("aborts shared provider work only after every caller cancels", async () => {
    let reject!: (error: YouTubeTranscriptError) => void;
    const pending = new Promise<YouTubeCaptionTrack[]>((_resolve, rejectPromise) => {
      reject = rejectPromise;
    });
    let underlyingAborts = 0;
    const innerTube: TranscriptProvider = {
      async listTracks(_videoId, signal) {
        signal?.addEventListener("abort", () => {
          underlyingAborts += 1;
          reject(new YouTubeTranscriptError("aborted"));
        }, { once: true });
        return await pending;
      },
      async fetchTrack(selectedTrack) {
        return transcript(selectedTrack);
      },
    };
    const { service, content } = createService({ innerTube });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = service.get({
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      refresh: true,
      signal: firstController.signal,
    });
    const second = service.get({
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      refresh: true,
      signal: secondController.signal,
    });

    firstController.abort();
    await expect(first).rejects.toMatchObject({ code: "aborted" });
    expect(underlyingAborts).toBe(0);
    secondController.abort();
    await expect(second).rejects.toMatchObject({ code: "aborted" });
    await Promise.resolve();

    expect(underlyingAborts).toBe(1);
    expect(content.writes).toEqual([]);
  });

  it("lets a new caller start fresh after every prior subscriber cancels", async () => {
    let rejectFirst!: (error: YouTubeTranscriptError) => void;
    const firstPending = new Promise<YouTubeCaptionTrack[]>((_resolve, reject) => {
      rejectFirst = reject;
    });
    let listCalls = 0;
    const innerTube: TranscriptProvider = {
      async listTracks(_videoId, signal) {
        listCalls += 1;
        if (listCalls > 1) return [track()];
        signal?.addEventListener("abort", () => {
          rejectFirst(new YouTubeTranscriptError("aborted"));
        }, { once: true });
        return await firstPending;
      },
      async fetchTrack(selectedTrack) {
        return transcript(selectedTrack);
      },
    };
    const { service } = createService({ innerTube });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = service.get({
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      refresh: true,
      signal: firstController.signal,
    });
    const second = service.get({
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      refresh: true,
      signal: secondController.signal,
    });
    await Promise.resolve();
    await Promise.resolve();
    firstController.abort();
    secondController.abort();
    const fresh = service.get({
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      refresh: true,
    });

    await expect(first).rejects.toMatchObject({ code: "aborted" });
    await expect(second).rejects.toMatchObject({ code: "aborted" });
    await expect(fresh).resolves.toMatchObject({ status: "ready" });
    expect(listCalls).toBe(2);
  });

  it("expires pending choices and never fetches their old signed track", async () => {
    let now = Date.parse("2026-07-28T06:00:00.000Z");
    const innerTube = new FakeProvider([
      track({ languageName: "English A" }),
      track({
        languageName: "English B",
        url: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en-B",
      }),
    ]);
    const { service } = createService({
      innerTube,
      clock: () => new Date(now),
      choiceTtlMs: 1_000,
    });
    const choice = await service.get({
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      refresh: true,
    });
    if (choice.status !== "selection-required") throw new Error("expected choices");
    now += 1_001;

    await expect(
      service.get({
        itemId: ITEM_ID,
        videoId: VIDEO_ID,
        trackId: choice.tracks[0].id,
      }),
    ).rejects.toMatchObject({ code: "temporarily-unavailable" });
    expect(innerTube.fetchCalls).toBe(0);
  });

  it("actively releases pending choices when their short TTL elapses", async () => {
    vi.useFakeTimers();
    const innerTube = new FakeProvider([
      track({ languageName: "English A" }),
      track({
        languageName: "English B",
        url: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en-B",
      }),
    ]);
    const { service } = createService({ innerTube, choiceTtlMs: 1_000 });
    try {
      const choice = await service.get({
        itemId: ITEM_ID,
        videoId: VIDEO_ID,
        refresh: true,
      });
      if (choice.status !== "selection-required") throw new Error("expected choices");
      await vi.advanceTimersByTimeAsync(1_001);

      await expect(
        service.get({
          itemId: ITEM_ID,
          videoId: VIDEO_ID,
          trackId: choice.tracks[0].id,
        }),
      ).rejects.toMatchObject({ code: "temporarily-unavailable" });
      expect(innerTube.fetchCalls).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("evicts the oldest pending choice set at the configured capacity", async () => {
    const innerTube = new FakeProvider([
      track({ languageName: "English A" }),
      track({
        languageName: "English B",
        url: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en-B",
      }),
    ]);
    const { service } = createService({
      innerTube,
      maxPendingChoiceSets: 2,
    });
    const ids = ["a".repeat(64), "b".repeat(64), "c".repeat(64)];
    const choices = [];
    for (const itemId of ids) {
      const result = await service.get({ itemId, videoId: VIDEO_ID, refresh: true });
      if (result.status !== "selection-required") throw new Error("expected choices");
      choices.push(result);
    }

    await expect(
      service.get({
        itemId: ids[0],
        videoId: VIDEO_ID,
        trackId: choices[0].tracks[0].id,
      }),
    ).rejects.toMatchObject({ code: "temporarily-unavailable" });
    expect(innerTube.fetchCalls).toBe(0);
  });

  it("invalidates an old choice after a cache hit", async () => {
    const first = track({ languageName: "English A" });
    const second = track({
      languageName: "English B",
      url: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en-B",
    });
    const content = new FakeContentRepository();
    const innerTube = new FakeProvider([first, second]);
    const { service } = createService({ innerTube, content });
    const choice = await service.get({
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      refresh: true,
    });
    if (choice.status !== "selection-required") throw new Error("expected choices");
    content.value = cached();

    await expect(
      service.get({ itemId: ITEM_ID, videoId: VIDEO_ID }),
    ).resolves.toMatchObject({ source: "cache" });
    await expect(
      service.get({
        itemId: ITEM_ID,
        videoId: VIDEO_ID,
        trackId: choice.tracks[0].id,
      }),
    ).rejects.toMatchObject({ code: "temporarily-unavailable" });
    expect(innerTube.fetchCalls).toBe(0);
  });

  it("invalidates old track IDs when a new refresh lists choices", async () => {
    const innerTube = new FakeProvider([
      track({ languageName: "English A" }),
      track({
        languageName: "English B",
        url: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en-B",
      }),
    ]);
    const { service } = createService({ innerTube });
    const first = await service.get({
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      refresh: true,
    });
    if (first.status !== "selection-required") throw new Error("expected choices");
    const second = await service.get({
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      refresh: true,
    });
    if (second.status !== "selection-required") throw new Error("expected choices");

    await expect(
      service.get({
        itemId: ITEM_ID,
        videoId: VIDEO_ID,
        trackId: first.tracks[0].id,
      }),
    ).rejects.toMatchObject({ code: "temporarily-unavailable" });
    await expect(
      service.get({
        itemId: ITEM_ID,
        videoId: VIDEO_ID,
        trackId: second.tracks[0].id,
      }),
    ).resolves.toMatchObject({ status: "ready" });
  });

  it("invalidates an old choice after its selected fetch fails", async () => {
    const tracks = [
      track({ languageName: "English A" }),
      track({
        languageName: "English B",
        url: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en-B",
      }),
    ];
    let fetchCalls = 0;
    const innerTube: TranscriptProvider = {
      async listTracks() {
        return tracks;
      },
      async fetchTrack(selectedTrack) {
        fetchCalls += 1;
        if (fetchCalls === 1) throw new YouTubeTranscriptError("login-required");
        return transcript(selectedTrack);
      },
    };
    const { service } = createService({ innerTube });
    const choice = await service.get({
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      refresh: true,
    });
    if (choice.status !== "selection-required") throw new Error("expected choices");

    await expect(
      service.get({
        itemId: ITEM_ID,
        videoId: VIDEO_ID,
        trackId: choice.tracks[0].id,
      }),
    ).rejects.toMatchObject({ code: "login-required" });
    await expect(
      service.get({
        itemId: ITEM_ID,
        videoId: VIDEO_ID,
        trackId: choice.tracks[0].id,
      }),
    ).rejects.toMatchObject({ code: "temporarily-unavailable" });
    expect(fetchCalls).toBe(1);
  });

  it("invalidates a selected choice immediately when its last caller cancels", async () => {
    const tracks = [
      track({ languageName: "English A" }),
      track({
        languageName: "English B",
        url: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en-B",
      }),
    ];
    let fetchCalls = 0;
    let rejectFetch!: (error: YouTubeTranscriptError) => void;
    const pendingFetch = new Promise<YouTubeTranscript>((_resolve, reject) => {
      rejectFetch = reject;
    });
    const innerTube: TranscriptProvider = {
      async listTracks() {
        return tracks;
      },
      async fetchTrack(_selectedTrack, signal) {
        fetchCalls += 1;
        signal?.addEventListener("abort", () => {
          rejectFetch(new YouTubeTranscriptError("aborted"));
        }, { once: true });
        return await pendingFetch;
      },
    };
    const { service } = createService({ innerTube });
    const choice = await service.get({
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      refresh: true,
    });
    if (choice.status !== "selection-required") throw new Error("expected choices");
    const controller = new AbortController();
    const selection = service.get({
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      trackId: choice.tracks[0].id,
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();

    await expect(selection).rejects.toMatchObject({ code: "aborted" });
    await expect(
      service.get({
        itemId: ITEM_ID,
        videoId: VIDEO_ID,
        trackId: choice.tracks[0].id,
      }),
    ).rejects.toMatchObject({ code: "temporarily-unavailable" });
    expect(fetchCalls).toBe(1);
  });

  it("prevents an older delayed language refresh from registering over a newer generation", async () => {
    let releaseOlder!: (tracks: YouTubeCaptionTrack[]) => void;
    let markOlderStarted!: () => void;
    const olderStarted = new Promise<void>((resolve) => {
      markOlderStarted = resolve;
    });
    const olderTracks = [
      track({ languageCode: "en-US", languageName: "Older English US" }),
      track({
        languageCode: "en-GB",
        languageName: "Older English UK",
        url: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en-GB",
      }),
    ];
    const newerTracks = [
      track({ languageCode: "zh-CN", languageName: "新中文 A" }),
      track({
        languageCode: "zh-TW",
        languageName: "新中文 B",
        url: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=zh-TW",
      }),
    ];
    let listCalls = 0;
    const innerTube: TranscriptProvider = {
      async listTracks() {
        listCalls += 1;
        if (listCalls === 1) {
          markOlderStarted();
          return await new Promise<YouTubeCaptionTrack[]>((resolve) => {
            releaseOlder = resolve;
          });
        }
        return newerTracks;
      },
      async fetchTrack(selectedTrack) {
        return transcript(selectedTrack);
      },
    };
    const { service } = createService({ innerTube });
    const older = service.get({
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      refresh: true,
      preferredLanguage: "en",
    });
    await olderStarted;
    const newer = await service.get({
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      refresh: true,
      preferredLanguage: "zh",
    });
    if (newer.status !== "selection-required") throw new Error("expected choices");
    releaseOlder(olderTracks);

    await expect(older).rejects.toMatchObject({ code: "temporarily-unavailable" });
    await expect(
      service.get({
        itemId: ITEM_ID,
        videoId: VIDEO_ID,
        trackId: newer.tracks[0].id,
      }),
    ).resolves.toMatchObject({
      status: "ready",
      content: { languageName: "新中文 A" },
    });
  });

  it("does not let an older slow cache miss reclaim a newer refresh generation", async () => {
    let releaseRead!: () => void;
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    class SlowMissRepository extends FakeContentRepository {
      override async read(): Promise<CachedItemContent | null> {
        this.readCalls += 1;
        markReadStarted();
        await new Promise<void>((resolve) => {
          releaseRead = resolve;
        });
        return null;
      }
    }
    const newerTracks = [
      track({ languageCode: "zh-CN", languageName: "新中文 A" }),
      track({
        languageCode: "zh-TW",
        languageName: "新中文 B",
        url: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=zh-TW",
      }),
    ];
    const content = new SlowMissRepository();
    const innerTube = new FakeProvider(newerTracks);
    const { service } = createService({ content, innerTube });
    const older = service.get({ itemId: ITEM_ID, videoId: VIDEO_ID });
    await readStarted;
    const newer = await service.get({
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      refresh: true,
      preferredLanguage: "zh",
    });
    if (newer.status !== "selection-required") throw new Error("expected choices");
    releaseRead();

    await expect(older).rejects.toMatchObject({ code: "temporarily-unavailable" });
    expect(innerTube.listCalls).toBe(1);
    await expect(
      service.get({
        itemId: ITEM_ID,
        videoId: VIDEO_ID,
        trackId: newer.tracks[0].id,
      }),
    ).resolves.toMatchObject({
      status: "ready",
      content: { languageName: "新中文 A" },
    });
  });

  it("does not fetch a delayed single track after a newer refresh becomes current", async () => {
    let releaseOlderList!: (tracks: YouTubeCaptionTrack[]) => void;
    let markOlderListStarted!: () => void;
    const olderListStarted = new Promise<void>((resolve) => {
      markOlderListStarted = resolve;
    });
    const newerTracks = [
      track({ languageCode: "zh-CN", languageName: "新中文 A" }),
      track({
        languageCode: "zh-TW",
        languageName: "新中文 B",
        url: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=zh-TW",
      }),
    ];
    let listCalls = 0;
    let fetchCalls = 0;
    const innerTube: TranscriptProvider = {
      async listTracks() {
        listCalls += 1;
        if (listCalls === 1) {
          markOlderListStarted();
          return await new Promise<YouTubeCaptionTrack[]>((resolve) => {
            releaseOlderList = resolve;
          });
        }
        return newerTracks;
      },
      async fetchTrack(selectedTrack) {
        fetchCalls += 1;
        return transcript(selectedTrack);
      },
    };
    const { service, content, metadata } = createService({ innerTube });
    const older = service.get({
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      refresh: true,
      preferredLanguage: "en",
    });
    await olderListStarted;
    const newer = await service.get({
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      refresh: true,
      preferredLanguage: "zh",
    });
    if (newer.status !== "selection-required") throw new Error("expected choices");
    releaseOlderList([track({ languageName: "Older single track" })]);

    await expect(older).rejects.toMatchObject({ code: "temporarily-unavailable" });
    expect(fetchCalls).toBe(0);
    expect(content.writes).toEqual([]);
    expect(metadata.updates).toEqual([]);
    await expect(
      service.get({
        itemId: ITEM_ID,
        videoId: VIDEO_ID,
        trackId: newer.tracks[0].id,
      }),
    ).resolves.toMatchObject({ status: "ready" });
  });

  it("does not persist an in-progress fetch after a newer refresh becomes current", async () => {
    const olderTrack = track({ languageName: "Older fetched track" });
    const newerTracks = [
      track({ languageCode: "zh-CN", languageName: "新中文 A" }),
      track({
        languageCode: "zh-TW",
        languageName: "新中文 B",
        url: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=zh-TW",
      }),
    ];
    let listCalls = 0;
    let fetchCalls = 0;
    let releaseOlderFetch!: (value: YouTubeTranscript) => void;
    let markOlderFetchStarted!: () => void;
    const olderFetchStarted = new Promise<void>((resolve) => {
      markOlderFetchStarted = resolve;
    });
    const innerTube: TranscriptProvider = {
      async listTracks() {
        listCalls += 1;
        return listCalls === 1 ? [olderTrack] : newerTracks;
      },
      async fetchTrack(selectedTrack) {
        fetchCalls += 1;
        if (fetchCalls === 1) {
          markOlderFetchStarted();
          return await new Promise<YouTubeTranscript>((resolve) => {
            releaseOlderFetch = resolve;
          });
        }
        return transcript(selectedTrack);
      },
    };
    const { service, content, metadata } = createService({ innerTube });
    const older = service.get({
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      refresh: true,
      preferredLanguage: "en",
    });
    await olderFetchStarted;
    const newer = await service.get({
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      refresh: true,
      preferredLanguage: "zh",
    });
    if (newer.status !== "selection-required") throw new Error("expected choices");
    releaseOlderFetch(transcript(olderTrack));

    await expect(older).rejects.toMatchObject({ code: "temporarily-unavailable" });
    expect(fetchCalls).toBe(1);
    expect(content.writes).toEqual([]);
    expect(metadata.updates).toEqual([]);
    await expect(
      service.get({
        itemId: ITEM_ID,
        videoId: VIDEO_ID,
        trackId: newer.tracks[0].id,
      }),
    ).resolves.toMatchObject({ status: "ready" });
  });

  it("rechecks a selected fetch after its item transaction wait before writing", async () => {
    let markSelectionTransactionRequested!: () => void;
    const selectionTransactionRequested = new Promise<void>((resolve) => {
      markSelectionTransactionRequested = resolve;
    });
    class ObservableTransactionRepository extends FakeContentRepository {
      transactionCalls = 0;

      override async transaction<T>(
        itemId: string,
        operation: (transaction: {
          read(): Promise<CachedItemContent | null>;
          write(value: CachedItemContent): Promise<string>;
          pathFor(): string;
        }) => Promise<T>,
      ): Promise<T> {
        this.transactionCalls += 1;
        if (this.transactionCalls === 2) markSelectionTransactionRequested();
        return await super.transaction(itemId, operation);
      }
    }
    const firstTracks = [
      track({ languageName: "English A" }),
      track({
        languageName: "English B",
        url: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en-B",
      }),
    ];
    const newerTracks = [
      track({ languageCode: "zh-CN", languageName: "新中文 A" }),
      track({
        languageCode: "zh-TW",
        languageName: "新中文 B",
        url: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=zh-TW",
      }),
    ];
    let listCalls = 0;
    const innerTube: TranscriptProvider = {
      async listTracks() {
        listCalls += 1;
        return listCalls === 1 ? firstTracks : newerTracks;
      },
      async fetchTrack(selectedTrack) {
        return transcript(selectedTrack);
      },
    };
    const content = new ObservableTransactionRepository();
    const { service, metadata } = createService({ innerTube, content });
    const first = await service.get({
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      refresh: true,
      preferredLanguage: "en",
    });
    if (first.status !== "selection-required") throw new Error("expected choices");
    let releaseHold!: () => void;
    let markHoldStarted!: () => void;
    const holdStarted = new Promise<void>((resolve) => {
      markHoldStarted = resolve;
    });
    const hold = content.transaction(ITEM_ID, async () => {
      markHoldStarted();
      await new Promise<void>((resolve) => {
        releaseHold = resolve;
      });
    });
    await holdStarted;
    const selection = service.get({
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      trackId: first.tracks[0].id,
    });
    await selectionTransactionRequested;
    const newer = await service.get({
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      refresh: true,
      preferredLanguage: "zh",
    });
    if (newer.status !== "selection-required") throw new Error("expected choices");
    releaseHold();
    await hold;

    await expect(selection).rejects.toMatchObject({ code: "temporarily-unavailable" });
    expect(content.writes).toEqual([]);
    expect(metadata.updates).toEqual([]);
    await expect(
      service.get({
        itemId: ITEM_ID,
        videoId: VIDEO_ID,
        trackId: newer.tracks[0].id,
      }),
    ).resolves.toMatchObject({ status: "ready" });
  });

  it.each(["temporarily-unavailable", "no-captions"] as const)(
    "prevents an older delayed fallback after %s from replacing newer InnerTube choices",
    async (primaryCode) => {
      let innerCalls = 0;
      const newerTracks = [
        track({ languageCode: "zh-CN", languageName: "新中文 A" }),
        track({
          languageCode: "zh-TW",
          languageName: "新中文 B",
          url: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=zh-TW",
        }),
      ];
      const innerTube: TranscriptProvider = {
        async listTracks() {
          innerCalls += 1;
          if (innerCalls === 1) {
            throw new YouTubeTranscriptError(primaryCode);
          }
          return newerTracks;
        },
        async fetchTrack(selectedTrack) {
          return transcript(selectedTrack);
        },
      };
      let releaseFallback!: (tracks: YouTubeCaptionTrack[]) => void;
      let markFallbackStarted!: () => void;
      const fallbackStarted = new Promise<void>((resolve) => {
        markFallbackStarted = resolve;
      });
      class DelayedFallbackProvider extends FakeOptionalProvider {
        override async listTracks(): Promise<YouTubeCaptionTrack[]> {
          this.listCalls += 1;
          markFallbackStarted();
          return await new Promise<YouTubeCaptionTrack[]>((resolve) => {
            releaseFallback = resolve;
          });
        }

        override async fetchTrack(selectedTrack: YouTubeCaptionTrack) {
          this.fetchCalls += 1;
          return transcript(selectedTrack);
        }
      }
      const ytDlp = new DelayedFallbackProvider(true);
      const { service } = createService({ innerTube, ytDlp });
      const older = service.get({
        itemId: ITEM_ID,
        videoId: VIDEO_ID,
        refresh: true,
        preferredLanguage: "en",
      });
      await fallbackStarted;
      const newer = await service.get({
        itemId: ITEM_ID,
        videoId: VIDEO_ID,
        refresh: true,
        preferredLanguage: "zh",
      });
      if (newer.status !== "selection-required") {
        throw new Error("expected choices");
      }
      releaseFallback([
        track({
          source: "yt-dlp",
          languageCode: "en-US",
          languageName: "Older fallback US",
        }),
        track({
          source: "yt-dlp",
          languageCode: "en-GB",
          languageName: "Older fallback UK",
          url: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en-GB",
        }),
      ]);

      await expect(older).rejects.toMatchObject({
        code: "temporarily-unavailable",
      });
      await expect(
        service.get({
          itemId: ITEM_ID,
          videoId: VIDEO_ID,
          trackId: newer.tracks[0].id,
        }),
      ).resolves.toMatchObject({
        status: "ready",
        content: { languageName: "新中文 A" },
      });
      expect(ytDlp.listCalls).toBe(1);
      expect(ytDlp.fetchCalls).toBe(0);
    },
  );

  it("dispose aborts and releases every in-flight request and rejects future work", async () => {
    let activeSignal: AbortSignal | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const innerTube: TranscriptProvider = {
      async listTracks(_videoId, signal) {
        activeSignal = signal;
        markStarted();
        return await new Promise<YouTubeCaptionTrack[]>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new YouTubeTranscriptError("aborted")),
            { once: true },
          );
        });
      },
      async fetchTrack(selectedTrack) {
        return transcript(selectedTrack);
      },
    };
    const { service } = createService({ innerTube });
    const pending = service.get({
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      refresh: true,
    });
    await started;

    service.dispose();

    expect(activeSignal?.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    expect((service as unknown as { inFlight: Map<string, unknown> }).inFlight.size).toBe(0);
    await expect(
      service.get({ itemId: ITEM_ID, videoId: VIDEO_ID, refresh: true }),
    ).rejects.toMatchObject({ code: "aborted" });
  });

  it("dispose clears choice timers, opaque track references, and generation maps", async () => {
    vi.useFakeTimers();
    const innerTube = new FakeProvider([
      track({ languageName: "English A" }),
      track({
        languageName: "English B",
        url: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en-B",
      }),
    ]);
    const { service } = createService({ innerTube });
    try {
      const result = await service.get({
        itemId: ITEM_ID,
        videoId: VIDEO_ID,
        refresh: true,
      });
      if (result.status !== "selection-required") throw new Error("expected choices");
      const internals = service as unknown as {
        pendingChoices: Map<string, { choices: Map<string, unknown> }>;
        currentGenerations: Map<string, symbol>;
      };
      const retainedChoiceSet = [...internals.pendingChoices.values()][0];
      expect(retainedChoiceSet?.choices.size).toBe(2);
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      service.dispose();

      expect(internals.pendingChoices.size).toBe(0);
      expect(internals.currentGenerations.size).toBe(0);
      expect(retainedChoiceSet?.choices.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("revokes only the exact opaque choice set and cannot invalidate a newer set", async () => {
    const innerTube = new FakeProvider([
      track({ languageName: "English A" }),
      track({
        languageName: "English B",
        url: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en-B",
      }),
    ]);
    const { service } = createService({ innerTube });
    const older = await service.get({
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      refresh: true,
    });
    if (older.status !== "selection-required") throw new Error("expected choices");
    const newer = await service.get({
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      refresh: true,
    });
    if (newer.status !== "selection-required") throw new Error("expected choices");

    expect(older.choiceSetId).not.toBe(newer.choiceSetId);
    service.revokeChoiceSet(older.choiceSetId);

    await expect(
      service.get({
        itemId: ITEM_ID,
        videoId: VIDEO_ID,
        trackId: newer.tracks[0].id,
      }),
    ).resolves.toMatchObject({ status: "ready" });
  });
});
