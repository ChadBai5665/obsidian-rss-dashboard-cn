import { normalizePath, type DataAdapter, type Vault } from "obsidian";
import type { CollectedItem } from "./collected-item";
import { mergeCollectedItems } from "./collection-merge";

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
        observationType: wasSeenEarlier
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
    const index = await this.loadIndex();
    const indexedEntry = index.items[id];
    return indexedEntry
      ? this.findItemOnDate(id, indexedEntry.latestDate)
      : null;
  }

  async listByDate(localDate: string): Promise<CollectedItem[]> {
    assertLocalDate(localDate);
    return (await this.readCollection(this.dailyPath(localDate))).items;
  }

  async updateFlags(id: string, patch: FlagPatch): Promise<void> {
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

  private get collectionsPath(): string {
    return normalizePath(`${this.dataRoot}/collections`);
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

    const listed = await this.vault.adapter.list(this.collectionsPath);
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
    if (!(await this.vault.adapter.exists(path))) {
      return { items: [], corruptLines: [] };
    }

    const raw = await this.vault.adapter.read(path);
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

    if (corruptLines.length > 0) {
      await this.preserveCorruptLines(path, corruptLines);
      await this.atomicWrite(path, serializeCollection(items));
      return { items, corruptLines: [] };
    }

    return { items, corruptLines };
  }

  private async preserveCorruptLines(
    dailyPath: string,
    corruptLines: string[],
  ): Promise<void> {
    const sidecarPath = `${dailyPath}.corrupt`;
    const existing = (await this.vault.adapter.exists(sidecarPath))
      ? await this.vault.adapter.read(sidecarPath)
      : "";
    const existingCounts = countOccurrences(
      splitLinesPreservingEndings(existing),
    );
    const incomingCounts = new Map<string, number>();
    let next = existing;

    for (const line of corruptLines) {
      const occurrence = (incomingCounts.get(line) ?? 0) + 1;
      incomingCounts.set(line, occurrence);
      if (occurrence <= (existingCounts.get(line) ?? 0)) {
        continue;
      }
      if (next && !/(?:\r\n|\n|\r)$/.test(next)) {
        next += "\n";
      }
      next += line;
    }

    if (next !== existing) {
      await this.atomicWrite(sidecarPath, next);
    }
  }

  private async atomicWrite(path: string, content: string): Promise<void> {
    const writeId = `${this.clock().getTime()}-${this.tempSequence++}`;
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

      const backupPath = `${path}.backup-${writeId}`;
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
      await adapter.remove.call(this.vault.adapter, backupPath);
      return;
    }

    await this.vault.adapter.write(path, content);
    if (typeof adapter.remove === "function") {
      await adapter.remove.call(this.vault.adapter, tempPath);
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

function countOccurrences(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
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
    validMetrics(value.metrics)
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
