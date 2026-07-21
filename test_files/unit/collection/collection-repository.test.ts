import type { Vault } from "obsidian";
import { describe, expect, it } from "vitest";
import { CollectionRepository } from "../../../src/collection/collection-repository";
import type { CollectedItem } from "../../../src/collection/collected-item";

const DATA_ROOT = ".rss-dashboard-data";
const NOW = new Date("2026-07-21T12:00:00.000Z");

class InMemoryAdapter {
  private readonly files = new Map<string, string>();
  private readonly mtimes = new Map<string, number>();
  private readonly directories = new Set<string>();
  private time = 0;
  private nextWriteFailure: ((path: string) => boolean) | null = null;
  private nextRenameFailure: ((from: string, to: string) => boolean) | null =
    null;
  private nextRemoveFailure: ((path: string) => boolean) | null = null;
  private statOverride: number | null | undefined;

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.directories.has(path);
  }

  async mkdir(path: string): Promise<void> {
    const parent = parentPath(path);
    if (parent && !this.directories.has(parent)) {
      throw new Error(`Missing parent directory: ${parent}`);
    }
    this.directories.add(path);
  }

  async read(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) {
      throw new Error(`Missing file: ${path}`);
    }
    return content;
  }

  async stat(path: string): Promise<{ mtime: number } | null> {
    if (this.statOverride !== undefined) {
      return this.statOverride === null ? null : { mtime: this.statOverride };
    }
    const mtime = this.mtimes.get(path);
    return mtime === undefined ? null : { mtime };
  }

  async write(path: string, content: string): Promise<void> {
    if (this.nextWriteFailure?.(path)) {
      this.nextWriteFailure = null;
      throw new Error(`Injected write failure: ${path}`);
    }

    const parent = parentPath(path);
    if (parent && !this.directories.has(parent)) {
      throw new Error(`Missing parent directory: ${parent}`);
    }
    this.files.set(path, content);
    this.mtimes.set(path, ++this.time);
  }

  async rename(from: string, to: string): Promise<void> {
    if (this.nextRenameFailure?.(from, to)) {
      this.nextRenameFailure = null;
      throw new Error(`Injected rename failure: ${from} -> ${to}`);
    }
    const content = this.files.get(from);
    if (content === undefined) {
      throw new Error(`Missing rename source: ${from}`);
    }
    if (this.files.has(to) || this.directories.has(to)) {
      throw new Error(`Rename destination already exists: ${to}`);
    }

    const parent = parentPath(to);
    if (parent && !this.directories.has(parent)) {
      throw new Error(`Missing parent directory: ${parent}`);
    }
    this.files.set(to, content);
    const mtime = this.mtimes.get(from);
    if (mtime !== undefined) {
      this.mtimes.set(to, mtime);
    }
    this.files.delete(from);
    this.mtimes.delete(from);
  }

  async remove(path: string): Promise<void> {
    if (this.nextRemoveFailure?.(path)) {
      this.nextRemoveFailure = null;
      throw new Error(`Injected remove failure: ${path}`);
    }
    this.files.delete(path);
    this.mtimes.delete(path);
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    if (!this.directories.has(path)) {
      throw new Error(`Missing directory: ${path}`);
    }

    const prefix = `${path}/`;
    return {
      files: [...this.files.keys()].filter(
        (candidate) =>
          candidate.startsWith(prefix) &&
          !candidate.slice(prefix.length).includes("/"),
      ),
      folders: [...this.directories].filter(
        (candidate) =>
          candidate.startsWith(prefix) &&
          !candidate.slice(prefix.length).includes("/"),
      ),
    };
  }

  failNextWriteWhere(predicate: (path: string) => boolean): void {
    this.nextWriteFailure = predicate;
  }

  failNextRenameWhere(predicate: (from: string, to: string) => boolean): void {
    this.nextRenameFailure = predicate;
  }

  failNextRemoveWhere(predicate: (path: string) => boolean): void {
    this.nextRemoveFailure = predicate;
  }

  setStatOverride(mtime: number | null): void {
    this.statOverride = mtime;
  }

  hasDirectory(path: string): boolean {
    return this.directories.has(path);
  }
}

function parentPath(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator === -1 ? "" : path.slice(0, separator);
}

function createHarness(
  options: { withoutRename?: boolean; dataRoot?: string } = {},
): {
  adapter: InMemoryAdapter;
  repository: CollectionRepository;
} {
  const adapter = new InMemoryAdapter();
  return {
    adapter,
    repository: createRepository(adapter, options),
  };
}

function createRepository(
  adapter: InMemoryAdapter,
  options: { withoutRename?: boolean; dataRoot?: string } = {},
): CollectionRepository {
  const boundary = options.withoutRename
    ? {
        exists: adapter.exists.bind(adapter),
        stat: adapter.stat.bind(adapter),
        mkdir: adapter.mkdir.bind(adapter),
        read: adapter.read.bind(adapter),
        write: adapter.write.bind(adapter),
        remove: adapter.remove.bind(adapter),
        list: adapter.list.bind(adapter),
      }
    : adapter;
  const vault = { adapter: boundary } as unknown as Vault;
  return new CollectionRepository(
    vault,
    options.dataRoot ?? DATA_ROOT,
    () => NOW,
  );
}

function createItem(overrides: Partial<CollectedItem> = {}): CollectedItem {
  return {
    schemaVersion: 1,
    id: "item-1",
    sourceType: "rss",
    sourceId: "feed-1",
    sourceName: "Example feed",
    sourceBucket: "Reading",
    title: "Example item",
    fetchedAt: "2026-07-21T08:00:00.000Z",
    firstSeenAt: "2026-07-21T08:00:00.000Z",
    lastSeenAt: "2026-07-21T08:00:00.000Z",
    observationType: "new",
    topics: ["typescript"],
    excerpt: "Original excerpt",
    contentBasis: "feed",
    metrics: { likes: 2 },
    read: false,
    starred: false,
    saved: false,
    collectionStatus: "collected",
    ...overrides,
  };
}

describe("CollectionRepository", () => {
  it("does no constructor I/O and creates only collection persistence directories", async () => {
    const { adapter, repository } = createHarness();

    expect(adapter.hasDirectory(DATA_ROOT)).toBe(false);

    await repository.upsertDaily([createItem()], "2026-07-21");

    expect(adapter.hasDirectory(DATA_ROOT)).toBe(true);
    expect(adapter.hasDirectory(`${DATA_ROOT}/collections`)).toBe(true);
    expect(adapter.hasDirectory(`${DATA_ROOT}/state`)).toBe(true);
    expect(adapter.hasDirectory(`${DATA_ROOT}/content`)).toBe(false);
    expect(adapter.hasDirectory(`${DATA_ROOT}/analysis`)).toBe(false);
  });

  it("stores one merged line per ID on the same date", async () => {
    const { adapter, repository } = createHarness();
    await repository.upsertDaily(
      [
        createItem({
          firstSeenAt: "2026-07-21T08:00:00.000Z",
          lastSeenAt: "2026-07-21T08:00:00.000Z",
          starred: true,
          saved: true,
        }),
      ],
      "2026-07-21",
    );

    const result = await repository.upsertDaily(
      [
        createItem({
          fetchedAt: "2026-07-21T09:00:00.000Z",
          firstSeenAt: "2026-07-21T09:00:00.000Z",
          lastSeenAt: "2026-07-21T09:00:00.000Z",
          excerpt: "Updated excerpt",
          metrics: { likes: 7, replies: 2 },
          read: true,
        }),
      ],
      "2026-07-21",
    );

    const raw = await adapter.read(`${DATA_ROOT}/collections/2026-07-21.jsonl`);
    expect(raw.trim().split("\n")).toHaveLength(1);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      firstSeenAt: "2026-07-21T08:00:00.000Z",
      lastSeenAt: "2026-07-21T09:00:00.000Z",
      excerpt: "Updated excerpt",
      metrics: { likes: 7, replies: 2 },
      read: true,
      starred: true,
      saved: true,
      observationType: "new",
    });
  });

  it("marks a later-date repeat as rediscovered and finds its latest occurrence", async () => {
    const { adapter, repository } = createHarness();
    await repository.upsertDaily([createItem()], "2026-07-21");
    await repository.upsertDaily(
      [
        createItem({
          fetchedAt: "2026-07-22T08:00:00.000Z",
          firstSeenAt: "2026-07-22T08:00:00.000Z",
          lastSeenAt: "2026-07-22T08:00:00.000Z",
        }),
      ],
      "2026-07-22",
    );

    const latest = await repository.findById("item-1");
    const index = JSON.parse(
      await adapter.read(`${DATA_ROOT}/state/item-index.json`),
    ) as unknown;

    expect(latest).toMatchObject({
      id: "item-1",
      observationType: "rediscovered",
      lastSeenAt: "2026-07-22T08:00:00.000Z",
    });
    expect(index).toEqual({
      schemaVersion: 1,
      items: {
        "item-1": {
          earliestDate: "2026-07-21",
          latestDate: "2026-07-22",
        },
      },
    });
  });

  it("quarantines malformed lines exactly once without erasing valid records", async () => {
    const { adapter, repository } = createHarness();
    await repository.upsertDaily([createItem()], "2026-07-21");
    const dailyPath = `${DATA_ROOT}/collections/2026-07-21.jsonl`;
    const valid = await adapter.read(dailyPath);
    const malformed = 'not-json\r\n{"unterminated"\n';
    await adapter.write(dailyPath, `${valid}${malformed}`);

    await repository.upsertDaily(
      [createItem({ id: "item-2", title: "Second item" })],
      "2026-07-21",
    );

    expect(await adapter.read(`${dailyPath}.corrupt`)).toBe(malformed);
    expect(await repository.listByDate("2026-07-21")).toHaveLength(2);
    expect(await adapter.read(dailyPath)).not.toContain("not-json");

    await repository.upsertDaily(
      [createItem({ id: "item-3", title: "Third item" })],
      "2026-07-21",
    );
    expect(await adapter.read(`${dailyPath}.corrupt`)).toBe(malformed);
  });

  it("rebuilds a missing or invalid index from collection files", async () => {
    const { adapter, repository } = createHarness();
    await repository.upsertDaily([createItem()], "2026-07-21");
    await repository.upsertDaily(
      [createItem({ lastSeenAt: "2026-07-22T10:00:00.000Z" })],
      "2026-07-22",
    );
    await adapter.write(`${DATA_ROOT}/state/item-index.json`, "{invalid");

    const found = await repository.findById("item-1");

    expect(found?.lastSeenAt).toBe("2026-07-22T10:00:00.000Z");
    expect(
      JSON.parse(await adapter.read(`${DATA_ROOT}/state/item-index.json`)),
    ).toEqual({
      schemaVersion: 1,
      items: {
        "item-1": {
          earliestDate: "2026-07-21",
          latestDate: "2026-07-22",
        },
      },
    });
  });

  it("applies the current UI flags exactly to every daily occurrence", async () => {
    const { repository } = createHarness();
    await repository.upsertDaily(
      [
        createItem({
          read: true,
          starred: true,
          saved: true,
          savedNotePath: "Saved/item-1.md",
        }),
      ],
      "2026-07-21",
    );
    await repository.upsertDaily([createItem()], "2026-07-22");

    await repository.updateFlags("item-1", {
      read: false,
      starred: false,
      saved: false,
      savedNotePath: undefined,
    });

    for (const date of ["2026-07-21", "2026-07-22"]) {
      const [item] = await repository.listByDate(date);
      expect(item).toMatchObject({
        read: false,
        starred: false,
        saved: false,
      });
      expect(item.savedNotePath).toBeUndefined();
    }
  });

  it("rejects invalid local dates before creating paths", async () => {
    const { adapter, repository } = createHarness();

    await expect(
      repository.upsertDaily([createItem()], "2026-02-30"),
    ).rejects.toThrow("Invalid local date");
    await expect(repository.listByDate("../2026-07-21")).rejects.toThrow(
      "Invalid local date",
    );
    expect(adapter.hasDirectory(DATA_ROOT)).toBe(false);
  });

  it("rejects a daily write failure without reporting or indexing success", async () => {
    const { adapter, repository } = createHarness();
    adapter.failNextWriteWhere((path) =>
      path.startsWith(`${DATA_ROOT}/collections/2026-07-21.jsonl.tmp-`),
    );

    await expect(
      repository.upsertDaily([createItem()], "2026-07-21"),
    ).rejects.toThrow("Injected write failure");

    expect(
      await adapter.exists(`${DATA_ROOT}/collections/2026-07-21.jsonl`),
    ).toBe(false);
    expect(await adapter.exists(`${DATA_ROOT}/state/item-index.json`)).toBe(
      false,
    );
  });

  it("makes daily data durable before attempting the index write", async () => {
    const { adapter, repository } = createHarness();
    adapter.failNextWriteWhere((path) =>
      path.startsWith(`${DATA_ROOT}/state/item-index.json.tmp-`),
    );

    await expect(
      repository.upsertDaily([createItem()], "2026-07-21"),
    ).rejects.toThrow("Injected write failure");

    expect(await repository.listByDate("2026-07-21")).toEqual([createItem()]);
  });

  it("recovers a durable unindexed observation before classifying a later repeat", async () => {
    const { adapter, repository } = createHarness();
    await repository.upsertDaily(
      [createItem({ id: "indexed-item" })],
      "2026-07-20",
    );
    adapter.failNextWriteWhere((path) =>
      path.startsWith(`${DATA_ROOT}/state/item-index.json.tmp-`),
    );
    await expect(
      repository.upsertDaily([createItem()], "2026-07-21"),
    ).rejects.toThrow("Injected write failure");

    const [repeat] = await repository.upsertDaily(
      [createItem({ lastSeenAt: "2026-07-22T08:00:00.000Z" })],
      "2026-07-22",
    );
    const index = JSON.parse(
      await adapter.read(`${DATA_ROOT}/state/item-index.json`),
    ) as {
      items: Record<string, { earliestDate: string; latestDate: string }>;
    };

    expect(repeat.observationType).toBe("rediscovered");
    expect(index.items["item-1"]).toEqual({
      earliestDate: "2026-07-21",
      latestDate: "2026-07-22",
    });
  });

  it("falls back safely when the adapter has no rename operation", async () => {
    const { repository } = createHarness({ withoutRename: true });

    await repository.upsertDaily([createItem()], "2026-07-21");

    expect(await repository.listByDate("2026-07-21")).toEqual([createItem()]);
  });

  it("restores both index bounds when valid derived state omits an ID", async () => {
    const { adapter, repository } = createHarness();
    await repository.upsertDaily(
      [createItem({ id: "indexed-item" })],
      "2026-07-20",
    );

    for (const date of ["2026-07-21", "2026-07-22"]) {
      adapter.failNextWriteWhere((path) =>
        path.startsWith(`${DATA_ROOT}/state/item-index.json.tmp-`),
      );
      await expect(
        repository.upsertDaily([createItem()], date),
      ).rejects.toThrow("Injected write failure");
    }

    await expect(repository.findById("item-1")).resolves.toMatchObject({
      observationType: "rediscovered",
    });
    const index = JSON.parse(
      await adapter.read(`${DATA_ROOT}/state/item-index.json`),
    ) as {
      items: Record<string, { earliestDate: string; latestDate: string }>;
    };
    expect(index.items["item-1"]).toEqual({
      earliestDate: "2026-07-21",
      latestDate: "2026-07-22",
    });
  });

  it("repairs a stale earliest date even when the indexed latest date is correct", async () => {
    const { adapter, repository } = createHarness();
    await repository.upsertDaily([createItem()], "2026-07-21");
    await repository.upsertDaily([createItem()], "2026-07-22");
    await adapter.write(
      `${DATA_ROOT}/state/item-index.json`,
      JSON.stringify({
        schemaVersion: 1,
        items: {
          "item-1": {
            earliestDate: "2026-07-22",
            latestDate: "2026-07-22",
          },
        },
      }),
    );

    await expect(repository.findById("item-1")).resolves.toMatchObject({
      id: "item-1",
      lastSeenAt: "2026-07-21T08:00:00.000Z",
    });
    expect(
      JSON.parse(await adapter.read(`${DATA_ROOT}/state/item-index.json`)),
    ).toEqual({
      schemaVersion: 1,
      items: {
        "item-1": {
          earliestDate: "2026-07-21",
          latestDate: "2026-07-22",
        },
      },
    });
  });

  it("rolls back earlier flag rewrites when a later date fails", async () => {
    const { adapter, repository } = createHarness();
    const initialFlags = {
      read: true,
      starred: true,
      saved: true,
      savedNotePath: "Saved/item-1.md",
    };
    await repository.upsertDaily([createItem(initialFlags)], "2026-07-21");
    await repository.upsertDaily([createItem(initialFlags)], "2026-07-22");
    adapter.failNextWriteWhere((path) =>
      path.startsWith(`${DATA_ROOT}/collections/2026-07-22.jsonl.tmp-`),
    );

    await expect(
      repository.updateFlags("item-1", {
        read: false,
        starred: false,
        saved: false,
        savedNotePath: undefined,
      }),
    ).rejects.toThrow("Injected write failure");

    for (const date of ["2026-07-21", "2026-07-22"]) {
      const [item] = await repository.listByDate(date);
      expect(item).toMatchObject(initialFlags);
    }
  });

  it("quarantines duplicate corrupt lines found while rebuilding from older dates", async () => {
    const { adapter, repository } = createHarness();
    await repository.upsertDaily([createItem()], "2026-07-20");
    await repository.upsertDaily([createItem({ id: "item-2" })], "2026-07-22");
    const olderPath = `${DATA_ROOT}/collections/2026-07-20.jsonl`;
    const duplicateCorruption =
      "duplicate-corrupt-line\nduplicate-corrupt-line\n";
    await adapter.write(
      olderPath,
      `${await adapter.read(olderPath)}${duplicateCorruption}`,
    );
    await adapter.write(`${DATA_ROOT}/state/item-index.json`, "{invalid");

    await expect(repository.findById("item-2")).resolves.toMatchObject({
      id: "item-2",
    });

    expect(await adapter.read(`${olderPath}.corrupt`)).toBe(
      duplicateCorruption,
    );
    expect(await adapter.read(olderPath)).not.toContain(
      "duplicate-corrupt-line",
    );
  });

  it("quarantines records with invalid enums, optional fields, or metrics", async () => {
    const { adapter, repository } = createHarness();
    await repository.upsertDaily([createItem()], "2026-07-21");
    const dailyPath = `${DATA_ROOT}/collections/2026-07-21.jsonl`;
    const invalidRecords = [
      { ...createItem(), sourceType: "email" },
      { ...createItem(), author: 42 },
      { ...createItem(), metrics: { likes: "many" } },
    ];
    const raw = `${invalidRecords.map((item) => JSON.stringify(item)).join("\n")}\n`;
    await adapter.write(dailyPath, raw);

    await expect(repository.listByDate("2026-07-21")).resolves.toEqual([]);
    expect(await adapter.read(`${dailyPath}.corrupt`)).toBe(raw);
    expect(await adapter.read(dailyPath)).toBe("");
  });

  it.each([
    "",
    "   ",
    ".",
    "./data",
    "nested/../escape",
    "/absolute/path",
    "C:\\vault",
    "C:vault",
    "folder\\child",
    "unsafe\0root",
  ])("rejects unsafe data root %j before filesystem access", (dataRoot) => {
    expect(() => createHarness({ dataRoot })).toThrow("Invalid data root");
  });

  it("restores an interrupted collection replacement from its durable backup", async () => {
    const { adapter, repository } = createHarness();
    await repository.upsertDaily([createItem()], "2026-07-21");
    const dailyPath = `${DATA_ROOT}/collections/2026-07-21.jsonl`;
    const backupPath = `${dailyPath}.backup-100-1`;
    const tempPath = `${dailyPath}.tmp-100-1`;
    await adapter.write(
      tempPath,
      `${JSON.stringify(createItem({ title: "Uncommitted replacement" }))}\n`,
    );
    await adapter.rename(dailyPath, backupPath);

    const recovered = createRepository(adapter);
    await expect(recovered.listByDate("2026-07-21")).resolves.toEqual([
      createItem(),
    ]);
    expect(await adapter.exists(dailyPath)).toBe(true);
    expect(await adapter.exists(backupPath)).toBe(false);
    expect(await adapter.exists(tempPath)).toBe(false);
  });

  it("restores an interrupted item-index replacement before lookup", async () => {
    const { adapter, repository } = createHarness();
    await repository.upsertDaily([createItem()], "2026-07-21");
    const indexPath = `${DATA_ROOT}/state/item-index.json`;
    const backupPath = `${indexPath}.backup-100-2`;
    const tempPath = `${indexPath}.tmp-100-2`;
    await adapter.write(tempPath, "{uncommitted");
    await adapter.rename(indexPath, backupPath);

    const recovered = createRepository(adapter);
    await expect(recovered.findById("item-1")).resolves.toMatchObject({
      id: "item-1",
    });
    expect(await adapter.exists(indexPath)).toBe(true);
    expect(await adapter.exists(backupPath)).toBe(false);
    expect(await adapter.exists(tempPath)).toBe(false);
  });

  it("restores the canonical file when installing a prepared rename fails", async () => {
    const { adapter, repository } = createHarness();
    await repository.upsertDaily([createItem()], "2026-07-21");
    const dailyPath = `${DATA_ROOT}/collections/2026-07-21.jsonl`;
    adapter.failNextRenameWhere(
      (from, to) => from.startsWith(`${dailyPath}.tmp-`) && to === dailyPath,
    );

    await expect(
      repository.upsertDaily(
        [createItem({ title: "Replacement title" })],
        "2026-07-21",
      ),
    ).rejects.toThrow("Injected rename failure");
    await expect(repository.listByDate("2026-07-21")).resolves.toEqual([
      createItem(),
    ]);
  });

  it("treats backup cleanup failure as debt after flags are committed", async () => {
    const { adapter, repository } = createHarness();
    await repository.upsertDaily([createItem()], "2026-07-21");
    await repository.upsertDaily([createItem()], "2026-07-22");
    adapter.failNextRemoveWhere((path) =>
      path.startsWith(`${DATA_ROOT}/collections/2026-07-21.jsonl.backup-`),
    );

    await expect(
      repository.updateFlags("item-1", {
        read: true,
        starred: true,
        saved: true,
        savedNotePath: "Saved/item-1.md",
      }),
    ).resolves.toBeUndefined();

    for (const date of ["2026-07-21", "2026-07-22"]) {
      await expect(repository.listByDate(date)).resolves.toEqual([
        expect.objectContaining({
          read: true,
          starred: true,
          saved: true,
          savedNotePath: "Saved/item-1.md",
        }),
      ]);
    }
    const listed = await adapter.list(`${DATA_ROOT}/collections`);
    expect(listed.files.some((path) => path.includes(".backup-"))).toBe(false);
  });

  it("treats fallback temp cleanup failure as debt after the final write", async () => {
    const { adapter, repository } = createHarness({ withoutRename: true });
    adapter.failNextRemoveWhere((path) =>
      path.startsWith(`${DATA_ROOT}/collections/2026-07-21.jsonl.tmp-`),
    );

    await expect(
      repository.upsertDaily([createItem()], "2026-07-21"),
    ).resolves.toEqual([createItem()]);
    await expect(repository.listByDate("2026-07-21")).resolves.toEqual([
      createItem(),
    ]);
    const listed = await adapter.list(`${DATA_ROOT}/collections`);
    expect(listed.files.some((path) => path.includes(".tmp-"))).toBe(false);
  });

  it("appends a genuinely new identical corrupt line to historical sidecar data", async () => {
    const { adapter, repository } = createHarness();
    await repository.upsertDaily([createItem()], "2026-07-21");
    const dailyPath = `${DATA_ROOT}/collections/2026-07-21.jsonl`;
    const valid = await adapter.read(dailyPath);
    await adapter.write(dailyPath, `${valid}bad\n`);
    await repository.listByDate("2026-07-21");
    expect(await adapter.read(`${dailyPath}.corrupt`)).toBe("bad\n");

    await adapter.write(dailyPath, `${valid}bad\n`);
    await repository.listByDate("2026-07-21");

    expect(await adapter.read(`${dailyPath}.corrupt`)).toBe("bad\nbad\n");
  });

  it("does not duplicate corrupt lines when quarantine cleanup is retried", async () => {
    const { adapter, repository } = createHarness();
    await repository.upsertDaily([createItem()], "2026-07-21");
    const dailyPath = `${DATA_ROOT}/collections/2026-07-21.jsonl`;
    await adapter.write(dailyPath, `${await adapter.read(dailyPath)}bad\n`);
    adapter.failNextWriteWhere((path) => path.startsWith(`${dailyPath}.tmp-`));

    await expect(repository.listByDate("2026-07-21")).rejects.toThrow(
      "Injected write failure",
    );
    await expect(repository.listByDate("2026-07-21")).resolves.toHaveLength(1);
    expect(await adapter.read(`${dailyPath}.corrupt`)).toBe("bad\n");
  });

  it("restores a corrupt collection backup before quarantining its raw line", async () => {
    const { adapter, repository } = createHarness();
    await repository.upsertDaily([createItem()], "2026-07-21");
    const dailyPath = `${DATA_ROOT}/collections/2026-07-21.jsonl`;
    const backupPath = `${dailyPath}.backup-200-1`;
    const tempPath = `${dailyPath}.tmp-200-1`;
    const valid = await adapter.read(dailyPath);
    await adapter.write(dailyPath, `${valid}bad\n`);
    await adapter.write(tempPath, valid);
    await adapter.rename(dailyPath, backupPath);

    const recovered = createRepository(adapter);
    await expect(recovered.listByDate("2026-07-21")).resolves.toEqual([
      createItem(),
    ]);
    expect(await adapter.read(`${dailyPath}.corrupt`)).toBe("bad\n");
    expect(await adapter.read(dailyPath)).toBe(valid);
    expect(await adapter.exists(backupPath)).toBe(false);
    expect(await adapter.exists(tempPath)).toBe(false);
  });

  it.each([
    ["constant", 7],
    ["null", null],
  ] as const)(
    "records a later identical corrupt line when source mtime is %s",
    async (_label, mtime) => {
      const { adapter, repository } = createHarness();
      adapter.setStatOverride(mtime);
      await repository.upsertDaily([createItem()], "2026-07-21");
      const dailyPath = `${DATA_ROOT}/collections/2026-07-21.jsonl`;
      const journalPath = `${dailyPath}.quarantine-journal.json`;
      const valid = await adapter.read(dailyPath);
      await adapter.write(dailyPath, `${valid}bad\n`);
      adapter.failNextRemoveWhere((path) => path === journalPath);
      await repository.listByDate("2026-07-21");
      expect(await adapter.exists(journalPath)).toBe(true);

      await adapter.write(dailyPath, `${valid}bad\n`);
      await repository.listByDate("2026-07-21");

      expect(await adapter.read(`${dailyPath}.corrupt`)).toBe("bad\nbad\n");
    },
  );

  it("uses retained source backup to finish a prepared journal before a later identical occurrence", async () => {
    const { adapter, repository } = createHarness();
    adapter.setStatOverride(null);
    await repository.upsertDaily([createItem()], "2026-07-21");
    const dailyPath = `${DATA_ROOT}/collections/2026-07-21.jsonl`;
    const journalPath = `${dailyPath}.quarantine-journal.json`;
    const valid = await adapter.read(dailyPath);
    await adapter.write(dailyPath, `${valid}bad\n`);
    let journalWrites = 0;
    adapter.failNextWriteWhere((path) => {
      if (!path.startsWith(`${journalPath}.tmp-`)) {
        return false;
      }
      journalWrites += 1;
      return journalWrites === 2;
    });

    await repository.listByDate("2026-07-21");
    expect(await adapter.exists(journalPath)).toBe(true);
    expect(await adapter.read(`${dailyPath}.corrupt`)).toBe("bad\n");

    await adapter.write(dailyPath, `${valid}bad\n`);
    await repository.listByDate("2026-07-21");

    expect(await adapter.read(`${dailyPath}.corrupt`)).toBe("bad\nbad\n");
  });
});
