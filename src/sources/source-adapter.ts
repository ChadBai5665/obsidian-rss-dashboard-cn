import type { Feed, FeedItem } from "../types/types";
import type { SourceConfig } from "./source-config";

export interface SourceRefreshContext {
  now: Date;
  signal?: AbortSignal;
  /** Isolated snapshot of the currently persisted feed, when one exists. */
  feed?: Feed;
}

export interface LinkedPageGroupData {
  url: string;
  postCount: number;
  authors: string[];
  postIds: string[];
}

export interface SourceRefreshOutput {
  feed: Feed;
  items: FeedItem[];
  providerRequestCount: number;
  warnings: string[];
  /** Complete items fetched in this run, before the feed cache is retained. */
  collectionItems?: FeedItem[];
  linkedPageGroups?: LinkedPageGroupData[];
}

export interface SourceAdapter<TConfig extends SourceConfig> {
  kind: TConfig["kind"];
  refresh(
    config: TConfig,
    context: SourceRefreshContext,
  ): Promise<SourceRefreshOutput>;
}
