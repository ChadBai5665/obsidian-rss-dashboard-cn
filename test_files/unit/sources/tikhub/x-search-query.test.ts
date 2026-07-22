import { describe, expect, it } from "vitest";
import type { XTopicSourceConfig } from "../../../../src/sources/source-config";
import {
  buildXTopicSearchPlan,
  XSearchQueryError,
} from "../../../../src/sources/tikhub/x-search-query";

const NOW = new Date("2026-07-22T08:00:00.000Z");

function topic(
  overrides: Partial<XTopicSourceConfig> = {},
): XTopicSourceConfig {
  return {
    kind: "x-topic",
    id: "topic-ai",
    name: "AI 应用",
    includeKeywords: ["AI", "agent   ops", "人工智能"],
    excludeKeywords: ["giveaway"],
    priorityAccounts: [],
    windowDays: 7,
    folder: "X/主题",
    ...overrides,
  };
}

describe("buildXTopicSearchPlan", () => {
  it("builds one neutral Latest and one platform Top request from normalized literals", () => {
    expect(buildXTopicSearchPlan(topic(), NOW)).toEqual({
      requestCount: 2,
      requests: [
        {
          query:
            '(AI OR "agent ops" OR 人工智能) -"giveaway" since:2026-07-15',
          searchType: "Latest",
          observationTag: "latest",
        },
        {
          query:
            '(AI OR "agent ops" OR 人工智能) -"giveaway" since:2026-07-15',
          searchType: "Top",
          observationTag: "platform-top",
        },
      ],
    });
  });

  it("treats user-supplied X operators as quoted literals and only emits builder operators", () => {
    const plan = buildXTopicSearchPlan(
      topic({
        includeKeywords: ["from:openai", "since:1999-01-01", "AI"],
        excludeKeywords: ["filter:links"],
        priorityAccounts: ["openai", "anthropic"],
      }),
      NOW,
    );

    expect(plan.requests).toEqual([
      {
        query:
          '("from:openai" OR "since:1999-01-01" OR AI) -"filter:links" since:2026-07-15',
        searchType: "Latest",
        observationTag: "latest",
      },
      {
        query:
          '("from:openai" OR "since:1999-01-01" OR AI) -"filter:links" since:2026-07-15',
        searchType: "Top",
        observationTag: "platform-top",
      },
      {
        query:
          '("from:openai" OR "since:1999-01-01" OR AI) -"filter:links" since:2026-07-15 (from:openai OR from:anthropic)',
        searchType: "Latest",
        observationTag: "priority-account",
      },
    ]);
    expect(plan.requestCount).toBe(3);
  });

  it("rejects empty, control-bearing, overlong, sparse, inherited, and oversized input", () => {
    expect(() =>
      buildXTopicSearchPlan(topic({ includeKeywords: ["  "] }), NOW),
    ).toThrow(XSearchQueryError);
    expect(() =>
      buildXTopicSearchPlan(topic({ includeKeywords: ["AI\u0000operator"] }), NOW),
    ).toThrow(XSearchQueryError);
    expect(() =>
      buildXTopicSearchPlan(topic({ includeKeywords: ["界".repeat(101)] }), NOW),
    ).toThrow(XSearchQueryError);

    const sparse = ["AI", "agents"];
    Reflect.deleteProperty(sparse, "0");
    expect(() =>
      buildXTopicSearchPlan(topic({ includeKeywords: sparse }), NOW),
    ).toThrow(XSearchQueryError);

    const inherited = Object.create(["AI"]) as string[];
    Object.defineProperty(inherited, "length", { value: 1 });
    expect(() =>
      buildXTopicSearchPlan(topic({ includeKeywords: inherited }), NOW),
    ).toThrow(XSearchQueryError);

    expect(() =>
      buildXTopicSearchPlan(
        topic({
          includeKeywords: Array.from(
            { length: 6 },
            (_, index) => `${index}${"a".repeat(89)}`,
          ),
        }),
        NOW,
      ),
    ).toThrow(/500/);
  });
});
