import { normalizePath, type DataAdapter, type Vault } from "obsidian";
import { renderAnalysisMarkdown } from "./analysis-markdown";
import { snapshotAiAnalysisResult } from "./analysis-result";

export interface AnalysisRepositoryOptions {
  /** Test seam; production values must remain unique and high entropy. */
  randomSuffix?: () => string;
}

type BoundAnalysisAdapter = Required<Pick<
  DataAdapter,
  | "exists"
  | "mkdir"
  | "write"
  | "read"
  | "copy"
  | "remove"
  | "rename"
  | "process"
>> & { identity: object };

const adapterQueues = new WeakMap<object, Map<string, Promise<void>>>();
const CLAIM_SOURCE_CONTENT = "rss-dashboard-cn-analysis-claim-source-v1";
const MAX_COLLISION_ATTEMPTS = 10_000;
const MAX_TEMP_ATTEMPTS = 32;

/** Stores only AI output artifacts below `{dataRoot}/analysis`. */
export class AnalysisRepository {
  private readonly dataRoot: string;
  private readonly randomSuffix: () => string;

  constructor(
    private readonly vault: Vault,
    dataRoot: string,
    options: AnalysisRepositoryOptions = {},
  ) {
    const trimmedRoot = dataRoot.trim();
    assertSafeDataRoot(trimmedRoot);
    this.dataRoot = normalizePath(trimmedRoot);
    this.randomSuffix = options.randomSuffix ?? defaultRandomSuffix;
  }

  async save(value: unknown): Promise<string> {
    // Snapshot and render before checking or creating anything in the vault.
    const result = snapshotAiAnalysisResult(value);
    const markdown = renderAnalysisMarkdown(result);

    // Bind every method once before transaction allocation, queuing, or I/O.
    const adapter = this.atomicAdapter();
    const transactionId = this.nextTransactionId();
    const ownershipNonce = defaultRandomSuffix();
    const claimToken = `${ownershipNonce}:${transactionId}:${result.id}`;

    return await this.withItemLock(adapter.identity, result.itemId, async () => {
      await this.ensureDirectory(adapter, this.dataRoot);
      await this.ensureDirectory(adapter, this.analysisDirectory);
      await this.ensureDirectory(adapter, this.itemDirectory(result.itemId));
      await this.ensureClaimSource(adapter);
      return await this.saveExclusive(
        result,
        markdown,
        adapter,
        transactionId,
        claimToken,
      );
    });
  }

  private atomicAdapter(): BoundAnalysisAdapter {
    const identity = this.vault.adapter as object;
    const adapter = identity as Partial<DataAdapter>;
    const exists = adapter.exists;
    const mkdir = adapter.mkdir;
    const write = adapter.write;
    const read = adapter.read;
    const copy = adapter.copy;
    const remove = adapter.remove;
    const rename = adapter.rename;
    const process = adapter.process;
    if (
      typeof exists !== "function" ||
      typeof mkdir !== "function" ||
      typeof write !== "function" ||
      typeof read !== "function" ||
      typeof copy !== "function" ||
      typeof remove !== "function" ||
      typeof rename !== "function" ||
      typeof process !== "function"
    ) {
      throw new Error("AI analysis writes require complete atomic storage support");
    }
    return {
      identity,
      exists: exists.bind(identity),
      mkdir: mkdir.bind(identity),
      write: write.bind(identity),
      read: read.bind(identity),
      copy: copy.bind(identity),
      remove: remove.bind(identity),
      rename: rename.bind(identity),
      process: process.bind(identity),
    };
  }

  private async ensureClaimSource(adapter: BoundAnalysisAdapter): Promise<void> {
    if (await adapter.exists(this.claimSourcePath, true)) {
      if (await this.fileEquals(adapter, this.claimSourcePath, CLAIM_SOURCE_CONTENT)) {
        return;
      }
      throw new Error("AI analysis claim source conflicts with an existing file");
    }

    let conflict = false;
    // DataAdapter.process cannot distinguish a missing file from an empty file
    // created in the exists-to-process window. A constant bootstrap value makes
    // cooperating repository races byte-identical; non-empty foreign data is
    // preserved and rejected.
    const processed = await adapter.process(this.claimSourcePath, (current) => {
      if (current && current !== CLAIM_SOURCE_CONTENT) {
        conflict = true;
        return current;
      }
      return CLAIM_SOURCE_CONTENT;
    });
    if (
      conflict ||
      processed !== CLAIM_SOURCE_CONTENT ||
      !(await this.fileEquals(adapter, this.claimSourcePath, CLAIM_SOURCE_CONTENT))
    ) {
      throw new Error("AI analysis claim source could not be initialized safely");
    }
  }

  private async saveExclusive(
    result: ReturnType<typeof snapshotAiAnalysisResult>,
    markdown: string,
    adapter: BoundAnalysisAdapter,
    transactionId: string,
    claimToken: string,
  ): Promise<string> {
    const stem = `${utcPathTimestamp(result.createdAt)}-${result.operation}`;
    for (let index = 1; index <= MAX_COLLISION_ATTEMPTS; index += 1) {
      const suffix = index === 1 ? "" : `-${index}`;
      const finalPath = normalizePath(
        `${this.itemDirectory(result.itemId)}/${stem}${suffix}.md`,
      );
      if (await adapter.exists(finalPath, true)) continue;

      const stagingPath = await this.writeClaimedTemp(
        finalPath,
        markdown,
        transactionId,
        "content",
        adapter,
      );
      let ownerSourcePath: string;
      try {
        ownerSourcePath = await this.writeClaimedTemp(
          finalPath,
          claimToken,
          transactionId,
          "owner",
          adapter,
        );
      } catch (error) {
        await this.removeIfExact(adapter, stagingPath, markdown);
        throw error;
      }

      const exclusiveTempPath = `${finalPath}.tmp-claim`;
      try {
        // The transaction-specific owner source makes a successful copy an
        // exclusive claim without ever copying partial Markdown to the final.
        await adapter.copy(ownerSourcePath, exclusiveTempPath);
      } catch (error) {
        const ownsClaim = await this.fileEquals(
          adapter,
          exclusiveTempPath,
          claimToken,
        );
        await this.removeIfExact(adapter, ownerSourcePath, claimToken);
        await this.removeIfExact(adapter, stagingPath, markdown);
        if (ownsClaim) {
          await this.removeIfExact(adapter, exclusiveTempPath, claimToken);
          throw error;
        }
        if (
          await adapter.exists(exclusiveTempPath, true) ||
          await adapter.exists(finalPath, true)
        ) {
          // Another process/wrapper won this exact name after our check.
          continue;
        }
        throw error;
      }

      const ownsCompleteClaim = await this.fileEquals(
        adapter,
        exclusiveTempPath,
        claimToken,
      );
      await this.removeIfExact(adapter, ownerSourcePath, claimToken);
      if (!ownsCompleteClaim) {
        await this.removeIfExact(adapter, stagingPath, markdown);
        throw new Error("AI analysis exclusive claim could not be verified");
      }
      if (await adapter.exists(finalPath, true)) {
        await this.removeIfExact(adapter, exclusiveTempPath, claimToken);
        await this.removeIfExact(adapter, stagingPath, markdown);
        continue;
      }
      try {
        // DataAdapter exposes no no-replace rename. The claim coordinates every
        // repository writer, but a non-cooperating external process could still
        // create finalPath in the narrow exists-to-rename window.
        await adapter.rename(stagingPath, finalPath);
      } catch (error) {
        const committed = await this.fileEquals(adapter, finalPath, markdown);
        await this.removeIfExact(adapter, stagingPath, markdown);
        await this.removeIfExact(adapter, exclusiveTempPath, claimToken);
        if (committed) return finalPath;
        throw error;
      }
      await this.removeIfExact(adapter, exclusiveTempPath, claimToken);
      return finalPath;
    }
    throw new Error("AI analysis path collision limit reached");
  }

  private async writeClaimedTemp(
    finalPath: string,
    content: string,
    transactionId: string,
    purpose: "content" | "owner",
    adapter: BoundAnalysisAdapter,
  ): Promise<string> {
    for (let attempt = 0; attempt < MAX_TEMP_ATTEMPTS; attempt += 1) {
      const tempPath = `${finalPath}.tmp-${transactionId}-${purpose}-${attempt}`;
      try {
        await adapter.copy(this.claimSourcePath, tempPath);
      } catch (error) {
        if (await adapter.exists(tempPath, true)) {
          // Never write to or delete a candidate another writer may own.
          continue;
        }
        throw error;
      }

      if (!(await this.fileEquals(adapter, tempPath, CLAIM_SOURCE_CONTENT))) {
        throw new Error("AI analysis temporary ownership could not be verified");
      }
      try {
        await adapter.write(tempPath, content);
      } catch (error) {
        await this.removeIfExact(adapter, tempPath, CLAIM_SOURCE_CONTENT);
        throw error;
      }
      if (!(await this.fileEquals(adapter, tempPath, content))) {
        // A non-exact value is ambiguous; leave the non-Markdown staging file
        // rather than risk deleting a file changed by another process.
        await this.removeIfExact(adapter, tempPath, CLAIM_SOURCE_CONTENT);
        throw new Error("AI analysis temporary file verification failed");
      }
      return tempPath;
    }
    throw new Error("Could not allocate a unique AI analysis temporary file");
  }

  private async ensureDirectory(
    adapter: BoundAnalysisAdapter,
    path: string,
  ): Promise<void> {
    if (await adapter.exists(path, true)) return;
    try {
      await adapter.mkdir(path);
    } catch (error) {
      if (!(await adapter.exists(path, true))) throw error;
    }
  }

  private get analysisDirectory(): string {
    return normalizePath(`${this.dataRoot}/analysis`);
  }

  private get claimSourcePath(): string {
    return normalizePath(`${this.analysisDirectory}/.claim-source-v1`);
  }

  private itemDirectory(itemId: string): string {
    return normalizePath(`${this.analysisDirectory}/${itemId}`);
  }

  private async fileEquals(
    adapter: BoundAnalysisAdapter,
    path: string,
    expected: string,
  ): Promise<boolean> {
    try {
      return await adapter.read(path) === expected;
    } catch {
      return false;
    }
  }

  private async removeIfExact(
    adapter: BoundAnalysisAdapter,
    path: string,
    expected: string,
  ): Promise<void> {
    try {
      if (await this.fileEquals(adapter, path, expected)) {
        await adapter.remove(path);
      }
    } catch {
      // Never replace the primary storage result with cleanup noise.
    }
  }

  private nextTransactionId(): string {
    const random = this.randomSuffix();
    assertSafeRandomSuffix(random);
    return random;
  }

  private async withItemLock<T>(
    adapterIdentity: object,
    itemId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const queues = adapterQueues.get(adapterIdentity) ?? new Map<string, Promise<void>>();
    adapterQueues.set(adapterIdentity, queues);
    const key = `${this.dataRoot}\0${itemId}`;
    const previous = queues.get(key) ?? Promise.resolve();
    const running = previous.catch(() => undefined).then(operation);
    const settled = running.then(() => undefined, () => undefined);
    queues.set(key, settled);
    try {
      return await running;
    } finally {
      if (queues.get(key) === settled) queues.delete(key);
      if (queues.size === 0) adapterQueues.delete(adapterIdentity);
    }
  }
}

function utcPathTimestamp(value: string): string {
  return value.replace(/[-:.Z]/gu, "");
}

function assertSafeDataRoot(value: string): void {
  const segments = value.split("/");
  if (
    !value ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    /^[A-Za-z]:/u.test(value) ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Invalid data root: ${value}`);
  }
}

function assertSafeRandomSuffix(value: string): void {
  if (!/^[A-Za-z0-9_-]{16,128}$/u.test(value)) {
    throw new Error("Invalid AI analysis temporary suffix");
  }
}

function defaultRandomSuffix(): string {
  const uuid = window.crypto?.randomUUID?.();
  if (uuid) return uuid.replace(/-/gu, "");
  const words = new Uint32Array(4);
  window.crypto.getRandomValues(words);
  return Array.from(words, (word) => word.toString(16).padStart(8, "0")).join("");
}
