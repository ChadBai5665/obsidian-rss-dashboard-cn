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

type FlagPatch = Pick<
  CollectedItem,
  "read" | "starred" | "saved" | "savedNotePath"
>;

const EMPTY_INDEX = (): ItemIndex => ({ schemaVersion: 1, items: {} });

export class CollectionRepository {
  private readonly dataRoot: string;
  private tempSequence = 0;

  constructor(
    private readonly vault: Vault,
    dataRoot: string,
    private readonly clock: () => Date,
  ) {
    const trimmedRoot = dataRoot.trim().replace(/^\/+|\/+$/g, "");
    if (!trimmedRoot) {
      throw new Error("Collection data root must not be empty");
    }
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
    if (parsed.corruptLines.length > 0) {
      await this.preserveCorruptLines(dailyPath, parsed.corruptLines);
    }

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
    let latest = indexedEntry
      ? await this.findItemOnDate(id, indexedEntry.latestDate)
      : null;
    let latestDate = indexedEntry?.latestDate;

    const dates = await this.collectionDates();
    const datesToScan = latestDate
      ? dates.filter((date) => date > latestDate)
      : dates;
    for (const date of datesToScan) {
      const candidate = await this.findItemOnDate(id, date);
      if (candidate) {
        latest = candidate;
        latestDate = date;
      }
    }

    if (!latest && indexedEntry) {
      const rebuilt = await this.rebuildIndex();
      await this.writeIndex(rebuilt);
      const rebuiltEntry = rebuilt.items[id];
      return rebuiltEntry
        ? this.findItemOnDate(id, rebuiltEntry.latestDate)
        : null;
    }

    if (latest && !indexedEntry) {
      const rebuilt = await this.rebuildIndex();
      await this.writeIndex(rebuilt);
      return latest;
    }

    if (latest && latestDate && latestDate !== indexedEntry?.latestDate) {
      updateIndexEntry(index, id, latestDate);
      await this.writeIndex(index);
    }

    return latest;
  }

  async listByDate(localDate: string): Promise<CollectedItem[]> {
    assertLocalDate(localDate);
    return (await this.readCollection(this.dailyPath(localDate))).items;
  }

  async updateFlags(id: string, patch: FlagPatch): Promise<void> {
    await this.loadIndex();
    const dates = await this.collectionDates();

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

      if (!changed && parsed.corruptLines.length === 0) {
        continue;
      }
      if (parsed.corruptLines.length > 0) {
        await this.preserveCorruptLines(path, parsed.corruptLines);
      }
      await this.atomicWrite(path, serializeCollection(updated));
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
    if (await this.vault.adapter.exists(this.indexPath)) {
      try {
        const parsed: unknown = JSON.parse(
          await this.vault.adapter.read(this.indexPath),
        );
        if (isItemIndex(parsed)) {
          return parsed;
        }
      } catch {
        // Invalid derived state is rebuilt from durable collection files.
      }
    }

    const rebuilt = await this.rebuildIndex();
    if (await this.vault.adapter.exists(this.collectionsPath)) {
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
    const existingLines = new Set(splitLinesPreservingEndings(existing));
    let next = existing;

    for (const line of corruptLines) {
      if (existingLines.has(line)) {
        continue;
      }
      if (next && !/(?:\r\n|\n|\r)$/.test(next)) {
        next += "\n";
      }
      next += line;
      existingLines.add(line);
    }

    if (next !== existing) {
      await this.atomicWrite(sidecarPath, next);
    }
  }

  private async atomicWrite(path: string, content: string): Promise<void> {
    const tempPath = `${path}.tmp-${this.clock().getTime()}-${this.tempSequence++}`;
    await this.vault.adapter.write(tempPath, content);

    const adapter = this.vault.adapter as Partial<DataAdapter>;
    if (typeof adapter.rename === "function") {
      await adapter.rename.call(this.vault.adapter, tempPath, path);
      return;
    }

    await this.vault.adapter.write(path, content);
    if (typeof adapter.remove === "function") {
      await adapter.remove.call(this.vault.adapter, tempPath);
    }
  }
}

function serializeCollection(items: CollectedItem[]): string {
  return items.length > 0
    ? `${items.map((item) => JSON.stringify(item)).join("\n")}\n`
    : "";
}

function splitLinesPreservingEndings(value: string): string[] {
  return value.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)?.filter(Boolean) ?? [];
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

function isCollectedItem(value: unknown): value is CollectedItem {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.schemaVersion === 1 &&
    typeof value.id === "string" &&
    typeof value.sourceType === "string" &&
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
    typeof value.read === "boolean" &&
    typeof value.starred === "boolean" &&
    typeof value.saved === "boolean" &&
    typeof value.collectionStatus === "string"
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
