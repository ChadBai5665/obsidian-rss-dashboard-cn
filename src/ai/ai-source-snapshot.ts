import type { Feed, FeedItem } from "../types/types";
import {
  createCanonicalFeedItemId,
  isStableItemId,
  resolveFeedSourceId,
} from "../collection/item-identity";

const INVALID = Symbol("invalid-ai-source-data");

/**
 * One deliberately conservative budget covers ownership discovery and the
 * selected-item clone. It is comfortably above normal feed/item JSON while
 * bounding adversarial depth, width, text, and cross-feed scan work.
 */
export const AI_SOURCE_SNAPSHOT_LIMITS = Object.freeze({
  maxDepth: 48,
  maxNodes: 20_000,
  maxKeys: 20_000,
  maxCharacters: 2_000_000,
  maxBytes: 4_000_000,
  maxArrayEntries: 100_000,
  maxFeeds: 4_096,
  maxItems: 100_000,
  maxOwnershipComparisons: 100_000,
});

type SafeClone =
  | null
  | undefined
  | string
  | number
  | boolean
  | SafeClone[]
  | { [key: string]: SafeClone };

interface WorkBudget {
  nodes: number;
  keys: number;
  characters: number;
  bytes: number;
  arrayEntries: number;
  feeds: number;
  items: number;
  ownershipComparisons: number;
  failed: boolean;
}

interface FeedScan {
  feed: Feed;
  items?: unknown[];
  referenceCount: number;
  sourceId?: string;
  url?: string;
}

interface IdentitySnapshot {
  title: string;
  link: string;
  guid: string;
  pubDate: string;
  author?: string;
  rssDashboardSourceId?: string;
  rssDashboardId?: string;
}

export interface AiSourceSnapshot {
  /** Immutable, own-data-only source metadata used by normalization and saving. */
  feed: Feed;
  /** Immutable, recursively own-data-only item captured when the modal opens. */
  item: FeedItem;
  /** Canonical ID derived without consulting a stored rssDashboardId. */
  expectedStableId: string;
  /** Exact owning source and item references, retained only for save revalidation. */
  originalOwner: Feed;
  originalTarget: FeedItem;
}

/**
 * Resolves ownership and snapshots every selected source value before any
 * normalizer, modal, or saver can observe it. No accessor is invoked. Stored
 * stable IDs are validation inputs only and never choose cached content.
 */
export function resolveAndSnapshotAiSource(
  feeds: Feed[],
  selected: FeedItem,
): AiSourceSnapshot | undefined {
  const budget = createWorkBudget();
  const item = snapshotFeedItem(selected, budget);
  const candidates = denseOwnArrayValues(
    feeds,
    budget,
    AI_SOURCE_SNAPSHOT_LIMITS.maxFeeds,
    "feeds",
  );
  if (!item || !candidates || budget.failed) return undefined;

  const scans: FeedScan[] = [];
  for (const candidate of candidates) {
    if (!isObject(candidate)) continue;
    const items = ownCandidateItems(candidate, budget);
    if (budget.failed) return undefined;
    let referenceCount = 0;
    if (items) {
      for (const current of items) {
        if (!spend(budget, "ownershipComparisons", 1)) return undefined;
        if (current === selected) referenceCount += 1;
      }
    }
    const feedId = ownCandidateString(candidate, "feedId", budget)?.trim();
    const url = ownCandidateString(candidate, "url", budget);
    scans.push({
      feed: candidate as Feed,
      items,
      referenceCount,
      sourceId: feedId || url?.trim() || undefined,
      url,
    });
    if (budget.failed) return undefined;
  }

  const ownerScan = resolveOwnerScan(scans, item);
  if (!ownerScan?.items) return undefined;
  const feedBase = snapshotFeedBase(ownerScan.feed, budget);
  if (!feedBase || budget.failed) return undefined;

  const sourceId = safeResolveFeedSourceId(feedBase);
  if (!sourceId) return undefined;
  const storedSourceId = ownSnapshotString(item, "rssDashboardSourceId")?.trim();
  if (storedSourceId && storedSourceId !== sourceId) return undefined;
  item.rssDashboardSourceId = sourceId;

  const expectedStableId = deriveExpectedStableId(feedBase, item);
  if (!expectedStableId) return undefined;
  const storedStableId = ownSnapshotValue(item, "rssDashboardId");
  if (
    storedStableId !== undefined &&
    (typeof storedStableId !== "string" ||
      !isStableItemId(storedStableId) ||
      storedStableId !== expectedStableId)
  ) return undefined;
  item.rssDashboardId = expectedStableId;

  const originalTarget = bindCanonicalOriginalTarget(
    ownerScan.items,
    feedBase,
    expectedStableId,
    budget,
  );
  if (!originalTarget || budget.failed) return undefined;

  deepFreeze(item);
  const feed = Object.freeze({
    ...feedBase,
    items: Object.freeze([item]) as unknown as FeedItem[],
  });
  return Object.freeze({
    feed,
    item,
    expectedStableId,
    originalOwner: ownerScan.feed,
    originalTarget,
  });
}

/** Creates a fresh mutable saver/normalizer input from an immutable snapshot. */
export function cloneAiSourceItem(snapshot: FeedItem): FeedItem {
  const clone = snapshotFeedItem(snapshot, createWorkBudget());
  if (!clone) throw new Error("AI source snapshot is invalid");
  return clone;
}

/**
 * Re-resolves the exact object binding immediately before a save. Any source
 * replacement, removal, mutation, collision, or unsafe structure fails closed.
 */
export function revalidateAiSourceForSave(
  feeds: Feed[],
  opening: AiSourceSnapshot,
): FeedItem | undefined {
  const current = resolveAndSnapshotAiSource(feeds, opening.originalTarget);
  if (
    !current ||
    current.originalOwner !== opening.originalOwner ||
    current.originalTarget !== opening.originalTarget ||
    current.expectedStableId !== opening.expectedStableId ||
    !sameFeedIdentity(current.feed, opening.feed) ||
    !sameItemIdentity(current.item, opening.item)
  ) return undefined;
  return current.originalTarget;
}

function createWorkBudget(): WorkBudget {
  return {
    nodes: 0,
    keys: 0,
    characters: 0,
    bytes: 0,
    arrayEntries: 0,
    feeds: 0,
    items: 0,
    ownershipComparisons: 0,
    failed: false,
  };
}

function spend(
  budget: WorkBudget,
  field: keyof Omit<WorkBudget, "failed">,
  amount: number,
): boolean {
  const limit = field === "nodes"
    ? AI_SOURCE_SNAPSHOT_LIMITS.maxNodes
    : field === "keys"
      ? AI_SOURCE_SNAPSHOT_LIMITS.maxKeys
      : field === "characters"
        ? AI_SOURCE_SNAPSHOT_LIMITS.maxCharacters
        : field === "bytes"
          ? AI_SOURCE_SNAPSHOT_LIMITS.maxBytes
          : field === "arrayEntries"
            ? AI_SOURCE_SNAPSHOT_LIMITS.maxArrayEntries
            : field === "feeds"
              ? AI_SOURCE_SNAPSHOT_LIMITS.maxFeeds
              : field === "items"
                ? AI_SOURCE_SNAPSHOT_LIMITS.maxItems
                : AI_SOURCE_SNAPSHOT_LIMITS.maxOwnershipComparisons;
  if (!Number.isSafeInteger(amount) || amount < 0 || budget[field] > limit - amount) {
    budget.failed = true;
    return false;
  }
  budget[field] += amount;
  return true;
}

function spendString(budget: WorkBudget, value: string): boolean {
  if (!spend(budget, "characters", value.length)) return false;
  const remainingBytes = AI_SOURCE_SNAPSHOT_LIMITS.maxBytes - budget.bytes;
  const bytes = utf8ByteLengthAtMost(value, remainingBytes);
  return bytes !== undefined && spend(budget, "bytes", bytes);
}

function utf8ByteLengthAtMost(
  value: string,
  maximum: number,
): number | undefined {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else bytes += 3;
    if (bytes > maximum) return undefined;
  }
  return bytes;
}

function resolveOwnerScan(
  scans: FeedScan[],
  item: FeedItem,
): FeedScan | undefined {
  const referenceMatches = scans.filter(({ referenceCount }) => referenceCount > 0);
  if (referenceMatches.length > 0) {
    return referenceMatches.length === 1 ? referenceMatches[0] : undefined;
  }

  const sourceId = ownSnapshotString(item, "rssDashboardSourceId")?.trim();
  if (sourceId) {
    const sourceMatches = scans.filter((scan) => scan.sourceId === sourceId);
    if (sourceMatches.length > 0) {
      return sourceMatches.length === 1 ? sourceMatches[0] : undefined;
    }
  }

  const feedUrl = ownSnapshotString(item, "feedUrl");
  if (!feedUrl) return undefined;
  const urlMatches = scans.filter((scan) => scan.url === feedUrl);
  return urlMatches.length === 1 ? urlMatches[0] : undefined;
}

function snapshotFeedBase(
  feed: Feed,
  budget: WorkBudget,
): Omit<Feed, "items"> & { sourceType?: string } | undefined {
  if (!isPlainRecord(feed) || !spend(budget, "nodes", 1)) return undefined;
  const feedId = optionalOwnString(feed, "feedId", budget);
  const title = requiredOwnString(feed, "title", budget);
  const url = requiredOwnString(feed, "url", budget);
  const folder = requiredOwnString(feed, "folder", budget);
  const author = optionalOwnString(feed, "author", budget);
  const mediaType = optionalOwnString(feed, "mediaType", budget);
  const sourceType = optionalOwnString(feed, "sourceType", budget);
  const customTemplate = optionalOwnString(feed, "customTemplate", budget);
  const customFolder = optionalOwnString(feed, "customFolder", budget);
  if (
    feedId === INVALID || title === INVALID || url === INVALID ||
    folder === INVALID || author === INVALID || mediaType === INVALID ||
    sourceType === INVALID || customTemplate === INVALID || customFolder === INVALID
  ) return undefined;
  return {
    ...(feedId !== undefined ? { feedId } : {}),
    ...(sourceType !== undefined ? { sourceType } : {}),
    title,
    url,
    folder,
    lastUpdated: 0,
    ...(author !== undefined ? { author } : {}),
    ...(mediaType !== undefined
      ? { mediaType: mediaType as Feed["mediaType"] }
      : {}),
    ...(customTemplate !== undefined ? { customTemplate } : {}),
    ...(customFolder !== undefined ? { customFolder } : {}),
  };
}

function snapshotFeedItem(
  item: FeedItem,
  budget: WorkBudget,
): FeedItem | undefined {
  const clone = cloneOwnData(item, budget, new WeakSet(), 0);
  if (
    clone === INVALID || !isObject(clone) || Array.isArray(clone) || budget.failed
  ) return undefined;
  const snapshot = clone as unknown as FeedItem;
  for (const field of [
    "title", "link", "description", "pubDate", "guid", "feedTitle",
    "feedUrl", "coverImage",
  ] as const) {
    if (typeof ownSnapshotValue(snapshot, field) !== "string") return undefined;
  }
  return snapshot;
}

function cloneOwnData(
  value: unknown,
  budget: WorkBudget,
  seen: WeakSet<object>,
  depth: number,
): SafeClone | typeof INVALID {
  if (depth > AI_SOURCE_SNAPSHOT_LIMITS.maxDepth) {
    budget.failed = true;
    return INVALID;
  }
  if (value === null || value === undefined || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return spendString(budget, value) ? value : INVALID;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : INVALID;
  }
  if (!isObject(value) || seen.has(value) || !spend(budget, "nodes", 1)) {
    budget.failed = true;
    return INVALID;
  }

  try {
    seen.add(value);
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return INVALID;
      const entries = denseOwnArrayValues(
        value,
        budget,
        AI_SOURCE_SNAPSHOT_LIMITS.maxArrayEntries,
        "arrayEntries",
      );
      if (!entries) return INVALID;
      const result: SafeClone[] = [];
      for (const entry of entries) {
        const cloned = cloneOwnData(entry, budget, seen, depth + 1);
        if (cloned === INVALID) return INVALID;
        result.push(cloned);
      }
      return result;
    }

    if (!isPlainRecord(value)) return INVALID;
    const keys = Reflect.ownKeys(value);
    if (
      keys.some((key) => typeof key !== "string") ||
      !spend(budget, "keys", keys.length)
    ) return INVALID;
    const result: Record<string, SafeClone> = {};
    for (const key of keys as string[]) {
      if (!spendString(budget, key)) return INVALID;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return INVALID;
      const cloned = cloneOwnData(descriptor.value, budget, seen, depth + 1);
      if (cloned === INVALID) return INVALID;
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: cloned,
      });
    }
    return result;
  } catch {
    return INVALID;
  }
}

function denseOwnArrayValues(
  value: unknown,
  budget: WorkBudget,
  maximum: number,
  category: "feeds" | "items" | "arrayEntries",
): unknown[] | undefined {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      return undefined;
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const length: unknown = lengthDescriptor && "value" in lengthDescriptor
      ? lengthDescriptor.value as unknown
      : undefined;
    if (
      typeof length !== "number" || !Number.isSafeInteger(length) ||
      length < 0 || length > maximum || !spend(budget, category, length) ||
      !spend(budget, "arrayEntries", category === "arrayEntries" ? 0 : length)
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

function ownCandidateItems(
  feed: object,
  budget: WorkBudget,
): unknown[] | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(feed, "items");
    return descriptor && "value" in descriptor
      ? denseOwnArrayValues(
          descriptor.value,
          budget,
          AI_SOURCE_SNAPSHOT_LIMITS.maxItems,
          "items",
        )
      : undefined;
  } catch {
    return undefined;
  }
}

function ownCandidateString(
  value: object,
  key: string,
  budget: WorkBudget,
): string | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor || !("value" in descriptor) ||
      typeof descriptor.value !== "string"
    ) return undefined;
    return spendString(budget, descriptor.value) ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function bindCanonicalOriginalTarget(
  items: unknown[],
  feed: Pick<Feed, "feedId" | "url"> & { sourceType?: unknown },
  expectedStableId: string,
  budget: WorkBudget,
): FeedItem | undefined {
  const matches: FeedItem[] = [];
  for (const candidate of items) {
    if (!spend(budget, "ownershipComparisons", 1)) return undefined;
    if (!isObject(candidate) || !isPlainRecord(candidate)) continue;
    const identity = snapshotIdentity(candidate, budget);
    if (!identity || budget.failed) return undefined;
    const candidateExpected = deriveExpectedStableId(feed, identity);
    if (!candidateExpected) return undefined;
    if (
      identity.rssDashboardSourceId &&
      identity.rssDashboardSourceId.trim() !== safeResolveFeedSourceId(feed)
    ) return undefined;
    if (
      identity.rssDashboardId !== undefined &&
      (!isStableItemId(identity.rssDashboardId) ||
        identity.rssDashboardId !== candidateExpected)
    ) return undefined;
    if (candidateExpected === expectedStableId) matches.push(candidate as FeedItem);
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function snapshotIdentity(
  value: object,
  budget: WorkBudget,
): IdentitySnapshot | undefined {
  const title = requiredOwnString(value, "title", budget);
  const link = requiredOwnString(value, "link", budget);
  const guid = requiredOwnString(value, "guid", budget);
  const pubDate = requiredOwnString(value, "pubDate", budget);
  const author = optionalOwnString(value, "author", budget);
  const rssDashboardSourceId = optionalOwnString(
    value,
    "rssDashboardSourceId",
    budget,
  );
  const rssDashboardId = optionalOwnString(value, "rssDashboardId", budget);
  if (
    title === INVALID || link === INVALID || guid === INVALID ||
    pubDate === INVALID || author === INVALID ||
    rssDashboardSourceId === INVALID || rssDashboardId === INVALID
  ) return undefined;
  return {
    title,
    link,
    guid,
    pubDate,
    ...(author !== undefined ? { author } : {}),
    ...(rssDashboardSourceId !== undefined ? { rssDashboardSourceId } : {}),
    ...(rssDashboardId !== undefined ? { rssDashboardId } : {}),
  };
}

function deriveExpectedStableId(
  feed: Pick<Feed, "feedId" | "url"> & { sourceType?: unknown },
  item: Pick<FeedItem, "title" | "link" | "guid" | "author" | "pubDate">,
): string | undefined {
  try {
    return createCanonicalFeedItemId({
      sourceType: typeof feed.sourceType === "string" ? feed.sourceType : "rss",
      sourceId: resolveFeedSourceId(feed),
      item,
    });
  } catch {
    return undefined;
  }
}

function safeResolveFeedSourceId(
  feed: Pick<Feed, "feedId" | "url">,
): string | undefined {
  try {
    return resolveFeedSourceId(feed);
  } catch {
    return undefined;
  }
}

function requiredOwnString(
  value: object,
  key: string,
  budget: WorkBudget,
): string | typeof INVALID {
  const result = optionalOwnString(value, key, budget);
  return typeof result === "string" ? result : INVALID;
}

function optionalOwnString(
  value: object,
  key: string,
  budget: WorkBudget,
): string | undefined | typeof INVALID {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return undefined;
    if (!("value" in descriptor)) return INVALID;
    const candidate: unknown = descriptor.value;
    if (candidate === undefined) return undefined;
    if (typeof candidate !== "string") return INVALID;
    return spendString(budget, candidate) ? candidate : INVALID;
  } catch {
    return INVALID;
  }
}

function sameFeedIdentity(left: Feed, right: Feed): boolean {
  return [
    "feedId", "title", "url", "folder", "author", "mediaType",
    "sourceType", "customTemplate", "customFolder",
  ].every((key) => ownSnapshotValue(left, key) === ownSnapshotValue(right, key));
}

function sameItemIdentity(left: FeedItem, right: FeedItem): boolean {
  return [
    "rssDashboardId", "rssDashboardSourceId", "title", "link", "guid",
    "pubDate", "author", "feedTitle", "feedUrl",
  ].every((key) => ownSnapshotValue(left, key) === ownSnapshotValue(right, key));
}

function ownSnapshotString(value: object, key: string): string | undefined {
  const candidate = ownSnapshotValue(value, key);
  return typeof candidate === "string" ? candidate : undefined;
}

function ownSnapshotValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function deepFreeze(value: unknown): void {
  if (!isObject(value) || Object.isFrozen(value)) return;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) deepFreeze(descriptor.value);
  }
  Object.freeze(value);
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
