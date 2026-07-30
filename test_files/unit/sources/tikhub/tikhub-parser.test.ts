import { describe, expect, it } from "vitest";
import accountFixture from "../../../fixtures/tikhub/synthetic/account-edge-cases.json";
import latestFixture from "../../../fixtures/tikhub/synthetic/search-latest-edge.json";
import topFixture from "../../../fixtures/tikhub/synthetic/search-top-edge.json";
import { parseTikHubTimeline } from "../../../../src/sources/tikhub/tikhub-parser";

describe("parseTikHubTimeline", () => {
  it("extracts the single own bottom cursor from a timeline page", () => {
    expect(parseTikHubTimeline(accountFixture).nextCursor).toBe("fixture-cursor");
  });

  it("rejects hostile and ambiguous bottom cursors without disclosing them", () => {
    const bottom = (value: unknown, entryId = "cursor-bottom-test") => ({
      entryId,
      content: {
        entryType: "TimelineTimelineCursor",
        cursorType: "Bottom",
        value,
      },
    });
    const payload = (entries: unknown[]) => ({
      data: { instructions: [{ entries }] },
    });
    const inheritedValue = Object.create({ value: "private-inherited-cursor" });
    Object.assign(inheritedValue, {
      entryType: "TimelineTimelineCursor",
      cursorType: "Bottom",
    });
    const cases = [
      payload([bottom("private\u0001cursor")]),
      payload([bottom("x".repeat(4_097))]),
      payload([{
        entryId: "cursor-bottom-inherited",
        content: inheritedValue,
      }]),
      payload([bottom("private-repeated-cursor"), bottom("private-repeated-cursor")]),
      payload([bottom("private-first-cursor"), bottom("private-second-cursor")]),
    ];

    for (const hostile of cases) {
      const result = parseTikHubTimeline(hostile);
      expect(result.nextCursor).toBeUndefined();
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(JSON.stringify(result.warnings)).not.toContain("private");
    }
  });

  it("ignores a non-bottom cursor without treating a normal page shape as hostile", () => {
    const result = parseTikHubTimeline({
      data: {
        instructions: [{
          entries: [{
            entryId: "cursor-top-test",
            content: {
              entryType: "TimelineTimelineCursor",
              cursorType: "Top",
              value: "private-top-cursor",
            },
          }],
        }],
      },
    });

    expect(result).toEqual({ posts: [], warnings: [], candidateCount: 0 });
  });

  it("maps an original post, URL entities, article links, and metrics", () => {
    const result = parseTikHubTimeline(accountFixture);
    const post = result.posts.find(({ id }) => id === "100");

    expect(post).toEqual({
      id: "100",
      authorHandle: "fixture_account",
      authorName: "Fixture Account",
      text: "Original fixture post https://t.co/article",
      createdAt: "2024-01-01T00:00:00.000Z",
      url: "https://x.com/fixture_account/status/100",
      conversationId: "100",
      externalUrls: ["https://example.com/fixture-article"],
      metrics: { replies: 2, reposts: 3, likes: 5, quotes: 1, views: 21 },
    });
  });

  it("identifies replies, reposts, quotes, and thread continuations", () => {
    const posts = parseTikHubTimeline(accountFixture).posts;

    expect(posts.find(({ id }) => id === "101")).toMatchObject({
      conversationId: "100",
      inReplyToId: "100",
    });
    expect(posts.find(({ id }) => id === "102")).toMatchObject({
      repostOfId: "90",
    });
    expect(posts.find(({ id }) => id === "103")).toMatchObject({
      quoteOfId: "91",
    });
    expect(posts.find(({ id }) => id === "104")).toMatchObject({
      conversationId: "100",
      inReplyToId: "101",
    });
  });

  it("parses module and alternate tweet-result nesting without inventing metrics", () => {
    const latest = parseTikHubTimeline(latestFixture);
    const top = parseTikHubTimeline(topFixture);

    expect(latest.posts).toEqual([
      expect.objectContaining({
        id: "200",
        authorHandle: "fixture_ai",
        metrics: {},
      }),
    ]);
    expect(top.posts).toEqual([
      expect.objectContaining({
        id: "300",
        text: "Top fixture long-form text",
        externalUrls: ["https://example.org/fixture-report"],
        metrics: { replies: 0, reposts: 1, likes: 8, quotes: 2, views: 34 },
      }),
    ]);
  });

  it("ignores cursors and skips unavailable, malformed, and unknown entries with safe warnings", () => {
    const account = parseTikHubTimeline(accountFixture);
    const top = parseTikHubTimeline(topFixture);

    expect(account.posts).toHaveLength(5);
    expect(account.warnings).toEqual([
      "Skipped an unavailable X post.",
      "Skipped an unknown X timeline entry.",
    ]);
    expect(top.warnings).toEqual(["Skipped a malformed X post."]);
    expect(JSON.stringify([...account.warnings, ...top.warnings])).not.toContain(
      "Fixture unavailable",
    );
  });

  it("emits provider-neutral copies without mutating raw fixtures", () => {
    const before = JSON.stringify(accountFixture);
    const result = parseTikHubTimeline(accountFixture);

    expect(JSON.stringify(accountFixture)).toBe(before);
    expect(JSON.stringify(result.posts)).not.toMatch(
      /tweet_results|request_id|cache_url|legacy/,
    );
    expect(result.posts[0]).not.toBe(result.posts[1]);
  });

  it("rejects a non-decimal post ID instead of interpolating it into a URL", () => {
    const payload = {
      data: {
        instructions: [
          {
            entries: [
              {
                entryId: "tweet-hostile-id",
                content: {
                  itemContent: {
                    tweet_results: {
                      result: {
                        __typename: "Tweet",
                        rest_id: "../hostile?value=1",
                        core: {
                          user_results: {
                            result: {
                              legacy: { screen_name: "fixture_ai" },
                            },
                          },
                        },
                        legacy: { full_text: "Hostile ID fixture" },
                      },
                    },
                  },
                },
              },
            ],
          },
        ],
      },
    };

    expect(parseTikHubTimeline(payload)).toEqual({
      posts: [],
      warnings: ["Skipped a malformed X post."],
      candidateCount: 1,
    });
  });

  it("preserves multiline post text while rejecting other control characters", () => {
    const payload = {
      data: {
        instructions: [
          {
            entries: [
              {
                entryId: "tweet-multiline",
                content: {
                  itemContent: {
                    tweet_results: {
                      result: {
                        rest_id: "400",
                        core: {
                          user_results: {
                            result: { legacy: { screen_name: "fixture_ai" } },
                          },
                        },
                        legacy: {
                          full_text: "Line one\nLine two\tvalue\r\nEnd",
                        },
                      },
                    },
                  },
                },
              },
              {
                entryId: "tweet-disallowed-control",
                content: {
                  itemContent: {
                    tweet_results: {
                      result: {
                        rest_id: "401",
                        core: {
                          user_results: {
                            result: { legacy: { screen_name: "fixture_ai" } },
                          },
                        },
                        legacy: { full_text: "Unsafe\u0001text" },
                      },
                    },
                  },
                },
              },
            ],
          },
        ],
      },
    };

    expect(parseTikHubTimeline(payload)).toEqual({
      posts: [
        expect.objectContaining({
          id: "400",
          text: "Line one\nLine two\tvalue\r\nEnd",
        }),
      ],
      warnings: ["Skipped a malformed X post."],
      candidateCount: 2,
    });
  });

  it("does not scan millions of holes in an oversized sparse entry array", () => {
    const target: unknown[] = [];
    target.length = 5_000_000;
    let descriptorReads = 0;
    const entries = new Proxy(target, {
      getOwnPropertyDescriptor(array, property) {
        if (typeof property === "string" && /^\d+$/.test(property)) {
          descriptorReads += 1;
          if (descriptorReads > 20) throw new Error("scanned sparse holes");
        }
        return Reflect.getOwnPropertyDescriptor(array, property);
      },
    });
    const payload = { data: { instructions: [{ entries }] } };

    expect(() => parseTikHubTimeline(payload)).not.toThrow();
    expect(descriptorReads).toBeLessThanOrEqual(20);
  });

  it("preserves duplicate IDs so account semantics can filter before merging", () => {
    const tweet = (screenName: string, text: string) => ({
      content: {
        itemContent: {
          tweet_results: {
            result: {
              rest_id: "999",
              core: {
                user_results: {
                  result: { legacy: { screen_name: screenName } },
                },
              },
              legacy: { full_text: text },
            },
          },
        },
      },
    });
    const payload = {
      data: {
        instructions: [{
          entries: [
            tweet("other_account", "Other account duplicate"),
            tweet("fixture_ai", "Target account duplicate"),
          ],
        }],
      },
    };

    expect(parseTikHubTimeline(payload).posts).toMatchObject([
      { id: "999", authorHandle: "other_account" },
      { id: "999", authorHandle: "fixture_ai" },
    ]);
  });
});
