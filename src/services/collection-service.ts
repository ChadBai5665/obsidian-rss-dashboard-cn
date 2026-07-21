import type { CollectedItem } from "../collection/collected-item";
import {
  createFeedItemMaterialFingerprint,
  normalizeFeedItem,
} from "../collection/feed-normalizer";
import { toLocalCalendarDate } from "../refresh/local-calendar-day";
import type { Feed, FeedItem } from "../types/types";

interface CollectionRepositoryPort {
  upsertDaily(
    items: CollectedItem[],
    localDate: string,
  ): Promise<CollectedItem[]>;
  hasItemsForSource(sourceId: string): Promise<boolean>;
}

interface DailyIndexPort {
  writeDailyIndex(input: {
    localDate: string;
    items: CollectedItem[];
  }): Promise<string>;
}

interface RefreshLedgerPort {
  recordSuccess(sourceId: string, succeededAt: Date): Promise<void>;
}

interface CollectionServiceDependencies {
  repository: CollectionRepositoryPort;
  dailyIndex: DailyIndexPort;
  ledger: RefreshLedgerPort;
  normalize?: typeof normalizeFeedItem;
}

export class CollectionService {
  private readonly normalize: typeof normalizeFeedItem;
  private collectionQueue: Promise<void> = Promise.resolve();

  constructor(private readonly dependencies: CollectionServiceDependencies) {
    this.normalize = dependencies.normalize ?? normalizeFeedItem;
  }

  async collectFeedRefresh(input: {
    feed: Feed;
    previousItems: FeedItem[];
    refreshedItems: FeedItem[];
    fetchedAt: Date;
  }): Promise<CollectedItem[]> {
    const operation = this.collectionQueue.then(() => this.collect(input));
    this.collectionQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return await operation;
  }

  private async collect(input: {
    feed: Feed;
    previousItems: FeedItem[];
    refreshedItems: FeedItem[];
    fetchedAt: Date;
  }): Promise<CollectedItem[]> {
    const sourceId = input.feed.feedId ?? input.feed.url;
    const normalizedItems = input.refreshedItems.map((item) => ({
      source: item,
      collected: this.normalize(input.feed, item, input.fetchedAt),
    }));
    const hasSuccessfulBootstrap =
      await this.dependencies.repository.hasItemsForSource(sourceId);
    const collected = hasSuccessfulBootstrap
      ? this.collectChanges(input, normalizedItems)
      : normalizedItems.map(({ collected }) => collected);
    const localDate = toLocalCalendarDate(input.fetchedAt);

    const storedDailyItems = await this.dependencies.repository.upsertDaily(
      collected,
      localDate,
    );
    await this.dependencies.dailyIndex.writeDailyIndex({
      localDate,
      items: storedDailyItems,
    });
    await this.dependencies.ledger.recordSuccess(sourceId, input.fetchedAt);

    return collected;
  }

  private collectChanges(
    input: {
      feed: Feed;
      previousItems: FeedItem[];
      refreshedItems: FeedItem[];
      fetchedAt: Date;
    },
    normalizedItems: Array<{
      source: FeedItem;
      collected: CollectedItem;
    }>,
  ): CollectedItem[] {
    const previousById = new Map(
      input.previousItems.map((item) => [
        this.normalize(input.feed, item, input.fetchedAt).id,
        item,
      ]),
    );

    const changes: CollectedItem[] = [];
    for (const {
      source: refreshedItem,
      collected: normalized,
    } of normalizedItems) {
      const previousItem = previousById.get(normalized.id);
      if (!previousItem) {
        changes.push(normalized);
        continue;
      }

      if (
        createFeedItemMaterialFingerprint(previousItem) !==
        createFeedItemMaterialFingerprint(refreshedItem)
      ) {
        changes.push({ ...normalized, observationType: "updated" });
      }
    }
    return changes;
  }
}
