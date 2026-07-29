import { describe, expect, it } from "vitest";
import { parseTikHubCaptionResponse } from "../../../../src/sources/tikhub/youtube-caption-response";

const VIDEO_ID = "dQw4w9WgXcQ";
const JOB_ID = "123e4567-e89b-12d3-a456-426614174000";

describe("parseTikHubCaptionResponse", () => {
  it("projects a documented caption list and infers generated tracks", () => {
    expect(parseTikHubCaptionResponse({
      video_id: VIDEO_ID,
      captions: [
        { language_code: "en", language_name: "English" },
        { language_code: "a.zh-Hans", language_name: "Chinese (auto)" },
      ],
    }, VIDEO_ID)).toEqual({
      kind: "tracks",
      videoId: VIDEO_ID,
      tracks: [
        { languageCode: "en", languageName: "English", isGenerated: false },
        {
          languageCode: "a.zh-Hans",
          languageName: "Chinese (auto)",
          isGenerated: true,
        },
      ],
    });
  });

  it("projects synchronous plain text without retaining the provider object", () => {
    const source = {
      video_id: VIDEO_ID,
      language_code: "en",
      language_name: "English",
      is_generated: false,
      format: "txt",
      content: "Line one\nLine two",
      available_languages: ["en", "ja"],
    };

    const result = parseTikHubCaptionResponse(source, VIDEO_ID);
    source.content = "mutated";

    expect(result).toEqual({
      kind: "content",
      videoId: VIDEO_ID,
      languageCode: "en",
      languageName: "English",
      isGenerated: false,
      text: "Line one\nLine two",
    });
  });

  it("projects the documented completed job shape using the trusted video context", () => {
    expect(parseTikHubCaptionResponse({
      job_id: JOB_ID,
      status: "completed",
      language_code: "a.en",
      language_name: "English (auto)",
      format: "txt",
      content: "Completed caption",
      available_languages: ["a.en", "ja"],
    }, VIDEO_ID)).toEqual({
      kind: "content",
      videoId: VIDEO_ID,
      languageCode: "a.en",
      languageName: "English (auto)",
      isGenerated: true,
      text: "Completed caption",
    });
  });

  it("projects processing and queued or active result states", () => {
    expect(parseTikHubCaptionResponse({
      video_id: VIDEO_ID,
      status: "processing",
      job_id: JOB_ID,
    }, VIDEO_ID)).toEqual({
      kind: "processing",
      videoId: VIDEO_ID,
      jobId: JOB_ID,
    });

    for (const status of ["queued", "active"] as const) {
      expect(parseTikHubCaptionResponse({ status, job_id: JOB_ID }, VIDEO_ID))
        .toEqual({ kind: "pending", jobId: JOB_ID });
    }
  });

  it("projects an empty caption list as an explicit no-captions result", () => {
    expect(parseTikHubCaptionResponse({
      video_id: VIDEO_ID,
      captions: [],
      message: "No captions found",
      message_zh: "未找到字幕",
    }, VIDEO_ID)).toEqual({ kind: "no-captions", videoId: VIDEO_ID });
  });

  it("rejects mismatched video IDs for every video-bound shape", () => {
    const cases = [
      { video_id: "9bZkp7q19f0", captions: [] },
      { video_id: "9bZkp7q19f0", status: "processing", job_id: JOB_ID },
      {
        video_id: "9bZkp7q19f0",
        language_code: "en",
        language_name: "English",
        format: "txt",
        content: "text",
      },
    ];

    for (const value of cases) {
      expect(() => parseTikHubCaptionResponse(value, VIDEO_ID)).toThrow();
    }
  });

  it("deduplicates identical languages but rejects conflicting duplicates", () => {
    expect(parseTikHubCaptionResponse({
      video_id: VIDEO_ID,
      captions: [
        { language_code: "en", language_name: "English" },
        { language_code: "en", language_name: "English", is_generated: false },
      ],
    }, VIDEO_ID)).toEqual({
      kind: "tracks",
      videoId: VIDEO_ID,
      tracks: [
        { languageCode: "en", languageName: "English", isGenerated: false },
      ],
    });

    expect(() => parseTikHubCaptionResponse({
      video_id: VIDEO_ID,
      captions: [
        { language_code: "en", language_name: "English" },
        { language_code: "en", language_name: "Private English" },
      ],
    }, VIDEO_ID)).toThrow();
  });

  it("does not execute accessors and rejects inherited response fields", () => {
    let getterReads = 0;
    const accessor = { video_id: VIDEO_ID } as Record<string, unknown>;
    Object.defineProperty(accessor, "captions", {
      enumerable: true,
      get() {
        getterReads += 1;
        return [];
      },
    });
    const inherited = Object.create({ captions: [] }) as Record<string, unknown>;
    inherited.video_id = VIDEO_ID;

    expect(() => parseTikHubCaptionResponse(accessor, VIDEO_ID)).toThrow();
    expect(() => parseTikHubCaptionResponse(inherited, VIDEO_ID)).toThrow();
    expect(getterReads).toBe(0);
  });

  it.each([
    ["language code control", {
      video_id: VIDEO_ID,
      captions: [{ language_code: "en\u0000", language_name: "English" }],
    }],
    ["language name control", {
      video_id: VIDEO_ID,
      captions: [{ language_code: "en", language_name: "English\u0001" }],
    }],
    ["caption text control", {
      video_id: VIDEO_ID,
      language_code: "en",
      language_name: "English",
      format: "txt",
      content: "unsafe\u0001text",
    }],
    ["empty text", {
      video_id: VIDEO_ID,
      language_code: "en",
      language_name: "English",
      format: "txt",
      content: "",
    }],
  ])("rejects %s", (_label, value) => {
    expect(() => parseTikHubCaptionResponse(value, VIDEO_ID)).toThrow();
  });

  it("rejects more than 256 tracks and caption text over one million characters", () => {
    const tracks = Array.from({ length: 257 }, (_, index) => ({
      language_code: `x-${index}`,
      language_name: `Language ${index}`,
    }));
    expect(() => parseTikHubCaptionResponse({
      video_id: VIDEO_ID,
      captions: tracks,
    }, VIDEO_ID)).toThrow();

    expect(() => parseTikHubCaptionResponse({
      video_id: VIDEO_ID,
      language_code: "en",
      language_name: "English",
      format: "txt",
      content: "x".repeat(1_000_001),
    }, VIDEO_ID)).toThrow();
  });

  it.each([
    ["invalid job ID", { status: "queued", job_id: "../private-job" }],
    ["unknown status", { status: "finished", job_id: JOB_ID }],
    ["unknown top-level field", {
      video_id: VIDEO_ID,
      captions: [],
      message: "No captions",
      message_zh: "没有字幕",
      unexpected: "private",
    }],
    ["unknown track field", {
      video_id: VIDEO_ID,
      captions: [{
        language_code: "en",
        language_name: "English",
        unexpected: "private",
      }],
    }],
    ["conflicting generated flag", {
      video_id: VIDEO_ID,
      captions: [{
        language_code: "a.en",
        language_name: "English (auto)",
        is_generated: false,
      }],
    }],
    ["duplicate available language", {
      video_id: VIDEO_ID,
      language_code: "en",
      language_name: "English",
      format: "txt",
      content: "Caption",
      available_languages: ["en", "en"],
    }],
    ["invalid available language", {
      job_id: JOB_ID,
      status: "completed",
      language_code: "en",
      language_name: "English",
      format: "txt",
      content: "Caption",
      available_languages: ["en", "../private"],
    }],
    ["unsafe no-caption message", {
      video_id: VIDEO_ID,
      captions: [],
      message: "No captions\u0001private",
      message_zh: "没有字幕",
    }],
  ])("rejects %s without reflecting provider data", (_label, value) => {
    let error: unknown;
    try {
      parseTikHubCaptionResponse(value, VIDEO_ID);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("private");
    expect(JSON.stringify(error)).not.toContain("private");
  });
});
