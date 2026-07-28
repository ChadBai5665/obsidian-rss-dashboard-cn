import type {
  CachedItemContent,
  YouTubeTranscriptCachedItemContent,
} from "../collection/content-repository";
import {
  assertYouTubeVideoId,
  YouTubeTranscriptError,
  type YouTubeCaptionTrack,
  type YouTubeTranscript,
  type YouTubeTranscriptErrorCode,
} from "./transcript-types";

export interface TranscriptProvider {
  listTracks(
    videoId: string,
    signal?: AbortSignal,
  ): Promise<YouTubeCaptionTrack[]>;
  fetchTrack(
    track: YouTubeCaptionTrack,
    signal?: AbortSignal,
  ): Promise<YouTubeTranscript>;
}

export interface OptionalTranscriptProvider extends TranscriptProvider {
  isAvailable(): Promise<boolean>;
}

export interface TranscriptCacheRepository {
  read(itemId: string): Promise<CachedItemContent | null>;
  write(content: CachedItemContent): Promise<string>;
  pathFor(itemId: string): string;
}

export interface TranscriptMetadataRepository {
  updateContentMetadata(
    itemId: string,
    contentPath: string,
    contentBasis: "youtube-transcript",
  ): Promise<void>;
}

export interface YouTubeTranscriptServiceOptions {
  innerTube: TranscriptProvider;
  ytDlp: OptionalTranscriptProvider;
  contentRepository: TranscriptCacheRepository;
  metadataRepository: TranscriptMetadataRepository;
  clock: () => Date;
}

export interface YouTubeTranscriptRequest {
  itemId: string;
  videoId: string;
  sourceUrl?: string;
  preferredLanguage?: string;
  refresh?: boolean;
  trackId?: string;
  signal?: AbortSignal;
}

export interface YouTubeTranscriptTrackChoice {
  id: string;
  languageCode: string;
  languageName: string;
  isGenerated: boolean;
  provider: "innertube" | "yt-dlp";
}

export type YouTubeTranscriptServiceResult =
  | {
      status: "ready";
      source: "cache" | "fresh";
      content: YouTubeTranscriptCachedItemContent;
    }
  | {
      status: "selection-required";
      tracks: readonly YouTubeTranscriptTrackChoice[];
    };

export type YouTubeTranscriptServiceErrorCode =
  | YouTubeTranscriptErrorCode
  | "fallback-unavailable";

/** Stable service error that does not expose provider payloads or executable output. */
export class YouTubeTranscriptServiceError extends Error {
  constructor(
    readonly code: YouTubeTranscriptServiceErrorCode,
    readonly primaryCode?: YouTubeTranscriptErrorCode,
  ) {
    super(code);
    this.name = "YouTubeTranscriptServiceError";
  }
}

interface RegisteredChoice {
  provider: TranscriptProvider;
  track: YouTubeCaptionTrack;
}

interface RankedTrack {
  track: YouTubeCaptionTrack;
  languageRank: number;
  generatedRank: number;
}

const STABLE_ITEM_ID = /^[a-f0-9]{64}$/u;
const LANGUAGE_CODE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/u;
const FALLBACK_ELIGIBLE = new Set<YouTubeTranscriptErrorCode>([
  "no-captions",
  "temporarily-unavailable",
  "timeout",
]);

export class YouTubeTranscriptService {
  private readonly inFlight = new Map<
    string,
    Promise<YouTubeTranscriptServiceResult>
  >();
  private readonly pendingChoices = new Map<string, Map<string, RegisteredChoice>>();
  private choiceSequence = 0;

  constructor(private readonly options: YouTubeTranscriptServiceOptions) {}

  async get(
    request: YouTubeTranscriptRequest,
  ): Promise<YouTubeTranscriptServiceResult> {
    assertRequest(request);
    const key = requestKey(request.itemId, request.videoId);
    const active = this.inFlight.get(key);
    if (active) return await active;

    const operation = this.getInternal(request, key);
    this.inFlight.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.inFlight.get(key) === operation) this.inFlight.delete(key);
    }
  }

  private async getInternal(
    request: YouTubeTranscriptRequest,
    key: string,
  ): Promise<YouTubeTranscriptServiceResult> {
    assertNotAborted(request.signal);

    if (!request.refresh && request.trackId === undefined) {
      const cached = await this.options.contentRepository.read(request.itemId);
      if (isMatchingTranscriptCache(cached, request)) {
        await this.repairMetadata(
          request.itemId,
          this.options.contentRepository.pathFor(request.itemId),
        );
        return { status: "ready", source: "cache", content: cached };
      }
    }

    const registered =
      request.trackId === undefined
        ? undefined
        : this.pendingChoices.get(key)?.get(request.trackId);
    if (request.trackId !== undefined && !registered) {
      throw new YouTubeTranscriptServiceError("temporarily-unavailable");
    }

    if (registered) {
      try {
        return await this.fetchAndPersist(
          request,
          key,
          registered.provider,
          registered.track,
        );
      } catch (error) {
        const primary = normalizeProviderError(error);
        if (
          registered.track.source !== "innertube" ||
          !isFallbackEligible(primary.code)
        ) {
          throw primary;
        }
        return await this.runFallback(request, key, primary.code);
      }
    }

    try {
      return await this.runProvider(
        request,
        key,
        this.options.innerTube,
        "innertube",
      );
    } catch (error) {
      const primary = normalizeProviderError(error);
      if (!isFallbackEligible(primary.code)) throw primary;
      return await this.runFallback(request, key, primary.code);
    }
  }

  private async runProvider(
    request: YouTubeTranscriptRequest,
    key: string,
    provider: TranscriptProvider,
    expectedSource: "innertube" | "yt-dlp",
  ): Promise<YouTubeTranscriptServiceResult> {
    assertNotAborted(request.signal);
    const tracks = await provider.listTracks(request.videoId, request.signal);
    assertNotAborted(request.signal);
    const eligible = tracks.filter(
      (candidate) => candidate.source === expectedSource,
    );
    if (eligible.length === 0) {
      throw new YouTubeTranscriptServiceError("no-captions");
    }

    const selected = selectTracks(eligible, request.preferredLanguage);
    if (selected.length > 1) {
      return this.registerChoices(key, provider, selected);
    }
    return await this.fetchAndPersist(
      request,
      key,
      provider,
      selected[0],
    );
  }

  private async fetchAndPersist(
    request: YouTubeTranscriptRequest,
    key: string,
    provider: TranscriptProvider,
    selectedTrack: YouTubeCaptionTrack,
  ): Promise<YouTubeTranscriptServiceResult> {
    const transcript = await provider.fetchTrack(
      selectedTrack,
      request.signal,
    );
    assertNotAborted(request.signal);
    const content = createCachedTranscript(request, transcript, this.options.clock);
    const path = await this.options.contentRepository.write(content);
    this.pendingChoices.delete(key);
    await this.repairMetadata(request.itemId, path);
    return { status: "ready", source: "fresh", content };
  }

  private async runFallback(
    request: YouTubeTranscriptRequest,
    key: string,
    primaryCode: YouTubeTranscriptErrorCode,
  ): Promise<YouTubeTranscriptServiceResult> {
    assertNotAborted(request.signal);
    let available: boolean;
    try {
      available = await this.options.ytDlp.isAvailable();
    } catch {
      throw new YouTubeTranscriptServiceError(
        "temporarily-unavailable",
        primaryCode,
      );
    }
    assertNotAborted(request.signal);
    if (!available) {
      throw new YouTubeTranscriptServiceError(
        "fallback-unavailable",
        primaryCode,
      );
    }

    try {
      return await this.runProvider(
        request,
        key,
        this.options.ytDlp,
        "yt-dlp",
      );
    } catch (error) {
      throw normalizeProviderError(error);
    }
  }

  private registerChoices(
    key: string,
    provider: TranscriptProvider,
    tracks: readonly YouTubeCaptionTrack[],
  ): YouTubeTranscriptServiceResult {
    const registered = new Map<string, RegisteredChoice>();
    const choices = tracks.map((candidate) => {
      const id = `track-${++this.choiceSequence}`;
      registered.set(id, { provider, track: candidate });
      return Object.freeze({
        id,
        languageCode: candidate.languageCode,
        languageName: candidate.languageName,
        isGenerated: candidate.isGenerated,
        provider: candidate.source,
      });
    });
    this.pendingChoices.set(key, registered);
    return {
      status: "selection-required",
      tracks: Object.freeze(choices),
    };
  }

  private async repairMetadata(
    itemId: string,
    contentPath: string,
  ): Promise<void> {
    try {
      await this.options.metadataRepository.updateContentMetadata(
        itemId,
        contentPath,
        "youtube-transcript",
      );
    } catch {
      // The durable cache remains authoritative. A later cache read retries.
    }
  }
}

function selectTracks(
  tracks: readonly YouTubeCaptionTrack[],
  preferredLanguage: string | undefined,
): YouTubeCaptionTrack[] {
  const ranked: RankedTrack[] = tracks.map((candidate) => ({
    track: candidate,
    languageRank: languageRank(candidate.languageCode, preferredLanguage),
    generatedRank: candidate.isGenerated ? 1 : 0,
  }));
  const bestLanguage = Math.min(...ranked.map((candidate) => candidate.languageRank));
  const languageMatches = ranked.filter(
    (candidate) => candidate.languageRank === bestLanguage,
  );
  const bestGeneration = Math.min(
    ...languageMatches.map((candidate) => candidate.generatedRank),
  );
  return languageMatches
    .filter((candidate) => candidate.generatedRank === bestGeneration)
    .map((candidate) => candidate.track);
}

function languageRank(
  languageCode: string,
  preferredLanguage: string | undefined,
): number {
  if (!preferredLanguage?.trim()) return 0;
  const actual = languageCode.toLowerCase();
  const preferred = preferredLanguage.trim().toLowerCase();
  if (actual === preferred) return 0;
  if (actual.split("-")[0] === preferred.split("-")[0]) return 1;
  return 2;
}

function createCachedTranscript(
  request: YouTubeTranscriptRequest,
  transcript: YouTubeTranscript,
  clock: () => Date,
): YouTubeTranscriptCachedItemContent {
  if (
    transcript.videoId !== request.videoId ||
    !LANGUAGE_CODE.test(transcript.languageCode) ||
    typeof transcript.languageName !== "string" ||
    !transcript.languageName.trim() ||
    transcript.languageName.length > 200 ||
    hasUnsafeControl(transcript.languageName) ||
    typeof transcript.isGenerated !== "boolean" ||
    (transcript.provider !== "innertube" &&
      transcript.provider !== "yt-dlp") ||
    typeof transcript.text !== "string" ||
    !transcript.text.trim()
  ) {
    throw new YouTubeTranscriptServiceError("temporarily-unavailable");
  }
  const fetchedAt = clock().toISOString();
  if (Number.isNaN(Date.parse(fetchedAt))) {
    throw new YouTubeTranscriptServiceError("temporarily-unavailable");
  }
  return {
    schemaVersion: 2,
    contentBasis: "youtube-transcript",
    itemId: request.itemId,
    ...(request.sourceUrl === undefined ? {} : { sourceUrl: request.sourceUrl }),
    fetchedAt,
    videoId: transcript.videoId,
    languageCode: transcript.languageCode,
    languageName: transcript.languageName,
    isGenerated: transcript.isGenerated,
    provider: transcript.provider,
    text: transcript.text,
  };
}

function isMatchingTranscriptCache(
  content: CachedItemContent | null,
  request: YouTubeTranscriptRequest,
): content is YouTubeTranscriptCachedItemContent {
  return (
    content?.schemaVersion === 2 &&
    content.contentBasis === "youtube-transcript" &&
    content.itemId === request.itemId &&
    content.videoId === request.videoId &&
    LANGUAGE_CODE.test(content.languageCode) &&
    typeof content.languageName === "string" &&
    Boolean(content.languageName.trim()) &&
    (content.provider === "innertube" || content.provider === "yt-dlp") &&
    typeof content.text === "string" &&
    Boolean(content.text.trim())
  );
}

function normalizeProviderError(error: unknown): YouTubeTranscriptServiceError {
  if (error instanceof YouTubeTranscriptServiceError) return error;
  if (error instanceof YouTubeTranscriptError) {
    return new YouTubeTranscriptServiceError(error.code);
  }
  return new YouTubeTranscriptServiceError("temporarily-unavailable");
}

function isFallbackEligible(
  code: YouTubeTranscriptServiceErrorCode,
): code is YouTubeTranscriptErrorCode {
  return (
    code !== "fallback-unavailable" &&
    FALLBACK_ELIGIBLE.has(code)
  );
}

function assertRequest(request: YouTubeTranscriptRequest): void {
  if (!STABLE_ITEM_ID.test(request.itemId)) {
    throw new YouTubeTranscriptServiceError("temporarily-unavailable");
  }
  try {
    assertYouTubeVideoId(request.videoId);
  } catch {
    throw new YouTubeTranscriptServiceError("invalid-video-id");
  }
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new YouTubeTranscriptServiceError("aborted");
  }
}

function requestKey(itemId: string, videoId: string): string {
  return `${itemId}\0${videoId}`;
}

function hasUnsafeControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}
