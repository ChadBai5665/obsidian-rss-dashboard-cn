import { describe, expect, it } from "vitest";
import {
  createXAccountSourceConfig,
  createXTopicSourceConfig,
  dedupeXAccountSourceConfigs,
  normalizeXAccountSourceConfig,
  normalizeXHandle,
  normalizeXTopicSourceConfig,
  sourceConfigUrl,
} from "../../../src/sources/source-config";

describe("X source configuration", () => {
  it("normalizes a watched account without mutating its input", () => {
    const input = {
      kind: "x-account",
      id: "account-1",
      handle: "  OpenAI  ",
      displayName: "  OpenAI  ",
      includeReplies: true,
      includeReposts: false,
      folder: "  信息收集 / X  ",
      topics: [" AI ", "ai", "研究"],
    };

    const result = normalizeXAccountSourceConfig(input);

    expect(result).toEqual({
      kind: "x-account",
      id: "account-1",
      handle: "openai",
      displayName: "OpenAI",
      includeReplies: true,
      includeReposts: false,
      folder: "信息收集 / X",
      topics: ["AI", "研究"],
    });
    expect(input.handle).toBe("  OpenAI  ");
    expect(input.topics).toEqual([" AI ", "ai", "研究"]);
  });

  it("preserves the verified provider restId needed to distinguish X identity changes", () => {
    const config = createXAccountSourceConfig({
      handle: "OpenAI",
      restId: "44196397",
    });

    expect(config.restId).toBe("44196397");
    expect(normalizeXAccountSourceConfig(config)?.restId).toBe("44196397");
    expect(normalizeXAccountSourceConfig({ ...config, restId: "bad id" }))
      .toBeUndefined();
  });

  it.each([
    "@OpenAI",
    "open ai",
    "openai?tab=posts",
    "openai/path",
    "",
    "\uFF2FpenAI",
    "a".repeat(16),
  ])(
    "rejects an unsafe watched-account handle %j after normalization",
    (handle) => {
      expect(
        normalizeXAccountSourceConfig({
          kind: "x-account",
          id: "account-1",
          handle,
          includeReplies: false,
          includeReposts: false,
          folder: "X",
          topics: [],
        }),
      ).toBeUndefined();
    },
  );

  it("deduplicates watched accounts case-insensitively through its stable URL", () => {
    const first = createXAccountSourceConfig({ handle: "OpenAI" });
    const duplicate = createXAccountSourceConfig({ handle: "openai" });

    expect(sourceConfigUrl(first)).toBe("tikhub://x-account/openai");
    expect(sourceConfigUrl(duplicate)).toBe("tikhub://x-account/openai");
    expect(
      new Set([sourceConfigUrl(first), sourceConfigUrl(duplicate)]).size,
    ).toBe(1);
  });

  it("deduplicates a watched-account list without mutating the supplied configs", () => {
    const first = createXAccountSourceConfig({ handle: "OpenAI" });
    const duplicate = createXAccountSourceConfig({ handle: "openai" });
    const configs = [first, duplicate];

    expect(dedupeXAccountSourceConfigs(configs)).toEqual([first]);
    expect(configs).toEqual([first, duplicate]);
  });

  it("normalizes topic filters, keeps an exact window union, and does not mutate input", () => {
    const input = {
      kind: "x-topic",
      id: "8b337018-2a05-4ce0-84c8-c1f3e580d7bd",
      name: "  AI 应用  ",
      includeKeywords: [" AI ", "ai", "Agent"],
      excludeKeywords: [" 广告 ", "广告"],
      priorityAccounts: [" OpenAI ", "openai", "anthropic"],
      windowDays: 14,
      folder: "  信息收集 / 主题  ",
    };

    const result = normalizeXTopicSourceConfig(input);

    expect(result).toEqual({
      kind: "x-topic",
      id: "8b337018-2a05-4ce0-84c8-c1f3e580d7bd",
      name: "AI 应用",
      includeKeywords: ["AI", "Agent"],
      excludeKeywords: ["广告"],
      priorityAccounts: ["openai", "anthropic"],
      windowDays: 14,
      folder: "信息收集 / 主题",
    });
    expect(input.includeKeywords).toEqual([" AI ", "ai", "Agent"]);
    expect(input.priorityAccounts).toEqual([" OpenAI ", "openai", "anthropic"]);
  });

  it.each([0, 2, 6, 31, "7", undefined])(
    "rejects a topic window outside the exact supported union: %j",
    (windowDays) => {
      expect(
        normalizeXTopicSourceConfig({
          kind: "x-topic",
          id: "topic-1",
          name: "AI",
          includeKeywords: ["AI"],
          excludeKeywords: [],
          priorityAccounts: [],
          windowDays,
          folder: "主题",
        }),
      ).toBeUndefined();
    },
  );

  it("rejects unsafe topic ids and own-property impostors", () => {
    expect(
      normalizeXTopicSourceConfig({
        kind: "x-topic",
        id: "../topic",
        name: "AI",
        includeKeywords: ["AI"],
        excludeKeywords: [],
        priorityAccounts: [],
        windowDays: 7,
        folder: "主题",
      }),
    ).toBeUndefined();

    const inherited = Object.create({
      kind: "x-account",
      id: "account-1",
      handle: "openai",
      includeReplies: false,
      includeReposts: false,
      folder: "X",
      topics: [],
    });
    expect(normalizeXAccountSourceConfig(inherited)).toBeUndefined();
  });

  it("reads optional fields only from own properties and rejects sparse or polluted arrays", () => {
    const input = Object.create({ displayName: "Inherited name" }) as Record<
      string,
      unknown
    >;
    Object.assign(input, {
      kind: "x-account",
      id: "account-1",
      handle: "openai",
      includeReplies: false,
      includeReposts: false,
      folder: "X",
      topics: [],
    });
    expect(normalizeXAccountSourceConfig(input)).not.toHaveProperty(
      "displayName",
    );

    const sparseTopics = new Array<string>(1);
    (Array.prototype as unknown as Record<number, unknown>)[0] = "polluted";
    try {
      expect(
        normalizeXAccountSourceConfig({
          kind: "x-account",
          id: "account-1",
          handle: "openai",
          includeReplies: false,
          includeReposts: false,
          folder: "X",
          topics: sparseTopics,
        }),
      ).toBeUndefined();
    } finally {
      delete (Array.prototype as unknown as Record<number, unknown>)[0];
    }
  });

  it.each(["openai\\path", "openai\u0000", "a".repeat(16)])(
    "rejects an X handle with a path, control character, or oversized value: %j",
    (handle) => {
      expect(normalizeXHandle(handle)).toBeUndefined();
    },
  );

  it("revalidates public configs before producing synthetic URLs", () => {
    expect(
      sourceConfigUrl({
        kind: "x-topic",
        id: "a/b?x",
        name: "AI",
        includeKeywords: [],
        excludeKeywords: [],
        priorityAccounts: [],
        windowDays: 7,
        folder: "X",
      }),
    ).toBeUndefined();
    expect(sourceConfigUrl({ kind: "feed" })).toBeUndefined();
  });

  it("rejects required X fields with the wrong type instead of coercing them", () => {
    const validAccount = {
      kind: "x-account",
      id: "account-1",
      handle: "openai",
      includeReplies: false,
      includeReposts: false,
      folder: "X",
      topics: [],
    };
    expect(
      normalizeXAccountSourceConfig({ ...validAccount, includeReplies: "false" }),
    ).toBeUndefined();
    expect(
      normalizeXAccountSourceConfig({ ...validAccount, folder: 42 }),
    ).toBeUndefined();
    expect(
      normalizeXTopicSourceConfig({
        kind: "x-topic",
        id: "topic-1",
        name: "AI",
        includeKeywords: [],
        excludeKeywords: [],
        priorityAccounts: [],
        windowDays: 7,
        folder: null,
      }),
    ).toBeUndefined();
  });

  it("creates a topic with a stable generated identifier and URL", () => {
    const topic = createXTopicSourceConfig({
      name: "AI 应用",
      includeKeywords: ["AI"],
    });

    expect(topic.id).toMatch(/^[a-z0-9][a-z0-9_-]{0,127}$/i);
    expect(sourceConfigUrl(topic)).toBe(`tikhub://x-topic/${topic.id}`);
  });
});
