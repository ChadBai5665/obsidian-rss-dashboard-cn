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
  type TranscriptProvider,
} from "../../../src/youtube-transcript/youtube-transcript-service";
import {
  YouTubeTranscriptError,
  type YouTubeCaptionTrack,
  type YouTubeTranscript,
} from "../../../src/youtube-transcript/transcript-types";

const ITEM_ID = "a".repeat(64);
const VIDEO_ID = "dQw4w9WgXcQ";
const CONTENT_PATH = `.rss-dashboard-data/content/${ITEM_ID}.md`;

function track(
  overrides: Partial<YouTubeCaptionTrack> = {},
): YouTubeCaptionTrack {
  return {
    languageCode: "en",
    languageName: "English",
    isGenerated: false,
    source: "innertube",
    url: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en",
    format: "json3",
    ...overrides,
  };
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
  ytDlp?: FakeOptionalProvider;
  content?: FakeContentRepository;
  metadata?: FakeMetadataRepository;
  clock?: () => Date;
  choiceTtlMs?: number;
  maxPendingChoiceSets?: number;
} = {}): {
  service: YouTubeTranscriptService;
  innerTube: TranscriptProvider;
  ytDlp: FakeOptionalProvider;
  content: FakeContentRepository;
  metadata: FakeMetadataRepository;
} {
  const innerTube = options.innerTube ?? new FakeProvider();
  const ytDlp = options.ytDlp ?? new FakeOptionalProvider(true);
  const content = options.content ?? new FakeContentRepository();
  const metadata = options.metadata ?? new FakeMetadataRepository();
  return {
    service: new YouTubeTranscriptService({
      innerTube,
      ytDlp,
      contentRepository: content,
      metadataRepository: metadata,
      clock: options.clock ?? (() => new Date("2026-07-28T06:00:00.000Z")),
      choiceTtlMs: options.choiceTtlMs,
      maxPendingChoiceSets: options.maxPendingChoiceSets,
    }),
    innerTube,
    ytDlp,
    content,
    metadata,
  };
}

describe("YouTubeTranscriptService", () => {
  it("rejects unbounded pending-choice retention settings", () => {
    expect(() => createService({ choiceTtlMs: 60 * 60 * 1_000 })).toThrow(
      "Invalid choice TTL",
    );
    expect(() => createService({ maxPendingChoiceSets: 1_000 })).toThrow(
      "Invalid pending choice capacity",
    );
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
    });
    expect(content.writes).toEqual([]);
    expect(metadata.updates).toEqual([
      { id: ITEM_ID, path: CONTENT_PATH, basis: "youtube-transcript" },
    ]);
    expect(innerTube.listCalls).toBe(0);
    expect(ytDlp.listCalls).toBe(0);
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
