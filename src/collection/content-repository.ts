import { AsyncLocalStorage } from "node:async_hooks";
import { normalizePath, type DataAdapter, type Vault } from "obsidian";
import {
  isValidYouTubeVideoId,
  type YouTubeTranscriptProvider,
} from "../youtube-transcript/transcript-types";
import { isValidYouTubeCaptionLanguageCode } from "../youtube-transcript/youtube-caption-language-code";

export interface FullTextCachedItemContent {
  schemaVersion: 1;
  itemId: string;
  sourceUrl?: string;
  fetchedAt: string;
  contentBasis: "full-text";
  text: string;
}

export interface YouTubeTranscriptCachedItemContent {
  schemaVersion: 2;
  contentBasis: "youtube-transcript";
  itemId: string;
  sourceUrl?: string;
  fetchedAt: string;
  videoId: string;
  languageCode: string;
  languageName: string;
  isGenerated: boolean;
  provider: YouTubeTranscriptProvider;
  text: string;
}

export type CachedItemContent =
  | FullTextCachedItemContent
  | YouTubeTranscriptCachedItemContent;

export interface ContentItemTransaction {
  read(): Promise<CachedItemContent | null>;
  write(content: CachedItemContent): Promise<string>;
  pathFor(): string;
}

interface ActiveContentTransaction {
  vault: object;
  key: string;
  active: boolean;
}

const STABLE_ITEM_ID = /^[a-f0-9]{64}$/;
const TRANSCRIPT_FIELDS = new Set([
  "schemaVersion",
  "itemId",
  "sourceUrl",
  "fetchedAt",
  "contentBasis",
  "videoId",
  "languageCode",
  "languageName",
  "isGenerated",
  "provider",
  "text",
]);
const vaultItemQueues = new WeakMap<object, Map<string, Promise<void>>>();
const activeContentTransactions = new AsyncLocalStorage<
  readonly ActiveContentTransaction[]
>();
let transactionSequence = 0;

/**
 * Persists article text explicitly requested by the reader. This repository
 * deliberately owns only files below `{dataRoot}/content`, leaving collection
 * observations and user-authored files untouched.
 */
export class ContentRepository {
  private readonly dataRoot: string;

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
    return await this.transaction(itemId, async (transaction) =>
      await transaction.read(),
    );
  }

  async write(content: CachedItemContent): Promise<string> {
    assertCachedItemContent(content);
    return await this.transaction(content.itemId, async (transaction) =>
      await transaction.write(content),
    );
  }

  async remove(itemId: string): Promise<void> {
    assertStableItemId(itemId);
    this.assertNotReentrant(itemId);
    await this.withItemLock(itemId, async () => await this.removeInternal(itemId));
  }

  pathFor(itemId: string): string {
    return this.contentPath(itemId);
  }

  /**
   * Serializes a complete content-and-metadata operation for one stable item.
   * The transaction methods bypass the outer queue intentionally, preventing
   * nested-lock deadlocks while the caller coordinates a second repository.
   */
  async transaction<T>(
    itemId: string,
    operation: (transaction: ContentItemTransaction) => Promise<T>,
  ): Promise<T> {
    assertStableItemId(itemId);
    this.assertNotReentrant(itemId);
    return await this.withItemLock(itemId, async () => {
      let active = true;
      const assertActive = () => {
        if (!active) throw new Error("Content transaction has ended");
      };
      const transaction: ContentItemTransaction = Object.freeze({
        read: async () => {
          assertActive();
          return await this.readInternal(itemId);
        },
        write: async (content: CachedItemContent) => {
          assertActive();
          assertCachedItemContent(content);
          if (content.itemId !== itemId) {
            throw new Error("Content transaction item mismatch");
          }
          return await this.writeInternal(content);
        },
        pathFor: () => {
          assertActive();
          return this.contentPath(itemId);
        },
      });
      const inherited = activeContentTransactions.getStore() ?? [];
      const context: ActiveContentTransaction = {
        vault: this.vault,
        key: this.itemLockKey(itemId),
        active: true,
      };
      try {
        return await activeContentTransactions.run(
          [...inherited, context],
          async () => await operation(transaction),
        );
      } finally {
        active = false;
        context.active = false;
      }
    });
  }

  private assertNotReentrant(itemId: string): void {
    const key = this.itemLockKey(itemId);
    if (
      (activeContentTransactions.getStore() ?? []).some(
        (entry) => entry.active && entry.vault === this.vault && entry.key === key,
      )
    ) {
      throw new Error("Reentrant content transaction is not allowed");
    }
  }

  private itemLockKey(itemId: string): string {
    return `${this.dataRoot}\0${itemId}`;
  }

  private async withItemLock<T>(
    itemId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const queues = vaultItemQueues.get(this.vault) ?? new Map<string, Promise<void>>();
    vaultItemQueues.set(this.vault, queues);
    const key = this.itemLockKey(itemId);
    const prior = queues.get(key) ?? Promise.resolve();
    const running = prior.catch(() => undefined).then(operation);
    const settled = running.then(() => undefined, () => undefined);
    queues.set(key, settled);
    try {
      return await running;
    } finally {
      if (queues.get(key) === settled) queues.delete(key);
      if (queues.size === 0) vaultItemQueues.delete(this.vault);
    }
  }

  private async writeInternal(content: CachedItemContent): Promise<string> {
    await this.ensureDirectory(this.dataRoot);
    await this.ensureDirectory(this.contentDirectory);
    const path = this.contentPath(content.itemId);
    await this.atomicWrite(path, serializeCachedItemContent(content));
    return path;
  }

  private async readInternal(itemId: string): Promise<CachedItemContent | null> {
    const path = this.contentPath(itemId);
    await this.recoverAtomicTarget(path);
    if (!(await this.vault.adapter.exists(path))) return null;
    const content = parseCachedItemContent(await this.vault.adapter.read(path));
    return content?.itemId === itemId ? content : null;
  }

  private async removeInternal(itemId: string): Promise<void> {
    const path = this.contentPath(itemId);
    await this.recoverAtomicTarget(path);
    const adapter = this.vault.adapter as Partial<DataAdapter>;
    if (
      typeof adapter.remove === "function" &&
      (await this.vault.adapter.exists(path))
    ) {
      await adapter.remove.call(this.vault.adapter, path);
    }
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
      try {
        await this.vault.adapter.mkdir(path);
      } catch (error) {
        if (!(await this.vault.adapter.exists(path))) throw error;
      }
    }
  }

  private async atomicWrite(path: string, content: string): Promise<void> {
    await this.recoverAtomicTarget(path);
    const adapter = this.vault.adapter as Partial<DataAdapter>;
    if (typeof adapter.rename !== "function" || typeof adapter.remove !== "function") {
      throw new Error("Atomic content writes require rename and remove support");
    }

    const writeId = nextTransactionId(this.clock);
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
    content.schemaVersion === 2
      ? `videoId: ${JSON.stringify(content.videoId)}`
      : undefined,
    content.schemaVersion === 2
      ? `languageCode: ${JSON.stringify(content.languageCode)}`
      : undefined,
    content.schemaVersion === 2
      ? `languageName: ${JSON.stringify(content.languageName)}`
      : undefined,
    content.schemaVersion === 2
      ? `isGenerated: ${JSON.stringify(content.isGenerated)}`
      : undefined,
    content.schemaVersion === 2
      ? `provider: ${JSON.stringify(content.provider)}`
      : undefined,
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
    if (fields.has(match[1])) return null;
    try {
      fields.set(match[1], JSON.parse(match[2]));
    } catch {
      return null;
    }
  }

  const schemaVersion = fields.get("schemaVersion");
  let candidate: CachedItemContent;
  if (schemaVersion === 1) {
    candidate = {
      schemaVersion: 1,
      itemId: fields.get("itemId") as string,
      sourceUrl: fields.get("sourceUrl") as string | undefined,
      fetchedAt: fields.get("fetchedAt") as string,
      contentBasis: fields.get("contentBasis") as "full-text",
      text: frontmatter[2],
    };
  } else if (schemaVersion === 2) {
    const allowedFrontmatter = new Set(
      [...TRANSCRIPT_FIELDS].filter((field) => field !== "text"),
    );
    if ([...fields.keys()].some((field) => !allowedFrontmatter.has(field))) {
      return null;
    }
    candidate = {
      schemaVersion: 2,
      itemId: fields.get("itemId") as string,
      sourceUrl: fields.get("sourceUrl") as string | undefined,
      fetchedAt: fields.get("fetchedAt") as string,
      contentBasis: fields.get("contentBasis") as "youtube-transcript",
      videoId: fields.get("videoId") as string,
      languageCode: fields.get("languageCode") as string,
      languageName: fields.get("languageName") as string,
      isGenerated: fields.get("isGenerated") as boolean,
      provider: fields.get("provider") as YouTubeTranscriptProvider,
      text: frontmatter[2],
    };
  } else {
    return null;
  }
  try {
    assertCachedItemContent(candidate);
    return candidate;
  } catch {
    return null;
  }
}

function assertCachedItemContent(content: CachedItemContent): void {
  if (!isRecord(content)) throw new Error("Invalid cached content schema");
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
  if (content.schemaVersion === 1) {
    if (content.contentBasis !== "full-text") {
      throw new Error("Invalid cached content schema");
    }
    return;
  }
  if (
    content.schemaVersion !== 2 ||
    content.contentBasis !== "youtube-transcript"
  ) {
    throw new Error("Invalid cached content schema");
  }
  if (
    Object.keys(content).some((field) => !TRANSCRIPT_FIELDS.has(field))
  ) {
    throw new Error("Invalid cached transcript fields");
  }
  if (!isValidYouTubeVideoId(content.videoId)) {
    throw new Error("Invalid cached transcript video id");
  }
  if (
    !isValidYouTubeCaptionLanguageCode(content.languageCode)
  ) {
    throw new Error("Invalid cached transcript language code");
  }
  if (
    typeof content.languageName !== "string" ||
    !content.languageName.trim() ||
    content.languageName.length > 200 ||
    hasUnsafeControl(content.languageName)
  ) {
    throw new Error("Invalid cached transcript language name");
  }
  if (typeof content.isGenerated !== "boolean") {
    throw new Error("Invalid cached transcript generation flag");
  }
  if (
    content.provider !== "innertube" &&
    content.provider !== "tikhub" &&
    content.provider !== "yt-dlp"
  ) {
    throw new Error("Invalid cached transcript provider");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasUnsafeControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
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

function nextTransactionId(clock: () => Date): string {
  const random = window.crypto?.randomUUID?.().replace(/-/g, "") ??
    Math.random().toString(36).slice(2);
  return `${clock().getTime()}-${transactionSequence++}-${random}`;
}
