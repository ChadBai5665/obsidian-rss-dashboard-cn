import { createHash } from "crypto";
import { normalizePath, type DataAdapter, type Vault } from "obsidian";
import type { CollectedItem } from "./collected-item";
import { mergeCollectedItems } from "./collection-merge";
import { normalizeXPostSourceMetadata } from "./source-metadata";

interface ItemIndexEntry {
  earliestDate: string;
  latestDate: string;
}

interface ItemIndex {
  schemaVersion: 1;
  items: Record<string, ItemIndexEntry>;
}

interface ParsedCollection {
  items: CollectedItem[];
  corruptLines: string[];
}

interface PreparedRewrite {
  path: string;
  before: string;
  after: string;
}

export interface RemovedCollectionDay {
  localDate: string;
  previousItems: CollectedItem[];
  remainingItems: CollectedItem[];
}

interface QuarantineJournal {
  schemaVersion: 1;
  stage: "prepared" | "committed";
  sourceFingerprint: string;
  transactionId: string;
  sidecarAfter: string;
  cleanedCollection: string;
}

interface AtomicWriteOptions {
  retainedBackupPath?: string;
}

type FlagPatch = Pick<
  CollectedItem,
  "read" | "starred" | "saved" | "savedNotePath"
>;

const EMPTY_INDEX = (): ItemIndex => ({ schemaVersion: 1, items: {} });

const SOURCE_TYPES = new Set([
  "rss",
  "atom",
  "json",
  "podcast",
  "website",
  "youtube",
  "x-account",
  "x-topic",
]);

const CONTENT_BASES = new Set([
  "feed",
  "full-text",
  "title-description",
  "x-post",
  "linked-page",
]);

const COLLECTION_STATUSES = new Set(["collected", "partial", "parse-error"]);
const rootMutationQueues = new WeakMap<object, Map<string, Promise<void>>>();

export class CollectionRepository {
  private readonly dataRoot: string;
  private tempSequence = 0;

  constructor(
    private readonly vault: Vault,
    dataRoot: string,
    private readonly clock: () => Date,
  ) {
    const trimmedRoot = dataRoot.trim();
    assertSafeDataRoot(trimmedRoot);
    this.dataRoot = normalizePath(trimmedRoot);
  }

  async upsertDaily(
    items: CollectedItem[],
    localDate: string,
  ): Promise<CollectedItem[]> {
    return await this.withRootAccessLock(async () =>
      await this.upsertDailyUnlocked(items, localDate),
    );
  }

  private async upsertDailyUnlocked(
    items: CollectedItem[],
    localDate: string,
  ): Promise<CollectedItem[]> {
    assertLocalDate(localDate);
    await this.ensureStorageDirectories();

    const index = await this.rebuildIndex();
    const dailyPath = this.dailyPath(localDate);
    const parsed = await this.readCollection(dailyPath);
    const dailyItems = new Map(parsed.items.map((item) => [item.id, item]));
    const priorItems = new Map<string, CollectedItem | null>();

    for (const incoming of items) {
      const sameDay = dailyItems.get(incoming.id);
      if (sameDay) {
        dailyItems.set(
          incoming.id,
          mergeCollectedItems(sameDay, {
            ...incoming,
            observationType: sameDay.observationType,
          }),
        );
        continue;
      }

      const indexEntry = index.items[incoming.id];
      const wasSeenEarlier =
        indexEntry !== undefined && indexEntry.earliestDate < localDate;
      let prepared: CollectedItem = {
        ...incoming,
        observationType:
          wasSeenEarlier && incoming.observationType === "new"
            ? "rediscovered"
            : incoming.observationType,
      };

      if (wasSeenEarlier) {
        let prior = priorItems.get(incoming.id);
        if (prior === undefined) {
          prior = await this.findItemOnDate(incoming.id, indexEntry.latestDate);
          priorItems.set(incoming.id, prior);
        }
        if (prior) {
          prepared = mergeCollectedItems(prior, prepared);
        }
      }

      dailyItems.set(incoming.id, prepared);
    }

    const storedItems = [...dailyItems.values()];
    await this.atomicWrite(dailyPath, serializeCollection(storedItems));

    for (const item of storedItems) {
      updateIndexEntry(index, item.id, localDate);
    }
    await this.writeIndex(index);

    return storedItems;
  }

  async findById(id: string): Promise<CollectedItem | null> {
    return await this.withRootAccessLock(async () =>
      await this.findByIdUnlocked(id),
    );
  }

  private async findByIdUnlocked(id: string): Promise<CollectedItem | null> {
    const index = await this.loadIndex();
    const indexedEntry = index.items[id];
    return indexedEntry
      ? this.findItemOnDate(id, indexedEntry.latestDate)
      : null;
  }

  async hasItemsForSource(sourceId: string): Promise<boolean> {
    return await this.withRootAccessLock(async () =>
      await this.hasItemsForSourceUnlocked(sourceId),
    );
  }

  private async hasItemsForSourceUnlocked(sourceId: string): Promise<boolean> {
    const dates = await this.collectionDates();
    for (let index = dates.length - 1; index >= 0; index -= 1) {
      const items = (
        await this.readCollection(this.dailyPath(dates[index]))
      ).items;
      if (items.some((item) => item.sourceId === sourceId)) {
        return true;
      }
    }
    return false;
  }

  async removeBySourceId(sourceId: string): Promise<RemovedCollectionDay[]> {
    if (!sourceId.trim()) throw new Error("Invalid collection source id");
    return await this.withRootAccessLock(async () =>
      await this.removeBySourceIdUnlocked(sourceId),
    );
  }

  private async removeBySourceIdUnlocked(
    sourceId: string,
  ): Promise<RemovedCollectionDay[]> {
    await this.loadIndex();
    const dates = await this.collectionDates();
    const itemsByDate = new Map<string, CollectedItem[]>();
    const rewrites: PreparedRewrite[] = [];
    const affected: RemovedCollectionDay[] = [];

    for (const localDate of dates) {
      const path = this.dailyPath(localDate);
      const parsed = await this.readCollection(path);
      const remainingItems = parsed.items.filter(
        (item) => item.sourceId !== sourceId,
      );
      itemsByDate.set(localDate, remainingItems);
      if (remainingItems.length === parsed.items.length) continue;
      rewrites.push({
        path,
        before: serializeCollection(parsed.items),
        after: serializeCollection(remainingItems),
      });
      affected.push({
        localDate,
        previousItems: parsed.items,
        remainingItems,
      });
    }

    if (affected.length === 0) return [];

    const nextIndex = EMPTY_INDEX();
    for (const localDate of dates) {
      for (const item of itemsByDate.get(localDate) ?? []) {
        updateIndexEntry(nextIndex, item.id, localDate);
      }
    }

    const completed: PreparedRewrite[] = [];
    try {
      for (const rewrite of rewrites) {
        await this.atomicWrite(rewrite.path, rewrite.after);
        completed.push(rewrite);
      }
      await this.writeIndex(nextIndex);
    } catch (removeError) {
      const rollbackErrors: unknown[] = [];
      for (const rewrite of completed.reverse()) {
        try {
          await this.atomicWrite(rewrite.path, rewrite.before);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length > 0) {
        throw combinedError(
          "Source removal failed and rollback was incomplete",
          removeError,
          rollbackErrors,
        );
      }
      throw removeError;
    }

    return affected;
  }

  async restoreRemovedSource(days: RemovedCollectionDay[]): Promise<void> {
    if (days.length === 0) return;
    await this.withRootAccessLock(async () => {
      const uniqueDates = new Set<string>();
      for (const day of days) {
        assertLocalDate(day.localDate);
        if (uniqueDates.has(day.localDate)) {
          throw new Error("Invalid source removal receipt");
        }
        uniqueDates.add(day.localDate);
      }

      await this.loadIndex();
      const dates = await this.collectionDates();
      const restorationByDate = new Map(days.map((day) => [day.localDate, day]));
      const itemsByDate = new Map<string, CollectedItem[]>();
      const rewrites: PreparedRewrite[] = [];

      for (const localDate of dates) {
        const path = this.dailyPath(localDate);
        const parsed = await this.readCollection(path);
        const receipt = restorationByDate.get(localDate);
        if (!receipt) {
          itemsByDate.set(localDate, parsed.items);
          continue;
        }
        if (
          serializeCollection(parsed.items) !==
          serializeCollection(receipt.remainingItems)
        ) {
          throw new Error("Source removal receipt no longer owns collection generation");
        }
        itemsByDate.set(localDate, receipt.previousItems);
        rewrites.push({
          path,
          before: serializeCollection(parsed.items),
          after: serializeCollection(receipt.previousItems),
        });
      }

      if (rewrites.length !== days.length) {
        throw new Error("Source removal receipt is incomplete");
      }

      const restoredIndex = EMPTY_INDEX();
      for (const localDate of dates) {
        for (const item of itemsByDate.get(localDate) ?? []) {
          updateIndexEntry(restoredIndex, item.id, localDate);
        }
      }

      const completed: PreparedRewrite[] = [];
      try {
        for (const rewrite of rewrites) {
          await this.atomicWrite(rewrite.path, rewrite.after);
          completed.push(rewrite);
        }
        await this.writeIndex(restoredIndex);
      } catch (restoreError) {
        const rollbackErrors: unknown[] = [];
        for (const rewrite of completed.reverse()) {
          try {
            await this.atomicWrite(rewrite.path, rewrite.before);
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
        if (rollbackErrors.length > 0) {
          throw combinedError(
            "Source restoration failed and rollback was incomplete",
            restoreError,
            rollbackErrors,
          );
        }
        throw restoreError;
      }
    });
  }

  async listByDate(localDate: string): Promise<CollectedItem[]> {
    return await this.withRootAccessLock(async () =>
      await this.listByDateUnlocked(localDate),
    );
  }

  private async listByDateUnlocked(localDate: string): Promise<CollectedItem[]> {
    assertLocalDate(localDate);
    return (await this.readCollection(this.dailyPath(localDate))).items;
  }

  async updateFlags(id: string, patch: FlagPatch): Promise<void> {
    await this.withRootAccessLock(async () =>
      await this.updateFlagsUnlocked(id, patch),
    );
  }

  private async updateFlagsUnlocked(id: string, patch: FlagPatch): Promise<void> {
    await this.loadIndex();
    const dates = await this.collectionDates();
    const rewrites: PreparedRewrite[] = [];

    for (const date of dates) {
      const path = this.dailyPath(date);
      const parsed = await this.readCollection(path);
      let changed = false;
      const updated = parsed.items.map((item) => {
        if (item.id !== id) {
          return item;
        }
        changed = true;
        return {
          ...item,
          read: patch.read,
          starred: patch.starred,
          saved: patch.saved,
          savedNotePath: patch.savedNotePath,
        };
      });

      if (!changed) {
        continue;
      }
      rewrites.push({
        path,
        before: serializeCollection(parsed.items),
        after: serializeCollection(updated),
      });
    }

    const completed: PreparedRewrite[] = [];
    try {
      for (const rewrite of rewrites) {
        await this.atomicWrite(rewrite.path, rewrite.after);
        completed.push(rewrite);
      }
    } catch (updateError) {
      const rollbackErrors: unknown[] = [];
      for (const rewrite of completed.reverse()) {
        try {
          await this.atomicWrite(rewrite.path, rewrite.before);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length > 0) {
        throw combinedError(
          "Flag update failed and rollback was incomplete",
          updateError,
          rollbackErrors,
        );
      }
      throw updateError;
    }
  }

  /**
   * Marks already-collected observations as backed by durable reader content.
   * Callers must write the content file first: metadata never claims a cache
   * that has not reached storage.
   */
  async updateContentMetadata(id: string, contentPath: string): Promise<void> {
    await this.withRootAccessLock(async () =>
      await this.updateContentMetadataUnlocked(id, contentPath),
    );
  }

  private async updateContentMetadataUnlocked(
    id: string,
    contentPath: string,
  ): Promise<void> {
    assertStableContentReference(id, contentPath, this.dataRoot);
    await this.loadIndex();
    const dates = await this.collectionDates();
    const rewrites: PreparedRewrite[] = [];

    for (const date of dates) {
      const path = this.dailyPath(date);
      const parsed = await this.readCollection(path);
      let changed = false;
      const updated = parsed.items.map((item) => {
        if (item.id !== id) return item;
        if (
          item.contentBasis === "full-text" &&
          item.contentPath === contentPath
        ) {
          return item;
        }
        changed = true;
        return { ...item, contentBasis: "full-text" as const, contentPath };
      });
      if (changed) {
        rewrites.push({
          path,
          before: serializeCollection(parsed.items),
          after: serializeCollection(updated),
        });
      }
    }

    const completed: PreparedRewrite[] = [];
    try {
      for (const rewrite of rewrites) {
        await this.atomicWrite(rewrite.path, rewrite.after);
        completed.push(rewrite);
      }
    } catch (updateError) {
      const rollbackErrors: unknown[] = [];
      for (const rewrite of completed.reverse()) {
        try {
          await this.atomicWrite(rewrite.path, rewrite.before);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length > 0) {
        throw combinedError(
          "Content metadata update failed and rollback was incomplete",
          updateError,
          rollbackErrors,
        );
      }
      throw updateError;
    }
  }

  private get collectionsPath(): string {
    return normalizePath(`${this.dataRoot}/collections`);
  }

  private async withRootAccessLock<T>(operation: () => Promise<T>): Promise<T> {
    const queues = rootMutationQueues.get(this.vault) ?? new Map<string, Promise<void>>();
    rootMutationQueues.set(this.vault, queues);
    const prior = queues.get(this.dataRoot) ?? Promise.resolve();
    const running = prior.catch(() => undefined).then(operation);
    const settled = running.then(() => undefined, () => undefined);
    queues.set(this.dataRoot, settled);
    try {
      return await running;
    } finally {
      if (queues.get(this.dataRoot) === settled) queues.delete(this.dataRoot);
      if (queues.size === 0) rootMutationQueues.delete(this.vault);
    }
  }

  private get statePath(): string {
    return normalizePath(`${this.dataRoot}/state`);
  }

  private get indexPath(): string {
    return normalizePath(`${this.statePath}/item-index.json`);
  }

  private dailyPath(localDate: string): string {
    return normalizePath(`${this.collectionsPath}/${localDate}.jsonl`);
  }

  private async ensureStorageDirectories(): Promise<void> {
    await this.ensureDirectory(this.dataRoot);
    await this.ensureDirectory(this.collectionsPath);
    await this.ensureDirectory(this.statePath);
  }

  private async ensureDirectory(path: string): Promise<void> {
    if (!(await this.vault.adapter.exists(path))) {
      await this.vault.adapter.mkdir(path);
    }
  }

  private async loadIndex(): Promise<ItemIndex> {
    await this.recoverAtomicTarget(this.indexPath);
    const rebuilt = await this.rebuildIndex();
    let stored: ItemIndex | null = null;

    if (await this.vault.adapter.exists(this.indexPath)) {
      try {
        const parsed: unknown = JSON.parse(
          await this.vault.adapter.read(this.indexPath),
        );
        if (isItemIndex(parsed)) {
          stored = parsed;
        }
      } catch {
        // Invalid derived state is rebuilt from durable collection files.
      }
    }

    if (
      (await this.vault.adapter.exists(this.collectionsPath)) &&
      (!stored || !itemIndexesEqual(stored, rebuilt))
    ) {
      await this.ensureDirectory(this.dataRoot);
      await this.ensureDirectory(this.statePath);
      await this.writeIndex(rebuilt);
    }
    return rebuilt;
  }

  private async rebuildIndex(): Promise<ItemIndex> {
    const index = EMPTY_INDEX();
    for (const date of await this.collectionDates()) {
      const parsed = await this.readCollection(this.dailyPath(date));
      for (const item of parsed.items) {
        updateIndexEntry(index, item.id, date);
      }
    }
    return index;
  }

  private async writeIndex(index: ItemIndex): Promise<void> {
    await this.atomicWrite(
      this.indexPath,
      `${JSON.stringify(index, null, 2)}\n`,
    );
  }

  private async collectionDates(): Promise<string[]> {
    if (!(await this.vault.adapter.exists(this.collectionsPath))) {
      return [];
    }

    let listed = await this.vault.adapter.list(this.collectionsPath);
    const interruptedTargets = new Set<string>();
    const quarantineTargets = new Set<string>();
    for (const path of listed.files) {
      const quarantineMatch = path.match(
        /^(.*\/\d{4}-\d{2}-\d{2}\.jsonl)\.backup-quarantine-[^/]+$/,
      );
      if (quarantineMatch) {
        quarantineTargets.add(quarantineMatch[1]);
        continue;
      }
      const match = path.match(
        /^(.*\/\d{4}-\d{2}-\d{2}\.jsonl)\.(?:backup|tmp)-[^/]+$/,
      );
      if (match) {
        interruptedTargets.add(match[1]);
      }
    }
    for (const path of quarantineTargets) {
      await this.recoverQuarantineTransaction(path);
    }
    for (const path of interruptedTargets) {
      await this.recoverAtomicTarget(path);
    }
    if (quarantineTargets.size > 0 || interruptedTargets.size > 0) {
      listed = await this.vault.adapter.list(this.collectionsPath);
    }

    return listed.files
      .map((path) => path.slice(this.collectionsPath.length + 1))
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
      .map((name) => name.slice(0, -".jsonl".length))
      .filter(isLocalDate)
      .sort();
  }

  private async findItemOnDate(
    id: string,
    localDate: string,
  ): Promise<CollectedItem | null> {
    const items = (await this.readCollection(this.dailyPath(localDate))).items;
    return items.find((item) => item.id === id) ?? null;
  }

  private async readCollection(path: string): Promise<ParsedCollection> {
    await this.recoverQuarantineTransaction(path);
    await this.recoverAtomicTarget(path);
    if (!(await this.vault.adapter.exists(path))) {
      return { items: [], corruptLines: [] };
    }

    const raw = await this.vault.adapter.read(path);
    const parsed = parseCollection(raw);

    if (parsed.corruptLines.length > 0) {
      await this.quarantineCorruptLines(path, raw, parsed);
      return { items: parsed.items, corruptLines: [] };
    }

    await this.cleanupQuarantineJournal(path);
    return parsed;
  }

  private async quarantineCorruptLines(
    dailyPath: string,
    sourceRaw: string,
    parsed: ParsedCollection,
  ): Promise<void> {
    const sidecarPath = `${dailyPath}.corrupt`;
    const journalPath = `${dailyPath}.quarantine-journal.json`;
    await this.recoverAtomicTarget(sidecarPath);
    await this.recoverAtomicTarget(journalPath);

    const existing = (await this.vault.adapter.exists(sidecarPath))
      ? await this.vault.adapter.read(sidecarPath)
      : "";
    const sourceFingerprint = fingerprint(sourceRaw);
    const pending = await this.readQuarantineJournal(journalPath);
    const samePendingBatch =
      pending?.stage === "prepared" &&
      pending.sourceFingerprint === sourceFingerprint;
    const sidecarAfter = samePendingBatch
      ? pending.sidecarAfter
      : appendRawLines(existing, parsed.corruptLines);
    const cleanedCollection = serializeCollection(parsed.items);
    const journal: QuarantineJournal = samePendingBatch
      ? pending
      : {
          schemaVersion: 1,
          stage: "prepared",
          sourceFingerprint,
          transactionId: this.nextWriteId(),
          sidecarAfter,
          cleanedCollection,
        };
    const sourceBackupPath = quarantineBackupPath(
      dailyPath,
      journal.transactionId,
    );

    await this.atomicWrite(journalPath, `${JSON.stringify(journal)}\n`);
    await this.atomicWrite(sidecarPath, sidecarAfter);
    await this.atomicWrite(dailyPath, cleanedCollection, {
      retainedBackupPath: sourceBackupPath,
    });
    const committed: QuarantineJournal = { ...journal, stage: "committed" };
    try {
      await this.atomicWrite(journalPath, `${JSON.stringify(committed)}\n`);
    } catch {
      // Canonical and sidecar are durable; topology allows later recovery.
      return;
    }
    await this.bestEffortRemove(journalPath);
    await this.bestEffortRemove(sourceBackupPath);
  }

  private async readQuarantineJournal(
    path: string,
  ): Promise<QuarantineJournal | null> {
    if (!(await this.vault.adapter.exists(path))) {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(await this.vault.adapter.read(path));
      return isQuarantineJournal(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private async recoverQuarantineTransaction(dailyPath: string): Promise<void> {
    const journalPath = `${dailyPath}.quarantine-journal.json`;
    await this.recoverAtomicTarget(journalPath);
    const journal = await this.readQuarantineJournal(journalPath);
    if (!journal) {
      return;
    }

    const sourceBackupPath = quarantineBackupPath(
      dailyPath,
      journal.transactionId,
    );
    const canonicalExists = await this.vault.adapter.exists(dailyPath);
    const backupExists = await this.vault.adapter.exists(sourceBackupPath);

    if (journal.stage === "committed") {
      await this.bestEffortRemove(journalPath);
      await this.bestEffortRemove(sourceBackupPath);
      return;
    }

    if (!canonicalExists && backupExists) {
      await this.restoreBackup(sourceBackupPath, dailyPath);
      return;
    }

    if (!canonicalExists) {
      return;
    }

    const canonical = await this.vault.adapter.read(dailyPath);
    if (fingerprint(canonical) === journal.sourceFingerprint) {
      if (backupExists) {
        await this.bestEffortRemove(sourceBackupPath);
      }
      return;
    }

    if (canonical === journal.cleanedCollection) {
      const committed: QuarantineJournal = {
        ...journal,
        stage: "committed",
      };
      await this.atomicWrite(journalPath, `${JSON.stringify(committed)}\n`);
      await this.bestEffortRemove(journalPath);
      await this.bestEffortRemove(sourceBackupPath);
      return;
    }

    throw new Error(
      "Cannot recover quarantine transaction: canonical content does not match its source or cleaned generation",
    );
  }

  private async restoreBackup(backupPath: string, path: string): Promise<void> {
    const adapter = this.vault.adapter as Partial<DataAdapter>;
    if (typeof adapter.rename === "function") {
      await adapter.rename.call(this.vault.adapter, backupPath, path);
      return;
    }

    const content = await this.vault.adapter.read(backupPath);
    await this.vault.adapter.write(path, content);
    await this.bestEffortRemove(backupPath);
  }

  private async cleanupQuarantineJournal(dailyPath: string): Promise<void> {
    const journalPath = `${dailyPath}.quarantine-journal.json`;
    await this.recoverAtomicTarget(journalPath);
    await this.bestEffortRemove(journalPath);
  }

  private async atomicWrite(
    path: string,
    content: string,
    options: AtomicWriteOptions = {},
  ): Promise<void> {
    await this.recoverAtomicTarget(path);
    const writeId = this.nextWriteId();
    const tempPath = `${path}.tmp-${writeId}`;
    await this.vault.adapter.write(tempPath, content);

    const adapter = this.vault.adapter as Partial<DataAdapter>;
    if (typeof adapter.rename === "function") {
      if (!(await this.vault.adapter.exists(path))) {
        await adapter.rename.call(this.vault.adapter, tempPath, path);
        return;
      }

      if (typeof adapter.remove !== "function") {
        throw new Error("Adapter remove is unavailable for atomic replacement");
      }

      const backupPath =
        options.retainedBackupPath ?? `${path}.backup-${writeId}`;
      await adapter.rename.call(this.vault.adapter, path, backupPath);
      try {
        await adapter.rename.call(this.vault.adapter, tempPath, path);
      } catch (replaceError) {
        try {
          await adapter.rename.call(this.vault.adapter, backupPath, path);
        } catch (restoreError) {
          throw combinedError(
            "Atomic replacement and restore both failed",
            replaceError,
            [restoreError],
          );
        }
        throw replaceError;
      }
      if (!options.retainedBackupPath) {
        await this.bestEffortRemove(backupPath);
      }
      return;
    }

    const targetExists = await this.vault.adapter.exists(path);
    if (options.retainedBackupPath && targetExists) {
      const previous = await this.vault.adapter.read(path);
      await this.vault.adapter.write(options.retainedBackupPath, previous);
    }
    await this.vault.adapter.write(path, content);
    await this.bestEffortRemove(tempPath);
  }

  private nextWriteId(): string {
    return `${this.clock().getTime()}-${this.tempSequence++}`;
  }

  private async recoverAtomicTarget(path: string): Promise<void> {
    const parent = parentPath(path);
    if (!parent || !(await this.vault.adapter.exists(parent))) {
      return;
    }

    const listed = await this.vault.adapter.list(parent);
    const quarantineBackupPrefix = `${path}.backup-quarantine-`;
    const backups = listed.files
      .filter(
        (candidate) =>
          candidate.startsWith(`${path}.backup-`) &&
          !candidate.startsWith(quarantineBackupPrefix),
      )
      .sort()
      .reverse();
    const temps = listed.files.filter((candidate) =>
      candidate.startsWith(`${path}.tmp-`),
    );

    if (await this.vault.adapter.exists(path)) {
      await this.cleanupSiblings([...backups, ...temps]);
      return;
    }

    let restored: string | null = null;
    for (const backup of backups) {
      let content: string;
      try {
        content = await this.vault.adapter.read(backup);
      } catch {
        continue;
      }
      if (!isValidAtomicContent(path, content)) {
        continue;
      }

      const adapter = this.vault.adapter as Partial<DataAdapter>;
      if (typeof adapter.rename === "function") {
        await adapter.rename.call(this.vault.adapter, backup, path);
      } else {
        await this.vault.adapter.write(path, content);
        await this.bestEffortRemove(backup);
      }
      restored = backup;
      break;
    }

    if (!restored) {
      return;
    }

    const staleSiblings = [...backups, ...temps].filter(
      (candidate) => candidate !== restored,
    );
    await this.cleanupSiblings(staleSiblings);
  }

  private async cleanupSiblings(paths: string[]): Promise<void> {
    for (const path of paths) {
      await this.bestEffortRemove(path);
    }
  }

  private async bestEffortRemove(path: string): Promise<void> {
    const adapter = this.vault.adapter as Partial<DataAdapter>;
    if (typeof adapter.remove !== "function") {
      return;
    }
    try {
      await adapter.remove.call(this.vault.adapter, path);
    } catch {
      // Canonical content is already durable; retry cleanup on a later access.
    }
  }
}

function combinedError(
  message: string,
  primary: unknown,
  secondary: unknown[],
): Error {
  return new Error(
    `${message}: ${errorMessage(primary)}; recovery: ${secondary
      .map(errorMessage)
      .join("; ")}`,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function serializeCollection(items: CollectedItem[]): string {
  return items.length > 0
    ? `${items.map((item) => JSON.stringify(item)).join("\n")}\n`
    : "";
}

function splitLinesPreservingEndings(value: string): string[] {
  return value.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)?.filter(Boolean) ?? [];
}

function parseCollection(raw: string): ParsedCollection {
  const items: CollectedItem[] = [];
  const corruptLines: string[] = [];
  for (const segment of splitLinesPreservingEndings(raw)) {
    const line = segment.replace(/(?:\r\n|\n|\r)$/, "");
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(line);
      if (isCollectedItem(parsed)) {
        items.push(parsed);
      } else {
        corruptLines.push(segment);
      }
    } catch {
      corruptLines.push(segment);
    }
  }
  return { items, corruptLines };
}

function appendRawLines(existing: string, additions: string[]): string {
  let result = existing;
  for (const addition of additions) {
    if (result && !/(?:\r\n|\n|\r)$/.test(result)) {
      result += "\n";
    }
    result += addition;
  }
  return result;
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function quarantineBackupPath(
  dailyPath: string,
  transactionId: string,
): string {
  return `${dailyPath}.backup-quarantine-${transactionId}`;
}

function parentPath(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator === -1 ? "" : path.slice(0, separator);
}

function isValidAtomicContent(path: string, content: string): boolean {
  if (/\/collections\/\d{4}-\d{2}-\d{2}\.jsonl$/.test(path)) {
    return true;
  }
  if (path.endsWith("/state/item-index.json")) {
    try {
      const parsed: unknown = JSON.parse(content);
      return isItemIndex(parsed);
    } catch {
      return false;
    }
  }
  if (path.endsWith(".quarantine-journal.json")) {
    try {
      const parsed: unknown = JSON.parse(content);
      return isQuarantineJournal(parsed);
    } catch {
      return false;
    }
  }
  return true;
}

function updateIndexEntry(
  index: ItemIndex,
  id: string,
  localDate: string,
): void {
  const existing = index.items[id];
  index.items[id] = existing
    ? {
        earliestDate:
          localDate < existing.earliestDate ? localDate : existing.earliestDate,
        latestDate:
          localDate > existing.latestDate ? localDate : existing.latestDate,
      }
    : { earliestDate: localDate, latestDate: localDate };
}

function isItemIndex(value: unknown): value is ItemIndex {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.items)) {
    return false;
  }
  return Object.values(value.items).every(
    (entry) =>
      isRecord(entry) &&
      typeof entry.earliestDate === "string" &&
      typeof entry.latestDate === "string" &&
      isLocalDate(entry.earliestDate) &&
      isLocalDate(entry.latestDate) &&
      entry.earliestDate <= entry.latestDate,
  );
}

function isQuarantineJournal(value: unknown): value is QuarantineJournal {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    (value.stage === "prepared" || value.stage === "committed") &&
    typeof value.sourceFingerprint === "string" &&
    typeof value.transactionId === "string" &&
    /^\d{1,20}-\d{1,20}$/.test(value.transactionId) &&
    typeof value.sidecarAfter === "string" &&
    typeof value.cleanedCollection === "string"
  );
}

function itemIndexesEqual(left: ItemIndex, right: ItemIndex): boolean {
  const leftIds = Object.keys(left.items).sort();
  const rightIds = Object.keys(right.items).sort();
  if (
    leftIds.length !== rightIds.length ||
    leftIds.some((id, index) => id !== rightIds[index])
  ) {
    return false;
  }
  return leftIds.every(
    (id) =>
      left.items[id].earliestDate === right.items[id].earliestDate &&
      left.items[id].latestDate === right.items[id].latestDate,
  );
}

function isCollectedItem(value: unknown): value is CollectedItem {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.schemaVersion === 1 &&
    typeof value.id === "string" &&
    typeof value.sourceType === "string" &&
    SOURCE_TYPES.has(value.sourceType) &&
    typeof value.sourceId === "string" &&
    typeof value.sourceName === "string" &&
    typeof value.sourceBucket === "string" &&
    typeof value.title === "string" &&
    typeof value.fetchedAt === "string" &&
    typeof value.firstSeenAt === "string" &&
    typeof value.lastSeenAt === "string" &&
    (value.observationType === "new" ||
      value.observationType === "updated" ||
      value.observationType === "rediscovered") &&
    Array.isArray(value.topics) &&
    value.topics.every((topic) => typeof topic === "string") &&
    typeof value.contentBasis === "string" &&
    CONTENT_BASES.has(value.contentBasis) &&
    typeof value.read === "boolean" &&
    typeof value.starred === "boolean" &&
    typeof value.saved === "boolean" &&
    typeof value.collectionStatus === "string" &&
    COLLECTION_STATUSES.has(value.collectionStatus) &&
    optionalString(value.author) &&
    optionalString(value.publishedAt) &&
    optionalString(value.url) &&
    optionalString(value.guid) &&
    optionalString(value.language) &&
    optionalString(value.excerpt) &&
    optionalString(value.contentPath) &&
    optionalString(value.savedNotePath) &&
    validMetrics(value.metrics) &&
    validSourceMetadata(value.sourceMetadata, value.sourceType, value.contentBasis)
  );
}

function validSourceMetadata(
  value: unknown,
  sourceType: unknown,
  contentBasis: unknown,
): boolean {
  if (value === undefined) return true;
  return (
    (sourceType === "x-account" || sourceType === "x-topic") &&
    contentBasis === "x-post" &&
    normalizeXPostSourceMetadata(value) !== undefined
  );
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function validMetrics(value: unknown): boolean {
  return (
    value === undefined ||
    (isRecord(value) &&
      Object.values(value).every(
        (metric) => typeof metric === "number" && Number.isFinite(metric),
      ))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertLocalDate(value: string): void {
  if (!isLocalDate(value)) {
    throw new Error(`Invalid local date: ${value}`);
  }
}

function assertSafeDataRoot(value: string): void {
  const segments = value.split("/");
  if (
    !value ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    /^[A-Za-z]:/.test(value) ||
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw new Error(`Invalid data root: ${value}`);
  }
}

function assertStableContentReference(
  id: string,
  contentPath: string,
  dataRoot: string,
): void {
  if (!/^[a-f0-9]{64}$/.test(id)) {
    throw new Error("Invalid collected item id");
  }
  const expected = normalizePath(`${dataRoot}/content/${id}.md`);
  if (contentPath !== expected) {
    throw new Error("Invalid collected content path");
  }
}

function isLocalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}
