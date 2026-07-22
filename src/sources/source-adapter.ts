import type { Feed, FeedItem } from "../types/types";
import type { SourceConfig } from "./source-config";

export interface SourceRefreshContext {
  now: Date;
  signal?: AbortSignal;
}

export interface SourceRefreshOutput {
  feed: Feed;
  items: FeedItem[];
  providerRequestCount: number;
  warnings: string[];
}

export interface SourceAdapter<TConfig extends SourceConfig> {
  kind: TConfig["kind"];
  refresh(
    config: TConfig,
    context: SourceRefreshContext,
  ): Promise<SourceRefreshOutput>;
}
