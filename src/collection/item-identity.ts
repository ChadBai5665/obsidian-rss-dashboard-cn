import { createHash } from "crypto";
import type { Feed, FeedItem } from "../types/types";

const TRACKING_PARAMETER_NAMES = new Set(["fbclid", "gclid"]);

export function canonicalizeUrl(rawUrl: string): string {
  let parsed: URL;

  try {
    parsed = new URL(rawUrl);
  } catch {
    return "";
  }

  parsed.hostname = parsed.hostname.toLowerCase();
  parsed.hash = "";

  if (
    (parsed.protocol === "http:" && parsed.port === "80") ||
    (parsed.protocol === "https:" && parsed.port === "443")
  ) {
    parsed.port = "";
  }

  const parameters = Array.from(parsed.searchParams.entries())
    .filter(([name]) => !isTrackingParameter(name))
    .sort(([leftName, leftValue], [rightName, rightValue]) => {
      if (leftName === rightName) {
        return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
      }

      return leftName < rightName ? -1 : 1;
    });

  parsed.search = "";
  for (const [name, value] of parameters) {
    parsed.searchParams.append(name, value);
  }

  return parsed.toString();
}

export function createCollectedItemId(input: {
  sourceId: string;
  guid?: string;
  url?: string;
  title: string;
  author?: string;
  publishedAt?: string;
}): string {
  const canonicalUrl = input.url ? canonicalizeUrl(input.url) : "";
  const guid = input.guid?.trim();
  const sourceId = normalizeText(input.sourceId);

  const identity = canonicalUrl
    ? ["url", canonicalUrl]
    : guid
      ? ["guid", sourceId, guid]
      : [
          "fallback",
          sourceId,
          normalizeText(input.title),
          normalizeText(input.author ?? ""),
          normalizePublishedAt(input.publishedAt),
        ];

  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

export function createSourceLocator(sourceId: string): string {
  return createHash("sha256").update(sourceId.trim()).digest("hex");
}

/** X IDs are globally stable across account renames and topic rediscovery. */
export function createXPostCollectedItemId(guid: string): string {
  const normalizedGuid = guid.trim();
  if (!/^\d{1,30}$/u.test(normalizedGuid)) {
    throw new Error("Cannot identify an X post without a valid post ID.");
  }
  return createHash("sha256")
    .update(JSON.stringify(["x-post", normalizedGuid]))
    .digest("hex");
}

/** Derives a feed item's canonical ID without reading or mutating a stored ID. */
export function createCanonicalFeedItemId(input: {
  sourceType: string;
  sourceId: string;
  item: Pick<FeedItem, "title" | "link" | "guid" | "author" | "pubDate">;
}): string {
  return input.sourceType === "x-account" || input.sourceType === "x-topic"
    ? createXPostCollectedItemId(input.item.guid)
    : createCollectedItemId({
        sourceId: input.sourceId,
        guid: input.item.guid,
        url: input.item.link,
        title: input.item.title,
        author: input.item.author,
        publishedAt: input.item.pubDate,
      });
}

export function resolveFeedSourceId(
  feed: Pick<Feed, "feedId" | "url">,
): string {
  const sourceId = feed.feedId?.trim() || feed.url?.trim();
  if (!sourceId) {
    throw new Error("Cannot identify an RSS item without a feed ID or URL.");
  }
  return sourceId;
}

export function bindFeedItemSourceIdentity(
  feed: Pick<Feed, "feedId" | "url">,
  item: FeedItem,
): boolean {
  const sourceId = resolveFeedSourceId(feed);
  if (item.rssDashboardSourceId === sourceId) return false;
  item.rssDashboardSourceId = sourceId;
  return true;
}

export function bindFeedItemsToSourceIdentity(feed: Feed): boolean {
  let didChange = false;
  for (const item of feed.items ?? []) {
    didChange = bindFeedItemSourceIdentity(feed, item) || didChange;
  }
  return didChange;
}

/** Transitional support for a detached pre-migration item in reader UIs. */
export function bindDetachedItemSourceIdentity(item: FeedItem): boolean {
  if (item.rssDashboardSourceId?.trim()) return false;
  const sourceId = item.feedUrl?.trim();
  if (!sourceId) {
    throw new Error("Detached RSS item is missing its feed URL.");
  }
  item.rssDashboardSourceId = sourceId;
  return true;
}

export function resolveFeedItemStableId(item: FeedItem): string {
  if (item.rssDashboardId !== undefined) {
    if (!isStableItemId(item.rssDashboardId)) {
      throw new Error("Invalid RSS Dashboard item ID.");
    }
    return item.rssDashboardId;
  }

  const sourceId = item.rssDashboardSourceId?.trim();
  if (!sourceId) {
    throw new Error("RSS item is missing its durable feed identity.");
  }
  const itemId = createCollectedItemId({
    sourceId,
    guid: item.guid,
    url: item.link,
    title: item.title,
    author: item.author,
    publishedAt: item.pubDate,
  });
  item.rssDashboardId = itemId;
  return itemId;
}

export function isStableItemId(value: string | undefined): value is string {
  return value !== undefined && /^[a-f0-9]{64}$/.test(value);
}

function isTrackingParameter(name: string): boolean {
  const normalizedName = name.toLowerCase();
  return (
    normalizedName.startsWith("utm_") ||
    TRACKING_PARAMETER_NAMES.has(normalizedName)
  );
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizePublishedAt(value: string | undefined): string {
  if (!value) {
    return "";
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? normalizeText(value)
    : parsed.toISOString();
}
