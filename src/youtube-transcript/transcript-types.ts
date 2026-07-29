export type YouTubeTranscriptErrorCode =
  | "invalid-video-id"
  | "video-unavailable"
  | "login-required"
  | "no-captions"
  | "temporarily-unavailable"
  | "timeout"
  | "tikhub-missing-key"
  | "tikhub-invalid-key"
  | "tikhub-insufficient-balance"
  | "tikhub-budget-unavailable"
  | "tikhub-rate-limited"
  | "tikhub-processing"
  | "tikhub-job-expired"
  | "tikhub-malformed-response"
  | "aborted";

export type YouTubeCaptionFormat = "json3" | "srv3" | "vtt";
export type YouTubeTranscriptProvider = "innertube" | "tikhub" | "yt-dlp";

export type YouTubeTranscriptProgressStage =
  | "checking-cache"
  | "trying-innertube"
  | "trying-tikhub"
  | "waiting-tikhub"
  | "trying-yt-dlp"
  | "saving";

export interface YouTubeTranscriptUsage {
  tikhubPaidRequests: 0 | 1 | 2;
}

export interface YouTubeTranscriptProgress {
  stage: YouTubeTranscriptProgressStage;
  usage: YouTubeTranscriptUsage;
}

export interface TranscriptProviderOperationEvidence {
  readonly tikhubPaidRequests: 0 | 1;
  readonly paidRequestAttempted: boolean;
}

export interface TranscriptProviderOperationResult<T> {
  readonly kind: "transcript-provider-operation-result";
  readonly value: T;
  readonly evidence: TranscriptProviderOperationEvidence;
  readonly persistenceToken?: unknown;
}

export function createTranscriptProviderOperationResult<T>(
  value: T,
  evidence: TranscriptProviderOperationEvidence,
  ...persistenceToken: [] | [unknown]
): TranscriptProviderOperationResult<T> {
  const result = {
    kind: "transcript-provider-operation-result" as const,
    value,
    evidence: freezeTranscriptProviderOperationEvidence(evidence),
    ...(persistenceToken.length === 0
      ? {}
      : { persistenceToken: persistenceToken[0] }),
  };
  return Object.freeze(result);
}

export function isTranscriptProviderOperationResult(
  value: unknown,
): value is TranscriptProviderOperationResult<unknown> {
  return operationResultParts(value) !== null;
}

export function snapshotTranscriptProviderOperationResult(
  value: unknown,
): TranscriptProviderOperationResult<unknown> | null {
  const parts = operationResultParts(value);
  if (!parts) return null;
  return parts.hasPersistenceToken
    ? createTranscriptProviderOperationResult(
        parts.value,
        parts.evidence,
        parts.persistenceToken,
      )
    : createTranscriptProviderOperationResult(parts.value, parts.evidence);
}

interface YouTubeCaptionTrackBase {
  languageCode: string;
  languageName: string;
  isGenerated: boolean;
  url: string;
}

export type YouTubeCaptionTrack = YouTubeCaptionTrackBase & (
  | {
      source: "tikhub";
      format: "txt";
    }
  | {
      source: "innertube" | "yt-dlp";
      format: YouTubeCaptionFormat;
    }
);

export interface YouTubeTranscript {
  videoId: string;
  languageCode: string;
  languageName: string;
  isGenerated: boolean;
  provider: YouTubeTranscriptProvider;
  text: string;
}

export interface TranscriptProviderRegistration {
  source: YouTubeTranscriptProvider;
  provider: TranscriptProvider;
  isAvailable?: () => Promise<boolean>;
}

export interface TranscriptProviderOperationContext {
  readonly itemId: string;
  readonly videoId: string;
}

export interface TranscriptProvider {
  listTracks(
    videoId: string,
    signal: AbortSignal | undefined,
    context: TranscriptProviderOperationContext,
  ): Promise<
    | YouTubeCaptionTrack[]
    | TranscriptProviderOperationResult<YouTubeCaptionTrack[]>
  >;
  fetchTrack(
    track: YouTubeCaptionTrack,
    signal: AbortSignal | undefined,
    context: TranscriptProviderOperationContext,
  ): Promise<
    YouTubeTranscript | TranscriptProviderOperationResult<YouTubeTranscript>
  >;
  onPersisted?(
    track: YouTubeCaptionTrack,
    transcript: YouTubeTranscript,
    context: TranscriptProviderOperationContext,
    persistenceToken?: unknown,
  ): Promise<void>;
}

/** A stable, localization-safe transcript failure without provider payloads. */
export class YouTubeTranscriptError extends Error {
  readonly operationEvidence?: TranscriptProviderOperationEvidence;

  constructor(
    readonly code: YouTubeTranscriptErrorCode,
    operationEvidence?: TranscriptProviderOperationEvidence,
  ) {
    super(code);
    this.name = "YouTubeTranscriptError";
    if (operationEvidence !== undefined) {
      Object.defineProperty(this, "operationEvidence", {
        value: freezeTranscriptProviderOperationEvidence(operationEvidence),
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
  }
}

function freezeTranscriptProviderOperationEvidence(
  value: unknown,
): TranscriptProviderOperationEvidence {
  const parts = operationEvidenceParts(value);
  if (!parts) {
    throw new Error("Invalid transcript provider operation evidence");
  }
  return Object.freeze({
    tikhubPaidRequests: parts.tikhubPaidRequests,
    paidRequestAttempted: parts.paidRequestAttempted,
  });
}

interface OperationEvidenceParts {
  tikhubPaidRequests: 0 | 1;
  paidRequestAttempted: boolean;
}

interface OperationResultParts {
  value: unknown;
  evidence: TranscriptProviderOperationEvidence;
  hasPersistenceToken: boolean;
  persistenceToken?: unknown;
}

function operationEvidenceParts(value: unknown): OperationEvidenceParts | null {
  const descriptors = ownDataDescriptors(
    value,
    ["tikhubPaidRequests", "paidRequestAttempted"],
  );
  if (!descriptors) return null;
  const paidRequests = descriptors.tikhubPaidRequests.value;
  const attempted = descriptors.paidRequestAttempted.value;
  if (
    (paidRequests !== 0 && paidRequests !== 1) ||
    typeof attempted !== "boolean" ||
    (paidRequests === 1 && !attempted)
  ) {
    return null;
  }
  return {
    tikhubPaidRequests: paidRequests,
    paidRequestAttempted: attempted,
  };
}

function operationResultParts(value: unknown): OperationResultParts | null {
  const descriptors = ownDataDescriptors(
    value,
    ["kind", "value", "evidence"],
    ["persistenceToken"],
  );
  if (!descriptors) return null;
  try {
    if (
      !Object.isFrozen(value) ||
      descriptors.kind.value !== "transcript-provider-operation-result" ||
      !Object.isFrozen(descriptors.evidence.value)
    ) {
      return null;
    }
    const evidence = operationEvidenceParts(descriptors.evidence.value);
    if (!evidence) return null;
    const hasPersistenceToken = Object.prototype.hasOwnProperty.call(
      descriptors,
      "persistenceToken",
    );
    return {
      value: descriptors.value.value,
      evidence: Object.freeze({ ...evidence }),
      hasPersistenceToken,
      ...(hasPersistenceToken
        ? { persistenceToken: descriptors.persistenceToken?.value }
        : {}),
    };
  } catch {
    return null;
  }
}

interface OwnDataDescriptor {
  configurable?: boolean;
  enumerable?: boolean;
  value: unknown;
  writable?: boolean;
}

function ownDataDescriptors(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): Record<string, OwnDataDescriptor> | null {
  if (typeof value !== "object" || value === null) return null;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return null;
    const allowedKeys = new Set([...requiredKeys, ...optionalKeys]);
    const keys = Reflect.ownKeys(value);
    if (
      keys.some((key) => typeof key !== "string" || !allowedKeys.has(key)) ||
      requiredKeys.some((key) => !keys.includes(key))
    ) {
      return null;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of keys) {
      const descriptor = descriptors[key as string];
      if (
        descriptor === undefined ||
        !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
        descriptor.enumerable !== true
      ) {
        return null;
      }
    }
    return descriptors as Record<string, OwnDataDescriptor>;
  } catch {
    return null;
  }
}

const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/u;

export function isValidYouTubeVideoId(videoId: string): boolean {
  return YOUTUBE_VIDEO_ID.test(videoId);
}

export function assertYouTubeVideoId(videoId: string): string {
  if (!isValidYouTubeVideoId(videoId)) {
    throw new YouTubeTranscriptError("invalid-video-id");
  }
  return videoId;
}
