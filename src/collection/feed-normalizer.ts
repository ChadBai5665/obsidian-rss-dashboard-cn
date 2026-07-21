import { createHash } from "crypto";
import type { Feed, FeedItem } from "../types/types";
import type { CollectedItem, SourceType } from "./collected-item";
import { canonicalizeUrl, createCollectedItemId } from "./item-identity";

const SOURCE_TYPES = new Set<SourceType>([
  "rss",
  "atom",
  "json",
  "podcast",
  "website",
  "youtube",
  "x-account",
  "x-topic",
]);

type FeedWithOptionalSourceType = Feed & { sourceType?: unknown };
type FeedItemWithMetrics = FeedItem & { metrics?: unknown };

export function normalizeFeedItem(
  feed: Feed,
  item: FeedItem,
  now: Date,
): CollectedItem {
  const sourceId = feed.feedId || feed.url;
  const sourceType = resolveSourceType(feed, item);
  const timestamp = now.toISOString();
  const author = nonEmpty(item.author) ?? nonEmpty(feed.author);
  const publishedAt = nonEmpty(item.pubDate);
  const guid = nonEmpty(item.guid);
  const url = canonicalizeUrl(item.link);

  const id = isStableItemId(item.rssDashboardId)
    ? item.rssDashboardId
    : createCollectedItemId({
        sourceId,
        guid,
        url: item.link,
        title: item.title,
        author,
        publishedAt,
      });
  item.rssDashboardId = id;

  return {
    schemaVersion: 1,
    id,
    sourceType,
    sourceId,
    sourceName: feed.title,
    sourceBucket: feed.folder,
    title: item.title,
    author,
    publishedAt,
    fetchedAt: timestamp,
    firstSeenAt: timestamp,
    lastSeenAt: timestamp,
    url: nonEmpty(url),
    guid,
    observationType: "new",
    topics: uniqueTopicNames(item),
    excerpt: normalizeFeedItemExcerpt(item),
    contentBasis: sourceType === "youtube" ? "title-description" : "feed",
    metrics: normalizeFeedItemMetrics(item),
    read: item.read ?? false,
    starred: item.starred ?? false,
    saved: item.saved ?? false,
    savedNotePath: nonEmpty(item.savedFilePath),
    collectionStatus: "collected",
  };
}

function isStableItemId(value: string | undefined): value is string {
  return value !== undefined && /^[a-f0-9]{64}$/.test(value);
}

export function normalizeFeedItemExcerpt(
  item: FeedItem,
): string | undefined {
  return nonEmpty(item.summary) ?? nonEmpty(item.description);
}

export function normalizeFeedItemMetrics(
  item: FeedItem,
): Record<string, number> | undefined {
  const value = (item as FeedItemWithMetrics).metrics;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const metrics = Object.entries(value).filter(
    (entry): entry is [string, number] =>
      typeof entry[1] === "number" && Number.isFinite(entry[1]),
  );
  return metrics.length > 0 ? Object.fromEntries(metrics) : undefined;
}

export function createFeedItemMaterialFingerprint(item: FeedItem): string {
  const metrics = normalizeFeedItemMetrics(item);
  return createHash("sha256")
    .update(
      JSON.stringify({
        title: item.title,
        excerpt: normalizeFeedItemExcerpt(item),
        content: nonEmpty(item.content),
        publishedAt: nonEmpty(item.pubDate),
        metrics: metrics
          ? Object.entries(metrics).sort(([left], [right]) =>
              left.localeCompare(right),
            )
          : undefined,
      }),
    )
    .digest("hex");
}

function resolveSourceType(feed: Feed, item: FeedItem): SourceType {
  const declaredSourceType = (feed as FeedWithOptionalSourceType).sourceType;
  if (
    typeof declaredSourceType === "string" &&
    SOURCE_TYPES.has(declaredSourceType as SourceType)
  ) {
    return declaredSourceType as SourceType;
  }

  if (feed.mediaType === "podcast" || item.mediaType === "podcast") {
    return "podcast";
  }

  if (
    feed.mediaType === "video" ||
    item.mediaType === "video" ||
    Boolean(item.videoId) ||
    isYouTubeUrl(feed.url) ||
    isYouTubeUrl(item.link) ||
    isYouTubeUrl(item.videoUrl) ||
    isYouTubeUrl(item.guid)
  ) {
    return "youtube";
  }

  return "rss";
}

function isYouTubeUrl(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "youtu.be" || hostname === "youtube.com" || hostname.endsWith(".youtube.com");
  } catch {
    return false;
  }
}

function uniqueTopicNames(item: FeedItem): string[] {
  const topics = new Set<string>();

  for (const tag of item.tags ?? []) {
    const topic = nonEmpty(tag.name);
    if (topic) {
      topics.add(topic);
    }
  }

  return Array.from(topics);
}

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}
