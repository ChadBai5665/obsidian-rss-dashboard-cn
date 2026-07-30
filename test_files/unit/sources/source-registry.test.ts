import { describe, expect, it, vi } from "vitest";
import type { Feed, FeedItem } from "../../../src/types/types";
import type { SourceAdapter } from "../../../src/sources/source-adapter";
import {
  SourceRegistry,
  UnsupportedSourceError,
} from "../../../src/sources/source-registry";
import type {
  XAccountSourceConfig,
  XTopicSourceConfig,
} from "../../../src/sources/source-config";

const account: XAccountSourceConfig = {
  kind: "x-account",
  id: "account-1",
  handle: "openai",
  includeReplies: false,
  includeReposts: false,
  folder: "X",
  topics: [],
};

const feed: Feed = {
  title: "OpenAI",
  url: "tikhub://x-account/openai",
  folder: "X",
  items: [],
  lastUpdated: 0,
  sourceKind: "x-account",
  sourceConfig: account,
};

const item: FeedItem = {
  title: "Post",
  link: "https://x.com/openai/status/1",
  description: "",
  pubDate: "2026-07-22T00:00:00.000Z",
  guid: "1",
  feedTitle: "OpenAI",
  feedUrl: feed.url,
  coverImage: "",
};

describe("SourceRegistry", () => {
  it("routes a typed config to its registered adapter", async () => {
    const refresh = vi.fn().mockResolvedValue({
      feed,
      items: [item],
      providerRequestCount: 1,
      warnings: [],
    });
    const adapter: SourceAdapter<XAccountSourceConfig> = {
      kind: "x-account",
      refresh,
    };
    const registry = new SourceRegistry();
    registry.register(adapter);

    await expect(
      registry.refresh(account, { now: new Date("2026-07-22") }),
    ).resolves.toMatchObject({
      providerRequestCount: 1,
      items: [item],
    });
    expect(refresh).toHaveBeenCalledWith(account, {
      now: new Date("2026-07-22"),
    });
  });

  it("rejects duplicate adapter registrations", () => {
    const registry = new SourceRegistry();
    const adapter: SourceAdapter<XAccountSourceConfig> = {
      kind: "x-account",
      refresh: vi.fn(),
    };
    registry.register(adapter);

    expect(() => registry.register(adapter)).toThrow("x-account");
  });

  it("rejects an adapter with an unsupported runtime kind", () => {
    const registry = new SourceRegistry();
    expect(() =>
      registry.register({
        kind: "unknown",
        refresh: vi.fn(),
      } as never),
    ).toThrow("Invalid source adapter");
  });

  it("throws a localized unsupported-source error instead of falling back to RSS", async () => {
    const rssRefresh = vi.fn();
    const registry = new SourceRegistry({
      translate: (key, params) => `中文：${key} ${params?.kind ?? ""}`,
    });
    registry.register({ kind: "feed", refresh: rssRefresh });

    const unknown: XTopicSourceConfig = {
      kind: "x-topic",
      id: "topic-1",
      name: "AI",
      includeKeywords: [],
      excludeKeywords: [],
      priorityAccounts: [],
      windowDays: 7,
      folder: "X",
    };
    await expect(
      registry.refresh(unknown, { now: new Date() }),
    ).rejects.toMatchObject({
      code: "unsupported-source",
      translationKey: "source.unsupported",
      message: "中文：source.unsupported x-topic",
    } satisfies Partial<UnsupportedSourceError>);
    expect(rssRefresh).not.toHaveBeenCalled();
  });

  it("rejects an adapter result that violates request-count or warning invariants", async () => {
    const registry = new SourceRegistry();
    registry.register({
      kind: "x-account",
      refresh: vi.fn().mockResolvedValue({
        feed,
        items: [],
        providerRequestCount: -1,
        warnings: "not-an-array",
      }),
    });

    await expect(
      registry.refresh(account, { now: new Date() }),
    ).rejects.toThrow("Invalid source refresh output");
  });

  it("gives every adapter an isolated feed snapshot and clones warnings", async () => {
    const controller = new AbortController();
    const sourceFeed = { ...feed, items: [{ ...item }] };
    const context = {
      now: new Date("2026-07-22"),
      signal: controller.signal,
      feed: sourceFeed,
    };
    const warnings = ["first"];
    const refresh = vi.fn().mockResolvedValue({
      feed: { ...feed, sourceConfig: { ...account, topics: [] } },
      items: [{ ...item }],
      providerRequestCount: 1,
      warnings,
    });
    const registry = new SourceRegistry();
    registry.register({ kind: "x-account", refresh });

    const output = await registry.refresh(account, context);
    warnings.push("mutated after return");
    expect(output.warnings).toEqual(["first"]);
    expect(refresh).toHaveBeenCalledWith(account, expect.objectContaining({
      now: context.now,
      signal: context.signal,
      feed: sourceFeed,
    }));
    const adapterContext = refresh.mock.calls[0][1];
    expect(adapterContext).not.toBe(context);
    expect(adapterContext.feed).not.toBe(sourceFeed);
    expect(adapterContext.feed.items).not.toBe(sourceFeed.items);
    adapterContext.feed.items[0].title = "Adapter mutation";
    expect(sourceFeed.items[0].title).toBe("Post");

    const mismatched = new SourceRegistry();
    mismatched.register({
      kind: "x-account",
      refresh: vi.fn().mockResolvedValue({
        feed: {
          ...feed,
          url: "https://example.com/rss",
          sourceKind: "feed",
          sourceConfig: { kind: "feed" },
        },
        items: [],
        providerRequestCount: 0,
        warnings: [],
      }),
    });
    await expect(mismatched.refresh(account, context)).rejects.toMatchObject({
      code: "invalid-source-output",
    });
  });

  it("validates and clones the optional complete collection batch", async () => {
    const collectionItems = [{ ...item }];
    const registry = new SourceRegistry();
    registry.register({
      kind: "x-account",
      refresh: vi.fn().mockResolvedValue({
        feed,
        items: [],
        collectionItems,
        providerRequestCount: 1,
        warnings: [],
      }),
    });

    const output = await registry.refresh(account, {
      now: new Date(),
      feed,
    });
    collectionItems.push({ ...item, guid: "2" });

    expect(output.collectionItems).toEqual([item]);
    expect(output.collectionItems).not.toBe(collectionItems);

    const invalid = new SourceRegistry();
    invalid.register({
      kind: "x-account",
      refresh: vi.fn().mockResolvedValue({
        feed,
        items: [],
        collectionItems: [{}],
        providerRequestCount: 1,
        warnings: [],
      }),
    });
    await expect(invalid.refresh(account, { now: new Date(), feed })).rejects
      .toMatchObject({ code: "invalid-source-output" });
  });

  it("rejects inherited output fields and incomplete FeedItems", async () => {
    const inheritedFeed = Object.create(feed) as Feed;
    Object.assign(inheritedFeed, {
      sourceKind: "x-account",
      sourceConfig: { ...account },
      url: "tikhub://x-account/openai",
    });
    const inheritedOutput = Object.create({
      feed: inheritedFeed,
      items: [{}],
      providerRequestCount: 0,
      warnings: [],
    });
    const registry = new SourceRegistry();
    registry.register({
      kind: "x-account",
      refresh: vi.fn().mockResolvedValue(inheritedOutput),
    });

    await expect(registry.refresh(account, { now: new Date() })).rejects.toMatchObject({
      code: "invalid-source-output",
    });
  });
});
