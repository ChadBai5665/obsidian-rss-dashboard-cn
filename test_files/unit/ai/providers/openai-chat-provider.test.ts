import { describe, expect, it, vi } from "vitest";

import type { AiConnection } from "../../../../src/ai/ai-types";
import {
  OpenAiChatProvider,
  type AiStreamingTransport,
  type AiTransportRequest,
} from "../../../../src/ai/providers/openai-chat-provider";
import { ProviderError } from "../../../../src/ai/providers/provider-error";

const API_KEY = "provider-secret-key";
const encoder = new TextEncoder();

function connection(overrides: Partial<AiConnection> = {}): AiConnection {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "OpenAI",
    providerKind: "openai",
    protocol: "openai-chat",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-user-selected",
    timeoutMs: 60_000,
    maxInputCharacters: 80_000,
    enabled: true,
    ...overrides,
  };
}

function event(data: unknown): string {
  return `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
}

function successJson(json: unknown = {
  id: "req-safe-json",
  choices: [{ message: { content: "JSON 结果" } }],
  usage: { prompt_tokens: 12, completion_tokens: 7 },
}): AiStreamingTransport {
  return vi.fn(async () => ({
    status: 200,
    headers: { "content-type": "application/json" },
    contentType: "application/json",
    requestId: "header-json",
    bodyText: JSON.stringify(json),
  }));
}

function streamTransport(
  chunks: readonly string[],
  response: Partial<Awaited<ReturnType<AiStreamingTransport>>> = {},
): AiStreamingTransport {
  return vi.fn(async (_request, onChunk) => {
    for (const chunk of chunks) onChunk(encoder.encode(chunk));
    return {
      status: 200,
      headers: { "content-type": "text/event-stream" },
      contentType: "text/event-stream",
      requestId: "header-stream",
      ...response,
    };
  });
}

function harness(
  transport: AiStreamingTransport = successJson(),
  overrides: Partial<AiConnection> = {},
  supportsStoreFalse = false,
  usesMaxCompletionTokens = false,
) {
  const requests: AiTransportRequest[] = [];
  const recordingTransport = vi.fn<AiStreamingTransport>(async (request, onChunk) => {
    requests.push(request);
    return await transport(request, onChunk);
  });
  const provider = new OpenAiChatProvider({
    connection: connection(overrides),
    apiKey: API_KEY,
    transport: recordingTransport,
    supportsStoreFalse,
    usesMaxCompletionTokens,
  });
  return { provider, requests, transport: recordingTransport };
}

describe("OpenAI-compatible streaming provider", () => {
  it.each([
    ["openai", "https://api.openai.com/v1", "https://api.openai.com/v1/chat/completions"],
    ["kimi", "https://api.moonshot.cn/v1", "https://api.moonshot.cn/v1/chat/completions"],
    ["deepseek", "https://api.deepseek.com", "https://api.deepseek.com/chat/completions"],
    ["qwen", "https://dashscope.aliyuncs.com/compatible-mode/v1", "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"],
    ["glm", "https://open.bigmodel.cn/api/paas/v4", "https://open.bigmodel.cn/api/paas/v4/chat/completions"],
    ["openai-compatible", "https://relay.example.com/v1", "https://relay.example.com/v1/chat/completions"],
  ] as const)("sends one narrow streaming request to %s", async (providerKind, baseUrl, expectedUrl) => {
    const test = harness(successJson(), { providerKind, baseUrl });
    const controller = new AbortController();

    await expect(test.provider.generate({
      system: "系统提示",
      user: "用户内容",
      maxOutputTokens: 512,
      signal: controller.signal,
    })).resolves.toMatchObject({ text: "JSON 结果" });

    expect(test.transport).toHaveBeenCalledOnce();
    expect(test.requests[0]?.url).toBe(expectedUrl);
    expect(test.requests[0]?.signal).toBe(controller.signal);
    const body = JSON.parse(test.requests[0]?.body ?? "{}");
    expect(body).toEqual({
      model: "gpt-user-selected",
      messages: [
        { role: "system", content: "系统提示" },
        { role: "user", content: "用户内容" },
      ],
      stream: true,
      max_tokens: 512,
    });
    expect(body).not.toHaveProperty("stream_options");
  });

  it("decodes fragmented events and emits only ordered final-answer content", async () => {
    const payload = [
      event({ id: "req-stream-1", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }),
      event({ id: "req-stream-1", choices: [{ index: 0, delta: { reasoning_content: "hidden", content: "第一" }, finish_reason: null }] }),
      event({ id: "req-stream-1", choices: [{ index: 0, delta: { content: "段🙂", tool_calls: [{ id: "hidden-tool" }] }, finish_reason: null }] }),
      event({ id: "req-stream-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 21, completion_tokens: 9 } }),
      event("[DONE]"),
    ].join("");
    const bytes = encoder.encode(payload);
    const transport = streamTransport([
      new TextDecoder().decode(bytes.slice(0, 37)),
      new TextDecoder().decode(bytes.slice(37, 131)),
      new TextDecoder().decode(bytes.slice(131)),
    ]);
    const test = harness(transport);
    const deltas: string[] = [];

    await expect(test.provider.generate(
      { system: "s", user: "u", maxOutputTokens: 100 },
      (text) => deltas.push(text),
    )).resolves.toEqual({
      text: "第一段🙂",
      providerRequestId: "req-stream-1",
      inputTokens: 21,
      outputTokens: 9,
    });
    expect(deltas.join("")).toBe("第一段🙂");
    expect(deltas.join("")).not.toContain("hidden");
    expect(test.transport).toHaveBeenCalledOnce();
  });

  it("keeps arbitrary byte fragmentation and UTF-8 splits in protocol order", async () => {
    const payload = event({ choices: [{ index: 0, delta: { content: "你🙂" }, finish_reason: null }] }) +
      event({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
      event("[DONE]");
    const bytes = encoder.encode(payload);
    const transport = vi.fn<AiStreamingTransport>(async (_request, onChunk) => {
      for (const byte of bytes) onChunk(Uint8Array.of(byte));
      return { status: 200, headers: {}, contentType: "text/event-stream" };
    });
    const test = harness(transport);
    const deltas: string[] = [];
    await expect(test.provider.generate(
      { system: "s", user: "u", maxOutputTokens: 10 },
      (delta) => deltas.push(delta),
    )).resolves.toMatchObject({ text: "你🙂" });
    expect(deltas.join("")).toBe("你🙂");
  });

  it.each([
    ["malformed JSON", event("{")],
    ["content before role is structurally valid", event({ choices: [{ index: 0, delta: { content: 7 }, finish_reason: null }] })],
    ["duplicate finish", event({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }) + event({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })],
    ["content after finish", event({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }) + event({ choices: [{ index: 0, delta: { content: "late" }, finish_reason: null }] })],
    ["duplicate completion", event({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }) + event("[DONE]") + event("[DONE]")],
    ["multiple choices", event({ choices: [{ index: 0, delta: { content: "a" }, finish_reason: null }, { index: 1, delta: { content: "b" }, finish_reason: null }] })],
  ] as const)("rejects %s without raw payload disclosure", async (_label, payload) => {
    const test = harness(streamTransport([payload]));
    const error = await test.provider.generate({
      system: "s",
      user: "u",
      maxOutputTokens: 100,
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "malformed-response" });
    expect(String(error)).not.toContain(payload);
  });

  it("rejects empty and oversized streamed output", async () => {
    const empty = harness(streamTransport([
      event({ choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: "stop" }] }) + event("[DONE]"),
    ]));
    await expect(empty.provider.generate({ system: "s", user: "u", maxOutputTokens: 10 }))
      .rejects.toMatchObject({ code: "empty-output" });

    const oversized = harness(streamTransport([
      event({ choices: [{ index: 0, delta: { content: "x".repeat(161) }, finish_reason: null }] }),
    ]));
    await expect(oversized.provider.generate({ system: "s", user: "u", maxOutputTokens: 10 }))
      .rejects.toMatchObject({ code: "response-too-large" });
  });

  it("uses the same-response JSON parser and emits one callback without retry", async () => {
    const transport = successJson();
    const test = harness(transport);
    const deltas: string[] = [];
    await expect(test.provider.generate(
      { system: "s", user: "u", maxOutputTokens: 100 },
      (delta) => deltas.push(delta),
    )).resolves.toEqual({
      text: "JSON 结果",
      providerRequestId: "req-safe-json",
      inputTokens: 12,
      outputTokens: 7,
    });
    expect(deltas).toEqual(["JSON 结果"]);
    expect(test.transport).toHaveBeenCalledOnce();
  });

  it("keeps the existing bounded JSON parser for same-response fallback", async () => {
    const excessiveNodes = Array.from({ length: 10_001 }, () => null);
    const transport = successJson({
      choices: [{ message: { content: "otherwise valid" } }],
      excessiveNodes,
    });
    await expect(harness(transport).provider.generate({
      system: "s", user: "u", maxOutputTokens: 100,
    })).rejects.toMatchObject({ code: "response-too-large" });
    expect(transport).toHaveBeenCalledOnce();
  });

  it("isolates callback exceptions and never retries", async () => {
    const transport = streamTransport([
      event({ choices: [{ index: 0, delta: { content: "安全结果" }, finish_reason: "stop" }] }) + event("[DONE]"),
    ]);
    const test = harness(transport);
    await expect(test.provider.generate(
      { system: "s", user: "u", maxOutputTokens: 100 },
      () => { throw new Error(`${API_KEY} callback`); },
    )).resolves.toMatchObject({ text: "安全结果" });
    expect(test.transport).toHaveBeenCalledOnce();
  });

  it("does not emit an API key reflected across content-delta boundaries", async () => {
    const split = Math.floor(API_KEY.length / 2);
    const transport = streamTransport([
      event({ choices: [{ index: 0, delta: { content: API_KEY.slice(0, split) }, finish_reason: null }] }) +
      event({ choices: [{ index: 0, delta: { content: API_KEY.slice(split) }, finish_reason: "stop" }] }) +
      event("[DONE]"),
    ]);
    const deltas: string[] = [];
    const error = await harness(transport).provider.generate(
      { system: "s", user: "u", maxOutputTokens: 100 },
      (delta) => deltas.push(delta),
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "empty-output" });
    expect(deltas.join("")).not.toContain(API_KEY);
    expect(transport).toHaveBeenCalledOnce();
  });

  it("rejects unsafe streamed usage metadata", async () => {
    const transport = streamTransport([
      event({
        choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: -1, completion_tokens: 2 },
      }) + event("[DONE]"),
    ]);
    await expect(harness(transport).provider.generate({
      system: "s", user: "u", maxOutputTokens: 100,
    })).rejects.toMatchObject({ code: "malformed-response" });
  });

  it.each([
    [400, "invalid-request"],
    [401, "invalid-key"],
    [402, "insufficient-balance"],
    [408, "timeout"],
    [429, "rate-limited"],
    [500, "provider-failure"],
  ] as const)("preserves HTTP %i as %s without response bodies", async (status, code) => {
    const transport = vi.fn<AiStreamingTransport>(async () => ({
      status,
      headers: {},
      contentType: "application/json",
      requestId: "safe-request-id",
      bodyText: `${API_KEY} private body`,
    }));
    const error = await harness(transport).provider.generate({
      system: "s", user: "u", maxOutputTokens: 10,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code, status, requestId: "safe-request-id" });
    expect(JSON.stringify(error)).not.toContain(API_KEY);
  });

  it("rejects a pre-aborted signal before transport and preserves trusted abort", async () => {
    const transport = successJson();
    const test = harness(transport);
    const controller = new AbortController();
    controller.abort();
    await expect(test.provider.generate({
      system: "s", user: "u", maxOutputTokens: 10, signal: controller.signal,
    })).rejects.toMatchObject({ code: "aborted" });
    expect(test.transport).not.toHaveBeenCalled();

    const aborted = vi.fn<AiStreamingTransport>(async () => {
      throw new ProviderError("aborted", "The AI provider request was cancelled.");
    });
    await expect(harness(aborted).provider.generate({
      system: "s", user: "u", maxOutputTokens: 10,
    })).rejects.toMatchObject({ code: "aborted" });
  });

  it("keeps model defaults, token field capability, and store:false without probes", async () => {
    const test = harness(
      successJson(),
      {
        providerKind: "minimax-cn",
        baseUrl: "https://api.minimaxi.com/v1",
        model: "",
      },
      true,
      true,
    );
    await test.provider.generate({ system: "s", user: "u", maxOutputTokens: 512 });
    const body = JSON.parse(test.requests[0]?.body ?? "{}");
    expect(body).toMatchObject({
      model: "MiniMax-M3",
      max_completion_tokens: 512,
      store: false,
      stream: true,
    });
    expect(body).not.toHaveProperty("max_tokens");
    expect(test.transport).toHaveBeenCalledOnce();
  });

  it("streams exactly the trim-normalized final text across whitespace boundaries", async () => {
    const payload = [
      event({ choices: [{ index: 0, delta: { content: " \n\u00a0" }, finish_reason: null }] }),
      event({ choices: [{ index: 0, delta: { content: "# 标题" }, finish_reason: null }] }),
      event({ choices: [{ index: 0, delta: { content: "  \n" }, finish_reason: null }] }),
      event({ choices: [{ index: 0, delta: { content: "- 项目" }, finish_reason: null }] }),
      event({ choices: [{ index: 0, delta: { content: "\n\t\ufeff" }, finish_reason: null }] }),
      event("[DONE]"),
    ].join("");
    const deltas: string[] = [];

    const result = await harness(streamTransport([payload])).provider.generate(
      { system: "s", user: "u", maxOutputTokens: 100 },
      (delta) => deltas.push(delta),
    );

    expect(result.text).toBe("# 标题  \n- 项目");
    expect(deltas.join("")).toBe(result.text);
  });

  it("does not callback whitespace-only streamed output", async () => {
    const payload = event({
      choices: [{
        index: 0,
        delta: { content: " \t\u00a0\n\ufeff" },
        finish_reason: null,
      }],
    }) + event("[DONE]");
    const deltas: string[] = [];

    await expect(harness(streamTransport([payload])).provider.generate(
      { system: "s", user: "u", maxOutputTokens: 100 },
      (delta) => deltas.push(delta),
    )).rejects.toMatchObject({ code: "empty-output" });

    expect(deltas).toEqual([]);
  });
});
