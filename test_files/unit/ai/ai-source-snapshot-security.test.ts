import { describe, expect, it } from "vitest";
import {
  AI_SOURCE_SNAPSHOT_LIMITS,
  cloneAiSourceItem,
  resolveAndSnapshotAiSource,
} from "../../../src/ai/ai-source-snapshot";
import {
  createCollectedItemId,
  createXPostCollectedItemId,
} from "../../../src/collection/item-identity";
import type { Feed, FeedItem } from "../../../src/types/types";

function item(guid = "selected-guid"): FeedItem {
  return {
    title: "Selected",
    link: `https://example.com/${guid}`,
    description: "Selected description",
    pubDate: "2026-07-23T00:00:00.000Z",
    guid,
    read: false,
    starred: false,
    saved: false,
    tags: [],
    feedTitle: "Source",
    feedUrl: "https://example.com/feed.xml",
    coverImage: "",
  };
}

function feed(selected: FeedItem, id = "feed-id"): Feed {
  return {
    feedId: id,
    sourceKind: "feed",
    sourceConfig: { kind: "feed" },
    title: "Source",
    url: selected.feedUrl,
    folder: "Research",
    items: [selected],
    lastUpdated: Date.now(),
  };
}

describe("AI source snapshot security", () => {
  it("derives a missing canonical ID without mutating the original item", () => {
    const selected = item();
    const owner = feed(selected);
    const expected = createCollectedItemId({
      sourceId: "feed-id",
      guid: selected.guid,
      url: selected.link,
      title: selected.title,
      publishedAt: selected.pubDate,
    });

    const snapshot = resolveAndSnapshotAiSource([owner], selected);

    expect(snapshot?.expectedStableId).toBe(expected);
    expect(snapshot?.item.rssDashboardId).toBe(expected);
    expect(selected.rssDashboardId).toBeUndefined();
  });

  it("derives the canonical X post ID and rejects a present mismatch", () => {
    const selected = item("1901234567890123456");
    selected.link = "https://x.com/example/status/1901234567890123456";
    const owner = feed(selected);
    (owner as Feed & { sourceType?: string }).sourceType = "x-account";
    const expected = createXPostCollectedItemId(selected.guid);

    expect(resolveAndSnapshotAiSource([owner], selected)?.expectedStableId)
      .toBe(expected);
    selected.rssDashboardId = "a".repeat(64);
    expect(resolveAndSnapshotAiSource([owner], selected)).toBeUndefined();
  });

  it("fails closed for duplicate canonical identity or shared ownership", () => {
    const selected = item();
    const owner = feed(selected);
    owner.items.push(structuredClone(selected));
    expect(resolveAndSnapshotAiSource([owner], selected)).toBeUndefined();

    owner.items = [selected];
    const secondOwner = feed(selected, "other-feed-id");
    expect(resolveAndSnapshotAiSource([owner, secondOwner], selected))
      .toBeUndefined();
  });

  it.each([
    ["cyclic", () => {
      const value: Record<string, unknown> = {};
      value.self = value;
      return value;
    }],
    ["shared", () => {
      const shared = { text: "shared" };
      return { left: shared, right: shared };
    }],
    ["over-depth", () => {
      let value: Record<string, unknown> = { leaf: "safe" };
      for (let depth = 0; depth <= AI_SOURCE_SNAPSHOT_LIMITS.maxDepth; depth += 1) {
        value = { child: value };
      }
      return value;
    }],
  ] as const)("fails closed for %s own-data graphs", (_name, create) => {
    const selected = item();
    (selected as FeedItem & { hostile?: unknown }).hostile = create();
    expect(resolveAndSnapshotAiSource([feed(selected)], selected)).toBeUndefined();
  });

  it("enforces the documented feed-count boundary", () => {
    const selected = item();
    const owner = feed(selected);
    const empty = (index: number): Feed => ({
      ...feed(item(`empty-${index}`), `empty-${index}`),
      items: [],
    });
    const accepted = [
      ...Array.from(
        { length: AI_SOURCE_SNAPSHOT_LIMITS.maxFeeds - 1 },
        (_, index) => empty(index),
      ),
      owner,
    ];
    expect(resolveAndSnapshotAiSource(accepted, selected)).toBeDefined();
    expect(resolveAndSnapshotAiSource([...accepted, empty(9_999)], selected))
      .toBeUndefined();
  });

  it("deep-freezes an isolated snapshot and returns a fresh mutable save clone", () => {
    const selected = item();
    const nested = { labels: [{ name: "opening" }] };
    (selected as FeedItem & { nested?: typeof nested }).nested = nested;
    const snapshot = resolveAndSnapshotAiSource([feed(selected)], selected)!;
    const frozenNested = (snapshot.item as FeedItem & { nested: typeof nested }).nested;
    const mutable = cloneAiSourceItem(snapshot.item) as FeedItem & {
      nested: typeof nested;
    };

    expect(Object.isFrozen(snapshot.item)).toBe(true);
    expect(Object.isFrozen(frozenNested.labels[0])).toBe(true);
    expect(mutable.nested).not.toBe(frozenNested);
    expect(Object.isFrozen(mutable.nested)).toBe(false);
    nested.labels[0].name = "mutated";
    mutable.nested.labels[0].name = "save clone";
    expect(frozenNested.labels[0].name).toBe("opening");
  });

  it.each(["title", "link", "guid", "rssDashboardId"] as const)(
    "does not invoke a selected-item %s accessor",
    (field) => {
      const selected = item();
      let calls = 0;
      Object.defineProperty(selected, field, {
        configurable: true,
        get() {
          calls += 1;
          throw new Error("accessor must not run");
        },
      });
      expect(resolveAndSnapshotAiSource([feed(selected)], selected)).toBeUndefined();
      expect(calls).toBe(0);
    },
  );

  it("does not invoke unrelated candidate accessors while resolving a safe reference", () => {
    const selected = item();
    const owner = feed(selected);
    const unrelated = feed(item("unrelated"), "unrelated-feed-id");
    let calls = 0;
    Object.defineProperty(unrelated, "feedId", {
      configurable: true,
      get() {
        calls += 1;
        throw new Error("unrelated accessor must not run");
      },
    });
    Object.defineProperty(unrelated.items, "0", {
      configurable: true,
      get() {
        calls += 1;
        throw new Error("unrelated item accessor must not run");
      },
    });

    expect(resolveAndSnapshotAiSource([unrelated, owner], selected)).toBeDefined();
    expect(calls).toBe(0);
  });
});
