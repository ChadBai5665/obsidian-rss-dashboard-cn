import { describe, expect, it } from "vitest";
import {
  createXAccountSourceConfig,
  createXTopicSourceConfig,
  dedupeXAccountSourceConfigs,
  normalizeXAccountSourceConfig,
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

  it("creates a topic with a stable generated identifier and URL", () => {
    const topic = createXTopicSourceConfig({
      name: "AI 应用",
      includeKeywords: ["AI"],
    });

    expect(topic.id).toMatch(/^[a-z0-9][a-z0-9_-]{0,127}$/i);
    expect(sourceConfigUrl(topic)).toBe(`tikhub://x-topic/${topic.id}`);
  });
});
