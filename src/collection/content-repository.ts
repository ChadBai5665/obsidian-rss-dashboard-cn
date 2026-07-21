import { normalizePath, type DataAdapter, type Vault } from "obsidian";

export interface CachedItemContent {
  schemaVersion: 1;
  itemId: string;
  sourceUrl?: string;
  fetchedAt: string;
  contentBasis: "full-text";
  text: string;
}

const STABLE_ITEM_ID = /^[a-f0-9]{64}$/;

/**
 * Persists article text explicitly requested by the reader. This repository
 * deliberately owns only files below `{dataRoot}/content`, leaving collection
 * observations and user-authored files untouched.
 */
export class ContentRepository {
  private readonly dataRoot: string;
  private readonly pendingWrites = new Map<string, Promise<void>>();
  private writeSequence = 0;

  constructor(
    private readonly vault: Vault,
    dataRoot: string,
    private readonly clock: () => Date,
  ) {
    const trimmedRoot = dataRoot.trim();
    assertSafeDataRoot(trimmedRoot);
    this.dataRoot = normalizePath(trimmedRoot);
  }

  async read(itemId: string): Promise<CachedItemContent | null> {
    assertStableItemId(itemId);
    const path = this.contentPath(itemId);
    await this.recoverAtomicTarget(path);
    if (!(await this.vault.adapter.exists(path))) {
      return null;
    }

    const content = parseCachedItemContent(await this.vault.adapter.read(path));
    return content?.itemId === itemId ? content : null;
  }

  async write(content: CachedItemContent): Promise<string> {
    assertCachedItemContent(content);
    const prior = this.pendingWrites.get(content.itemId) ?? Promise.resolve();
    const operation = prior
      .catch(() => undefined)
      .then(async () => this.writeInternal(content));
    const settled = operation.then(
      () => undefined,
      () => undefined,
    );
    this.pendingWrites.set(content.itemId, settled);

    try {
      return await operation;
    } finally {
      if (this.pendingWrites.get(content.itemId) === settled) {
        this.pendingWrites.delete(content.itemId);
      }
    }
  }

  async remove(itemId: string): Promise<void> {
    assertStableItemId(itemId);
    const path = this.contentPath(itemId);
    await this.recoverAtomicTarget(path);
    const adapter = this.vault.adapter as Partial<DataAdapter>;
    if (typeof adapter.remove === "function" && (await this.vault.adapter.exists(path))) {
      await adapter.remove.call(this.vault.adapter, path);
    }
  }

  private async writeInternal(content: CachedItemContent): Promise<string> {
    await this.ensureDirectory(this.dataRoot);
    await this.ensureDirectory(this.contentDirectory);
    const path = this.contentPath(content.itemId);
    await this.atomicWrite(path, serializeCachedItemContent(content));
    return path;
  }

  private get contentDirectory(): string {
    return normalizePath(`${this.dataRoot}/content`);
  }

  private contentPath(itemId: string): string {
    assertStableItemId(itemId);
    return normalizePath(`${this.contentDirectory}/${itemId}.md`);
  }

  private async ensureDirectory(path: string): Promise<void> {
    if (!(await this.vault.adapter.exists(path))) {
      await this.vault.adapter.mkdir(path);
    }
  }

  private async atomicWrite(path: string, content: string): Promise<void> {
    await this.recoverAtomicTarget(path);
    const adapter = this.vault.adapter as Partial<DataAdapter>;
    if (typeof adapter.rename !== "function" || typeof adapter.remove !== "function") {
      throw new Error("Atomic content writes require rename and remove support");
    }

    const writeId = `${this.clock().getTime()}-${this.writeSequence++}`;
    const tempPath = `${path}.tmp-${writeId}`;
    await this.vault.adapter.write(tempPath, content);

    if (!(await this.vault.adapter.exists(path))) {
      await adapter.rename.call(this.vault.adapter, tempPath, path);
      return;
    }

    const backupPath = `${path}.backup-${writeId}`;
    await adapter.rename.call(this.vault.adapter, path, backupPath);
    try {
      await adapter.rename.call(this.vault.adapter, tempPath, path);
    } catch (replaceError) {
      try {
        await adapter.rename.call(this.vault.adapter, backupPath, path);
      } catch (restoreError) {
        throw new Error(
          `Atomic content replacement and restore both failed: ${errorMessage(replaceError)}; recovery: ${errorMessage(restoreError)}`,
        );
      }
      throw replaceError;
    }

    await this.bestEffortRemove(backupPath);
  }

  private async recoverAtomicTarget(path: string): Promise<void> {
    const parent = parentPath(path);
    if (!parent || !(await this.vault.adapter.exists(parent))) {
      return;
    }

    const listed = await this.vault.adapter.list(parent);
    const backups = listed.files
      .filter((candidate) => candidate.startsWith(`${path}.backup-`))
      .sort()
      .reverse();
    const temps = listed.files.filter((candidate) =>
      candidate.startsWith(`${path}.tmp-`),
    );

    if (await this.vault.adapter.exists(path)) {
      await this.cleanupSiblings([...backups, ...temps]);
      return;
    }

    const adapter = this.vault.adapter as Partial<DataAdapter>;
    if (typeof adapter.rename !== "function") {
      return;
    }

    let restored: string | null = null;
    for (const backup of backups) {
      try {
        const cached = parseCachedItemContent(await this.vault.adapter.read(backup));
        if (!cached || this.contentPath(cached.itemId) !== path) {
          continue;
        }
        await adapter.rename.call(this.vault.adapter, backup, path);
        restored = backup;
        break;
      } catch {
        // A malformed backup cannot become the durable final file.
      }
    }

    if (restored) {
      await this.cleanupSiblings(
        [...backups, ...temps].filter((candidate) => candidate !== restored),
      );
    }
  }

  private async cleanupSiblings(paths: string[]): Promise<void> {
    for (const path of paths) {
      await this.bestEffortRemove(path);
    }
  }

  private async bestEffortRemove(path: string): Promise<void> {
    const adapter = this.vault.adapter as Partial<DataAdapter>;
    if (typeof adapter.remove !== "function") return;
    try {
      await adapter.remove.call(this.vault.adapter, path);
    } catch {
      // Cleanup debt is harmless and will be retried on a later repository access.
    }
  }
}

function serializeCachedItemContent(content: CachedItemContent): string {
  const lines = [
    "---",
    `schemaVersion: ${content.schemaVersion}`,
    `itemId: ${JSON.stringify(content.itemId)}`,
    content.sourceUrl === undefined
      ? undefined
      : `sourceUrl: ${JSON.stringify(content.sourceUrl)}`,
    `fetchedAt: ${JSON.stringify(content.fetchedAt)}`,
    `contentBasis: ${JSON.stringify(content.contentBasis)}`,
    "---",
    "",
  ].filter((line): line is string => line !== undefined);
  return `${lines.join("\n")}${content.text}`;
}

function parseCachedItemContent(raw: string): CachedItemContent | null {
  const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n(?:\r?\n)?([\s\S]*)$/);
  if (!frontmatter) return null;

  const fields = new Map<string, unknown>();
  for (const line of frontmatter[1].split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9]*):\s(.+)$/);
    if (!match) return null;
    try {
      fields.set(match[1], JSON.parse(match[2]));
    } catch {
      if (match[1] === "schemaVersion" && match[2] === "1") {
        fields.set(match[1], 1);
      } else {
        return null;
      }
    }
  }

  const candidate: CachedItemContent = {
    schemaVersion: fields.get("schemaVersion") as 1,
    itemId: fields.get("itemId") as string,
    sourceUrl: fields.get("sourceUrl") as string | undefined,
    fetchedAt: fields.get("fetchedAt") as string,
    contentBasis: fields.get("contentBasis") as "full-text",
    text: frontmatter[2],
  };
  try {
    assertCachedItemContent(candidate);
    return candidate;
  } catch {
    return null;
  }
}

function assertCachedItemContent(content: CachedItemContent): void {
  if (content.schemaVersion !== 1 || content.contentBasis !== "full-text") {
    throw new Error("Invalid cached content schema");
  }
  assertStableItemId(content.itemId);
  if (typeof content.fetchedAt !== "string" || Number.isNaN(Date.parse(content.fetchedAt))) {
    throw new Error("Invalid cached content timestamp");
  }
  if (content.sourceUrl !== undefined && typeof content.sourceUrl !== "string") {
    throw new Error("Invalid cached content source URL");
  }
  if (typeof content.text !== "string" || !content.text.trim()) {
    throw new Error("Cached content must not be empty");
  }
}

function assertStableItemId(value: string): void {
  if (!STABLE_ITEM_ID.test(value)) {
    throw new Error("Invalid collected item id");
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
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Invalid data root: ${value}`);
  }
}

function parentPath(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator === -1 ? "" : path.slice(0, separator);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
