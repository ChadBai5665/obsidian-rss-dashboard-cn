import { describe, expect, it } from "vitest";
import type { FeedItem } from "../../../src/types/types";
import {
  filterItemsForInitialImport,
  normalizeInitialImportPolicy,
  normalizeInitialImportProgress,
} from "../../../src/sources/initial-import-policy";

function item(pubDate: string, guid: string): FeedItem {
  return {
    title: guid,
    link: `https://example.com/${guid}`,
    description: "",
    pubDate,
    guid,
    feedTitle: "Example",
    feedUrl: "https://example.com/feed.xml",
    coverImage: "",
  };
}

describe("initial import policy", () => {
  it("defaults an absent policy and accepts only the declared policy variants", () => {
    expect(normalizeInitialImportPolicy(undefined)).toEqual({
      mode: "lookback-days",
      days: 7,
    });
    expect(
      normalizeInitialImportPolicy({ mode: "since-date", since: "2026-07-01" }),
    ).toEqual({ mode: "since-date", since: "2026-07-01" });
    expect(
      normalizeInitialImportPolicy({ mode: "lookback-days", days: -1 }),
    ).toBeUndefined();
    expect(
      normalizeInitialImportPolicy({ mode: "since-date", since: "2026-02-30" }),
    ).toBeUndefined();
  });

  it("rejects inherited or accessor-backed policy fields", () => {
    const inherited = Object.create({ mode: "from-now" });
    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, "mode", {
      enumerable: true,
      get: () => "from-now",
    });

    expect(normalizeInitialImportPolicy(inherited)).toBeUndefined();
    expect(normalizeInitialImportPolicy(accessor)).toBeUndefined();
  });

  it("filters a lookback window against its supplied time", () => {
    const now = new Date("2026-07-27T12:00:00.000Z");
    const items = [
      item("2026-07-20T12:00:00.000Z", "at-cutoff"),
      item("2026-07-20T11:59:59.999Z", "before-cutoff"),
    ];

    expect(
      filterItemsForInitialImport(items, { mode: "lookback-days", days: 7 }, now),
    ).toEqual([items[0]]);
  });

  it("keeps only valid, bounded progress data and clones it", () => {
    const progress = {
      status: "running",
      pagesFetched: 3,
      itemsImported: 12,
      earliestImportedAt: "2026-07-25T00:00:00.000Z",
      phase: "replies",
      nextCursor: "next-page",
      replyCursor: "reply-page",
    };

    const normalized = normalizeInitialImportProgress(progress);

    expect(normalized).toEqual(progress);
    expect(normalized).not.toBe(progress);
    expect(
      normalizeInitialImportProgress({
        ...progress,
        nextCursor: "x".repeat(4_097),
      }),
    ).toBeUndefined();
  });

  it("rejects accessor-backed provider cursors without invoking them", () => {
    const progress = {
      status: "running",
      pagesFetched: 1,
      itemsImported: 2,
    } as Record<string, unknown>;
    let getterCalls = 0;
    Object.defineProperty(progress, "nextCursor", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "cursor";
      },
    });

    expect(normalizeInitialImportProgress(progress)).toBeUndefined();
    expect(getterCalls).toBe(0);
  });
});
