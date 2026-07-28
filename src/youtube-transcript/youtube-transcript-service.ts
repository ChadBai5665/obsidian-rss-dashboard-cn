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
  transaction<T>(
    itemId: string,
    operation: (transaction: TranscriptCacheTransaction) => Promise<T>,
  ): Promise<T>;
}

export interface TranscriptCacheTransaction {
  read(): Promise<CachedItemContent | null>;
  write(content: CachedItemContent): Promise<string>;
  pathFor(): string;
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
  choiceTtlMs?: number;
  maxPendingChoiceSets?: number;
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
      choiceSetId: string;
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

/** Internal marker that distinguishes provider/tool failures from local state. */
class TranscriptProviderStageError extends Error {
  constructor(readonly failure: YouTubeTranscriptServiceError) {
    super(failure.message);
    this.name = "TranscriptProviderStageError";
  }
}

interface RegisteredChoice {
  provider: TranscriptProvider;
  track: YouTubeCaptionTrack;
  fallbackPrimaryCode?: YouTubeTranscriptErrorCode;
}

interface PendingChoiceSet {
  generation: symbol;
  choiceSetId: string;
  expiresAt: number;
  expirationTimer: number;
  choices: Map<string, RegisteredChoice>;
}

interface SelectionAtStart {
  pendingGeneration: symbol;
  registered: RegisteredChoice;
}

interface SharedWork {
  controller: AbortController;
  promise: Promise<YouTubeTranscriptServiceResult>;
  subscribers: number;
  settled: boolean;
  onAllCancelled: () => void;
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
const NO_CAPTIONS_PRESERVABLE_FALLBACK_FAILURES = new Set<
  YouTubeTranscriptServiceErrorCode
>(["no-captions", "temporarily-unavailable", "timeout"]);
const DEFAULT_CHOICE_TTL_MS = 2 * 60 * 1_000;
const DEFAULT_MAX_PENDING_CHOICE_SETS = 20;
const MAX_CHOICE_TTL_MS = 10 * 60 * 1_000;
const MAX_PENDING_CHOICE_SETS = 100;

export class YouTubeTranscriptService {
  private readonly inFlight = new Map<string, SharedWork>();
  private readonly pendingChoices = new Map<string, PendingChoiceSet>();
  private readonly choiceSetIndex = new Map<
    string,
    { key: string; generation: symbol }
  >();
  private readonly currentGenerations = new Map<string, symbol>();
  private readonly choiceTtlMs: number;
  private readonly maxPendingChoiceSets: number;
  private choiceSequence = 0;
  private choiceSetSequence = 0;
  private disposed = false;

  constructor(private readonly options: YouTubeTranscriptServiceOptions) {
    this.choiceTtlMs = positiveInteger(
      options.choiceTtlMs,
      DEFAULT_CHOICE_TTL_MS,
      MAX_CHOICE_TTL_MS,
      "choice TTL",
    );
    this.maxPendingChoiceSets = positiveInteger(
      options.maxPendingChoiceSets,
      DEFAULT_MAX_PENDING_CHOICE_SETS,
      MAX_PENDING_CHOICE_SETS,
      "pending choice capacity",
    );
  }

  async get(
    request: YouTubeTranscriptRequest,
  ): Promise<YouTubeTranscriptServiceResult> {
    this.assertActive();
    assertRequest(request);
    this.cleanupExpiredChoices();
    const resourceKey = requestKey(request.itemId, request.videoId);
    const workKey = requestWorkKey(resourceKey, request);
    const operationGeneration = Symbol(workKey);
    const pendingAtStart = this.pendingChoices.get(resourceKey);
    const registeredAtStart =
      request.trackId === undefined
        ? undefined
        : pendingAtStart?.choices.get(request.trackId);
    const selectionAtStart =
      registeredAtStart === undefined || pendingAtStart === undefined
        ? undefined
        : {
            pendingGeneration: pendingAtStart.generation,
            registered: registeredAtStart,
          };
    return await this.subscribeToWork(
      workKey,
      request.signal,
      async (sharedSignal) =>
        await this.getInternal(
          { ...request, signal: sharedSignal },
          resourceKey,
          operationGeneration,
          selectionAtStart,
        ),
      () => {
        const pending = this.pendingChoices.get(resourceKey);
        if (
          request.trackId !== undefined
            ? pending?.choices.has(request.trackId)
            : false
        ) {
          this.deletePendingChoiceSet(resourceKey);
        }
        this.clearGeneration(resourceKey, operationGeneration);
      },
      () => {
        if (request.trackId === undefined || selectionAtStart !== undefined) {
          this.beginGeneration(
            resourceKey,
            operationGeneration,
            request.trackId === undefined,
          );
        }
      },
    );
  }

  /** Releases all runtime-owned resources and permanently rejects new work. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [key, work] of this.inFlight) {
      this.inFlight.delete(key);
      work.onAllCancelled();
      work.controller.abort();
    }
    for (const [key] of this.pendingChoices) {
      this.deletePendingChoiceSet(key);
    }
    this.choiceSetIndex.clear();
    this.currentGenerations.clear();
  }

  /** Revokes only the opaque choice generation issued to one panel. */
  revokeChoiceSet(choiceSetId: string): void {
    const indexed = this.choiceSetIndex.get(choiceSetId);
    if (!indexed) return;
    const pending = this.pendingChoices.get(indexed.key);
    if (
      pending?.generation !== indexed.generation ||
      pending.choiceSetId !== choiceSetId
    ) {
      this.choiceSetIndex.delete(choiceSetId);
      return;
    }
    this.clearGeneration(indexed.key, indexed.generation);
  }

  private async getInternal(
    request: YouTubeTranscriptRequest,
    key: string,
    operationGeneration: symbol,
    selectionAtStart: SelectionAtStart | undefined,
  ): Promise<YouTubeTranscriptServiceResult> {
    try {
      assertNotAborted(request.signal);

      if (!request.refresh && request.trackId === undefined) {
        const cachedResult = await this.options.contentRepository.transaction(
          request.itemId,
          async (transaction) => {
            assertNotAborted(request.signal);
            const cached = await transaction.read();
            assertNotAborted(request.signal);
            if (!isMatchingTranscriptCache(cached, request)) return null;
            await this.repairMetadata(request.itemId, transaction.pathFor());
            return { status: "ready", source: "cache", content: cached } as const;
          },
        );
        if (cachedResult) {
          this.clearGeneration(key, operationGeneration);
          return cachedResult;
        }
      }

      if (request.trackId !== undefined && selectionAtStart === undefined) {
        throw new YouTubeTranscriptServiceError("temporarily-unavailable");
      }

      if (selectionAtStart !== undefined) {
        try {
          const result = await this.fetchAndPersist(
            request,
            key,
            operationGeneration,
            selectionAtStart.registered.provider,
            selectionAtStart.registered.track,
          );
          this.deletePendingChoiceSet(key, selectionAtStart.pendingGeneration);
          this.clearGeneration(key, operationGeneration);
          return result;
        } catch (error) {
          const primary = normalizeProviderError(error);
          if (request.signal?.aborted || this.disposed) {
            throw new YouTubeTranscriptServiceError("aborted");
          }
          if (this.currentGenerations.get(key) !== operationGeneration) {
            throw new YouTubeTranscriptServiceError("temporarily-unavailable");
          }
          if (
            selectionAtStart.registered.fallbackPrimaryCode === "no-captions" &&
            preservesNoCaptions(error)
          ) {
            throw new YouTubeTranscriptServiceError("no-captions");
          }
          if (
            selectionAtStart.registered.track.source !== "innertube" ||
            !isFallbackEligible(primary.code)
          ) {
            throw primary;
          }
          const result = await this.runFallback(
            request,
            key,
            operationGeneration,
            primary.code,
          );
          if (result.status === "ready") {
            this.deletePendingChoiceSet(
              key,
              selectionAtStart.pendingGeneration,
            );
            this.clearGeneration(key, operationGeneration);
          }
          return result;
        }
      }

      this.assertCurrentGeneration(key, operationGeneration);
      try {
        const result = await this.runProvider(
          request,
          key,
          operationGeneration,
          this.options.innerTube,
          "innertube",
        );
        if (result.status === "ready") {
          this.clearGeneration(key, operationGeneration);
        }
        return result;
      } catch (error) {
        const primary = normalizeProviderError(error);
        if (request.signal?.aborted || this.disposed) {
          throw new YouTubeTranscriptServiceError("aborted");
        }
        if (this.currentGenerations.get(key) !== operationGeneration) {
          throw new YouTubeTranscriptServiceError("temporarily-unavailable");
        }
        if (!isFallbackEligible(primary.code)) throw primary;
        const result = await this.runFallback(
          request,
          key,
          operationGeneration,
          primary.code,
        );
        if (result.status === "ready") {
          this.clearGeneration(key, operationGeneration);
        }
        return result;
      }
    } catch (error) {
      if (selectionAtStart !== undefined) {
        this.deletePendingChoiceSet(key, selectionAtStart.pendingGeneration);
      }
      this.clearGeneration(key, operationGeneration);
      throw error;
    }
  }

  private async runProvider(
    request: YouTubeTranscriptRequest,
    key: string,
    operationGeneration: symbol,
    provider: TranscriptProvider,
    expectedSource: "innertube" | "yt-dlp",
    fallbackPrimaryCode?: YouTubeTranscriptErrorCode,
  ): Promise<YouTubeTranscriptServiceResult> {
    assertNotAborted(request.signal);
    this.assertCurrentGeneration(key, operationGeneration);
    let tracks: YouTubeCaptionTrack[];
    try {
      tracks = await provider.listTracks(request.videoId, request.signal);
    } catch (error) {
      throw providerStageError(error);
    }
    assertNotAborted(request.signal);
    this.assertCurrentGeneration(key, operationGeneration);
    const eligible = tracks.filter(
      (candidate) => candidate.source === expectedSource,
    );
    if (eligible.length === 0) {
      throw providerStageError(
        new YouTubeTranscriptServiceError("no-captions"),
      );
    }

    const selected = selectTracks(eligible, request.preferredLanguage);
    if (selected.length > 1) {
      return this.registerChoices(
        key,
        operationGeneration,
        provider,
        selected,
        fallbackPrimaryCode,
      );
    }
    return await this.fetchAndPersist(
      request,
      key,
      operationGeneration,
      provider,
      selected[0],
    );
  }

  private async fetchAndPersist(
    request: YouTubeTranscriptRequest,
    key: string,
    operationGeneration: symbol,
    provider: TranscriptProvider,
    selectedTrack: YouTubeCaptionTrack,
  ): Promise<YouTubeTranscriptServiceResult> {
    this.assertCurrentGeneration(key, operationGeneration);
    let transcript: YouTubeTranscript;
    try {
      transcript = await provider.fetchTrack(selectedTrack, request.signal);
    } catch (error) {
      throw providerStageError(error);
    }
    assertNotAborted(request.signal);
    this.assertCurrentGeneration(key, operationGeneration);
    try {
      assertProviderTranscript(request, transcript);
    } catch (error) {
      throw providerStageError(error);
    }
    const content = createCachedTranscript(
      request,
      transcript,
      this.options.clock,
    );
    await this.options.contentRepository.transaction(
      request.itemId,
      async (transaction) => {
        assertNotAborted(request.signal);
        this.assertCurrentGeneration(key, operationGeneration);
        const path = await transaction.write(content);
        await this.repairMetadata(request.itemId, path);
        this.assertCurrentGeneration(key, operationGeneration);
      },
    );
    return { status: "ready", source: "fresh", content };
  }

  private async runFallback(
    request: YouTubeTranscriptRequest,
    key: string,
    operationGeneration: symbol,
    primaryCode: YouTubeTranscriptErrorCode,
  ): Promise<YouTubeTranscriptServiceResult> {
    assertNotAborted(request.signal);
    this.assertCurrentGeneration(key, operationGeneration);
    const preserveNoCaptions = primaryCode === "no-captions";
    let available: boolean;
    try {
      available = await this.options.ytDlp.isAvailable();
    } catch {
      if (request.signal?.aborted || this.disposed) {
        throw new YouTubeTranscriptServiceError("aborted");
      }
      if (this.currentGenerations.get(key) !== operationGeneration) {
        throw new YouTubeTranscriptServiceError("temporarily-unavailable");
      }
      if (preserveNoCaptions) {
        throw new YouTubeTranscriptServiceError("no-captions");
      }
      throw new YouTubeTranscriptServiceError(
        "temporarily-unavailable",
        primaryCode,
      );
    }
    assertNotAborted(request.signal);
    this.assertCurrentGeneration(key, operationGeneration);
    if (!available) {
      if (preserveNoCaptions) {
        throw new YouTubeTranscriptServiceError("no-captions");
      }
      throw new YouTubeTranscriptServiceError(
        "fallback-unavailable",
        primaryCode,
      );
    }

    try {
      return await this.runProvider(
        request,
        key,
        operationGeneration,
        this.options.ytDlp,
        "yt-dlp",
        primaryCode,
      );
    } catch (error) {
      const failure = normalizeProviderError(error);
      if (request.signal?.aborted || this.disposed) {
        throw new YouTubeTranscriptServiceError("aborted");
      }
      if (this.currentGenerations.get(key) !== operationGeneration) {
        throw new YouTubeTranscriptServiceError("temporarily-unavailable");
      }
      if (preserveNoCaptions && preservesNoCaptions(error)) {
        throw new YouTubeTranscriptServiceError("no-captions");
      }
      throw failure;
    }
  }

  private registerChoices(
    key: string,
    operationGeneration: symbol,
    provider: TranscriptProvider,
    tracks: readonly YouTubeCaptionTrack[],
    fallbackPrimaryCode?: YouTubeTranscriptErrorCode,
  ): YouTubeTranscriptServiceResult {
    this.assertCurrentGeneration(key, operationGeneration);
    const registered = new Map<string, RegisteredChoice>();
    const choices = tracks.map((candidate) => {
      const id = `track-${++this.choiceSequence}`;
      registered.set(id, {
        provider,
        track: candidate,
        ...(fallbackPrimaryCode === undefined ? {} : { fallbackPrimaryCode }),
      });
      return Object.freeze({
        id,
        languageCode: candidate.languageCode,
        languageName: candidate.languageName,
        isGenerated: candidate.isGenerated,
        provider: candidate.source,
      });
    });
    this.deletePendingChoiceSet(key);
    const choiceSetId = `choice-set-${++this.choiceSetSequence}`;
    const expirationTimer = window.setTimeout(() => {
      this.clearGeneration(key, operationGeneration);
    }, this.choiceTtlMs);
    this.pendingChoices.set(key, {
      generation: operationGeneration,
      choiceSetId,
      expiresAt: this.options.clock().getTime() + this.choiceTtlMs,
      expirationTimer,
      choices: registered,
    });
    this.choiceSetIndex.set(choiceSetId, {
      key,
      generation: operationGeneration,
    });
    this.enforceChoiceCapacity();
    return {
      status: "selection-required",
      choiceSetId,
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

  private async subscribeToWork(
    key: string,
    callerSignal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<YouTubeTranscriptServiceResult>,
    onAllCancelled: () => void,
    onStart: () => void,
  ): Promise<YouTubeTranscriptServiceResult> {
    assertNotAborted(callerSignal);
    let work = this.inFlight.get(key);
    if (!work) {
      onStart();
      const controller = new AbortController();
      let resolveWork!: (value: YouTubeTranscriptServiceResult) => void;
      let rejectWork!: (reason: unknown) => void;
      const promise = new Promise<YouTubeTranscriptServiceResult>(
        (resolve, reject) => {
          resolveWork = resolve;
          rejectWork = reject;
        },
      );
      work = {
        controller,
        promise,
        subscribers: 0,
        settled: false,
        onAllCancelled,
      };
      this.inFlight.set(key, work);
      void operation(controller.signal).then(resolveWork, rejectWork);
      const created = work;
      void created.promise.then(
        () => this.settleWork(key, created),
        () => this.settleWork(key, created),
      );
    }
    work.subscribers += 1;
    return await this.awaitSharedWork(key, work, callerSignal);
  }

  private async awaitSharedWork(
    key: string,
    work: SharedWork,
    callerSignal: AbortSignal | undefined,
  ): Promise<YouTubeTranscriptServiceResult> {
    return await new Promise<YouTubeTranscriptServiceResult>((resolve, reject) => {
      let released = false;
      const release = (cancelled: boolean) => {
        if (released) return;
        released = true;
        callerSignal?.removeEventListener("abort", onAbort);
        work.subscribers = Math.max(0, work.subscribers - 1);
        if (cancelled && work.subscribers === 0 && !work.settled) {
          if (this.inFlight.get(key) === work) this.inFlight.delete(key);
          work.onAllCancelled();
          work.controller.abort();
        }
      };
      const onAbort = () => {
        release(true);
        reject(new YouTubeTranscriptServiceError("aborted"));
      };
      callerSignal?.addEventListener("abort", onAbort, { once: true });
      if (callerSignal?.aborted) {
        onAbort();
        return;
      }
      void work.promise.then(
        (value) => {
          if (released) return;
          release(false);
          resolve(value);
        },
        (error: unknown) => {
          if (released) return;
          release(false);
          reject(
            error instanceof Error
              ? error
              : new YouTubeTranscriptServiceError("temporarily-unavailable"),
          );
        },
      );
    });
  }

  private settleWork(key: string, work: SharedWork): void {
    work.settled = true;
    if (this.inFlight.get(key) === work) this.inFlight.delete(key);
  }

  private cleanupExpiredChoices(): void {
    const now = this.options.clock().getTime();
    for (const [key, entry] of this.pendingChoices) {
      if (entry.expiresAt <= now) this.clearGeneration(key, entry.generation);
    }
  }

  private enforceChoiceCapacity(): void {
    while (this.pendingChoices.size > this.maxPendingChoiceSets) {
      const oldest = this.pendingChoices.keys().next().value;
      if (oldest === undefined) return;
      const pending = this.pendingChoices.get(oldest);
      if (pending === undefined) return;
      this.clearGeneration(oldest, pending.generation);
    }
  }

  private clearPendingChoices(key: string, generation: symbol): void {
    this.deletePendingChoiceSet(key, generation);
  }

  private beginGeneration(
    key: string,
    generation: symbol,
    invalidateChoices: boolean,
  ): void {
    this.currentGenerations.set(key, generation);
    if (invalidateChoices) this.deletePendingChoiceSet(key);
  }

  private assertCurrentGeneration(key: string, generation: symbol): void {
    if (this.currentGenerations.get(key) !== generation) {
      throw new YouTubeTranscriptServiceError("temporarily-unavailable");
    }
  }

  private clearGeneration(key: string, generation: symbol): void {
    this.clearPendingChoices(key, generation);
    if (this.currentGenerations.get(key) === generation) {
      this.currentGenerations.delete(key);
    }
  }

  private deletePendingChoiceSet(key: string, generation?: symbol): void {
    const pending = this.pendingChoices.get(key);
    if (
      !pending ||
      (generation !== undefined && pending.generation !== generation)
    ) {
      return;
    }
    window.clearTimeout(pending.expirationTimer);
    pending.choices.clear();
    this.choiceSetIndex.delete(pending.choiceSetId);
    this.pendingChoices.delete(key);
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new YouTubeTranscriptServiceError("aborted");
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
  let fetchedAt: string;
  try {
    fetchedAt = clock().toISOString();
  } catch {
    throw new YouTubeTranscriptServiceError("temporarily-unavailable");
  }
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

function assertProviderTranscript(
  request: YouTubeTranscriptRequest,
  transcript: YouTubeTranscript,
): void {
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
  if (error instanceof TranscriptProviderStageError) return error.failure;
  if (error instanceof YouTubeTranscriptServiceError) return error;
  if (error instanceof YouTubeTranscriptError) {
    return new YouTubeTranscriptServiceError(error.code);
  }
  return new YouTubeTranscriptServiceError("temporarily-unavailable");
}

function providerStageError(error: unknown): TranscriptProviderStageError {
  if (error instanceof TranscriptProviderStageError) return error;
  return new TranscriptProviderStageError(normalizeProviderError(error));
}

function preservesNoCaptions(error: unknown): boolean {
  return (
    error instanceof TranscriptProviderStageError &&
    NO_CAPTIONS_PRESERVABLE_FALLBACK_FAILURES.has(error.failure.code)
  );
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

function requestWorkKey(
  resourceKey: string,
  request: YouTubeTranscriptRequest,
): string {
  if (request.trackId !== undefined) {
    return `${resourceKey}\0select:${request.trackId}`;
  }
  const mode = request.refresh ? "refresh" : "cache";
  return [
    resourceKey,
    mode,
    request.preferredLanguage?.trim().toLowerCase() ?? "",
  ].join("\0");
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved <= 0 ||
    resolved > maximum
  ) {
    throw new Error(`Invalid ${label}`);
  }
  return resolved;
}

function hasUnsafeControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}
