import type {
  CachedItemContent,
  YouTubeTranscriptCachedItemContent,
} from "../collection/content-repository";
import type {
  OperationJournalPort,
  OperationJournalScope,
} from "../operation-journal/operation-journal-service";
import type {
  OperationDetails,
  OperationErrorCode,
  OperationStage,
} from "../operation-journal/operation-event";
import {
  assertYouTubeVideoId,
  snapshotTranscriptProviderOperationResult,
  YouTubeTranscriptError,
  type TranscriptProvider,
  type TranscriptProviderContinuation,
  type TranscriptProviderOperationContext,
  type TranscriptProviderOperationEvidence,
  type TranscriptProviderOperationResult,
  type TranscriptProviderRegistration,
  type YouTubeCaptionTrack,
  type YouTubeTranscript,
  type YouTubeTranscriptErrorCode,
  type YouTubeTranscriptProgress,
  type YouTubeTranscriptProgressStage,
  type YouTubeTranscriptProvider,
  type YouTubeTranscriptUsage,
} from "./transcript-types";
import { isValidYouTubeCaptionLanguageCode } from "./youtube-caption-language-code";

export type {
  TranscriptProvider,
  TranscriptProviderOperationContext,
  TranscriptProviderRegistration,
} from "./transcript-types";

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
  providers: readonly TranscriptProviderRegistration[];
  contentRepository: TranscriptCacheRepository;
  metadataRepository: TranscriptMetadataRepository;
  clock: () => Date;
  choiceTtlMs?: number;
  maxPendingChoiceSets?: number;
  operationJournal?: OperationJournalPort;
}

interface LegacyYouTubeTranscriptServiceOptions {
  innerTube: TranscriptProvider;
  ytDlp: OptionalTranscriptProvider;
  contentRepository: TranscriptCacheRepository;
  metadataRepository: TranscriptMetadataRepository;
  clock: () => Date;
  choiceTtlMs?: number;
  maxPendingChoiceSets?: number;
  operationJournal?: OperationJournalPort;
}

export interface YouTubeTranscriptRequest {
  itemId: string;
  videoId: string;
  sourceUrl?: string;
  preferredLanguage?: string;
  refresh?: boolean;
  trackId?: string;
  signal?: AbortSignal;
  onProgress?: (progress: YouTubeTranscriptProgress) => void;
  subjectLabel?: string;
}

export interface YouTubeTranscriptCacheRequest {
  itemId: string;
  videoId: string;
  signal?: AbortSignal;
}

export interface YouTubeTranscriptContinuationRequest
  extends YouTubeTranscriptCacheRequest {
  sourceUrl?: string;
  onProgress?: (progress: YouTubeTranscriptProgress) => void;
}

export interface YouTubeTranscriptTrackChoice {
  id: string;
  languageCode: string;
  languageName: string;
  isGenerated: boolean;
  provider: YouTubeTranscriptProvider;
}

export type YouTubeTranscriptServiceResult =
  | {
      status: "ready";
      source: "cache" | "fresh";
      content: YouTubeTranscriptCachedItemContent;
      usage: YouTubeTranscriptUsage;
    }
  | {
      status: "selection-required";
      choiceSetId: string;
      tracks: readonly YouTubeTranscriptTrackChoice[];
    };

export type YouTubeTranscriptServiceErrorCode =
  | YouTubeTranscriptErrorCode
  | "fallback-unavailable";

export interface YouTubeTranscriptProviderFailure {
  source: YouTubeTranscriptProvider;
  code: YouTubeTranscriptServiceErrorCode;
}

/** Stable service error that does not expose provider payloads or executable output. */
export class YouTubeTranscriptServiceError extends Error {
  constructor(
    readonly code: YouTubeTranscriptServiceErrorCode,
    readonly primaryCode?: YouTubeTranscriptErrorCode,
    failures: readonly YouTubeTranscriptProviderFailure[] = [],
    usage: YouTubeTranscriptUsage = ZERO_USAGE,
    tikhubPaidRequestPossiblySent = false,
  ) {
    super(code);
    this.name = "YouTubeTranscriptServiceError";
    this.failures = freezeFailures(failures);
    this.usage = freezeUsage(usage.tikhubPaidRequests);
    Object.defineProperty(this, "tikhubPaidRequestPossiblySent", {
      value: tikhubPaidRequestPossiblySent === true,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  readonly failures: readonly YouTubeTranscriptProviderFailure[];
  readonly usage: YouTubeTranscriptUsage;
  readonly tikhubPaidRequestPossiblySent!: boolean;
}

/** Internal marker that distinguishes provider/tool failures from local state. */
class TranscriptProviderStageError extends Error {
  constructor(readonly failure: YouTubeTranscriptServiceError) {
    super(failure.message);
    this.name = "TranscriptProviderStageError";
  }
}

interface RegisteredChoice {
  registration: TranscriptProviderRegistration;
  providerIndex: number;
  track: YouTubeCaptionTrack;
  context: TranscriptProviderOperationContext;
  failures: readonly YouTubeTranscriptProviderFailure[];
  usage: YouTubeTranscriptUsage;
  tikhubPaidRequestPossiblySent: boolean;
  timeline: TranscriptOperationTimeline;
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
  operationId: string;
  timeline: TranscriptOperationTimeline;
  subscribers: number;
  settled: boolean;
  onAllCancelled: () => void;
}

interface TranscriptOperationTimeline {
  readonly operationId: string;
  readonly scope: OperationJournalScope;
  stage: OperationStage;
  terminal: boolean;
}

interface RankedTrack {
  track: YouTubeCaptionTrack;
  languageRank: number;
  generatedRank: number;
}

interface ProviderChainState {
  failures: YouTubeTranscriptProviderFailure[];
  tikhubPaidRequests: 0 | 1 | 2;
  tikhubPaidRequestPossiblySent: boolean;
}

const STABLE_ITEM_ID = /^[a-f0-9]{64}$/u;
const FALLBACK_ELIGIBLE = new Set<YouTubeTranscriptErrorCode>([
  "no-captions",
  "temporarily-unavailable",
  "timeout",
]);
const TIKHUB_ACTIONABLE = new Set<YouTubeTranscriptErrorCode>([
  "tikhub-missing-key",
  "tikhub-invalid-key",
  "tikhub-insufficient-balance",
  "tikhub-budget-unavailable",
  "tikhub-rate-limited",
  "tikhub-job-expired",
  "tikhub-malformed-response",
]);
const NO_CAPTIONS_PRESERVABLE_FALLBACK_FAILURES = new Set<
  YouTubeTranscriptServiceErrorCode
>(["no-captions", "temporarily-unavailable", "timeout"]);
const DEFAULT_CHOICE_TTL_MS = 2 * 60 * 1_000;
const DEFAULT_MAX_PENDING_CHOICE_SETS = 20;
const MAX_CHOICE_TTL_MS = 10 * 60 * 1_000;
const MAX_PENDING_CHOICE_SETS = 100;
const ZERO_USAGE: YouTubeTranscriptUsage = Object.freeze({
  tikhubPaidRequests: 0,
});

export class YouTubeTranscriptService {
  private readonly inFlight = new Map<string, SharedWork>();
  private readonly pendingChoices = new Map<string, PendingChoiceSet>();
  private readonly choiceSetIndex = new Map<
    string,
    { key: string; generation: symbol }
  >();
  private readonly currentGenerations = new Map<string, symbol>();
  private readonly cacheReadControllers = new Set<AbortController>();
  private readonly choiceTtlMs: number;
  private readonly maxPendingChoiceSets: number;
  private readonly providers: readonly TranscriptProviderRegistration[];
  private choiceSequence = 0;
  private choiceSetSequence = 0;
  private disposed = false;

  constructor(options: YouTubeTranscriptServiceOptions);
  // Temporary compatibility until runtime wiring adopts ordered registrations.
  constructor(options: LegacyYouTubeTranscriptServiceOptions);
  constructor(
    private readonly options:
      | YouTubeTranscriptServiceOptions
      | LegacyYouTubeTranscriptServiceOptions,
  ) {
    this.providers = providerChainFromOptions(options);
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
      request,
      async (sharedSignal, timeline) =>
        await this.getInternal(
          { ...request, signal: sharedSignal },
          resourceKey,
          operationGeneration,
          selectionAtStart,
          timeline,
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
      selectionAtStart?.registered.timeline,
    );
  }

  /**
   * Reads only the durable transcript cache and repairs collection metadata.
   * A cache miss is final: this path never probes InnerTube or yt-dlp.
   */
  async readCached(
    request: YouTubeTranscriptCacheRequest,
  ): Promise<YouTubeTranscriptCachedItemContent | null> {
    this.assertActive();
    assertRequest(request);
    assertNotAborted(request.signal);
    const controller = new AbortController();
    const onCallerAbort = () => controller.abort();
    request.signal?.addEventListener("abort", onCallerAbort, { once: true });
    if (request.signal?.aborted) controller.abort();
    this.cacheReadControllers.add(controller);
    try {
      const cached = await this.options.contentRepository.transaction(
        request.itemId,
        async (transaction) => {
          assertNotAborted(controller.signal);
          const content = await transaction.read();
          assertNotAborted(controller.signal);
          if (!isMatchingTranscriptCache(content, request)) return null;
          await this.repairMetadata(request.itemId, transaction.pathFor());
          assertNotAborted(controller.signal);
          return content;
        },
      );
      assertNotAborted(controller.signal);
      return cached;
    } catch (error) {
      if (controller.signal.aborted || this.disposed) {
        throw new YouTubeTranscriptServiceError("aborted");
      }
      if (error instanceof YouTubeTranscriptServiceError) throw error;
      throw new YouTubeTranscriptServiceError("temporarily-unavailable");
    } finally {
      request.signal?.removeEventListener("abort", onCallerAbort);
      this.cacheReadControllers.delete(controller);
    }
  }

  async hasPendingContinuation(
    request: YouTubeTranscriptCacheRequest,
  ): Promise<boolean> {
    this.assertActive();
    assertRequest(request);
    assertNotAborted(request.signal);
    const registration = this.providers.find(
      ({ source, provider }) =>
        source === "tikhub" &&
        typeof provider.hasPendingContinuation === "function",
    );
    if (!registration?.provider.hasPendingContinuation) return false;
    try {
      const pending = await registration.provider.hasPendingContinuation(
        providerOperationContext(request, createLocalOperationId()),
      );
      assertNotAborted(request.signal);
      return pending === true;
    } catch (error) {
      if (error instanceof YouTubeTranscriptError) {
        throw new YouTubeTranscriptServiceError(error.code);
      }
      if (error instanceof YouTubeTranscriptServiceError) throw error;
      throw new YouTubeTranscriptServiceError("temporarily-unavailable");
    }
  }

  async continuePending(
    request: YouTubeTranscriptContinuationRequest,
  ): Promise<YouTubeTranscriptServiceResult & { status: "ready" }> {
    this.assertActive();
    assertRequest(request);
    const resourceKey = requestKey(request.itemId, request.videoId);
    const workKey = `${resourceKey}\0continue`;
    const operationGeneration = Symbol(workKey);
    return await this.subscribeToWork(
      workKey,
      request.signal,
      request,
      async (sharedSignal, timeline) =>
        await this.continuePendingInternal(
          { ...request, signal: sharedSignal },
          resourceKey,
          operationGeneration,
          timeline,
        ),
      () => this.clearGeneration(resourceKey, operationGeneration),
      () => this.beginGeneration(resourceKey, operationGeneration, true),
    ) as YouTubeTranscriptServiceResult & { status: "ready" };
  }

  private async continuePendingInternal(
    request: YouTubeTranscriptContinuationRequest,
    key: string,
    operationGeneration: symbol,
    timeline: TranscriptOperationTimeline,
  ): Promise<YouTubeTranscriptServiceResult & { status: "ready" }> {
    const state: ProviderChainState = {
      failures: [],
      tikhubPaidRequests: 0,
      tikhubPaidRequestPossiblySent: false,
    };
    const registration = this.providers.find(
      ({ source, provider }) =>
        source === "tikhub" &&
        typeof provider.continuePending === "function",
    );
    if (!registration?.provider.continuePending) {
      throw new YouTubeTranscriptServiceError("tikhub-job-expired");
    }
    const context = providerOperationContext(request, timeline.operationId);
    try {
      assertNotAborted(request.signal);
      this.assertCurrentGeneration(key, operationGeneration);
      emitProgress(request, "trying-tikhub", state);
      recordTimelineProgress(timeline, "trying-provider", {
        provider: "tikhub",
      });
      let settled: {
        value: TranscriptProviderContinuation;
        persistenceToken?: unknown;
      };
      try {
        settled = settleProviderOperation<TranscriptProviderContinuation>(
          await registration.provider.continuePending(request.signal, context),
          "tikhub",
          true,
          state,
        );
      } catch (error) {
        if (error instanceof TranscriptProviderStageError) throw error;
        throw providerOperationStageError(error, "tikhub", state);
      }
      assertNotAborted(request.signal);
      this.assertCurrentGeneration(key, operationGeneration);
      const continuation = settled.value;
      if (
        typeof continuation !== "object" ||
        continuation === null ||
        !Object.prototype.hasOwnProperty.call(continuation, "track") ||
        !Object.prototype.hasOwnProperty.call(continuation, "transcript")
      ) {
        throw new TranscriptProviderStageError(
          malformedProviderResponse("tikhub"),
        );
      }
      assertProviderTrack(continuation.track, "tikhub");
      assertProviderTranscript(request, continuation.transcript, "tikhub");
      emitProgress(request, "saving", state);
      recordTimelineProgress(timeline, "saving", { provider: "tikhub" });
      const content = createCachedTranscript(
        request,
        continuation.transcript,
        this.options.clock,
      );
      let metadataRepaired = true;
      await this.options.contentRepository.transaction(
        context.itemId,
        async (transaction) => {
          assertNotAborted(request.signal);
          this.assertCurrentGeneration(key, operationGeneration);
          const path = await transaction.write(content);
          metadataRepaired = await this.repairMetadata(context.itemId, path);
          assertNotAborted(request.signal);
          this.assertCurrentGeneration(key, operationGeneration);
        },
      );
      assertNotAborted(request.signal);
      this.assertCurrentGeneration(key, operationGeneration);
      if (!metadataRepaired) {
        recordTimelineProgress(timeline, "saving", {
          provider: "tikhub",
          errorCode: "cache-save-failed",
        });
      }
      try {
        await registration.provider.onPersisted?.(
          continuation.track,
          continuation.transcript,
          context,
          settled.persistenceToken,
        );
      } catch {
        // Durable content is authoritative; exact CAS cleanup can retry.
      }
      this.clearGeneration(key, operationGeneration);
      return {
        status: "ready",
        source: "fresh",
        content,
        usage: freezeUsage(state.tikhubPaidRequests),
      };
    } catch (error) {
      this.clearGeneration(key, operationGeneration);
      if (error instanceof TranscriptProviderStageError) {
        addFailure(state, "tikhub", error.failure.code);
        throw chainFailure(state, error.failure.code);
      }
      throw normalizeLocalError(error, state);
    }
  }

  /** Releases all runtime-owned resources and permanently rejects new work. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [key, work] of this.inFlight) {
      this.inFlight.delete(key);
      recordTimelineAbort(work.timeline);
      work.onAllCancelled();
      work.controller.abort();
    }
    for (const [key] of this.pendingChoices) {
      this.deletePendingChoiceSet(key);
    }
    for (const controller of this.cacheReadControllers) {
      controller.abort();
    }
    this.cacheReadControllers.clear();
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
    timeline: TranscriptOperationTimeline,
  ): Promise<YouTubeTranscriptServiceResult> {
    const context = providerOperationContext(
      selectionAtStart?.registered.context ?? request,
      timeline.operationId,
    );
    const state: ProviderChainState = selectionAtStart === undefined
      ? {
          failures: [],
          tikhubPaidRequests: 0,
          tikhubPaidRequestPossiblySent: false,
        }
      : {
          failures: [...selectionAtStart.registered.failures],
          tikhubPaidRequests:
            selectionAtStart.registered.usage.tikhubPaidRequests,
          tikhubPaidRequestPossiblySent:
            selectionAtStart.registered.tikhubPaidRequestPossiblySent,
        };
    try {
      assertNotAborted(request.signal);

      if (!request.refresh && request.trackId === undefined) {
        emitProgress(request, "checking-cache", state);
        recordTimelineProgress(timeline, "checking-cache", {
          provider: "cache",
        });
        const cachedResult = await this.options.contentRepository.transaction(
          request.itemId,
          async (transaction) => {
            assertNotAborted(request.signal);
            const cached = await transaction.read();
            assertNotAborted(request.signal);
            if (!isMatchingTranscriptCache(cached, request)) return null;
            const metadataRepaired = await this.repairMetadata(
              request.itemId,
              transaction.pathFor(),
            );
            if (!metadataRepaired) {
              recordTimelineProgress(timeline, "saving", {
                provider: "cache",
                errorCode: "cache-save-failed",
              });
            }
            return {
              status: "ready",
              source: "cache",
              content: cached,
              usage: ZERO_USAGE,
            } as const;
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
        const { registration, providerIndex, track: selectedTrack } =
          selectionAtStart.registered;
        emitProgress(request, stageForSource(registration.source), state);
        recordTimelineProgress(timeline, "trying-provider", {
          provider: registration.source,
        });
        try {
          const result = await this.fetchAndPersist(
            request,
            key,
            operationGeneration,
            registration,
            selectedTrack,
            state,
            context,
            timeline,
          );
          this.deletePendingChoiceSet(key, selectionAtStart.pendingGeneration);
          this.clearGeneration(key, operationGeneration);
          return result;
        } catch (error) {
          if (!(error instanceof TranscriptProviderStageError)) {
            if (request.signal?.aborted || this.disposed) {
              throw new YouTubeTranscriptServiceError("aborted");
            }
            if (this.currentGenerations.get(key) !== operationGeneration) {
              throw new YouTubeTranscriptServiceError("temporarily-unavailable");
            }
            throw normalizeLocalError(error, state);
          }
          const failure = error.failure;
          addFailure(state, registration.source, failure.code);
          recordProviderFailure(timeline, registration.source, failure.code);
          if (failure.code === "aborted") {
            throw chainFailure(state, failure.code);
          }
          if (failure.code === "tikhub-processing") {
            emitProgress(request, "waiting-tikhub", state);
            throw chainFailure(state, failure.code);
          }
          if (!isProviderFallbackEligible(registration.source, failure.code)) {
            throw chainFailure(state, failure.code);
          }
          const result = await this.runProvidersFrom(
            request,
            key,
            operationGeneration,
            providerIndex + 1,
            state,
            context,
            timeline,
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
      const result = await this.runProvidersFrom(
        request,
        key,
        operationGeneration,
        0,
        state,
        context,
        timeline,
      );
      if (result.status === "ready") {
        this.clearGeneration(key, operationGeneration);
      }
      return result;
    } catch (error) {
      if (selectionAtStart !== undefined) {
        this.deletePendingChoiceSet(key, selectionAtStart.pendingGeneration);
      }
      this.clearGeneration(key, operationGeneration);
      throw normalizeLocalError(error, state);
    }
  }

  private async runProvidersFrom(
    request: YouTubeTranscriptRequest,
    key: string,
    operationGeneration: symbol,
    startIndex: number,
    state: ProviderChainState,
    context: TranscriptProviderOperationContext,
    timeline: TranscriptOperationTimeline,
  ): Promise<YouTubeTranscriptServiceResult> {
    for (let index = startIndex; index < this.providers.length; index += 1) {
      const registration = this.providers[index];
      assertNotAborted(request.signal);
      this.assertCurrentGeneration(key, operationGeneration);

      if (registration.isAvailable) {
        let available: boolean;
        try {
          available = await registration.isAvailable();
        } catch {
          assertNotAborted(request.signal);
          this.assertCurrentGeneration(key, operationGeneration);
          addFailure(state, registration.source, "temporarily-unavailable");
          recordTimelineProgress(timeline, "trying-provider", {
            provider: registration.source,
          });
          recordProviderFailure(
            timeline,
            registration.source,
            "temporarily-unavailable",
          );
          continue;
        }
        assertNotAborted(request.signal);
        this.assertCurrentGeneration(key, operationGeneration);
        if (!available) {
          addFailure(state, registration.source, "fallback-unavailable");
          recordTimelineProgress(timeline, "trying-provider", {
            provider: registration.source,
          });
          recordProviderFailure(
            timeline,
            registration.source,
            "fallback-unavailable",
          );
          continue;
        }
      }

      try {
        return await this.runProvider(
          request,
          key,
          operationGeneration,
          registration,
          index,
          state,
          context,
          timeline,
        );
      } catch (error) {
        if (!(error instanceof TranscriptProviderStageError)) {
          if (request.signal?.aborted || this.disposed) {
            throw new YouTubeTranscriptServiceError("aborted");
          }
          if (this.currentGenerations.get(key) !== operationGeneration) {
            throw new YouTubeTranscriptServiceError("temporarily-unavailable");
          }
          throw normalizeLocalError(error, state);
        }
        const failure = error.failure;
        addFailure(state, registration.source, failure.code);
        recordProviderFailure(timeline, registration.source, failure.code);
        if (failure.code === "aborted") {
          throw chainFailure(state, failure.code);
        }
        if (failure.code === "tikhub-processing") {
          emitProgress(request, "waiting-tikhub", state);
          throw chainFailure(state, failure.code);
        }
        if (!isProviderFallbackEligible(registration.source, failure.code)) {
          throw chainFailure(state, failure.code);
        }
      }
    }
    throw chainFailure(state);
  }

  private async runProvider(
    request: YouTubeTranscriptRequest,
    key: string,
    operationGeneration: symbol,
    registration: TranscriptProviderRegistration,
    providerIndex: number,
    state: ProviderChainState,
    context: TranscriptProviderOperationContext,
    timeline: TranscriptOperationTimeline,
  ): Promise<YouTubeTranscriptServiceResult> {
    assertNotAborted(request.signal);
    this.assertCurrentGeneration(key, operationGeneration);
    emitProgress(request, stageForSource(registration.source), state);
    recordTimelineProgress(timeline, "trying-provider", {
      provider: registration.source,
    });
    let settledList: { value: YouTubeCaptionTrack[] };
    try {
      const listResult = await registration.provider.listTracks(
        context.videoId,
        request.signal,
        context,
      );
      settledList = settleProviderOperation<YouTubeCaptionTrack[]>(
        listResult,
        registration.source,
        false,
        state,
      );
    } catch (error) {
      if (error instanceof TranscriptProviderStageError) throw error;
      throw providerOperationStageError(error, registration.source, state);
    }
    assertNotAborted(request.signal);
    this.assertCurrentGeneration(key, operationGeneration);
    let selected: YouTubeCaptionTrack[];
    try {
      const tracks = settledList.value;
      assertProviderTracks(tracks, registration.source);
      if (registration.source === "tikhub") {
        emitProgress(request, "trying-tikhub", state);
      }
      if (tracks.length === 0) {
        throw new YouTubeTranscriptServiceError("no-captions");
      }
      selected = selectTracks(tracks, request.preferredLanguage);
    } catch (error) {
      throw providerStageError(error);
    }

    if (selected.length > 1) {
      return this.registerChoices(
        key,
        operationGeneration,
        registration,
        providerIndex,
        selected,
        state,
        context,
        timeline,
      );
    }
    return await this.fetchAndPersist(
      request,
      key,
      operationGeneration,
      registration,
      selected[0],
      state,
      context,
      timeline,
    );
  }

  private async fetchAndPersist(
    request: YouTubeTranscriptRequest,
    key: string,
    operationGeneration: symbol,
    registration: TranscriptProviderRegistration,
    selectedTrack: YouTubeCaptionTrack,
    state: ProviderChainState,
    context: TranscriptProviderOperationContext,
    timeline: TranscriptOperationTimeline,
  ): Promise<YouTubeTranscriptServiceResult> {
    this.assertCurrentGeneration(key, operationGeneration);
    let settledFetch: {
      value: YouTubeTranscript;
      persistenceToken?: unknown;
    };
    try {
      assertProviderTrack(selectedTrack, registration.source);
      const fetchResult = await registration.provider.fetchTrack(
        selectedTrack,
        request.signal,
        context,
      );
      settledFetch = settleProviderOperation<YouTubeTranscript>(
        fetchResult,
        registration.source,
        true,
        state,
      );
    } catch (error) {
      if (error instanceof TranscriptProviderStageError) throw error;
      throw providerOperationStageError(error, registration.source, state);
    }
    assertNotAborted(request.signal);
    this.assertCurrentGeneration(key, operationGeneration);
    let transcript: YouTubeTranscript;
    let persistenceToken: unknown;
    try {
      transcript = settledFetch.value;
      persistenceToken = settledFetch.persistenceToken;
      assertProviderTrack(selectedTrack, registration.source);
      assertProviderTranscript(
        { ...request, itemId: context.itemId, videoId: context.videoId },
        transcript,
        registration.source,
      );
      if (registration.source === "tikhub") {
        emitProgress(request, "trying-tikhub", state);
      }
    } catch (error) {
      throw providerStageError(error);
    }
    emitProgress(request, "saving", state);
    recordTimelineProgress(timeline, "saving", {
      provider: registration.source,
    });
    const content = createCachedTranscript(
      { ...request, itemId: context.itemId, videoId: context.videoId },
      transcript,
      this.options.clock,
    );
    let metadataRepaired = true;
    await this.options.contentRepository.transaction(
      context.itemId,
      async (transaction) => {
        assertNotAborted(request.signal);
        this.assertCurrentGeneration(key, operationGeneration);
        const path = await transaction.write(content);
        metadataRepaired = await this.repairMetadata(context.itemId, path);
        assertNotAborted(request.signal);
        this.assertCurrentGeneration(key, operationGeneration);
      },
    );
    assertNotAborted(request.signal);
    this.assertCurrentGeneration(key, operationGeneration);
    if (!metadataRepaired) {
      recordTimelineProgress(timeline, "saving", {
        provider: registration.source,
        errorCode: "cache-save-failed",
      });
    }
    if (registration.provider.onPersisted) {
      try {
        await registration.provider.onPersisted(
          selectedTrack,
          transcript,
          context,
          persistenceToken,
        );
      } catch {
        // Durable content is authoritative; cleanup can be retried separately.
      }
    }
    return {
      status: "ready",
      source: "fresh",
      content,
      usage: freezeUsage(state.tikhubPaidRequests),
    };
  }

  private registerChoices(
    key: string,
    operationGeneration: symbol,
    registration: TranscriptProviderRegistration,
    providerIndex: number,
    tracks: readonly YouTubeCaptionTrack[],
    state: ProviderChainState,
    context: TranscriptProviderOperationContext,
    timeline: TranscriptOperationTimeline,
  ): YouTubeTranscriptServiceResult {
    this.assertCurrentGeneration(key, operationGeneration);
    const registered = new Map<string, RegisteredChoice>();
    const choiceContext = providerOperationContext(
      context,
      timeline.operationId,
    );
    const choices = tracks.map((candidate) => {
      const id = `track-${++this.choiceSequence}`;
      registered.set(id, {
        registration,
        providerIndex,
        track: candidate,
        context: choiceContext,
        failures: freezeFailures(state.failures),
        usage: freezeUsage(state.tikhubPaidRequests),
        tikhubPaidRequestPossiblySent:
          state.tikhubPaidRequestPossiblySent,
        timeline,
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
  ): Promise<boolean> {
    try {
      await this.options.metadataRepository.updateContentMetadata(
        itemId,
        contentPath,
        "youtube-transcript",
      );
      return true;
    } catch {
      // The durable cache remains authoritative. A later cache read retries.
      return false;
    }
  }

  private async subscribeToWork(
    key: string,
    callerSignal: AbortSignal | undefined,
    request: { readonly itemId: string; readonly subjectLabel?: string },
    operation: (
      signal: AbortSignal,
      timeline: TranscriptOperationTimeline,
    ) => Promise<YouTubeTranscriptServiceResult>,
    onAllCancelled: () => void,
    onStart: () => void,
    existingTimeline?: TranscriptOperationTimeline,
  ): Promise<YouTubeTranscriptServiceResult> {
    assertNotAborted(callerSignal);
    let work = this.inFlight.get(key);
    if (!work) {
      onStart();
      const timeline =
        existingTimeline ??
        beginTranscriptTimeline(this.options.operationJournal, request);
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
        operationId: timeline.operationId,
        timeline,
        subscribers: 0,
        settled: false,
        onAllCancelled,
      };
      this.inFlight.set(key, work);
      void operation(controller.signal, timeline).then(
        (result) => {
          if (result.status === "ready") {
            recordTimelineSuccess(
              timeline,
              result.source === "cache" ? "cache" : result.content.provider,
            );
          }
          resolveWork(result);
        },
        (error: unknown) => {
          recordTimelineFailure(timeline, error);
          rejectWork(error);
        },
      );
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
      const release = (cancelled: boolean): boolean => {
        if (released) return false;
        released = true;
        callerSignal?.removeEventListener("abort", onAbort);
        work.subscribers = Math.max(0, work.subscribers - 1);
        if (cancelled && work.subscribers === 0 && !work.settled) {
          if (this.inFlight.get(key) === work) this.inFlight.delete(key);
          recordTimelineAbort(work.timeline);
          work.onAllCancelled();
          work.controller.abort();
          return true;
        }
        return false;
      };
      const onAbort = () => {
        const cancelledUnderlying = release(true);
        if (!cancelledUnderlying) {
          reject(new YouTubeTranscriptServiceError("aborted"));
          return;
        }
        void work.promise.then(
          () => reject(new YouTubeTranscriptServiceError("aborted")),
          (error: unknown) => reject(
            error instanceof Error
              ? error
              : new YouTubeTranscriptServiceError("aborted"),
          ),
        );
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
  expectedSource: YouTubeTranscriptProvider,
): void {
  if (
    transcript.videoId !== request.videoId ||
    !isValidYouTubeCaptionLanguageCode(transcript.languageCode) ||
    typeof transcript.languageName !== "string" ||
    !transcript.languageName.trim() ||
    transcript.languageName.length > 200 ||
    hasUnsafeControl(transcript.languageName) ||
    typeof transcript.isGenerated !== "boolean" ||
    transcript.provider !== expectedSource ||
    typeof transcript.text !== "string" ||
    !transcript.text.trim()
  ) {
    throw malformedProviderResponse(expectedSource);
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
    isValidYouTubeCaptionLanguageCode(content.languageCode) &&
    typeof content.languageName === "string" &&
    Boolean(content.languageName.trim()) &&
    (content.provider === "innertube" ||
      content.provider === "tikhub" ||
      content.provider === "yt-dlp") &&
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

function normalizeLocalError(
  error: unknown,
  state: ProviderChainState,
): YouTubeTranscriptServiceError {
  const normalized = normalizeProviderError(error);
  return new YouTubeTranscriptServiceError(
    normalized.code,
    normalized.primaryCode,
    normalized.failures.length > 0 ? normalized.failures : state.failures,
    freezeUsage(state.tikhubPaidRequests),
    normalized.tikhubPaidRequestPossiblySent ||
      state.tikhubPaidRequestPossiblySent,
  );
}

function providerStageError(error: unknown): TranscriptProviderStageError {
  if (error instanceof TranscriptProviderStageError) return error;
  return new TranscriptProviderStageError(normalizeProviderError(error));
}

function providerOperationStageError(
  error: unknown,
  source: YouTubeTranscriptProvider,
  state: ProviderChainState,
): TranscriptProviderStageError {
  if (source !== "tikhub") return providerStageError(error);
  if (
    error instanceof YouTubeTranscriptError &&
    error.operationEvidence !== undefined
  ) {
    applyOperationEvidence(state, error.operationEvidence, true);
    return providerStageError(error);
  }
  return new TranscriptProviderStageError(malformedProviderResponse(source));
}

function settleProviderOperation<T>(
  result: T | TranscriptProviderOperationResult<T>,
  source: YouTubeTranscriptProvider,
  allowPersistenceToken: boolean,
  state: ProviderChainState,
): { value: T; persistenceToken?: unknown } {
  const snapshot = snapshotTranscriptProviderOperationResult(result);
  if (!snapshot) {
    if (source === "tikhub") {
      throw new TranscriptProviderStageError(malformedProviderResponse(source));
    }
    return { value: result as T };
  }

  applyOperationEvidence(state, snapshot.evidence, false);
  const hasPersistenceToken = Object.prototype.hasOwnProperty.call(
    snapshot,
    "persistenceToken",
  );
  if (!allowPersistenceToken && hasPersistenceToken) {
    throw new TranscriptProviderStageError(malformedProviderResponse(source));
  }
  return {
    value: snapshot.value as T,
    ...(hasPersistenceToken
      ? { persistenceToken: snapshot.persistenceToken }
      : {}),
  };
}

function isProviderFallbackEligible(
  source: YouTubeTranscriptProvider,
  code: YouTubeTranscriptServiceErrorCode,
): boolean {
  if (code === "fallback-unavailable" || code === "aborted") return false;
  if (source === "tikhub") return code !== "tikhub-processing";
  return FALLBACK_ELIGIBLE.has(code);
}

function assertProviderTracks(
  value: unknown,
  expectedSource: YouTubeTranscriptProvider,
): asserts value is YouTubeCaptionTrack[] {
  if (
    !Array.isArray(value) ||
    !value.every((candidate) =>
      isValidProviderTrack(candidate, expectedSource)
    )
  ) {
    throw malformedProviderResponse(expectedSource);
  }
}

function assertProviderTrack(
  value: unknown,
  expectedSource: YouTubeTranscriptProvider,
): asserts value is YouTubeCaptionTrack {
  if (!isValidProviderTrack(value, expectedSource)) {
    throw malformedProviderResponse(expectedSource);
  }
}

function isValidProviderTrack(
  value: unknown,
  expectedSource: YouTubeTranscriptProvider,
): value is YouTubeCaptionTrack {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    isValidYouTubeCaptionLanguageCode(candidate.languageCode) &&
    typeof candidate.languageName === "string" &&
    Boolean(candidate.languageName.trim()) &&
    candidate.languageName.length <= 200 &&
    !hasUnsafeControl(candidate.languageName) &&
    typeof candidate.isGenerated === "boolean" &&
    candidate.source === expectedSource &&
    typeof candidate.url === "string" &&
    Boolean(candidate.url.trim()) &&
    !hasUnsafeControl(candidate.url) &&
    (expectedSource === "tikhub"
      ? candidate.format === "txt"
      : candidate.format === "json3" ||
        candidate.format === "srv3" ||
        candidate.format === "vtt")
  );
}

function providerChainFromOptions(
  options:
    | YouTubeTranscriptServiceOptions
    | LegacyYouTubeTranscriptServiceOptions,
): readonly TranscriptProviderRegistration[] {
  if ("providers" in options) return validateProviderChain(options.providers);
  return validateProviderChain([
    { source: "innertube", provider: options.innerTube },
    {
      source: "yt-dlp",
      provider: options.ytDlp,
      isAvailable: async () => await options.ytDlp.isAvailable(),
    },
  ]);
}

function validateProviderChain(
  providers: readonly TranscriptProviderRegistration[],
): readonly TranscriptProviderRegistration[] {
  if (providers.length === 0) {
    throw new Error("Invalid transcript provider chain");
  }
  const sources = new Set<YouTubeTranscriptProvider>();
  const validated = providers.map((registration) => {
    if (
      typeof registration !== "object" ||
      registration === null ||
      (registration.source !== "innertube" &&
        registration.source !== "tikhub" &&
        registration.source !== "yt-dlp") ||
      sources.has(registration.source) ||
      typeof registration.provider !== "object" ||
      registration.provider === null ||
      typeof registration.provider.listTracks !== "function" ||
      typeof registration.provider.fetchTrack !== "function" ||
      (registration.isAvailable !== undefined &&
        typeof registration.isAvailable !== "function")
    ) {
      throw new Error("Invalid transcript provider chain");
    }
    sources.add(registration.source);
    return Object.freeze({ ...registration });
  });
  return Object.freeze(validated);
}

function stageForSource(
  source: YouTubeTranscriptProvider,
): YouTubeTranscriptProgressStage {
  switch (source) {
    case "innertube":
      return "trying-innertube";
    case "tikhub":
      return "trying-tikhub";
    case "yt-dlp":
      return "trying-yt-dlp";
  }
}

function emitProgress(
  request: YouTubeTranscriptRequest,
  stage: YouTubeTranscriptProgressStage,
  state: ProviderChainState,
): void {
  if (!request.onProgress) return;
  const progress: YouTubeTranscriptProgress = Object.freeze({
    stage,
    usage: freezeUsage(state.tikhubPaidRequests),
  });
  try {
    request.onProgress(progress);
  } catch {
    // UI progress is advisory and cannot alter transcript retrieval.
  }
}

function applyOperationEvidence(
  state: ProviderChainState,
  evidence: TranscriptProviderOperationEvidence,
  failed: boolean,
): void {
  state.tikhubPaidRequests = Math.min(
    2,
    state.tikhubPaidRequests + evidence.tikhubPaidRequests,
  ) as 0 | 1 | 2;
  if (
    failed &&
    evidence.paidRequestAttempted &&
    evidence.tikhubPaidRequests === 0
  ) {
    state.tikhubPaidRequestPossiblySent = true;
  }
}

function addFailure(
  state: ProviderChainState,
  source: YouTubeTranscriptProvider,
  code: YouTubeTranscriptServiceErrorCode,
): void {
  state.failures.push({ source, code });
}

function chainFailure(
  state: ProviderChainState,
  preferredCode?: YouTubeTranscriptServiceErrorCode,
): YouTubeTranscriptServiceError {
  const failures = freezeFailures(state.failures);
  const firstMeaningful = failures.find(
    ({ code }) => code !== "fallback-unavailable",
  );
  const primaryCode = firstMeaningful?.code === "fallback-unavailable"
    ? undefined
    : firstMeaningful?.code;
  let code = preferredCode;

  if (!code) {
    const actionableTikHub = failures.find(
      (failure) =>
        failure.source === "tikhub" &&
        failure.code !== "fallback-unavailable" &&
        TIKHUB_ACTIONABLE.has(failure.code),
    );
    if (actionableTikHub) code = actionableTikHub.code;
  }
  if (!code) {
    const ambiguousTikHub = failures.find(
      (failure) =>
        failure.source === "tikhub" &&
        (failure.code === "temporarily-unavailable" ||
          failure.code === "timeout"),
    );
    if (ambiguousTikHub) code = ambiguousTikHub.code;
  }
  if (!code && preservesAuthoritativeNoCaptions(failures)) {
    code = "no-captions";
  }
  if (!code) {
    const last = failures[failures.length - 1];
    const lastMeaningful = [...failures].reverse().find(
      ({ code: candidate }) => candidate !== "fallback-unavailable",
    );
    code = last?.code === "fallback-unavailable"
      ? "fallback-unavailable"
      : lastMeaningful?.code ?? "fallback-unavailable";
  }

  return new YouTubeTranscriptServiceError(
    code,
    primaryCode,
    failures,
    freezeUsage(state.tikhubPaidRequests),
    state.tikhubPaidRequestPossiblySent,
  );
}

function preservesAuthoritativeNoCaptions(
  failures: readonly YouTubeTranscriptProviderFailure[],
): boolean {
  const firstMeaningful = failures.find(
    ({ code }) => code !== "fallback-unavailable",
  );
  return firstMeaningful?.code === "no-captions" && failures.every(
    ({ source, code }) =>
      code === "fallback-unavailable" ||
      code === "no-captions" ||
      (source !== "tikhub" &&
        NO_CAPTIONS_PRESERVABLE_FALLBACK_FAILURES.has(code)),
  );
}

function malformedProviderResponse(
  source: YouTubeTranscriptProvider,
): YouTubeTranscriptServiceError {
  return new YouTubeTranscriptServiceError(
    source === "tikhub"
      ? "tikhub-malformed-response"
      : "temporarily-unavailable",
  );
}

function freezeFailures(
  failures: readonly YouTubeTranscriptProviderFailure[],
): readonly YouTubeTranscriptProviderFailure[] {
  return Object.freeze(
    failures.map(({ source, code }) => Object.freeze({ source, code })),
  );
}

function freezeUsage(
  tikhubPaidRequests: 0 | 1 | 2,
): YouTubeTranscriptUsage {
  return Object.freeze({ tikhubPaidRequests });
}

let localOperationSequence = 0;
const OPERATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function beginTranscriptTimeline(
  journal: OperationJournalPort | undefined,
  request: { readonly itemId: string; readonly subjectLabel?: string },
): TranscriptOperationTimeline {
  let scope: OperationJournalScope | undefined;
  if (journal) {
    try {
      scope = journal.begin({
        category: "transcript",
        action: "retrieve",
        trigger: "manual",
        subject: {
          itemId: request.itemId,
          ...(request.subjectLabel === undefined
            ? {}
            : { label: request.subjectLabel }),
        },
        stage: "requested",
        details: { contentBasis: "youtube-transcript" },
      });
    } catch {
      // Operation history is optional and cannot alter transcript retrieval.
    }
  }
  const safeScope = isUsableJournalScope(scope)
    ? scope
    : createNoopJournalScope(createLocalOperationId());
  return {
    operationId: safeScope.operationId,
    scope: safeScope,
    stage: "requested",
    terminal: false,
  };
}

function isUsableJournalScope(
  scope: OperationJournalScope | undefined,
): scope is OperationJournalScope {
  try {
    return Boolean(
      scope &&
      OPERATION_ID.test(scope.operationId) &&
      typeof scope.progress === "function" &&
      typeof scope.succeed === "function" &&
      typeof scope.fail === "function" &&
      typeof scope.abort === "function",
    );
  } catch {
    return false;
  }
}

function createNoopJournalScope(operationId: string): OperationJournalScope {
  const resolved = (): Promise<void> => Promise.resolve();
  return Object.freeze({
    operationId,
    progress: resolved,
    succeed: resolved,
    fail: resolved,
    abort: resolved,
  });
}

function createLocalOperationId(): string {
  try {
    const operationId = globalThis.crypto.randomUUID();
    if (OPERATION_ID.test(operationId)) return operationId;
  } catch {
    // Fall through to a process-local valid correlation ID.
  }
  localOperationSequence = (localOperationSequence + 1) % 0xffffffffffff;
  return `00000000-0000-4000-8000-${localOperationSequence
    .toString(16)
    .padStart(12, "0")}`;
}

function recordTimelineProgress(
  timeline: TranscriptOperationTimeline,
  stage: OperationStage,
  details: OperationDetails,
): void {
  if (timeline.terminal) return;
  timeline.stage = stage;
  safelyRecord(() => timeline.scope.progress(stage, details));
}

function recordTimelineSuccess(
  timeline: TranscriptOperationTimeline,
  provider: "cache" | YouTubeTranscriptProvider,
): void {
  if (timeline.terminal) return;
  timeline.terminal = true;
  timeline.stage = "completed";
  safelyRecord(() =>
    timeline.scope.succeed("completed", {
      provider,
      contentBasis: "youtube-transcript",
    }),
  );
}

function recordProviderFailure(
  timeline: TranscriptOperationTimeline,
  provider: YouTubeTranscriptProvider,
  code: YouTubeTranscriptServiceErrorCode,
): void {
  recordTimelineProgress(timeline, "trying-provider", {
    provider,
    errorCode: operationErrorCode(code),
  });
}

function recordTimelineFailure(
  timeline: TranscriptOperationTimeline,
  error: unknown,
): void {
  if (timeline.terminal) return;
  const serviceError = normalizeProviderError(error);
  if (serviceError.code === "aborted") {
    recordTimelineAbort(timeline);
    return;
  }
  timeline.terminal = true;
  const errorCode =
    timeline.stage === "saving"
      ? "cache-save-failed"
      : operationErrorCode(serviceError.code);
  safelyRecord(() => timeline.scope.fail(timeline.stage, errorCode));
}

function recordTimelineAbort(timeline: TranscriptOperationTimeline): void {
  if (timeline.terminal) return;
  timeline.terminal = true;
  safelyRecord(() => timeline.scope.abort(timeline.stage));
}

function safelyRecord(operation: () => Promise<void>): void {
  try {
    void operation().catch(() => undefined);
  } catch {
    // Operation history is optional and cannot alter transcript retrieval.
  }
}

function operationErrorCode(
  code: YouTubeTranscriptServiceErrorCode,
): OperationErrorCode {
  switch (code) {
    case "invalid-video-id":
      return "invalid-request";
    case "no-captions":
      return "no-transcript";
    case "timeout":
      return "timeout";
    case "tikhub-missing-key":
      return "missing-key";
    case "tikhub-invalid-key":
      return "invalid-key";
    case "tikhub-insufficient-balance":
      return "insufficient-balance";
    case "tikhub-budget-unavailable":
      return "budget-exhausted";
    case "tikhub-rate-limited":
      return "rate-limited";
    case "tikhub-malformed-response":
      return "malformed-response";
    case "aborted":
      return "aborted";
    case "video-unavailable":
    case "login-required":
    case "temporarily-unavailable":
    case "tikhub-processing":
    case "tikhub-job-expired":
    case "fallback-unavailable":
      return "transcript-unavailable";
  }
}

function providerOperationContext(
  identity: Pick<TranscriptProviderOperationContext, "itemId" | "videoId">,
  operationId: string,
): TranscriptProviderOperationContext {
  return Object.freeze({
    itemId: identity.itemId,
    videoId: identity.videoId,
    operationId,
  });
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
