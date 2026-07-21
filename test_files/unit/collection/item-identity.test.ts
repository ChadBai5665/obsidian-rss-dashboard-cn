import { describe, expect, it } from "vitest";
import {
  canonicalizeUrl,
  createCollectedItemId,
} from "../../../src/collection/item-identity";

describe("collection item identities", () => {
  it("uses a canonical item URL before source-local identifiers", () => {
    const firstId = createCollectedItemId({
      sourceId: "feed-one",
      guid: "entry-one",
      url: "https://example.com/articles/42?b=2&a=1",
      title: "An article",
    });
    const secondId = createCollectedItemId({
      sourceId: "feed-two",
      guid: "entry-two",
      url: "https://EXAMPLE.com:443/articles/42?a=1&b=2#comments",
      title: "A syndicated title",
    });

    expect(firstId).toBe(secondId);
  });

  it("removes recognized tracking parameters from canonical URLs", () => {
    const cleanId = createCollectedItemId({
      sourceId: "feed-one",
      url: "https://example.com/article?ref=homepage",
      title: "Article",
    });
    const trackedId = createCollectedItemId({
      sourceId: "feed-two",
      url: "https://example.com/article?utm_source=newsletter&fbclid=abc&gclid=def&ref=homepage",
      title: "Article",
    });

    expect(trackedId).toBe(cleanId);
  });

  it("uses a source-scoped GUID when no usable URL is available", () => {
    const firstId = createCollectedItemId({
      sourceId: "feed-one",
      guid: "same-guid",
      url: "not a URL",
      title: "Article",
    });
    const repeatedId = createCollectedItemId({
      sourceId: "feed-one",
      guid: "same-guid",
      title: "Renamed article",
    });
    const otherSourceId = createCollectedItemId({
      sourceId: "feed-two",
      guid: "same-guid",
      title: "Article",
    });

    expect(firstId).toBe(repeatedId);
    expect(otherSourceId).not.toBe(firstId);
  });

  it("falls back to normalized source, title, author, and publication time", () => {
    const firstId = createCollectedItemId({
      sourceId: "feed-one",
      title: "  A   Title ",
      author: " Ada  Lovelace ",
      publishedAt: "2026-07-21T10:00:00.000Z",
    });
    const normalizedId = createCollectedItemId({
      sourceId: "feed-one",
      title: "a title",
      author: "ada lovelace",
      publishedAt: "2026-07-21T10:00:00.000Z",
    });

    expect(firstId).toBe(normalizedId);
  });

  it("keeps same-title URL-less items from different sources distinct", () => {
    const firstId = createCollectedItemId({
      sourceId: "feed-one",
      title: "Shared title",
    });
    const secondId = createCollectedItemId({
      sourceId: "feed-two",
      title: "Shared title",
    });

    expect(firstId).not.toBe(secondId);
  });

  it("returns lowercase SHA-256 hexadecimal IDs and rejects non-absolute URLs", () => {
    const id = createCollectedItemId({
      sourceId: "feed-one",
      title: "Article",
    });

    expect(id).toMatch(/^[a-f0-9]{64}$/);
    expect(canonicalizeUrl("/relative/article")).toBe("");
    expect(canonicalizeUrl("not a URL")).toBe("");
  });
});
