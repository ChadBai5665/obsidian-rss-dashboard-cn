import { describe, expect, it, vi } from "vitest";
import { normalizeFeedItem } from "../../../../src/collection/feed-normalizer";
import type { XTopicSourceConfig } from "../../../../src/sources/source-config";
import { SourceRegistry } from "../../../../src/sources/source-registry";
import type {
  TikHubBudgetReservation,
  TikHubRequestBudgetLike,
} from "../../../../src/sources/tikhub/request-budget";
import { TikHubRequestBudgetError } from "../../../../src/sources/tikhub/request-budget";
import type { TikHubSearchRequest } from "../../../../src/sources/tikhub/tikhub-client";
import type { TikHubTimelineParseResult } from "../../../../src/sources/tikhub/tikhub-parser";
import type { XPost } from "../../../../src/sources/tikhub/x-post";
import {
  XTopicAdapter,
  type XTopicTikHubClient,
} from "../../../../src/sources/tikhub/x-topic-adapter";

const CONNECTION_ID = "d4eb3f58-b672-4f73-b9f3-9cd2f0e57a8d";
const API_KEY = "method-scoped-key";
const NOW = new Date("2026-07-22T08:00:00.000Z");

function topic(overrides: Partial<XTopicSourceConfig> = {}): XTopicSourceConfig {
  return {
    kind: "x-topic",
    id: "topic-ai",
    name: "AI 应用",
    includeKeywords: ["AI", "agent ops"],
    excludeKeywords: ["giveaway"],
    priorityAccounts: [],
    windowDays: 7,
    folder: "X/主题",
    ...overrides,
  };
}

function post(overrides: Partial<XPost> = {}): XPost {
  const id = overrides.id ?? "100";
  const authorHandle = overrides.authorHandle ?? "alice";
  const value = {
    id,
    authorHandle,
    text: "An observed X post",
    createdAt: "2026-07-22T07:00:00.000Z",
    url: `https://x.com/${authorHandle}/status/${id}`,
    externalUrls: [],
    metrics: {},
    ...overrides,
  } as XPost;
  for (const key of Object.keys(value) as Array<keyof XPost>) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}

function harness(options: {
  responses?: XPost[][];
  reserveError?: Error;
  failCall?: number;
  parseTimeline?: (value: unknown) => TikHubTimelineParseResult;
} = {}) {
  let remaining = 0;
  const markAttempted = vi.fn(() => {
    if (remaining <= 0) throw new Error("No reserved TikHub request remains");
    remaining -= 1;
  });
  const releaseUnused = vi.fn(async () => {
    const released = remaining;
    remaining = 0;
    return released;
  });
  const reservation: TikHubBudgetReservation = {
    total: 3,
    get remaining() {
      return remaining;
    },
    markAttempted,
    releaseUnused,
  };
  const reserve = vi.fn(async (count: number) => {
    if (options.reserveError) throw options.reserveError;
    remaining = count;
    return reservation;
  });
  const budget: TikHubRequestBudgetLike = { reserve };
  let callIndex = 0;
  const fetchSearchTimeline = vi.fn(
    async (request: TikHubSearchRequest) => {
      callIndex += 1;
      if (options.failCall === callIndex) throw new Error("provider failed");
      request.reservation?.markAttempted();
      return {
        data: { posts: options.responses?.[callIndex - 1] ?? [] },
      };
    },
  );
  const client: XTopicTikHubClient = { fetchSearchTimeline };
  const adapter = new XTopicAdapter({
    client,
    budget,
    secretStore: { get: vi.fn(async () => API_KEY) },
    connectionId: CONNECTION_ID,
    parseTimeline:
      options.parseTimeline ??
      ((value) => {
        const posts = (value as { posts?: XPost[] }).posts ?? [];
        return { posts, warnings: [], candidateCount: posts.length };
      }),
  });
  return {
    adapter,
    budget,
    fetchSearchTimeline,
    markAttempted,
    releaseUnused,
    reserve,
  };
}

describe("XTopicAdapter request planning and neutral observations", () => {
  it("reserves two calls atomically and sends the same query once to Latest and Top", async () => {
    const test = harness();

    const result = await test.adapter.refresh(topic(), { now: NOW });

    expect(test.reserve).toHaveBeenCalledOnce();
    expect(test.reserve).toHaveBeenCalledWith(2);
    expect(test.fetchSearchTimeline).toHaveBeenCalledTimes(2);
    const calls = test.fetchSearchTimeline.mock.calls.map(([request]) => request);
    expect(calls.map(({ searchType }) => searchType)).toEqual(["Latest", "Top"]);
    expect(calls[0]?.query).toBe(calls[1]?.query);
    expect(calls.every(({ apiKey }) => apiKey === API_KEY)).toBe(true);
    expect(calls[0]?.reservation).toBe(calls[1]?.reservation);
    expect(result.providerRequestCount).toBe(2);
    expect(test.markAttempted).toHaveBeenCalledTimes(2);
    expect(test.releaseUnused).toHaveBeenCalledOnce();
  });

  it("adds exactly one priority Latest request and merges duplicate observation tags", async () => {
    const shared = post({
      id: "200",
      externalUrls: ["https://example.com/report?utm_source=x"],
      conversationId: "190",
    });
    const topDuplicate = post({
      ...shared,
      conversationId: "191",
      externalUrls: ["https://example.com/second"],
    });
    const priorityDuplicate = post({
      id: "200",
      externalUrls: ["https://example.com/report?utm_source=x"],
      quoteOfId: "180",
    });
    const test = harness({
      responses: [[shared], [topDuplicate], [priorityDuplicate]],
    });

    const result = await test.adapter.refresh(
      topic({ priorityAccounts: ["openai", "anthropic"] }),
      { now: NOW },
    );

    expect(test.reserve).toHaveBeenCalledWith(3);
    expect(test.fetchSearchTimeline).toHaveBeenCalledTimes(3);
    expect(test.fetchSearchTimeline.mock.calls.map(([request]) => request.searchType))
      .toEqual(["Latest", "Top", "Latest"]);
    expect(test.fetchSearchTimeline.mock.calls[2]?.[0].query).toContain(
      "(from:openai OR from:anthropic)",
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      guid: "200",
      sourceType: "x-topic",
      sourceMetadata: {
        kind: "x-post",
        conversationId: "190",
        quoteOfId: "180",
        externalUrls: [
          "https://example.com/report?utm_source=x",
          "https://example.com/second",
        ],
        observationTags: ["latest", "platform-top", "priority-account"],
      },
    });
    expect(result.items[0]).not.toHaveProperty("score");

    const collected = normalizeFeedItem(result.feed, result.items[0], NOW);
    expect(collected.observationType).toBe("new");
    expect(collected.topics).toEqual([
      "AI 应用",
      "x:latest",
      "x:platform-top",
      "x:priority-account",
    ]);
  });

  it("enforces the exact elapsed local window and exposes objective shared-page groups", async () => {
    const before = post({ id: "300", createdAt: "2026-07-15T07:59:59.999Z" });
    const boundary = post({
      id: "301",
      authorHandle: "alice",
      createdAt: "2026-07-15T08:00:00.000Z",
      externalUrls: ["https://example.com/shared?utm_campaign=x"],
    });
    const recent = post({
      id: "302",
      authorHandle: "bob",
      externalUrls: ["https://example.com/shared"],
    });
    const missingDate = post({ id: "303", createdAt: undefined });
    const test = harness({ responses: [[before, boundary], [recent, missingDate]] });

    const result = await test.adapter.refresh(topic(), { now: NOW });

    expect(result.items.map((item) => item.guid)).toEqual(["302", "301"]);
    expect(result.linkedPageGroups).toEqual([
      {
        url: "https://example.com/shared",
        postCount: 2,
        authors: ["alice", "bob"],
        postIds: ["301", "302"],
      },
    ]);
    expect(result.linkedPageGroups?.[0]).not.toHaveProperty("score");
    expect(result.warnings).toContain("Skipped an X post without an in-window timestamp.");
  });

  it.each([1, 3, 7, 14, 30] as const)(
    "enforces the %i-day client-side boundary even when provider results are stale",
    async (windowDays) => {
      const boundary = new Date(
        NOW.getTime() - windowDays * 24 * 60 * 60 * 1_000,
      );
      const test = harness({
        responses: [
          [
            post({
              id: "401",
              createdAt: new Date(boundary.getTime() - 1).toISOString(),
            }),
            post({ id: "402", createdAt: boundary.toISOString() }),
          ],
          [],
        ],
      });

      const result = await test.adapter.refresh(topic({ windowDays }), {
        now: NOW,
      });

      expect(result.items.map((item) => item.guid)).toEqual(["402"]);
    },
  );

  it("makes zero calls and returns a warning when the whole batch cannot be reserved", async () => {
    const test = harness({ reserveError: new TikHubRequestBudgetError() });

    const result = await test.adapter.refresh(topic(), { now: NOW });

    expect(test.reserve).toHaveBeenCalledWith(2);
    expect(test.fetchSearchTimeline).not.toHaveBeenCalled();
    expect(result.items).toEqual([]);
    expect(result.providerRequestCount).toBe(0);
    expect(result.warnings).toEqual([
      "TikHub request budget could not reserve this topic batch.",
    ]);
  });

  it("releases the unattempted batch tail after an early failure or abort", async () => {
    const failed = harness({ failCall: 2 });
    await expect(failed.adapter.refresh(topic(), { now: NOW })).rejects.toThrow(
      "provider failed",
    );
    expect(failed.markAttempted).toHaveBeenCalledTimes(1);
    expect(failed.releaseUnused).toHaveBeenCalledOnce();

    const controller = new AbortController();
    controller.abort();
    const aborted = harness();
    await expect(
      aborted.adapter.refresh(topic(), { now: NOW, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(aborted.fetchSearchTimeline).not.toHaveBeenCalled();
    expect(aborted.releaseUnused).toHaveBeenCalledOnce();
  });

  it("rejects a hostile parser seam and releases the unattempted tail", async () => {
    const sparsePosts = Array<XPost>(1);
    const test = harness({
      parseTimeline: () => ({
        posts: sparsePosts,
        warnings: [],
        candidateCount: 1,
      }),
    });

    await expect(test.adapter.refresh(topic(), { now: NOW })).rejects.toMatchObject({
      code: "invalid-x-timeline",
    });
    expect(test.fetchSearchTimeline).toHaveBeenCalledOnce();
    expect(test.markAttempted).toHaveBeenCalledOnce();
    expect(test.releaseUnused).toHaveBeenCalledOnce();
  });

  it("registers as x-topic and never falls through to a feed adapter", async () => {
    const test = harness();
    const rssRefresh = vi.fn();
    const registry = new SourceRegistry();
    registry.register({ kind: "feed", refresh: rssRefresh });
    registry.register(test.adapter);

    await registry.refresh(topic(), { now: NOW });

    expect(test.fetchSearchTimeline).toHaveBeenCalledTimes(2);
    expect(rssRefresh).not.toHaveBeenCalled();
  });

  it("rejects adapter-supplied linked-page judgments at the registry boundary", async () => {
    const test = harness();
    const output = await test.adapter.refresh(topic(), { now: NOW });
    const registry = new SourceRegistry();
    registry.register({
      kind: "x-topic",
      refresh: vi.fn().mockResolvedValue({
        ...output,
        linkedPageGroups: [
          {
            url: "https://example.com/shared",
            postCount: 2,
            authors: ["alice", "bob"],
            postIds: ["1", "2"],
            score: 99,
          },
        ],
      }),
    });

    await expect(registry.refresh(topic(), { now: NOW })).rejects.toThrow(
      "Invalid source refresh output",
    );
  });
});
