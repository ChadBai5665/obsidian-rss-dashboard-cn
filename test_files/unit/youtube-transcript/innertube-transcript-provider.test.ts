import { describe, expect, it, vi } from "vitest";

import {
  InnerTubeTranscriptProvider,
  type TranscriptHttpRequest,
  type TranscriptHttpResponse,
  type TranscriptHttpTransport,
} from "../../../src/youtube-transcript/innertube-transcript-provider";

const VIDEO_ID = "abcdefghijk";
const WATCH_URL =
  "https://www.youtube.com/watch?v=abcdefghijk&hl=en&persist_hl=1&has_verified=1&bpctr=9999999999";
const PLAYER_URL =
  "https://www.youtube.com/youtubei/v1/player?key=AIzaSyFixedPublicKey1234567890&prettyPrint=false";

function response(
  text: string,
  status = 200,
  headers: Record<string, string> = {},
): TranscriptHttpResponse {
  return { status, headers, text };
}

function watchHtml(
  overrides: {
    apiKey?: string;
    clientVersion?: string;
    visitorData?: string;
  } = {},
): string {
  const apiKey = overrides.apiKey ?? "AIzaSyFixedPublicKey1234567890";
  const clientVersion = overrides.clientVersion ?? "2.20260728.01.00";
  const visitorData = overrides.visitorData ?? "Cgtsafe-visitor_123%3D%3D";
  return `<html><script>ytcfg.set({"INNERTUBE_API_KEY":"${apiKey}","INNERTUBE_CLIENT_VERSION":"${clientVersion}","VISITOR_DATA":"${visitorData}","SECRET":"must-not-leak"});</script></html>`;
}

function captionTrack(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    baseUrl: `https://www.youtube.com/api/timedtext?v=${VIDEO_ID}&lang=en`,
    languageCode: "en",
    name: { simpleText: "English" },
    ...overrides,
  };
}

function playerWithTracks(
  tracks: readonly Record<string, unknown>[] = [captionTrack()],
): string {
  return JSON.stringify({
    playabilityStatus: { status: "OK" },
    captions: {
      playerCaptionsTracklistRenderer: { captionTracks: tracks },
    },
  });
}

function queuedTransport(
  responses: readonly (TranscriptHttpResponse | Error | DOMException)[],
): TranscriptHttpTransport & ReturnType<typeof vi.fn> {
  let index = 0;
  return vi.fn(async () => {
    const next = responses[index++];
    if (next instanceof Error || next instanceof DOMException) throw next;
    if (!next) throw new Error("Unexpected transport call");
    return next;
  });
}

function parseBody(request: TranscriptHttpRequest): Record<string, unknown> {
  return JSON.parse(request.body ?? "") as Record<string, unknown>;
}

describe("InnerTubeTranscriptProvider", () => {
  it("uses the fixed watch and Android player protocol and projects only safe tracks", async () => {
    const transport = queuedTransport([
      response(watchHtml()),
      response(
        playerWithTracks([
          captionTrack(),
          captionTrack({
            baseUrl: `https://www.youtube.com/api/timedtext?v=${VIDEO_ID}&lang=zh`,
            languageCode: "zh-Hans",
            kind: "asr",
            name: { runs: [{ text: "Chinese (auto-generated)" }] },
          }),
        ]),
      ),
    ]);

    const provider = new InnerTubeTranscriptProvider(transport);
    const tracks = await provider.listTracks(VIDEO_ID);

    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[0]?.[0]).toMatchObject({
      url: WATCH_URL,
      method: "GET",
      body: undefined,
    });
    const playerRequest = transport.mock.calls[1]?.[0] as TranscriptHttpRequest;
    expect(playerRequest).toMatchObject({
      url: PLAYER_URL,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-YouTube-Client-Name": "3",
        "X-YouTube-Client-Version": "20.10.38",
        "X-Goog-Visitor-Id": "Cgtsafe-visitor_123%3D%3D",
      },
    });
    expect(parseBody(playerRequest)).toEqual({
      context: {
        client: {
          hl: "en",
          gl: "US",
          utcOffsetMinutes: 0,
          visitorData: "Cgtsafe-visitor_123%3D%3D",
          clientName: "ANDROID",
          clientVersion: "20.10.38",
          clientFormFactor: "SMALL_FORM_FACTOR",
          androidSdkVersion: 34,
          osName: "Android",
          osVersion: "14",
          platform: "MOBILE",
        },
        request: { useSsl: true },
      },
      videoId: VIDEO_ID,
    });
    expect(tracks).toEqual([
      {
        languageCode: "en",
        languageName: "English",
        isGenerated: false,
        source: "innertube",
        url: `https://www.youtube.com/api/timedtext?v=${VIDEO_ID}&lang=en&fmt=json3`,
        format: "json3",
      },
      {
        languageCode: "zh-Hans",
        languageName: "Chinese (auto-generated)",
        isGenerated: true,
        source: "innertube",
        url: `https://www.youtube.com/api/timedtext?v=${VIDEO_ID}&lang=zh&fmt=json3`,
        format: "json3",
      },
    ]);
    expect(Object.isFrozen(tracks[0])).toBe(true);
    expect(JSON.stringify(tracks)).not.toContain("SECRET");
  });

  it("tries Android, web, then iOS only for structurally unsupported player responses", async () => {
    const transport = queuedTransport([
      response(watchHtml()),
      response(JSON.stringify({ responseContext: {} })),
      response(JSON.stringify({ playabilityStatus: {} })),
      response(playerWithTracks()),
    ]);

    const tracks = await new InnerTubeTranscriptProvider(transport).listTracks(
      VIDEO_ID,
    );

    expect(tracks).toHaveLength(1);
    expect(transport).toHaveBeenCalledTimes(4);
    const requests = transport.mock.calls
      .slice(1)
      .map((call) => call[0] as TranscriptHttpRequest);
    expect(
      requests.map((request) => request.headers["X-YouTube-Client-Name"]),
    ).toEqual(["3", "1", "5"]);
    expect(
      requests.map((request) => request.headers["X-YouTube-Client-Version"]),
    ).toEqual(["20.10.38", "2.20260728.01.00", "20.10.4"]);
    expect(
      requests.map(
        (request) =>
          (
            (parseBody(request).context as Record<string, unknown>)
              .client as Record<string, unknown>
          ).clientName,
      ),
    ).toEqual(["ANDROID", "WEB", "IOS"]);
  });

  it("fetches the selected timed-text URL exactly once through the Task 1 parser", async () => {
    const transport = queuedTransport([
      response(watchHtml()),
      response(playerWithTracks()),
      response(
        JSON.stringify({
          events: [
            { tStartMs: 0, segs: [{ utf8: "Hello" }] },
            { tStartMs: 500, segs: [{ utf8: "world" }] },
          ],
        }),
      ),
    ]);
    const provider = new InnerTubeTranscriptProvider(transport);
    const [track] = await provider.listTracks(VIDEO_ID);

    const transcript = await provider.fetchTrack(track);

    expect(transport).toHaveBeenCalledTimes(3);
    expect(transport.mock.calls[2]?.[0]).toMatchObject({
      method: "GET",
      url: `https://www.youtube.com/api/timedtext?v=${VIDEO_ID}&lang=en&fmt=json3`,
    });
    expect(transcript).toEqual({
      videoId: VIDEO_ID,
      languageCode: "en",
      languageName: "English",
      isGenerated: false,
      provider: "innertube",
      text: "Hello\nworld",
    });
  });

  it.each([
    ["LOGIN_REQUIRED", "Sign in to confirm your age", "login-required"],
    ["ERROR", "This video is unavailable", "video-unavailable"],
    ["UNPLAYABLE", "This video is private", "video-unavailable"],
    [
      "LOGIN_REQUIRED",
      "Sign in to confirm you are not a bot",
      "temporarily-unavailable",
    ],
  ])(
    "maps authoritative %s status without trying another client",
    async (status, reason, code) => {
      const transport = queuedTransport([
        response(watchHtml()),
        response(JSON.stringify({ playabilityStatus: { status, reason } })),
      ]);

      await expect(
        new InnerTubeTranscriptProvider(transport).listTracks(VIDEO_ID),
      ).rejects.toMatchObject({ code });
      expect(transport).toHaveBeenCalledTimes(2);
    },
  );

  it("returns no-captions without trying another client for an authoritative playable response", async () => {
    const transport = queuedTransport([
      response(watchHtml()),
      response(JSON.stringify({ playabilityStatus: { status: "OK" } })),
    ]);

    await expect(
      new InnerTubeTranscriptProvider(transport).listTracks(VIDEO_ID),
    ).rejects.toMatchObject({ code: "no-captions" });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("validates video IDs before invoking the transport", async () => {
    const transport = queuedTransport([]);

    await expect(
      new InnerTubeTranscriptProvider(transport).listTracks(
        "https://youtu.be/abcdefghijk",
      ),
    ).rejects.toMatchObject({ code: "invalid-video-id" });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    [404, "video-unavailable"],
    [410, "video-unavailable"],
    [401, "login-required"],
    [403, "login-required"],
    [408, "timeout"],
    [429, "temporarily-unavailable"],
    [500, "temporarily-unavailable"],
    [504, "timeout"],
  ])("maps watch HTTP %i to %s", async (status, code) => {
    const transport = queuedTransport([response("unsafe raw body", status)]);

    await expect(
      new InnerTubeTranscriptProvider(transport).listTracks(VIDEO_ID),
    ).rejects.toMatchObject({ code, message: code });
  });

  it("maps abort and timeout transport failures without exposing raw messages", async () => {
    const timeout = Object.assign(new Error("private socket details"), {
      name: "TimeoutError",
    });
    const timedOutTransport = queuedTransport([timeout]);
    await expect(
      new InnerTubeTranscriptProvider(timedOutTransport).listTracks(VIDEO_ID),
    ).rejects.toMatchObject({ code: "timeout", message: "timeout" });

    const controller = new AbortController();
    const abortTransport: TranscriptHttpTransport = async () => {
      controller.abort();
      throw new Error("private abort details");
    };
    await expect(
      new InnerTubeTranscriptProvider(abortTransport).listTracks(
        VIDEO_ID,
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "aborted", message: "aborted" });
  });

  it("maps a native AbortError even when the caller signal has not changed", async () => {
    const transport = queuedTransport([
      new DOMException("private abort details", "AbortError"),
    ]);

    await expect(
      new InnerTubeTranscriptProvider(transport).listTracks(VIDEO_ID),
    ).rejects.toMatchObject({ code: "aborted", message: "aborted" });
  });

  it("does no work when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const transport = queuedTransport([]);

    await expect(
      new InnerTubeTranscriptProvider(transport).listTracks(
        VIDEO_ID,
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    ["missing API key", "<html></html>"],
    ["unsafe API key", watchHtml({ apiKey: "bad/key" })],
    ["unsafe visitor data", watchHtml({ visitorData: "unsafe visitor value" })],
    ["oversized page", "x".repeat(2_000_001)],
  ])("rejects a %s as temporarily unavailable", async (_name, html) => {
    const transport = queuedTransport([response(html)]);

    await expect(
      new InnerTubeTranscriptProvider(transport).listTracks(VIDEO_ID),
    ).rejects.toMatchObject({ code: "temporarily-unavailable" });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["malformed JSON", "{"],
    ["oversized JSON", "x".repeat(2_000_001)],
    ["non-object JSON", "[]"],
  ])("rejects %s player data without retries", async (_name, playerText) => {
    const transport = queuedTransport([
      response(watchHtml()),
      response(playerText),
    ]);

    await expect(
      new InnerTubeTranscriptProvider(transport).listTracks(VIDEO_ID),
    ).rejects.toMatchObject({ code: "temporarily-unavailable" });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["http protocol", `http://www.youtube.com/api/timedtext?v=${VIDEO_ID}`],
    [
      "credentials",
      `https://user:pass@www.youtube.com/api/timedtext?v=${VIDEO_ID}`,
    ],
    ["fragment", `https://www.youtube.com/api/timedtext?v=${VIDEO_ID}#secret`],
    ["custom port", `https://www.youtube.com:444/api/timedtext?v=${VIDEO_ID}`],
    [
      "lookalike host",
      `https://www.youtube.com.evil.test/api/timedtext?v=${VIDEO_ID}`,
    ],
    ["unapproved host", `https://example.com/api/timedtext?v=${VIDEO_ID}`],
  ])("rejects a caption URL with %s", async (_name, baseUrl) => {
    const transport = queuedTransport([
      response(watchHtml()),
      response(playerWithTracks([captionTrack({ baseUrl })])),
    ]);

    await expect(
      new InnerTubeTranscriptProvider(transport).listTracks(VIDEO_ID),
    ).rejects.toMatchObject({ code: "temporarily-unavailable" });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed and excessive track data", async () => {
    const malformed = queuedTransport([
      response(watchHtml()),
      response(playerWithTracks([captionTrack({ languageCode: "bad value" })])),
    ]);
    await expect(
      new InnerTubeTranscriptProvider(malformed).listTracks(VIDEO_ID),
    ).rejects.toMatchObject({ code: "temporarily-unavailable" });

    const excessive = queuedTransport([
      response(watchHtml()),
      response(
        playerWithTracks(Array.from({ length: 101 }, () => captionTrack())),
      ),
    ]);
    await expect(
      new InnerTubeTranscriptProvider(excessive).listTracks(VIDEO_ID),
    ).rejects.toMatchObject({ code: "temporarily-unavailable" });
  });

  it("rejects unlisted or mutated tracks before a timed-text request", async () => {
    const transport = queuedTransport([
      response(watchHtml()),
      response(playerWithTracks()),
    ]);
    const provider = new InnerTubeTranscriptProvider(transport);
    const [track] = await provider.listTracks(VIDEO_ID);
    const copy = { ...track };

    await expect(provider.fetchTrack(copy)).rejects.toMatchObject({
      code: "temporarily-unavailable",
    });
    expect(() => {
      (track as { languageName: string }).languageName = "Changed";
    }).toThrow();
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("allows bounded redirects only on approved hosts", async () => {
    const redirectedWatch = `https://m.youtube.com/watch?v=${VIDEO_ID}&hl=en&persist_hl=1&has_verified=1&bpctr=9999999999`;
    const transport = queuedTransport([
      response("", 302, { Location: redirectedWatch }),
      response(watchHtml()),
      response(playerWithTracks()),
      response("", 302, {
        location: `https://rr1---sn-safe.googlevideo.com/api/timedtext?v=${VIDEO_ID}&lang=en&fmt=json3`,
      }),
      response(
        JSON.stringify({ events: [{ tStartMs: 0, segs: [{ utf8: "Safe" }] }] }),
      ),
    ]);
    const provider = new InnerTubeTranscriptProvider(transport);
    const [track] = await provider.listTracks(VIDEO_ID);
    const transcript = await provider.fetchTrack(track);

    expect(transcript.text).toBe("Safe");
    expect(transport.mock.calls[1]?.[0]).toMatchObject({
      url: redirectedWatch,
      method: "GET",
    });
    const redirectedCaption = transport.mock
      .calls[4]?.[0] as TranscriptHttpRequest;
    expect(redirectedCaption.url).toContain("googlevideo.com/api/timedtext");
    expect(redirectedCaption.headers).not.toHaveProperty("Origin");
    expect(redirectedCaption.headers).not.toHaveProperty("Referer");
    expect(
      Object.keys(redirectedCaption.headers).some((name) =>
        name.toLowerCase().startsWith("x-"),
      ),
    ).toBe(false);
  });

  it.each([
    ["watch host", "https://evil.test/watch"],
    ["player credentials", "https://user@www.youtube.com/youtubei/v1/player"],
  ])("rejects an unsafe redirect for %s", async (_name, location) => {
    const transport = queuedTransport([response("", 302, { location })]);

    await expect(
      new InnerTubeTranscriptProvider(transport).listTracks(VIDEO_ID),
    ).rejects.toMatchObject({ code: "temporarily-unavailable" });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("rejects timed-text redirects to non-caption hosts", async () => {
    const transport = queuedTransport([
      response(watchHtml()),
      response(playerWithTracks()),
      response("", 302, { location: "https://evil.test/caption" }),
    ]);
    const provider = new InnerTubeTranscriptProvider(transport);
    const [track] = await provider.listTracks(VIDEO_ID);

    await expect(provider.fetchTrack(track)).rejects.toMatchObject({
      code: "temporarily-unavailable",
    });
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it("caps redirect hops and response bodies", async () => {
    const redirects = Array.from({ length: 4 }, (_, index) =>
      response("", 302, {
        location: `https://www.youtube.com/watch?v=${VIDEO_ID}&hop=${index}`,
      }),
    );
    const redirectTransport = queuedTransport(redirects);
    await expect(
      new InnerTubeTranscriptProvider(redirectTransport).listTracks(VIDEO_ID),
    ).rejects.toMatchObject({ code: "temporarily-unavailable" });
    expect(redirectTransport).toHaveBeenCalledTimes(4);

    const contentLengthTransport = queuedTransport([
      response("small", 200, { "Content-Length": "2000001" }),
    ]);
    await expect(
      new InnerTubeTranscriptProvider(contentLengthTransport).listTracks(
        VIDEO_ID,
      ),
    ).rejects.toMatchObject({ code: "temporarily-unavailable" });
  });
});
