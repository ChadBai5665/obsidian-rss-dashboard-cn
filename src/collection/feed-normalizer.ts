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

  return {
    schemaVersion: 1,
    id: createCollectedItemId({
      sourceId,
      guid,
      url: item.link,
      title: item.title,
      author,
      publishedAt,
    }),
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
    excerpt: nonEmpty(item.summary) ?? nonEmpty(item.description),
    contentBasis: sourceType === "youtube" ? "title-description" : "feed",
    read: item.read ?? false,
    starred: item.starred ?? false,
    saved: item.saved ?? false,
    savedNotePath: nonEmpty(item.savedFilePath),
    collectionStatus: "collected",
  };
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
