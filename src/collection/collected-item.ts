export type SourceType =
  | "rss"
  | "atom"
  | "json"
  | "podcast"
  | "website"
  | "youtube"
  | "x-account"
  | "x-topic";

export type ObservationType = "new" | "updated" | "rediscovered";

export type ContentBasis =
  | "feed"
  | "full-text"
  | "title-description"
  | "x-post"
  | "linked-page";

export type CollectionStatus = "collected" | "partial" | "parse-error";

export interface XObservedSource {
  type: "x-account" | "x-topic";
  id: string;
  bucket: string;
}

export interface XPostSourceMetadata {
  kind: "x-post";
  conversationId?: string;
  inReplyToId?: string;
  repostOfId?: string;
  quoteOfId?: string;
  externalUrls: string[];
  /** Provider observation categories, not plugin quality judgments. */
  observationTags?: Array<"latest" | "platform-top" | "priority-account">;
  /** Every configured X source that observed this post. */
  observedSources?: XObservedSource[];
}

export interface CollectedItem {
  schemaVersion: 1;
  id: string;
  sourceType: SourceType;
  sourceId: string;
  sourceName: string;
  sourceBucket: string;
  title: string;
  author?: string;
  publishedAt?: string;
  fetchedAt: string;
  firstSeenAt: string;
  lastSeenAt: string;
  url?: string;
  guid?: string;
  observationType: ObservationType;
  topics: string[];
  language?: string;
  excerpt?: string;
  contentPath?: string;
  contentBasis: ContentBasis;
  metrics?: Record<string, number>;
  sourceMetadata?: XPostSourceMetadata;
  read: boolean;
  starred: boolean;
  saved: boolean;
  savedNotePath?: string;
  collectionStatus: CollectionStatus;
}
