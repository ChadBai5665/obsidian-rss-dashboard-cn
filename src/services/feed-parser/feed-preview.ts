import { requestUrl } from "obsidian";
import type {
  FeedPreviewData,
  JsonFeed,
  Rss2JsonResponse,
} from "./types.js";

export type { FeedPreviewData } from "./types.js";

const BARE_AMPERSAND_REGEX =
  /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/g;
export function parseFeedPreviewFromXmlText(
  xmlText: string,
  feedUrl: string,
): FeedPreviewData | null {
  return parseFeedPreviewFromText(xmlText, feedUrl);
}

export function parseFeedPreviewFromText(
  feedText: string,
  feedUrl: string,
): FeedPreviewData | null {
  if (!feedText) return null;

  const jsonPreview = parseJsonFeedPreview(feedText, feedUrl);
  if (jsonPreview) return jsonPreview;

  const sanitizedXmlText = feedText.replace(BARE_AMPERSAND_REGEX, "&amp;");
  const doc = new DOMParser().parseFromString(sanitizedXmlText, "text/xml");

  if (doc.querySelector("parsererror")) {
    return null;
  }
  if (!isFeedDocument(doc)) return null;

  return parseFeedDoc(doc, feedUrl);
}

export async function loadFeedForPreview(
  feedUrl: string,
): Promise<FeedPreviewData> {
  // Try direct request first
  try {
    const response = await requestUrl({
      url: feedUrl,
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept:
          "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
      },
    });

    const preview = parseFeedPreviewFromText(response.text, feedUrl);
    if (preview) return preview;
  } catch {
    // Fall through to rss2json
  }

  // Fallback to rss2json
  const rss2jsonUrl = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(feedUrl)}`;

  try {
    const response = await requestUrl({
      url: rss2jsonUrl,
      method: "GET",
    });

    const data = JSON.parse(response.text) as Rss2JsonResponse;

    if (data.status !== "ok" || !data.feed) {
      throw new Error(data.message || "Failed to load feed");
    }
    return {
      title: data.feed.title || "",
      description: data.feed.description || "",
      link: data.feed.link || "",
      image: data.feed.image || "",
      format: "rss",
      latestTitle: data.items?.[0]?.title || "",
      latestPubDate: data.items?.[0]?.pubDate || "",
      hasEntries: (data.items?.length || 0) > 0,
      feedUrl,
    };
  } catch {
    console.error("[RSS Dashboard] Feed preview request failed.");
    throw new Error("Failed to load feed.");
  }
}

function parseFeedDoc(doc: Document, feedUrl: string): FeedPreviewData {
  const channel = doc.querySelector("channel") || doc.querySelector("feed");
  const title = channel?.querySelector("title")?.textContent || "";
  const description = channel?.querySelector("description")?.textContent || "";
  const link = channel?.querySelector("link")?.textContent || "";
  const imageEl =
    channel?.querySelector("image > url, itunes\\:image")?.textContent ||
    channel?.querySelector("itunes\\:image")?.getAttribute("href") ||
    "";

  const firstItem = doc.querySelector("item, entry");
  const format =
    doc.documentElement.localName.toLowerCase() === "feed" ? "atom" : "rss";
  const latestTitle = firstItem?.querySelector("title")?.textContent || "";
  const latestPubDate =
    firstItem?.querySelector("pubDate, published, updated")?.textContent || "";

  return {
    title,
    description,
    link,
    image: imageEl,
    format,
    latestTitle,
    latestPubDate,
    hasEntries: !!firstItem,
    feedUrl,
  };
}

function parseJsonFeedPreview(
  feedText: string,
  feedUrl: string,
): FeedPreviewData | null {
  let feed: JsonFeed;
  try {
    feed = JSON.parse(feedText) as JsonFeed;
  } catch {
    return null;
  }

  if (!feed.version?.startsWith("https://jsonfeed.org/")) return null;

  const firstItem = feed.items?.[0];
  return {
    title: feed.title || "",
    description: feed.description || "",
    link: feed.home_page_url || "",
    image: feed.icon || "",
    format: "json",
    latestTitle: firstItem?.title || "",
    latestPubDate: firstItem?.date_published || "",
    hasEntries: !!firstItem,
    feedUrl,
  };
}

function isFeedDocument(doc: Document): boolean {
  const rootName = doc.documentElement.localName.toLowerCase();
  return rootName === "rss" || rootName === "feed" || rootName === "rdf";
}
