import { Buffer } from "node:buffer";
import { getEventListeners } from "node:events";
import {
  ClientRequest,
  IncomingMessage,
  createServer,
  type Server,
  type ServerResponse,
} from "node:http";
import { Socket } from "node:net";
import {
  clearTimeout as cancelTimer,
  setImmediate as scheduleImmediate,
  setTimeout as scheduleTimer,
} from "node:timers";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createNodeAiStreamingTransport,
  MAX_AI_STREAM_REQUEST_BODY_BYTES,
  validateAiStreamingRedirect,
} from "../../../../src/ai/providers/streaming-ai-transport";
import { ProviderError } from "../../../../src/ai/providers/provider-error";
import type {
  AiTransportRequest,
  TextGenerationProvider,
} from "../../../../src/ai/providers/text-generation-provider";

interface LocalServer {
  server: Server;
  origin: string;
  close(): Promise<void>;
}

const servers = new Set<LocalServer>();

afterEach(async () => {
  const pending = [...servers];
  servers.clear();
  await Promise.all(pending.map((server) => server.close()));
  vi.restoreAllMocks();
});

async function localServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<LocalServer> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  const fixture: LocalServer = {
    server,
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      if (!server.listening) return;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  servers.add(fixture);
  return fixture;
}

function request(
  url: string,
  overrides: Partial<AiTransportRequest> = {},
): AiTransportRequest {
  return {
    url,
    method: "POST",
    headers: {
      authorization: "Bearer test-key",
      "content-type": "application/json",
    },
    body: "{\"prompt\":\"hello\"}",
    ...overrides,
  };
}

function expectProviderCode(error: unknown, code: ProviderError["code"]): void {
  expect(error).toBeInstanceOf(ProviderError);
  expect((error as ProviderError).code).toBe(code);
  expect(Object.prototype.hasOwnProperty.call(error, "cause")).toBe(false);
}

describe("secure AI streaming transport", () => {
  it("sends the exact request and delivers successful SSE chunks in order", async () => {
    let observedMethod = "";
    let observedAuthorization = "";
    let observedBody = "";
    const fixture = await localServer((incoming, response) => {
      observedMethod = incoming.method ?? "";
      observedAuthorization = String(incoming.headers.authorization ?? "");
      incoming.setEncoding("utf8");
      incoming.on("data", (chunk: string) => {
        observedBody += chunk;
      });
      incoming.on("end", () => {
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "x-request-id": "request-123",
        });
        response.write("data: first\n\n");
        response.end("data: second\n\n");
      });
    });
    const chunks: Uint8Array[] = [];
    const transport = createNodeAiStreamingTransport();

    const result = await transport(
      request(`${fixture.origin}/v1/chat/completions`),
      (chunk) => chunks.push(chunk),
    );

    expect(observedMethod).toBe("POST");
    expect(observedAuthorization).toBe("Bearer test-key");
    expect(observedBody).toBe("{\"prompt\":\"hello\"}");
    expect(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"))
      .toBe("data: first\n\ndata: second\n\n");
    expect(result).toEqual({
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
      contentType: "text/event-stream",
      requestId: "request-123",
    });
    expect(JSON.stringify(result)).not.toContain("test-key");
  });

  it("collects only a bounded same-response JSON fallback", async () => {
    const body = JSON.stringify({ choices: [{ message: { content: "ok" } }] });
    const fixture = await localServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(body);
    });
    const onChunk = vi.fn();
    const result = await createNodeAiStreamingTransport({ maxJsonBodyBytes: 128 })(
      request(`${fixture.origin}/json`),
      onChunk,
    );

    expect(result).toEqual({
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      contentType: "application/json",
      bodyText: body,
    });
    expect(onChunk).not.toHaveBeenCalled();
  });

  it("rejects an oversized single SSE chunk before forwarding it", async () => {
    const fixture = await localServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end("x".repeat(65));
    });
    const onChunk = vi.fn();

    const error = await createNodeAiStreamingTransport({ maxResponseBytes: 64 })(
      request(`${fixture.origin}/oversized`),
      onChunk,
    ).catch((reason: unknown) => reason);

    expectProviderCode(error, "response-too-large");
    expect(onChunk).not.toHaveBeenCalled();
  });

  it("checks the cumulative byte and chunk ceilings before each callback", async () => {
    const fixture = await localServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("1234");
      scheduleImmediate(() => {
        response.write("5678");
        scheduleImmediate(() => response.end("9"));
      });
    });
    const byteChunks: Uint8Array[] = [];
    const byteError = await createNodeAiStreamingTransport({
      maxResponseBytes: 8,
      maxResponseChunks: 8,
    })(request(`${fixture.origin}/bytes`), (chunk) => byteChunks.push(chunk))
      .catch((reason: unknown) => reason);
    expectProviderCode(byteError, "response-too-large");
    expect(Buffer.concat(byteChunks.map((chunk) => Buffer.from(chunk))).toString())
      .toBe("12345678");

    const chunkFixture = await localServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("a");
      scheduleImmediate(() => {
        response.write("b");
        scheduleImmediate(() => response.end("c"));
      });
    });
    const countChunks: Uint8Array[] = [];
    const countError = await createNodeAiStreamingTransport({
      maxResponseBytes: 64,
      maxResponseChunks: 2,
    })(request(`${chunkFixture.origin}/chunks`), (chunk) => countChunks.push(chunk))
      .catch((reason: unknown) => reason);
    expectProviderCode(countError, "response-too-large");
    expect(Buffer.concat(countChunks.map((chunk) => Buffer.from(chunk))).toString())
      .toBe("ab");
  });

  it("rejects oversized JSON without returning or streaming a partial body", async () => {
    const sentinel = "RAW-JSON-SENTINEL";
    const fixture = await localServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ value: sentinel.repeat(8) }));
    });
    const onChunk = vi.fn();
    const error = await createNodeAiStreamingTransport({
      maxResponseBytes: 256,
      maxJsonBodyBytes: 32,
    })(request(`${fixture.origin}/large-json`), onChunk)
      .catch((reason: unknown) => reason);

    expectProviderCode(error, "response-too-large");
    expect(JSON.stringify(error)).not.toContain(sentinel);
    expect(String(error)).not.toContain(sentinel);
    expect(onChunk).not.toHaveBeenCalled();
  });

  it("bounds and discards an unknown successful content type", async () => {
    const exact = await localServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end("12345678");
    });
    const onChunk = vi.fn();
    await expect(createNodeAiStreamingTransport({ maxResponseBytes: 8 })(
      request(`${exact.origin}/unknown-exact`),
      onChunk,
    )).resolves.toEqual({
      status: 200,
      headers: { "content-type": "application/octet-stream" },
      contentType: "",
    });
    expect(onChunk).not.toHaveBeenCalled();

    const oversized = await localServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end("123456789");
    });
    const error = await createNodeAiStreamingTransport({ maxResponseBytes: 8 })(
      request(`${oversized.origin}/unknown-oversized`),
      onChunk,
    ).catch((reason: unknown) => reason);
    expectProviderCode(error, "response-too-large");
    expect(onChunk).not.toHaveBeenCalled();
  });

  it("maps timeout and caller abort to stable errors and removes abort listeners", async () => {
    const fixture = await localServer(() => undefined);
    const timeoutError = await createNodeAiStreamingTransport({ timeoutMs: 25 })(
      request(`${fixture.origin}/timeout`),
      vi.fn(),
    ).catch((reason: unknown) => reason);
    expectProviderCode(timeoutError, "timeout");

    const controller = new AbortController();
    const pending = createNodeAiStreamingTransport({ timeoutMs: 5_000 })(
      request(`${fixture.origin}/abort`, { signal: controller.signal }),
      vi.fn(),
    );
    await vi.waitFor(() => {
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
    });
    controller.abort();
    const abortError = await pending.catch((reason: unknown) => reason);
    expectProviderCode(abortError, "aborted");
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("settles an abort-timeout race once and cleans the caller listener", async () => {
    const fixture = await localServer(() => undefined);
    const controller = new AbortController();
    let settlements = 0;
    const pending = createNodeAiStreamingTransport({ timeoutMs: 10 })(
      request(`${fixture.origin}/abort-timeout-race`, {
        signal: controller.signal,
      }),
      vi.fn(),
    ).then(
      () => {
        settlements += 1;
        return undefined;
      },
      (error: unknown) => {
        settlements += 1;
        return error;
      },
    );
    const abortTimer = scheduleTimer(() => controller.abort(), 10);
    const error = await pending;
    cancelTimer(abortTimer);

    expect(error).toBeInstanceOf(ProviderError);
    expect(["aborted", "timeout"]).toContain((error as ProviderError).code);
    await new Promise<void>((resolve) => scheduleTimer(resolve, 20));
    expect(settlements).toBe(1);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("maps socket and callback failures without exposing their causes", async () => {
    const unavailable = await localServer((_request, response) => response.end());
    const url = `${unavailable.origin}/closed`;
    await unavailable.close();
    servers.delete(unavailable);
    const socketError = await createNodeAiStreamingTransport({ timeoutMs: 250 })(
      request(url),
      vi.fn(),
    ).catch((reason: unknown) => reason);
    expectProviderCode(socketError, "network-failure");
    expect(String(socketError)).not.toMatch(/ECONNREFUSED|127\.0\.0\.1/u);

    const callbackSentinel = "CALLBACK-SECRET-SENTINEL";
    const fixture = await localServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end("data: ok\n\n");
    });
    const callbackError = await createNodeAiStreamingTransport()(
      request(`${fixture.origin}/callback`),
      () => {
        throw new Error(callbackSentinel);
      },
    ).catch((reason: unknown) => reason);
    expectProviderCode(callbackError, "malformed-response");
    expect(String(callbackError)).not.toContain(callbackSentinel);
    expect(JSON.stringify(callbackError)).not.toContain(callbackSentinel);
  });

  it("keeps request and response error sinks through close after normal end", async () => {
    const captured: {
      request?: ClientRequest;
      response?: IncomingMessage;
    } = {};
    let requestListenersDuringEnd = -1;
    let responseListenersDuringEnd = -1;
    let lateErrorThrew = false;
    let endProbeInstalled = false;
    const originalRequestOn: unknown = Reflect.get(ClientRequest.prototype, "on");
    const originalResponseOn: unknown = Reflect.get(IncomingMessage.prototype, "on");
    const originalResponseOnce: unknown = Reflect.get(
      IncomingMessage.prototype,
      "once",
    );
    vi.spyOn(ClientRequest.prototype, "on").mockImplementation(function (
      this: ClientRequest,
      event: string | symbol,
      listener: (...args: unknown[]) => void,
    ): ClientRequest {
      if (event === "error") Reflect.set(captured, "request", this);
      return Reflect.apply(originalRequestOn, this, [event, listener]);
    });
    vi.spyOn(IncomingMessage.prototype, "on").mockImplementation(function (
      this: IncomingMessage,
      event: string | symbol,
      listener: (...args: unknown[]) => void,
    ): IncomingMessage {
      if (event === "data" && typeof this.statusCode === "number") {
        Reflect.set(captured, "response", this);
      }
      if (
        event === "close" &&
        typeof this.statusCode === "number" &&
        !endProbeInstalled
      ) {
        endProbeInstalled = true;
        Reflect.apply(originalResponseOnce, this, ["end", () => {
          requestListenersDuringEnd = captured.request?.listenerCount("error") ?? -1;
          responseListenersDuringEnd = captured.response?.listenerCount("error") ?? -1;
          try {
            captured.request?.emit("error", new Error("late request"));
            captured.response?.emit("error", new Error("late response"));
          } catch {
            lateErrorThrew = true;
          }
        }]);
      }
      return Reflect.apply(originalResponseOn, this, [event, listener]);
    });
    const fixture = await localServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end("data: complete\n\n");
    });
    let settlements = 0;
    const pending = createNodeAiStreamingTransport()(
      request(`${fixture.origin}/late-errors`),
      vi.fn(),
    ).then((result) => {
      settlements += 1;
      return result;
    });

    await expect(pending).resolves.toMatchObject({ status: 200 });
    expect(captured.request).toBeDefined();
    expect(captured.response).toBeDefined();
    expect(requestListenersDuringEnd).toBeGreaterThan(0);
    expect(responseListenersDuringEnd).toBeGreaterThan(0);
    expect(lateErrorThrew).toBe(false);
    expect(settlements).toBe(1);
    await vi.waitFor(() => {
      expect(captured.request?.closed).toBe(true);
      expect(captured.response?.closed).toBe(true);
    });
    expect(captured.request?.listenerCount("error")).toBe(0);
    expect(captured.response?.listenerCount("error")).toBe(0);
  });

  it.each([307, 308])(
    "follows same-origin %i without changing POST body, authorization, or content length",
    async (status) => {
    const seen: Array<{
      path: string;
      method: string;
      authorization: string;
      contentLength: string;
      body: string;
    }> = [];
    const fixture = await localServer((incoming, response) => {
      let body = "";
      incoming.setEncoding("utf8");
      incoming.on("data", (chunk: string) => {
        body += chunk;
      });
      incoming.on("end", () => {
        seen.push({
          path: incoming.url ?? "",
          method: incoming.method ?? "",
          authorization: String(incoming.headers.authorization ?? ""),
          contentLength: String(incoming.headers["content-length"] ?? ""),
          body,
        });
        if (incoming.url === "/start") {
          response.writeHead(status, { location: "/final" });
          response.end();
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end("data: ok\n\n");
      });
    });

    await expect(createNodeAiStreamingTransport()(
      request(`${fixture.origin}/start`),
      vi.fn(),
    )).resolves.toMatchObject({ status: 200 });
    expect(seen).toEqual([
      {
        path: "/start",
        method: "POST",
        authorization: "Bearer test-key",
        contentLength: "18",
        body: "{\"prompt\":\"hello\"}",
      },
      {
        path: "/final",
        method: "POST",
        authorization: "Bearer test-key",
        contentLength: "18",
        body: "{\"prompt\":\"hello\"}",
      },
    ]);
  });

  it.each([301, 302, 303])(
    "rejects same-origin %i without creating a second side-effecting POST",
    async (status) => {
      let requests = 0;
      const fixture = await localServer((incoming, response) => {
        requests += 1;
        if (incoming.url === "/start") {
          response.writeHead(status, { location: "/must-not-run" });
          response.end();
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end("data: duplicate\n\n");
      });

      const error = await createNodeAiStreamingTransport()(
        request(`${fixture.origin}/start`),
        vi.fn(),
      ).catch((reason: unknown) => reason);

      expectProviderCode(error, "network-failure");
      expect(requests).toBe(1);
    },
  );

  it("returns a redirect status without Location as an ordinary response", async () => {
    let requests = 0;
    const fixture = await localServer((_incoming, response) => {
      requests += 1;
      response.writeHead(302, { "content-type": "application/json" });
      response.end("{\"ignored\":true}");
    });

    await expect(createNodeAiStreamingTransport()(
      request(`${fixture.origin}/no-location`),
      vi.fn(),
    )).resolves.toEqual({
      status: 302,
      headers: { "content-type": "application/json" },
      contentType: "application/json",
    });
    expect(requests).toBe(1);
  });

  it("enforces the redirect limit", async () => {
    let requests = 0;
    const fixture = await localServer((_request, response) => {
      requests += 1;
      response.writeHead(307, { location: "/again" });
      response.end();
    });
    const error = await createNodeAiStreamingTransport({ maxRedirects: 2 })(
      request(`${fixture.origin}/again`),
      vi.fn(),
    ).catch((reason: unknown) => reason);

    expectProviderCode(error, "network-failure");
    expect(requests).toBe(3);
  });

  it("rejects cross-origin redirects without sending authorization to the target", async () => {
    let targetRequests = 0;
    let targetAuthorization = "";
    const target = await localServer((incoming, response) => {
      targetRequests += 1;
      targetAuthorization = String(incoming.headers.authorization ?? "");
      response.end();
    });
    const source = await localServer((_request, response) => {
      response.writeHead(307, { location: `${target.origin}/capture` });
      response.end();
    });

    const error = await createNodeAiStreamingTransport()(
      request(`${source.origin}/redirect`),
      vi.fn(),
    ).catch((reason: unknown) => reason);

    expectProviderCode(error, "network-failure");
    expect(targetRequests).toBe(0);
    expect(targetAuthorization).toBe("");
  });

  it.each([
    "http://example.com/v1/chat/completions",
    "http://localhost.evil.test/v1/chat/completions",
    "http://localhost./v1/chat/completions",
    "http://127.1/v1/chat/completions",
    "http://2130706433/v1/chat/completions",
    "http://127.0.0.1:0/v1/chat/completions",
    "http://[::1]:11434/v1/chat/completions",
    "ftp://localhost/v1/chat/completions",
    "https://127.0.0.1:0/v1/chat/completions",
    "https://user:password@example.com/v1/chat/completions",
    "https://example.com/v1/chat/completions#fragment",
  ])("rejects an unsafe URL before opening a socket: %s", async (url) => {
    const connect = vi.spyOn(Socket.prototype, "connect")
      .mockImplementation(function blockedSocket(): Socket {
        throw new Error("test blocked an unsafe socket attempt");
      });
    const error = await createNodeAiStreamingTransport()(request(url), vi.fn())
      .catch((reason: unknown) => reason);
    expectProviderCode(error, "invalid-request");
    expect(connect).not.toHaveBeenCalled();
  });

  it("rejects oversized UTF-8 request bytes before opening a socket", async () => {
    const fixture = await localServer((_request, response) => response.end());
    let requests = 0;
    fixture.server.on("request", () => {
      requests += 1;
    });
    const body = "界".repeat(Math.floor(MAX_AI_STREAM_REQUEST_BODY_BYTES / 3) + 1);

    const error = await createNodeAiStreamingTransport()(
      request(`${fixture.origin}/oversized-request`, { body }),
      vi.fn(),
    ).catch((reason: unknown) => reason);

    expectProviderCode(error, "invalid-request");
    expect(requests).toBe(0);
  });

  it("rejects unknown, inherited, and accessor-backed request fields without invoking them", async () => {
    const transport = createNodeAiStreamingTransport();
    const unknown = {
      ...request("http://127.0.0.1:1/v1"),
      apiKey: "UNKNOWN-FIELD-SECRET",
    };
    expectProviderCode(
      await transport(unknown, vi.fn()).catch((reason: unknown) => reason),
      "invalid-request",
    );

    const inherited = Object.create(request("http://127.0.0.1:1/v1"));
    expectProviderCode(
      await transport(inherited, vi.fn()).catch((reason: unknown) => reason),
      "invalid-request",
    );

    let getterCalls = 0;
    const accessorBacked = request("http://127.0.0.1:1/v1");
    Object.defineProperty(accessorBacked, "url", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "http://127.0.0.1:1/v1";
      },
    });
    expectProviderCode(
      await transport(accessorBacked, vi.fn()).catch((reason: unknown) => reason),
      "invalid-request",
    );
    expect(getterCalls).toBe(0);
  });

  it("rejects dangerous and duplicate header names without invoking accessors", async () => {
    const connect = vi.spyOn(Socket.prototype, "connect")
      .mockImplementation(function blockedSocket(): Socket {
        throw new Error("test blocked an unsafe socket attempt");
      });
    const transport = createNodeAiStreamingTransport();

    for (const dangerousName of ["__proto__", "prototype", "constructor"]) {
      const headers = Object.create(null) as Record<string, string>;
      Object.defineProperty(headers, "authorization", {
        enumerable: true,
        value: "Bearer fixture",
      });
      Object.defineProperty(headers, dangerousName, {
        enumerable: true,
        value: "unsafe",
      });
      const error = await transport(
        request("http://127.0.0.1:1/v1", { headers }),
        vi.fn(),
      ).catch((reason: unknown) => reason);
      expectProviderCode(error, "invalid-request");
    }

    const duplicate = Object.create(null) as Record<string, string>;
    duplicate.Authorization = "Bearer fixture";
    duplicate.authorization = "Bearer fixture";
    expectProviderCode(
      await transport(request("http://127.0.0.1:1/v1", { headers: duplicate }), vi.fn())
        .catch((reason: unknown) => reason),
      "invalid-request",
    );

    let getterCalls = 0;
    const accessor = Object.create(null) as Record<string, string>;
    Object.defineProperty(accessor, "x-api-key", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "must-not-read";
      },
    });
    expectProviderCode(
      await transport(request("http://127.0.0.1:1/v1", { headers: accessor }), vi.fn())
        .catch((reason: unknown) => reason),
      "invalid-request",
    );
    expect(getterCalls).toBe(0);
    expect(connect).not.toHaveBeenCalled();
  });

  it("supports null-prototype header records without inheriting values", async () => {
    let authorization = "";
    const fixture = await localServer((incoming, response) => {
      authorization = String(incoming.headers.authorization ?? "");
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end("data: ok\n\n");
    });
    const headers = Object.create(null) as Record<string, string>;
    Object.defineProperty(headers, "authorization", {
      enumerable: true,
      value: "Bearer null-prototype",
    });
    Object.defineProperty(headers, "content-type", {
      enumerable: true,
      value: "application/json",
    });

    await expect(createNodeAiStreamingTransport()(
      request(`${fixture.origin}/null-prototype`, { headers }),
      vi.fn(),
    )).resolves.toMatchObject({ status: 200 });
    expect(authorization).toBe("Bearer null-prototype");
  });

  it("allows exact localhost and 127.0.0.1 HTTP origins", async () => {
    const fixture = await localServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end("data: ok\n\n");
    });
    const port = new URL(fixture.origin).port;
    await expect(createNodeAiStreamingTransport()(
      request(`http://localhost:${port}/v1/chat/completions`),
      vi.fn(),
    )).resolves.toMatchObject({ status: 200 });
    await expect(createNodeAiStreamingTransport()(
      request(`${fixture.origin}/v1/chat/completions`),
      vi.fn(),
    )).resolves.toMatchObject({ status: 200 });
  });

  it("rejects HTTPS downgrade and credentialed/cross-origin redirect targets", () => {
    expect(() => validateAiStreamingRedirect(
      new URL("https://relay.example/v1"),
      "http://relay.example/v2",
    )).toThrow(ProviderError);
    expect(() => validateAiStreamingRedirect(
      new URL("https://relay.example/v1"),
      "https://user:password@relay.example/v2",
    )).toThrow(ProviderError);
    expect(() => validateAiStreamingRedirect(
      new URL("https://relay.example/v1"),
      "https://other.example/v2",
    )).toThrow(ProviderError);
  });

  it("does not expose authorization, raw failure bodies, request causes, or logs", async () => {
    const keySentinel = "KEY-SENTINEL-DO-NOT-LEAK";
    const bodySentinel = "BODY-SENTINEL-DO-NOT-LEAK";
    const fixture = await localServer((_request, response) => {
      response.writeHead(500, {
        "content-type": "application/json",
        "x-request-id": keySentinel,
      });
      response.end(JSON.stringify({ error: bodySentinel }));
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await createNodeAiStreamingTransport()(
      request(`${fixture.origin}/failure`, {
        headers: {
          authorization: `Bearer ${keySentinel}`,
          "content-type": "application/json",
        },
      }),
      vi.fn(),
    );

    expect(result.status).toBe(500);
    expect(result.bodyText).toBeUndefined();
    expect(result.requestId).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(keySentinel);
    expect(JSON.stringify(result)).not.toContain(bodySentinel);
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it("filters short structured credentials from response request IDs without filtering ordinary labels", async () => {
    const cases = [
      { header: "authorization", value: "Bearer k", requestId: "k" },
      { header: "authorization", value: "Basic eA==", requestId: "eA==" },
      { header: "x-api-key", value: "z", requestId: "z" },
      { header: "x-auth-token", value: "Token q", requestId: "q" },
    ] as const;
    for (const fixtureCase of cases) {
      const fixture = await localServer((_request, response) => {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "x-request-id": fixtureCase.requestId,
        });
        response.end("data: ok\n\n");
      });
      const result = await createNodeAiStreamingTransport()(
        request(`${fixture.origin}/short-secret`, {
          headers: {
            [fixtureCase.header]: fixtureCase.value,
            "content-type": "application/json",
          },
        }),
        vi.fn(),
      );
      expect(result.requestId).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain(fixtureCase.requestId);
    }

    const ordinary = await localServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "x-request-id": "ok",
      });
      response.end("data: ok\n\n");
    });
    const ordinaryResult = await createNodeAiStreamingTransport()(
      request(`${ordinary.origin}/ordinary`, {
        headers: {
          "x-client-label": "ok",
          "content-type": "application/json",
        },
      }),
      vi.fn(),
    );
    expect(ordinaryResult.requestId).toBe("ok");
  });

  it("exposes the planned optional text-delta provider contract", () => {
    const provider: TextGenerationProvider = {
      generate: async (_input, onTextDelta) => {
        onTextDelta?.("final text");
        return { text: "final text" };
      },
    };
    expect(provider).toBeDefined();
  });
});
