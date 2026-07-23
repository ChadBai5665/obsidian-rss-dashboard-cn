import { describe, expect, it, vi } from "vitest";
import {
  buildSafeDiagnostics,
  SafeDiagnosticsError,
} from "../../../src/security/safe-diagnostics";

describe("buildSafeDiagnostics", () => {
  it("contains only coarse versions, OS, aggregate source kinds, codes, counts, and ISO timestamps", () => {
    const input = {
      pluginVersion: "0.1.0",
      obsidianVersion: "1.8.7",
      osName: "darwin",
      generatedAt: "2026-07-22T10:00:00.000Z",
      lastRefreshAt: "2026-07-22T09:00:00.000Z",
      sourceKinds: ["feed", "feed", "x-account", "x-topic", "future-private-kind"],
      statusCodes: ["ok", "missing-key", "timeout", "raw-private-error-code"],
      aggregateCounts: {
        enabledAiConnections: 2,
        failedSources: 1,
      },
      handle: "@PRIVATE_HANDLE_CANARY",
      feedUrl: "https://user:PRIVATE_URL_PASSWORD_CANARY@example.com/feed",
      title: "PRIVATE_TITLE_CANARY",
      keywords: ["PRIVATE_KEYWORD_CANARY"],
      folder: "/Users/private/PRIVATE_FOLDER_CANARY",
      prompt: "PRIVATE_PROMPT_CANARY",
      response: "PRIVATE_RESPONSE_CANARY",
      connectionName: "PRIVATE_CONNECTION_NAME_CANARY",
      baseUrl: "https://PRIVATE_BASE_URL_CANARY.example",
      secretPath: "C:\\Users\\private\\PRIVATE_SECRET_PATH_CANARY.json",
      error: new Error("PRIVATE_RAW_ERROR_CANARY"),
    };

    const diagnostics = buildSafeDiagnostics(input);
    const text = JSON.stringify(diagnostics);

    expect(diagnostics).toEqual({
      pluginVersion: "0.1.0",
      obsidianVersion: "1.8.7",
      os: "macOS",
      generatedAt: "2026-07-22T10:00:00.000Z",
      lastRefreshAt: "2026-07-22T09:00:00.000Z",
      sourceCounts: { feed: 2, "x-account": 1, "x-topic": 1, unknown: 1 },
      statusCounts: { ok: 1, "missing-key": 1, timeout: 1, unknown: 1 },
      aggregateCounts: { enabledAiConnections: 2, failedSources: 1 },
    });
    expect(Object.isFrozen(diagnostics)).toBe(true);
    expect(Object.isFrozen(diagnostics.sourceCounts)).toBe(true);
    expect(text).not.toContain("PRIVATE_");
  });

  it("does not invoke getters or malicious toJSON on ignored fields", () => {
    const getter = vi.fn(() => "PRIVATE_GETTER_CANARY");
    const toJSON = vi.fn(() => ({ token: "PRIVATE_TOJSON_CANARY" }));
    const input: Record<string, unknown> = {
      pluginVersion: "0.1.0",
      obsidianVersion: "1.8.7",
      osName: "linux",
      generatedAt: "2026-07-22T10:00:00.000Z",
      sourceKinds: [],
      statusCodes: [],
      aggregateCounts: {},
      toJSON,
    };
    Object.defineProperty(input, "stack", { enumerable: true, get: getter });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    input.futureCycle = cycle;

    const text = JSON.stringify(buildSafeDiagnostics(input));
    expect(getter).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
    expect(text).not.toContain("PRIVATE_");
  });

  it("fails closed for accessor-backed, sparse, cyclic, or oversized allowlisted input", () => {
    const base = {
      pluginVersion: "0.1.0",
      obsidianVersion: "1.8.7",
      osName: "windows",
      generatedAt: "2026-07-22T10:00:00.000Z",
      sourceKinds: [] as unknown[],
      statusCodes: [] as unknown[],
      aggregateCounts: {},
    };
    const accessor = { ...base } as Record<string, unknown>;
    const getter = vi.fn(() => []);
    Object.defineProperty(accessor, "sourceKinds", { enumerable: true, get: getter });
    expect(() => buildSafeDiagnostics(accessor)).toThrow(SafeDiagnosticsError);
    expect(getter).not.toHaveBeenCalled();

    const sparse = { ...base, sourceKinds: new Array(2) };
    expect(() => buildSafeDiagnostics(sparse)).toThrow(SafeDiagnosticsError);

    const cyclicCounts: Record<string, unknown> = {};
    cyclicCounts.self = cyclicCounts;
    expect(() =>
      buildSafeDiagnostics({ ...base, aggregateCounts: cyclicCounts }),
    ).toThrow(SafeDiagnosticsError);

    expect(() =>
      buildSafeDiagnostics({
        ...base,
        statusCodes: Array.from({ length: 10_001 }, () => "ok"),
      }),
    ).toThrow(SafeDiagnosticsError);
  });

  it("rejects invalid timestamps and version strings rather than echoing them", () => {
    const base = {
      pluginVersion: "0.1.0",
      obsidianVersion: "1.8.7",
      osName: "linux",
      generatedAt: "2026-07-22T10:00:00.000Z",
      sourceKinds: [],
      statusCodes: [],
      aggregateCounts: {},
    };
    expect(() =>
      buildSafeDiagnostics({ ...base, generatedAt: "/Users/private/canary" }),
    ).toThrow(SafeDiagnosticsError);
    expect(() =>
      buildSafeDiagnostics({ ...base, pluginVersion: "Bearer private-canary" }),
    ).toThrow(SafeDiagnosticsError);
  });
});
