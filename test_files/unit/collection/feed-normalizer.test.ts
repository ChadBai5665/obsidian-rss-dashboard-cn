import { describe, expect, it } from "vitest";
import { normalizeFeedItem } from "../../../src/collection/feed-normalizer";
import type { Feed, FeedItem } from "../../../src/types/types";

const now = new Date("2026-07-21T10:00:00.000Z");

function createFeed(overrides: Partial<Feed> = {}): Feed {
  return {
    feedId: "feed-123",
    title: "Engineering Daily",
    url: "https://example.com/rss.xml",
    folder: "Technology/Engineering",
    items: [],
    lastUpdated: 0,
    ...overrides,
  };
}

function createItem(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    title: "A collected item",
    link: "https://example.com/articles/42?utm_source=rss",
    description: "A concise feed description.",
    pubDate: "2026-07-20T09:30:00.000Z",
    guid: "article-42",
    feedTitle: "Engineering Daily",
    feedUrl: "https://example.com/rss.xml",
    coverImage: "",
    tags: [
      { name: "typescript", color: "blue" },
      { name: "typescript", color: "red" },
      { name: "architecture", color: "green" },
    ],
    ...overrides,
  };
}

describe("normalizeFeedItem", () => {
  it("maps a standard feed item into a deterministic collected record", () => {
    const collected = normalizeFeedItem(createFeed(), createItem(), now);

    expect(collected).toMatchObject({
      schemaVersion: 1,
      sourceType: "rss",
      sourceId: "feed-123",
      sourceName: "Engineering Daily",
      sourceBucket: "Technology/Engineering",
      title: "A collected item",
      publishedAt: "2026-07-20T09:30:00.000Z",
      fetchedAt: "2026-07-21T10:00:00.000Z",
      firstSeenAt: "2026-07-21T10:00:00.000Z",
      lastSeenAt: "2026-07-21T10:00:00.000Z",
      url: "https://example.com/articles/42",
      guid: "article-42",
      observationType: "new",
      topics: ["typescript", "architecture"],
      excerpt: "A concise feed description.",
      contentBasis: "feed",
      read: false,
      starred: false,
      saved: false,
      collectionStatus: "collected",
    });
    expect(collected.id).toMatch(/^[a-f0-9]{64}$/);
  });

  it("uses feed URL as the source ID and honors valid optional source metadata", () => {
    const feed = createFeed({ feedId: undefined, url: "https://example.com/atom.xml" }) as Feed & {
      sourceType?: string;
    };
    feed.sourceType = "atom";

    const collected = normalizeFeedItem(feed, createItem(), now);

    expect(collected.sourceType).toBe("atom");
    expect(collected.sourceId).toBe("https://example.com/atom.xml");
    expect(collected.contentBasis).toBe("feed");
  });

  it("infers podcast and YouTube records without changing upstream parser types", () => {
    const podcast = normalizeFeedItem(
      createFeed({ mediaType: "podcast" }),
      createItem(),
      now,
    );
    const youtube = normalizeFeedItem(
      createFeed({ mediaType: "video" }),
      createItem({
        link: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        mediaType: "video",
      }),
      now,
    );

    expect(podcast.sourceType).toBe("podcast");
    expect(podcast.contentBasis).toBe("feed");
    expect(youtube.sourceType).toBe("youtube");
    expect(youtube.contentBasis).toBe("title-description");
  });

  it("infers YouTube from feed or item URLs when source metadata is unavailable", () => {
    const collected = normalizeFeedItem(
      createFeed({
        url: "https://www.youtube.com/feeds/videos.xml?channel_id=channel",
      }),
      createItem({ link: "https://youtu.be/dQw4w9WgXcQ" }),
      now,
    );

    expect(collected.sourceType).toBe("youtube");
    expect(collected.contentBasis).toBe("title-description");
  });
});
