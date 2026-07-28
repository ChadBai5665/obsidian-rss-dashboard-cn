import { describe, expect, it } from "vitest";

import {
  assertYouTubeVideoId,
  isValidYouTubeVideoId,
  YouTubeTranscriptError,
} from "../../../src/youtube-transcript/transcript-types";

describe("YouTube transcript video IDs", () => {
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
