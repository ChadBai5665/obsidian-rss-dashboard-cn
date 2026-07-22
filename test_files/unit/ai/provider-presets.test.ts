import { describe, expect, it } from "vitest";

import {
  AI_PROVIDER_PRESETS,
  createAiConnection,
  getAiProviderPreset,
} from "../../../src/ai/provider-presets";
import { normalizeAiConnection } from "../../../src/ai/connection-validation";

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
    });
    expect(getAiProviderPreset("kimi")?.baseUrl).toBe(
      "https://api.moonshot.cn/v1",
    );
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
      });
      expect(Object.isFrozen(second)).toBe(true);
    } finally {
      Reflect.set(first, "baseUrl", originalBaseUrl);
      Reflect.set(first, "protocol", "openai-chat");
    }
  });
});
