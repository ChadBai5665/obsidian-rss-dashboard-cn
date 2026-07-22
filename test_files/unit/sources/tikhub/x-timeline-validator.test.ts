import { describe, expect, it } from "vitest";
import type { XPost } from "../../../../src/sources/tikhub/x-post";
import {
  InvalidXTimelineError,
  validateParsedXTimeline,
} from "../../../../src/sources/tikhub/x-timeline-validator";

function post(overrides: Partial<XPost> = {}): XPost {
  const value: XPost = {
    id: "100",
    authorHandle: "openai",
    text: "Safe text",
    createdAt: "2026-07-22T07:00:00.000Z",
    url: "https://x.com/openai/status/100",
    externalUrls: [],
    metrics: { likes: 1 },
    ...overrides,
  };
  if (!Object.prototype.hasOwnProperty.call(overrides, "url")) {
    value.url = `https://x.com/${value.authorHandle}/status/${value.id}`;
  }
  return value;
}

function parsed(posts: unknown[], warnings: unknown[] = []) {
  return { posts, warnings, candidateCount: posts.length };
}

describe("validateParsedXTimeline", () => {
  it("rejects extra array properties and non-enumerable metric accessors", () => {
    const externalUrls: string[] = [];
    Object.defineProperty(externalUrls, "hidden", {
      value: "not array data",
      enumerable: false,
    });
    let metricGetterReads = 0;
    const metrics = {};
    Object.defineProperty(metrics, "likes", {
      enumerable: false,
      get() {
        metricGetterReads += 1;
        return 4;
      },
    });

    const result = validateParsedXTimeline(parsed([
      post({ id: "101", externalUrls }),
      post({ id: "102", metrics }),
    ]));

    expect(metricGetterReads).toBe(0);
    expect(result.posts).toEqual([]);
    expect(result.warnings).toEqual([
      "Skipped an invalid parsed X post.",
      "Skipped an invalid parsed X post.",
    ]);
  });

  it("rejects relation traversal and clones every accepted nested value", () => {
    const externalUrls = ["https://example.com/report"];
    const metrics = { likes: 3 };
    const source = post({ externalUrls, metrics });
    const posts = [source];
    const warnings = ["safe warning"];
    const result = validateParsedXTimeline(parsed(posts, warnings));

    source.text = "mutated";
    externalUrls.push("https://example.com/later");
    metrics.likes = 99;
    posts.length = 0;
    warnings.push("late warning");

    expect(result).toEqual({
      posts: [post({
        externalUrls: ["https://example.com/report"],
        metrics: { likes: 3 },
      })],
      warnings: ["safe warning"],
      candidateCount: 1,
    });
    expect(validateParsedXTimeline(parsed([
      post({ id: "103", inReplyToId: "../../escape" }),
    ])).posts).toEqual([]);
  });

  it("does not execute parser-container getters", () => {
    let getterReads = 0;
    const hostile = { warnings: [], candidateCount: 1 } as Record<string, unknown>;
    Object.defineProperty(hostile, "posts", {
      enumerable: true,
      get() {
        getterReads += 1;
        return [post()];
      },
    });

    expect(() => validateParsedXTimeline(hostile)).toThrow(
      InvalidXTimelineError,
    );
    expect(getterReads).toBe(0);
  });

  it("validates array length through own data without invoking proxy getters", () => {
    let lengthGetterReads = 0;
    const posts = new Proxy([post()], {
      get(target, key, receiver) {
        if (key === "length") {
          lengthGetterReads += 1;
          throw new Error("length getter executed");
        }
        return Reflect.get(target, key, receiver);
      },
    });

    expect(validateParsedXTimeline({
      posts,
      warnings: [],
      candidateCount: 1,
    }).posts).toHaveLength(1);
    expect(lengthGetterReads).toBe(0);
  });

  it.each([
    ["post ID", { id: "../../escape" }],
    ["oversized post ID", { id: "1".repeat(31) }],
    ["handle", { authorHandle: "@openai" }],
    ["text", { text: "   " }],
    ["date", { createdAt: "not-a-date" }],
    ["canonical URL", { url: "https://evil.invalid/openai/status/100" }],
    ["relation ID", { quoteOfId: "../1" }],
    ["external URL", { externalUrls: ["javascript:alert(1)"] }],
    ["negative metric", { metrics: { likes: -1 } }],
    ["unknown metric", { metrics: { score: 1 } }],
  ])("skips an XPost with an invalid %s", (_label, overrides) => {
    const result = validateParsedXTimeline(parsed([
      post(overrides as Partial<XPost>),
    ]));

    expect(result.posts).toEqual([]);
    expect(result.warnings).toEqual(["Skipped an invalid parsed X post."]);
  });
});
