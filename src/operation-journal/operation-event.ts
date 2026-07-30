import type { AiOperation } from "../ai/prompts/prompt-types";

export type OperationCategory =
  | "transcript"
  | "ai"
  | "refresh"
  | "subscription";

export type OperationTrigger = "manual" | "startup" | "schedule" | "system";

export type OperationStatus =
  | "started"
  | "progress"
  | "succeeded"
  | "failed"
  | "aborted"
  | "interrupted";

export type OperationAction =
  | "retrieve"
  | AiOperation
  | "all"
  | "failed"
  | "source"
  | "folder"
  | "add"
  | "update"
  | "pause"
  | "resume"
  | "remove";

export type OperationStage =
  | "requested"
  | "checking-cache"
  | "trying-provider"
  | "tikhub-request"
  | "job-received"
  | "polling"
  | "preparing"
  | "generating"
  | "streaming"
  | "refreshing"
  | "validating"
  | "saving"
  | "cleaning"
  | "completed";

export type OperationErrorCode =
  | "missing-key"
  | "invalid-connection"
  | "connection-disabled"
  | "invalid-request"
  | "invalid-key"
  | "insufficient-balance"
  | "timeout"
  | "rate-limited"
  | "provider-failure"
  | "provider-rejected"
  | "network-failure"
  | "aborted"
  | "malformed-response"
  | "response-too-large"
  | "empty-output"
  | "secret-store-failure"
  | "connection-not-found"
  | "invalid-operation"
  | "selection-failed"
  | "no-transcript"
  | "transcript-unavailable"
  | "tikhub-disabled"
  | "budget-exhausted"
  | "cache-save-failed"
  | "refresh-failed"
  | "source-refresh-failed"
  | "source-validation-failed"
  | "subscription-operation-failed"
  | "duplicate-subscription"
  | "invalid-subscription-request"
  | "subscription-not-found"
  | "purge-confirmation-required"
  | "settings-save-failed"
  | "collection-cleanup-failed";

export interface OperationSubject {
  readonly itemId?: string;
  readonly sourceId?: string;
  readonly label?: string;
}

export interface TranscriptOperationDetails {
  readonly provider?: "cache" | "innertube" | "yt-dlp" | "tikhub";
  readonly confirmedPaidRequests?: 0 | 1 | 2;
  readonly possiblySent?: boolean;
  readonly jobId?: string;
  readonly pollNumber?: number;
  readonly elapsedMs?: number;
  readonly contentBasis?: "youtube-transcript";
  readonly errorCode?: OperationErrorCode;
}

export interface AiOperationDetails {
  readonly connectionName?: string;
  readonly providerKind?:
    | "kimi"
    | "deepseek"
    | "qwen"
    | "glm"
    | "openai"
    | "claude"
    | "minimax-cn"
    | "minimax-global"
    | "openai-compatible"
    | "anthropic-compatible";
  readonly model?: string;
  readonly contentBasis?:
    | "feed"
    | "full-text"
    | "youtube-transcript"
    | "title-description"
    | "x-post"
    | "linked-page";
  readonly elapsedMs?: number;
  readonly artifactPath?: string;
  readonly errorCode?: OperationErrorCode;
}

export interface RefreshOperationDetails {
  readonly total?: number;
  readonly succeeded?: number;
  readonly failed?: number;
  readonly newItems?: number;
  readonly elapsedMs?: number;
  readonly errorCode?: OperationErrorCode;
}

export interface SubscriptionOperationDetails {
  readonly sourceKind?:
    | "rss"
    | "atom"
    | "json"
    | "podcast"
    | "website"
    | "youtube"
    | "x-account"
    | "x-topic";
  readonly preserveHistory?: boolean;
  readonly errorCode?: OperationErrorCode;
}

export type OperationDetails =
  | TranscriptOperationDetails
  | AiOperationDetails
  | RefreshOperationDetails
  | SubscriptionOperationDetails;

export interface OperationEvent {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly operationId: string;
  readonly occurredAt: string;
  readonly category: OperationCategory;
  readonly action: OperationAction;
  readonly trigger: OperationTrigger;
  readonly stage: OperationStage;
  readonly status: OperationStatus;
  readonly subject: Readonly<OperationSubject>;
  readonly details: Readonly<OperationDetails>;
}

const EVENT_KEYS = [
  "schemaVersion",
  "eventId",
  "operationId",
  "occurredAt",
  "category",
  "action",
  "trigger",
  "stage",
  "status",
  "subject",
  "details",
] as const;
const SUBJECT_KEYS = ["itemId", "sourceId", "label"] as const;

const ACTIONS: Readonly<Record<OperationCategory, readonly OperationAction[]>> =
  Object.freeze({
    transcript: ["retrieve"],
    ai: ["summary", "translate-zh-cn", "core-points", "deep-analysis"],
    refresh: ["all", "failed", "source", "folder"],
    subscription: ["add", "update", "pause", "resume", "remove"],
  });
const STAGES: Readonly<Record<OperationCategory, readonly OperationStage[]>> =
  Object.freeze({
    transcript: [
      "requested",
      "checking-cache",
      "trying-provider",
      "tikhub-request",
      "job-received",
      "polling",
      "saving",
      "completed",
    ],
    ai: ["preparing", "generating", "streaming", "saving", "completed"],
    refresh: ["preparing", "refreshing", "saving", "completed"],
    subscription: ["validating", "saving", "cleaning", "completed"],
  });
const DETAIL_KEYS: Readonly<Record<OperationCategory, readonly string[]>> =
  Object.freeze({
    transcript: [
      "provider",
      "confirmedPaidRequests",
      "possiblySent",
      "jobId",
      "pollNumber",
      "elapsedMs",
      "contentBasis",
      "errorCode",
    ],
    ai: [
      "connectionName",
      "providerKind",
      "model",
      "contentBasis",
      "elapsedMs",
      "artifactPath",
      "errorCode",
    ],
    refresh: [
      "total",
      "succeeded",
      "failed",
      "newItems",
      "elapsedMs",
      "errorCode",
    ],
    subscription: ["sourceKind", "preserveHistory", "errorCode"],
  });
const CATEGORIES = new Set<OperationCategory>([
  "transcript",
  "ai",
  "refresh",
  "subscription",
]);
const TRIGGERS = new Set<OperationTrigger>([
  "manual",
  "startup",
  "schedule",
  "system",
]);
const PERSISTED_STATUSES = new Set<Exclude<OperationStatus, "interrupted">>([
  "started",
  "progress",
  "succeeded",
  "failed",
  "aborted",
]);
const PROVIDERS = new Set<NonNullable<TranscriptOperationDetails["provider"]>>([
  "cache",
  "innertube",
  "yt-dlp",
  "tikhub",
]);
const AI_PROVIDER_KINDS = new Set<
  NonNullable<AiOperationDetails["providerKind"]>
>([
  "kimi",
  "deepseek",
  "qwen",
  "glm",
  "openai",
  "claude",
  "minimax-cn",
  "minimax-global",
  "openai-compatible",
  "anthropic-compatible",
]);
const CONTENT_BASES = new Set<NonNullable<AiOperationDetails["contentBasis"]>>([
  "feed",
  "full-text",
  "youtube-transcript",
  "title-description",
  "x-post",
  "linked-page",
]);
const SOURCE_KINDS = new Set<
  NonNullable<SubscriptionOperationDetails["sourceKind"]>
>([
  "rss",
  "atom",
  "json",
  "podcast",
  "website",
  "youtube",
  "x-account",
  "x-topic",
]);
const ERROR_CODES = new Set<OperationErrorCode>([
  "missing-key",
  "invalid-connection",
  "connection-disabled",
  "invalid-request",
  "invalid-key",
  "insufficient-balance",
  "timeout",
  "rate-limited",
  "provider-failure",
  "provider-rejected",
  "network-failure",
  "aborted",
  "malformed-response",
  "response-too-large",
  "empty-output",
  "secret-store-failure",
  "connection-not-found",
  "invalid-operation",
  "selection-failed",
  "no-transcript",
  "transcript-unavailable",
  "tikhub-disabled",
  "budget-exhausted",
  "cache-save-failed",
  "refresh-failed",
  "source-refresh-failed",
  "source-validation-failed",
  "subscription-operation-failed",
  "duplicate-subscription",
  "invalid-subscription-request",
  "subscription-not-found",
  "purge-confirmation-required",
  "settings-save-failed",
  "collection-cleanup-failed",
]);
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const LOCAL_ID = /^[A-Za-z0-9._:-]{1,200}$/u;
const ARTIFACT_PATH = /^analysis\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.md$/u;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SENSITIVE_TEXT =
  /(?:\b(?:https?|wss?|ftp):\/\/|\bwww\.|\bauthorization\s*:|\bbearer\s+[A-Za-z0-9._~+/-]+|\b(?:api[ _-]?key|access[ _-]?token|client[ _-]?secret|password|cookie)\s*[:=]|\bsk-[A-Za-z0-9_-]{8,})/iu;

export class OperationEventParseError extends Error {
  constructor() {
    super("Invalid operation journal event.");
    this.name = "OperationEventParseError";
  }
}

export function snapshotOperationEvent(value: unknown): OperationEvent {
  const event = ownDataRecord(value, EVENT_KEYS);
  const category = enumValue(event.category, CATEGORIES);
  const action = enumValue(event.action, new Set(ACTIONS[category]));
  const stage = enumValue(event.stage, new Set(STAGES[category]));

  if (event.schemaVersion !== 1) throw malformedEvent();
  const snapshot: OperationEvent = {
    schemaVersion: 1,
    eventId: uuid(event.eventId),
    operationId: uuid(event.operationId),
    occurredAt: utcInstant(event.occurredAt),
    category,
    action,
    trigger: enumValue(event.trigger, TRIGGERS),
    stage,
    status: enumValue(event.status, PERSISTED_STATUSES),
    subject: snapshotSubject(event.subject),
    details: snapshotDetails(category, event.details),
  };
  return Object.freeze(snapshot);
}

function snapshotSubject(value: unknown): Readonly<OperationSubject> {
  const subject = ownDataRecord(value, SUBJECT_KEYS);
  return Object.freeze({
    ...(subject.itemId === undefined
      ? {}
      : { itemId: localId(subject.itemId) }),
    ...(subject.sourceId === undefined
      ? {}
      : { sourceId: localId(subject.sourceId) }),
    ...(subject.label === undefined ? {} : { label: safeText(subject.label) }),
  });
}

function snapshotDetails(
  category: OperationCategory,
  value: unknown,
): Readonly<OperationDetails> {
  const details = ownDataRecord(value, DETAIL_KEYS[category]);
  switch (category) {
    case "transcript":
      return Object.freeze({
        ...(details.provider === undefined
          ? {}
          : { provider: enumValue(details.provider, PROVIDERS) }),
        ...(details.confirmedPaidRequests === undefined
          ? {}
          : {
              confirmedPaidRequests: confirmedPaidRequests(
                details.confirmedPaidRequests,
              ),
            }),
        ...(details.possiblySent === undefined
          ? {}
          : { possiblySent: booleanValue(details.possiblySent) }),
        ...(details.jobId === undefined
          ? {}
          : { jobId: localId(details.jobId) }),
        ...(details.pollNumber === undefined
          ? {}
          : { pollNumber: count(details.pollNumber) }),
        ...(details.elapsedMs === undefined
          ? {}
          : { elapsedMs: count(details.elapsedMs) }),
        ...(details.contentBasis === undefined
          ? {}
          : { contentBasis: transcriptContentBasis(details.contentBasis) }),
        ...(details.errorCode === undefined
          ? {}
          : { errorCode: enumValue(details.errorCode, ERROR_CODES) }),
      });
    case "ai":
      return Object.freeze({
        ...(details.connectionName === undefined
          ? {}
          : { connectionName: safeText(details.connectionName) }),
        ...(details.providerKind === undefined
          ? {}
          : {
              providerKind: enumValue(details.providerKind, AI_PROVIDER_KINDS),
            }),
        ...(details.model === undefined
          ? {}
          : { model: safeText(details.model) }),
        ...(details.contentBasis === undefined
          ? {}
          : { contentBasis: enumValue(details.contentBasis, CONTENT_BASES) }),
        ...(details.elapsedMs === undefined
          ? {}
          : { elapsedMs: count(details.elapsedMs) }),
        ...(details.artifactPath === undefined
          ? {}
          : { artifactPath: artifactPath(details.artifactPath) }),
        ...(details.errorCode === undefined
          ? {}
          : { errorCode: enumValue(details.errorCode, ERROR_CODES) }),
      });
    case "refresh":
      return Object.freeze({
        ...(details.total === undefined ? {} : { total: count(details.total) }),
        ...(details.succeeded === undefined
          ? {}
          : { succeeded: count(details.succeeded) }),
        ...(details.failed === undefined
          ? {}
          : { failed: count(details.failed) }),
        ...(details.newItems === undefined
          ? {}
          : { newItems: count(details.newItems) }),
        ...(details.elapsedMs === undefined
          ? {}
          : { elapsedMs: count(details.elapsedMs) }),
        ...(details.errorCode === undefined
          ? {}
          : { errorCode: enumValue(details.errorCode, ERROR_CODES) }),
      });
    case "subscription":
      return Object.freeze({
        ...(details.sourceKind === undefined
          ? {}
          : { sourceKind: enumValue(details.sourceKind, SOURCE_KINDS) }),
        ...(details.preserveHistory === undefined
          ? {}
          : { preserveHistory: booleanValue(details.preserveHistory) }),
        ...(details.errorCode === undefined
          ? {}
          : { errorCode: enumValue(details.errorCode, ERROR_CODES) }),
      });
  }
}

function ownDataRecord(
  value: unknown,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null) throw malformedEvent();
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype)
      throw malformedEvent();
    const keys = Reflect.ownKeys(value);
    if (
      keys.some((key) => typeof key !== "string" || !allowedKeys.includes(key))
    ) {
      throw malformedEvent();
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const record: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key as string];
      if (
        descriptor === undefined ||
        !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
        descriptor.enumerable !== true
      ) {
        throw malformedEvent();
      }
      record[key as string] = descriptor.value;
    }
    return record;
  } catch (error) {
    if (error instanceof OperationEventParseError) throw error;
    throw malformedEvent();
  }
}

function enumValue<T extends string>(
  value: unknown,
  values: ReadonlySet<T>,
): T {
  if (typeof value !== "string" || !values.has(value as T))
    throw malformedEvent();
  return value as T;
}

function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw malformedEvent();
  return value.toLowerCase();
}

function utcInstant(value: unknown): string {
  if (typeof value !== "string" || !ISO_UTC.test(value)) throw malformedEvent();
  const timestamp = Date.parse(value);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== value
  ) {
    throw malformedEvent();
  }
  return value;
}

function localId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !LOCAL_ID.test(value) ||
    SENSITIVE_TEXT.test(value)
  ) {
    throw malformedEvent();
  }
  return value;
}

function safeText(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    [...value].length > 200 ||
    SENSITIVE_TEXT.test(value)
  ) {
    throw malformedEvent();
  }
  return value;
}

function artifactPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    [...value].length > 200 ||
    !ARTIFACT_PATH.test(value)
  ) {
    throw malformedEvent();
  }
  return value;
}

function transcriptContentBasis(value: unknown): "youtube-transcript" {
  if (value !== "youtube-transcript") throw malformedEvent();
  return value;
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw malformedEvent();
  }
  return value;
}

function confirmedPaidRequests(value: unknown): 0 | 1 | 2 {
  if (value !== 0 && value !== 1 && value !== 2) throw malformedEvent();
  return value;
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== "boolean") throw malformedEvent();
  return value;
}

function malformedEvent(): OperationEventParseError {
  return new OperationEventParseError();
}
