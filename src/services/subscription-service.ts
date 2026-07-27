import { applyFeedRetentionLimits } from "./feed-parser";
import type { RssWebsiteVerification } from "./source-verification/rss-website-discovery";
import type { YouTubeChannelVerification } from "./source-verification/youtube-channel-resolver";
import {
  filterItemsForInitialImport,
  normalizeInitialImportPolicy,
  type InitialImportPolicy,
  type InitialImportProgress,
} from "../sources/initial-import-policy";
import {
  createXAccountSourceConfig,
  normalizeXAccountSourceConfig,
  normalizeXHandle,
} from "../sources/source-config";
import type { XProfile } from "../sources/tikhub/x-profile";
import type {
  Feed,
  FeedItem,
  FeedKeywordRulesSettings,
} from "../types/types";

export interface SubscriptionPreferences {
  displayName?: string;
  folder?: string;
  tags: string[];
  initialImportPolicy: InitialImportPolicy;
  /** Set only after the verification UI's explicit empty-feed warning. */
  acceptedEmptyFeedWarning?: boolean;
  autoDeleteDuration?: number;
  maxItemsLimit?: number;
  scanInterval?: number;
  keywordRules?: FeedKeywordRulesSettings;
  customTemplate?: string;
  excludeFromRefresh?: boolean;
  mediaType?: "article" | "video" | "podcast";
}

export type VerifiedFeedSubscriptionRequest =
  | ({
      kind: "rss-website";
      verification: RssWebsiteVerification;
      selectedCandidateUrl: string;
    } & SubscriptionPreferences)
  | ({
      kind: "youtube";
      verification: YouTubeChannelVerification;
    } & SubscriptionPreferences);

export type VerifiedXSubscriptionRequest = {
  kind: "x-account";
  profile: XProfile;
  includeReplies: boolean;
  includeReposts: boolean;
  /** Required when the paid X all-history option was explicitly confirmed. */
  confirmedAllAvailable?: boolean;
} & SubscriptionPreferences;

export type VerifiedSubscriptionRequest =
  | VerifiedFeedSubscriptionRequest
  | VerifiedXSubscriptionRequest;

export type SubscriptionServiceErrorCode =
  | "duplicate-subscription"
  | "invalid-subscription-request"
  | "subscription-not-found"
  | "purge-confirmation-required";

export class SubscriptionServiceError extends Error {
  constructor(readonly code: SubscriptionServiceErrorCode) {
    super(code);
    this.name = "SubscriptionServiceError";
  }
}

const confirmedPurges = new WeakSet<object>();

export class ConfirmedCollectionPurge {
  private constructor(readonly feedId: string) {
    confirmedPurges.add(this);
    Object.freeze(this);
  }

  static create(feedId: string): ConfirmedCollectionPurge {
    if (!feedId.trim()) {
      throw new SubscriptionServiceError("purge-confirmation-required");
    }
    return new ConfirmedCollectionPurge(feedId);
  }

  matches(feedId: string): boolean {
    return confirmedPurges.has(this) && this.feedId === feedId;
  }
}

export function createConfirmedCollectionPurge(
  feedId: string,
): ConfirmedCollectionPurge {
  return ConfirmedCollectionPurge.create(feedId);
}

export type RemoveSubscriptionOptions =
  | { purgeCollection: false }
  | {
      purgeCollection: true;
      confirmation: ConfirmedCollectionPurge;
    };

interface SubscriptionSettingsPort {
  feeds: Feed[];
}

interface CollectionServicePort {
  collectFeedRefresh(input: {
    feed: Feed;
    previousItems: FeedItem[];
    refreshedItems: FeedItem[];
    fetchedAt: Date;
  }): Promise<unknown>;
  removeSource(sourceId: string): Promise<unknown>;
}

export interface SubscriptionServiceDependencies {
  settings: SubscriptionSettingsPort;
  defaults: {
    autoDeleteDuration: number;
    maxItems: number;
  };
  parseFeed(url: string, seed: Feed): Promise<Feed>;
  collectionService: CollectionServicePort;
  ensureFolder(folder: string): Promise<unknown>;
  saveSettings(): Promise<void>;
  now?: () => Date;
  createFeedId?: () => string;
  prepareFeed?: (feed: Feed) => Feed;
}

export class SubscriptionService {
  private readonly now: () => Date;
  private readonly createFeedId: () => string;

  constructor(private readonly dependencies: SubscriptionServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.createFeedId = dependencies.createFeedId ?? createFeedId;
  }

  async add(request: VerifiedSubscriptionRequest): Promise<Feed> {
    const key = requestKey(request);
    if (this.hasDuplicate(key)) {
      throw new SubscriptionServiceError("duplicate-subscription");
    }
    const feedId = this.uniqueFeedId();
    if (request.kind === "x-account") {
      const feed = this.buildXFeed(request, feedId);
      if (feed.folder) await this.dependencies.ensureFolder(feed.folder);
      this.assertPublicationAvailable(request, feedId);
      await this.commitFeeds([
        ...cloneFeeds(this.dependencies.settings.feeds),
        feed,
      ]);
      return feed;
    }
    return await this.addFeedSubscription(request, feedId);
  }

  async update(
    feedId: string,
    request: VerifiedSubscriptionRequest,
  ): Promise<Feed> {
    const index = this.feedIndex(feedId);
    const previous = this.dependencies.settings.feeds[index];
    const key = requestKey(request);
    if (this.hasDuplicate(key, feedId)) {
      throw new SubscriptionServiceError("duplicate-subscription");
    }
    if (existingFeedKey(previous) !== key) {
      throw new SubscriptionServiceError("invalid-subscription-request");
    }

    const policy = validPolicy(request.initialImportPolicy);
    const folder = normalizedFolder(request.folder);
    let updated: Feed;
    if (request.kind === "x-account") {
      const replacement = this.buildXFeed(request, feedId);
      updated = {
        ...replacement,
        items: previous.items,
        lastUpdated: previous.lastUpdated,
        initialImportPolicy: policy,
        initialImportProgress: previous.initialImportProgress,
        subscriptionStatus: previous.subscriptionStatus ?? "active",
      };
    } else {
      updated = {
        ...previous,
        title: normalizedTitle(request.displayName) ?? previous.title,
        folder,
        customTags: [...request.tags],
        initialImportPolicy: policy,
      };
    }
    if (folder) await this.dependencies.ensureFolder(folder);
    const candidate = cloneFeeds(this.dependencies.settings.feeds);
    candidate[index] = updated;
    await this.commitFeeds(candidate);
    return updated;
  }

  async setPaused(feedId: string, paused: boolean): Promise<Feed> {
    return await this.updateFeed(feedId, (feed) => ({
      ...feed,
      subscriptionStatus: paused ? "paused" : "active",
    }));
  }

  async stopInitialImport(feedId: string): Promise<Feed> {
    return await this.updateImportStatus(feedId, "stopped");
  }

  async resumeInitialImport(feedId: string): Promise<Feed> {
    const feed = this.dependencies.settings.feeds[this.feedIndex(feedId)];
    if (feed.sourceKind === undefined || feed.sourceKind === "feed") {
      return await this.resumeFeedImport(feedId, feed);
    }
    return await this.updateImportStatus(feedId, "pending");
  }

  async remove(
    feedId: string,
    options: RemoveSubscriptionOptions,
  ): Promise<void> {
    const index = this.feedIndex(feedId);
    if (
      options.purgeCollection &&
      (!(options.confirmation instanceof ConfirmedCollectionPurge) ||
        !options.confirmation.matches(feedId))
    ) {
      throw new SubscriptionServiceError("purge-confirmation-required");
    }

    const candidate = cloneFeeds(this.dependencies.settings.feeds);
    candidate.splice(index, 1);
    await this.commitFeeds(candidate);
    if (options.purgeCollection) {
      await this.dependencies.collectionService.removeSource(feedId);
    }
  }

  private async addFeedSubscription(
    request: VerifiedFeedSubscriptionRequest,
    feedId: string,
  ): Promise<Feed> {
    const verified = verifiedFeedDetails(request);
    if (!verified.hasEntries && request.acceptedEmptyFeedWarning !== true) {
      throw new SubscriptionServiceError("invalid-subscription-request");
    }
    const policy = validPolicy(request.initialImportPolicy);
    const now = this.now();
    const folder = normalizedFolder(request.folder);
    const autoDeleteDuration = numberOrDefault(
      request.autoDeleteDuration,
      this.dependencies.defaults.autoDeleteDuration,
    );
    const maxItemsLimit = numberOrDefault(
      request.maxItemsLimit,
      this.dependencies.defaults.maxItems,
    );
    const seed: Feed = {
      feedId,
      sourceKind: "feed",
      sourceConfig: { kind: "feed" },
      title: normalizedTitle(request.displayName) ?? verified.title,
      url: verified.feedUrl,
      siteUrl: verified.siteUrl,
      folder,
      items: [],
      lastUpdated: now.getTime(),
      mediaType: request.kind === "youtube" ? "video" : request.mediaType ?? "article",
      autoDeleteDuration: 0,
      maxItemsLimit: 0,
      scanInterval: request.scanInterval ?? 0,
      excludeFromRefresh: request.excludeFromRefresh === true,
      customTemplate: request.customTemplate || undefined,
      customTags: [...request.tags],
      keywordRules: request.keywordRules ?? {
        overrideGlobalRules: false,
        includeLogic: "AND",
        rules: [],
      },
      subscriptionStatus: "active",
      initialImportPolicy: policy,
      initialImportProgress: initialProgress("pending"),
    };
    const parsed = await this.dependencies.parseFeed(verified.feedUrl, seed);
    const selected = filterItemsForInitialImport(parsed.items ?? [], policy, now);
    const pending = this.prepareFeed({
      ...parsed,
      feedId,
      sourceKind: "feed",
      sourceConfig: { kind: "feed" },
      title: normalizedTitle(request.displayName) ?? parsed.title ?? verified.title,
      url: verified.feedUrl,
      siteUrl: verified.siteUrl,
      folder,
      items: selected,
      mediaType: request.kind === "youtube" ? "video" : parsed.mediaType ?? request.mediaType ?? "article",
      autoDeleteDuration,
      maxItemsLimit,
      scanInterval: request.scanInterval ?? parsed.scanInterval ?? 0,
      excludeFromRefresh:
        request.excludeFromRefresh ?? parsed.excludeFromRefresh ?? false,
      customTemplate: request.customTemplate || parsed.customTemplate,
      customTags: [...request.tags],
      keywordRules: request.keywordRules ?? parsed.keywordRules ?? seed.keywordRules,
      subscriptionStatus: "active",
      initialImportPolicy: policy,
      initialImportProgress: initialProgress("pending"),
    });

    if (folder) await this.dependencies.ensureFolder(folder);
    this.assertPublicationAvailable(request, feedId);
    await this.commitFeeds([
      ...cloneFeeds(this.dependencies.settings.feeds),
      pending,
    ]);

    try {
      await this.dependencies.collectionService.collectFeedRefresh({
        feed: pending,
        previousItems: [],
        refreshedItems: selected,
        fetchedAt: now,
      });
    } catch (error) {
      const failed = {
        ...pending,
        initialImportProgress: initialProgress("failed"),
      };
      await this.replacePublishedFeed(feedId, failed);
      throw error;
    }

    const progress: InitialImportProgress = {
      status: "completed",
      pagesFetched: 1,
      itemsImported: selected.length,
      ...(earliestPublishedAt(selected)
        ? { earliestImportedAt: earliestPublishedAt(selected) }
        : {}),
    };
    const completed = applyFeedRetentionLimits(
      { ...pending, initialImportProgress: progress },
      { nowMs: now.getTime() },
    );
    await this.replacePublishedFeed(feedId, completed);
    return completed;
  }

  private buildXFeed(
    request: VerifiedXSubscriptionRequest,
    feedId: string,
  ): Feed {
    const policy = validPolicy(request.initialImportPolicy);
    if (policy.mode === "all-available" && request.confirmedAllAvailable !== true) {
      throw new SubscriptionServiceError("invalid-subscription-request");
    }
    const handle = normalizeXHandle(request.profile.handle);
    if (!handle || !request.profile.restId.trim()) {
      throw new SubscriptionServiceError("invalid-subscription-request");
    }
    const folder = normalizedFolder(request.folder);
    const sourceConfig = createXAccountSourceConfig({
      id: feedId,
      handle,
      displayName: normalizedTitle(request.displayName) ?? request.profile.displayName,
      includeReplies: request.includeReplies,
      includeReposts: request.includeReposts,
      folder,
      topics: request.tags,
    });
    return {
      feedId,
      sourceKind: "x-account",
      sourceConfig,
      title: sourceConfig.displayName ?? `@${handle}`,
      url: `tikhub://x-account/${handle}`,
      folder,
      items: [],
      lastUpdated: 0,
      author: sourceConfig.displayName ?? `@${handle}`,
      mediaType: "article",
      customTags: [...request.tags],
      subscriptionStatus: "active",
      initialImportPolicy: policy,
      initialImportProgress: initialProgress("pending"),
    };
  }

  private prepareFeed(feed: Feed): Feed {
    return this.dependencies.prepareFeed?.(feed) ?? feed;
  }

  private assertPublicationAvailable(
    request: VerifiedSubscriptionRequest,
    feedId: string,
  ): void {
    if (this.hasDuplicate(requestKey(request))) {
      throw new SubscriptionServiceError("duplicate-subscription");
    }
    if (this.dependencies.settings.feeds.some((feed) => feed.feedId === feedId)) {
      throw new SubscriptionServiceError("invalid-subscription-request");
    }
  }

  private hasDuplicate(key: string, excludedFeedId?: string): boolean {
    return this.dependencies.settings.feeds.some(
      (feed) =>
        (feed.feedId ?? feed.url) !== excludedFeedId &&
        existingFeedKey(feed) === key,
    );
  }

  private uniqueFeedId(): string {
    const feedId = this.createFeedId().normalize("NFC").trim().toLowerCase();
    if (
      !/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(feedId) ||
      this.dependencies.settings.feeds.some((feed) => feed.feedId === feedId)
    ) {
      throw new SubscriptionServiceError("invalid-subscription-request");
    }
    return feedId;
  }

  private feedIndex(feedId: string): number {
    const index = this.dependencies.settings.feeds.findIndex(
      (feed) => (feed.feedId ?? feed.url) === feedId,
    );
    if (index < 0) {
      throw new SubscriptionServiceError("subscription-not-found");
    }
    return index;
  }

  private async updateFeed(
    feedId: string,
    update: (feed: Feed) => Feed,
  ): Promise<Feed> {
    const candidate = cloneFeeds(this.dependencies.settings.feeds);
    const index = candidate.findIndex(
      (feed) => (feed.feedId ?? feed.url) === feedId,
    );
    if (index < 0) {
      throw new SubscriptionServiceError("subscription-not-found");
    }
    const updated = update(candidate[index]);
    candidate[index] = updated;
    await this.commitFeeds(candidate);
    return updated;
  }

  private async updateImportStatus(
    feedId: string,
    status: "stopped" | "pending",
  ): Promise<Feed> {
    return await this.updateFeed(feedId, (feed) => {
      if (!feed.initialImportProgress) {
        throw new SubscriptionServiceError("invalid-subscription-request");
      }
      return {
        ...feed,
        initialImportProgress: {
          ...feed.initialImportProgress,
          status,
        },
      };
    });
  }

  private async resumeFeedImport(feedId: string, feed: Feed): Promise<Feed> {
    if (!feed.initialImportProgress || !feed.initialImportPolicy) {
      throw new SubscriptionServiceError("invalid-subscription-request");
    }
    const now = this.now();
    const selected = filterItemsForInitialImport(
      feed.items,
      validPolicy(feed.initialImportPolicy),
      now,
    );
    const runningProgress: InitialImportProgress = {
      ...feed.initialImportProgress,
      status: "running",
    };
    const running: Feed = {
      ...feed,
      items: selected,
      initialImportProgress: runningProgress,
    };
    await this.replacePublishedFeed(feedId, running);
    try {
      await this.dependencies.collectionService.collectFeedRefresh({
        feed: running,
        previousItems: [],
        refreshedItems: selected,
        fetchedAt: now,
      });
    } catch (error) {
      await this.replacePublishedFeed(feedId, {
        ...running,
        initialImportProgress: {
          ...runningProgress,
          status: "failed",
        },
      });
      throw error;
    }

    const earliest = earliestPublishedAt(selected);
    const completed = applyFeedRetentionLimits(
      {
        ...running,
        initialImportProgress: {
          status: "completed",
          pagesFetched: Math.max(1, runningProgress.pagesFetched),
          itemsImported: selected.length,
          ...(earliest ? { earliestImportedAt: earliest } : {}),
        },
      },
      { nowMs: now.getTime() },
    );
    await this.replacePublishedFeed(feedId, completed);
    return completed;
  }

  private async replacePublishedFeed(feedId: string, feed: Feed): Promise<void> {
    const candidate = cloneFeeds(this.dependencies.settings.feeds);
    const index = candidate.findIndex(
      (entry) => (entry.feedId ?? entry.url) === feedId,
    );
    if (index < 0) {
      throw new SubscriptionServiceError("subscription-not-found");
    }
    candidate[index] = feed;
    await this.commitFeeds(candidate);
  }

  private async commitFeeds(candidate: Feed[]): Promise<void> {
    const original = this.dependencies.settings.feeds;
    this.dependencies.settings.feeds = candidate;
    try {
      await this.dependencies.saveSettings();
    } catch (error) {
      this.dependencies.settings.feeds = original;
      throw error;
    }
  }
}

function verifiedFeedDetails(request: VerifiedFeedSubscriptionRequest): {
  feedUrl: string;
  siteUrl: string;
  title: string;
  hasEntries: boolean;
} {
  if (request.kind === "youtube") {
    const channelId = request.verification.channelId;
    const expectedFeedUrl =
      `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
    if (
      !/^UC[A-Za-z0-9_-]{22}$/u.test(channelId) ||
      request.verification.feedUrl !== expectedFeedUrl ||
      request.verification.channelUrl !==
        `https://www.youtube.com/channel/${channelId}`
    ) {
      throw new SubscriptionServiceError("invalid-subscription-request");
    }
    return {
      feedUrl: expectedFeedUrl,
      siteUrl: request.verification.channelUrl,
      title: request.verification.channelName,
      hasEntries: request.verification.hasEntries,
    };
  }

  const selectedUrl = canonicalHttpUrl(request.selectedCandidateUrl);
  const selected = request.verification.candidates.find(
    (candidate) => canonicalHttpUrl(candidate.url) === selectedUrl,
  );
  if (!selected) {
    throw new SubscriptionServiceError("invalid-subscription-request");
  }
  return {
    feedUrl: selectedUrl,
    siteUrl: canonicalHttpUrl(request.verification.siteUrl),
    title: selected.title,
    hasEntries: request.verification.hasEntries,
  };
}

function requestKey(request: VerifiedSubscriptionRequest): string {
  if (request.kind === "x-account") {
    const handle = normalizeXHandle(request.profile.handle);
    if (!handle) {
      throw new SubscriptionServiceError("invalid-subscription-request");
    }
    return `x:${handle}`;
  }
  if (request.kind === "youtube") {
    verifiedFeedDetails(request);
    return `youtube:${request.verification.channelId}`;
  }
  const feedUrl = verifiedFeedDetails(request).feedUrl;
  const channelId = youtubeChannelId(feedUrl);
  return channelId ? `youtube:${channelId}` : `feed:${feedUrl}`;
}

function existingFeedKey(feed: Feed): string {
  const account = normalizeXAccountSourceConfig(feed.sourceConfig);
  if (feed.sourceKind === "x-account" && account) {
    return `x:${account.handle}`;
  }
  if (feed.sourceKind === "x-topic") {
    return `source:x-topic:${feed.feedId ?? feed.url}`;
  }
  const channelId = youtubeChannelId(feed.url);
  const canonical = tryCanonicalHttpUrl(feed.url);
  return channelId
    ? `youtube:${channelId}`
    : `feed:${canonical ?? feed.url.normalize("NFC").trim()}`;
}

function youtubeChannelId(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      url.hostname.toLowerCase() !== "www.youtube.com" ||
      url.pathname !== "/feeds/videos.xml"
    ) {
      return undefined;
    }
    const channelId = url.searchParams.get("channel_id") ?? "";
    return /^UC[A-Za-z0-9_-]{22}$/u.test(channelId) ? channelId : undefined;
  } catch {
    return undefined;
  }
}

function canonicalHttpUrl(value: string): string {
  const canonical = tryCanonicalHttpUrl(value);
  if (canonical) return canonical;
  throw new SubscriptionServiceError("invalid-subscription-request");
}

function tryCanonicalHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("unsupported protocol");
    }
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

function validPolicy(value: InitialImportPolicy): InitialImportPolicy {
  const policy = normalizeInitialImportPolicy(value);
  if (!policy) {
    throw new SubscriptionServiceError("invalid-subscription-request");
  }
  return policy;
}

function initialProgress(
  status: InitialImportProgress["status"],
): InitialImportProgress {
  return { status, pagesFetched: 0, itemsImported: 0 };
}

function earliestPublishedAt(items: readonly FeedItem[]): string | undefined {
  let earliest: string | undefined;
  let earliestMs = Number.POSITIVE_INFINITY;
  for (const item of items) {
    const publishedAt = Date.parse(item.pubDate);
    if (Number.isFinite(publishedAt) && publishedAt < earliestMs) {
      earliestMs = publishedAt;
      earliest = item.pubDate;
    }
  }
  return earliest;
}

function numberOrDefault(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizedFolder(value: string | undefined): string {
  return value?.normalize("NFC").trim() ?? "";
}

function normalizedTitle(value: string | undefined): string | undefined {
  const normalized = value?.normalize("NFC").trim();
  return normalized || undefined;
}

function cloneFeeds(feeds: readonly Feed[]): Feed[] {
  return [...structuredClone(feeds)];
}

function createFeedId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `feed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
