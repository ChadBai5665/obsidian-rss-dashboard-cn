import { describe, expect, it } from "vitest";
import {
  groupLinkedPages,
  type LinkedPageGroup,
} from "../../../../src/sources/tikhub/linked-page-grouper";
import type { XPost } from "../../../../src/sources/tikhub/x-post";

function post(overrides: Partial<XPost> = {}): XPost {
  const id = overrides.id ?? "100";
  const authorHandle = overrides.authorHandle ?? "alice";
  return {
    id,
    authorHandle,
    text: "A post",
    url: `https://x.com/${authorHandle}/status/${id}`,
    externalUrls: [],
    metrics: {},
    ...overrides,
  };
}

describe("groupLinkedPages", () => {
  it("groups shared non-X pages by a tracking-free canonical URL", () => {
    const groups = groupLinkedPages([
      post({
        id: "101",
        authorHandle: "alice",
        externalUrls: [
          "https://Example.com/report?utm_source=x&edition=full#section",
        ],
      }),
      post({
        id: "102",
        authorHandle: "bob",
        externalUrls: [
          "https://example.com/report?edition=full&fbclid=tracking",
        ],
      }),
    ]);

    expect(groups).toEqual([
      {
        url: "https://example.com/report?edition=full",
        postCount: 2,
        authors: ["alice", "bob"],
        postIds: ["101", "102"],
      },
    ] satisfies LinkedPageGroup[]);
    expect(groups[0]).not.toHaveProperty("score");
    expect(groups[0]).not.toHaveProperty("recommendation");
  });

  it("keeps each post objective and ignores X, Twitter, t.co, credentials, and singletons", () => {
    const groups = groupLinkedPages([
      post({
        id: "101",
        externalUrls: [
          "https://x.com/someone/status/999",
          "https://twitter.com/someone/status/999",
          "https://t.co/short",
          "https://user:pass@example.com/private",
          "https://example.com/only-once",
          "https://example.com/shared?gclid=a",
          "https://example.com/shared?gclid=b",
        ],
      }),
      post({
        id: "102",
        authorHandle: "bob",
        externalUrls: ["https://example.com/shared"],
      }),
    ]);

    expect(groups).toEqual([
      {
        url: "https://example.com/shared",
        postCount: 2,
        authors: ["alice", "bob"],
        postIds: ["101", "102"],
      },
    ]);
  });

  it("removes common click and campaign identifiers before grouping", () => {
    expect(
      groupLinkedPages([
        post({
          id: "201",
          externalUrls: [
            "https://example.com/research?edition=1&msclkid=secret&mc_cid=mail",
          ],
        }),
        post({
          id: "202",
          authorHandle: "bob",
          externalUrls: [
            "https://example.com/research?dclid=secret&edition=1&igshid=secret",
          ],
        }),
      ]),
    ).toEqual([
      {
        url: "https://example.com/research?edition=1",
        postCount: 2,
        authors: ["alice", "bob"],
        postIds: ["201", "202"],
      },
    ]);
  });

  it.each([
    "https://x.com./outside",
    "https://x.com../outside",
    "https://sub.twitter.com./outside",
    "https://t.co../outside",
    "https://sub.t.co./outside",
  ])("does not group an X-family FQDN with trailing dots: %s", (url) => {
    expect(
      groupLinkedPages([
        post({ id: "301", externalUrls: [url] }),
        post({ id: "302", authorHandle: "bob", externalUrls: [url] }),
      ]),
    ).toEqual([]);
  });
});
