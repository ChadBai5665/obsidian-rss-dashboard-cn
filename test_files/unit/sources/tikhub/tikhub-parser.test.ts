import { describe, expect, it } from "vitest";
import accountFixture from "../../../fixtures/tikhub/account-posts.json";
import latestFixture from "../../../fixtures/tikhub/search-latest.json";
import topFixture from "../../../fixtures/tikhub/search-top.json";
import { parseTikHubTimeline } from "../../../../src/sources/tikhub/tikhub-parser";

describe("parseTikHubTimeline", () => {
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
    });
  });
});
