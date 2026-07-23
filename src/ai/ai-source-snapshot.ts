import type { Feed, FeedItem } from "../types/types";

const INVALID = Symbol("invalid-ai-source-data");
const MAX_ARRAY_LENGTH = 100_000;

type SafeClone =
  | null
  | undefined
  | string
  | number
  | boolean
  | SafeClone[]
  | { [key: string]: SafeClone };

export interface AiSourceSnapshot {
  /** Immutable, own-data-only source metadata used by normalization and saving. */
  feed: Feed;
  /** Immutable, recursively own-data-only item captured when the modal opens. */
  item: FeedItem;
  /** The exact original feed item to update after a successful snapshot save. */
  originalTarget?: FeedItem;
}

/**
 * Resolves ownership and snapshots every source value before any normalizer,
 * modal, or saver can observe it. Accessors, inherited records, sparse arrays,
 * and ambiguous identities all fail closed without invoking property accessors.
 */
export function resolveAndSnapshotAiSource(
  feeds: Feed[],
  selected: FeedItem,
): AiSourceSnapshot | undefined {
  const item = snapshotFeedItem(selected, true);
  const candidates = denseOwnArrayValues(feeds);
  if (!item || !candidates) return undefined;

  let owner: Feed | undefined;
  const referenceMatches = candidates.filter((candidate): candidate is Feed =>
    isObject(candidate) && safelyContainsReference(candidate, selected));
  if (referenceMatches.length > 0) {
    if (referenceMatches.length !== 1) return undefined;
    owner = referenceMatches[0];
  } else {
    const sourceId = ownSnapshotString(item, "rssDashboardSourceId")?.trim();
    if (sourceId) {
      const sourceMatches = candidates.filter((candidate): candidate is Feed =>
        isObject(candidate) && feedSourceIdentity(candidate) === sourceId);
      if (sourceMatches.length > 0) {
        if (sourceMatches.length !== 1) return undefined;
        owner = sourceMatches[0];
      }
    }

    if (!owner) {
      const feedUrl = ownSnapshotString(item, "feedUrl");
      if (!feedUrl) return undefined;
      const urlMatches = candidates.filter((candidate): candidate is Feed =>
        isObject(candidate) && ownCandidateString(candidate, "url") === feedUrl);
      if (urlMatches.length !== 1) return undefined;
      owner = urlMatches[0];
    }
  }

  const feed = snapshotFeed(owner, item);
  if (!feed) return undefined;
  const originalTarget = bindOriginalTarget(owner, selected, item);
  if (originalTarget === INVALID) return undefined;

  return Object.freeze({
    feed,
    item,
    ...(originalTarget ? { originalTarget } : {}),
  });
}

/** Creates a fresh mutable saver/normalizer input from an immutable snapshot. */
export function cloneAiSourceItem(snapshot: FeedItem): FeedItem {
  const clone = snapshotFeedItem(snapshot, false);
  if (!clone) throw new Error("AI source snapshot is invalid");
  return clone;
}

function snapshotFeed(feed: Feed, item: FeedItem): Feed | undefined {
  if (!isPlainRecord(feed)) return undefined;
  const items = ownCandidateItems(feed);
  if (!items) return undefined;

  const feedId = optionalOwnString(feed, "feedId");
  const title = requiredOwnString(feed, "title");
  const url = requiredOwnString(feed, "url");
  const folder = requiredOwnString(feed, "folder");
  const author = optionalOwnString(feed, "author");
  const mediaType = optionalOwnString(feed, "mediaType");
  const sourceType = optionalOwnString(feed, "sourceType");
  const customTemplate = optionalOwnString(feed, "customTemplate");
  const customFolder = optionalOwnString(feed, "customFolder");
  if (
    feedId === INVALID ||
    title === INVALID ||
    url === INVALID ||
    folder === INVALID ||
    author === INVALID ||
    mediaType === INVALID ||
    sourceType === INVALID ||
    customTemplate === INVALID ||
    customFolder === INVALID
  ) return undefined;

  const snapshot: Feed & { sourceType?: string } = {
    ...(feedId !== undefined ? { feedId } : {}),
    ...(sourceType !== undefined ? { sourceType } : {}),
    title,
    url,
    folder,
    items: Object.freeze([item]) as unknown as FeedItem[],
    lastUpdated: 0,
    ...(author !== undefined ? { author } : {}),
    ...(mediaType !== undefined
      ? { mediaType: mediaType as Feed["mediaType"] }
      : {}),
    ...(customTemplate !== undefined ? { customTemplate } : {}),
    ...(customFolder !== undefined ? { customFolder } : {}),
  };
  return Object.freeze(snapshot);
}

function snapshotFeedItem(
  item: FeedItem,
  freeze: boolean,
): FeedItem | undefined {
  const clone = cloneOwnData(item, new WeakSet(), freeze);
  if (clone === INVALID || !isObject(clone) || Array.isArray(clone)) {
    return undefined;
  }
  const snapshot = clone as unknown as FeedItem;
  for (const field of [
    "title",
    "link",
    "description",
    "pubDate",
    "guid",
    "feedTitle",
    "feedUrl",
    "coverImage",
  ] as const) {
    if (typeof ownSnapshotValue(snapshot, field) !== "string") return undefined;
  }
  return snapshot;
}

function cloneOwnData(
  value: unknown,
  ancestors: WeakSet<object>,
  freeze: boolean,
): SafeClone | typeof INVALID {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) return value;
  if (!isObject(value) || ancestors.has(value)) return INVALID;

  try {
    ancestors.add(value);
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return INVALID;
      const entries = denseOwnArrayValues(value);
      if (!entries) return INVALID;
      const result: SafeClone[] = [];
      for (const entry of entries) {
        const cloned = cloneOwnData(entry, ancestors, freeze);
        if (cloned === INVALID) return INVALID;
        result.push(cloned);
      }
      return freeze ? Object.freeze(result) as unknown as SafeClone[] : result;
    }

    if (!isPlainRecord(value)) return INVALID;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) return INVALID;
    const result: Record<string, SafeClone> = {};
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return INVALID;
      const cloned = cloneOwnData(descriptor.value, ancestors, freeze);
      if (cloned === INVALID) return INVALID;
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: cloned,
      });
    }
    return freeze ? Object.freeze(result) : result;
  } catch {
    return INVALID;
  } finally {
    ancestors.delete(value);
  }
}

function denseOwnArrayValues(value: unknown): unknown[] | undefined {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      return undefined;
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const length: unknown = lengthDescriptor && "value" in lengthDescriptor
      ? lengthDescriptor.value as unknown
      : undefined;
    if (
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > MAX_ARRAY_LENGTH
    ) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length + 1 || !keys.includes("length")) return undefined;

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

function safelyContainsReference(feed: object, selected: FeedItem): boolean {
  const items = ownCandidateItems(feed);
  return items ? items.some((candidate) => candidate === selected) : false;
}

function ownCandidateItems(feed: object): unknown[] | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(feed, "items");
    return descriptor && "value" in descriptor
      ? denseOwnArrayValues(descriptor.value)
      : undefined;
  } catch {
    return undefined;
  }
}

function feedSourceIdentity(feed: object): string | undefined {
  const feedId = ownCandidateString(feed, "feedId")?.trim();
  if (feedId) return feedId;
  return ownCandidateString(feed, "url")?.trim() || undefined;
}

function ownCandidateString(value: object, key: string): string | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor &&
        typeof descriptor.value === "string"
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function bindOriginalTarget(
  feed: Feed,
  selected: FeedItem,
  snapshot: FeedItem,
): FeedItem | undefined | typeof INVALID {
  const items = ownCandidateItems(feed);
  if (!items) return INVALID;
  const referenceMatches = items.filter((candidate) => candidate === selected);
  if (referenceMatches.length > 0) {
    return referenceMatches.length === 1 ? selected : INVALID;
  }

  const stableId = ownSnapshotString(snapshot, "rssDashboardId")?.trim();
  if (stableId) {
    const stableMatches = safeTargetMatches(items, "rssDashboardId", stableId);
    if (stableMatches.length > 0) {
      return stableMatches.length === 1 ? stableMatches[0] : INVALID;
    }
  }

  const guid = ownSnapshotString(snapshot, "guid")?.trim();
  if (!guid) return undefined;
  const guidMatches = safeTargetMatches(items, "guid", guid);
  return guidMatches.length <= 1 ? guidMatches[0] : INVALID;
}

function safeTargetMatches(
  items: unknown[],
  key: string,
  expected: string,
): FeedItem[] {
  const matches: FeedItem[] = [];
  for (const candidate of items) {
    if (!isObject(candidate)) continue;
    if (ownCandidateString(candidate, key) !== expected) continue;
    if (!snapshotFeedItem(candidate as FeedItem, true)) continue;
    matches.push(candidate as FeedItem);
  }
  return matches;
}

function requiredOwnString(
  value: object,
  key: string,
): string | typeof INVALID {
  const result = optionalOwnString(value, key);
  return typeof result === "string" ? result : INVALID;
}

function optionalOwnString(
  value: object,
  key: string,
): string | undefined | typeof INVALID {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return undefined;
    const candidate: unknown = "value" in descriptor
      ? descriptor.value as unknown
      : INVALID;
    return "value" in descriptor &&
        (candidate === undefined || typeof candidate === "string")
      ? candidate
      : INVALID;
  } catch {
    return INVALID;
  }
}

function ownSnapshotString(value: object, key: string): string | undefined {
  const candidate = ownSnapshotValue(value, key);
  return typeof candidate === "string" ? candidate : undefined;
}

function ownSnapshotValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function isPlainRecord(value: object): boolean {
  try {
    const prototype: unknown = Object.getPrototypeOf(value) as unknown;
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}
