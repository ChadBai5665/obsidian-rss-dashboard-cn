import { afterEach, describe, expect, it, vi } from "vitest";

import type { AiConnection } from "../../../../src/ai/ai-types";
import {
  OpenAiChatProvider,
  type AiTransport,
  type AiTransportRequest,
} from "../../../../src/ai/providers/openai-chat-provider";
import {
  MAX_AI_REQUEST_CHARACTERS,
  snapshotGenerationRequest,
} from "../../../../src/ai/providers/text-generation-provider";
import { ProviderError } from "../../../../src/ai/providers/provider-error";

const API_KEY = "provider-secret-key";

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

function success(json: unknown = {
  id: "req-safe-1",
  choices: [{ message: { content: "生成结果" } }],
  usage: { prompt_tokens: 12, completion_tokens: 7 },
}) {
  return { status: 200, headers: {}, json };
}

function harness(
  response: unknown = success(),
  overrides: Partial<AiConnection> = {},
  supportsStoreFalse = false,
) {
  const requests: AiTransportRequest[] = [];
  const transport = vi.fn<AiTransport>((request) => {
    requests.push(request);
    return Promise.resolve(response);
  });
  const provider = new OpenAiChatProvider({
    connection: connection(overrides),
    apiKey: API_KEY,
    transport,
    supportsStoreFalse,
  });
  return { provider, requests, transport };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("OpenAI-compatible provider", () => {
  it("uses the exported single request-character boundary", () => {
    expect(snapshotGenerationRequest({
      system: "s",
      user: "u".repeat(MAX_AI_REQUEST_CHARACTERS - 1),
      maxOutputTokens: 10,
    }).user).toHaveLength(MAX_AI_REQUEST_CHARACTERS - 1);
    expect(() => snapshotGenerationRequest({
      system: "s",
      user: "u".repeat(MAX_AI_REQUEST_CHARACTERS),
      maxOutputTokens: 10,
    })).toThrow();
  });

  it.each([
    ["openai", "https://api.openai.com/v1", "https://api.openai.com/v1/chat/completions"],
    ["kimi", "https://api.moonshot.cn/v1", "https://api.moonshot.cn/v1/chat/completions"],
    ["deepseek", "https://api.deepseek.com", "https://api.deepseek.com/chat/completions"],
    ["qwen", "https://dashscope.aliyuncs.com/compatible-mode/v1", "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"],
    ["glm", "https://open.bigmodel.cn/api/paas/v4", "https://open.bigmodel.cn/api/paas/v4/chat/completions"],
    [
      "openai-compatible",
      "https://relay.example.com/v1",
      "https://relay.example.com/v1/chat/completions",
    ],
  ] as const)("sends max_tokens to %s at %s", async (providerKind, baseUrl, expectedUrl) => {
    const test = harness(success(), { providerKind, baseUrl });
    const controller = new AbortController();

    await expect(test.provider.generate({
      system: "系统提示",
      user: "用户内容",
      maxOutputTokens: 512,
      signal: controller.signal,
    })).resolves.toEqual({
      text: "生成结果",
      providerRequestId: "req-safe-1",
      inputTokens: 12,
      outputTokens: 7,
    });

    expect(test.requests).toHaveLength(1);
    expect(test.requests[0]).toEqual({
      url: expectedUrl,
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-user-selected",
        messages: [
          { role: "system", content: "系统提示" },
          { role: "user", content: "用户内容" },
        ],
        stream: false,
        max_tokens: 512,
      }),
      signal: controller.signal,
    });
  });

  it("resolves a blank Kimi model before a direct provider request", async () => {
    const test = harness(success(), {
      providerKind: "kimi",
      baseUrl: "https://api.moonshot.cn/v1",
      model: "",
    });

    await test.provider.generate({ system: "system", user: "user", maxOutputTokens: 10 });

    expect(JSON.parse(test.requests[0]?.body ?? "{}")).toMatchObject({
      model: "kimi-latest",
      max_tokens: 10,
    });
  });

  it("adds store:false only through an explicit capability and never retries", async () => {
    const supported = harness(success(), {}, true);
    await supported.provider.generate({
      system: "system",
      user: "user",
      maxOutputTokens: 100,
    });
    expect(JSON.parse(supported.requests[0]?.body ?? "{}")).toMatchObject({
      store: false,
    });
    expect(supported.transport).toHaveBeenCalledOnce();

    const omitted = harness(success(), {}, false);
    await omitted.provider.generate({
      system: "system",
      user: "user",
      maxOutputTokens: 100,
    });
    expect(JSON.parse(omitted.requests[0]?.body ?? "{}")).not.toHaveProperty("store");
    expect(omitted.transport).toHaveBeenCalledOnce();
  });

  it.each([
    [400, "invalid-request"],
    [401, "invalid-key"],
    [403, "invalid-key"],
    [402, "insufficient-balance"],
    [408, "timeout"],
    [504, "timeout"],
    [429, "rate-limited"],
    [500, "provider-failure"],
    [599, "provider-failure"],
  ] as const)("maps HTTP %i to static %s", async (status, code) => {
    const test = harness({
      status,
      headers: { Authorization: API_KEY, "x-private": "response-body-secret" },
      json: { error: `body ${API_KEY}` },
    });
    const error = await test.provider.generate({
      system: "system",
      user: "user",
      maxOutputTokens: 10,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code, status });
    expect(JSON.stringify(error)).not.toContain(API_KEY);
    expect(String(error)).not.toContain("response-body-secret");
    expect(error).not.toHaveProperty("headers");
    expect(error).not.toHaveProperty("body");
  });

  it.each([
    ["malformed root", { id: "safe", choices: "not-an-array" }, "malformed-response"],
    ["empty choices", { choices: [] }, "empty-output"],
    ["empty content", { choices: [{ message: { content: "  " } }] }, "empty-output"],
  ] as const)("rejects %s with a typed static error", async (_label, json, code) => {
    const test = harness(success(json));
    await expect(test.provider.generate({
      system: "system",
      user: "user",
      maxOutputTokens: 10,
    })).rejects.toMatchObject({ code });
  });

  it("maps synchronous, asynchronous, and hostile thenable failures to one static offline error", async () => {
    const failures: AiTransport[] = [
      () => {
        throw new Error(`sync ${API_KEY} private-body`);
      },
      () => Promise.reject(new Error(`async ${API_KEY} private-body`)),
      () => {
        const hostile: Record<string, unknown> = {};
        Object.defineProperty(hostile, "then", {
          get() {
            throw new Error(`then ${API_KEY} private-body`);
          },
        });
        return hostile;
      },
    ];

    for (const transport of failures) {
      const provider = new OpenAiChatProvider({
        connection: connection(),
        apiKey: API_KEY,
        transport,
      });
      const error = await provider.generate({
        system: "system",
        user: "user",
        maxOutputTokens: 10,
      }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "network-failure" });
      expect(String(error)).not.toContain(API_KEY);
      expect(JSON.stringify(error)).not.toContain("private-body");
    }
  });

  it("preserves AbortSignal identity and clears the timeout after abort", async () => {
    vi.useFakeTimers();
    const clearTimeout = vi.spyOn(window, "clearTimeout");
    let captured: AiTransportRequest | undefined;
    const transport = vi.fn<AiTransport>((request) => {
      captured = request;
      return new Promise(() => undefined);
    });
    const provider = new OpenAiChatProvider({
      connection: connection({ timeoutMs: 10_000 }),
      apiKey: API_KEY,
      transport,
    });
    const controller = new AbortController();
    const pending = provider.generate({
      system: "system",
      user: "user",
      maxOutputTokens: 10,
      signal: controller.signal,
    });

    expect(captured?.signal).toBe(controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    expect(clearTimeout).toHaveBeenCalled();
  });

  it("times out a pending transport once and clears the timer", async () => {
    vi.useFakeTimers();
    const clearTimeout = vi.spyOn(window, "clearTimeout");
    const provider = new OpenAiChatProvider({
      connection: connection({ timeoutMs: 25 }),
      apiKey: API_KEY,
      transport: () => new Promise(() => undefined),
    });
    const pending = provider.generate({
      system: "system",
      user: "user",
      maxOutputTokens: 10,
    });
    const rejection = expect(pending).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(clearTimeout).toHaveBeenCalled();
  });

  it("rejects a pre-aborted signal without transport", async () => {
    const test = harness();
    const controller = new AbortController();
    controller.abort();
    await expect(test.provider.generate({
      system: "system",
      user: "user",
      maxOutputTokens: 10,
      signal: controller.signal,
    })).rejects.toMatchObject({ code: "aborted" });
    expect(test.transport).not.toHaveBeenCalled();
  });

  it.each(["status", "headers", "json"] as const)(
    "never invokes a hostile response %s getter",
    async (property) => {
      const response: Record<string, unknown> = {
        status: 200,
        headers: {},
        json: success().json,
      };
      let getterCalls = 0;
      Object.defineProperty(response, property, {
        enumerable: true,
        get() {
          getterCalls += 1;
          throw new Error(`${API_KEY} private-body`);
        },
      });
      const error = await harness(response).provider.generate({
        system: "system",
        user: "user",
        maxOutputTokens: 10,
      }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "malformed-response" });
      expect(getterCalls).toBe(0);
      expect(String(error)).not.toContain(API_KEY);
    },
  );

  it("rejects malformed raw JSON distinctly from offline transport", async () => {
    const test = harness({ status: 200, headers: {}, text: "{" });
    await expect(test.provider.generate({
      system: "system",
      user: "user",
      maxOutputTokens: 10,
    })).rejects.toMatchObject({ code: "malformed-response" });
  });

  it("accepts safe response request IDs but drops IDs and output containing the API key", async () => {
    const safe = harness({
      status: 200,
      headers: { "x-request-id": "header-safe" },
      json: { choices: [{ message: { content: "ok" } }] },
    });
    await expect(safe.provider.generate({
      system: "system",
      user: "user",
      maxOutputTokens: 10,
    })).resolves.toMatchObject({ providerRequestId: "header-safe" });

    const secretId = harness(success({
      id: `prefix-${API_KEY}-suffix`,
      choices: [{ message: { content: "ok" } }],
    }));
    await expect(secretId.provider.generate({
      system: "system",
      user: "user",
      maxOutputTokens: 10,
    })).resolves.toEqual({ text: "ok" });

    const secretText = harness(success({
      choices: [{ message: { content: `reflected ${API_KEY}` } }],
    }));
    const error = await secretText.provider.generate({
      system: "system",
      user: "user",
      maxOutputTokens: 10,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect(JSON.stringify(error)).not.toContain(API_KEY);
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])(
    "rejects unsafe usage token count %s",
    async (promptTokens) => {
      const test = harness(success({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: promptTokens, completion_tokens: 1 },
      }));
      await expect(test.provider.generate({
        system: "system",
        user: "user",
        maxOutputTokens: 10,
      })).rejects.toMatchObject({ code: "malformed-response" });
    },
  );

  it("rejects sparse, inherited, accessor-backed, and non-plain success schemas", async () => {
    const sparseChoices = new Array(1);
    const inheritedRoot = Object.create({
      choices: [{ message: { content: "inherited" } }],
    });
    const accessorMessage: Record<string, unknown> = {};
    Object.defineProperty(accessorMessage, "content", {
      get() {
        throw new Error(API_KEY);
      },
    });
    for (const json of [
      { choices: sparseChoices },
      inheritedRoot,
      { choices: [{ message: accessorMessage }] },
      new Date(),
    ]) {
      const error = await harness(success(json)).provider.generate({
        system: "system",
        user: "user",
        maxOutputTokens: 10,
      }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "malformed-response" });
      expect(String(error)).not.toContain(API_KEY);
    }
  });

  it("snapshots only exact own-data request fields without invoking getters or accepting prototypes", async () => {
    let getterCalls = 0;
    const getterRequest: Record<string, unknown> = {
      user: "user",
      maxOutputTokens: 10,
    };
    Object.defineProperty(getterRequest, "system", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error(`${API_KEY} request getter`);
      },
    });
    const inherited = Object.create({ system: "system" }) as Record<string, unknown>;
    inherited.user = "user";
    inherited.maxOutputTokens = 10;
    const symbolRequest = {
      system: "system",
      user: "user",
      maxOutputTokens: 10,
      [Symbol("extra")]: true,
    };
    const extraRequest = {
      system: "system",
      user: "user",
      maxOutputTokens: 10,
      extra: "not-allowed",
    };
    const proxyRequest = new Proxy(
      { system: "system", user: "user", maxOutputTokens: 10 },
      {
        ownKeys() {
          throw new Error(`${API_KEY} proxy trap`);
        },
      },
    );

    for (const request of [
      getterRequest,
      inherited,
      symbolRequest,
      extraRequest,
      proxyRequest,
    ]) {
      const test = harness();
      const error = await test.provider.generate(
        request as unknown as Parameters<typeof test.provider.generate>[0],
      ).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "invalid-request" });
      expect(String(error)).not.toContain(API_KEY);
      expect(test.transport).not.toHaveBeenCalled();
    }
    expect(getterCalls).toBe(0);
  });

  it("requires a real AbortSignal brand and ignores hostile instance method overrides", async () => {
    const fakeSignal = {
      aborted: false,
      addEventListener() {
        throw new Error(API_KEY);
      },
      removeEventListener() {
        throw new Error(API_KEY);
      },
    };
    const rejected = harness();
    const error = await rejected.provider.generate({
      system: "system",
      user: "user",
      maxOutputTokens: 10,
      signal: fakeSignal as unknown as AbortSignal,
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "invalid-request" });
    expect(String(error)).not.toContain(API_KEY);
    expect(rejected.transport).not.toHaveBeenCalled();

    const controller = new AbortController();
    Object.defineProperty(controller.signal, "addEventListener", {
      get() {
        throw new Error(`${API_KEY} add getter`);
      },
    });
    Object.defineProperty(controller.signal, "removeEventListener", {
      get() {
        throw new Error(`${API_KEY} remove getter`);
      },
    });
    const accepted = harness();
    await expect(accepted.provider.generate({
      system: "system",
      user: "user",
      maxOutputTokens: 10,
      signal: controller.signal,
    })).resolves.toMatchObject({ text: "生成结果" });
    expect(accepted.requests[0]?.signal).toBe(controller.signal);
  });

  it("caps maxOutputTokens before transport", async () => {
    const test = harness();
    await expect(test.provider.generate({
      system: "system",
      user: "user",
      maxOutputTokens: Number.MAX_SAFE_INTEGER,
    })).rejects.toMatchObject({ code: "invalid-request" });
    expect(test.transport).not.toHaveBeenCalled();
  });

  it("rejects oversized raw responses, output text, cycles, and excessive nodes", async () => {
    const oversizedRaw = harness({
      status: 200,
      headers: {},
      text: JSON.stringify({
        choices: [{ message: { content: "x".repeat(1_000_001) } }],
      }),
    });
    await expect(oversizedRaw.provider.generate({
      system: "system",
      user: "user",
      maxOutputTokens: 10,
    })).rejects.toMatchObject({ code: "response-too-large" });

    const oversizedOutput = harness(success({
      choices: [{ message: { content: "x".repeat(10_000) } }],
    }));
    await expect(oversizedOutput.provider.generate({
      system: "system",
      user: "user",
      maxOutputTokens: 10,
    })).rejects.toMatchObject({ code: "response-too-large" });

    const cyclic: Record<string, unknown> = {
      choices: [{ message: { content: "ok" } }],
    };
    cyclic.cycle = cyclic;
    await expect(harness(success(cyclic)).provider.generate({
      system: "system",
      user: "user",
      maxOutputTokens: 10,
    })).rejects.toMatchObject({ code: "malformed-response" });

    const excessiveNodes = Array.from({ length: 10_001 }, () => null);
    await expect(harness(success({
      choices: [{ message: { content: "ok" } }],
      excessiveNodes,
    })).provider.generate({
      system: "system",
      user: "user",
      maxOutputTokens: 10,
    })).rejects.toMatchObject({ code: "response-too-large" });
  });
});
