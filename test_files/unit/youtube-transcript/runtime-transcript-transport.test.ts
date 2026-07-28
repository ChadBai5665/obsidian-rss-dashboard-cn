import { EventEmitter } from "node:events";
import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import {
  createRuntimeTranscriptHttpTransport,
  type RuntimeTranscriptRequest,
  type RuntimeTranscriptRequestFactory,
  type RuntimeTranscriptResponse,
} from "../../../src/youtube-transcript/runtime-transcript-transport";

class FakeResponse extends EventEmitter implements RuntimeTranscriptResponse {
  constructor(
    readonly statusCode: number,
    readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  ) {
    super();
  }
}

class FakeRequest extends EventEmitter implements RuntimeTranscriptRequest {
  readonly destroy = vi.fn((error?: Error) => {
    if (error) this.emit("error", error);
  });
  readonly armTimeout = vi.fn((_timeout: number, _handler: () => void) => this);
  readonly end = vi.fn((_body?: string) => undefined);
}

function factoryResponding(
  status: number,
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  chunks: readonly string[],
) {
  const request = new FakeRequest();
  const factory = vi.fn<RuntimeTranscriptRequestFactory>(
    (_url, _options, onResponse) => {
      const response = new FakeResponse(status, headers);
      queueMicrotask(() => {
        onResponse(response);
        for (const chunk of chunks) response.emit("data", Buffer.from(chunk));
        response.emit("end");
      });
      return request;
    },
  );
  return { factory, request };
}

describe("runtime transcript HTTPS transport", () => {
  it.each([
    "http://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://user:pass@www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com:444/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ#fragment",
  ])("rejects an unsafe outbound URL before opening a socket: %s", async (url) => {
    const factory = vi.fn<RuntimeTranscriptRequestFactory>();
    const transport = createRuntimeTranscriptHttpTransport({ request: factory });

    await expect(
      transport({ url, method: "GET", headers: {} }),
    ).rejects.toThrow("Unsafe transcript request");
    expect(factory).not.toHaveBeenCalled();
  });

  it("rejects credential and connection headers and never reads cookies", async () => {
    const factory = vi.fn<RuntimeTranscriptRequestFactory>();
    const transport = createRuntimeTranscriptHttpTransport({ request: factory });

    for (const name of ["Cookie", "Authorization", "Host", "Connection"]) {
      await expect(
        transport({
          url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          method: "GET",
          headers: { [name]: "private" },
        }),
      ).rejects.toThrow("Unsafe transcript request headers");
    }
    expect(factory).not.toHaveBeenCalled();
  });

  it("returns a bounded redirect response without following or forwarding headers", async () => {
    const { factory } = factoryResponding(
      302,
      {
        location: "https://evil.example/redirect",
        "content-type": "text/plain",
        "set-cookie": "private=value",
      },
      ["redirect"],
    );
    const transport = createRuntimeTranscriptHttpTransport({ request: factory });

    const result = await transport({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      method: "GET",
      headers: { "User-Agent": "fixed-client" },
    });

    expect(factory).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      status: 302,
      headers: {
        location: "https://evil.example/redirect",
        "content-type": "text/plain",
      },
      text: "redirect",
    });
    const requestOptions = factory.mock.calls[0]?.[1];
    expect(requestOptions?.headers).toMatchObject({
      "User-Agent": "fixed-client",
      "Accept-Encoding": "identity",
    });
    expect(Object.keys(requestOptions?.headers ?? {})).not.toContain("Cookie");
  });

  it("allows only YouTube and Googlevideo caption hosts", async () => {
    const youtube = factoryResponding(200, {}, ["ok"]);
    const googlevideo = factoryResponding(200, {}, ["captions"]);
    const first = createRuntimeTranscriptHttpTransport({ request: youtube.factory });
    const second = createRuntimeTranscriptHttpTransport({ request: googlevideo.factory });

    await expect(first({
      url: "https://www.youtube.com/youtubei/v1/player?key=fixed",
      method: "POST",
      headers: {},
      body: "{}",
    })).resolves.toMatchObject({ status: 200, text: "ok" });
    await expect(second({
      url: "https://rr1---sn.example.googlevideo.com/api/timedtext?v=dQw4w9WgXcQ",
      method: "GET",
      headers: {},
    })).resolves.toMatchObject({ status: 200, text: "captions" });
  });

  it("destroys an oversized response instead of retaining it", async () => {
    const { factory, request } = factoryResponding(200, {}, ["x".repeat(33)]);
    const transport = createRuntimeTranscriptHttpTransport({
      request: factory,
      maxResponseBytes: 32,
    });

    await expect(transport({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      method: "GET",
      headers: {},
    })).rejects.toThrow("Transcript response is too large");
    expect(request.destroy).toHaveBeenCalled();
  });

  it("propagates caller abort and owns a finite socket timeout", async () => {
    const request = new FakeRequest();
    const factory = vi.fn<RuntimeTranscriptRequestFactory>(() => request);
    const transport = createRuntimeTranscriptHttpTransport({ request: factory });
    const controller = new AbortController();
    const pending = transport({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      method: "GET",
      headers: {},
      signal: controller.signal,
    });

    expect(request.armTimeout).toHaveBeenCalledWith(20_000, expect.any(Function));
    controller.abort();
    await expect(pending).rejects.toThrow("Transcript request aborted");
    expect(request.destroy).toHaveBeenCalled();
  });
});
