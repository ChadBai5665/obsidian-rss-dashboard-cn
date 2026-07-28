import { Buffer } from "node:buffer";
import { getEventListeners } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { Socket } from "node:net";
import { setImmediate as scheduleImmediate } from "node:timers";
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

  it("follows only bounded same-origin redirects and preserves authorization", async () => {
    const seen: Array<{ path: string; authorization: string }> = [];
    const fixture = await localServer((incoming, response) => {
      seen.push({
        path: incoming.url ?? "",
        authorization: String(incoming.headers.authorization ?? ""),
      });
      if (incoming.url === "/start") {
        response.writeHead(307, { location: "/final" });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end("data: ok\n\n");
    });

    await expect(createNodeAiStreamingTransport()(
      request(`${fixture.origin}/start`),
      vi.fn(),
    )).resolves.toMatchObject({ status: 200 });
    expect(seen).toEqual([
      { path: "/start", authorization: "Bearer test-key" },
      { path: "/final", authorization: "Bearer test-key" },
    ]);
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
