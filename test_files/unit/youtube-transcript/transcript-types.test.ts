import { describe, expect, it } from "vitest";

import {
  assertYouTubeVideoId,
  isValidYouTubeVideoId,
  YouTubeTranscriptError,
  type TranscriptProviderRegistration,
  type YouTubeCaptionTrack,
  type YouTubeTranscriptProvider,
} from "../../../src/youtube-transcript/transcript-types";

const ALL_PROVIDERS: readonly YouTubeTranscriptProvider[] = [
  "innertube",
  "tikhub",
  "yt-dlp",
];

const TIKHUB_TEXT_TRACK: YouTubeCaptionTrack = {
  languageCode: "en",
  languageName: "English",
  isGenerated: false,
  source: "tikhub",
  url: "tikhub:caption/en",
  format: "txt",
};

const registrations: TranscriptProviderRegistration[] = ALL_PROVIDERS.map(
  (source) => ({
    source,
    provider: {
      async listTracks(): Promise<YouTubeCaptionTrack[]> {
        return [];
      },
      async fetchTrack(): Promise<never> {
        throw new YouTubeTranscriptError("no-captions");
      },
    },
  }),
);

describe("YouTube transcript video IDs", () => {
  it("exposes TikHub as a stable provider registration source", () => {
    expect(registrations.map(({ source }) => source)).toEqual([
      "innertube",
      "tikhub",
      "yt-dlp",
    ]);
  });

  it("represents TikHub plain-text locators in the caption-track domain", () => {
    expect(TIKHUB_TEXT_TRACK).toEqual({
      languageCode: "en",
      languageName: "English",
      isGenerated: false,
      source: "tikhub",
      url: "tikhub:caption/en",
      format: "txt",
    });
  });

  it.each(["dQw4w9WgXcQ", "abc_DEF-123", "___________"])(
    "accepts the exact eleven-character YouTube ID %s",
    (videoId) => {
      expect(isValidYouTubeVideoId(videoId)).toBe(true);
      expect(assertYouTubeVideoId(videoId)).toBe(videoId);
    },
  );

  it.each([
    "dQw4w9WgXc",
    "dQw4w9WgXcQx",
    " dQw4w9WgXcQ",
    "dQw4w9WgXcQ ",
    "https://youtu.be/dQw4w9WgXcQ",
    "dQw4w9WgXc@",
    "视频标识符1234567",
  ])("rejects non-ID input without normalizing it: %s", (videoId) => {
    expect(isValidYouTubeVideoId(videoId)).toBe(false);

    try {
      assertYouTubeVideoId(videoId);
      throw new Error("expected assertYouTubeVideoId to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(YouTubeTranscriptError);
      expect((error as YouTubeTranscriptError).code).toBe("invalid-video-id");
      expect((error as Error).message).toBe("invalid-video-id");
    }
  });
});
