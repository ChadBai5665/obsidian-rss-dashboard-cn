import { describe, expect, it, vi } from "vitest";

import type { AiConnection } from "../../../../src/ai/ai-types";
import {
  AnthropicMessagesProvider,
  type AiTransport,
  type AiTransportRequest,
} from "../../../../src/ai/providers/anthropic-messages-provider";

const API_KEY = "anthropic-secret-key";

function connection(baseUrl = "https://api.anthropic.com"): AiConnection {
  return {
    id: "claude-1",
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

function success(json: unknown = {
  id: "msg-safe-1",
  content: [
    { type: "text", text: "第一段" },
    { type: "tool_use", id: "ignored" },
    { type: "text", text: "第二段" },
  ],
  usage: { input_tokens: 13, output_tokens: 8 },
}) {
  return { status: 200, headers: {}, json };
}

function harness(response: unknown = success(), baseUrl?: string) {
  const requests: AiTransportRequest[] = [];
  const transport = vi.fn<AiTransport>((request) => {
    requests.push(request);
    return Promise.resolve(response);
  });
  const provider = new AnthropicMessagesProvider({
    connection: connection(baseUrl),
    apiKey: API_KEY,
    transport,
  });
  return { provider, requests, transport };
}

describe("Anthropic-compatible provider", () => {
  it.each([
    ["https://api.anthropic.com", "https://api.anthropic.com/v1/messages"],
    ["https://relay.example.com/v1", "https://relay.example.com/v1/messages"],
    [
      "https://relay.example.com/anthropic/v1",
      "https://relay.example.com/anthropic/v1/messages",
    ],
    [
      "https://relay.example.com/anthropic/v1/messages",
      "https://relay.example.com/anthropic/v1/messages",
    ],
    [
      "https://relay.example.com/anthropic",
      "https://relay.example.com/anthropic/v1/messages",
    ],
  ])("joins the exact messages endpoint for %s", async (baseUrl, expectedUrl) => {
    const test = harness(success(), baseUrl);
    const controller = new AbortController();

    await expect(test.provider.generate({
      system: "系统提示",
      user: "用户内容",
      maxOutputTokens: 1024,
      signal: controller.signal,
    })).resolves.toEqual({
      text: "第一段第二段",
      providerRequestId: "msg-safe-1",
      inputTokens: 13,
      outputTokens: 8,
    });

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
      }),
      signal: controller.signal,
    }]);
  });

  it("rejects missing, malformed, sparse, inherited, and accessor-backed content", async () => {
    const cases: unknown[] = [
      {},
      { content: "text" },
      { content: [] },
      { content: [{ type: "text", text: " " }] },
      { content: new Array(1) },
      { content: [{ type: "text", text: "ok" }], usage: { input_tokens: -1 } },
    ];

    const inherited = Object.create({ content: [{ type: "text", text: "secret" }] });
    cases.push(inherited);
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, "content", {
      get() {
        throw new Error(API_KEY);
      },
    });
    cases.push(accessor);

    for (const json of cases) {
      const test = harness(success(json));
      const error = await test.provider.generate({
        system: "system",
        user: "user",
        maxOutputTokens: 10,
      }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        code: expect.stringMatching(/^(malformed-response|empty-output)$/u),
      });
      expect(String(error)).not.toContain(API_KEY);
    }
  });
});
