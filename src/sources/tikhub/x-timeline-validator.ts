import type { TikHubTimelineParseResult } from "./tikhub-parser";
import type { XPost } from "./x-post";

const POST_ID = /^\d{1,30}$/u;
const X_HANDLE = /^[A-Za-z0-9_]{1,15}$/u;
const POST_KEYS = new Set([
  "id",
  "authorHandle",
  "authorName",
  "text",
  "createdAt",
  "url",
  "conversationId",
  "inReplyToId",
  "repostOfId",
  "quoteOfId",
  "externalUrls",
  "metrics",
]);
const METRIC_KEYS = new Set(["replies", "reposts", "likes", "quotes", "views"]);
const REQUIRED_POST_KEYS = [
  "id",
  "authorHandle",
  "text",
  "url",
  "externalUrls",
  "metrics",
] as const;
const RELATION_KEYS = [
  "conversationId",
  "inReplyToId",
  "repostOfId",
  "quoteOfId",
] as const;
const MAX_POSTS = 100_000;
const MAX_TEXT_LENGTH = 1_000_000;
const MAX_CURSOR_LENGTH = 4_096;
const INVALID_POST_WARNING = "Skipped an invalid parsed X post.";

export class InvalidXTimelineError extends Error {
  readonly code = "invalid-x-timeline";

  constructor() {
    super("Invalid parsed X timeline data");
    this.name = "InvalidXTimelineError";
  }
}

/** Validates and clones the parser seam before account/topic semantics run. */
export function validateParsedXTimeline(value: unknown): TikHubTimelineParseResult {
  const record = plainRecord(value);
  if (
    !record ||
    (!hasExactKeys(record, ["posts", "warnings", "candidateCount"]) &&
      !hasExactKeys(record, ["posts", "warnings", "candidateCount", "nextCursor"]))
  ) {
    throw new InvalidXTimelineError();
  }
  const postsValue = ownData(record, "posts");
  const warningsValue = ownData(record, "warnings");
  const candidateCount = ownData(record, "candidateCount");
  const hasNextCursor = Object.prototype.hasOwnProperty.call(record, "nextCursor");
  const nextCursor = hasNextCursor
    ? ownData(record, "nextCursor")
    : undefined;
  const posts = denseOwnArray(postsValue, MAX_POSTS);
  const warnings = denseOwnArray(warningsValue, MAX_POSTS);
  if (
    !posts ||
    !warnings ||
    typeof candidateCount !== "number" ||
    !Number.isSafeInteger(candidateCount) ||
    candidateCount < 0 ||
    (hasNextCursor && !isPrintableCursor(nextCursor))
  ) {
    throw new InvalidXTimelineError();
  }

  const safeWarnings: string[] = [];
  for (const warning of warnings) {
    if (
      typeof warning !== "string" ||
      warning.length > 300 ||
      hasDisallowedControl(warning)
    ) {
      throw new InvalidXTimelineError();
    }
    safeWarnings.push(warning);
  }

  const safePosts: XPost[] = [];
  for (const candidate of posts) {
    let post: XPost | undefined;
    try {
      post = validatedPost(candidate);
    } catch {
      post = undefined;
    }
    if (post) safePosts.push(post);
    else safeWarnings.push(INVALID_POST_WARNING);
  }
  return {
    posts: safePosts,
    warnings: safeWarnings,
    candidateCount,
    ...(hasNextCursor && typeof nextCursor === "string" ? { nextCursor } : {}),
  };
}

function isPrintableCursor(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_CURSOR_LENGTH
  ) return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      codePoint <= 31 ||
      (codePoint >= 127 && codePoint <= 159)
    ) return false;
  }
  return true;
}

function validatedPost(value: unknown): XPost | undefined {
  const record = plainRecord(value);
  if (
    !record ||
    !hasAllowedKeys(record, POST_KEYS) ||
    !REQUIRED_POST_KEYS.every((key) => hasOwnData(record, key))
  ) {
    return undefined;
  }
  const id = ownData(record, "id");
  const authorHandle = ownData(record, "authorHandle");
  const authorName = optionalSafeString(record, "authorName", 512);
  const text = ownData(record, "text");
  const createdAt = optionalIsoDate(record, "createdAt");
  const url = ownData(record, "url");
  if (
    typeof id !== "string" ||
    !POST_ID.test(id) ||
    typeof authorHandle !== "string" ||
    !X_HANDLE.test(authorHandle) ||
    authorName === INVALID ||
    typeof text !== "string" ||
    !text.trim() ||
    text.length > MAX_TEXT_LENGTH ||
    hasDisallowedControl(text) ||
    createdAt === INVALID ||
    typeof url !== "string" ||
    url !== `https://x.com/${authorHandle}/status/${id}`
  ) {
    return undefined;
  }

  const relations: Partial<Pick<XPost, typeof RELATION_KEYS[number]>> = {};
  for (const key of RELATION_KEYS) {
    const relation = optionalPostId(record, key);
    if (relation === INVALID) return undefined;
    if (relation !== undefined) relations[key] = relation;
  }
  const externalUrls = validatedExternalUrls(ownData(record, "externalUrls"));
  const metrics = validatedMetrics(ownData(record, "metrics"));
  if (!externalUrls || !metrics) return undefined;

  return {
    id,
    authorHandle,
    ...(authorName === undefined ? {} : { authorName }),
    text,
    ...(createdAt === undefined ? {} : { createdAt }),
    url,
    ...relations,
    externalUrls,
    metrics,
  };
}

const INVALID = Symbol("invalid");

function optionalSafeString(
  record: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | undefined | typeof INVALID {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
  const value = ownData(record, key);
  return typeof value === "string" &&
    value.length <= maxLength &&
    !hasDisallowedControl(value)
    ? value
    : INVALID;
}

function optionalIsoDate(
  record: Record<string, unknown>,
  key: string,
): string | undefined | typeof INVALID {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
  const value = ownData(record, key);
  if (typeof value !== "string") return INVALID;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
    ? value
    : INVALID;
}

function optionalPostId(
  record: Record<string, unknown>,
  key: string,
): string | undefined | typeof INVALID {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
  const value = ownData(record, key);
  return typeof value === "string" && POST_ID.test(value) ? value : INVALID;
}

function validatedExternalUrls(value: unknown): string[] | undefined {
  const entries = denseOwnArray(value, 10_000);
  if (!entries) return undefined;
  const result: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string" || entry.length > 8_192) return undefined;
    try {
      const url = new URL(entry);
      if (
        (url.protocol !== "https:" && url.protocol !== "http:") ||
        url.username ||
        url.password ||
        url.toString() !== entry
      ) {
        return undefined;
      }
    } catch {
      return undefined;
    }
    result.push(entry);
  }
  return result;
}

function validatedMetrics(value: unknown): XPost["metrics"] | undefined {
  const record = plainRecord(value);
  if (!record || !hasAllowedKeys(record, METRIC_KEYS)) return undefined;
  const result: XPost["metrics"] = {};
  const keys = ownStringKeys(record);
  if (!keys) return undefined;
  for (const key of keys) {
    const metric = ownData(record, key);
    if (
      typeof metric !== "number" ||
      !Number.isSafeInteger(metric) ||
      metric < 0
    ) {
      return undefined;
    }
    result[key as keyof XPost["metrics"]] = metric;
  }
  return result;
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    const prototype = Reflect.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function denseOwnArray(value: unknown, maximum: number): unknown[] | undefined {
  try {
    if (!Array.isArray(value)) return undefined;
    if (Reflect.getPrototypeOf(value) !== Array.prototype) return undefined;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      !lengthDescriptor ||
      !("value" in lengthDescriptor) ||
      typeof lengthDescriptor.value !== "number" ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0 ||
      lengthDescriptor.value > maximum
    ) {
      return undefined;
    }
    const length = lengthDescriptor.value;
    const keys = Reflect.ownKeys(value);
    const expected = new Set<PropertyKey>([
      "length",
      ...Array.from({ length }, (_, index) => String(index)),
    ]);
    if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
      return undefined;
    }
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor)) return undefined;
      result.push(descriptor.value);
    }
    return result;
  } catch {
    return undefined;
  }
}

function hasExactKeys(record: Record<string, unknown>, expected: string[]): boolean {
  const keys = ownStringKeys(record);
  return keys !== undefined &&
    keys.length === expected.length &&
    expected.every((key) => keys.includes(key));
}

function hasAllowedKeys(record: Record<string, unknown>, allowed: Set<string>): boolean {
  const keys = ownStringKeys(record);
  return keys !== undefined && keys.every((key) => allowed.has(key));
}

function ownStringKeys(record: object): string[] | undefined {
  try {
    const keys = Reflect.ownKeys(record);
    return keys.every((key): key is string => typeof key === "string")
      ? keys
      : undefined;
  } catch {
    return undefined;
  }
}

function hasOwnData(record: Record<string, unknown>, key: string): boolean {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor !== undefined && "value" in descriptor;
  } catch {
    return false;
  }
}

function ownData(record: Record<string, unknown>, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function hasDisallowedControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint === 9 || codePoint === 10 || codePoint === 13) continue;
    if (codePoint <= 31 || codePoint === 127) return true;
  }
  return false;
}
