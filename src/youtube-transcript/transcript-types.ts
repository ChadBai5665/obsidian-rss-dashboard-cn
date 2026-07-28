export type YouTubeTranscriptErrorCode =
  | "invalid-video-id"
  | "video-unavailable"
  | "login-required"
  | "no-captions"
  | "temporarily-unavailable"
  | "timeout"
  | "aborted";

export type YouTubeCaptionFormat = "json3" | "srv3" | "vtt";
export type YouTubeTranscriptProvider = "innertube" | "yt-dlp";

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
