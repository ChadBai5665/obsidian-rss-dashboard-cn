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
  normalizeXTopicSourceConfig,
} from "../sources/source-config";
import type { XProfile } from "../sources/tikhub/x-profile";
import {
  commitXProfileVerificationReservation,
  releaseXProfileVerificationReservation,
  reserveXProfileVerificationProof,
  type XProfileVerificationProof,
  type XProfileVerificationReservation,
} from "../sources/tikhub/x-profile-resolver";
import type { CollectionRemovalReceipt } from "./collection-service";
import type {
  Feed,
  FeedItem,
  FeedKeywordRulesSettings,
  Folder,
  RssDashboardSettings,
} from "../types/types";
import {
  moveFeedAndInsert,
  moveFeedToFolderAppend,
  moveFolder,
  type FeedInsertPlacement,
  type FolderDropPlacement,
  type FolderOperationResult,
  type OperationResult,
} from "./sidebar-ordering-controller";

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
  verificationProof: XProfileVerificationProof;
  includeReplies: boolean;
  includeReposts: boolean;
  /** Required when the paid X all-history option was explicitly confirmed. */
  confirmedAllAvailable?: boolean;
} & SubscriptionPreferences;

export type VerifiedSubscriptionRequest =
  | VerifiedFeedSubscriptionRequest
  | VerifiedXSubscriptionRequest;

/** Patch-only X settings update. Identity fields are intentionally absent. */
export interface XSubscriptionOptionsUpdateRequest {
  kind: "x-account-options";
  folder?: string;
  tags?: string[];
  initialImportPolicy?: InitialImportPolicy;
  includeReplies?: boolean;
  includeReposts?: boolean;
  autoDeleteDuration?: number;
  maxItemsLimit?: number;
  scanInterval?: number;
  keywordRules?: FeedKeywordRulesSettings;
  customTemplate?: string;
  excludeFromRefresh?: boolean;
  paused?: boolean;
}

/** Patch-only feed settings update. The canonical URL is intentionally absent. */
export interface FeedSubscriptionOptionsUpdateRequest {
  kind: "feed-options";
  displayName?: string;
  folder?: string;
  tags?: string[];
  initialImportPolicy?: InitialImportPolicy;
  autoDeleteDuration?: number;
  maxItemsLimit?: number;
  scanInterval?: number;
  keywordRules?: FeedKeywordRulesSettings;
  customTemplate?: string;
  excludeFromRefresh?: boolean;
  mediaType?: "article" | "video" | "podcast";
  paused?: boolean;
}

export type SubscriptionUpdateRequest =
  | VerifiedSubscriptionRequest
  | XSubscriptionOptionsUpdateRequest
  | FeedSubscriptionOptionsUpdateRequest;

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

export interface SubscriptionSettingsPort {
  feeds: Feed[];
  folders: Folder[];
  collapsedFolders?: string[];
  folderFeedSortOrders?: RssDashboardSettings["folderFeedSortOrders"];
  folderSortOrder?: RssDashboardSettings["folderSortOrder"];
}

export type SidebarOrderingMutationRequest =
  | {
      kind: "feed-insert";
      draggedUrl: string;
      targetUrl: string;
      placement: FeedInsertPlacement;
    }
  | {
      kind: "feed-folder-append";
      draggedUrl: string;
      destinationFolderPath: string;
    }
  | {
      kind: "folder-move";
      draggedPath: string;
      targetPath: string;
      placement: FolderDropPlacement;
    };

export type SidebarOrderingMutationResult =
  | OperationResult
  | FolderOperationResult;

export type SubscriptionFolderMutationRequest =
  | {
      kind: "rename";
      folderPath: string;
      newName: string;
    }
  | {
      kind: "delete";
      folderPath: string;
    };

export type SubscriptionFolderMutationResult =
  | { ok: true; newPath: string }
  | {
      ok: true;
      removedSourceIds: string[];
      topicDestinationFolder: string;
    }
  | { ok: false; reason: "dragged-folder-not-found" | "duplicate-folder-target" };

interface CollectionServicePort {
  collectFeedRefresh(input: {
    feed: Feed;
    previousItems: FeedItem[];
    refreshedItems: FeedItem[];
    fetchedAt: Date;
  }): Promise<unknown>;
  removeSource(sourceId: string): Promise<CollectionRemovalReceipt>;
}

export interface SubscriptionServiceDependencies {
  settings: SubscriptionSettingsPort;
  /** Resolves the live settings generation after any queued import/reset. */
  getSettings?: () => SubscriptionSettingsPort;
  /** Production mutations share Main's complete settings persistence queue. */
  enqueueMutation?: <T>(operation: () => Promise<T>) => Promise<T>;
  defaults: {
    autoDeleteDuration: number;
    maxItems: number;
  };
  getDefaults?: () => {
    autoDeleteDuration: number;
    maxItems: number;
  };
  parseFeed(url: string, seed: Feed): Promise<Feed>;
  collectionService: CollectionServicePort;
  getCollectionService?: () => CollectionServicePort;
  ensureFolder(folder: string): Promise<unknown>;
  saveSettings(): Promise<void>;
  saveSettingsCandidate?: (
    candidate: SubscriptionSettingsPort,
    publish: () => void,
  ) => Promise<void>;
  now?: () => Date;
  createFeedId?: () => string;
  prepareFeed?: (feed: Feed) => Feed;
  abortInitialImport?: (feedId: string) => void;
}

const lifecycleMutationQueues = new WeakMap<object, Promise<void>>();
const pendingRemovalIntents = new WeakMap<
  object,
  Map<string, Set<symbol>>
>();

export function isSubscriptionRemovalPending(
  settings: object,
  feedId: string,
): boolean {
  return (pendingRemovalIntents.get(settings)?.get(feedId)?.size ?? 0) > 0;
}

function registerRemovalIntent(settings: object, feedId: string): symbol {
  const token = Symbol(feedId);
  let sourceIntents = pendingRemovalIntents.get(settings);
  if (!sourceIntents) {
    sourceIntents = new Map();
    pendingRemovalIntents.set(settings, sourceIntents);
  }
  let tokens = sourceIntents.get(feedId);
  if (!tokens) {
    tokens = new Set();
    sourceIntents.set(feedId, tokens);
  }
  tokens.add(token);
  return token;
}

function clearRemovalIntent(
  settings: object,
  feedId: string,
  token: symbol,
): void {
  const sourceIntents = pendingRemovalIntents.get(settings);
  const tokens = sourceIntents?.get(feedId);
  if (!sourceIntents || !tokens) return;
  tokens.delete(token);
  if (tokens.size === 0) sourceIntents.delete(feedId);
  if (sourceIntents.size === 0) pendingRemovalIntents.delete(settings);
}

export class SubscriptionService {
  private readonly now: () => Date;
  private readonly createFeedId: () => string;

  constructor(private readonly dependencies: SubscriptionServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.createFeedId = dependencies.createFeedId ?? createFeedId;
  }

  private get settings(): SubscriptionSettingsPort {
    return this.dependencies.getSettings?.() ?? this.dependencies.settings;
  }

  private get defaults(): SubscriptionServiceDependencies["defaults"] {
    return this.dependencies.getDefaults?.() ?? this.dependencies.defaults;
  }

  private get collectionService(): CollectionServicePort {
    return this.dependencies.getCollectionService?.() ??
      this.dependencies.collectionService;
  }

  async add(request: VerifiedSubscriptionRequest): Promise<Feed> {
    return await this.enqueueMutation(async () => await this.addUnlocked(request));
  }

  private async addUnlocked(request: VerifiedSubscriptionRequest): Promise<Feed> {
    const key = requestKey(request);
    if (this.hasDuplicate(key)) {
      throw new SubscriptionServiceError("duplicate-subscription");
    }
    const feedId = this.uniqueFeedId();
    if (request.kind === "x-account") {
      return await this.withReservedXVerification(request, async () => {
        const feed = this.buildXFeed(request, feedId);
        if (feed.folder) await this.dependencies.ensureFolder(feed.folder);
        this.assertPublicationAvailable(request, feedId);
        await this.commitFeeds([
          ...cloneFeeds(this.settings.feeds),
          feed,
        ]);
        return feed;
      });
    }
    return await this.addFeedSubscription(request, feedId);
  }

  async update(
    feedId: string,
    request: SubscriptionUpdateRequest,
  ): Promise<Feed> {
    return await this.enqueueMutation(
      async () => await this.updateUnlocked(feedId, request),
    );
  }

  private async updateUnlocked(
    feedId: string,
    request: SubscriptionUpdateRequest,
  ): Promise<Feed> {
    const index = this.feedIndex(feedId);
    const previous = this.settings.feeds[index];
    if (request.kind === "x-account-options") {
      return await this.updateXOptions(index, previous, request);
    }
    if (request.kind === "feed-options") {
      return await this.updateFeedOptions(index, previous, request);
    }
    const key = requestKey(request);
    if (this.hasDuplicate(key, feedId)) {
      throw new SubscriptionServiceError("duplicate-subscription");
    }
    const policy = validPolicy(request.initialImportPolicy);
    const folder = normalizedFolder(request.folder);
    const identityChanged = existingFeedKey(previous) !== key ||
      xRestIdChanged(previous, request);

    if (identityChanged && request.kind !== "x-account") {
      return await this.addFeedSubscription(request, feedId, previous);
    }

    if (request.kind === "x-account") {
      return await this.withReservedXVerification(request, async () => {
        const replacement = this.buildXFeed(request, feedId);
        const previousAccount = normalizeXAccountSourceConfig(previous.sourceConfig);
        const sameProviderIdentity = previousAccount?.restId !== undefined &&
          previousAccount.restId === request.profile.restId;
        const updated: Feed = {
          ...replacement,
          items: identityChanged && !sameProviderIdentity ? [] : previous.items,
          lastUpdated: identityChanged && !sameProviderIdentity
            ? 0
            : previous.lastUpdated,
          initialImportPolicy: policy,
          initialImportProgress: identityChanged && !sameProviderIdentity
            ? initialProgress("pending")
            : previous.initialImportProgress,
          subscriptionStatus: previous.subscriptionStatus ?? "active",
        };
        if (folder) await this.dependencies.ensureFolder(folder);
        const candidate = cloneFeeds(this.settings.feeds);
        candidate[index] = updated;
        await this.commitFeeds(candidate);
        return updated;
      });
    }
    const updated = applyEditableFeedOptions(
      previous,
      request,
      policy,
      folder,
      this.dependencies,
    );
    if (folder) await this.dependencies.ensureFolder(folder);
    const candidate = cloneFeeds(this.settings.feeds);
    candidate[index] = updated;
    await this.commitFeeds(candidate);
    return updated;
  }

  private async updateXOptions(
    index: number,
    previous: Feed,
    request: XSubscriptionOptionsUpdateRequest,
  ): Promise<Feed> {
    const account = previous.sourceKind === "x-account"
      ? normalizeXAccountSourceConfig(previous.sourceConfig)
      : undefined;
    if (!account) {
      throw new SubscriptionServiceError("invalid-subscription-request");
    }
    const folder = request.folder === undefined
      ? previous.folder ?? account.folder
      : normalizedFolder(request.folder);
    const tags = request.tags === undefined
      ? undefined
      : [...request.tags];
    const updated: Feed = {
      ...previous,
      sourceConfig: {
        ...account,
        includeReplies: request.includeReplies ?? account.includeReplies,
        includeReposts: request.includeReposts ?? account.includeReposts,
        folder: request.folder === undefined ? account.folder : folder,
        topics: tags ?? account.topics,
      },
      folder,
      ...(tags ? { customTags: tags } : {}),
      ...(request.initialImportPolicy === undefined
        ? {}
        : { initialImportPolicy: validPolicy(request.initialImportPolicy) }),
      ...(request.autoDeleteDuration === undefined
        ? {}
        : {
            autoDeleteDuration: numberOrDefault(
              request.autoDeleteDuration,
              previous.autoDeleteDuration ??
                this.defaults.autoDeleteDuration,
            ),
          }),
      ...(request.maxItemsLimit === undefined
        ? {}
        : {
            maxItemsLimit: numberOrDefault(
              request.maxItemsLimit,
              previous.maxItemsLimit ?? this.defaults.maxItems,
            ),
          }),
      ...(request.scanInterval === undefined
        ? {}
        : { scanInterval: request.scanInterval }),
      ...(request.keywordRules === undefined
        ? {}
        : { keywordRules: cloneKeywordRules(request.keywordRules) }),
      ...(request.customTemplate === undefined
        ? {}
        : { customTemplate: normalizedTitle(request.customTemplate) }),
      ...(request.excludeFromRefresh === undefined
        ? {}
        : { excludeFromRefresh: request.excludeFromRefresh }),
      ...(request.paused === undefined
        ? {}
        : { subscriptionStatus: request.paused ? "paused" : "active" }),
    };
    if (folder) await this.dependencies.ensureFolder(folder);
    const candidate = cloneFeeds(this.settings.feeds);
    candidate[index] = updated;
    await this.commitFeeds(candidate);
    return updated;
  }

  private async updateFeedOptions(
    index: number,
    previous: Feed,
    request: FeedSubscriptionOptionsUpdateRequest,
  ): Promise<Feed> {
    if (previous.sourceKind === "x-account" || previous.sourceKind === "x-topic") {
      throw new SubscriptionServiceError("invalid-subscription-request");
    }
    const folder = request.folder === undefined
      ? previous.folder
      : normalizedFolder(request.folder);
    const updated: Feed = {
      ...previous,
      ...(request.displayName === undefined
        ? {}
        : { title: normalizedTitle(request.displayName) ?? previous.title }),
      folder,
      ...(request.tags === undefined
        ? {}
        : { customTags: [...request.tags] }),
      ...(request.initialImportPolicy === undefined
        ? {}
        : { initialImportPolicy: validPolicy(request.initialImportPolicy) }),
      ...(request.autoDeleteDuration === undefined
        ? {}
        : {
            autoDeleteDuration: numberOrDefault(
              request.autoDeleteDuration,
              previous.autoDeleteDuration ??
                this.defaults.autoDeleteDuration,
            ),
          }),
      ...(request.maxItemsLimit === undefined
        ? {}
        : {
            maxItemsLimit: numberOrDefault(
              request.maxItemsLimit,
              previous.maxItemsLimit ?? this.defaults.maxItems,
            ),
          }),
      ...(request.scanInterval === undefined
        ? {}
        : { scanInterval: request.scanInterval }),
      ...(request.keywordRules === undefined
        ? {}
        : { keywordRules: cloneKeywordRules(request.keywordRules) }),
      ...(request.customTemplate === undefined
        ? {}
        : { customTemplate: normalizedTitle(request.customTemplate) }),
      ...(request.excludeFromRefresh === undefined
        ? {}
        : { excludeFromRefresh: request.excludeFromRefresh }),
      ...(request.mediaType === undefined
        ? {}
        : { mediaType: request.mediaType }),
      ...(request.paused === undefined
        ? {}
        : { subscriptionStatus: request.paused ? "paused" : "active" }),
    };
    if (folder) await this.dependencies.ensureFolder(folder);
    const candidate = cloneFeeds(this.settings.feeds);
    candidate[index] = updated;
    await this.commitFeeds(candidate);
    return updated;
  }

  async setPaused(feedId: string, paused: boolean): Promise<Feed> {
    return await this.enqueueMutation(async () =>
      await this.updateFeed(feedId, (feed) => ({
        ...feed,
        subscriptionStatus: paused ? "paused" : "active",
      }))
    );
  }

  async applySidebarOrdering(
    request: SidebarOrderingMutationRequest,
  ): Promise<SidebarOrderingMutationResult> {
    return await this.enqueueMutation(async () => {
      const settings = this.settings as RssDashboardSettings;
      const result = request.kind === "feed-insert"
        ? moveFeedAndInsert(settings, request)
        : request.kind === "feed-folder-append"
          ? moveFeedToFolderAppend(settings, request)
          : moveFolder(settings, request);
      if (!result.ok) return result;

      synchronizeSourceConfigFolders(result.settings.feeds);
      await this.commitSidebarOrdering(result.settings);
      return result;
    });
  }

  async applyFolderMutation(
    request: SubscriptionFolderMutationRequest,
  ): Promise<SubscriptionFolderMutationResult> {
    if (request.kind === "rename") {
      return await this.enqueueMutation(
        async () => await this.renameFolderUnlocked(request),
      );
    }

    const folderPath = normalizeRequiredFolderPath(request.folderPath);
    if (!findFolderNode(this.settings.folders, folderPath)) {
      return { ok: false, reason: "dragged-folder-not-found" };
    }
    const intents: Array<{
      owner: SubscriptionSettingsPort;
      sourceId: string;
      token: symbol;
    }> = [];
    const registerCurrentRemovalIntents = (): void => {
      const owner = this.settings;
      for (const feed of owner.feeds) {
        if (
          feed.sourceKind === "x-topic" ||
          !isFolderWithin(feed.folder, folderPath)
        ) continue;
        const sourceId = feed.feedId ?? feed.url;
        if (intents.some((intent) =>
          intent.owner === owner && intent.sourceId === sourceId
        )) continue;
        intents.push({
          owner,
          sourceId,
          token: registerRemovalIntent(owner, sourceId),
        });
        this.dependencies.abortInitialImport?.(sourceId);
      }
    };
    try {
      registerCurrentRemovalIntents();
      return await this.enqueueMutation(async () => {
        registerCurrentRemovalIntents();
        for (const intent of intents) {
          this.dependencies.abortInitialImport?.(intent.sourceId);
        }
        return await this.deleteFolderUnlocked(folderPath);
      });
    } finally {
      for (const { owner, sourceId, token } of intents) {
        clearRemovalIntent(owner, sourceId, token);
      }
    }
  }

  async stopInitialImport(feedId: string): Promise<Feed> {
    this.dependencies.abortInitialImport?.(feedId);
    return await this.enqueueMutation(
      async () => await this.updateImportStatus(feedId, "stopped"),
    );
  }

  async resumeInitialImport(feedId: string): Promise<Feed> {
    return await this.enqueueMutation(async () => {
      const feed = this.settings.feeds[this.feedIndex(feedId)];
      const status = feed.initialImportProgress?.status;
      const mayResume = status === "stopped" || status === "paused-limit" || (
        (feed.sourceKind === undefined || feed.sourceKind === "feed") &&
        status === "failed"
      );
      if (!mayResume) {
        throw new SubscriptionServiceError("invalid-subscription-request");
      }
      if (feed.sourceKind === undefined || feed.sourceKind === "feed") {
        return await this.resumeFeedImport(feedId, feed);
      }
      return await this.updateImportStatus(feedId, "pending");
    });
  }

  async remove(
    feedId: string,
    options: RemoveSubscriptionOptions,
  ): Promise<void> {
    this.removalIndex(feedId, options);
    const intents: Array<{ owner: SubscriptionSettingsPort; token: symbol }> = [];
    const registerCurrentRemovalIntent = (): void => {
      const owner = this.settings;
      if (intents.some((intent) => intent.owner === owner)) return;
      intents.push({ owner, token: registerRemovalIntent(owner, feedId) });
    };
    try {
      registerCurrentRemovalIntent();
      this.dependencies.abortInitialImport?.(feedId);
      return await this.enqueueMutation(async () => {
        registerCurrentRemovalIntent();
        this.dependencies.abortInitialImport?.(feedId);
        await this.removeUnlocked(feedId, options);
      });
    } finally {
      for (const { owner, token } of intents) {
        clearRemovalIntent(owner, feedId, token);
      }
    }
  }

  private async removeUnlocked(
    feedId: string,
    options: RemoveSubscriptionOptions,
  ): Promise<void> {
    const index = this.removalIndex(feedId, options);

    const candidate = cloneFeeds(this.settings.feeds);
    candidate.splice(index, 1);
    if (!options.purgeCollection) {
      await this.commitFeeds(candidate);
      return;
    }

    const removal = await this.collectionService.removeSource(feedId);
    try {
      await this.commitFeeds(candidate);
      await removal.commit();
    } catch (saveError) {
      try {
        await removal.rollback();
      } catch {
        throw new Error("Subscription purge failed and rollback was incomplete");
      }
      throw saveError;
    }
  }

  private removalIndex(
    feedId: string,
    options: RemoveSubscriptionOptions,
  ): number {
    const index = this.feedIndex(feedId);
    if (
      !options ||
      typeof options !== "object" ||
      (options.purgeCollection !== true && options.purgeCollection !== false)
    ) {
      throw new SubscriptionServiceError("invalid-subscription-request");
    }
    if (
      options.purgeCollection &&
      (!(options.confirmation instanceof ConfirmedCollectionPurge) ||
        !options.confirmation.matches(feedId))
    ) {
      throw new SubscriptionServiceError("purge-confirmation-required");
    }
    return index;
  }

  private async addFeedSubscription(
    request: VerifiedFeedSubscriptionRequest,
    feedId: string,
    previous?: Feed,
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
      this.defaults.autoDeleteDuration,
    );
    const maxItemsLimit = numberOrDefault(
      request.maxItemsLimit,
      this.defaults.maxItems,
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
      subscriptionStatus: previous?.subscriptionStatus ?? "active",
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
      mediaType:
        request.kind === "youtube"
          ? "video"
          : previous
            ? request.mediaType ?? parsed.mediaType ?? "article"
            : parsed.mediaType ?? request.mediaType ?? "article",
      autoDeleteDuration,
      maxItemsLimit,
      scanInterval: request.scanInterval ?? parsed.scanInterval ?? 0,
      excludeFromRefresh:
        request.excludeFromRefresh ?? parsed.excludeFromRefresh ?? false,
      customTemplate:
        request.customTemplate === undefined
          ? parsed.customTemplate
          : normalizedTitle(request.customTemplate),
      customTags: [...request.tags],
      keywordRules: request.keywordRules ?? parsed.keywordRules ?? seed.keywordRules,
      subscriptionStatus: previous?.subscriptionStatus ?? "active",
      initialImportPolicy: policy,
      initialImportProgress: initialProgress("pending"),
    });

    if (folder) await this.dependencies.ensureFolder(folder);
    if (previous) {
      await this.replacePublishedFeed(feedId, pending);
    } else {
      this.assertPublicationAvailable(request, feedId);
      await this.commitFeeds([
        ...cloneFeeds(this.settings.feeds),
        pending,
      ]);
    }

    try {
      await this.collectionService.collectFeedRefresh({
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
      restId: request.profile.restId,
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
      mediaType: request.mediaType ?? "article",
      autoDeleteDuration: numberOrDefault(
        request.autoDeleteDuration,
        this.defaults.autoDeleteDuration,
      ),
      maxItemsLimit: numberOrDefault(
        request.maxItemsLimit,
        this.defaults.maxItems,
      ),
      scanInterval: request.scanInterval ?? 0,
      keywordRules: cloneKeywordRules(request.keywordRules),
      customTemplate: request.customTemplate || undefined,
      excludeFromRefresh: request.excludeFromRefresh === true,
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
    if (this.settings.feeds.some((feed) => feed.feedId === feedId)) {
      throw new SubscriptionServiceError("invalid-subscription-request");
    }
  }

  private hasDuplicate(key: string, excludedFeedId?: string): boolean {
    return this.settings.feeds.some(
      (feed) =>
        (feed.feedId ?? feed.url) !== excludedFeedId &&
        existingFeedKey(feed) === key,
    );
  }

  private uniqueFeedId(): string {
    const feedId = this.createFeedId().normalize("NFC").trim().toLowerCase();
    if (
      !/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(feedId) ||
      this.settings.feeds.some((feed) => feed.feedId === feedId)
    ) {
      throw new SubscriptionServiceError("invalid-subscription-request");
    }
    return feedId;
  }

  private feedIndex(feedId: string): number {
    const index = this.settings.feeds.findIndex(
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
    const candidate = cloneFeeds(this.settings.feeds);
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
      await this.collectionService.collectFeedRefresh({
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
    const candidate = cloneFeeds(this.settings.feeds);
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
    await this.commitSettingsReferences({
      ...cloneSubscriptionSettings(this.settings),
      feeds: candidate,
    });
  }

  private async commitSidebarOrdering(
    candidate: RssDashboardSettings,
  ): Promise<void> {
    await this.commitSettingsReferences({
      feeds: candidate.feeds,
      folders: candidate.folders,
      collapsedFolders: candidate.collapsedFolders,
      folderFeedSortOrders: candidate.folderFeedSortOrders,
      folderSortOrder: candidate.folderSortOrder,
    });
  }

  private async commitSettingsReferences(
    candidate: SubscriptionSettingsPort,
  ): Promise<void> {
    const settings = this.settings;
    const original = snapshotSettingsReferences(settings);
    const publish = (): void => publishSettingsReferences(settings, candidate);
    if (this.dependencies.saveSettingsCandidate) {
      await this.dependencies.saveSettingsCandidate(candidate, publish);
      return;
    }
    publish();
    try {
      await this.dependencies.saveSettings();
    } catch (error) {
      publishSettingsReferences(settings, original);
      throw error;
    }
  }

  private async renameFolderUnlocked(
    request: Extract<SubscriptionFolderMutationRequest, { kind: "rename" }>,
  ): Promise<SubscriptionFolderMutationResult> {
    const folderPath = normalizeRequiredFolderPath(request.folderPath);
    const newName = normalizeFolderName(request.newName);
    const candidate = cloneSubscriptionSettings(this.settings);
    const location = findFolderLocationForMutation(candidate.folders, folderPath);
    if (!location) return { ok: false, reason: "dragged-folder-not-found" };
    if (
      location.siblings.some((folder, index) =>
        index !== location.index && folder.name === newName
      )
    ) {
      return { ok: false, reason: "duplicate-folder-target" };
    }
    const newPath = location.parentPath
      ? `${location.parentPath}/${newName}`
      : newName;
    location.folder.name = newName;
    location.folder.modifiedAt = this.now().getTime();
    for (const feed of candidate.feeds) {
      if (!isFolderWithin(feed.folder, folderPath)) continue;
      feed.folder = remapFolderPrefix(feed.folder, folderPath, newPath);
    }
    synchronizeSourceConfigFolders(candidate.feeds);
    candidate.collapsedFolders = (candidate.collapsedFolders ?? []).map(
      (path) => remapFolderPrefix(path, folderPath, newPath),
    );
    candidate.folderFeedSortOrders = remapFolderSortKeys(
      candidate.folderFeedSortOrders,
      folderPath,
      newPath,
    );
    await this.commitSettingsReferences(candidate);
    return { ok: true, newPath };
  }

  private async deleteFolderUnlocked(
    folderPath: string,
  ): Promise<SubscriptionFolderMutationResult> {
    const candidate = cloneSubscriptionSettings(this.settings);
    const location = findFolderLocationForMutation(candidate.folders, folderPath);
    if (!location) return { ok: false, reason: "dragged-folder-not-found" };
    const topicDestinationFolder = location.parentPath;
    location.siblings.splice(location.index, 1);
    const removedSourceIds: string[] = [];
    candidate.feeds = candidate.feeds.flatMap((feed) => {
      if (!isFolderWithin(feed.folder, folderPath)) return [feed];
      if (feed.sourceKind !== "x-topic") {
        removedSourceIds.push(feed.feedId ?? feed.url);
        return [];
      }
      const remapped = { ...feed, folder: topicDestinationFolder };
      const config = normalizeXTopicSourceConfig(remapped.sourceConfig);
      if (config) {
        remapped.sourceConfig = { ...config, folder: topicDestinationFolder };
      }
      return [remapped];
    });
    candidate.collapsedFolders = (candidate.collapsedFolders ?? []).filter(
      (path) => !isFolderWithin(path, folderPath),
    );
    candidate.folderFeedSortOrders = filterDeletedFolderSortKeys(
      candidate.folderFeedSortOrders,
      folderPath,
    );
    await this.commitSettingsReferences(candidate);
    return { ok: true, removedSourceIds, topicDestinationFolder };
  }

  private reserveXVerification(
    request: VerifiedXSubscriptionRequest,
  ): XProfileVerificationReservation {
    const reservation = reserveXProfileVerificationProof(
      request.profile,
      request.verificationProof,
      this.now(),
    );
    if (!reservation) {
      throw new SubscriptionServiceError("invalid-subscription-request");
    }
    return reservation;
  }

  private async withReservedXVerification<T>(
    request: VerifiedXSubscriptionRequest,
    operation: () => Promise<T>,
  ): Promise<T> {
    const reservation = this.reserveXVerification(request);
    let result: T;
    try {
      result = await operation();
    } catch (error) {
      releaseXProfileVerificationReservation(reservation, this.now());
      throw error;
    }
    commitXProfileVerificationReservation(reservation);
    return result;
  }

  private async enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.dependencies.enqueueMutation) {
      return await this.dependencies.enqueueMutation(operation);
    }
    const owner = this.settings;
    const prior = lifecycleMutationQueues.get(owner) ?? Promise.resolve();
    const running = prior.catch(() => undefined).then(operation);
    const settled = running.then(() => undefined, () => undefined);
    lifecycleMutationQueues.set(owner, settled);
    try {
      return await running;
    } finally {
      if (lifecycleMutationQueues.get(owner) === settled) {
        lifecycleMutationQueues.delete(owner);
      }
    }
  }
}

function synchronizeSourceConfigFolders(feeds: Feed[]): void {
  for (const feed of feeds) {
    if (feed.sourceKind === "x-account") {
      const config = normalizeXAccountSourceConfig(feed.sourceConfig);
      if (config) {
        feed.sourceConfig = { ...config, folder: feed.folder ?? "" };
      }
      continue;
    }
    if (feed.sourceKind === "x-topic") {
      const config = normalizeXTopicSourceConfig(feed.sourceConfig);
      if (config) {
        feed.sourceConfig = { ...config, folder: feed.folder ?? "" };
      }
    }
  }
}

function cloneSubscriptionSettings(
  settings: SubscriptionSettingsPort,
): SubscriptionSettingsPort {
  return {
    feeds: cloneFeeds(settings.feeds),
    folders: structuredClone(settings.folders),
    collapsedFolders: [...(settings.collapsedFolders ?? [])],
    ...(settings.folderFeedSortOrders === undefined
      ? {}
      : {
          folderFeedSortOrders: structuredClone(
            settings.folderFeedSortOrders,
          ),
        }),
    ...(settings.folderSortOrder === undefined
      ? {}
      : { folderSortOrder: { ...settings.folderSortOrder } }),
  };
}

function snapshotSettingsReferences(
  settings: SubscriptionSettingsPort,
): SubscriptionSettingsPort {
  return {
    feeds: settings.feeds,
    folders: settings.folders,
    collapsedFolders: settings.collapsedFolders,
    folderFeedSortOrders: settings.folderFeedSortOrders,
    folderSortOrder: settings.folderSortOrder,
  };
}

function publishSettingsReferences(
  settings: SubscriptionSettingsPort,
  candidate: SubscriptionSettingsPort,
): void {
  settings.feeds = candidate.feeds;
  settings.folders = candidate.folders;
  settings.collapsedFolders = candidate.collapsedFolders;
  settings.folderFeedSortOrders = candidate.folderFeedSortOrders;
  settings.folderSortOrder = candidate.folderSortOrder;
}

function normalizeRequiredFolderPath(path: string): string {
  const normalized = path.normalize("NFC").trim();
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.endsWith("/") ||
    normalized.split("/").some((segment) => !segment.trim())
  ) {
    throw new SubscriptionServiceError("invalid-subscription-request");
  }
  return normalized;
}

function normalizeFolderName(name: string): string {
  const normalized = name.normalize("NFC").trim();
  if (!normalized || normalized.includes("/")) {
    throw new SubscriptionServiceError("invalid-subscription-request");
  }
  return normalized;
}

function isFolderWithin(path: string | undefined, base: string): boolean {
  return path === base || path?.startsWith(`${base}/`) === true;
}

function remapFolderPrefix(path: string, fromBase: string, toBase: string): string {
  if (path === fromBase) return toBase;
  if (!path.startsWith(`${fromBase}/`)) return path;
  return `${toBase}${path.substring(fromBase.length)}`;
}

interface FolderMutationLocation {
  folder: Folder;
  siblings: Folder[];
  index: number;
  parentPath: string;
}

function findFolderLocationForMutation(
  folders: Folder[],
  path: string,
): FolderMutationLocation | undefined {
  const parts = path.split("/");
  let siblings = folders;
  const parents: string[] = [];
  for (let depth = 0; depth < parts.length; depth += 1) {
    const index = siblings.findIndex((folder) => folder.name === parts[depth]);
    if (index < 0) return undefined;
    const folder = siblings[index];
    if (depth === parts.length - 1) {
      return { folder, siblings, index, parentPath: parents.join("/") };
    }
    parents.push(folder.name);
    siblings = folder.subfolders ?? [];
  }
  return undefined;
}

function findFolderNode(folders: Folder[], path: string): Folder | undefined {
  return findFolderLocationForMutation(folders, path)?.folder;
}

function remapFolderSortKeys(
  orders: RssDashboardSettings["folderFeedSortOrders"],
  fromBase: string,
  toBase: string,
): RssDashboardSettings["folderFeedSortOrders"] {
  if (orders === undefined) return undefined;
  return Object.fromEntries(Object.entries(orders).map(([path, order]) => [
    remapFolderPrefix(path, fromBase, toBase),
    order,
  ]));
}

function filterDeletedFolderSortKeys(
  orders: RssDashboardSettings["folderFeedSortOrders"],
  folderPath: string,
): RssDashboardSettings["folderFeedSortOrders"] {
  if (orders === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(orders).filter(([path]) => !isFolderWithin(path, folderPath)),
  );
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
    if (!handle || !/^\d{1,30}$/u.test(request.profile.restId)) {
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

function xRestIdChanged(
  previous: Feed,
  request: VerifiedSubscriptionRequest,
): boolean {
  if (request.kind !== "x-account") return false;
  const account = normalizeXAccountSourceConfig(previous.sourceConfig);
  return account?.restId !== request.profile.restId;
}

function applyEditableFeedOptions(
  previous: Feed,
  request: VerifiedFeedSubscriptionRequest,
  policy: InitialImportPolicy,
  folder: string,
  dependencies: SubscriptionServiceDependencies,
): Feed {
  return {
    ...previous,
    title: normalizedTitle(request.displayName) ?? previous.title,
    folder,
    customTags: [...request.tags],
    initialImportPolicy: policy,
    autoDeleteDuration: numberOrDefault(
      request.autoDeleteDuration,
      previous.autoDeleteDuration ?? dependencies.defaults.autoDeleteDuration,
    ),
    maxItemsLimit: numberOrDefault(
      request.maxItemsLimit,
      previous.maxItemsLimit ?? dependencies.defaults.maxItems,
    ),
    scanInterval: request.scanInterval ?? previous.scanInterval ?? 0,
    keywordRules: request.keywordRules === undefined
      ? previous.keywordRules
      : cloneKeywordRules(request.keywordRules),
    customTemplate: request.customTemplate || undefined,
    excludeFromRefresh: request.excludeFromRefresh === true,
    mediaType: request.kind === "youtube"
      ? "video"
      : request.mediaType ?? previous.mediaType ?? "article",
  };
}

function cloneKeywordRules(
  value: FeedKeywordRulesSettings | undefined,
): FeedKeywordRulesSettings | undefined {
  return value === undefined ? undefined : structuredClone(value);
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
  const uuid = window.crypto?.randomUUID?.();
  return uuid ?? `feed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
