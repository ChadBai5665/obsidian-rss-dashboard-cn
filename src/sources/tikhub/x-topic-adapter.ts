import { createTranslator } from "../../i18n";
import type { TranslationKey, Translator } from "../../i18n/types";
import type { SourceAdapter, SourceRefreshOutput } from "../source-adapter";
import type { XTopicSourceConfig } from "../source-config";
import {
  TikHubRequestBudgetError,
} from "./request-budget";
import { TikHubRequestLedgerError } from "./request-ledger";
import {
  TikHubClientError,
  type TikHubBatchHandle,
  type TikHubSearchRequest,
} from "./tikhub-client";
import { parseTikHubTimeline } from "./tikhub-parser";
import type { TikHubResult } from "./tikhub-types";
import {
  groupLinkedPages,
  type LinkedPageGroup,
} from "./linked-page-grouper";
import {
  mapXTopicPostsToFeed,
  type ObservedXPost,
} from "./x-feed-mapper";
import type { XPost } from "./x-post";
import {
  buildXTopicSearchPlan,
  type XObservationTag,
} from "./x-search-query";
import { validateParsedXTimeline } from "./x-timeline-validator";

export interface XTopicTikHubClient {
  reserveBatch(count: 2 | 3): Promise<TikHubBatchHandle>;
  releaseBatch(handle: TikHubBatchHandle): Promise<number>;
  fetchSearchTimeline(input: TikHubSearchRequest): Promise<TikHubResult<unknown>>;
}

export interface XTopicSecretStore {
  get(connectionId: string): Promise<string | undefined>;
}

type TimelineParser = typeof parseTikHubTimeline;

export interface XTopicAdapterOptions {
  client: XTopicTikHubClient;
  secretStore: XTopicSecretStore;
  connectionId: string;
  translate?: Translator;
  /** Test seam only; all results still pass through the defensive validator. */
  parseTimeline?: TimelineParser;
}

export type XTopicRefreshErrorCode =
  | "missing-key"
  | "invalid-key"
  | "budget-unavailable";

export class XTopicRefreshError extends Error {
  constructor(
    readonly code: XTopicRefreshErrorCode,
    readonly translationKey: TranslationKey,
    translate: Translator,
  ) {
    super(translate(translationKey));
    this.name = "XTopicRefreshError";
  }
}

const MISSING_TIMESTAMP_WARNING =
  "Skipped an X post without an in-window timestamp.";
const OBSERVATION_ORDER: XObservationTag[] = [
  "latest",
  "platform-top",
  "priority-account",
];

export class XTopicAdapter implements SourceAdapter<XTopicSourceConfig> {
  readonly kind = "x-topic" as const;
  private readonly client: XTopicTikHubClient;
  private readonly secretStore: XTopicSecretStore;
  private readonly connectionId: string;
  private readonly translate: Translator;
  private readonly parseTimeline: TimelineParser;

  constructor(options: XTopicAdapterOptions) {
    this.client = options.client;
    this.secretStore = options.secretStore;
    this.connectionId = options.connectionId;
    this.translate = options.translate ?? createTranslator("zh-CN");
    this.parseTimeline = options.parseTimeline ?? parseTikHubTimeline;
  }

  readonly refresh = async (
    config: XTopicSourceConfig,
    context: Parameters<SourceAdapter<XTopicSourceConfig>["refresh"]>[1],
  ): Promise<SourceRefreshOutput> => {
    const plan = buildXTopicSearchPlan(config, context.now);
    let apiKey: string | undefined;
    let batch: TikHubBatchHandle | undefined;
    let payload: unknown;
    let parsed: ReturnType<TimelineParser> | undefined;
    let warnings: string[] = [];
    let observed = new Map<string, MutableObservedPost>();
    try {
      if (!isUuid(this.connectionId)) throw this.missingKeyError();
      apiKey = await this.secretStore.get(this.connectionId);
      if (apiKey === undefined || !apiKey.trim()) throw this.missingKeyError();
      if (!isLocallyValidApiKey(apiKey)) throw this.invalidKeyError();

      try {
        const requestCount = plan.requestCount;
        if (requestCount !== 2 && requestCount !== 3) throw new Error(
          "Invalid X topic request plan",
        );
        batch = await this.client.reserveBatch(requestCount);
      } catch (error) {
        if (!isInsufficientBudget(error)) throw error;
        throw this.budgetUnavailableError();
      }

      const window = dateWindow(context.now, config.windowDays);
      let providerRequestCount = 0;
      for (const request of plan.requests) {
        if (context.signal?.aborted) throw abortedError();
        payload = (await this.callClient(() =>
          this.client.fetchSearchTimeline({
            apiKey: apiKey as string,
            query: request.query,
            searchType: request.searchType,
            signal: context.signal,
            batch,
          }),
        )).data;
        providerRequestCount += 1;
        parsed = validateParsedXTimeline(this.parseTimeline(payload));
        warnings.push(...parsed.warnings);
        for (const post of parsed.posts) {
          const timestamp = post.createdAt ? Date.parse(post.createdAt) : Number.NaN;
          if (!Number.isFinite(timestamp)) {
            warnings.push(MISSING_TIMESTAMP_WARNING);
            continue;
          }
          if (timestamp < window.start || timestamp > window.end) continue;
          addObservation(observed, post, request.observationTag);
        }
      }

      const observedPosts = [...observed.values()].map(toObservedPost);
      const mapped = mapXTopicPostsToFeed(config, observedPosts, context.now);
      const linkedPageGroups: LinkedPageGroup[] = groupLinkedPages(
        observedPosts.map(({ post }) => post),
      );
      return {
        ...mapped,
        providerRequestCount,
        warnings,
        linkedPageGroups,
      };
    } finally {
      if (batch) await this.client.releaseBatch(batch);
      apiKey = undefined;
      batch = undefined;
      payload = undefined;
      parsed = undefined;
      warnings = [];
      observed.clear();
      observed = new Map();
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

  private missingKeyError(): XTopicRefreshError {
    return new XTopicRefreshError(
      "missing-key",
      "source.tikhubKeyMissing",
      this.translate,
    );
  }

  private invalidKeyError(): XTopicRefreshError {
    return new XTopicRefreshError(
      "invalid-key",
      "source.tikhubKeyInvalid",
      this.translate,
    );
  }

  private budgetUnavailableError(): XTopicRefreshError {
    return new XTopicRefreshError(
      "budget-unavailable",
      "source.tikhubBudgetUnavailable",
      this.translate,
    );
  }
}

interface MutableObservedPost {
  post: XPost;
  observationTags: Set<XObservationTag>;
}

function addObservation(
  observations: Map<string, MutableObservedPost>,
  incoming: XPost,
  tag: XObservationTag,
): void {
  const previous = observations.get(incoming.id);
  if (!previous) {
    observations.set(incoming.id, {
      post: clonePost(incoming),
      observationTags: new Set([tag]),
    });
    return;
  }
  previous.post = mergePost(previous.post, incoming);
  previous.observationTags.add(tag);
}

function toObservedPost(value: MutableObservedPost): ObservedXPost {
  return {
    post: clonePost(value.post),
    observationTags: OBSERVATION_ORDER.filter((tag) =>
      value.observationTags.has(tag),
    ),
  };
}

function mergePost(previous: XPost, incoming: XPost): XPost {
  return {
    ...previous,
    authorName: previous.authorName ?? incoming.authorName,
    createdAt: previous.createdAt ?? incoming.createdAt,
    conversationId: previous.conversationId ?? incoming.conversationId,
    inReplyToId: previous.inReplyToId ?? incoming.inReplyToId,
    repostOfId: previous.repostOfId ?? incoming.repostOfId,
    quoteOfId: previous.quoteOfId ?? incoming.quoteOfId,
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

function dateWindow(now: Date, days: number): { start: number; end: number } {
  const end = Date.prototype.getTime.call(now);
  if (!Number.isFinite(end)) throw new Error("Invalid refresh time");
  return { start: end - days * 24 * 60 * 60 * 1_000, end };
}

function isInsufficientBudget(error: unknown): boolean {
  return (
    error instanceof TikHubRequestBudgetError ||
    (error instanceof TikHubRequestLedgerError && error.code === "daily-limit")
  );
}

function abortedError(): TikHubClientError {
  return new TikHubClientError("aborted", "TikHub request was cancelled.");
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function isLocallyValidApiKey(value: string): boolean {
  return (
    value.length <= 4_096 &&
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
