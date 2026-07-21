import type { CollectedItem, SourceType } from "./collected-item";

export interface CollectionQueryInput {
  items: CollectedItem[];
  text?: string;
  sourceTypes?: SourceType[];
  topics?: string[];
  read?: boolean;
  starred?: boolean;
  saved?: boolean;
}

/**
 * Applies only user-selected filters to collection records. It deliberately
 * has no scoring, recommendation, or ranking model: ordering is a stable,
 * objective presentation order that makes results reproducible.
 */
export class CollectionQueryService {
  query(input: CollectionQueryInput): CollectedItem[] {
    const normalizedText = normalizeSearchText(input.text);
    const sourceTypes = new Set(input.sourceTypes ?? []);
    const topics = new Set((input.topics ?? []).map(normalizeSearchText));

    return input.items
      .filter((item) => {
        if (
          normalizedText &&
          !searchableFields(item).some((field) =>
            normalizeSearchText(field).includes(normalizedText),
          )
        ) {
          return false;
        }

        if (sourceTypes.size > 0 && !sourceTypes.has(item.sourceType)) {
          return false;
        }

        // Multiple selected topics are alternatives within the topic filter;
        // every distinct filter group is still combined with AND semantics.
        if (
          topics.size > 0 &&
          !item.topics.some((topic) => topics.has(normalizeSearchText(topic)))
        ) {
          return false;
        }

        return (
          (input.read === undefined || item.read === input.read) &&
          (input.starred === undefined || item.starred === input.starred) &&
          (input.saved === undefined || item.saved === input.saved)
        );
      })
      .slice()
      .sort(compareCollectionItems);
  }
}

function searchableFields(item: CollectedItem): string[] {
  return [
    item.title,
    item.author ?? "",
    item.sourceName,
    item.excerpt ?? "",
    ...item.topics,
  ];
}

function normalizeSearchText(value: string | undefined): string {
  return (value ?? "").normalize("NFKC").toLocaleLowerCase().trim();
}

function compareCollectionItems(a: CollectedItem, b: CollectedItem): number {
  const aTimestamp = collectionTimestamp(a);
  const bTimestamp = collectionTimestamp(b);
  if (aTimestamp !== bTimestamp) {
    // Invalid timestamps use negative infinity and therefore follow every
    // valid date. Avoid subtracting two infinities (NaN), which would skip
    // the required title/ID tie-breakers for two invalid records.
    if (aTimestamp === Number.NEGATIVE_INFINITY) return 1;
    if (bTimestamp === Number.NEGATIVE_INFINITY) return -1;
    return bTimestamp - aTimestamp;
  }

  const byTitle = compareText(a.title, b.title);
  if (byTitle !== 0) {
    return byTitle;
  }

  return compareText(a.id, b.id);
}

function collectionTimestamp(item: CollectedItem): number {
  // `publishedAt ?? fetchedAt` is intentionally literal. A present but invalid
  // published timestamp sorts after all valid timestamps instead of silently
  // becoming a different date. This makes malformed source data observable and
  // keeps ordering deterministic.
  const parsed = Date.parse(item.publishedAt ?? item.fetchedAt);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function compareText(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}
