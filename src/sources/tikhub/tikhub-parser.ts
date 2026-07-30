import type { XPost } from "./x-post";

export interface TikHubTimelineParseResult {
  posts: XPost[];
  warnings: string[];
  candidateCount: number;
  nextCursor?: string;
}

const MAX_WALK_DEPTH = 32;
const MAX_WALK_NODES = 25_000;
const MAX_ARRAY_ENTRIES = 100_000;
const MAX_OBJECT_PROPERTIES = 10_000;
const MAX_CURSOR_LENGTH = 4_096;
const X_HANDLE = /^[A-Za-z0-9_]{1,15}$/;

/** Converts untrusted TikHub GraphQL timeline data into provider-neutral records. */
export function parseTikHubTimeline(payload: unknown): TikHubTimelineParseResult {
  const warnings: string[] = [];
  const posts: XPost[] = [];
  const bottomCursors: string[] = [];
  let candidateCount = 0;
  const instructionArrays = findNamedArrays(payload, "instructions");

  for (const instructions of instructionArrays) {
    for (const instruction of ownArrayValues(instructions)) {
      const entries = ownArray(ownValue(instruction, "entries"));
      if (!entries) continue;

      for (const entry of ownArrayValues(entries)) {
        if (isCursorEntry(entry)) {
          if (isBottomCursorEntry(entry)) {
            const cursor = bottomCursor(entry);
            if (cursor) bottomCursors.push(cursor);
            else warnings.push("Skipped an invalid X timeline cursor.");
          }
          continue;
        }
        const candidates = findTweetResults(entry);
        candidateCount += candidates.length;
        if (candidates.length === 0) {
          warnings.push("Skipped an unknown X timeline entry.");
          continue;
        }

        for (const candidate of candidates) {
          if (isUnavailable(candidate)) {
            warnings.push("Skipped an unavailable X post.");
            continue;
          }
          const post = parseTweetResult(candidate);
          if (!post) {
            warnings.push("Skipped a malformed X post.");
            continue;
          }
          posts.push(post);
        }
      }
    }
  }

  if (bottomCursors.length > 1) {
    warnings.push("Stopped X pagination because the timeline cursor was ambiguous.");
  }
  return {
    posts,
    warnings,
    candidateCount,
    ...(bottomCursors.length === 1 ? { nextCursor: bottomCursors[0] } : {}),
  };
}

function parseTweetResult(candidate: unknown): XPost | undefined {
  const tweet = unwrapTweet(candidate);
  if (!tweet) return undefined;

  const id = xPostId(ownValue(tweet, "rest_id"));
  const legacy = ownRecord(ownValue(tweet, "legacy"));
  const userLegacy = findUserLegacy(tweet);
  const authorHandle = requiredString(ownValue(userLegacy, "screen_name"));
  const noteResult = ownRecord(
    path(tweet, "note_tweet", "note_tweet_results", "result"),
  );
  const text =
    requiredString(ownValue(noteResult, "text")) ??
    requiredString(ownValue(legacy, "full_text"));

  if (!id || !legacy || !authorHandle || !X_HANDLE.test(authorHandle) || !text) {
    return undefined;
  }

  const authorName = optionalString(ownValue(userLegacy, "name"));
  const createdAt = normalizeDate(ownValue(legacy, "created_at"));
  const conversationId = xPostId(
    ownValue(legacy, "conversation_id_str"),
  );
  const inReplyToId = xPostId(
    ownValue(legacy, "in_reply_to_status_id_str"),
  );
  const repostOfId = nestedTweetId(ownValue(legacy, "retweeted_status_result"));
  const quoteOfId = nestedTweetId(
    ownValue(legacy, "quoted_status_result") ??
      ownValue(tweet, "quoted_status_result"),
  );

  return withoutUndefined({
    id,
    authorHandle,
    authorName,
    text,
    createdAt,
    url: `https://x.com/${authorHandle}/status/${id}`,
    conversationId,
    inReplyToId,
    repostOfId,
    quoteOfId,
    externalUrls: extractExternalUrls(legacy, noteResult),
    metrics: withoutUndefined({
      replies: nonNegativeInteger(ownValue(legacy, "reply_count")),
      reposts: nonNegativeInteger(ownValue(legacy, "retweet_count")),
      likes: nonNegativeInteger(ownValue(legacy, "favorite_count")),
      quotes: nonNegativeInteger(ownValue(legacy, "quote_count")),
      views: nonNegativeInteger(path(tweet, "views", "count")),
    }),
  });
}

function unwrapTweet(candidate: unknown): Record<string, unknown> | undefined {
  const record = ownRecord(candidate);
  if (!record) return undefined;
  const typename = optionalString(ownValue(record, "__typename"));
  if (typename === "TweetWithVisibilityResults") {
    return ownRecord(ownValue(record, "tweet"));
  }
  return record;
}

function findUserLegacy(
  tweet: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return (
    ownRecord(path(tweet, "core", "user_results", "result", "legacy")) ??
    ownRecord(path(tweet, "core", "user_result", "result", "legacy"))
  );
}

function nestedTweetId(value: unknown): string | undefined {
  const result = ownRecord(ownValue(value, "result"));
  const tweet = unwrapTweet(result);
  return xPostId(ownValue(tweet, "rest_id"));
}

function findTweetResults(entry: unknown): unknown[] {
  const results: unknown[] = [];
  walkOwnData(entry, (record) => {
    for (const key of ["tweet_results", "tweetResult"]) {
      const container = ownRecord(ownValue(record, key));
      if (!container) continue;
      const result = ownValue(container, "result");
      if (result !== undefined) results.push(result);
      return false;
    }
    return true;
  });
  return results;
}

function findNamedArrays(payload: unknown, key: string): unknown[][] {
  const arrays: unknown[][] = [];
  walkOwnData(payload, (record) => {
    const candidate = ownArray(ownValue(record, key));
    if (candidate) arrays.push(candidate);
    return true;
  });
  return arrays;
}

function walkOwnData(
  root: unknown,
  visit: (record: Record<string, unknown>) => boolean,
): void {
  const seen = new WeakSet<object>();
  const stack: Array<{ value: unknown; depth: number }> = [
    { value: root, depth: 0 },
  ];
  let visited = 0;

  while (stack.length > 0 && visited < MAX_WALK_NODES) {
    const current = stack.pop();
    if (!current || current.depth > MAX_WALK_DEPTH) continue;
    const value = current.value;
    if ((typeof value !== "object" && typeof value !== "function") || value === null) {
      continue;
    }
    if (seen.has(value)) continue;
    seen.add(value);
    visited += 1;

    if (Array.isArray(value)) {
      const values = ownArrayValues(value);
      for (let index = values.length - 1; index >= 0; index -= 1) {
        stack.push({ value: values[index], depth: current.depth + 1 });
      }
      continue;
    }

    const record = value as Record<string, unknown>;
    if (!visit(record)) continue;
    const properties = ownEnumerableKeys(record);
    if (properties.length > MAX_OBJECT_PROPERTIES) continue;
    for (const property of properties) {
      const child = ownValue(record, property);
      if (child !== undefined) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
}

function isCursorEntry(entry: unknown): boolean {
  const entryId = optionalString(ownValue(entry, "entryId"));
  if (entryId?.toLowerCase().startsWith("cursor-")) return true;
  const content = ownRecord(ownValue(entry, "content"));
  const entryType = optionalString(ownValue(content, "entryType"));
  const cursorType = optionalString(ownValue(content, "cursorType"));
  return entryType === "TimelineTimelineCursor" || cursorType !== undefined;
}

function isBottomCursorEntry(entry: unknown): boolean {
  const entryId = ownValue(entry, "entryId");
  const content = ownRecord(ownValue(entry, "content"));
  const cursorType = ownValue(content, "cursorType");
  return cursorType === "Bottom" ||
    (typeof entryId === "string" &&
      entryId.toLowerCase().startsWith("cursor-bottom"));
}

function bottomCursor(entry: unknown): string | undefined {
  const content = ownRecord(ownValue(entry, "content"));
  const value = ownValue(content, "value");
  return typeof value === "string" &&
      value.length > 0 &&
      value.length <= MAX_CURSOR_LENGTH &&
      isPrintable(value)
    ? value
    : undefined;
}

function isPrintable(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      codePoint <= 31 ||
      (codePoint >= 127 && codePoint <= 159)
    ) {
      return false;
    }
  }
  return true;
}

function isUnavailable(candidate: unknown): boolean {
  const record = ownRecord(candidate);
  const typename = optionalString(ownValue(record, "__typename"));
  return (
    typename === "TweetUnavailable" ||
    typename === "TweetTombstone" ||
    typename === "TweetDeleted"
  );
}

function extractExternalUrls(
  legacy: Record<string, unknown>,
  noteResult: Record<string, unknown> | undefined,
): string[] {
  const urls = new Set<string>();
  addUrlEntities(urls, ownValue(ownRecord(ownValue(legacy, "entities")), "urls"));
  addUrlEntities(
    urls,
    ownValue(ownRecord(ownValue(noteResult, "entity_set")), "urls"),
  );
  return [...urls];
}

function addUrlEntities(destination: Set<string>, value: unknown): void {
  const entities = ownArray(value);
  if (!entities) return;
  for (const entity of ownArrayValues(entities)) {
    const expanded =
      optionalString(ownValue(entity, "expanded_url")) ??
      optionalString(ownValue(entity, "unwound_url")) ??
      optionalString(ownValue(entity, "expandedUrl"));
    const normalized = externalHttpUrl(expanded);
    if (normalized) destination.add(normalized);
  }
}

function externalHttpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password
    ) {
      return undefined;
    }
    const host = url.hostname.toLowerCase();
    if (
      host === "t.co" ||
      host === "x.com" ||
      host.endsWith(".x.com") ||
      host === "twitter.com" ||
      host.endsWith(".twitter.com")
    ) {
      return undefined;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function normalizeDate(value: unknown): string | undefined {
  const raw = optionalString(value);
  if (!raw) return undefined;
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

function path(root: unknown, ...keys: string[]): unknown {
  let current = root;
  for (const key of keys) current = ownValue(current, key);
  return current;
}

function ownValue(value: unknown, key: string): unknown {
  if (
    (typeof value !== "object" && typeof value !== "function") ||
    value === null
  ) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function ownRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function ownArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function ownArrayValues(value: unknown[]): unknown[] {
  if (value.length > MAX_ARRAY_ENTRIES) return [];
  const values: unknown[] = [];
  const keys = ownEnumerableKeys(value);
  if (keys.length > MAX_ARRAY_ENTRIES) return [];
  for (const key of keys) {
    if (!/^(?:0|[1-9]\d*)$/.test(key)) continue;
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index < 0 || index >= value.length) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) values.push(descriptor.value);
  }
  return values;
}

function ownEnumerableKeys(value: object): string[] {
  try {
    return Object.keys(value);
  } catch {
    return [];
  }
}

function requiredString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && !hasControlCharacter(normalized)
    ? normalized
    : undefined;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || code === 13) continue;
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function optionalString(value: unknown): string | undefined {
  return requiredString(value);
}

function xPostId(value: unknown): string | undefined {
  const id = requiredString(value);
  return id && /^\d{1,30}$/.test(id) ? id : undefined;
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}
