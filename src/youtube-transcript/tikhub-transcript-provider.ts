import { isCanonicalConnectionId } from "../security/connection-id";
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
  type TikHubCaptionJobRecord,
} from "./tikhub-caption-job-repository";
import { isValidYouTubeCaptionLanguageCode } from "./youtube-caption-language-code";
import {
  assertYouTubeVideoId,
  YouTubeTranscriptError,
  type TranscriptProviderOperationContext,
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
  write(record: TikHubCaptionJobRecord): Promise<void>;
  remove(key: string): Promise<void>;
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
}

type CaptionStage = "tracks" | "content";

interface OperationIdentity {
  itemId: string;
  videoId: string;
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

const ITEM_ID = /^[a-f0-9]{64}$/u;
const JOB_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const LOCATOR_PREFIX = "tikhub:";
const MAX_LANGUAGE_NAME_LENGTH = 200;
const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_MAX_POLLS = 10;
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
  ): Promise<YouTubeCaptionTrack[]> {
    const identity = operationIdentity(requestedVideoId, context);
    assertNotAborted(signal);
    const session = await this.currentSession(signal);
    const response = await this.runStage(
      "tracks",
      identity,
      undefined,
      session,
      signal,
    );
    if (response.kind === "no-captions") return [];
    if (response.kind !== "tracks") throw stableError("tikhub-malformed-response");
    return response.tracks.map((track) => createTrack(identity.videoId, track));
  }

  async fetchTrack(
    track: YouTubeCaptionTrack,
    signal: AbortSignal | undefined,
    context: TranscriptProviderOperationContext,
  ): Promise<YouTubeTranscript> {
    const locator = parseLocator(track);
    const identity = operationIdentity(locator.videoId, context);
    assertNotAborted(signal);
    const session = await this.currentSession(signal);
    const response = await this.runStage(
      "content",
      identity,
      locator.languageCode,
      session,
      signal,
    );
    if (response.kind === "no-captions") throw stableError("no-captions");
    if (
      response.kind !== "content" ||
      response.languageCode !== locator.languageCode ||
      response.languageName !== locator.languageName ||
      response.isGenerated !== locator.isGenerated
    ) {
      throw stableError("tikhub-malformed-response");
    }
    return {
      videoId: identity.videoId,
      languageCode: response.languageCode,
      languageName: response.languageName,
      isGenerated: response.isGenerated,
      provider: "tikhub",
      text: response.text,
    };
  }

  async onPersisted(
    track: YouTubeCaptionTrack,
    transcript: YouTubeTranscript,
    context: TranscriptProviderOperationContext,
  ): Promise<void> {
    const locator = parseLocator(track);
    const identity = operationIdentity(locator.videoId, context);
    if (!isMatchingTranscript(transcript, identity, locator)) {
      throw stableError("tikhub-malformed-response");
    }
    const key = safeJobKey(
      identity,
      "content",
      locator.languageCode,
    );
    try {
      await this.options.jobs.remove(key);
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
  ): Promise<TikHubCaptionResponse> {
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
        throw stableError("tikhub-job-expired");
      }
      return await this.pollJob(currentJob, stage, session, signal);
    }

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
      throw normalizeFailure(error, false, signal);
    }
    assertNotAborted(signal);
    const response = parseResponse(resultData(result), identity.videoId);
    if (response.kind !== "processing") {
      if (response.kind === "pending") {
        throw stableError("tikhub-malformed-response");
      }
      assertTerminalStage(response, stage);
      return response;
    }

    const timestamp = safeTimestamp(this.options.clock);
    const record: TikHubCaptionJobRecord = {
      schemaVersion: 1,
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
    try {
      await this.options.jobs.write(record);
    } catch {
      throw stableError("tikhub-budget-unavailable");
    }
    assertNotAborted(signal);
    return await this.pollJob(record, stage, session, signal);
  }

  private async pollJob(
    initialJob: TikHubCaptionJobRecord,
    stage: CaptionStage,
    session: CurrentSession,
    signal: AbortSignal | undefined,
  ): Promise<TikHubCaptionResponse> {
    let job = { ...initialJob };
    for (let attempt = 0; attempt < this.maxPolls; attempt += 1) {
      assertNotAborted(signal);
      try {
        await this.options.delay(this.pollIntervalMs, signal);
      } catch (error) {
        throw normalizeFailure(error, false, signal);
      }
      assertNotAborted(signal);

      let result: TikHubResult<unknown>;
      try {
        result = await session.client.fetchYouTubeCaptionResult({
          apiKey: session.apiKey,
          jobId: job.jobId,
          format: "txt",
          signal,
        });
      } catch (error) {
        throw normalizeFailure(error, true, signal);
      }
      assertNotAborted(signal);
      const data = resultData(result);
      assertResultJobId(data, job.jobId);
      const response = parseResponse(data, job.videoId);
      if (response.kind === "pending" || response.kind === "processing") {
        if (response.jobId !== job.jobId) {
          throw stableError("tikhub-malformed-response");
        }
        job = {
          ...job,
          lastCheckedAt: safeTimestamp(this.options.clock),
        };
        try {
          await this.options.jobs.write(job);
        } catch {
          throw stableError("tikhub-budget-unavailable");
        }
        continue;
      }
      assertTerminalStage(response, stage);
      return response;
    }
    throw stableError("tikhub-processing");
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
  const videoId = assertYouTubeVideoId(requestedVideoId);
  try {
    if (!plainRecord(context)) throw new Error("invalid operation context");
    const contextVideoId = ownData(context, "videoId");
    const itemId = ownData(context, "itemId");
    if (
      contextVideoId !== videoId ||
      typeof itemId !== "string" ||
      !ITEM_ID.test(itemId)
    ) {
      throw new Error("invalid operation context");
    }
    return {
      itemId,
      videoId,
    };
  } catch {
    throw stableError("tikhub-malformed-response");
  }
}

function createTrack(
  videoId: string,
  track: TikHubCaptionTrack,
): YouTubeCaptionTrack {
  if (
    !isValidYouTubeCaptionLanguageCode(track.languageCode) ||
    !safeLanguageName(track.languageName) ||
    typeof track.isGenerated !== "boolean"
  ) {
    throw stableError("tikhub-malformed-response");
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
  identity: OperationIdentity,
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

function isExpectedJob(
  value: unknown,
  identity: OperationIdentity,
  stage: CaptionStage,
  languageCode: string | undefined,
  connectionId: string,
): value is TikHubCaptionJobRecord {
  try {
    if (!plainRecord(value)) return false;
    const fields = stage === "tracks" ? TRACK_JOB_FIELDS : CONTENT_JOB_FIELDS;
    if (!hasExactKeys(value, fields)) return false;
    const createdAt = ownData(value, "createdAt");
    const lastCheckedAt = ownData(value, "lastCheckedAt");
    const jobId = ownData(value, "jobId");
    return (
      ownData(value, "schemaVersion") === 1 &&
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

function parseResponse(data: unknown, videoId: string): TikHubCaptionResponse {
  try {
    return parseTikHubCaptionResponse(data, videoId);
  } catch {
    throw stableError("tikhub-malformed-response");
  }
}

function resultData(value: unknown): unknown {
  try {
    if (!plainRecord(value)) throw new Error("invalid client result");
    return ownData(value, "data");
  } catch {
    throw stableError("tikhub-malformed-response");
  }
}

function assertResultJobId(data: unknown, expectedJobId: string): void {
  try {
    if (!plainRecord(data) || ownData(data, "job_id") !== expectedJobId) {
      throw new Error("mismatched job");
    }
  } catch {
    throw stableError("tikhub-malformed-response");
  }
}

function assertTerminalStage(
  response: TikHubCaptionResponse,
  stage: CaptionStage,
): void {
  const valid = stage === "tracks"
    ? response.kind === "tracks" || response.kind === "no-captions"
    : response.kind === "content" || response.kind === "no-captions";
  if (!valid) throw stableError("tikhub-malformed-response");
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
): YouTubeTranscriptError {
  if (signal?.aborted) return stableError("aborted");
  if (error instanceof YouTubeTranscriptError) return stableError(error.code);
  if (
    error instanceof TikHubRequestBudgetError ||
    error instanceof TikHubRequestLedgerError
  ) {
    return stableError("tikhub-budget-unavailable");
  }
  if (error instanceof InvalidTikHubCaptionResponseError) {
    return stableError("tikhub-malformed-response");
  }
  if (error instanceof TikHubClientError) {
    if (
      resuming &&
      (error.code === "invalid-query" || error.code === "provider-rejected")
    ) {
      return stableError("tikhub-job-expired");
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
    return stableError(code[error.code] ?? "temporarily-unavailable");
  }
  return stableError("temporarily-unavailable");
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw stableError("aborted");
}

function stableError(code: YouTubeTranscriptErrorCode): YouTubeTranscriptError {
  return new YouTubeTranscriptError(code);
}

function safeTimestamp(clock: () => Date): string {
  try {
    const value = clock();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new Error("invalid clock");
    }
    return value.toISOString();
  } catch {
    throw stableError("tikhub-malformed-response");
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
