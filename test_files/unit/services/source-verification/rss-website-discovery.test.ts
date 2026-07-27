import { describe, expect, it } from "vitest";
import {
  discoverRssWebsite,
} from "../../../../src/services/source-verification/rss-website-discovery.js";

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Example RSS</title><item><title>Latest RSS item</title><pubDate>Sun, 27 Jul 2026 10:00:00 GMT</pubDate></item></channel></rss>`;
const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Example Atom</title><entry><title>Latest Atom entry</title><updated>2026-07-27T10:00:00Z</updated></entry></feed>`;
const JSON_FEED = JSON.stringify({
  version: "https://jsonfeed.org/version/1.1",
  title: "Example JSON Feed",
  items: [
    {
      id: "latest",
      title: "Latest JSON item",
      date_published: "2026-07-27T10:00:00Z",
    },
  ],
});

describe("RSS and website discovery", () => {
  it.each([
    ["rss", RSS, "Example RSS", "Latest RSS item"],
    ["atom", ATOM, "Example Atom", "Latest Atom entry"],
    ["json", JSON_FEED, "Example JSON Feed", "Latest JSON item"],
  ])(
    "validates a direct %s feed and extracts its latest entry",
    async (format, text, title, latestTitle) => {
      const result = await discoverRssWebsite("https://example.com/feed", {
        request: async () => ({
          url: "https://feeds.example.com/feed",
          text,
        }),
      });

      expect(result).toMatchObject({
        inputUrl: "https://example.com/feed",
        siteUrl: "https://feeds.example.com/feed",
        selected: {
          url: "https://feeds.example.com/feed",
          title,
          format,
        },
        latestTitle,
        latestPubDate: expect.stringContaining("2026"),
        hasEntries: true,
      });
      expect(result.candidates).toHaveLength(1);
    },
  );

  it("resolves declared alternate feeds against the final website URL", async () => {
    const result = await discoverRssWebsite("https://example.com", {
      request: async (url) => {
        if (url === "https://example.com/") {
          return {
            url: "https://www.example.com/news/",
            text: `<html><head>
              <link rel="alternate" type="application/rss+xml" title="All" href="/feed.xml">
              <link rel="alternate" type="application/atom+xml" title="Research" href="research.atom">
            </head></html>`,
          };
        }
        if (url === "https://www.example.com/feed.xml") {
          return { url, text: RSS };
        }
        return { url, text: ATOM };
      },
    });

    expect(result.candidates).toEqual([
      { url: "https://www.example.com/feed.xml", title: "All", format: "rss" },
      { url: "https://www.example.com/news/research.atom", title: "Research", format: "atom" },
    ]);
    expect(result.selected).toBeUndefined();
    expect(result.hasEntries).toBe(false);
  });

  it("deduplicates canonical declarations and ignores unsafe alternate URLs", async () => {
    const result = await discoverRssWebsite("https://example.com", {
      request: async (url) => {
        if (url === "https://example.com/") {
          return {
            url,
            text: `<html><head>
              <link rel="alternate" type="application/rss+xml" href="/feed.xml#fragment">
              <link rel="alternate" type="application/rss+xml" title="Duplicate" href="https://example.com/feed.xml">
              <link rel="alternate" type="application/rss+xml" href="javascript:alert(1)">
              <link rel="alternate" type="application/rss+xml" href="https://user:password@example.com/private.xml">
            </head></html>`,
          };
        }
        return { url, text: RSS };
      },
    });

    expect(result.candidates).toEqual([
      { url: "https://example.com/feed.xml", title: "Example RSS", format: "rss" },
    ]);
    expect(result.selected).toEqual(result.candidates[0]);
  });

  it("tries only common feed paths when a page declares none", async () => {
    const requests: string[] = [];
    const result = await discoverRssWebsite("https://example.com/blog", {
      request: async (url) => {
        requests.push(url);
        if (url === "https://example.com/blog") {
          return { url, text: "<html><head></head><body>Blog</body></html>" };
        }
        if (url === "https://example.com/rss.xml") return { url, text: RSS };
        return { url, text: "not a feed" };
      },
    });

    expect(requests).toEqual([
      "https://example.com/blog",
      "https://example.com/feed",
      "https://example.com/feed.xml",
      "https://example.com/rss",
      "https://example.com/rss.xml",
    ]);
    expect(result.selected).toEqual({
      url: "https://example.com/rss.xml",
      title: "Example RSS",
      format: "rss",
    });
  });

  it("returns no selection when no candidate feed is found", async () => {
    const result = await discoverRssWebsite("https://example.com", {
      request: async (url) => ({
        url,
        text: "<html><head></head><body>Nothing to subscribe to</body></html>",
      }),
    });

    expect(result).toMatchObject({ candidates: [], hasEntries: false });
    expect(result.selected).toBeUndefined();
  });

  it("keeps an empty direct feed selectable while warning through hasEntries", async () => {
    const result = await discoverRssWebsite("https://example.com/feed.xml", {
      request: async (url) => ({
        url,
        text: `<?xml version="1.0"?><rss version="2.0"><channel><title>Empty feed</title></channel></rss>`,
      }),
    });

    expect(result.selected).toEqual({
      url: "https://example.com/feed.xml",
      title: "Empty feed",
      format: "rss",
    });
    expect(result).toMatchObject({ hasEntries: false });
  });

  it.each([
    "ftp://example.com/feed.xml",
    "https://user:password@example.com/feed.xml",
  ])("rejects an unsafe source input", async (input) => {
    await expect(
      discoverRssWebsite(input, {
        request: async () => ({ url: "https://example.com", text: RSS }),
      }),
    ).rejects.toThrow();
  });

  it("surfaces its bounded request timeout with a stable safe code", async () => {
    const pending = discoverRssWebsite("https://example.com", {
      request: async () => await new Promise<never>(() => undefined),
      timeoutMs: 1,
    });

    await expect(pending).rejects.toEqual(
      expect.objectContaining({ code: "network-timeout" }),
    );
  });

  it("surfaces non-timeout transport failures without private details", async () => {
    const result = discoverRssWebsite("https://example.com", {
      request: async () => {
        throw new Error("private upstream detail");
      },
    });

    await expect(result).rejects.toMatchObject({
      code: "network-request-failed",
      message: "network-request-failed",
    });
  });
});
