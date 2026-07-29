import { describe, expect, it } from "vitest";

import {
  assertYouTubeVideoId,
  createTranscriptProviderOperationResult,
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
  it("creates frozen operation envelopes with copied, frozen billing evidence", () => {
    const evidence = {
      tikhubPaidRequests: 1 as const,
      paidRequestAttempted: true,
    };
    const persistenceToken = { job: "memory-only" };

    const result = createTranscriptProviderOperationResult(
      [TIKHUB_TEXT_TRACK],
      evidence,
      persistenceToken,
    );

    expect(result).toEqual({
      kind: "transcript-provider-operation-result",
      value: [TIKHUB_TEXT_TRACK],
      evidence,
      persistenceToken,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.evidence)).toBe(true);
    expect(result.evidence).not.toBe(evidence);
    expect(Reflect.set(result.evidence, "tikhubPaidRequests", 0)).toBe(false);
  });

  it.each([
    { tikhubPaidRequests: 1, paidRequestAttempted: false },
    { tikhubPaidRequests: 2, paidRequestAttempted: true },
    { tikhubPaidRequests: 0, paidRequestAttempted: "yes" },
    {
      tikhubPaidRequests: 0,
      paidRequestAttempted: false,
      endpoint: "/api/private",
    },
  ])("rejects invalid or non-sanitized operation evidence %#", (evidence) => {
    expect(() =>
      createTranscriptProviderOperationResult(
        [],
        evidence as never,
      ),
    ).toThrow("Invalid transcript provider operation evidence");
    expect(() =>
      new YouTubeTranscriptError("temporarily-unavailable", evidence as never),
    ).toThrow("Invalid transcript provider operation evidence");
  });

  it("stores only frozen sanitized operation evidence on provider errors", () => {
    const evidence = {
      tikhubPaidRequests: 0 as const,
      paidRequestAttempted: true,
    };

    const error = new YouTubeTranscriptError(
      "temporarily-unavailable",
      evidence,
    );

    expect(error.operationEvidence).toEqual(evidence);
    expect(error.operationEvidence).not.toBe(evidence);
    expect(Object.isFrozen(error.operationEvidence)).toBe(true);
    expect(Reflect.set(error.operationEvidence!, "paidRequestAttempted", false))
      .toBe(false);
  });

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
