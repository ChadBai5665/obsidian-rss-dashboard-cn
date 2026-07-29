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
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(candidate);
  if (
    !Object.isFrozen(candidate) ||
    keys.some(
      (key) =>
        key !== "kind" &&
        key !== "value" &&
        key !== "evidence" &&
        key !== "persistenceToken",
    ) ||
    !keys.includes("kind") ||
    !keys.includes("value") ||
    !keys.includes("evidence") ||
    candidate.kind !== "transcript-provider-operation-result"
  ) {
    return false;
  }
  return (
    Object.isFrozen(candidate.evidence) &&
    isTranscriptProviderOperationEvidence(candidate.evidence)
  );
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

function isTranscriptProviderOperationEvidence(
  value: unknown,
): value is TranscriptProviderOperationEvidence {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(candidate);
  return (
    keys.length === 2 &&
    keys.includes("tikhubPaidRequests") &&
    keys.includes("paidRequestAttempted") &&
    (candidate.tikhubPaidRequests === 0 ||
      candidate.tikhubPaidRequests === 1) &&
    typeof candidate.paidRequestAttempted === "boolean" &&
    (candidate.tikhubPaidRequests === 0 || candidate.paidRequestAttempted)
  );
}

function freezeTranscriptProviderOperationEvidence(
  value: unknown,
): TranscriptProviderOperationEvidence {
  if (!isTranscriptProviderOperationEvidence(value)) {
    throw new Error("Invalid transcript provider operation evidence");
  }
  return Object.freeze({
    tikhubPaidRequests: value.tikhubPaidRequests,
    paidRequestAttempted: value.paidRequestAttempted,
  });
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
