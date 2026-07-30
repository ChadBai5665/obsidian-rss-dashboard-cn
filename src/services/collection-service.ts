import type { CollectedItem } from "../collection/collected-item";
import type { RemovedCollectionDay } from "../collection/collection-repository";
import type { DailyIndexSnapshot } from "../collection/daily-index-service";
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
  removeBySourceId(sourceId: string): Promise<RemovedCollectionDay[]>;
  restoreRemovedSource(days: RemovedCollectionDay[]): Promise<void>;
}

interface DailyIndexPort {
  writeDailyIndex(input: {
    localDate: string;
    items: CollectedItem[];
  }): Promise<string>;
  snapshotDailyIndex(localDate: string): Promise<DailyIndexSnapshot>;
  restoreDailyIndex(snapshot: DailyIndexSnapshot): Promise<void>;
}

interface RefreshLedgerPort {
  recordSuccess(sourceId: string, succeededAt: Date): Promise<void>;
}

interface CollectionServiceDependencies {
  repository: CollectionRepositoryPort;
  dailyIndex: DailyIndexPort;
  ledger: RefreshLedgerPort;
  normalize?: typeof normalizeFeedItem;
  isSourceActive?: (sourceId: string) => boolean;
}

export interface CollectionRemovalReceipt {
  days: RemovedCollectionDay[];
  commit(): Promise<void>;
  rollback(): Promise<void>;
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

  async removeSource(sourceId: string): Promise<CollectionRemovalReceipt> {
    let resolveReceipt!: (receipt: CollectionRemovalReceipt) => void;
    let rejectReceipt!: (error: unknown) => void;
    const receiptPromise = new Promise<CollectionRemovalReceipt>(
      (resolve, reject) => {
        resolveReceipt = resolve;
        rejectReceipt = reject;
      },
    );
    const operation = this.collectionQueue.then(async () => {
      try {
        const affected = await this.dependencies.repository.removeBySourceId(
          sourceId,
        );
        const dailySnapshots: DailyIndexSnapshot[] = [];
        try {
          for (const day of affected) {
            dailySnapshots.push(
              await this.dependencies.dailyIndex.snapshotDailyIndex(day.localDate),
            );
          }
          for (const day of affected) {
            await this.dependencies.dailyIndex.writeDailyIndex({
              localDate: day.localDate,
              items: day.remainingItems,
            });
          }
        } catch (purgeError) {
          const rollbackComplete = await this.rollbackRemoval(
            affected,
            dailySnapshots,
          );
          if (!rollbackComplete) {
            throw new Error("Source purge failed and rollback was incomplete");
          }
          throw purgeError;
        }

        let finalized = false;
        let releaseQueue!: () => void;
        const queueBarrier = new Promise<void>((resolve) => {
          releaseQueue = resolve;
        });
        const receipt: CollectionRemovalReceipt = {
          days: structuredClone(affected),
          commit: async (): Promise<void> => {
            if (finalized) return;
            finalized = true;
            releaseQueue();
          },
          rollback: async (): Promise<void> => {
            if (finalized) return;
            const complete = await this.rollbackRemoval(affected, dailySnapshots);
            finalized = true;
            releaseQueue();
            if (!complete) {
              throw new Error("Source purge rollback was incomplete");
            }
          },
        };
        resolveReceipt(receipt);
        await queueBarrier;
      } catch (purgeError) {
        rejectReceipt(purgeError);
        throw purgeError;
      }
    });
    this.collectionQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return await receiptPromise;
  }

  private async rollbackRemoval(
    affected: RemovedCollectionDay[],
    dailySnapshots: DailyIndexSnapshot[],
  ): Promise<boolean> {
    let complete = true;
    try {
      await this.dependencies.repository.restoreRemovedSource(affected);
    } catch {
      complete = false;
    }
    for (const snapshot of [...dailySnapshots].reverse()) {
      try {
        await this.dependencies.dailyIndex.restoreDailyIndex(snapshot);
      } catch {
        complete = false;
      }
    }
    return complete;
  }

  private async collect(input: {
    feed: Feed;
    previousItems: FeedItem[];
    refreshedItems: FeedItem[];
    fetchedAt: Date;
  }): Promise<CollectedItem[]> {
    const sourceId = input.feed.feedId ?? input.feed.url;
    if (this.dependencies.isSourceActive?.(sourceId) === false) {
      throw new Error("Collection source is no longer active");
    }
    const normalizedItems = input.refreshedItems.map((item) => ({
      source: item,
      collected: this.normalize(input.feed, item, input.fetchedAt),
    }));
    const hasSuccessfulBootstrap =
      await this.dependencies.repository.hasItemsForSource(sourceId);
    // Topic discovery is an observation snapshot, not a change feed. Passing
    // every in-window result lets the repository mark cross-day repeats as
    // rediscovered while its same-day merge still prevents duplicates.
    const collected = input.feed.sourceKind === "x-topic"
      ? normalizedItems.map(({ collected }) => collected)
      : hasSuccessfulBootstrap
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
