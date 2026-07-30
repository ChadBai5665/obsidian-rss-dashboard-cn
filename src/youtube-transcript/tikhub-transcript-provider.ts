import { isCanonicalConnectionId } from "../security/connection-id";
import type {
  OperationIdentityInput,
  OperationJournalPort,
  OperationJournalScope,
} from "../operation-journal/operation-journal-service";
import type {
  OperationDetails,
  OperationErrorCode,
  OperationStage,
} from "../operation-journal/operation-event";
import { TikHubRequestBudgetError } from "../sources/tikhub/request-budget";
import { TikHubRequestLedgerError } from "../sources/tikhub/request-ledger";
import {
  TikHubClientError,
  type TikHubYouTubeCaptionRequest,
  type TikHubYouTubeCaptionResultRequest,
} from "../sources/tikhub/tikhub-client";
import {
  InvalidTikHubCaptionResponseError,
  parseTikHubCaptionResponse,
} from "../sources/tikhub/youtube-caption-response";
import {
  normalizeTikHubBaseUrl,
  type TikHubCaptionResponse,
  type TikHubCaptionTrack,
  type TikHubResult,
} from "../sources/tikhub/tikhub-types";
import type { TikHubSettings } from "../types/types";
import type { OptionalTranscriptProvider } from "./youtube-transcript-service";
import {
  captionJobKey,
  TikHubCaptionJobAmbiguityError,
  type TikHubCaptionJobIdentity,
  type TikHubCaptionJobRecord,
} from "./tikhub-caption-job-repository";
import { isValidYouTubeCaptionLanguageCode } from "./youtube-caption-language-code";
import {
  assertYouTubeVideoId,
  createTranscriptProviderOperationResult,
  YouTubeTranscriptError,
  type TranscriptProviderOperationEvidence,
  type TranscriptProviderOperationContext,
  type TranscriptProviderContinuationIdentity,
  type TranscriptProviderOperationResult,
  type YouTubeCaptionTrack,
  type YouTubeTranscript,
  type YouTubeTranscriptErrorCode,
} from "./transcript-types";

export interface TikHubCaptionClient {
  fetchYouTubeCaptions(
    input: TikHubYouTubeCaptionRequest,
  ): Promise<TikHubResult<unknown>>;
  fetchYouTubeCaptionResult(
    input: TikHubYouTubeCaptionResultRequest,
  ): Promise<TikHubResult<unknown>>;
}

export interface TikHubCaptionJobStore {
  read(key: string): Promise<TikHubCaptionJobRecord | null>;
  findPendingContentJob(
    itemId: string,
    videoId: string,
  ): Promise<TikHubCaptionJobRecord | null>;
  createIfAbsent(record: TikHubCaptionJobRecord): Promise<boolean>;
  replaceIfCurrent(
    identity: TikHubCaptionJobIdentity,
    replacement: TikHubCaptionJobRecord,
  ): Promise<boolean>;
  removeIfCurrent(identity: TikHubCaptionJobIdentity): Promise<boolean>;
}

export interface TikHubTranscriptProviderOptions {
  getSettings: () => TikHubSettings;
  getApiKey: (connectionId: string) => Promise<string | undefined>;
  createClient: (settings: TikHubSettings) => TikHubCaptionClient;
  jobs: TikHubCaptionJobStore;
  clock: () => Date;
  delay: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  pollIntervalMs?: number;
  maxPolls?: number;
  operationJournal?: OperationJournalPort;
}

type CaptionStage = "tracks" | "content";

interface OperationIdentity {
  itemId: string;
  videoId: string;
  operationId: string;
}

interface CurrentSession {
  connectionId: string;
  apiKey: string;
  client: TikHubCaptionClient;
}

interface LocatorProjection {
  videoId: string;
  languageCode: string;
  languageName: string;
  isGenerated: boolean;
  format: "txt";
}

interface StageOperationResult {
  response: TikHubCaptionResponse;
  evidence: TranscriptProviderOperationEvidence;
  completedJob?: TikHubCaptionJobRecord;
}

const ITEM_ID = /^[a-f0-9]{64}$/u;
const JOB_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const OPERATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const LOCATOR_PREFIX = "tikhub:";
const MAX_LANGUAGE_NAME_LENGTH = 200;
const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_MAX_POLLS = 10;
const FREE_OPERATION_EVIDENCE: TranscriptProviderOperationEvidence =
  Object.freeze({
    tikhubPaidRequests: 0,
    paidRequestAttempted: false,
  });
const PAID_OPERATION_EVIDENCE: TranscriptProviderOperationEvidence =
  Object.freeze({
    tikhubPaidRequests: 1,
    paidRequestAttempted: true,
  });
const ATTEMPTED_OPERATION_EVIDENCE: TranscriptProviderOperationEvidence =
  Object.freeze({
    tikhubPaidRequests: 0,
    paidRequestAttempted: true,
  });
const TRACK_JOB_FIELDS = [
  "schemaVersion",
  "itemId",
  "videoId",
  "stage",
  "format",
  "jobId",
  "connectionId",
  "createdAt",
  "lastCheckedAt",
  "status",
] as const;
const CONTENT_JOB_FIELDS = [
  "schemaVersion",
  "itemId",
  "videoId",
  "stage",
  "languageCode",
  "format",
  "jobId",
  "connectionId",
  "createdAt",
  "lastCheckedAt",
  "status",
] as const;
const TRACK_JOB_V2_FIELDS = [...TRACK_JOB_FIELDS, "operationId"] as const;
const CONTENT_JOB_V2_FIELDS = [...CONTENT_JOB_FIELDS, "operationId"] as const;
const LOCATOR_FIELDS = [
  "videoId",
  "languageCode",
  "languageName",
  "isGenerated",
  "format",
] as const;

/**
 * Explicit-only TikHub transcript adapter. It retains callbacks and durable job
 * identities, but never retains a resolved API key, client, provider payload,
 * or credential-bearing URL between operations.
 */
export class TikHubTranscriptProvider implements OptionalTranscriptProvider {
  private readonly pollIntervalMs: number;
  private readonly maxPolls: number;

  constructor(private readonly options: TikHubTranscriptProviderOptions) {
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxPolls = options.maxPolls ?? DEFAULT_MAX_POLLS;
    if (
      this.pollIntervalMs !== DEFAULT_POLL_INTERVAL_MS ||
      this.maxPolls !== DEFAULT_MAX_POLLS
    ) {
      throw new Error("TikHub caption polling must use the fixed safe bounds.");
    }
  }

  async isAvailable(): Promise<boolean> {
    const settings = this.readRawSettings();
    return ownData(settings, "enabled") === true &&
      ownData(settings, "youtubeTranscriptFallbackEnabled") === true;
  }

  async listTracks(
    requestedVideoId: string,
    signal: AbortSignal | undefined,
    context: TranscriptProviderOperationContext,
  ): Promise<TranscriptProviderOperationResult<YouTubeCaptionTrack[]>> {
    const identity = operationIdentity(requestedVideoId, context);
    assertNotAborted(signal);
    if (await this.pendingContentJob(identity)) {
      throw stableError("tikhub-processing");
    }
    const session = await this.currentSession(signal);
    const operation = await this.runStage(
      "tracks",
      identity,
      undefined,
      session,
      signal,
    );
    const { response, evidence } = operation;
    if (response.kind === "no-captions") {
      return createTranscriptProviderOperationResult([], evidence);
    }
    if (response.kind !== "tracks") {
      throw stableError("tikhub-malformed-response", evidence);
    }
    return createTranscriptProviderOperationResult(
      response.tracks.map((track) => createTrack(identity.videoId, track, evidence)),
      evidence,
    );
  }

  async hasPendingContinuation(
    context: TranscriptProviderOperationContext,
  ): Promise<boolean> {
    const identity = operationIdentity(context.videoId, context);
    return (await this.pendingContentJob(identity)) !== null;
  }

  async pendingContinuationOperationId(
    continuationIdentity: TranscriptProviderContinuationIdentity,
  ): Promise<string | undefined> {
    const identity = continuationOperationIdentity(continuationIdentity);
    const job = await this.pendingContentJob(identity);
    if (!job) return undefined;
    if (job.schemaVersion === 2) return job.operationId;

    const scope = beginContinuationScope(
      this.options.operationJournal,
      identity.itemId,
    );
    if (!scope) return undefined;
    const key = safeJobKey(identity, "content", job.languageCode);
    const upgraded: TikHubCaptionJobRecord = {
      ...job,
      schemaVersion: 2,
      operationId: scope.operationId,
    };
    let replaced: boolean;
    try {
      replaced = await this.options.jobs.replaceIfCurrent(
        jobIdentity(key, job),
        upgraded,
      );
    } catch {
      return undefined;
    }
    return replaced ? scope.operationId : undefined;
  }

  async continuePending(
    signal: AbortSignal | undefined,
    context: TranscriptProviderOperationContext,
  ): Promise<TranscriptProviderOperationResult<{
    track: YouTubeCaptionTrack;
    transcript: YouTubeTranscript;
  }>> {
    const identity = operationIdentity(context.videoId, context);
    assertNotAborted(signal);
    const job = await this.pendingContentJob(identity);
    if (!job || job.languageCode === undefined) {
      throw stableError("tikhub-job-expired");
    }
    const session = await this.currentSession(signal);
    if (session.connectionId !== job.connectionId) {
      throw stableError("tikhub-job-expired");
    }
    const resumedJob = await this.ensureOperationIdentity(
      job,
      identity.operationId,
    );
    const key = safeJobKey(identity, "content", job.languageCode);
    const journal = attachOperationScope(
      this.options.operationJournal,
      resumedJob.schemaVersion === 2
        ? resumedJob.operationId
        : identity.operationId,
      identity.itemId,
    );
    recordProgress(journal, "job-received", {
      provider: "tikhub",
      confirmedPaidRequests: 0,
      possiblySent: false,
      jobId: resumedJob.jobId,
    });
    const operation = await this.pollJob(
      key,
      resumedJob,
      "content",
      session,
      signal,
      FREE_OPERATION_EVIDENCE,
      journal,
    );
    if (operation.response.kind !== "content") {
      throw stableError("tikhub-malformed-response", operation.evidence);
    }
    const response = operation.response;
    const track = createTrack(identity.videoId, {
      languageCode: response.languageCode,
      languageName: response.languageName,
      isGenerated: response.isGenerated,
    }, operation.evidence);
    const transcript: YouTubeTranscript = {
      videoId: identity.videoId,
      languageCode: response.languageCode,
      languageName: response.languageName,
      isGenerated: response.isGenerated,
      provider: "tikhub",
      text: response.text,
    };
    if (!operation.completedJob) {
      throw stableError("tikhub-malformed-response", operation.evidence);
    }
    return createTranscriptProviderOperationResult(
      { track, transcript },
      operation.evidence,
      persistenceToken(key, operation.completedJob),
    );
  }

  async fetchTrack(
    track: YouTubeCaptionTrack,
    signal: AbortSignal | undefined,
    context: TranscriptProviderOperationContext,
  ): Promise<TranscriptProviderOperationResult<YouTubeTranscript>> {
    const locator = parseLocator(track);
    const identity = operationIdentity(locator.videoId, context);
    assertNotAborted(signal);
    const session = await this.currentSession(signal);
    const operation = await this.runStage(
      "content",
      identity,
      locator.languageCode,
      session,
      signal,
    );
    const { response, evidence } = operation;
    if (response.kind === "no-captions") throw stableError("no-captions", evidence);
    if (
      response.kind !== "content" ||
      response.languageCode !== locator.languageCode ||
      response.languageName !== locator.languageName ||
      response.isGenerated !== locator.isGenerated
    ) {
      throw stableError("tikhub-malformed-response", evidence);
    }
    const transcript: YouTubeTranscript = {
      videoId: identity.videoId,
      languageCode: response.languageCode,
      languageName: response.languageName,
      isGenerated: response.isGenerated,
      provider: "tikhub",
      text: response.text,
    };
    if (!operation.completedJob) {
      return createTranscriptProviderOperationResult(transcript, evidence);
    }
    const key = safeJobKey(identity, "content", locator.languageCode);
    return createTranscriptProviderOperationResult(
      transcript,
      evidence,
      persistenceToken(key, operation.completedJob),
    );
  }

  async onPersisted(
    track: YouTubeCaptionTrack,
    transcript: YouTubeTranscript,
    context: TranscriptProviderOperationContext,
    persistenceTokenValue?: unknown,
  ): Promise<void> {
    if (persistenceTokenValue === undefined) return;
    const locator = parseLocator(track);
    const identity = operationIdentity(locator.videoId, context);
    if (!isMatchingTranscript(transcript, identity, locator)) {
      throw stableError("tikhub-malformed-response");
    }
    const expectedKey = safeJobKey(
      identity,
      "content",
      locator.languageCode,
    );
    const cleanupIdentity = parsePersistenceToken(
      persistenceTokenValue,
      expectedKey,
    );
    try {
      const removed = await this.options.jobs.removeIfCurrent(cleanupIdentity);
      if (removed) {
        recordProgress(
          attachOperationScope(
            this.options.operationJournal,
            context.operationId,
            identity.itemId,
          ),
          "completed",
          { provider: "tikhub", contentBasis: "youtube-transcript" },
        );
      }
    } catch {
      throw stableError("tikhub-budget-unavailable");
    }
  }

  private async runStage(
    stage: CaptionStage,
    identity: OperationIdentity,
    languageCode: string | undefined,
    session: CurrentSession,
    signal: AbortSignal | undefined,
  ): Promise<StageOperationResult> {
    const key = safeJobKey(identity, stage, languageCode);
    let currentJob: TikHubCaptionJobRecord | null;
    try {
      currentJob = await this.options.jobs.read(key);
    } catch {
      throw stableError("tikhub-budget-unavailable");
    }
    assertNotAborted(signal);

    if (currentJob !== null) {
      if (!isExpectedJob(
        currentJob,
        identity,
        stage,
        languageCode,
        session.connectionId,
      )) {
        return await this.expireJob(
          key,
          currentJob,
          FREE_OPERATION_EVIDENCE,
        );
      }
      const journal = attachOperationScope(
        this.options.operationJournal,
        currentJob.schemaVersion === 2
          ? currentJob.operationId
          : identity.operationId,
        identity.itemId,
      );
      recordProgress(journal, "job-received", {
        provider: "tikhub",
        confirmedPaidRequests: 0,
        possiblySent: false,
        jobId: currentJob.jobId,
      });
      return await this.pollJob(
        key,
        currentJob,
        stage,
        session,
        signal,
        FREE_OPERATION_EVIDENCE,
        journal,
        identity.operationId,
      );
    }

    const journal = attachOperationScope(
      this.options.operationJournal,
      identity.operationId,
      identity.itemId,
    );
    recordProgress(journal, "tikhub-request", {
      provider: "tikhub",
      confirmedPaidRequests: 0,
      possiblySent: false,
    });
    let result: TikHubResult<unknown>;
    try {
      result = stage === "tracks"
        ? await session.client.fetchYouTubeCaptions({
            apiKey: session.apiKey,
            videoId: identity.videoId,
            signal,
          })
        : await session.client.fetchYouTubeCaptions({
            apiKey: session.apiKey,
            videoId: identity.videoId,
            languageCode,
            format: "txt",
            signal,
          });
    } catch (error) {
      const normalized = normalizeFailure(
        error,
        false,
        signal,
        FREE_OPERATION_EVIDENCE,
        true,
      );
      const possiblySent = normalized.operationEvidence?.paidRequestAttempted === true;
      recordFailure(journal, "tikhub-request", normalized.code, {
        provider: "tikhub",
        confirmedPaidRequests: possiblySent ? 1 : 0,
        possiblySent,
      });
      throw normalized;
    }
    recordProgress(journal, "tikhub-request", {
      provider: "tikhub",
      confirmedPaidRequests: 1,
      possiblySent: true,
    });
    let response: TikHubCaptionResponse;
    try {
      assertNotAborted(signal, PAID_OPERATION_EVIDENCE);
      response = parseResponse(
        resultData(result, PAID_OPERATION_EVIDENCE),
        identity.videoId,
        PAID_OPERATION_EVIDENCE,
      );
      if (response.kind !== "processing") {
        if (response.kind === "pending") {
          throw stableError("tikhub-malformed-response", PAID_OPERATION_EVIDENCE);
        }
        assertTerminalStage(response, stage, PAID_OPERATION_EVIDENCE);
      }
    } catch (error) {
      const normalized = normalizeFailure(
        error,
        false,
        signal,
        PAID_OPERATION_EVIDENCE,
      );
      recordFailure(journal, "tikhub-request", normalized.code, {
        provider: "tikhub",
        confirmedPaidRequests: 1,
        possiblySent: true,
      });
      throw normalized;
    }
    if (response.kind !== "processing") {
      return { response, evidence: PAID_OPERATION_EVIDENCE };
    }

    const timestamp = safeTimestamp(
      this.options.clock,
      PAID_OPERATION_EVIDENCE,
    );
    const record: TikHubCaptionJobRecord = {
      schemaVersion: 2,
      operationId: identity.operationId,
      itemId: identity.itemId,
      videoId: identity.videoId,
      stage,
      ...(stage === "content" ? { languageCode } : {}),
      format: "txt",
      jobId: response.jobId,
      connectionId: session.connectionId,
      createdAt: timestamp,
      lastCheckedAt: timestamp,
      status: "processing",
    };
    let created: boolean;
    try {
      created = await this.options.jobs.createIfAbsent(record);
    } catch {
      recordFailure(journal, "job-received", "tikhub-budget-unavailable", {
        provider: "tikhub",
        confirmedPaidRequests: 1,
        possiblySent: true,
        jobId: record.jobId,
      });
      throw stableError("tikhub-budget-unavailable", PAID_OPERATION_EVIDENCE);
    }
    if (!created) {
      recordFailure(journal, "job-received", "tikhub-processing", {
        provider: "tikhub",
        confirmedPaidRequests: 1,
        possiblySent: true,
        jobId: record.jobId,
      });
      throw stableError("tikhub-processing", PAID_OPERATION_EVIDENCE);
    }
    recordProgress(journal, "job-received", {
      provider: "tikhub",
      confirmedPaidRequests: 1,
      possiblySent: true,
      jobId: record.jobId,
    });
    assertNotAborted(signal, PAID_OPERATION_EVIDENCE);
    return await this.pollJob(
      key,
      record,
      stage,
      session,
      signal,
      PAID_OPERATION_EVIDENCE,
      journal,
    );
  }

  private async ensureOperationIdentity(
    job: TikHubCaptionJobRecord,
    operationId: string,
  ): Promise<TikHubCaptionJobRecord> {
    if (job.schemaVersion === 2) return job;
    const key = safeJobKey(job, job.stage, job.languageCode);
    const upgraded: TikHubCaptionJobRecord = {
      ...job,
      schemaVersion: 2,
      operationId,
    };
    let replaced: boolean;
    try {
      replaced = await this.options.jobs.replaceIfCurrent(
        jobIdentity(key, job),
        upgraded,
      );
    } catch {
      throw stableError("tikhub-budget-unavailable");
    }
    if (!replaced) throw stableError("tikhub-job-expired");
    return upgraded;
  }

  private async pendingContentJob(
    identity: Pick<OperationIdentity, "itemId" | "videoId">,
  ): Promise<TikHubCaptionJobRecord | null> {
    let job: TikHubCaptionJobRecord | null;
    try {
      job = await this.options.jobs.findPendingContentJob(
        identity.itemId,
        identity.videoId,
      );
    } catch (error) {
      throw stableError(
        error instanceof TikHubCaptionJobAmbiguityError
          ? "tikhub-job-expired"
          : "tikhub-budget-unavailable",
      );
    }
    if (job === null) return null;
    const settings = this.currentSettings();
    if (
      !settings.enabled ||
      !settings.youtubeTranscriptFallbackEnabled ||
      job.languageCode === undefined ||
      !isExpectedJob(
        job,
        identity,
        "content",
        job.languageCode,
        settings.connectionId,
      )
    ) {
      throw stableError("tikhub-job-expired");
    }
    return job;
  }

  private async pollJob(
    key: string,
    initialJob: TikHubCaptionJobRecord,
    stage: CaptionStage,
    session: CurrentSession,
    signal: AbortSignal | undefined,
    evidence: TranscriptProviderOperationEvidence,
    journal?: OperationJournalScope,
    operationId?: string,
  ): Promise<StageOperationResult> {
    let job = { ...initialJob };
    for (let attempt = 0; attempt < this.maxPolls; attempt += 1) {
      assertNotAborted(signal, evidence);
      const pollNumber = attempt + 1;
      try {
        await this.options.delay(this.pollIntervalMs, signal);
      } catch (error) {
        throw normalizeFailure(error, false, signal, evidence);
      }
      assertNotAborted(signal, evidence);
      recordProgress(journal, "polling", {
        provider: "tikhub",
        jobId: job.jobId,
        pollNumber,
        elapsedMs: elapsedSince(job.createdAt, this.options.clock),
      });

      let result: TikHubResult<unknown>;
      try {
        result = await session.client.fetchYouTubeCaptionResult({
          apiKey: session.apiKey,
          jobId: job.jobId,
          format: "txt",
          signal,
        });
      } catch (error) {
        if (!signal?.aborted && isExpiredJobFailure(error)) {
          return await this.expireJob(key, job, evidence);
        }
        const normalized = normalizeFailure(error, true, signal, evidence);
        recordFailure(journal, "polling", normalized.code, {
          provider: "tikhub",
          confirmedPaidRequests: evidence.tikhubPaidRequests,
          possiblySent: evidence.paidRequestAttempted,
          jobId: job.jobId,
          pollNumber,
          elapsedMs: elapsedSince(job.createdAt, this.options.clock),
        });
        throw normalized;
      }
      assertNotAborted(signal, evidence);
      const data = resultData(result, evidence);
      assertResultJobId(data, job.jobId, evidence);
      const response = parseResponse(data, job.videoId, evidence);
      if (response.kind === "pending" || response.kind === "processing") {
        if (response.jobId !== job.jobId) {
          throw stableError("tikhub-malformed-response", evidence);
        }
        const replacement: TikHubCaptionJobRecord = job.schemaVersion === 2
          ? {
              ...job,
              lastCheckedAt: safeTimestamp(this.options.clock, evidence),
            }
          : {
              ...job,
              schemaVersion: 2,
              operationId: operationId ?? journal?.operationId ?? "",
              lastCheckedAt: safeTimestamp(this.options.clock, evidence),
            };
        let replaced: boolean;
        try {
          replaced = await this.options.jobs.replaceIfCurrent(
            jobIdentity(key, job),
            replacement,
          );
        } catch {
          throw stableError("tikhub-budget-unavailable", evidence);
        }
        if (!replaced) {
          throw stableError("tikhub-job-expired", evidence);
        }
        job = replacement;
        continue;
      }
      assertTerminalStage(response, stage, evidence);
      return { response, evidence, completedJob: job };
    }
    recordFailure(journal, "polling", "tikhub-processing", {
      provider: "tikhub",
      confirmedPaidRequests: evidence.tikhubPaidRequests,
      possiblySent: evidence.paidRequestAttempted,
      jobId: job.jobId,
      pollNumber: this.maxPolls,
      elapsedMs: elapsedSince(job.createdAt, this.options.clock),
    });
    throw stableError("tikhub-processing", evidence);
  }

  private async expireJob(
    key: string,
    job: TikHubCaptionJobRecord,
    evidence: TranscriptProviderOperationEvidence,
  ): Promise<never> {
    try {
      await this.options.jobs.removeIfCurrent(jobIdentity(key, job));
    } catch {
      throw stableError("tikhub-budget-unavailable", evidence);
    }
    throw stableError("tikhub-job-expired", evidence);
  }

  private async currentSession(
    signal: AbortSignal | undefined,
  ): Promise<CurrentSession> {
    const settings = this.currentSettings();
    if (!settings.enabled || !settings.youtubeTranscriptFallbackEnabled) {
      throw stableError("temporarily-unavailable");
    }
    if (!isCanonicalConnectionId(settings.connectionId)) {
      throw stableError("tikhub-missing-key");
    }
    assertNotAborted(signal);
    let resolvedKey: string | undefined;
    try {
      resolvedKey = await this.options.getApiKey(settings.connectionId);
    } catch {
      throw stableError("tikhub-missing-key");
    }
    assertNotAborted(signal);
    const apiKey = typeof resolvedKey === "string" ? resolvedKey.trim() : "";
    if (!apiKey) throw stableError("tikhub-missing-key");
    let client: TikHubCaptionClient;
    try {
      client = this.options.createClient(settings);
    } catch (error) {
      throw normalizeFailure(error, false, signal);
    }
    return {
      connectionId: settings.connectionId,
      apiKey,
      client,
    };
  }

  private currentSettings(): TikHubSettings {
    const raw = this.readRawSettings();
    const enabled = ownData(raw, "enabled");
    const youtubeTranscriptFallbackEnabled = ownData(
      raw,
      "youtubeTranscriptFallbackEnabled",
    );
    const connectionId = ownData(raw, "connectionId");
    const baseUrl = normalizeTikHubBaseUrl(ownData(raw, "baseUrl"));
    const timeoutMs = ownData(raw, "timeoutMs");
    const maxRequestsPerRun = ownData(raw, "maxRequestsPerRun");
    const maxRequestsPerDay = ownData(raw, "maxRequestsPerDay");
    if (
      typeof enabled !== "boolean" ||
      typeof youtubeTranscriptFallbackEnabled !== "boolean" ||
      typeof connectionId !== "string" ||
      !baseUrl ||
      !positiveInteger(timeoutMs)
    ) {
      throw stableError("tikhub-malformed-response");
    }
    if (!positiveInteger(maxRequestsPerRun) || !positiveInteger(maxRequestsPerDay)) {
      throw stableError("tikhub-budget-unavailable");
    }
    return {
      enabled,
      youtubeTranscriptFallbackEnabled,
      connectionId,
      baseUrl,
      timeoutMs,
      maxRequestsPerRun,
      maxRequestsPerDay,
    };
  }

  private readRawSettings(): Record<string, unknown> {
    let value: unknown;
    try {
      value = this.options.getSettings();
    } catch {
      throw stableError("tikhub-malformed-response");
    }
    if (!plainRecord(value)) throw stableError("tikhub-malformed-response");
    return value;
  }
}

function operationIdentity(
  requestedVideoId: string,
  context: TranscriptProviderOperationContext,
): OperationIdentity {
  let videoId: string;
  try {
    videoId = assertYouTubeVideoId(requestedVideoId);
  } catch (error) {
    if (error instanceof YouTubeTranscriptError) {
      throw stableError(error.code);
    }
    throw stableError("invalid-video-id");
  }
  try {
    if (
      !plainRecord(context) ||
      !hasExactKeys(context, ["itemId", "videoId", "operationId"])
    ) {
      throw new Error("invalid operation context");
    }
    const contextVideoId = ownData(context, "videoId");
    const itemId = ownData(context, "itemId");
    const operationId = ownData(context, "operationId");
    if (
      contextVideoId !== videoId ||
      typeof itemId !== "string" ||
      !ITEM_ID.test(itemId) ||
      typeof operationId !== "string" ||
      !OPERATION_ID.test(operationId)
    ) {
      throw new Error("invalid operation context");
    }
    return {
      itemId,
      videoId,
      operationId,
    };
  } catch {
    throw stableError("tikhub-malformed-response");
  }
}

function continuationOperationIdentity(
  value: TranscriptProviderContinuationIdentity,
): Pick<OperationIdentity, "itemId" | "videoId"> {
  try {
    if (
      !plainRecord(value) ||
      !hasExactKeys(value, ["itemId", "videoId"])
    ) {
      throw new Error("invalid continuation identity");
    }
    const itemId = ownData(value, "itemId");
    const videoId = ownData(value, "videoId");
    if (
      typeof itemId !== "string" ||
      !ITEM_ID.test(itemId) ||
      typeof videoId !== "string" ||
      assertYouTubeVideoId(videoId) !== videoId
    ) {
      throw new Error("invalid continuation identity");
    }
    return { itemId, videoId };
  } catch {
    throw stableError("tikhub-malformed-response");
  }
}

function journalIdentity(itemId: string): OperationIdentityInput {
  return {
    category: "transcript",
    action: "retrieve",
    trigger: "manual",
    subject: { itemId },
  };
}

function beginContinuationScope(
  journal: OperationJournalPort | undefined,
  itemId: string,
): OperationJournalScope | undefined {
  if (!journal) return undefined;
  try {
    const scope = journal.begin({
      ...journalIdentity(itemId),
      stage: "trying-provider",
      details: { provider: "tikhub" },
    });
    return usableScope(scope) ? scope : undefined;
  } catch {
    return undefined;
  }
}

function attachOperationScope(
  journal: OperationJournalPort | undefined,
  operationId: string,
  itemId: string,
): OperationJournalScope | undefined {
  if (!journal || !OPERATION_ID.test(operationId)) return undefined;
  try {
    const scope = journal.attach(operationId, journalIdentity(itemId));
    return usableScope(scope) && scope.operationId === operationId
      ? scope
      : undefined;
  } catch {
    return undefined;
  }
}

function usableScope(value: unknown): value is OperationJournalScope {
  try {
    if (!plainRecord(value)) return false;
    const operationId = ownData(value, "operationId");
    return typeof operationId === "string" &&
      OPERATION_ID.test(operationId) &&
      typeof ownData(value, "progress") === "function" &&
      typeof ownData(value, "succeed") === "function" &&
      typeof ownData(value, "fail") === "function" &&
      typeof ownData(value, "abort") === "function";
  } catch {
    return false;
  }
}

function recordProgress(
  scope: OperationJournalScope | undefined,
  stage: OperationStage,
  details: OperationDetails,
): void {
  safelyRecord(() => scope?.progress(stage, details));
}

function recordFailure(
  scope: OperationJournalScope | undefined,
  stage: OperationStage,
  code: YouTubeTranscriptErrorCode,
  details: OperationDetails,
): void {
  safelyRecord(() => scope?.fail(stage, journalErrorCode(code), details));
}

function safelyRecord(operation: () => Promise<void> | undefined): void {
  try {
    void operation()?.catch(() => undefined);
  } catch {
    // Operation history is optional and cannot alter transcript retrieval.
  }
}

function journalErrorCode(code: YouTubeTranscriptErrorCode): OperationErrorCode {
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
      return "transcript-unavailable";
  }
}

function elapsedSince(createdAt: string, clock: () => Date): number {
  try {
    const now = clock();
    const started = Date.parse(createdAt);
    if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || !Number.isFinite(started)) {
      return 0;
    }
    return Math.max(0, Math.floor(now.getTime() - started));
  } catch {
    return 0;
  }
}

function createTrack(
  videoId: string,
  track: TikHubCaptionTrack,
  evidence: TranscriptProviderOperationEvidence,
): YouTubeCaptionTrack {
  if (
    !isValidYouTubeCaptionLanguageCode(track.languageCode) ||
    !safeLanguageName(track.languageName) ||
    typeof track.isGenerated !== "boolean"
  ) {
    throw stableError("tikhub-malformed-response", evidence);
  }
  const locator: LocatorProjection = {
    videoId,
    languageCode: track.languageCode,
    languageName: track.languageName,
    isGenerated: track.isGenerated,
    format: "txt",
  };
  return Object.freeze({
    languageCode: locator.languageCode,
    languageName: locator.languageName,
    isGenerated: locator.isGenerated,
    source: "tikhub" as const,
    url: `${LOCATOR_PREFIX}${encodeURIComponent(JSON.stringify(locator))}`,
    format: "txt" as const,
  });
}

function parseLocator(track: YouTubeCaptionTrack): LocatorProjection {
  try {
    if (!plainRecord(track)) throw new Error("invalid track");
    const trackKeys = Reflect.ownKeys(track);
    const expectedTrackKeys = [
      "languageCode",
      "languageName",
      "isGenerated",
      "source",
      "url",
      "format",
    ];
    if (
      trackKeys.length !== expectedTrackKeys.length ||
      trackKeys.some((key) =>
        typeof key !== "string" || !expectedTrackKeys.includes(key)
      ) ||
      ownData(track, "source") !== "tikhub" ||
      ownData(track, "format") !== "txt"
    ) {
      throw new Error("invalid track");
    }
    const url = ownData(track, "url");
    if (typeof url !== "string" || !url.startsWith(LOCATOR_PREFIX)) {
      throw new Error("invalid locator");
    }
    const decoded: unknown = JSON.parse(
      decodeURIComponent(url.slice(LOCATOR_PREFIX.length)),
    );
    if (!plainRecord(decoded) || !hasExactKeys(decoded, LOCATOR_FIELDS)) {
      throw new Error("invalid locator");
    }
    const videoId = ownData(decoded, "videoId");
    const languageCode = ownData(decoded, "languageCode");
    const languageName = ownData(decoded, "languageName");
    const isGenerated = ownData(decoded, "isGenerated");
    if (
      typeof videoId !== "string" ||
      assertYouTubeVideoId(videoId) !== videoId ||
      typeof languageCode !== "string" ||
      !isValidYouTubeCaptionLanguageCode(languageCode) ||
      typeof languageName !== "string" ||
      !safeLanguageName(languageName) ||
      typeof isGenerated !== "boolean" ||
      ownData(decoded, "format") !== "txt" ||
      ownData(track, "languageCode") !== languageCode ||
      ownData(track, "languageName") !== languageName ||
      ownData(track, "isGenerated") !== isGenerated
    ) {
      throw new Error("invalid locator");
    }
    return {
      videoId,
      languageCode,
      languageName,
      isGenerated,
      format: "txt",
    };
  } catch {
    throw stableError("tikhub-malformed-response");
  }
}

function safeJobKey(
  identity: Pick<OperationIdentity, "itemId" | "videoId">,
  stage: CaptionStage,
  languageCode: string | undefined,
): string {
  try {
    return captionJobKey(
      identity.itemId,
      identity.videoId,
      stage,
      languageCode,
    );
  } catch {
    throw stableError("tikhub-malformed-response");
  }
}

function jobIdentity(
  key: string,
  job: Pick<TikHubCaptionJobRecord, "jobId" | "connectionId">,
): TikHubCaptionJobIdentity {
  return {
    key,
    jobId: job.jobId,
    connectionId: job.connectionId,
  };
}

function persistenceToken(
  key: string,
  job: Pick<TikHubCaptionJobRecord, "jobId" | "connectionId">,
): TikHubCaptionJobIdentity {
  return Object.freeze(jobIdentity(key, job));
}

function parsePersistenceToken(
  value: unknown,
  expectedKey: string,
): TikHubCaptionJobIdentity {
  try {
    if (
      !plainRecord(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      !hasExactKeys(value, ["key", "jobId", "connectionId"])
    ) {
      throw new Error("invalid persistence token");
    }
    const key = ownData(value, "key");
    const jobId = ownData(value, "jobId");
    const connectionId = ownData(value, "connectionId");
    if (
      key !== expectedKey ||
      typeof jobId !== "string" ||
      !JOB_ID.test(jobId) ||
      typeof connectionId !== "string" ||
      !isCanonicalConnectionId(connectionId)
    ) {
      throw new Error("invalid persistence token");
    }
    return { key, jobId, connectionId };
  } catch {
    throw stableError("tikhub-malformed-response");
  }
}

function isExpiredJobFailure(error: unknown): boolean {
  return error instanceof TikHubClientError &&
    (error.code === "invalid-query" || error.code === "provider-rejected");
}

function isExpectedJob(
  value: unknown,
  identity: Pick<OperationIdentity, "itemId" | "videoId">,
  stage: CaptionStage,
  languageCode: string | undefined,
  connectionId: string,
): value is TikHubCaptionJobRecord {
  try {
    if (!plainRecord(value)) return false;
    const schemaVersion = ownData(value, "schemaVersion");
    const fields = stage === "tracks"
      ? schemaVersion === 1
        ? TRACK_JOB_FIELDS
        : schemaVersion === 2
          ? TRACK_JOB_V2_FIELDS
          : undefined
      : schemaVersion === 1
        ? CONTENT_JOB_FIELDS
        : schemaVersion === 2
          ? CONTENT_JOB_V2_FIELDS
          : undefined;
    if (!fields) return false;
    if (!hasExactKeys(value, fields)) return false;
    const createdAt = ownData(value, "createdAt");
    const lastCheckedAt = ownData(value, "lastCheckedAt");
    const jobId = ownData(value, "jobId");
    return (
      (schemaVersion === 1 ||
        (schemaVersion === 2 &&
          typeof ownData(value, "operationId") === "string" &&
          OPERATION_ID.test(ownData(value, "operationId") as string))) &&
      ownData(value, "itemId") === identity.itemId &&
      ownData(value, "videoId") === identity.videoId &&
      ownData(value, "stage") === stage &&
      (stage === "tracks"
        ? !Object.prototype.hasOwnProperty.call(value, "languageCode")
        : ownData(value, "languageCode") === languageCode) &&
      ownData(value, "format") === "txt" &&
      typeof jobId === "string" &&
      JOB_ID.test(jobId) &&
      ownData(value, "connectionId") === connectionId &&
      typeof createdAt === "string" &&
      canonicalTimestamp(createdAt) &&
      typeof lastCheckedAt === "string" &&
      canonicalTimestamp(lastCheckedAt) &&
      createdAt <= lastCheckedAt &&
      ownData(value, "status") === "processing"
    );
  } catch {
    return false;
  }
}

function parseResponse(
  data: unknown,
  videoId: string,
  evidence: TranscriptProviderOperationEvidence,
): TikHubCaptionResponse {
  try {
    return parseTikHubCaptionResponse(data, videoId);
  } catch {
    throw stableError("tikhub-malformed-response", evidence);
  }
}

function resultData(
  value: unknown,
  evidence: TranscriptProviderOperationEvidence,
): unknown {
  try {
    if (!plainRecord(value)) throw new Error("invalid client result");
    return ownData(value, "data");
  } catch {
    throw stableError("tikhub-malformed-response", evidence);
  }
}

function assertResultJobId(
  data: unknown,
  expectedJobId: string,
  evidence: TranscriptProviderOperationEvidence,
): void {
  try {
    if (!plainRecord(data) || ownData(data, "job_id") !== expectedJobId) {
      throw new Error("mismatched job");
    }
  } catch {
    throw stableError("tikhub-malformed-response", evidence);
  }
}

function assertTerminalStage(
  response: TikHubCaptionResponse,
  stage: CaptionStage,
  evidence: TranscriptProviderOperationEvidence,
): void {
  const valid = stage === "tracks"
    ? response.kind === "tracks" || response.kind === "no-captions"
    : response.kind === "content" || response.kind === "no-captions";
  if (!valid) throw stableError("tikhub-malformed-response", evidence);
}

function isMatchingTranscript(
  value: unknown,
  identity: OperationIdentity,
  locator: LocatorProjection,
): value is YouTubeTranscript {
  try {
    if (!plainRecord(value)) return false;
    return ownData(value, "videoId") === identity.videoId &&
      ownData(value, "languageCode") === locator.languageCode &&
      ownData(value, "languageName") === locator.languageName &&
      ownData(value, "isGenerated") === locator.isGenerated &&
      ownData(value, "provider") === "tikhub";
  } catch {
    return false;
  }
}

function normalizeFailure(
  error: unknown,
  resuming: boolean,
  signal: AbortSignal | undefined,
  evidence: TranscriptProviderOperationEvidence = FREE_OPERATION_EVIDENCE,
  useClientAttemptEvidence = false,
): YouTubeTranscriptError {
  const clientEvidence = error instanceof TikHubClientError &&
      useClientAttemptEvidence
    ? error.paidRequestAttempted
      ? ATTEMPTED_OPERATION_EVIDENCE
      : FREE_OPERATION_EVIDENCE
    : evidence;
  if (signal?.aborted) return stableError("aborted", clientEvidence);
  if (error instanceof YouTubeTranscriptError) {
    return stableError(error.code, evidence);
  }
  if (
    error instanceof TikHubRequestBudgetError ||
    error instanceof TikHubRequestLedgerError
  ) {
    return stableError("tikhub-budget-unavailable", evidence);
  }
  if (error instanceof InvalidTikHubCaptionResponseError) {
    return stableError("tikhub-malformed-response", evidence);
  }
  if (error instanceof TikHubClientError) {
    if (
      resuming &&
      (error.code === "invalid-query" || error.code === "provider-rejected")
    ) {
      return stableError("tikhub-job-expired", clientEvidence);
    }
    const code: Record<TikHubClientError["code"], YouTubeTranscriptErrorCode> = {
      "missing-key": "tikhub-missing-key",
      "invalid-key": "tikhub-invalid-key",
      "insufficient-balance": "tikhub-insufficient-balance",
      "rate-limited": "tikhub-rate-limited",
      "invalid-query": "tikhub-malformed-response",
      "provider-failure": "temporarily-unavailable",
      "provider-rejected": "temporarily-unavailable",
      "network-failure": "temporarily-unavailable",
      "malformed-response": "tikhub-malformed-response",
      timeout: "timeout",
      aborted: "aborted",
      "invalid-batch": "tikhub-budget-unavailable",
    };
    return stableError(
      code[error.code] ?? "temporarily-unavailable",
      clientEvidence,
    );
  }
  return stableError("temporarily-unavailable", evidence);
}

function assertNotAborted(
  signal: AbortSignal | undefined,
  evidence: TranscriptProviderOperationEvidence = FREE_OPERATION_EVIDENCE,
): void {
  if (signal?.aborted) throw stableError("aborted", evidence);
}

function stableError(
  code: YouTubeTranscriptErrorCode,
  evidence: TranscriptProviderOperationEvidence = FREE_OPERATION_EVIDENCE,
): YouTubeTranscriptError {
  return new YouTubeTranscriptError(code, evidence);
}

function safeTimestamp(
  clock: () => Date,
  evidence: TranscriptProviderOperationEvidence = FREE_OPERATION_EVIDENCE,
): string {
  try {
    const value = clock();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new Error("invalid clock");
    }
    return value.toISOString();
  } catch {
    throw stableError("tikhub-malformed-response", evidence);
  }
}

function canonicalTimestamp(value: string): boolean {
  if (!ISO_TIMESTAMP.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function safeLanguageName(value: string): boolean {
  return value.length > 0 &&
    value.length <= MAX_LANGUAGE_NAME_LENGTH &&
    value.trim() === value &&
    !hasUnsafeControl(value);
}

function hasUnsafeControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      codePoint <= 31 ||
      (codePoint >= 127 && codePoint <= 159)
    ) {
      return true;
    }
  }
  return false;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  try {
    const prototype = Reflect.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function ownData(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) {
    throw stableError("tikhub-malformed-response");
  }
  return descriptor.value;
}

function hasExactKeys(
  value: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === fields.length && keys.every((key) =>
    typeof key === "string" && fields.includes(key)
  );
}
