import type { Feed, FeedItem } from "../types/types";
import type { SourceConfig } from "./source-config";

export interface SourceRefreshContext {
  now: Date;
  signal?: AbortSignal;
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
  linkedPageGroups?: LinkedPageGroupData[];
}

export interface SourceAdapter<TConfig extends SourceConfig> {
  kind: TConfig["kind"];
  refresh(
    config: TConfig,
    context: SourceRefreshContext,
  ): Promise<SourceRefreshOutput>;
}
