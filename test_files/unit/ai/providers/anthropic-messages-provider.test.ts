import { describe, expect, it, vi } from "vitest";

import type { AiConnection } from "../../../../src/ai/ai-types";
import {
  AnthropicMessagesProvider,
  type AiStreamingTransport,
  type AiTransportRequest,
} from "../../../../src/ai/providers/anthropic-messages-provider";
import { ProviderError } from "../../../../src/ai/providers/provider-error";

const API_KEY = "anthropic-secret-key";
const encoder = new TextEncoder();

function connection(baseUrl = "https://api.anthropic.com"): AiConnection {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    name: "Claude",
    providerKind: baseUrl === "https://api.anthropic.com"
      ? "claude"
      : "anthropic-compatible",
    protocol: "anthropic-messages",
    baseUrl,
    model: "claude-user-selected",
    timeoutMs: 60_000,
    maxInputCharacters: 80_000,
    enabled: true,
  };
}

function event(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function validStream(): string {
  return [
    event("message_start", {
      type: "message_start",
      message: {
        id: "msg-stream-1",
        content: [],
        usage: { input_tokens: 13 },
      },
    }),
    event("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "第一" },
    }),
    event("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "段" },
    }),
    event("content_block_stop", { type: "content_block_stop", index: 0 }),
    event("content_block_start", {
      type: "content_block_start",
      index: 1,
      content_block: { type: "thinking", thinking: "hidden-thought" },
    }),
    event("content_block_delta", {
      type: "content_block_delta",
      index: 1,
      delta: { type: "thinking_delta", thinking: "hidden-reasoning" },
    }),
    event("content_block_delta", {
      type: "content_block_delta",
      index: 1,
      delta: { type: "signature_delta", signature: "hidden-signature" },
    }),
    event("content_block_stop", { type: "content_block_stop", index: 1 }),
    event("content_block_start", {
      type: "content_block_start",
      index: 2,
      content_block: { type: "tool_use", id: "hidden-tool", name: "hidden" },
    }),
    event("content_block_delta", {
      type: "content_block_delta",
      index: 2,
      delta: { type: "input_json_delta", partial_json: "{hidden}" },
    }),
    event("content_block_stop", { type: "content_block_stop", index: 2 }),
    event("content_block_start", {
      type: "content_block_start",
      index: 3,
      content_block: { type: "text", text: "第二段" },
    }),
    event("content_block_stop", { type: "content_block_stop", index: 3 }),
    event("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 8 },
    }),
    event("message_stop", { type: "message_stop" }),
  ].join("");
}

function streamTransport(chunks: readonly Uint8Array[]): AiStreamingTransport {
  return vi.fn(async (_request, onChunk) => {
    for (const chunk of chunks) onChunk(chunk);
    return {
      status: 200,
      headers: { "content-type": "text/event-stream" },
      contentType: "text/event-stream",
      requestId: "header-anthropic",
    };
  });
}

function jsonTransport(json: unknown = {
  id: "msg-json-1",
  content: [
    { type: "text", text: "JSON 第一段" },
    { type: "thinking", thinking: "hidden" },
    { type: "text", text: "第二段" },
  ],
  usage: { input_tokens: 13, output_tokens: 8 },
}): AiStreamingTransport {
  return vi.fn(async () => ({
    status: 200,
    headers: { "content-type": "application/json" },
    contentType: "application/json",
    requestId: "header-json",
    bodyText: JSON.stringify(json),
  }));
}

function harness(transport: AiStreamingTransport = jsonTransport(), baseUrl?: string) {
  const requests: AiTransportRequest[] = [];
  const recordingTransport = vi.fn<AiStreamingTransport>(async (request, onChunk) => {
    requests.push(request);
    return await transport(request, onChunk);
  });
  const provider = new AnthropicMessagesProvider({
    connection: connection(baseUrl),
    apiKey: API_KEY,
    transport: recordingTransport,
  });
  return { provider, requests, transport: recordingTransport };
}

describe("Anthropic-compatible streaming provider", () => {
  it.each([
    ["https://api.anthropic.com", "https://api.anthropic.com/v1/messages"],
    ["https://relay.example.com/v1", "https://relay.example.com/v1/messages"],
    ["https://relay.example.com/anthropic/v1", "https://relay.example.com/anthropic/v1/messages"],
    ["https://relay.example.com/anthropic/v1/messages", "https://relay.example.com/anthropic/v1/messages"],
    ["https://relay.example.com/anthropic", "https://relay.example.com/anthropic/v1/messages"],
  ])("sends one narrow streaming request for %s", async (baseUrl, expectedUrl) => {
    const test = harness(jsonTransport(), baseUrl);
    const controller = new AbortController();
    await expect(test.provider.generate({
      system: "系统提示",
      user: "用户内容",
      maxOutputTokens: 1024,
      signal: controller.signal,
    })).resolves.toMatchObject({ text: "JSON 第一段第二段" });

    expect(test.transport).toHaveBeenCalledOnce();
    expect(test.requests).toEqual([{
      url: expectedUrl,
      method: "POST",
      headers: {
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-user-selected",
        max_tokens: 1024,
        system: "系统提示",
        messages: [{ role: "user", content: "用户内容" }],
        stream: true,
      }),
      signal: controller.signal,
    }]);
  });

  it("streams multiple text blocks while discarding thinking and signatures", async () => {
    const payload = encoder.encode(validStream());
    const transport = streamTransport([
      payload.slice(0, 51),
      payload.slice(51, 191),
      payload.slice(191, 519),
      payload.slice(519),
    ]);
    const test = harness(transport);
    const deltas: string[] = [];
    await expect(test.provider.generate(
      { system: "s", user: "u", maxOutputTokens: 100 },
      (delta) => deltas.push(delta),
    )).resolves.toEqual({
      text: "第一段第二段",
      providerRequestId: "msg-stream-1",
      inputTokens: 13,
      outputTokens: 8,
    });
    expect(deltas.join("")).toBe("第一段第二段");
    expect(deltas.join("")).not.toMatch(/hidden|thinking|signature/u);
    expect(test.transport).toHaveBeenCalledOnce();
  });

  it("preserves UTF-8 and event order under one-byte fragments", async () => {
    const bytes = encoder.encode(validStream());
    const transport = vi.fn<AiStreamingTransport>(async (_request, onChunk) => {
      for (const byte of bytes) onChunk(Uint8Array.of(byte));
      return { status: 200, headers: {}, contentType: "text/event-stream" };
    });
    const deltas: string[] = [];
    await expect(harness(transport).provider.generate(
      { system: "s", user: "u", maxOutputTokens: 100 },
      (delta) => deltas.push(delta),
    )).resolves.toMatchObject({ text: "第一段第二段" });
    expect(deltas.join("")).toBe("第一段第二段");
  });

  it.each([
    ["delta before message", event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "bad" } })],
    ["block delta before start", event("message_start", { type: "message_start", message: { id: "m", content: [], usage: {} } }) + event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "bad" } })],
    ["block stop before start", event("message_start", { type: "message_start", message: { id: "m", content: [], usage: {} } }) + event("content_block_stop", { type: "content_block_stop", index: 0 })],
    ["message stop with open block", event("message_start", { type: "message_start", message: { id: "m", content: [], usage: {} } }) + event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "ok" } }) + event("message_stop", { type: "message_stop" })],
    ["duplicate message stop", validStream() + event("message_stop", { type: "message_stop" })],
    ["event and data type mismatch", event("message_start", { type: "message_stop" })],
    ["malformed JSON", "event: message_start\ndata: {\n\n"],
  ] as const)("rejects malformed order: %s", async (_label, payload) => {
    const error = await harness(streamTransport([encoder.encode(payload)])).provider.generate({
      system: "s", user: "u", maxOutputTokens: 100,
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "malformed-response" });
    expect(String(error)).not.toContain(payload);
  });

  it("rejects empty and oversized final text", async () => {
    const emptyPayload = event("message_start", {
      type: "message_start",
      message: { id: "m", content: [], usage: {} },
    }) + event("message_stop", { type: "message_stop" });
    await expect(harness(streamTransport([encoder.encode(emptyPayload)])).provider.generate({
      system: "s", user: "u", maxOutputTokens: 10,
    })).rejects.toMatchObject({ code: "empty-output" });

    const oversized = event("message_start", {
      type: "message_start",
      message: { id: "m", content: [], usage: {} },
    }) + event("content_block_start", {
      type: "content_block_start", index: 0, content_block: { type: "text", text: "x".repeat(161) },
    });
    await expect(harness(streamTransport([encoder.encode(oversized)])).provider.generate({
      system: "s", user: "u", maxOutputTokens: 10,
    })).rejects.toMatchObject({ code: "response-too-large" });
  });

  it("uses the original response JSON fallback once and emits one callback", async () => {
    const transport = jsonTransport();
    const test = harness(transport);
    const deltas: string[] = [];
    await expect(test.provider.generate(
      { system: "s", user: "u", maxOutputTokens: 100 },
      (delta) => deltas.push(delta),
    )).resolves.toEqual({
      text: "JSON 第一段第二段",
      providerRequestId: "msg-json-1",
      inputTokens: 13,
      outputTokens: 8,
    });
    expect(deltas).toEqual(["JSON 第一段第二段"]);
    expect(test.transport).toHaveBeenCalledOnce();
  });

  it("isolates callback exceptions without leaking or retrying", async () => {
    const transport = streamTransport([encoder.encode(validStream())]);
    const test = harness(transport);
    await expect(test.provider.generate(
      { system: "s", user: "u", maxOutputTokens: 100 },
      () => { throw new Error(`${API_KEY} callback`); },
    )).resolves.toMatchObject({ text: "第一段第二段" });
    expect(test.transport).toHaveBeenCalledOnce();
  });

  it("does not emit an API key reflected across text-block boundaries", async () => {
    const split = Math.floor(API_KEY.length / 2);
    const payload = event("message_start", {
      type: "message_start",
      message: { id: "m", content: [], usage: {} },
    }) + event("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: API_KEY.slice(0, split) },
    }) + event("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: API_KEY.slice(split) },
    });
    const transport = streamTransport([encoder.encode(payload)]);
    const deltas: string[] = [];
    const error = await harness(transport).provider.generate(
      { system: "s", user: "u", maxOutputTokens: 100 },
      (delta) => deltas.push(delta),
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "empty-output" });
    expect(deltas.join("")).not.toContain(API_KEY);
    expect(transport).toHaveBeenCalledOnce();
  });

  it("preserves HTTP status, request ID, and unsafe usage boundaries", async () => {
    const rejected = vi.fn<AiStreamingTransport>(async () => ({
      status: 429,
      headers: {},
      contentType: "application/json",
      requestId: "safe-anthropic-id",
      bodyText: `${API_KEY} private body`,
    }));
    const error = await harness(rejected).provider.generate({
      system: "s", user: "u", maxOutputTokens: 10,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({
      code: "rate-limited",
      status: 429,
      requestId: "safe-anthropic-id",
    });
    expect(JSON.stringify(error)).not.toContain(API_KEY);

    const invalidUsage = event("message_start", {
      type: "message_start",
      message: { id: "m", content: [], usage: { input_tokens: -1 } },
    });
    await expect(harness(streamTransport([encoder.encode(invalidUsage)])).provider.generate({
      system: "s", user: "u", maxOutputTokens: 10,
    })).rejects.toMatchObject({ code: "malformed-response" });
  });

  it("preserves trusted abort without exposing causes", async () => {
    const controller = new AbortController();
    controller.abort();
    const test = harness(jsonTransport());
    await expect(test.provider.generate({
      system: "s", user: "u", maxOutputTokens: 10, signal: controller.signal,
    })).rejects.toMatchObject({ code: "aborted" });
    expect(test.transport).not.toHaveBeenCalled();

    const transport = vi.fn<AiStreamingTransport>(async () => {
      throw new ProviderError("aborted", "The AI provider request was cancelled.");
    });
    await expect(harness(transport).provider.generate({
      system: "s", user: "u", maxOutputTokens: 10,
    })).rejects.toMatchObject({ code: "aborted" });
  });

  it("resolves the current default model without an extra request", async () => {
    const metadata = { ...connection(), model: "" };
    const requests: AiTransportRequest[] = [];
    const transport = jsonTransport();
    const recording = vi.fn<AiStreamingTransport>(async (request, onChunk) => {
      requests.push(request);
      return await transport(request, onChunk);
    });
    const provider = new AnthropicMessagesProvider({
      connection: metadata,
      apiKey: API_KEY,
      transport: recording,
    });
    await provider.generate({ system: "s", user: "u", maxOutputTokens: 1024 });
    expect(JSON.parse(requests[0]?.body ?? "{}")).toMatchObject({
      model: "claude-sonnet-5",
      stream: true,
    });
    expect(recording).toHaveBeenCalledOnce();
  });
});
