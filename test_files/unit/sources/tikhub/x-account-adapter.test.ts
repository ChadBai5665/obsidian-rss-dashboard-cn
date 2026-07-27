import { describe, expect, it, vi } from "vitest";
import { mergeCollectedItems } from "../../../../src/collection/collection-merge";
import { normalizeFeedItem } from "../../../../src/collection/feed-normalizer";
import type { XAccountSourceConfig } from "../../../../src/sources/source-config";
import { SourceRegistry } from "../../../../src/sources/source-registry";
import type { InitialImportProgress } from "../../../../src/sources/initial-import-policy";
import {
  TikHubClient,
  TikHubClientError,
} from "../../../../src/sources/tikhub/tikhub-client";
import type { TikHubTimelineParseResult } from "../../../../src/sources/tikhub/tikhub-parser";
import type {
  TikHubBudgetReservation,
  TikHubRequestBudgetLike,
} from "../../../../src/sources/tikhub/request-budget";
import { TikHubRequestBudgetError } from "../../../../src/sources/tikhub/request-budget";
import { TikHubRequestLedgerError } from "../../../../src/sources/tikhub/request-ledger";
import {
  XAccountAdapter,
  XAccountRefreshError,
  type XAccountTikHubClient,
} from "../../../../src/sources/tikhub/x-account-adapter";
import {
  mapXAccountPostsToFeed,
  type XAccountFeedItem,
} from "../../../../src/sources/tikhub/x-feed-mapper";
import type { XPost } from "../../../../src/sources/tikhub/x-post";
import type { Feed } from "../../../../src/types/types";
import accountFixture from "../../../fixtures/tikhub/synthetic/account-edge-cases.json";

const CONNECTION_ID = "d4eb3f58-b672-4f73-b9f3-9cd2f0e57a8d";
const API_KEY = "method-scoped-key";
const NOW = new Date("2026-07-22T08:00:00.000Z");

const account = (overrides: Partial<XAccountSourceConfig> = {}): XAccountSourceConfig => ({
  kind: "x-account",
  id: "account-openai",
  handle: "openai",
  displayName: "OpenAI",
  includeReplies: false,
  includeReposts: false,
  folder: "X/关注账号",
  topics: ["AI"],
  ...overrides,
});

const post = (overrides: Partial<XPost> = {}): XPost => {
  const value = {
    id: "100",
    authorHandle: "openai",
    authorName: "OpenAI",
    text: "Original post",
    createdAt: "2026-07-22T07:00:00.000Z",
    url: "https://x.com/openai/status/100",
    externalUrls: [],
    metrics: { likes: 1 },
    ...overrides,
  } as XPost;
  if (!Object.prototype.hasOwnProperty.call(overrides, "url")) {
    value.url = `https://x.com/${value.authorHandle}/status/${value.id}`;
  }
  for (const key of Object.keys(value) as Array<keyof XPost>) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
};

function payload(posts: XPost[]) {
  return { posts };
}

function harness(options: {
  apiKey?: string;
  connectionId?: string;
  accountPosts?: XPost[];
  replyPosts?: XPost[];
  userPostsError?: Error;
  postPages?: Array<TikHubTimelineParseResult | Error>;
  replyPages?: Array<TikHubTimelineParseResult | Error>;
} = {}) {
  const get = vi.fn(async () => options.apiKey ?? API_KEY);
  let postPageIndex = 0;
  let replyPageIndex = 0;
  const fetchUserPosts = vi.fn(async () => {
    if (options.userPostsError) throw options.userPostsError;
    const page = options.postPages?.[postPageIndex++];
    if (page instanceof Error) throw page;
    if (page) return { data: page };
    return { data: payload(options.accountPosts ?? [post()]) };
  });
  const fetchUserReplies = vi.fn(async () => {
    const page = options.replyPages?.[replyPageIndex++];
    if (page instanceof Error) throw page;
    if (page) return { data: page };
    return { data: payload(options.replyPosts ?? []) };
  });
  const client: XAccountTikHubClient = { fetchUserPosts, fetchUserReplies };
  const adapter = new XAccountAdapter({
    client,
    secretStore: { get },
    connectionId:
      options.connectionId === undefined ? CONNECTION_ID : options.connectionId,
    parseTimeline: (value) => {
      const page = value as Partial<TikHubTimelineParseResult>;
      const valuePosts = page.posts ?? [];
      return {
        posts: valuePosts,
        warnings: page.warnings ?? [],
        candidateCount: page.candidateCount ?? valuePosts.length,
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      };
    },
  });
  return { adapter, client, fetchUserPosts, fetchUserReplies, get };
}

function page(
  posts: XPost[],
  nextCursor?: string,
): TikHubTimelineParseResult {
  return {
    posts,
    warnings: [],
    candidateCount: posts.length,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

function importFeed(options: {
  config?: XAccountSourceConfig;
  progress?: InitialImportProgress;
  posts?: XPost[];
  policy?: Feed["initialImportPolicy"];
} = {}): Feed {
  const config = options.config ?? account();
  const mapped = mapXAccountPostsToFeed(config, options.posts ?? [], NOW);
  return {
    ...mapped.feed,
    items: mapped.items,
    initialImportPolicy: options.policy ?? { mode: "all-available" },
    initialImportProgress: options.progress ?? {
      status: "pending",
      pagesFetched: 0,
      itemsImported: 0,
    },
  };
}

describe("XAccountAdapter requests and filtering", () => {
  it("makes exactly one account-post request and defaults to original posts plus quotes", async () => {
    const reply = post({ id: "101", text: "Reply", inReplyToId: "90" });
    const repost = post({ id: "102", text: "Repost", repostOfId: "80" });
    const quote = post({ id: "103", text: "Quote", quoteOfId: "70" });
    const test = harness({ accountPosts: [reply, repost, quote, post()] });

    const result = await test.adapter.refresh(account(), { now: NOW });

    expect(test.get).toHaveBeenCalledOnce();
    expect(test.fetchUserPosts).toHaveBeenCalledOnce();
    expect(test.fetchUserPosts).toHaveBeenCalledWith({
      apiKey: API_KEY,
      handle: "openai",
      signal: undefined,
    });
    expect(test.fetchUserReplies).not.toHaveBeenCalled();
    expect(result.providerRequestCount).toBe(1);
    expect(result.items.map((item) => item.guid)).toEqual(["103", "100"]);
  });

  it("includes reposts without another request", async () => {
    const repost = post({ id: "102", text: "Repost", repostOfId: "80" });
    const test = harness({ accountPosts: [post(), repost] });

    const result = await test.adapter.refresh(
      account({ includeReposts: true }),
      { now: NOW },
    );

    expect(result.items.map((item) => item.guid)).toEqual(["102", "100"]);
    expect(test.fetchUserPosts).toHaveBeenCalledOnce();
    expect(test.fetchUserReplies).not.toHaveBeenCalled();
    expect(result.providerRequestCount).toBe(1);
  });

  it("makes exactly one reply request and merges duplicate IDs", async () => {
    const accountReply = post({
      id: "101",
      text: "Reply old metrics",
      inReplyToId: "90",
      metrics: { likes: 1 },
    });
    const refreshedReply = post({
      id: "101",
      text: "Reply updated metrics",
      inReplyToId: "90",
      metrics: { likes: 9, replies: 2 },
    });
    const secondReply = post({
      id: "104",
      text: "Second reply",
      createdAt: "2026-07-22T07:30:00.000Z",
      inReplyToId: "91",
    });
    const test = harness({
      accountPosts: [post(), accountReply],
      replyPosts: [refreshedReply, secondReply],
    });

    const result = await test.adapter.refresh(
      account({ includeReplies: true }),
      { now: NOW },
    );

    expect(test.fetchUserPosts).toHaveBeenCalledOnce();
    expect(test.fetchUserReplies).toHaveBeenCalledOnce();
    expect(test.fetchUserReplies).toHaveBeenCalledWith({
      apiKey: API_KEY,
      handle: "openai",
      signal: undefined,
    });
    expect(result.providerRequestCount).toBe(2);
    expect(result.items.map((item) => item.guid)).toEqual(["104", "101", "100"]);
    expect((result.items[1] as XAccountFeedItem).metrics).toEqual({
      likes: 9,
      replies: 2,
    });
  });

  it.each([
    ["missing", undefined, "missing-key", "尚未配置有效的 API 密钥。请在 TikHub 设置中配置后重试。"],
    ["blank", "   ", "missing-key", "尚未配置有效的 API 密钥。请在 TikHub 设置中配置后重试。"],
    ["contains a control character", "bad\nkey", "invalid-key", "TikHub API 密钥无效。请在 TikHub 设置中重新配置后重试。"],
  ])("rejects a %s external key before any paid request", async (_label, apiKey, code, message) => {
    const test = harness({ apiKey: apiKey as string });
    if (apiKey === undefined) test.get.mockResolvedValueOnce(undefined);

    await expect(test.adapter.refresh(account(), { now: NOW })).rejects.toMatchObject({
      code,
      message,
    } satisfies Partial<XAccountRefreshError>);
    expect(test.fetchUserPosts).not.toHaveBeenCalled();
    expect(test.fetchUserReplies).not.toHaveBeenCalled();
  });

  it("does not retain the method-scoped key after refresh", async () => {
    const test = harness();
    await test.adapter.refresh(account(), { now: NOW });

    expect(JSON.stringify(test.adapter)).not.toContain(API_KEY);
    expect(Object.values(test.adapter as unknown as Record<string, unknown>)).not.toContain(
      API_KEY,
    );
  });

  it("rejects invalid connection metadata before reading a key or requesting TikHub", async () => {
    const test = harness({ connectionId: "" });

    await expect(test.adapter.refresh(account(), { now: NOW })).rejects.toMatchObject({
      code: "missing-key",
      translationKey: "source.tikhubKeyMissing",
    });
    expect(test.get).not.toHaveBeenCalled();
    expect(test.fetchUserPosts).not.toHaveBeenCalled();
  });

  it("localizes a provider-rejected key without exposing the provider message", async () => {
    const test = harness({
      userPostsError: new TikHubClientError(
        "invalid-key",
        "TikHub authentication failed.",
        401,
      ),
    });

    await expect(test.adapter.refresh(account(), { now: NOW })).rejects.toMatchObject({
      code: "invalid-key",
      message: "TikHub API 密钥无效。请在 TikHub 设置中重新配置后重试。",
    });
    expect(test.fetchUserPosts).toHaveBeenCalledOnce();
  });

  it("uses the real client budget once per endpoint and never performs hidden requests", async () => {
    const marks: Array<ReturnType<typeof vi.fn>> = [];
    const releases: Array<ReturnType<typeof vi.fn>> = [];
    const reserve = vi.fn(async (): Promise<TikHubBudgetReservation> => {
      const markAttempted = vi.fn();
      const releaseUnused = vi.fn(async () => 0);
      marks.push(markAttempted);
      releases.push(releaseUnused);
      return { total: 1, remaining: 1, markAttempted, releaseUnused };
    });
    const budget: TikHubRequestBudgetLike = { reserve };
    const transport = vi.fn(async () => ({
      status: 200,
      text: JSON.stringify({ code: 200, data: payload([post()]) }),
      headers: {},
    }));
    const client = new TikHubClient({
      baseUrl: "https://api.tikhub.dev",
      timeoutMs: 20_000,
      budget,
      transport,
    });
    const adapter = new XAccountAdapter({
      client,
      secretStore: { get: vi.fn(async () => API_KEY) },
      connectionId: CONNECTION_ID,
      parseTimeline: (value) => {
        const valuePosts = (value as { posts: XPost[] }).posts;
        return { posts: valuePosts, warnings: [], candidateCount: valuePosts.length };
      },
    });

    const output = await adapter.refresh(account({ includeReplies: true }), {
      now: NOW,
    });

    expect(output.providerRequestCount).toBe(2);
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(marks).toHaveLength(2);
    expect(marks.every((mark) => mark.mock.calls.length === 1)).toBe(true);
    expect(releases).toHaveLength(2);
    expect(releases.every((release) => release.mock.calls.length === 1)).toBe(true);
  });

  it("filters the sanitized account fixture through the production parser", async () => {
    const fetchUserPosts = vi.fn(async () => ({ data: accountFixture }));
    const adapter = new XAccountAdapter({
      client: {
        fetchUserPosts,
        fetchUserReplies: vi.fn(async () => ({ data: {} })),
      },
      secretStore: { get: vi.fn(async () => API_KEY) },
      connectionId: CONNECTION_ID,
    });

    const output = await adapter.refresh(
      account({
        id: "account-fixture",
        handle: "fixture_account",
        displayName: "Fixture Account",
      }),
      { now: NOW },
    );

    expect(fetchUserPosts).toHaveBeenCalledOnce();
    expect(output.items.map((item) => item.guid)).toEqual(["100", "103"]);
    expect(output.items.find((item) => item.guid === "103")).toMatchObject({
      sourceMetadata: { quoteOfId: "91" },
    });
  });

  it("filters by the watched account before merging duplicate post IDs", async () => {
    const test = harness({
      accountPosts: [
        post({ id: "999", authorHandle: "other", text: "Other account" }),
        post({ id: "999", text: "Target account" }),
      ],
    });

    const output = await test.adapter.refresh(account(), { now: NOW });

    expect(output.items).toHaveLength(1);
    expect(output.items[0]).toMatchObject({
      guid: "999",
      plainText: "Target account",
    });
  });

  it("merges target-account duplicates before reply and repost filtering", async () => {
    const test = harness({
      accountPosts: [
        post({ id: "701", text: "Reply relation", inReplyToId: "700" }),
        post({ id: "701", text: "Incomplete duplicate", inReplyToId: undefined }),
        post({ id: "801", text: "Repost relation", repostOfId: "800" }),
        post({ id: "801", text: "Incomplete duplicate", repostOfId: undefined }),
        post(),
      ],
    });

    const output = await test.adapter.refresh(account(), { now: NOW });

    expect(output.items.map((item) => item.guid)).toEqual(["100"]);
  });

  it("rejects inherited or sparse parser containers as typed failures", async () => {
    const inherited = Object.create({
      posts: [post()],
      warnings: [],
      candidateCount: 1,
    }) as ReturnType<typeof import("../../../../src/sources/tikhub/tikhub-parser").parseTikHubTimeline>;
    const sparsePosts: XPost[] = [];
    sparsePosts.length = 1;
    const outputs = [
      inherited,
      { posts: sparsePosts, warnings: [], candidateCount: 0 },
    ];

    for (const parsed of outputs) {
      const adapter = new XAccountAdapter({
        client: {
          fetchUserPosts: vi.fn(async () => ({ data: {} })),
          fetchUserReplies: vi.fn(async () => ({ data: {} })),
        },
        secretStore: { get: vi.fn(async () => API_KEY) },
        connectionId: CONNECTION_ID,
        parseTimeline: () => parsed,
      });
      await expect(adapter.refresh(account(), { now: NOW })).rejects.toMatchObject({
        code: "invalid-x-timeline",
      });
    }
  });

  it("rejects an accessor-backed parser cursor without executing it", async () => {
    let getterReads = 0;
    const parsed = {
      posts: [post()],
      warnings: [],
      candidateCount: 1,
    } as TikHubTimelineParseResult;
    Object.defineProperty(parsed, "nextCursor", {
      enumerable: true,
      get() {
        getterReads += 1;
        return "private-cursor";
      },
    });
    const adapter = new XAccountAdapter({
      client: {
        fetchUserPosts: vi.fn(async () => ({ data: {} })),
        fetchUserReplies: vi.fn(async () => ({ data: {} })),
      },
      secretStore: { get: vi.fn(async () => API_KEY) },
      connectionId: CONNECTION_ID,
      parseTimeline: () => parsed,
    });

    await expect(adapter.refresh(account(), { now: NOW })).rejects.toMatchObject({
      code: "invalid-x-timeline",
    });
    expect(getterReads).toBe(0);
  });

  it("never executes XPost accessors or reads inherited post data", async () => {
    let getterReads = 0;
    const getterPost = { ...post({ id: "501" }) } as XPost;
    Object.defineProperty(getterPost, "text", {
      enumerable: true,
      get() {
        getterReads += 1;
        return "Accessor text";
      },
    });
    const inheritedPost = Object.create(
      post({ id: "../../escape" }),
    ) as XPost;
    const adapter = new XAccountAdapter({
      client: {
        fetchUserPosts: vi.fn(async () => ({ data: {} })),
        fetchUserReplies: vi.fn(async () => ({ data: {} })),
      },
      secretStore: { get: vi.fn(async () => API_KEY) },
      connectionId: CONNECTION_ID,
      parseTimeline: () => ({
        posts: [getterPost, inheritedPost, post()],
        warnings: [],
        candidateCount: 3,
      }),
    });

    const output = await adapter.refresh(account(), { now: NOW });

    expect(getterReads).toBe(0);
    expect(output.items.map((item) => item.guid)).toEqual(["100"]);
    expect(output.warnings).toEqual([
      "Skipped an invalid parsed X post.",
      "Skipped an invalid parsed X post.",
    ]);
  });
});

describe("XAccountAdapter bounded first import", () => {
  it("follows cursors, deduplicates pages, and completes with the full current batch", async () => {
    const test = harness({
      postPages: [
        page([
          post({ id: "3", createdAt: "2026-07-22T07:00:00.000Z" }),
          post({ id: "2", createdAt: "2026-07-21T07:00:00.000Z", text: "older copy" }),
        ], "page-2"),
        page([
          post({ id: "2", createdAt: "2026-07-21T07:00:00.000Z", text: "newer copy" }),
          post({ id: "1", createdAt: "2026-07-20T07:00:00.000Z" }),
        ]),
      ],
    });

    const result = await test.adapter.refresh(account(), {
      now: NOW,
      feed: importFeed(),
    });

    expect(test.fetchUserPosts).toHaveBeenNthCalledWith(2, expect.objectContaining({
      cursor: "page-2",
    }));
    expect(result.feed.initialImportProgress).toMatchObject({
      status: "completed",
      pagesFetched: 2,
      itemsImported: 3,
      earliestImportedAt: "2026-07-20T07:00:00.000Z",
    });
    expect(result.collectionItems?.map((item) => item.guid)).toEqual(["3", "2", "1"]);
    expect(result.items.map((item) => item.guid)).toEqual(["3", "2", "1"]);
    expect(result.items.find((item) => item.guid === "2")).toMatchObject({
      plainText: "newer copy",
    });
  });

  it("stops at the selected date cutoff and does not request another page", async () => {
    const test = harness({
      postPages: [
        page([post({ id: "3", createdAt: "2026-07-20T08:00:00.000Z" })], "page-2"),
        page([
          post({ id: "2", createdAt: "2026-07-15T08:00:00.000Z" }),
          post({ id: "1", createdAt: "2026-07-15T07:59:59.999Z" }),
        ], "page-3"),
      ],
    });

    const result = await test.adapter.refresh(account(), {
      now: NOW,
      feed: importFeed({ policy: { mode: "lookback-days", days: 7 } }),
    });

    expect(test.fetchUserPosts).toHaveBeenCalledTimes(2);
    expect(result.collectionItems?.map((item) => item.guid)).toEqual(["3", "2"]);
    expect(result.feed.initialImportProgress).toMatchObject({
      status: "completed",
      pagesFetched: 2,
      itemsImported: 2,
    });
    expect(result.feed.initialImportProgress).not.toHaveProperty("nextCursor");
  });

  it("terminates a repeated-cursor loop with a safe warning", async () => {
    const test = harness({
      postPages: [
        page([post({ id: "3" })], "page-2"),
        page([post({ id: "2" })], "page-2"),
      ],
    });

    const result = await test.adapter.refresh(account(), {
      now: NOW,
      feed: importFeed(),
    });

    expect(test.fetchUserPosts).toHaveBeenCalledTimes(2);
    expect(result.feed.initialImportProgress).toMatchObject({
      status: "completed",
      pagesFetched: 2,
    });
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(JSON.stringify(result.warnings)).not.toContain("page-2");
  });

  it.each([
    new TikHubRequestBudgetError(),
    new TikHubRequestLedgerError("daily-limit", "daily unavailable"),
  ])("checkpoints a successful partial batch when a later page cannot be reserved", async (limitError) => {
    const test = harness({
      postPages: [
        page([post({ id: "3" })], "resume-page"),
        limitError,
      ],
    });

    const result = await test.adapter.refresh(account(), {
      now: NOW,
      feed: importFeed(),
    });

    expect(test.fetchUserPosts).toHaveBeenCalledTimes(2);
    expect(result.providerRequestCount).toBe(1);
    expect(result.collectionItems?.map((item) => item.guid)).toEqual(["3"]);
    expect(result.feed.initialImportProgress).toMatchObject({
      status: "paused-limit",
      pagesFetched: 1,
      itemsImported: 1,
      nextCursor: "resume-page",
    });
  });

  it("resumes from the persisted cursor and merges the historical cache", async () => {
    const historical = post({ id: "3", createdAt: "2026-07-21T07:00:00.000Z" });
    const test = harness({
      postPages: [page([
        post({ id: "3", createdAt: "2026-07-21T07:00:00.000Z", text: "overlap" }),
        post({ id: "2", createdAt: "2026-07-20T07:00:00.000Z" }),
      ])],
    });
    const feed = importFeed({
      posts: [historical],
      progress: {
        status: "paused-limit",
        pagesFetched: 1,
        itemsImported: 1,
        earliestImportedAt: historical.createdAt,
        nextCursor: "persisted-cursor",
      },
    });

    const result = await test.adapter.refresh(account(), { now: NOW, feed });

    expect(test.fetchUserPosts).toHaveBeenCalledWith(expect.objectContaining({
      cursor: "persisted-cursor",
    }));
    expect(result.feed.items.map((item) => item.guid)).toEqual(["3", "2"]);
    expect(result.collectionItems?.map((item) => item.guid)).toEqual(["3", "2"]);
    expect(result.feed.initialImportProgress).toMatchObject({
      status: "completed",
      pagesFetched: 2,
      itemsImported: 2,
      earliestImportedAt: "2026-07-20T07:00:00.000Z",
    });
  });

  it("paginates replies independently and counts every successful page", async () => {
    const config = account({ includeReplies: true });
    const test = harness({
      postPages: [page([post({ id: "3" })])],
      replyPages: [
        page([post({ id: "2", inReplyToId: "1" })], "reply-page-2"),
        page([post({ id: "1", inReplyToId: "0" })]),
      ],
    });

    const result = await test.adapter.refresh(config, {
      now: NOW,
      feed: importFeed({ config }),
    });

    expect(test.fetchUserPosts).toHaveBeenCalledOnce();
    expect(test.fetchUserReplies).toHaveBeenCalledTimes(2);
    expect(test.fetchUserReplies).toHaveBeenNthCalledWith(2, expect.objectContaining({
      cursor: "reply-page-2",
    }));
    expect(result.providerRequestCount).toBe(3);
    expect(result.feed.initialImportProgress).toMatchObject({
      status: "completed",
      pagesFetched: 3,
      itemsImported: 3,
    });
  });

  it("keeps a stopped import on the normal one-page daily refresh path", async () => {
    const config = account({ includeReplies: true });
    const test = harness({
      postPages: [page([post({ id: "3" })], "ignored-post-cursor")],
      replyPages: [page([post({ id: "2", inReplyToId: "1" })], "ignored-reply-cursor")],
    });
    const feed = importFeed({
      config,
      progress: { status: "stopped", pagesFetched: 4, itemsImported: 8 },
    });

    const result = await test.adapter.refresh(config, { now: NOW, feed });

    expect(test.fetchUserPosts).toHaveBeenCalledOnce();
    expect(test.fetchUserReplies).toHaveBeenCalledOnce();
    expect(result.providerRequestCount).toBe(2);
    expect(result.feed.initialImportProgress).toEqual(feed.initialImportProgress);
  });

  it("keeps completed and legacy daily refreshes to one posts page plus optional one replies page", async () => {
    for (const progress of [
      undefined,
      { status: "completed", pagesFetched: 2, itemsImported: 2 } as const,
    ]) {
      const config = account({ includeReplies: true });
      const test = harness({
        postPages: [page([post({ id: "3" })], "ignored-post-cursor")],
        replyPages: [page([post({ id: "2", inReplyToId: "1" })], "ignored-reply-cursor")],
      });
      const feed = importFeed({ config });
      if (progress === undefined) delete feed.initialImportProgress;
      else feed.initialImportProgress = progress;

      await test.adapter.refresh(config, { now: NOW, feed });

      expect(test.fetchUserPosts).toHaveBeenCalledOnce();
      expect(test.fetchUserReplies).toHaveBeenCalledOnce();
    }
  });
});

describe("X account feed mapping", () => {
  it("maps canonical metadata, safe complete text, and a 120-code-point title", () => {
    const dangerousText = `<img src=x onerror="globalThis.pwned=true">${"😀".repeat(130)}`;
    const mapped = mapXAccountPostsToFeed(account(), [
      post({ id: "200", text: dangerousText, metrics: { likes: 3, views: 40 } }),
    ], NOW);
    const item = mapped.items[0];

    expect(Array.from(item.title)).toHaveLength(120);
    expect(item.title).toContain("<img");
    expect(item.description).toContain("&lt;img");
    expect(item.description).not.toContain("<img");
    const rendered = new DOMParser().parseFromString(item.description, "text/html");
    expect(rendered.querySelector("img")).toBeNull();
    expect(rendered.body.textContent).toBe(dangerousText);
    expect(item.content).toBe(item.description);
    expect(item.plainText).toBe(dangerousText);
    expect(item).toMatchObject({
      guid: "200",
      link: "https://x.com/openai/status/200",
      feedUrl: "tikhub://x-account/openai",
      contentBasis: "x-post",
      sourceType: "x-account",
      sourceBucket: "X/关注账号",
      metrics: { likes: 3, views: 40 },
      sourceMetadata: {
        kind: "x-post",
        externalUrls: [],
      },
    });
    expect(mapped.feed).toMatchObject({
      feedId: "account-openai",
      sourceKind: "x-account",
      sourceType: "x-account",
      folder: "X/关注账号",
      url: "tikhub://x-account/openai",
    });
  });

  it("keeps legal angle brackets while neutralizing format controls and surrogates", () => {
    const mapped = mapXAccountPostsToFeed(account(), [
      post({
        id: "201",
        text: "Line one\n  2 < 3 and 5 > 4\t\u202Ebad\u200B \uD800 end",
      }),
    ], NOW);
    const item = mapped.items[0];

    expect(item.title).toBe("Line one 2 < 3 and 5 > 4 bad � end");
    expect(item.title).not.toContain("\u202E");
    expect(item.title).not.toContain("\u200B");
    expect(item.plainText).toBe(
      "Line one\n  2 < 3 and 5 > 4\t\u202Ebad\u200B � end",
    );
    expect(item.description).toContain("\u202Ebad\u200B � end");
    expect(item.description).toContain("2 &lt; 3 and 5 &gt; 4");
  });

  it("preserves legal Unicode joiners and body whitespace independently from title cleanup", () => {
    const exactText = "Family 👨‍👩‍👧‍👦; Persian می‌خواهم\nNext\tline";
    const mapped = mapXAccountPostsToFeed(account(), [
      post({ id: "203", text: exactText }),
    ], NOW);
    const item = mapped.items[0];

    expect(item.plainText).toBe(exactText);
    expect(item.description).toBe(exactText);
    expect(item.content).toBe(exactText);
    expect(item.description).toContain("👨‍👩‍👧‍👦");
    expect(item.description).toContain("می‌خواهم");
    expect(item.title).toBe(
      "Family 👨‍👩‍👧‍👦; Persian می‌خواهم Next line",
    );
  });

  it("carries all X relationships and links into durable source metadata", () => {
    const mapped = mapXAccountPostsToFeed(account(), [
      post({
        id: "202",
        conversationId: "190",
        inReplyToId: "191",
        repostOfId: "192",
        quoteOfId: "193",
        externalUrls: ["https://example.com/report"],
      }),
    ], NOW);
    const item = mapped.items[0];
    const collected = normalizeFeedItem(mapped.feed, item, NOW);

    expect(item.sourceMetadata).toEqual({
      kind: "x-post",
      conversationId: "190",
      inReplyToId: "191",
      repostOfId: "192",
      quoteOfId: "193",
      externalUrls: ["https://example.com/report"],
    });
    expect(collected.sourceMetadata).toEqual({
      ...item.sourceMetadata,
      observedSources: [
        {
          type: "x-account",
          id: "account-openai",
          bucket: "X/关注账号",
        },
      ],
    });
    expect(collected.sourceMetadata).not.toBe(item.sourceMetadata);
  });

  it("sorts by created time descending and then by post ID descending", () => {
    const mapped = mapXAccountPostsToFeed(account(), [
      post({ id: "8", createdAt: "2026-07-20T00:00:00.000Z" }),
      post({ id: "9", createdAt: "2026-07-21T00:00:00.000Z" }),
      post({ id: "10", createdAt: "2026-07-21T00:00:00.000Z" }),
      post({ id: "7", createdAt: undefined }),
    ], NOW);

    expect(mapped.items.map((item) => item.guid)).toEqual(["10", "9", "8", "7"]);
    expect(mapped.feed.items.map((item) => item.guid)).toEqual(["10", "9", "8", "7"]);
  });

  it("keeps X identity stable across handle/source changes while metrics merge", () => {
    const first = mapXAccountPostsToFeed(account({
      id: "account-oldhandle",
      handle: "oldhandle",
    }), [
      post({ metrics: { likes: 1 } }),
    ], NOW);
    const second = mapXAccountPostsToFeed(account({
      id: "account-newhandle",
      handle: "newhandle",
    }), [
      post({
        authorHandle: "newhandle",
        url: "https://x.com/newhandle/status/100",
        metrics: { likes: 7, replies: 2 },
      }),
    ], new Date("2026-07-22T09:00:00.000Z"));
    expect(first.items[0].rssDashboardId).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.items[0].rssDashboardId).toBe(second.items[0].rssDashboardId);
    const firstCollected = normalizeFeedItem(first.feed, first.items[0], NOW);
    const secondCollected = normalizeFeedItem(
      second.feed,
      second.items[0],
      new Date("2026-07-22T09:00:00.000Z"),
    );

    expect(firstCollected.id).toBe(secondCollected.id);
    expect(firstCollected.guid).toBe("100");
    expect(mergeCollectedItems(firstCollected, secondCollected)).toMatchObject({
      id: firstCollected.id,
      contentBasis: "x-post",
      sourceType: "x-account",
      sourceBucket: "X/关注账号",
      metrics: { likes: 7, replies: 2 },
    });
  });

  it("registers beside a feed adapter without changing RSS routing", async () => {
    const test = harness();
    const feedRefresh = vi.fn();
    const registry = new SourceRegistry();
    registry.register(test.adapter);
    registry.register({ kind: "feed", refresh: feedRefresh });

    await registry.refresh(account(), { now: NOW });

    expect(test.fetchUserPosts).toHaveBeenCalledOnce();
    expect(feedRefresh).not.toHaveBeenCalled();
  });
});
