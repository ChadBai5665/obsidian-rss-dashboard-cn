import type { Vault } from "obsidian";
import { describe, expect, it } from "vitest";
import {
  ContentRepository,
  type CachedItemContent,
} from "../../../src/collection/content-repository";

const DATA_ROOT = ".rss-dashboard-data";
const ITEM_ID = "a".repeat(64);

class InMemoryAdapter {
  readonly files = new Map<string, string>();
  private readonly directories = new Set<string>();
  private failRename: ((from: string, to: string) => boolean) | null = null;

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
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`Missing file: ${path}`);
    return value;
  }

  async write(path: string, value: string): Promise<void> {
    const parent = parentPath(path);
    if (parent && !this.directories.has(parent)) {
      throw new Error(`Missing parent directory: ${parent}`);
    }
    this.files.set(path, value);
  }

  async rename(from: string, to: string): Promise<void> {
    if (this.failRename?.(from, to)) {
      this.failRename = null;
      throw new Error(`Injected rename failure: ${from} -> ${to}`);
    }
    const value = this.files.get(from);
    if (value === undefined) throw new Error(`Missing rename source: ${from}`);
    if (this.files.has(to)) throw new Error(`Destination exists: ${to}`);
    this.files.set(to, value);
    this.files.delete(from);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
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

  failNextRenameWhere(
    predicate: (from: string, to: string) => boolean,
  ): void {
    this.failRename = predicate;
  }
}

function parentPath(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator === -1 ? "" : path.slice(0, separator);
}

function createRepository(adapter: InMemoryAdapter, vault?: Vault): ContentRepository {
  return new ContentRepository(
    vault ?? ({ adapter } as unknown as Vault),
    DATA_ROOT,
    () => new Date("2026-07-21T12:00:00.000Z"),
  );
}

function createContent(
  overrides: Partial<CachedItemContent> = {},
): CachedItemContent {
  return {
    schemaVersion: 1,
    itemId: ITEM_ID,
    sourceUrl: "https://example.com/article?x=1",
    fetchedAt: "2026-07-21T12:00:00.000Z",
    contentBasis: "full-text",
    text: "<p>Durable extracted article text.</p>",
    ...overrides,
  };
}

describe("ContentRepository", () => {
  it("persists and reads full text below the configured data root", async () => {
    const adapter = new InMemoryAdapter();
    const repository = createRepository(adapter);

    const path = await repository.write(createContent());

    expect(path).toBe(`${DATA_ROOT}/content/${ITEM_ID}.md`);
    expect(await repository.read(ITEM_ID)).toEqual(createContent());
    expect(adapter.files.get(path)).toContain('sourceUrl: "https://example.com/article?x=1"');
  });

  it("uses only a validated 64-character stable id as a filename", async () => {
    const repository = createRepository(new InMemoryAdapter());

    await expect(repository.read("../unsafe")).rejects.toThrow(
      "Invalid collected item id",
    );
    await expect(
      repository.write(createContent({ itemId: "A".repeat(64) })),
    ).rejects.toThrow("Invalid collected item id");
  });

  it("rejects empty content and safely escapes frontmatter provenance", async () => {
    const adapter = new InMemoryAdapter();
    const repository = createRepository(adapter);

    await expect(
      repository.write(createContent({ text: " \n\t " })),
    ).rejects.toThrow("Cached content must not be empty");

    await repository.write(
      createContent({
        sourceUrl: "https://example.com/article\ncontentBasis: injected",
      }),
    );
    const stored = adapter.files.get(`${DATA_ROOT}/content/${ITEM_ID}.md`) ?? "";
    expect(stored).toContain('sourceUrl: "https://example.com/article\\ncontentBasis: injected"');
    expect(stored).toContain("contentBasis: \"full-text\"");
  });

  it("atomically replaces plugin-owned cached content without exposing partial final content", async () => {
    const adapter = new InMemoryAdapter();
    const repository = createRepository(adapter);
    await repository.write(createContent({ text: "<p>Old full text</p>" }));

    adapter.failNextRenameWhere((from, to) =>
      from.includes(".tmp-") && to.endsWith(`${ITEM_ID}.md`),
    );

    await expect(
      repository.write(createContent({ text: "<p>New full text</p>" })),
    ).rejects.toThrow("Injected rename failure");

    expect((await repository.read(ITEM_ID))?.text).toBe("<p>Old full text</p>");
  });

  it("recovers a durable backup when a process stopped after moving the old final", async () => {
    const adapter = new InMemoryAdapter();
    const repository = createRepository(adapter);
    await repository.write(createContent({ text: "<p>Old full text</p>" }));
    const finalPath = `${DATA_ROOT}/content/${ITEM_ID}.md`;
    const backupPath = `${finalPath}.backup-interrupted`;
    await adapter.rename(finalPath, backupPath);

    expect((await repository.read(ITEM_ID))?.text).toBe("<p>Old full text</p>");
    expect(adapter.files.has(finalPath)).toBe(true);
  });

  it("serializes concurrent same-item writes across repository instances", async () => {
    const adapter = new InMemoryAdapter();
    const vault = { adapter } as unknown as Vault;
    const first = createRepository(adapter, vault);
    const second = createRepository(adapter, vault);

    await Promise.all([
      first.write(createContent({ text: "<p>First durable text</p>" })),
      second.write(createContent({ text: "<p>Second durable text</p>" })),
    ]);

    expect((await first.read(ITEM_ID))?.text).toBe("<p>Second durable text</p>");
    expect(
      [...adapter.files.keys()].filter((path) => path.includes(".tmp-") || path.includes(".backup-")),
    ).toEqual([]);
  });

  it("coordinates a read with a sibling write rather than deleting an active temp", async () => {
    const adapter = new InMemoryAdapter();
    const vault = { adapter } as unknown as Vault;
    const writer = createRepository(adapter, vault);
    const reader = createRepository(adapter, vault);
    await writer.write(createContent({ text: "<p>Old durable text</p>" }));

    await Promise.all([
      writer.write(createContent({ text: "<p>Replacement durable text</p>" })),
      reader.read(ITEM_ID),
    ]);

    expect((await reader.read(ITEM_ID))?.text).toBe("<p>Replacement durable text</p>");
  });
});
