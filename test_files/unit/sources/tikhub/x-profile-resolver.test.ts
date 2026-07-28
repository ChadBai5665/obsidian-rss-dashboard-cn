import { describe, expect, it, vi } from "vitest";

import type { TikHubSettings } from "../../../../src/types/types";
import {
  TikHubClientError,
  type TikHubUserRequest,
} from "../../../../src/sources/tikhub/tikhub-client";
import type { TikHubResult } from "../../../../src/sources/tikhub/tikhub-types";
import {
  XProfileResolver,
} from "../../../../src/sources/tikhub/x-profile-resolver";

const API_KEY = "profile-resolver-secret";
const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const PROFILE_PAYLOAD = {
  data: {
    user: {
      result: {
        rest_id: "123",
        legacy: { screen_name: "openai", name: "OpenAI" },
      },
    },
  },
};

function settings(overrides: Partial<TikHubSettings> = {}): TikHubSettings {
  return {
    enabled: true,
    connectionId: CONNECTION_ID,
    baseUrl: "https://custom.example.com",
    timeoutMs: 20_000,
    maxRequestsPerRun: 40,
    maxRequestsPerDay: 100,
    ...overrides,
  };
}

function harness(options: {
  settings?: TikHubSettings;
  apiKey?: string;
  fetch?: (input: TikHubUserRequest) => Promise<TikHubResult<unknown>>;
} = {}) {
  const events: string[] = [];
  const get = vi.fn(async (connectionId: string) => {
    events.push(`get:${connectionId}`);
    return options.apiKey === undefined ? API_KEY : options.apiKey;
  });
  const fetchUserProfile = vi.fn(options.fetch ?? (async (input) => {
    events.push(`fetch:${input.handle}`);
    return { data: PROFILE_PAYLOAD, requestId: "request-safe" };
  }));
  const resolver = new XProfileResolver({
    settings: options.settings ?? settings(),
    secretStore: { get },
    client: { fetchUserProfile },
  });
  return { events, fetchUserProfile, get, resolver };
}

describe("XProfileResolver", () => {
  it("returns a short-lived opaque verification with the safe profile projection", async () => {
    const test = harness();

    const verified = await test.resolver.resolve("openai");

    expect(verified.profile).toEqual({
      restId: "123",
      handle: "openai",
      displayName: "OpenAI",
      verified: false,
    });
    expect(verified.proof).toBeDefined();
    expect(JSON.stringify(verified.proof)).toBe("{}");
    expect(test.events).toEqual([
      `get:${CONNECTION_ID}`,
      "fetch:openai",
    ]);
    expect(test.fetchUserProfile).toHaveBeenCalledWith({
      apiKey: API_KEY,
      handle: "openai",
      signal: undefined,
    });
    expect(JSON.stringify(test.resolver)).not.toContain(API_KEY);
    expect(Object.values(test.resolver as unknown as Record<string, unknown>))
      .not.toContain(API_KEY);
  });

  it("blocks disabled TikHub before secret or client access", async () => {
    const test = harness({ settings: settings({ enabled: false }) });

    await expect(test.resolver.resolve("openai")).rejects.toMatchObject({
      code: "tikhub-disabled",
    });
    expect(test.get).not.toHaveBeenCalled();
    expect(test.fetchUserProfile).not.toHaveBeenCalled();
  });

  it.each([
    ["missing UUID", settings({ connectionId: "" }), API_KEY],
    ["missing stored key", settings(), ""],
  ])("maps %s to missing-key before transport", async (_name, value, apiKey) => {
    const test = harness({ settings: value, apiKey });

    await expect(test.resolver.resolve("openai")).rejects.toMatchObject({
      code: "missing-key",
    });
    expect(test.fetchUserProfile).not.toHaveBeenCalled();
  });

  it("rejects an invalid stored key before transport", async () => {
    const test = harness({ apiKey: "invalid\nkey" });

    await expect(test.resolver.resolve("openai")).rejects.toMatchObject({
      code: "invalid-key",
    });
    expect(test.fetchUserProfile).not.toHaveBeenCalled();
  });

  it("rejects a hostile non-string secret without touching its accessors", async () => {
    let getterCalls = 0;
    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostile, "trim", {
      get() {
        getterCalls += 1;
        throw new Error("unsafe secret accessor");
      },
    });
    const get = vi.fn(async () => hostile) as unknown as (
      connectionId: string,
    ) => Promise<string | undefined>;
    const fetchUserProfile = vi.fn();
    const resolver = new XProfileResolver({
      settings: settings(),
      secretStore: { get },
      client: { fetchUserProfile },
    });

    await expect(resolver.resolve("openai")).rejects.toMatchObject({
      code: "invalid-key",
    });
    expect(getterCalls).toBe(0);
    expect(fetchUserProfile).not.toHaveBeenCalled();
  });

  it.each([
    [new TikHubClientError("invalid-key", "unsafe"), "invalid-key"],
    [new TikHubClientError("insufficient-balance", "unsafe"), "insufficient-balance"],
    [new TikHubClientError("rate-limited", "unsafe"), "rate-limited"],
    [new TikHubClientError("timeout", "unsafe"), "network-timeout"],
    [new TikHubClientError("provider-rejected", "unsafe", 404), "not-found"],
    [new TikHubClientError("network-failure", "unsafe"), "network-failure"],
    [new TikHubClientError("malformed-response", "unsafe"), "malformed-response"],
    [new TikHubClientError("provider-failure", "unsafe"), "provider-failure"],
    [new TikHubClientError("aborted", "unsafe"), "provider-failure"],
  ])("maps client failure to stable resolver code %s", async (failure, code) => {
    const test = harness({ fetch: async () => { throw failure; } });

    const error = await test.resolver.resolve("openai").catch((caught) => caught);
    expect(error).toMatchObject({ code });
    expect(error).not.toHaveProperty("diagnostic");
    expect(String(error)).not.toContain("unsafe");
  });

  it("forwards AbortSignal to the client", async () => {
    const controller = new AbortController();
    const test = harness();

    await test.resolver.resolve("openai", controller.signal);

    expect(test.fetchUserProfile.mock.calls[0]?.[0].signal).toBe(
      controller.signal,
    );
  });

  it("attaches only a frozen value-free diagnostic after one unsupported-shape request", async () => {
    const providerSentinel = "SECRET_NAVAL_VALUE";
    const providerUrl = `https://provider.example/${providerSentinel}`;
    const test = harness({
      apiKey: `${API_KEY}-${providerSentinel}`,
      fetch: async () => ({
        data: {
          providerSecretField: providerUrl,
          result: {
            rest_id: { providerSecretField: providerSentinel },
            legacy: {
              screen_name: providerSentinel,
              name: providerSentinel,
            },
          },
        },
      }),
    });

    const error = await test.resolver.resolve("openai").catch((caught) => caught);

    expect(error).toMatchObject({
      code: "profile-shape-unsupported",
      diagnostic: {
        issue: "required-field-invalid",
        visitedContainers: 4,
        candidateCount: 1,
        hasLegacyContainer: true,
        hasCoreContainer: false,
      },
    });
    expect(error.message).toBe("profile-shape-unsupported");
    expect(test.fetchUserProfile).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(error.diagnostic)).toBe(true);
    expect(Object.keys(error.diagnostic)).toEqual([
      "issue",
      "visitedContainers",
      "candidateCount",
      "hasLegacyContainer",
      "hasCoreContainer",
    ]);
    expect(JSON.stringify(error)).not.toContain(providerSentinel);
    expect(JSON.stringify(error.diagnostic)).not.toContain(providerUrl);
    expect(String(error)).not.toContain(providerSentinel);
  });

  it("rejects a returned handle that does not match the requested account", async () => {
    const test = harness({
      fetch: async () => ({
        data: {
          result: {
            rest_id: "456",
            legacy: { screen_name: "different", name: "Different" },
          },
        },
      }),
    });

    await expect(test.resolver.resolve("openai")).rejects.toMatchObject({
      code: "not-found",
    });
  });
});
