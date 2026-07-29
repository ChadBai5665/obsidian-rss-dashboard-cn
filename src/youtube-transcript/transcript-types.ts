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

export interface YouTubeCaptionTrack {
  languageCode: string;
  languageName: string;
  isGenerated: boolean;
  source: YouTubeTranscriptProvider;
  url: string;
  format: YouTubeCaptionFormat;
}

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

export interface TranscriptProvider {
  listTracks(
    videoId: string,
    signal?: AbortSignal,
  ): Promise<YouTubeCaptionTrack[]>;
  fetchTrack(
    track: YouTubeCaptionTrack,
    signal?: AbortSignal,
  ): Promise<YouTubeTranscript>;
  onPersisted?(
    track: YouTubeCaptionTrack,
    transcript: YouTubeTranscript,
  ): Promise<void>;
}

/** A stable, localization-safe transcript failure without provider payloads. */
export class YouTubeTranscriptError extends Error {
  constructor(readonly code: YouTubeTranscriptErrorCode) {
    super(code);
    this.name = "YouTubeTranscriptError";
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
