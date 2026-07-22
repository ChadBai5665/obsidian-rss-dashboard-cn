import type { CollectedItem } from "./collected-item";
import { mergeXPostSourceMetadata } from "./source-metadata";

export function mergeCollectedItems(
  previous: CollectedItem,
  incoming: CollectedItem,
): CollectedItem {
  return {
    ...previous,
    ...incoming,
    firstSeenAt: earliestTimestamp(previous.firstSeenAt, incoming.firstSeenAt),
    lastSeenAt: latestTimestamp(previous.lastSeenAt, incoming.lastSeenAt),
    topics: Array.from(new Set([...previous.topics, ...incoming.topics])),
    excerpt: preferNonEmpty(incoming.excerpt, previous.excerpt),
    contentPath: preferNonEmpty(incoming.contentPath, previous.contentPath),
    metrics: mergeMetrics(previous.metrics, incoming.metrics),
    sourceMetadata: mergeXPostSourceMetadata(
      previous.sourceMetadata,
      incoming.sourceMetadata,
    ),
    read: incoming.read,
    starred: previous.starred || incoming.starred,
    saved: previous.saved || incoming.saved,
    savedNotePath: preferNonEmpty(
      incoming.savedNotePath,
      previous.savedNotePath,
    ),
  };
}

function earliestTimestamp(left: string, right: string): string {
  return compareTimestamps(left, right) <= 0 ? left : right;
}

function latestTimestamp(left: string, right: string): string {
  return compareTimestamps(left, right) >= 0 ? left : right;
}

function compareTimestamps(left: string, right: string): number {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (!Number.isNaN(leftTime) && !Number.isNaN(rightTime)) {
    return leftTime - rightTime;
  }
  return left.localeCompare(right);
}

function preferNonEmpty(
  incoming: string | undefined,
  previous: string | undefined,
): string | undefined {
  if (incoming?.trim()) {
    return incoming;
  }
  if (previous?.trim()) {
    return previous;
  }
  return undefined;
}

function mergeMetrics(
  previous: Record<string, number> | undefined,
  incoming: Record<string, number> | undefined,
): Record<string, number> | undefined {
  if (!previous && !incoming) {
    return undefined;
  }
  return { ...previous, ...incoming };
}
