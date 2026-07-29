import { describe, expect, it } from "vitest";

import {
  AI_PROVIDER_PRESETS,
  createAiConnection,
  getAiProviderPreset,
  resolveAiConnectionForRequest,
} from "../../../src/ai/provider-presets";
import { normalizeAiConnection } from "../../../src/ai/connection-validation";

describe("AI provider presets", () => {
  it("defines the ten provider default-model policies", () => {
    expect(AI_PROVIDER_PRESETS.map(({ providerKind, defaultModel }) => [
      providerKind,
      defaultModel,
    ])).toEqual([
      ["kimi", "kimi-latest"],
      ["deepseek", "deepseek-v4-pro"],
      ["qwen", "qwen3.7-plus"],
      ["glm", "glm-5.2"],
      ["openai", "gpt-5.6"],
      ["claude", "claude-sonnet-5"],
      ["minimax-cn", "MiniMax-M3"],
      ["minimax-global", "MiniMax-M3"],
      ["openai-compatible", undefined],
      ["anthropic-compatible", undefined],
    ]);
  });

  it("resolves an official default model only for a blank official connection", () => {
    const following = createAiConnection({
      id: "33333333-3333-4333-8333-333333333333",
      name: "跟随默认",
      providerKind: "minimax-cn",
      model: "",
    });
    expect(following.model).toBe("");
    expect(resolveAiConnectionForRequest(following)?.model).toBe("MiniMax-M3");

    const pinned = createAiConnection({
      id: "44444444-4444-4444-8444-444444444444",
      name: "固定模型",
      providerKind: "deepseek",
      model: "deepseek-account-model",
    });
    expect(resolveAiConnectionForRequest(pinned)?.model).toBe(
      "deepseek-account-model",
    );
  });

  it("creates metadata defaults without inventing a model or storing a key", () => {
    expect(
      createAiConnection({
        id: "11111111-1111-4111-8111-111111111111",
        name: "Kimi",
        providerKind: "kimi",
        model: "moonshot-user-selected",
      }),
    ).toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      name: "Kimi",
      providerKind: "kimi",
      protocol: "openai-chat",
      baseUrl: "https://api.moonshot.cn/v1",
      model: "moonshot-user-selected",
      timeoutMs: 60_000,
      maxInputCharacters: 80_000,
      enabled: true,
      thinkingMode: "platform-default",
      reasoningEffort: "platform-default",
      responseMode: "stream",
    });
    expect(getAiProviderPreset("kimi")?.baseUrl).toBe(
      "https://api.moonshot.cn/v1",
    );
    expect(
      createAiConnection({
        id: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
        name: "Uppercase legacy input",
        providerKind: "openai",
        model: "user-selected",
      }).id,
    ).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  });

  it("requires a user-supplied endpoint for compatible relays", () => {
    expect(() =>
      createAiConnection({
        id: "22222222-2222-4222-8222-222222222222",
        name: "OpenAI relay",
        providerKind: "openai-compatible",
        baseUrl: "",
        model: "relay-model",
      }),
    ).toThrow("Invalid AI connection");
  });

  it("keeps canonical creation and validation isolated from exported preset mutation", () => {
    const publicPresets = AI_PROVIDER_PRESETS as unknown as Array<
      Record<string, unknown>
    >;
    const kimi = publicPresets.find((preset) => preset.providerKind === "kimi");
    expect(kimi).toBeDefined();
    const originalProtocol = kimi?.protocol;
    const originalBaseUrl = kimi?.baseUrl;

    try {
      if (kimi) {
        Reflect.set(kimi, "protocol", "anthropic-messages");
        Reflect.set(kimi, "baseUrl", "https://attacker.invalid/v1");
      }
      expect(
        createAiConnection({
          id: "11111111-1111-4111-8111-111111111111",
          name: "Kimi",
          providerKind: "kimi",
          model: "selected-model",
        }),
      ).toMatchObject({
        protocol: "openai-chat",
        baseUrl: "https://api.moonshot.cn/v1",
      });
      expect(
        normalizeAiConnection({
          id: "11111111-1111-4111-8111-111111111111",
          name: "Kimi",
          providerKind: "kimi",
          protocol: "openai-chat",
          baseUrl: "https://api.moonshot.cn/v1",
          model: "selected-model",
          timeoutMs: 60_000,
          maxInputCharacters: 80_000,
          enabled: true,
        }),
      ).toBeDefined();
    } finally {
      if (kimi) {
        Reflect.set(kimi, "protocol", originalProtocol);
        Reflect.set(kimi, "baseUrl", originalBaseUrl);
      }
    }
  });

  it("keeps canonical creation isolated from public reorder and deletion", () => {
    const publicPresets = AI_PROVIDER_PRESETS as unknown as Array<
      Record<string, unknown>
    >;
    const snapshot = [...publicPresets];
    try {
      Reflect.set(publicPresets, 0, publicPresets[1]);
      Reflect.deleteProperty(publicPresets, 1);
      expect(
        createAiConnection({
          id: "11111111-1111-4111-8111-111111111111",
          name: "Kimi",
          providerKind: "kimi",
          model: "selected-model",
        }),
      ).toMatchObject({
        protocol: "openai-chat",
        baseUrl: "https://api.moonshot.cn/v1",
      });
    } finally {
      snapshot.forEach((preset, index) => {
        Reflect.set(publicPresets, index, preset);
      });
    }
  });

  it("returns immutable independent preset snapshots across calls", () => {
    const first = getAiProviderPreset("openai") as Record<string, unknown>;
    const originalBaseUrl = first.baseUrl;
    try {
      Reflect.set(first, "baseUrl", "https://attacker.invalid/v1");
      Reflect.deleteProperty(first, "protocol");
      const second = getAiProviderPreset("openai");

      expect(second).not.toBe(first);
      expect(second).toEqual({
        providerKind: "openai",
        protocol: "openai-chat",
        baseUrl: "https://api.openai.com/v1",
        defaultModel: "gpt-5.6",
      });
      expect(Object.isFrozen(second)).toBe(true);
    } finally {
      Reflect.set(first, "baseUrl", originalBaseUrl);
      Reflect.set(first, "protocol", "openai-chat");
    }
  });
});
