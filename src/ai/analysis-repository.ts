import { normalizePath, type DataAdapter, type Vault } from "obsidian";
import { renderAnalysisMarkdown } from "./analysis-markdown";
import { snapshotAiAnalysisResult } from "./analysis-result";

export interface AnalysisRepositoryOptions {
  /** Test seam; production values must remain unique and high entropy. */
  randomSuffix?: () => string;
}

const adapterQueues = new WeakMap<object, Map<string, Promise<void>>>();
const MAX_COLLISION_ATTEMPTS = 10_000;
const MAX_TEMP_ATTEMPTS = 32;
let tempSequence = 0;

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
    const adapter = this.atomicAdapter();
    const transactionId = this.nextTransactionId();
    return await this.withItemLock(result.itemId, async () => {
      await this.ensureDirectory(this.dataRoot);
      await this.ensureDirectory(this.analysisDirectory);
      await this.ensureDirectory(this.itemDirectory(result.itemId));
      return await this.saveExclusive(result, markdown, adapter, transactionId);
    });
  }

  private atomicAdapter(): Required<Pick<DataAdapter, "copy" | "remove" | "rename">> {
    const adapter = this.vault.adapter as Partial<DataAdapter>;
    if (
      typeof adapter.copy !== "function" ||
      typeof adapter.remove !== "function" ||
      typeof adapter.rename !== "function"
    ) {
      throw new Error("AI analysis writes require exclusive atomic storage support");
    }
    return {
      copy: adapter.copy.bind(this.vault.adapter),
      remove: adapter.remove.bind(this.vault.adapter),
      rename: adapter.rename.bind(this.vault.adapter),
    };
  }

  private async saveExclusive(
    result: ReturnType<typeof snapshotAiAnalysisResult>,
    markdown: string,
    adapter: Required<Pick<DataAdapter, "copy" | "remove" | "rename">>,
    transactionId: string,
  ): Promise<string> {
    const stem = `${utcPathTimestamp(result.createdAt)}-${result.operation}`;
    for (let index = 1; index <= MAX_COLLISION_ATTEMPTS; index += 1) {
      const suffix = index === 1 ? "" : `-${index}`;
      const finalPath = normalizePath(
        `${this.itemDirectory(result.itemId)}/${stem}${suffix}.md`,
      );
      if (await this.vault.adapter.exists(finalPath, true)) continue;

      const stagingPath = await this.writeUniqueTemp(
        finalPath,
        markdown,
        transactionId,
        "content",
      );
      const exclusiveTempPath = `${finalPath}.tmp-claim`;
      const claimToken = `${transactionId}:rss-dashboard-cn-analysis-claim`;
      let claimSourcePath: string;
      try {
        claimSourcePath = await this.writeUniqueTemp(
          finalPath,
          claimToken,
          transactionId,
          "owner",
        );
      } catch (error) {
        await this.bestEffortRemove(stagingPath, adapter);
        throw error;
      }
      try {
        // DataAdapter.copy is the only adapter operation documented to fail
        // when its target exists, so it acts as an inter-writer claim. The
        // complete claimed sibling is then atomically renamed into place.
        await adapter.copy(claimSourcePath, exclusiveTempPath);
      } catch (error) {
        const ownsClaim = await this.claimBelongsTo(
          exclusiveTempPath,
          claimToken,
        );
        await this.bestEffortRemove(claimSourcePath, adapter);
        await this.bestEffortRemove(stagingPath, adapter);
        if (ownsClaim) {
          await this.bestEffortRemove(exclusiveTempPath, adapter);
          throw error;
        }
        if (
          await this.vault.adapter.exists(exclusiveTempPath, true) ||
          await this.vault.adapter.exists(finalPath, true)
        ) {
          // Another process/wrapper won this exact name after our check.
          continue;
        }
        throw error;
      }

      const ownsCompleteClaim = await this.claimBelongsTo(
        exclusiveTempPath,
        claimToken,
      );
      await this.bestEffortRemove(claimSourcePath, adapter);
      if (!ownsCompleteClaim) {
        if (await this.claimBelongsTo(exclusiveTempPath, claimToken)) {
          await this.bestEffortRemove(exclusiveTempPath, adapter);
        }
        await this.bestEffortRemove(stagingPath, adapter);
        throw new Error("AI analysis exclusive claim could not be verified");
      }
      if (await this.vault.adapter.exists(finalPath, true)) {
        await this.bestEffortRemove(exclusiveTempPath, adapter);
        await this.bestEffortRemove(stagingPath, adapter);
        continue;
      }
      try {
        await adapter.rename(stagingPath, finalPath);
      } catch (error) {
        const committed = await this.fileEquals(finalPath, markdown);
        await this.bestEffortRemove(stagingPath, adapter);
        await this.bestEffortRemove(exclusiveTempPath, adapter);
        if (committed) return finalPath;
        throw error;
      }
      await this.bestEffortRemove(exclusiveTempPath, adapter);
      return finalPath;
    }
    throw new Error("AI analysis path collision limit reached");
  }

  private async writeUniqueTemp(
    finalPath: string,
    content: string,
    transactionId: string,
    purpose: "content" | "owner",
  ): Promise<string> {
    for (let attempt = 0; attempt < MAX_TEMP_ATTEMPTS; attempt += 1) {
      const tempPath = `${finalPath}.tmp-${transactionId}-${purpose}-${attempt}`;
      if (await this.vault.adapter.exists(tempPath, true)) continue;
      try {
        await this.vault.adapter.write(tempPath, content);
        if (await this.vault.adapter.read(tempPath) !== content) {
          throw new Error("AI analysis temporary file verification failed");
        }
        return tempPath;
      } catch (error) {
        await this.bestEffortRemove(tempPath, this.atomicAdapter());
        throw error;
      }
    }
    throw new Error("Could not allocate a unique AI analysis temporary file");
  }

  private async claimBelongsTo(
    path: string,
    token: string,
  ): Promise<boolean> {
    try {
      if (!(await this.vault.adapter.exists(path, true))) return false;
      const content = await this.vault.adapter.read(path);
      return content === token;
    } catch {
      return false;
    }
  }

  private async fileEquals(path: string, expected: string): Promise<boolean> {
    try {
      return await this.vault.adapter.read(path) === expected;
    } catch {
      return false;
    }
  }

  private nextTransactionId(): string {
    const random = this.randomSuffix();
    assertSafeRandomSuffix(random);
    return `${random}-${tempSequence++}`;
  }

  private async ensureDirectory(path: string): Promise<void> {
    if (await this.vault.adapter.exists(path, true)) return;
    try {
      await this.vault.adapter.mkdir(path);
    } catch (error) {
      if (!(await this.vault.adapter.exists(path, true))) throw error;
    }
  }

  private get analysisDirectory(): string {
    return normalizePath(`${this.dataRoot}/analysis`);
  }

  private itemDirectory(itemId: string): string {
    return normalizePath(`${this.analysisDirectory}/${itemId}`);
  }

  private async bestEffortRemove(
    path: string,
    adapter: Required<Pick<DataAdapter, "remove">>,
  ): Promise<void> {
    try {
      if (await this.vault.adapter.exists(path, true)) {
        await adapter.remove(path);
      }
    } catch {
      // Never replace the primary storage result with cleanup noise.
    }
  }

  private async withItemLock<T>(
    itemId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const adapterIdentity = this.vault.adapter as object;
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
