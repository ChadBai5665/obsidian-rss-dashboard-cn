import { describe, expect, it } from "vitest";
import { parseFeedPreviewFromXmlText } from "../../../../src/services/feed-parser/feed-preview.js";

describe("feed preview parsing", () => {
  it("escapes bare ampersands so preview detects entries", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Example Feed</title>
    <description>AI & Data Science</description>
    <link>https://example.com</link>
    <item>
      <title>First</title>
      <link>https://example.com/first</link>
      <guid>https://example.com/first</guid>
      <pubDate>Fri, 13 Mar 2026 12:45:44 GMT</pubDate>
      <description>Hello</description>
    </item>
  </channel>
</rss>`;

    const parsed = parseFeedPreviewFromXmlText(xml, "https://example.com/rss.xml");
    expect(parsed).not.toBeNull();
    expect(parsed?.title).toBe("Example Feed");
    expect(parsed?.format).toBe("rss");
    expect(parsed?.hasEntries).toBe(true);
    expect(parsed?.latestTitle).toBe("First");
    expect(parsed?.latestPubDate).toContain("2026");
  });

  it.each([
    [
      "atom",
      `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Research</title><entry><title>Atom entry</title><updated>2026-07-27T10:00:00Z</updated></entry></feed>`,
      "Atom entry",
      "2026-07-27T10:00:00Z",
    ],
    [
      "json",
      JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "JSON updates",
        items: [
          {
            id: "first",
            title: "JSON entry",
            date_published: "2026-07-27T11:00:00Z",
          },
        ],
      }),
      "JSON entry",
      "2026-07-27T11:00:00Z",
    ],
  ])(
    "parses the latest entry from a %s feed",
    (format, text, latestTitle, latestPubDate) => {
      const parsed = parseFeedPreviewFromXmlText(
        text,
        "https://example.com/feed",
      );

      expect(parsed).toMatchObject({
        format,
        latestTitle,
        latestPubDate,
        hasEntries: true,
      });
    },
  );

  it("returns null for empty xml text", () => {
    expect(parseFeedPreviewFromXmlText("", "https://example.com/feed.xml")).toBeNull();
  });

  it("rejects an unsupported JSON Feed version URL", () => {
    const parsed = parseFeedPreviewFromXmlText(
      JSON.stringify({
        version: "https://jsonfeed.org/version/not-supported",
        title: "Not a feed",
        items: [{ id: "not-an-entry", title: "Ignored" }],
      }),
      "https://example.com/feed.json",
    );

    expect(parsed).toBeNull();
  });
});
