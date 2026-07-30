import type {
  ContentBasis,
  SourceType,
  XPostSourceMetadata,
} from "../../collection/collected-item";
import type { Feed, FeedItem } from "../../types/types";
import { createXPostCollectedItemId } from "../../collection/item-identity";
import {
  sourceConfigUrl,
  type XAccountSourceConfig,
  type XTopicSourceConfig,
} from "../source-config";
import type { XPost } from "./x-post";
import type { XObservationTag } from "./x-search-query";

export interface XAccountFeedItem extends FeedItem {
  contentBasis: Extract<ContentBasis, "x-post">;
  sourceType: Extract<SourceType, "x-account">;
  sourceBucket: string;
  /** Exact provider-neutral post text; render as text, never as markup. */
  plainText: string;
  metrics: XPost["metrics"];
  sourceMetadata: XPostSourceMetadata;
}

export interface XAccountFeed extends Feed {
  sourceType: Extract<SourceType, "x-account">;
  sourceKind: "x-account";
  sourceConfig: XAccountSourceConfig;
  items: XAccountFeedItem[];
}

export interface XAccountFeedMapping {
  feed: XAccountFeed;
  items: XAccountFeedItem[];
}

export interface ObservedXPost {
  post: XPost;
  observationTags: XObservationTag[];
}

export interface XTopicFeedItem extends FeedItem {
  contentBasis: Extract<ContentBasis, "x-post">;
  sourceType: Extract<SourceType, "x-topic">;
  sourceBucket: string;
  plainText: string;
  metrics: XPost["metrics"];
  sourceMetadata: XPostSourceMetadata;
}

export interface XTopicFeed extends Feed {
  sourceType: Extract<SourceType, "x-topic">;
  sourceKind: "x-topic";
  sourceConfig: XTopicSourceConfig;
  items: XTopicFeedItem[];
}

export interface XTopicFeedMapping {
  feed: XTopicFeed;
  items: XTopicFeedItem[];
}

/** Maps already-filtered X posts into the neutral feed pipeline. */
export function mapXAccountPostsToFeed(
  config: XAccountSourceConfig,
  posts: readonly XPost[],
  now: Date,
  previousFeed?: Feed,
): XAccountFeedMapping {
  const feedUrl = sourceConfigUrl(config);
  if (!feedUrl) throw new Error("Invalid X account source configuration");
  const feedTitle = config.displayName ?? `@${config.handle}`;
  const currentItems = [...posts]
    .sort(compareXPosts)
    .map((post) => mapPost(config, post, feedTitle, feedUrl));
  const items = mergeXAccountFeedItems(previousFeed?.items ?? [], currentItems);
  const sourceConfig: XAccountSourceConfig = {
    ...config,
    topics: [...config.topics],
  };
  const feed: XAccountFeed = {
    ...previousFeed,
    feedId: config.id,
    sourceKind: "x-account",
    sourceConfig,
    sourceType: "x-account",
    title: feedTitle,
    url: feedUrl,
    folder: config.folder,
    items,
    lastUpdated: now.getTime(),
    author: feedTitle,
    mediaType: "article",
  };
  return { feed, items: currentItems };
}

function mergeXAccountFeedItems(
  previousItems: readonly FeedItem[],
  currentItems: readonly XAccountFeedItem[],
): XAccountFeedItem[] {
  const merged = new Map<string, XAccountFeedItem>();
  for (const item of previousItems) {
    if (/^\d{1,30}$/u.test(item.guid)) {
      merged.set(item.guid, cloneFeedItem(item) as XAccountFeedItem);
    }
  }
  for (const item of currentItems) {
    const previous = merged.get(item.guid);
    merged.set(item.guid, {
      ...previous,
      ...cloneFeedItem(item),
      ...(previous?.read === undefined ? {} : { read: previous.read }),
      ...(previous?.starred === undefined ? {} : { starred: previous.starred }),
      ...(previous?.saved === undefined ? {} : { saved: previous.saved }),
      ...(previous?.savedFilePath === undefined
        ? {}
        : { savedFilePath: previous.savedFilePath }),
    } as XAccountFeedItem);
  }
  return [...merged.values()].sort(compareFeedItems);
}

function cloneFeedItem(item: FeedItem): FeedItem {
  return {
    ...item,
    ...(item.tags ? { tags: item.tags.map((tag) => ({ ...tag })) } : {}),
  };
}

function compareFeedItems(left: FeedItem, right: FeedItem): number {
  const leftTime = Date.parse(left.pubDate);
  const rightTime = Date.parse(right.pubDate);
  const normalizedLeft = Number.isFinite(leftTime) ? leftTime : Number.NEGATIVE_INFINITY;
  const normalizedRight = Number.isFinite(rightTime) ? rightTime : Number.NEGATIVE_INFINITY;
  if (normalizedLeft !== normalizedRight) return normalizedRight - normalizedLeft;
  return compareDecimalIdsDescending(left.guid, right.guid);
}

/** Maps observed topic posts without adding a score or recommendation. */
export function mapXTopicPostsToFeed(
  config: XTopicSourceConfig,
  observedPosts: readonly ObservedXPost[],
  now: Date,
): XTopicFeedMapping {
  const feedUrl = sourceConfigUrl(config);
  if (!feedUrl) throw new Error("Invalid X topic source configuration");
  const items = [...observedPosts]
    .sort((left, right) => compareXPosts(left.post, right.post))
    .map(({ post, observationTags }) =>
      mapTopicPost(config, post, observationTags, feedUrl),
    );
  const sourceConfig: XTopicSourceConfig = {
    ...config,
    includeKeywords: [...config.includeKeywords],
    excludeKeywords: [...config.excludeKeywords],
    priorityAccounts: [...config.priorityAccounts],
  };
  const feed: XTopicFeed = {
    feedId: config.id,
    sourceKind: "x-topic",
    sourceConfig,
    sourceType: "x-topic",
    title: config.name,
    url: feedUrl,
    folder: config.folder,
    items,
    lastUpdated: now.getTime(),
    author: config.name,
    mediaType: "article",
  };
  return { feed, items };
}

function mapPost(
  config: XAccountSourceConfig,
  post: XPost,
  feedTitle: string,
  feedUrl: string,
): XAccountFeedItem {
  const plainText = repairUnpairedSurrogates(post.text);
  const safeMarkup = escapeHtml(plainText);
  const canonicalUrl = `https://x.com/${config.handle}/status/${post.id}`;
  const title = truncateCodePoints(sanitizeTitle(plainText), 120) ||
    `@${config.handle} · ${post.id}`;

  return {
    rssDashboardId: createXPostCollectedItemId(post.id),
    title,
    link: canonicalUrl,
    description: safeMarkup,
    content: safeMarkup,
    plainText,
    pubDate: post.createdAt ?? "",
    guid: post.id,
    feedTitle,
    feedUrl,
    coverImage: "",
    author: post.authorName ?? `@${post.authorHandle}`,
    tags: config.topics.map((name) => ({ name, color: "" })),
    contentBasis: "x-post",
    sourceType: "x-account",
    sourceBucket: config.folder,
    metrics: normalizeMetrics(post.metrics),
    sourceMetadata: {
      kind: "x-post",
      ...(post.conversationId ? { conversationId: post.conversationId } : {}),
      ...(post.inReplyToId ? { inReplyToId: post.inReplyToId } : {}),
      ...(post.repostOfId ? { repostOfId: post.repostOfId } : {}),
      ...(post.quoteOfId ? { quoteOfId: post.quoteOfId } : {}),
      externalUrls: [...post.externalUrls],
    },
  };
}

function mapTopicPost(
  config: XTopicSourceConfig,
  post: XPost,
  observationTags: XObservationTag[],
  feedUrl: string,
): XTopicFeedItem {
  const plainText = repairUnpairedSurrogates(post.text);
  const safeMarkup = escapeHtml(plainText);
  const canonicalUrl = `https://x.com/${post.authorHandle}/status/${post.id}`;
  const title = truncateCodePoints(sanitizeTitle(plainText), 120) ||
    `@${post.authorHandle} · ${post.id}`;

  return {
    rssDashboardId: createXPostCollectedItemId(post.id),
    title,
    link: canonicalUrl,
    description: safeMarkup,
    content: safeMarkup,
    plainText,
    pubDate: post.createdAt ?? "",
    guid: post.id,
    feedTitle: config.name,
    feedUrl,
    coverImage: "",
    author: post.authorName ?? `@${post.authorHandle}`,
    tags: [{ name: config.name, color: "" }],
    contentBasis: "x-post",
    sourceType: "x-topic",
    sourceBucket: config.folder,
    metrics: normalizeMetrics(post.metrics),
    sourceMetadata: {
      kind: "x-post",
      ...(post.conversationId ? { conversationId: post.conversationId } : {}),
      ...(post.inReplyToId ? { inReplyToId: post.inReplyToId } : {}),
      ...(post.repostOfId ? { repostOfId: post.repostOfId } : {}),
      ...(post.quoteOfId ? { quoteOfId: post.quoteOfId } : {}),
      externalUrls: [...post.externalUrls],
      observationTags: [...observationTags],
    },
  };
}

function repairUnpairedSurrogates(text: string): string {
  let result = "";
  for (let index = 0; index < text.length; index += 1) {
    const first = text.charCodeAt(index);
    let codePoint: number;
    if (first >= 0xd800 && first <= 0xdbff) {
      const second = text.charCodeAt(index + 1);
      if (second < 0xdc00 || second > 0xdfff) {
        result += "�";
        continue;
      }
      codePoint = (first - 0xd800) * 0x400 + (second - 0xdc00) + 0x10000;
      index += 1;
    } else if (first >= 0xdc00 && first <= 0xdfff) {
      result += "�";
      continue;
    } else {
      codePoint = first;
    }
    result += String.fromCodePoint(codePoint);
  }
  return result;
}

function sanitizeTitle(text: string): string {
  let result = "";
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && !isDangerousTitleFormatControl(codePoint)) {
      result += character;
    }
  }
  return result.replace(/\s+/gu, " ").trim();
}

function isDangerousTitleFormatControl(codePoint: number): boolean {
  return (
    codePoint === 0x00ad ||
    codePoint === 0x061c ||
    codePoint === 0x180e ||
    codePoint === 0x200b ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2060 && codePoint <= 0x206f) ||
    codePoint === 0xfeff ||
    (codePoint >= 0xfff9 && codePoint <= 0xfffb) ||
    (codePoint >= 0x1d173 && codePoint <= 0x1d17a) ||
    codePoint === 0xe0001 ||
    (codePoint >= 0xe0020 && codePoint <= 0xe007f)
  );
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

function truncateCodePoints(text: string, limit: number): string {
  return Array.from(text).slice(0, limit).join("");
}

function normalizeMetrics(metrics: XPost["metrics"]): XPost["metrics"] {
  return Object.fromEntries(
    Object.entries(metrics).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === "number" &&
        Number.isSafeInteger(entry[1]) &&
        entry[1] >= 0,
    ),
  );
}

function compareXPosts(left: XPost, right: XPost): number {
  const timeDifference = sortableTime(right.createdAt) - sortableTime(left.createdAt);
  if (timeDifference !== 0) return timeDifference;
  return compareDecimalIdsDescending(left.id, right.id);
}

function sortableTime(value: string | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function compareDecimalIdsDescending(left: string, right: string): number {
  const normalizedLeft = left.replace(/^0+(?=\d)/u, "");
  const normalizedRight = right.replace(/^0+(?=\d)/u, "");
  if (normalizedLeft.length !== normalizedRight.length) {
    return normalizedRight.length - normalizedLeft.length;
  }
  if (normalizedLeft !== normalizedRight) {
    return normalizedLeft < normalizedRight ? 1 : -1;
  }
  return left < right ? 1 : left > right ? -1 : 0;
}
