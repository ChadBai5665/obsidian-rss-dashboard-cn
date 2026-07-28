import { constants } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { TranscriptHttpTransport } from "../../../src/youtube-transcript/innertube-transcript-provider";
import {
  YtDlpTranscriptProvider,
  type ExecutableRunner,
  type YtDlpExecutableAccess,
} from "../../../src/youtube-transcript/yt-dlp-transcript-provider";

const VIDEO_ID = "abcdefghijk";
const WATCH_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;
const CAPTION_URL = `https://www.youtube.com/api/timedtext?v=${VIDEO_ID}&lang=en`;
const FIXED_ARGS = [
  "--dump-single-json",
  "--skip-download",
  "--no-warnings",
  "--no-playlist",
  "--socket-timeout",
  "15",
  "--",
  WATCH_URL,
] as const;

function metadata(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: VIDEO_ID,
    subtitles: {
      en: [{ ext: "json3", url: CAPTION_URL, name: "English" }],
    },
    automatic_captions: {},
    private_payload: "must-not-leak",
    ...overrides,
  });
}

function runnerReturning(
  stdout: string,
  stderr = "private stderr",
): ExecutableRunner & { execFile: ReturnType<typeof vi.fn> } {
  return {
    execFile: vi.fn(async () => ({ stdout, stderr })),
  };
}

function transportReturning(
  text: string,
  status = 200,
  headers: Record<string, string> = {},
): TranscriptHttpTransport & ReturnType<typeof vi.fn<TranscriptHttpTransport>> {
  return vi.fn(async () => ({ status, headers, text }));
}

function accessOnly(
  executable: string | undefined,
): YtDlpExecutableAccess & ReturnType<typeof vi.fn> {
  return vi.fn(async (path, mode) => {
    expect(mode).toBe(constants.X_OK);
    if (path !== executable) {
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    }
  });
}

function providerWith(
  runner: ExecutableRunner,
  access: YtDlpExecutableAccess,
  transport: TranscriptHttpTransport = transportReturning(""),
): YtDlpTranscriptProvider {
  return new YtDlpTranscriptProvider(transport, {
    runner,
    access,
    pathValue: "/safe/bin:/second/bin",
    homeDirectory: "/Users/tester",
  });
}

describe("YtDlpTranscriptProvider", () => {
  it("discovers yt-dlp from PATH and executes the fixed metadata-only command once", async () => {
    const runner = runnerReturning(metadata());
    const access = accessOnly("/safe/bin/yt-dlp");
    const controller = new AbortController();
    const provider = providerWith(runner, access);

    const tracks = await provider.listTracks(VIDEO_ID, controller.signal);

    expect(access).toHaveBeenCalledWith("/safe/bin/yt-dlp", constants.X_OK);
    expect(runner.execFile).toHaveBeenCalledTimes(1);
    const [file, args, options] = runner.execFile.mock.calls[0] ?? [];
    expect(file).toBe("/safe/bin/yt-dlp");
    expect(args).toEqual(FIXED_ARGS);
    expect(options).toEqual({
      timeout: 20_000,
      maxBuffer: 2_000_000,
      signal: controller.signal,
    });
    expect(options).not.toHaveProperty("shell", true);
    expect(args).not.toEqual(
      expect.arrayContaining([
        "--cookies",
        "--cookies-from-browser",
        "--username",
        "--password",
        "--output",
        "--write-subs",
        "--write-auto-subs",
        "--extract-audio",
        "--format",
      ]),
    );
    expect(tracks).toHaveLength(1);
  });

  it.each([
    ["second PATH entry", "/second/bin/yt-dlp"],
    ["Apple Silicon Homebrew", "/opt/homebrew/bin/yt-dlp"],
    ["Intel Homebrew", "/usr/local/bin/yt-dlp"],
    ["user-local install", "/Users/tester/.local/bin/yt-dlp"],
  ])("discovers the documented %s candidate", async (_name, executable) => {
    const runner = runnerReturning(metadata());
    const provider = providerWith(runner, accessOnly(executable));

    await provider.listTracks(VIDEO_ID);

    expect(runner.execFile).toHaveBeenCalledOnce();
    expect(runner.execFile.mock.calls[0]?.[0]).toBe(executable);
  });

  it("treats a missing executable as unavailable without running a process", async () => {
    const runner = runnerReturning(metadata());
    const provider = providerWith(runner, accessOnly(undefined));

    await expect(provider.isAvailable()).resolves.toBe(false);
    await expect(provider.listTracks(VIDEO_ID)).rejects.toMatchObject({
      code: "temporarily-unavailable",
      message: "temporarily-unavailable",
    });
    expect(runner.execFile).not.toHaveBeenCalled();
  });

  it("rejects invalid video IDs before discovery or execution", async () => {
    const runner = runnerReturning(metadata());
    const access = accessOnly("/safe/bin/yt-dlp");
    const provider = providerWith(runner, access);

    await expect(
      provider.listTracks("https://youtu.be/abcdefghijk"),
    ).rejects.toMatchObject({ code: "invalid-video-id" });
    expect(access).not.toHaveBeenCalled();
    expect(runner.execFile).not.toHaveBeenCalled();
  });

  it.each([
    [
      Object.assign(new Error("private executable path"), { code: "ENOENT" }),
      "temporarily-unavailable",
    ],
    [
      Object.assign(new Error("private timeout details"), {
        name: "TimeoutError",
        killed: true,
      }),
      "timeout",
    ],
    [
      Object.assign(new Error("private abort details"), {
        name: "AbortError",
        killed: true,
      }),
      "aborted",
    ],
    [
      Object.assign(new Error("private max-buffer details"), {
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      }),
      "temporarily-unavailable",
    ],
  ])(
    "maps runner failures to stable errors without exposing stderr",
    async (failure, code) => {
      const runner: ExecutableRunner & { execFile: ReturnType<typeof vi.fn> } =
        {
          execFile: vi.fn(async () => {
            throw failure;
          }),
        };
      const provider = providerWith(runner, accessOnly("/safe/bin/yt-dlp"));

      const rejection = provider.listTracks(VIDEO_ID);
      await expect(rejection).rejects.toMatchObject({ code, message: code });
      await expect(rejection).rejects.not.toThrow(/private/iu);
      expect(runner.execFile).toHaveBeenCalledOnce();
    },
  );

  it("forwards AbortSignal so an in-flight child can be killed", async () => {
    const runner: ExecutableRunner & { execFile: ReturnType<typeof vi.fn> } = {
      execFile: vi.fn(
        (_file, _args, options) =>
          new Promise((_resolve, reject) => {
            options.signal?.addEventListener(
              "abort",
              () =>
                reject(
                  Object.assign(new Error("private"), { name: "AbortError" }),
                ),
              { once: true },
            );
          }),
      ),
    };
    const controller = new AbortController();
    const provider = providerWith(runner, accessOnly("/safe/bin/yt-dlp"));

    const pending = provider.listTracks(VIDEO_ID, controller.signal);
    await vi.waitFor(() => expect(runner.execFile).toHaveBeenCalledOnce());
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    expect(runner.execFile).toHaveBeenCalledOnce();
  });

  it("projects one preferred format per manual and generated language", async () => {
    const runner = runnerReturning(
      metadata({
        subtitles: {
          en: [
            { ext: "vtt", url: `${CAPTION_URL}&fmt=vtt`, name: "English VTT" },
            {
              ext: "srv3",
              url: `${CAPTION_URL}&fmt=srv3`,
              name: "English SRV",
            },
            {
              ext: "json3",
              url: `${CAPTION_URL}&fmt=json3`,
              name: "English manual",
            },
            { ext: "ttml", url: `${CAPTION_URL}&fmt=ttml` },
          ],
          fr: [{ ext: "vtt", url: `${CAPTION_URL}&lang=fr&fmt=vtt` }],
        },
        automatic_captions: {
          "zh-Hans": [
            { ext: "vtt", url: `${CAPTION_URL}&lang=zh-Hans&fmt=vtt` },
            {
              ext: "srv3",
              url: `${CAPTION_URL}&lang=zh-Hans&fmt=srv3`,
              name: "中文（自动生成）",
            },
          ],
        },
      }),
    );
    const tracks = await providerWith(
      runner,
      accessOnly("/safe/bin/yt-dlp"),
    ).listTracks(VIDEO_ID);

    expect(tracks).toEqual([
      {
        languageCode: "en",
        languageName: "English manual",
        isGenerated: false,
        source: "yt-dlp",
        url: `${CAPTION_URL}&fmt=json3`,
        format: "json3",
      },
      {
        languageCode: "fr",
        languageName: "fr",
        isGenerated: false,
        source: "yt-dlp",
        url: `${CAPTION_URL}&lang=fr&fmt=vtt`,
        format: "vtt",
      },
      {
        languageCode: "zh-Hans",
        languageName: "中文（自动生成）",
        isGenerated: true,
        source: "yt-dlp",
        url: `${CAPTION_URL}&lang=zh-Hans&fmt=srv3`,
        format: "srv3",
      },
    ]);
    expect(tracks.every(Object.isFrozen)).toBe(true);
    expect(JSON.stringify(tracks)).not.toContain("must-not-leak");
  });

  it.each([
    ["non-object root", "[]"],
    ["wrong video", metadata({ id: "zyxwvutsrqp" })],
    ["missing video ID", metadata({ id: undefined })],
    ["malformed subtitles", metadata({ subtitles: [] })],
    ["malformed language entries", metadata({ subtitles: { en: {} } })],
    [
      "too many languages",
      metadata({
        subtitles: Object.fromEntries(
          Array.from({ length: 101 }, (_, index) => [`x-${index}`, []]),
        ),
      }),
    ],
    ["oversized metadata", "x".repeat(2_000_001)],
    ["malformed JSON", "{private raw metadata"],
  ])(
    "rejects %s metadata without retaining raw data",
    async (_name, stdout) => {
      const runner = runnerReturning(stdout);
      const provider = providerWith(runner, accessOnly("/safe/bin/yt-dlp"));

      const rejection = provider.listTracks(VIDEO_ID);
      await expect(rejection).rejects.toMatchObject({
        code: "temporarily-unavailable",
        message: "temporarily-unavailable",
      });
      await expect(rejection).rejects.not.toThrow(/private|must-not-leak/iu);
    },
  );

  it.each([
    "http://www.youtube.com/api/timedtext?v=abcdefghijk",
    "https://user:pass@www.youtube.com/api/timedtext?v=abcdefghijk",
    "https://www.youtube.com:444/api/timedtext?v=abcdefghijk",
    "https://www.youtube.com/api/timedtext?v=abcdefghijk#fragment",
    "https://evil.example/api/timedtext?v=abcdefghijk",
    "https://www.youtube.com/watch?v=abcdefghijk",
  ])("rejects unsafe supported subtitle URL %s", async (url) => {
    const runner = runnerReturning(
      metadata({ subtitles: { en: [{ ext: "json3", url }] } }),
    );
    const provider = providerWith(runner, accessOnly("/safe/bin/yt-dlp"));

    await expect(provider.listTracks(VIDEO_ID)).rejects.toMatchObject({
      code: "temporarily-unavailable",
    });
  });

  it("reports no-captions distinctly when no supported public tracks exist", async () => {
    const runner = runnerReturning(
      metadata({
        subtitles: { en: [{ ext: "ttml", url: CAPTION_URL }] },
        automatic_captions: {},
      }),
    );

    await expect(
      providerWith(runner, accessOnly("/safe/bin/yt-dlp")).listTracks(VIDEO_ID),
    ).rejects.toMatchObject({ code: "no-captions", message: "no-captions" });
  });

  it("fetches a registered public track once and delegates to the bounded parser", async () => {
    const runner = runnerReturning(metadata());
    const transport = transportReturning(
      JSON.stringify({
        events: [
          { tStartMs: 0, segs: [{ utf8: "Hello" }] },
          { tStartMs: 500, segs: [{ utf8: "world" }] },
        ],
      }),
    );
    const provider = providerWith(
      runner,
      accessOnly("/safe/bin/yt-dlp"),
      transport,
    );
    const [track] = await provider.listTracks(VIDEO_ID);

    const transcript = await provider.fetchTrack(track);

    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]?.[0]).toMatchObject({
      method: "GET",
      url: CAPTION_URL,
      body: undefined,
    });
    expect(transcript).toEqual({
      videoId: VIDEO_ID,
      languageCode: "en",
      languageName: "English",
      isGenerated: false,
      provider: "yt-dlp",
      text: "Hello\nworld",
    });
  });

  it("rejects forged or mutated tracks before HTTP access", async () => {
    const runner = runnerReturning(metadata());
    const transport = transportReturning("");
    const provider = providerWith(
      runner,
      accessOnly("/safe/bin/yt-dlp"),
      transport,
    );
    const [track] = await provider.listTracks(VIDEO_ID);
    const forged = { ...track };

    await expect(provider.fetchTrack(forged)).rejects.toMatchObject({
      code: "temporarily-unavailable",
    });
    await expect(
      provider.fetchTrack({
        ...track,
        url: "https://evil.example/api/timedtext",
      }),
    ).rejects.toMatchObject({ code: "temporarily-unavailable" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("bounds caption responses and validates redirects before following them", async () => {
    const runner = runnerReturning(metadata());
    const transport = vi.fn<TranscriptHttpTransport>().mockResolvedValueOnce({
      status: 302,
      headers: { location: "https://evil.example/api/timedtext" },
      text: "",
    });
    const provider = providerWith(
      runner,
      accessOnly("/safe/bin/yt-dlp"),
      transport,
    );
    const [track] = await provider.listTracks(VIDEO_ID);

    await expect(provider.fetchTrack(track)).rejects.toMatchObject({
      code: "temporarily-unavailable",
    });
    expect(transport).toHaveBeenCalledOnce();

    const oversizedTransport = transportReturning("x".repeat(2_000_001));
    const secondProvider = providerWith(
      runnerReturning(metadata()),
      accessOnly("/safe/bin/yt-dlp"),
      oversizedTransport,
    );
    const [secondTrack] = await secondProvider.listTracks(VIDEO_ID);
    await expect(secondProvider.fetchTrack(secondTrack)).rejects.toMatchObject({
      code: "temporarily-unavailable",
    });
  });

  it("strips origin-bound headers before a safe cross-origin caption redirect", async () => {
    const redirectedUrl = `https://rr1---sn-safe.googlevideo.com/api/timedtext?v=${VIDEO_ID}&lang=en`;
    const transport = vi
      .fn<TranscriptHttpTransport>()
      .mockResolvedValueOnce({
        status: 302,
        headers: { location: redirectedUrl },
        text: "",
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        text: JSON.stringify({
          events: [{ tStartMs: 0, segs: [{ utf8: "Safe" }] }],
        }),
      });
    const provider = providerWith(
      runnerReturning(metadata()),
      accessOnly("/safe/bin/yt-dlp"),
      transport,
    );
    const [track] = await provider.listTracks(VIDEO_ID);

    await expect(provider.fetchTrack(track)).resolves.toMatchObject({
      text: "Safe",
    });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[0]?.[0].headers).toMatchObject({
      Origin: "https://www.youtube.com",
      Referer: WATCH_URL,
    });
    expect(transport.mock.calls[1]?.[0].headers).not.toHaveProperty("Origin");
    expect(transport.mock.calls[1]?.[0].headers).not.toHaveProperty("Referer");
  });
});
