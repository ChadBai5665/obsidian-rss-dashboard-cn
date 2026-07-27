import { createTranslator } from "../../i18n";
import type { TranslationKey, Translator } from "../../i18n/types";
import type { SourceAdapter, SourceRefreshOutput } from "../source-adapter";
import type { XAccountSourceConfig } from "../source-config";
import {
  filterItemsForInitialImport,
  normalizeInitialImportPolicy,
  normalizeInitialImportProgress,
  type InitialImportPolicy,
  type InitialImportProgress,
} from "../initial-import-policy";
import { TikHubRequestBudgetError } from "./request-budget";
import { TikHubRequestLedgerError } from "./request-ledger";
import {
  TikHubClientError,
  type TikHubUserRequest,
} from "./tikhub-client";
import { parseTikHubTimeline } from "./tikhub-parser";
import type { TikHubResult } from "./tikhub-types";
import { mapXAccountPostsToFeed } from "./x-feed-mapper";
import type { XPost } from "./x-post";
import { validateParsedXTimeline } from "./x-timeline-validator";

export interface XAccountTikHubClient {
  fetchUserPosts(input: TikHubUserRequest): Promise<TikHubResult<unknown>>;
  fetchUserReplies(input: TikHubUserRequest): Promise<TikHubResult<unknown>>;
}

export interface XAccountSecretStore {
  get(connectionId: string): Promise<string | undefined>;
}

type TimelineParser = typeof parseTikHubTimeline;

export interface XAccountAdapterOptions {
  client: XAccountTikHubClient;
  secretStore: XAccountSecretStore;
  connectionId: string;
  translate?: Translator;
  /** Test seam for sanitized provider shapes; production uses the defensive parser. */
  parseTimeline?: TimelineParser;
}

export type XAccountRefreshErrorCode = "missing-key" | "invalid-key";

export class XAccountRefreshError extends Error {
  constructor(
    readonly code: XAccountRefreshErrorCode,
    readonly translationKey: TranslationKey,
    translate: Translator,
  ) {
    super(translate(translationKey));
    this.name = "XAccountRefreshError";
  }
}

export class XAccountAdapter implements SourceAdapter<XAccountSourceConfig> {
  readonly kind = "x-account" as const;
  private readonly client: XAccountTikHubClient;
  private readonly secretStore: XAccountSecretStore;
  private readonly connectionId: string;
  private readonly translate: Translator;
  private readonly parseTimeline: TimelineParser;

  constructor(options: XAccountAdapterOptions) {
    this.client = options.client;
    this.secretStore = options.secretStore;
    this.connectionId = options.connectionId;
    this.translate = options.translate ?? createTranslator("zh-CN");
    this.parseTimeline = options.parseTimeline ?? parseTikHubTimeline;
  }

  readonly refresh = async (
    config: XAccountSourceConfig,
    context: Parameters<SourceAdapter<XAccountSourceConfig>["refresh"]>[1],
  ): Promise<SourceRefreshOutput> => {
    let apiKey: string | undefined;
    try {
      if (!isUuid(this.connectionId)) throw this.missingKeyError();
      apiKey = await this.secretStore.get(this.connectionId);
      if (apiKey === undefined || !apiKey.trim()) throw this.missingKeyError();
      if (!isLocallyValidApiKey(apiKey)) throw this.invalidKeyError();

      const progress = normalizeInitialImportProgress(
        context.feed?.initialImportProgress,
      );
      if (isActiveInitialImport(progress)) {
        const policy = normalizeInitialImportPolicy(
          context.feed?.initialImportPolicy,
        );
        if (!policy) throw new Error("Invalid X initial import policy");
        return await this.refreshInitialImport(
          config,
          context,
          apiKey,
          policy,
          progress,
        );
      }
      return await this.refreshDaily(config, context, apiKey);
    } finally {
      apiKey = undefined;
    }
  };

  private async refreshDaily(
    config: XAccountSourceConfig,
    context: Parameters<SourceAdapter<XAccountSourceConfig>["refresh"]>[1],
    apiKey: string,
  ): Promise<SourceRefreshOutput> {
    const postsPage = await this.fetchTimelinePage(
      "posts",
      config,
      context,
      apiKey,
    );
    const posts = [...postsPage.posts];
    const warnings = [...postsPage.warnings];
    let providerRequestCount = 1;
    if (config.includeReplies) {
      const repliesPage = await this.fetchTimelinePage(
        "replies",
        config,
        context,
        apiKey,
      );
      posts.push(...repliesPage.posts);
      warnings.push(...repliesPage.warnings);
      providerRequestCount += 1;
    }

    const currentPosts = filterAccountPosts(config, posts);
    const mapped = mapXAccountPostsToFeed(
      config,
      currentPosts,
      context.now,
      context.feed,
    );
    return {
      feed: mapped.feed,
      items: mapped.feed.items,
      collectionItems: mapped.items,
      providerRequestCount,
      warnings,
    };
  }

  private async refreshInitialImport(
    config: XAccountSourceConfig,
    context: Parameters<SourceAdapter<XAccountSourceConfig>["refresh"]>[1],
    apiKey: string,
    policy: InitialImportPolicy,
    previousProgress: InitialImportProgress,
  ): Promise<SourceRefreshOutput> {
    const progress: InitialImportProgress = {
      ...previousProgress,
      status: "running",
    };
    let providerRequestCount = 0;
    const warnings: string[] = [];
    const importedPosts: XPost[] = [];
    let pausedAtLimit = false;

    const fetchPages = async (
      kind: "posts" | "replies",
      initialCursor: string | undefined,
    ): Promise<{ completed: boolean; cursor?: string }> => {
      let cursor = initialCursor;
      const seenCursors = new Set(cursor ? [cursor] : []);
      while (true) {
        let parsed: ReturnType<TimelineParser>;
        try {
          parsed = await this.fetchTimelinePage(
            kind,
            config,
            context,
            apiKey,
            cursor,
          );
        } catch (error) {
          if (!isInsufficientBudget(error) || progress.pagesFetched === 0) {
            throw error;
          }
          pausedAtLimit = true;
          return { completed: false, ...(cursor ? { cursor } : {}) };
        }

        providerRequestCount += 1;
        progress.pagesFetched += 1;
        warnings.push(...parsed.warnings);
        const ownedPosts = parsed.posts.filter((post) =>
          belongsToAccount(config, post)
        );
        const selected = selectInitialImportPosts(
          config,
          ownedPosts,
          policy,
          context.now,
        );
        importedPosts.push(...selected.posts);
        if (selected.crossedCutoff || !parsed.nextCursor) {
          return { completed: true };
        }
        if (seenCursors.has(parsed.nextCursor)) {
          warnings.push("Stopped X pagination because a cursor repeated.");
          return { completed: true };
        }
        seenCursors.add(parsed.nextCursor);
        cursor = parsed.nextCursor;
      }
    };

    const resumeAfterPosts =
      config.includeReplies &&
      previousProgress.status !== "pending" &&
      previousProgress.pagesFetched > 0 &&
      previousProgress.nextCursor === undefined;
    if (!resumeAfterPosts) {
      const postResult = await fetchPages("posts", previousProgress.nextCursor);
      if (postResult.completed) delete progress.nextCursor;
      else if (postResult.cursor) progress.nextCursor = postResult.cursor;
    }

    if (!pausedAtLimit && config.includeReplies) {
      const replyResult = await fetchPages(
        "replies",
        previousProgress.replyCursor,
      );
      if (replyResult.completed) delete progress.replyCursor;
      else if (replyResult.cursor) progress.replyCursor = replyResult.cursor;
    }

    const currentPosts = filterAccountPosts(config, importedPosts);
    const mapped = mapXAccountPostsToFeed(
      config,
      currentPosts,
      context.now,
      context.feed,
    );
    progress.status = pausedAtLimit ? "paused-limit" : "completed";
    const previouslyCachedIds = new Set(
      context.feed?.items.map((item) => item.guid) ?? [],
    );
    progress.itemsImported = previousProgress.itemsImported +
      mapped.items.filter((item) => !previouslyCachedIds.has(item.guid)).length;
    const earliest = earliestIsoDate([
      previousProgress.earliestImportedAt,
      ...mapped.items.map((item) => item.pubDate),
    ]);
    if (earliest) progress.earliestImportedAt = earliest;
    else delete progress.earliestImportedAt;
    mapped.feed.initialImportProgress = progress;

    return {
      feed: mapped.feed,
      items: mapped.feed.items,
      collectionItems: mapped.items,
      providerRequestCount,
      warnings,
    };
  }

  private async fetchTimelinePage(
    kind: "posts" | "replies",
    config: XAccountSourceConfig,
    context: Parameters<SourceAdapter<XAccountSourceConfig>["refresh"]>[1],
    apiKey: string,
    cursor?: string,
  ): Promise<ReturnType<TimelineParser>> {
    if (context.signal?.aborted) {
      throw new TikHubClientError("aborted", "TikHub request was cancelled.");
    }
    const input: TikHubUserRequest = {
      apiKey,
      handle: config.handle,
      signal: context.signal,
      ...(cursor ? { cursor } : {}),
    };
    const payload = (await this.callClient(() =>
      kind === "posts"
        ? this.client.fetchUserPosts(input)
        : this.client.fetchUserReplies(input)
    )).data;
    return validateParsedXTimeline(this.parseTimeline(payload));
  }

  private async callClient(
    call: () => Promise<TikHubResult<unknown>>,
  ): Promise<TikHubResult<unknown>> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof TikHubClientError && error.code === "invalid-key") {
        throw this.invalidKeyError();
      }
      throw error;
    }
  }

  private missingKeyError(): XAccountRefreshError {
    return new XAccountRefreshError(
      "missing-key",
      "source.tikhubKeyMissing",
      this.translate,
    );
  }

  private invalidKeyError(): XAccountRefreshError {
    return new XAccountRefreshError(
      "invalid-key",
      "source.tikhubKeyInvalid",
      this.translate,
    );
  }
}

function isActiveInitialImport(
  progress: InitialImportProgress | undefined,
): progress is InitialImportProgress {
  return progress?.status === "pending" ||
    progress?.status === "running" ||
    progress?.status === "paused-limit";
}

function filterAccountPosts(
  config: XAccountSourceConfig,
  posts: readonly XPost[],
): XPost[] {
  return mergePostsById(
    posts.filter((post) => belongsToAccount(config, post)),
    [],
  ).filter((post) => passesAccountSwitches(config, post));
}

function selectInitialImportPosts(
  config: XAccountSourceConfig,
  posts: readonly XPost[],
  policy: InitialImportPolicy,
  now: Date,
): { posts: XPost[]; crossedCutoff: boolean } {
  if (policy.mode === "all-available") {
    return { posts: [...posts], crossedCutoff: false };
  }
  const mapped = mapXAccountPostsToFeed(config, posts, now);
  const selectedItems = filterItemsForInitialImport(mapped.items, policy, now);
  const selectedIds = new Set(selectedItems.map((item) => item.guid));
  const crossedCutoff = mapped.items.some((item) =>
    Number.isFinite(Date.parse(item.pubDate)) && !selectedIds.has(item.guid)
  );
  return {
    posts: posts.filter((post) => selectedIds.has(post.id)),
    crossedCutoff,
  };
}

function earliestIsoDate(values: Array<string | undefined>): string | undefined {
  let earliest: { value: string; timestamp: number } | undefined;
  for (const value of values) {
    if (!value) continue;
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) continue;
    if (!earliest || timestamp < earliest.timestamp) {
      earliest = { value: new Date(timestamp).toISOString(), timestamp };
    }
  }
  return earliest?.value;
}

function isInsufficientBudget(error: unknown): boolean {
  return error instanceof TikHubRequestBudgetError ||
    (error instanceof TikHubRequestLedgerError && error.code === "daily-limit");
}

function belongsToAccount(
  config: XAccountSourceConfig,
  post: XPost,
): boolean {
  return post.authorHandle.toLowerCase() === config.handle;
}

function passesAccountSwitches(
  config: XAccountSourceConfig,
  post: XPost,
): boolean {
  if (post.inReplyToId && !config.includeReplies) return false;
  if (post.repostOfId && !config.includeReposts) return false;
  return true;
}

function mergePostsById(
  accountPosts: readonly XPost[],
  replyPosts: readonly XPost[],
): XPost[] {
  const merged = new Map<string, XPost>();
  for (const post of [...accountPosts, ...replyPosts]) {
    const previous = merged.get(post.id);
    merged.set(post.id, previous ? mergePost(previous, post) : clonePost(post));
  }
  return [...merged.values()];
}

function mergePost(previous: XPost, incoming: XPost): XPost {
  return {
    ...previous,
    ...incoming,
    createdAt: incoming.createdAt ?? previous.createdAt,
    conversationId: incoming.conversationId ?? previous.conversationId,
    inReplyToId: incoming.inReplyToId ?? previous.inReplyToId,
    repostOfId: incoming.repostOfId ?? previous.repostOfId,
    quoteOfId: incoming.quoteOfId ?? previous.quoteOfId,
    externalUrls: [...new Set([...previous.externalUrls, ...incoming.externalUrls])],
    metrics: { ...previous.metrics, ...incoming.metrics },
  };
}

function clonePost(post: XPost): XPost {
  return {
    ...post,
    externalUrls: [...post.externalUrls],
    metrics: { ...post.metrics },
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function isLocallyValidApiKey(value: string): boolean {
  return (
    value.length <= 4096 &&
    value.trim() === value &&
    !hasApiKeyControlCharacter(value)
  );
}

function hasApiKeyControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 31 || codePoint === 127) return true;
  }
  return false;
}
