import { createTranslator } from "../../i18n";
import type { TranslationKey, Translator } from "../../i18n/types";
import type { SourceAdapter, SourceRefreshOutput } from "../source-adapter";
import type { XAccountSourceConfig } from "../source-config";
import {
  TikHubClientError,
  type TikHubUserRequest,
} from "./tikhub-client";
import { parseTikHubTimeline } from "./tikhub-parser";
import type { TikHubResult } from "./tikhub-types";
import { mapXAccountPostsToFeed } from "./x-feed-mapper";
import type { XPost } from "./x-post";

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
    let accountPayload: unknown;
    let replyPayload: unknown;
    let parsed: ReturnType<TimelineParser> | undefined;
    let posts: XPost[] = [];
    let warnings: string[] = [];
    try {
      if (!isUuid(this.connectionId)) throw this.missingKeyError();
      apiKey = await this.secretStore.get(this.connectionId);
      if (apiKey === undefined || !apiKey.trim()) throw this.missingKeyError();
      if (!isLocallyValidApiKey(apiKey)) throw this.invalidKeyError();

      accountPayload = (await this.callClient(
        () => this.client.fetchUserPosts({
          apiKey: apiKey as string,
          handle: config.handle,
          signal: context.signal,
        }),
      )).data;
      parsed = this.parseTimeline(accountPayload);
      posts = parsed.posts;
      warnings = [...parsed.warnings];

      let providerRequestCount = 1;
      if (config.includeReplies) {
        replyPayload = (await this.callClient(
          () => this.client.fetchUserReplies({
            apiKey: apiKey as string,
            handle: config.handle,
            signal: context.signal,
          }),
        )).data;
        providerRequestCount += 1;
        parsed = this.parseTimeline(replyPayload);
        posts = mergePostsById(posts, parsed.posts);
        warnings.push(...parsed.warnings);
      }

      posts = posts.filter((post) => shouldIncludePost(config, post));
      const mapped = mapXAccountPostsToFeed(config, posts, context.now);
      return {
        feed: mapped.feed,
        items: mapped.items,
        providerRequestCount,
        warnings,
      };
    } finally {
      apiKey = undefined;
      accountPayload = undefined;
      replyPayload = undefined;
      parsed = undefined;
      posts = [];
      warnings = [];
    }
  };

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

function shouldIncludePost(
  config: XAccountSourceConfig,
  post: XPost,
): boolean {
  if (post.authorHandle.toLowerCase() !== config.handle) return false;
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
