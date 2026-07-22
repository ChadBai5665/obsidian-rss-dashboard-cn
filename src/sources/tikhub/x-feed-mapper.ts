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
} from "../source-config";
import type { XPost } from "./x-post";

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

/** Maps already-filtered X posts into the neutral feed pipeline. */
export function mapXAccountPostsToFeed(
  config: XAccountSourceConfig,
  posts: readonly XPost[],
  now: Date,
): XAccountFeedMapping {
  const feedUrl = sourceConfigUrl(config);
  if (!feedUrl) throw new Error("Invalid X account source configuration");
  const feedTitle = config.displayName ?? `@${config.handle}`;
  const items = [...posts]
    .sort(compareXPosts)
    .map((post) => mapPost(config, post, feedTitle, feedUrl));
  const sourceConfig: XAccountSourceConfig = {
    ...config,
    topics: [...config.topics],
  };
  const feed: XAccountFeed = {
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
  return { feed, items };
}

function mapPost(
  config: XAccountSourceConfig,
  post: XPost,
  feedTitle: string,
  feedUrl: string,
): XAccountFeedItem {
  const plainText = sanitizePlainText(post.text);
  const safeMarkup = escapeHtml(plainText);
  const canonicalUrl = `https://x.com/${config.handle}/status/${post.id}`;
  const title = truncateCodePoints(plainTextTitle(plainText), 120) ||
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

function plainTextTitle(text: string): string {
  return text
    .replace(/\s+/gu, " ")
    .trim();
}

function sanitizePlainText(text: string): string {
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
    if (!isFormatControl(codePoint)) result += String.fromCodePoint(codePoint);
  }
  return result;
}

function isFormatControl(codePoint: number): boolean {
  return (
    codePoint === 0x00ad ||
    codePoint === 0x061c ||
    codePoint === 0x180e ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
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
