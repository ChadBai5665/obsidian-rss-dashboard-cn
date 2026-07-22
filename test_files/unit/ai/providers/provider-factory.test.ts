import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AiConnection } from "../../../../src/ai/ai-types";
import { createTextGenerationProvider } from "../../../../src/ai/providers/provider-factory";
import type { AiTransport } from "../../../../src/ai/providers/text-generation-provider";
import { DesktopSecretStore } from "../../../../src/security/desktop-secret-store";

const API_KEY = "factory-secret-key";
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

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

describe("AI provider factory", () => {
  it("reads the external key immediately before construction and retains no enumerable secret", async () => {
    const events: string[] = [];
    const secretStore = {
      get: vi.fn(async (id: string) => {
        events.push(`get:${id}`);
        return API_KEY;
      }),
    };
    const transport = vi.fn<AiTransport>(() => {
      events.push("transport");
      return Promise.resolve({
        status: 200,
        headers: {},
        json: { choices: [{ message: { content: "ok" } }] },
      });
    });

    const provider = await createTextGenerationProvider(
      connection(),
      secretStore,
      { transport },
    );
    expect(events).toEqual(["get:11111111-1111-4111-8111-111111111111"]);
    expect(JSON.stringify(provider)).not.toContain(API_KEY);
    expect(Object.values(provider as unknown as Record<string, unknown>)).not.toContain(API_KEY);

    await expect(provider.generate({
      system: "system",
      user: "user",
      maxOutputTokens: 10,
    })).resolves.toMatchObject({ text: "ok" });
    expect(events).toEqual([
      "get:11111111-1111-4111-8111-111111111111",
      "transport",
    ]);
  });

  it.each([undefined, "", "  ", "key\nheader"]) (
    "rejects a missing or invalid external key without transport: %j",
    async (apiKey) => {
      const transport = vi.fn<AiTransport>();
      await expect(createTextGenerationProvider(
        connection(),
        { get: vi.fn(async () => apiKey) },
        { transport },
      )).rejects.toMatchObject({ code: "missing-key" });
      expect(transport).not.toHaveBeenCalled();
    },
  );

  it("rejects invalid connection metadata before reading the key or making transport", async () => {
    const get = vi.fn(async () => API_KEY);
    const transport = vi.fn<AiTransport>();
    await expect(createTextGenerationProvider(
      connection({ protocol: "anthropic-messages" }),
      { get },
      { transport },
    )).rejects.toMatchObject({ code: "invalid-connection" });
    expect(get).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();

    await expect(createTextGenerationProvider(
      connection({ id: "legacy-connection-id" }),
      { get },
      { transport },
    )).rejects.toMatchObject({ code: "invalid-connection" });
    expect(get).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it("rejects a disabled connection and a secret-store failure before transport", async () => {
    const disabledGet = vi.fn(async () => API_KEY);
    const transport = vi.fn<AiTransport>();
    await expect(createTextGenerationProvider(
      connection({ enabled: false }),
      { get: disabledGet },
      { transport },
    )).rejects.toMatchObject({ code: "connection-disabled" });
    expect(disabledGet).not.toHaveBeenCalled();

    const error = await createTextGenerationProvider(
      connection(),
      {
        get: vi.fn(async () => {
          throw new Error(`${API_KEY} leaked by secret storage`);
        }),
      },
      { transport },
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "secret-store-failure" });
    expect(String(error)).not.toContain(API_KEY);
    expect(transport).not.toHaveBeenCalled();
  });

  it("fails closed on a hostile secret-store thenable without leaking or transporting", async () => {
    const transport = vi.fn<AiTransport>();
    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostile, "then", {
      get() {
        throw new Error(`${API_KEY} from then getter`);
      },
    });
    const get = vi.fn(() => hostile) as unknown as (
      id: string,
    ) => Promise<string | undefined>;
    const error = await createTextGenerationProvider(
      connection(),
      { get },
      { transport },
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "secret-store-failure" });
    expect(String(error)).not.toContain(API_KEY);
    expect(transport).not.toHaveBeenCalled();
  });

  it("selects both protocols and gives store:false only to the explicit OpenAI capability", async () => {
    const requests: Array<{ body: string; url: string }> = [];
    const transport = vi.fn<AiTransport>((request) => {
      requests.push(request);
      return request.url.endsWith("/v1/messages")
        ? {
            status: 200,
            headers: {},
            json: { content: [{ type: "text", text: "claude" }] },
          }
        : {
            status: 200,
            headers: {},
            json: { choices: [{ message: { content: "openai" } }] },
          };
    });
    const secretStore = { get: vi.fn(async () => API_KEY) };

    const openai = await createTextGenerationProvider(
      connection(),
      secretStore,
      { transport },
    );
    await openai.generate({ system: "s", user: "u", maxOutputTokens: 10 });

    const relay = await createTextGenerationProvider(
      connection({
        id: "22222222-2222-4222-8222-222222222222",
        name: "Relay",
        providerKind: "openai-compatible",
        protocol: "openai-chat",
        baseUrl: "https://relay.example.com/v1",
      }),
      secretStore,
      { transport },
    );
    await relay.generate({ system: "s", user: "u", maxOutputTokens: 10 });

    const anthropic = await createTextGenerationProvider(
      connection({
        id: "33333333-3333-4333-8333-333333333333",
        name: "Claude",
        providerKind: "claude",
        protocol: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
      }),
      secretStore,
      { transport },
    );
    await anthropic.generate({ system: "s", user: "u", maxOutputTokens: 10 });

    expect(JSON.parse(requests[0]?.body ?? "{}")).toHaveProperty("store", false);
    expect(JSON.parse(requests[1]?.body ?? "{}")).not.toHaveProperty("store");
    expect(requests[2]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it("snapshots safe metadata so later caller mutation cannot redirect a provider", async () => {
    const metadata = connection();
    const requests: Array<{ url: string; body: string }> = [];
    const provider = await createTextGenerationProvider(
      metadata,
      { get: vi.fn(async () => API_KEY) },
      {
        transport: (request) => {
          requests.push(request);
          return {
            status: 200,
            headers: {},
            json: { choices: [{ message: { content: "ok" } }] },
          };
        },
      },
    );
    metadata.baseUrl = "https://attacker.invalid/v1";
    metadata.model = API_KEY;

    await provider.generate({ system: "s", user: "u", maxOutputTokens: 10 });
    expect(requests[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(requests[0]?.body).not.toContain(API_KEY);
  });

  it("integrates with a real temporary DesktopSecretStore using the same UUID", async () => {
    const root = await mkdtemp(join(process.cwd(), ".tmp-rss-ai-factory-"));
    temporaryRoots.push(root);
    const store = new DesktopSecretStore({
      secretPath: join(root, "secrets", "secrets.json"),
      platform: "linux",
      randomSuffix: () => "factory-integration",
    });
    await store.set("11111111-1111-4111-8111-111111111111", API_KEY);
    const transport = vi.fn<AiTransport>(() => ({
      status: 200,
      headers: {},
      json: { choices: [{ message: { content: "safe result" } }] },
    }));

    const provider = await createTextGenerationProvider(
      connection(),
      store,
      { transport },
    );
    await expect(provider.generate({
      system: "system",
      user: "user",
      maxOutputTokens: 10,
    })).resolves.toEqual({ text: "safe result" });
    expect(JSON.stringify(provider)).not.toContain(API_KEY);
    expect(JSON.stringify(await store.getStatus(connection().id))).not.toContain(API_KEY);
  });
});
