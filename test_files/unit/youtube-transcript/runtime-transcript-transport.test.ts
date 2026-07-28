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
  timeoutHandler: (() => void) | null = null;
  readonly destroy = vi.fn((error?: Error) => {
    if (error) this.emit("error", error);
  });
  readonly armTimeout = vi.fn((_timeout: number, handler: () => void) => {
    this.timeoutHandler = handler;
    return this;
  });
  readonly disarmTimeout = vi.fn(() => {
    this.timeoutHandler = null;
  });
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
    expect(request.disarmTimeout).toHaveBeenCalledTimes(1);
    request.emit("close");
    expect(request.listenerCount("error")).toBe(0);
  });

  it("disarms timeout and detaches request/response listeners after success", async () => {
    const request = new FakeRequest();
    let response!: FakeResponse;
    const factory = vi.fn<RuntimeTranscriptRequestFactory>(
      (_url, _options, onResponse) => {
        response = new FakeResponse(200, {});
        queueMicrotask(() => {
          onResponse(response);
          response.emit("data", Buffer.from("ok"));
          response.emit("end");
        });
        return request;
      },
    );
    const transport = createRuntimeTranscriptHttpTransport({ request: factory });

    await expect(transport({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      method: "GET",
      headers: {},
    })).resolves.toMatchObject({ text: "ok" });

    const timeoutAfterSuccess = request.armTimeout.mock.calls[0]?.[1];
    timeoutAfterSuccess?.();
    expect(request.destroy).not.toHaveBeenCalled();
    expect(request.disarmTimeout).toHaveBeenCalledTimes(1);
    expect(request.listenerCount("error")).toBe(0);
    expect(response.listenerCount("data")).toBe(0);
    expect(response.listenerCount("end")).toBe(0);
    expect(response.listenerCount("error")).toBe(0);
  });

  it("terminates safely and cleans listeners when response data is invalid", async () => {
    const request = new FakeRequest();
    let response!: FakeResponse;
    const factory = vi.fn<RuntimeTranscriptRequestFactory>(
      (_url, _options, onResponse) => {
        response = new FakeResponse(200, {});
        queueMicrotask(() => {
          onResponse(response);
          response.emit("data", { unsafe: true });
        });
        return request;
      },
    );
    const transport = createRuntimeTranscriptHttpTransport({ request: factory });

    await expect(transport({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      method: "GET",
      headers: {},
    })).rejects.toThrow("Invalid transcript response body");
    expect(request.destroy).toHaveBeenCalledTimes(1);
    expect(request.disarmTimeout).toHaveBeenCalledTimes(1);
    request.emit("close");
    response.emit("close");
    expect(response.listenerCount("data")).toBe(0);
    expect(response.listenerCount("end")).toBe(0);
    expect(response.listenerCount("error")).toBe(0);
  });

  it("cleans every listener when the response stream fails", async () => {
    const request = new FakeRequest();
    let response!: FakeResponse;
    const factory = vi.fn<RuntimeTranscriptRequestFactory>(
      (_url, _options, onResponse) => {
        response = new FakeResponse(200, {});
        queueMicrotask(() => {
          onResponse(response);
          response.emit("error", new Error("stream failed"));
        });
        return request;
      },
    );
    const transport = createRuntimeTranscriptHttpTransport({ request: factory });

    await expect(transport({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      method: "GET",
      headers: {},
    })).rejects.toThrow("Transcript response failed");
    expect(request.disarmTimeout).toHaveBeenCalledTimes(1);
    request.emit("close");
    response.emit("close");
    expect(request.listenerCount("error")).toBe(0);
    expect(response.listenerCount("data")).toBe(0);
    expect(response.listenerCount("end")).toBe(0);
    expect(response.listenerCount("error")).toBe(0);
  });

  it("settles timeout once, destroys the request, and detaches listeners", async () => {
    const request = new FakeRequest();
    const factory = vi.fn<RuntimeTranscriptRequestFactory>(() => request);
    const transport = createRuntimeTranscriptHttpTransport({ request: factory });
    const pending = transport({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      method: "GET",
      headers: {},
    });

    request.armTimeout.mock.calls[0]?.[1]();

    await expect(pending).rejects.toThrow("Transcript request timed out");
    expect(request.destroy).toHaveBeenCalledTimes(1);
    expect(request.disarmTimeout).toHaveBeenCalledTimes(1);
    request.emit("close");
    expect(request.listenerCount("error")).toBe(0);
  });

  it("catches response-end assembly exceptions and performs full cleanup", async () => {
    const request = new FakeRequest();
    let response!: FakeResponse;
    const concat = vi.spyOn(Buffer, "concat").mockImplementationOnce(() => {
      throw new Error("assembly failed");
    });
    const factory = vi.fn<RuntimeTranscriptRequestFactory>(
      (_url, _options, onResponse) => {
        response = new FakeResponse(200, {});
        queueMicrotask(() => {
          onResponse(response);
          response.emit("data", Buffer.from("ok"));
          response.emit("end");
        });
        return request;
      },
    );
    const transport = createRuntimeTranscriptHttpTransport({ request: factory });

    await expect(transport({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      method: "GET",
      headers: {},
    })).rejects.toThrow("Invalid transcript response body");
    expect(request.destroy).toHaveBeenCalledTimes(1);
    expect(request.disarmTimeout).toHaveBeenCalledTimes(1);
    request.emit("close");
    response.emit("close");
    expect(response.listenerCount("data")).toBe(0);
    expect(response.listenerCount("end")).toBe(0);
    expect(response.listenerCount("error")).toBe(0);
    concat.mockRestore();
  });

  it("keeps a terminal request error sink until close after caller abort", async () => {
    const request = new FakeRequest();
    let hadTerminalSink = false;
    request.destroy.mockImplementation(() => {
      queueMicrotask(() => {
        hadTerminalSink = request.listenerCount("error") > 0;
        if (hadTerminalSink) request.emit("error", new Error("ECONNRESET"));
        request.emit("close");
      });
    });
    const transport = createRuntimeTranscriptHttpTransport({
      request: vi.fn<RuntimeTranscriptRequestFactory>(() => request),
    });
    const controller = new AbortController();
    const pending = transport({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      method: "GET",
      headers: {},
      signal: controller.signal,
    });

    controller.abort();

    await expect(pending).rejects.toThrow("Transcript request aborted");
    await Promise.resolve();
    expect(hadTerminalSink).toBe(true);
    expect(request.listenerCount("error")).toBe(0);
  });

  it("sinks late request and response errors after invalid chunks destroy the socket", async () => {
    const request = new FakeRequest();
    let response!: FakeResponse;
    let requestSinkPresent = false;
    let responseSinkPresent = false;
    request.destroy.mockImplementation(() => {
      queueMicrotask(() => {
        requestSinkPresent = request.listenerCount("error") > 0;
        responseSinkPresent = response.listenerCount("error") > 0;
        if (requestSinkPresent) request.emit("error", new Error("ECONNRESET"));
        if (responseSinkPresent) response.emit("error", new Error("aborted"));
        request.emit("close");
        response.emit("close");
      });
    });
    const transport = createRuntimeTranscriptHttpTransport({
      request: vi.fn<RuntimeTranscriptRequestFactory>(
        (_url, _options, onResponse) => {
          response = new FakeResponse(200, {});
          queueMicrotask(() => {
            onResponse(response);
            response.emit("data", { invalid: true });
          });
          return request;
        },
      ),
    });

    await expect(transport({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      method: "GET",
      headers: {},
    })).rejects.toThrow("Invalid transcript response body");
    await Promise.resolve();

    expect(requestSinkPresent).toBe(true);
    expect(responseSinkPresent).toBe(true);
    expect(request.listenerCount("error")).toBe(0);
    expect(response.listenerCount("error")).toBe(0);
  });

  it("destroys a constructed request when request.end throws synchronously", async () => {
    const request = new FakeRequest();
    let hadTerminalSink = false;
    request.end.mockImplementationOnce(() => {
      throw new Error("end failed");
    });
    request.destroy.mockImplementation(() => {
      queueMicrotask(() => {
        hadTerminalSink = request.listenerCount("error") > 0;
        if (hadTerminalSink) request.emit("error", new Error("ECONNRESET"));
        request.emit("close");
      });
    });
    const transport = createRuntimeTranscriptHttpTransport({
      request: vi.fn<RuntimeTranscriptRequestFactory>(() => request),
    });

    await expect(transport({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      method: "GET",
      headers: {},
    })).rejects.toThrow("Transcript request failed");
    await Promise.resolve();

    expect(request.destroy).toHaveBeenCalledTimes(1);
    expect(hadTerminalSink).toBe(true);
    expect(request.listenerCount("error")).toBe(0);
  });
});
