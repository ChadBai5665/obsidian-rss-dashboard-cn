import { describe, expect, it } from "vitest";

import {
  AI_PROVIDER_PRESETS,
  createAiConnection,
  getAiProviderPreset,
} from "../../../src/ai/provider-presets";

describe("AI provider presets", () => {
  it("defines the six fixed providers with exact protocols and base URLs", () => {
    expect(AI_PROVIDER_PRESETS).toEqual([
      {
        providerKind: "kimi",
        protocol: "openai-chat",
        baseUrl: "https://api.moonshot.cn/v1",
      },
      {
        providerKind: "deepseek",
        protocol: "openai-chat",
        baseUrl: "https://api.deepseek.com",
      },
      {
        providerKind: "qwen",
        protocol: "openai-chat",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      },
      {
        providerKind: "glm",
        protocol: "openai-chat",
        baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      },
      {
        providerKind: "openai",
        protocol: "openai-chat",
        baseUrl: "https://api.openai.com/v1",
      },
      {
        providerKind: "claude",
        protocol: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
      },
      {
        providerKind: "openai-compatible",
        protocol: "openai-chat",
      },
      {
        providerKind: "anthropic-compatible",
        protocol: "anthropic-messages",
      },
    ]);
  });

  it("creates metadata defaults without inventing a model or storing a key", () => {
    expect(
      createAiConnection({
        id: "connection-1",
        name: "Kimi",
        providerKind: "kimi",
        model: "moonshot-user-selected",
      }),
    ).toEqual({
      id: "connection-1",
      name: "Kimi",
      providerKind: "kimi",
      protocol: "openai-chat",
      baseUrl: "https://api.moonshot.cn/v1",
      model: "moonshot-user-selected",
      timeoutMs: 60_000,
      maxInputCharacters: 80_000,
      enabled: true,
    });
    expect(getAiProviderPreset("kimi")?.baseUrl).toBe(
      "https://api.moonshot.cn/v1",
    );
  });

  it("requires a user-supplied endpoint for compatible relays", () => {
    expect(() =>
      createAiConnection({
        id: "relay-1",
        name: "OpenAI relay",
        providerKind: "openai-compatible",
        baseUrl: "",
        model: "relay-model",
      }),
    ).toThrow("Invalid AI connection");
  });
});
