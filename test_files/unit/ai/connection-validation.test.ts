import { describe, expect, it } from "vitest";

import { MAX_AI_SELECTED_CONTENT_CHARACTERS } from "../../../src/ai/ai-types";

import {
  normalizeAiBaseUrl,
  normalizeAiConnection,
  normalizeAiSettings,
} from "../../../src/ai/connection-validation";

function connection(overrides: Record<string, unknown> = {}) {
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

describe("AI connection validation", () => {
  it("normalizes only trailing slashes and preserves intentional base paths", () => {
    expect(
      normalizeAiBaseUrl(
        "https://relay.example.com/compatible-mode/v1///",
        "openai-compatible",
      ),
    ).toBe("https://relay.example.com/compatible-mode/v1");
  });

  it.each([
    "http://relay.example.com/v1",
    "https://user:password@relay.example.com/v1",
    "https://relay.example.com/v1?token=secret",
    "https://relay.example.com/v1#secret",
    "https://relay.example.com/v1\\chat",
    "https://relay.example.com/v1/%2e%2e/private",
    "https://relay.example.com/v1/%0aheader",
  ])("rejects unsafe relay endpoint %s", (baseUrl) => {
    expect(normalizeAiBaseUrl(baseUrl, "openai-compatible")).toBeUndefined();
  });

  it("permits HTTP only for an explicitly selected compatible relay on an exact local hostname", () => {
    expect(
      normalizeAiBaseUrl(
        "http://localhost:11434/openai/v1/",
        "openai-compatible",
      ),
    ).toBe("http://localhost:11434/openai/v1");
    expect(
      normalizeAiBaseUrl(
        "http://127.0.0.1:8080/anthropic",
        "anthropic-compatible",
      ),
    ).toBe("http://127.0.0.1:8080/anthropic");

    for (const value of [
      "http://[::1]:11434/v1",
      "http://2130706433:11434/v1",
      "http://127.1:11434/v1",
      "http://localhost.:11434/v1",
      "http://localhost.evil.test:11434/v1",
    ]) {
      expect(normalizeAiBaseUrl(value, "openai-compatible")).toBeUndefined();
    }
    expect(
      normalizeAiBaseUrl("http://localhost:11434/v1", "openai"),
    ).toBeUndefined();
  });

  it("requires fixed provider protocol and exact canonical endpoint", () => {
    expect(normalizeAiConnection(connection())).toEqual(connection());
    expect(
      normalizeAiBaseUrl("https://relay.example.com/v1", "openai"),
    ).toBeUndefined();
    expect(
      normalizeAiBaseUrl("https://relay.example.com/v1", "unknown" as never),
    ).toBeUndefined();
    expect(
      normalizeAiConnection(connection({ protocol: "anthropic-messages" })),
    ).toBeUndefined();
    expect(
      normalizeAiConnection(
        connection({ baseUrl: "https://relay.example.com/v1" }),
      ),
    ).toBeUndefined();
  });

  it.each(["", "  ", "model\nheader", "model\u0000secret", "model\u0085next"])(
    "rejects invalid model id %j",
    (model) => {
      expect(normalizeAiConnection(connection({ model }))).toBeUndefined();
    },
  );

  it("rejects duplicate connection IDs and dangling defaults", () => {
    expect(
      normalizeAiSettings({
        connections: [connection(), connection({ name: "Duplicate" })],
      }),
    ).toEqual({ connections: [] });

    expect(
      normalizeAiSettings({
        connections: [connection()],
        defaultConnectionId: "missing",
      }),
    ).toEqual({ connections: [connection()] });
  });

  it("requires canonical UUID connection IDs and caps timeout at ten minutes", () => {
    expect(normalizeAiConnection(connection({ id: "connection-1" }))).toBeUndefined();
    expect(normalizeAiConnection(connection({ id: "11111111111141118111111111111111" }))).toBeUndefined();
    expect(normalizeAiConnection(connection({ timeoutMs: 600_001 }))).toBeUndefined();
    expect(normalizeAiConnection(connection({ timeoutMs: Number.MAX_SAFE_INTEGER }))).toBeUndefined();
    expect(normalizeAiConnection(connection({ timeoutMs: 600_000 }))).toMatchObject({
      timeoutMs: 600_000,
    });
    expect(normalizeAiConnection(connection({
      id: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
    }))).toMatchObject({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    expect(normalizeAiSettings({
      connections: [connection({ id: "legacy-connection" })],
      defaultConnectionId: "legacy-connection",
    })).toEqual({ connections: [] });
  });

  it("caps configured source content below the provider request envelope", () => {
    expect(normalizeAiConnection(connection({
      maxInputCharacters: MAX_AI_SELECTED_CONTENT_CHARACTERS,
    }))).toMatchObject({
      maxInputCharacters: MAX_AI_SELECTED_CONTENT_CHARACTERS,
    });
    expect(normalizeAiConnection(connection({
      maxInputCharacters: MAX_AI_SELECTED_CONTENT_CHARACTERS + 1,
    }))).toBeUndefined();
  });

  it("rejects unknown keys, inherited fields, getters, and sparse connection arrays", () => {
    expect(
      normalizeAiConnection(connection({ apiKey: "must-not-survive" })),
    ).toBeUndefined();

    const inherited = Object.create(connection());
    expect(normalizeAiConnection(inherited)).toBeUndefined();

    let getterCalls = 0;
    const getterBacked = connection();
    Object.defineProperty(getterBacked, "model", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "secret-from-getter";
      },
    });
    expect(normalizeAiConnection(getterBacked)).toBeUndefined();
    expect(getterCalls).toBe(0);

    const sparse = new Array(1);
    expect(normalizeAiSettings({ connections: sparse })).toEqual({
      connections: [],
    });
  });
});
