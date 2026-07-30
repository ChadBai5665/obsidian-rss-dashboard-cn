import { normalizePath, type DataAdapter, type Vault } from "obsidian";
import { renderAnalysisMarkdown } from "./analysis-markdown";
import {
  analysisArtifactPathItemId,
  parseAnalysisMarkdown,
  parseAnalysisArtifactPath,
  type AiAnalysisArtifact,
} from "./analysis-markdown-parser";
import {
  AI_ANALYSIS_OPERATIONS,
  snapshotAiAnalysisResult,
  type AiAnalysisResult,
} from "./analysis-result";
import type { AiOperation } from "./prompts/prompt-types";

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
  | "rmdir"
  | "rename"
>> & {
  identity: object;
  createFolder: (path: string) => Promise<unknown>;
};
type BoundAnalysisReadAdapter = Required<Pick<DataAdapter, "read">> & {
  identity: object;
};
type BoundAnalysisListAdapter = Required<Pick<DataAdapter, "list" | "read">> & {
  identity: object;
};

const adapterQueues = new WeakMap<object, Map<string, Promise<void>>>();
const CLAIM_SOURCE_CONTENT = "rss-dashboard-cn-analysis-claim-source-v1";
const MAX_COLLISION_ATTEMPTS = 10_000;
const MAX_TEMP_ATTEMPTS = 32;
export const MAX_AI_ANALYSIS_HISTORY_FILES = 256;
export const MAX_AI_ANALYSIS_MARKDOWN_CHARACTERS = 1_100_000;
export const MAX_AI_ANALYSIS_MARKDOWN_BYTES = 4_400_000;
export const MAX_AI_ANALYSIS_HISTORY_TOTAL_BYTES = 16_000_000;
const STABLE_ITEM_ID = /^[a-f0-9]{64}$/u;
const OPERATIONS: ReadonlySet<string> = new Set(AI_ANALYSIS_OPERATIONS);

export class AnalysisArtifactVerificationError extends Error {
  constructor() {
    super("The saved AI analysis artifact could not be verified");
    this.name = "AnalysisArtifactVerificationError";
  }
}

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

  async list(
    itemId: string,
    operation?: AiOperation,
  ): Promise<AiAnalysisArtifact[]> {
    if (
      typeof itemId !== "string" ||
      !STABLE_ITEM_ID.test(itemId) ||
      (operation !== undefined &&
        (typeof operation !== "string" || !OPERATIONS.has(operation)))
    ) {
      return frozenArtifacts([]);
    }
    const adapter = this.listAdapter();
    const directory = this.itemDirectory(itemId);
    let listed: unknown;
    try {
      listed = await adapter.list(directory);
    } catch {
      return frozenArtifacts([]);
    }
    const files = snapshotListedFiles(listed);
    if (!files) return frozenArtifacts([]);

    const canonicalPaths: Array<{
      path: string;
      createdAt: string;
    }> = [];
    for (const path of files) {
      const metadata = parseAnalysisArtifactPath(path, this.analysisDirectory);
      if (
        metadata?.itemId !== itemId ||
        (operation !== undefined && metadata.operation !== operation)
      ) {
        continue;
      }
      canonicalPaths.push({ path, createdAt: metadata.createdAt });
    }
    const candidates = canonicalPaths
      .sort((left, right) =>
        compareText(right.createdAt, left.createdAt) ||
        compareText(left.path, right.path))
      .slice(0, MAX_AI_ANALYSIS_HISTORY_FILES)
      .map(({ path }) => path);
    const artifacts: AiAnalysisArtifact[] = [];
    let totalBytes = 0;
    for (const path of candidates) {
      const artifactContent = await this.readBounded(adapter, path);
      if (!artifactContent) continue;
      totalBytes += artifactContent.bytes;
      if (totalBytes > MAX_AI_ANALYSIS_HISTORY_TOTAL_BYTES) break;
      const artifact = parseAnalysisMarkdown(
        artifactContent.text,
        path,
        this.analysisDirectory,
      );
      if (!artifact || (operation !== undefined &&
        artifact.record.operation !== operation)) {
        continue;
      }
      artifacts.push(artifact);
    }
    artifacts.sort((left, right) => {
      const newestFirst = right.record.createdAt.localeCompare(
        left.record.createdAt,
      );
      return newestFirst || compareText(left.path, right.path);
    });
    return frozenArtifacts(artifacts);
  }

  async latest(
    itemId: string,
    operation: AiOperation,
  ): Promise<AiAnalysisArtifact | null> {
    const artifacts = await this.list(itemId, operation);
    return artifacts[0] ?? null;
  }

  async read(path: string): Promise<AiAnalysisArtifact | null> {
    if (
      analysisArtifactPathItemId(path, this.analysisDirectory) === undefined
    ) {
      return null;
    }
    const adapter = this.readAdapter();
    const artifactContent = await this.readBounded(adapter, path);
    return artifactContent
      ? parseAnalysisMarkdown(
        artifactContent.text,
        path,
        this.analysisDirectory,
      )
      : null;
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
      await this.ensureClaimSource(adapter, transactionId);
      return await this.saveExclusive(
        result,
        markdown,
        adapter,
        transactionId,
        claimToken,
      );
    });
  }

  /**
   * Revalidates an exact repository-owned artifact immediately before handing
   * its trusted result snapshot to a consumer. The adapter cannot lock out an
   * unrelated external process after the read, so the consumer is invoked in
   * the same repository queue with no additional repository await boundary.
   */
  async withVerifiedArtifact<T>(
    path: unknown,
    value: unknown,
    consume: (result: AiAnalysisResult) => Promise<T> | T,
  ): Promise<T> {
    const result = Object.freeze(snapshotAiAnalysisResult(value));
    const markdown = renderAnalysisMarkdown(result);
    const artifactPath = this.expectedArtifactPath(path, result);
    if (typeof consume !== "function") {
      throw new AnalysisArtifactVerificationError();
    }
    const adapter = this.atomicAdapter();

    return await this.withItemLock(adapter.identity, result.itemId, async () => {
      if (!(await this.fileEquals(adapter, artifactPath, markdown))) {
        throw new AnalysisArtifactVerificationError();
      }
      return await consume(result);
    });
  }

  private atomicAdapter(): BoundAnalysisAdapter {
    const identity = this.vault.adapter as object;
    const adapter = identity as Partial<DataAdapter>;
    const createFolder = typeof this.vault.createFolder === "function"
      ? this.vault.createFolder.bind(this.vault)
      : undefined;
    const exists = adapter.exists;
    const mkdir = adapter.mkdir;
    const write = adapter.write;
    const read = adapter.read;
    const copy = adapter.copy;
    const remove = adapter.remove;
    const rmdir = adapter.rmdir;
    const rename = adapter.rename;
    if (
      typeof exists !== "function" ||
      typeof mkdir !== "function" ||
      typeof write !== "function" ||
      typeof read !== "function" ||
      typeof copy !== "function" ||
      typeof remove !== "function" ||
      typeof rmdir !== "function" ||
      typeof rename !== "function" ||
      typeof createFolder !== "function"
    ) {
      throw new Error("AI analysis writes require complete atomic storage support");
    }
    return {
      identity,
      createFolder,
      exists: exists.bind(identity),
      mkdir: mkdir.bind(identity),
      write: write.bind(identity),
      read: read.bind(identity),
      copy: copy.bind(identity),
      remove: remove.bind(identity),
      rmdir: rmdir.bind(identity),
      rename: rename.bind(identity),
    };
  }

  private readAdapter(): BoundAnalysisReadAdapter {
    const identity = this.vault.adapter as object;
    const read = (identity as Partial<DataAdapter>).read;
    if (typeof read !== "function") {
      throw new Error("AI analysis reads require storage read support");
    }
    return {
      identity,
      read: read.bind(identity),
    };
  }

  private listAdapter(): BoundAnalysisListAdapter {
    const identity = this.vault.adapter as object;
    const adapter = identity as Partial<DataAdapter>;
    const list = adapter.list;
    const read = adapter.read;
    if (typeof list !== "function" || typeof read !== "function") {
      throw new Error("AI analysis listing requires list and read support");
    }
    return {
      identity,
      list: list.bind(identity),
      read: read.bind(identity),
    };
  }

  private async readBounded(
    adapter: BoundAnalysisReadAdapter,
    path: string,
  ): Promise<{ text: string; bytes: number } | null> {
    let text: string;
    try {
      text = await adapter.read(path);
    } catch {
      return null;
    }
    if (
      typeof text !== "string" ||
      text.length > MAX_AI_ANALYSIS_MARKDOWN_CHARACTERS
    ) {
      return null;
    }
    const bytes = new TextEncoder().encode(text).byteLength;
    return bytes <= MAX_AI_ANALYSIS_MARKDOWN_BYTES
      ? { text, bytes }
      : null;
  }

  private async ensureClaimSource(
    adapter: BoundAnalysisAdapter,
    transactionId: string,
  ): Promise<void> {
    if (await adapter.exists(this.claimSourcePath, true)) {
      if (await this.fileEquals(adapter, this.claimSourcePath, CLAIM_SOURCE_CONTENT)) {
        return;
      }
      throw new Error("AI analysis claim source conflicts with an existing file");
    }

    const bootstrap = await this.createClaimBootstrap(adapter, transactionId);
    try {
      try {
        // DataAdapter.copy is the public exclusive-create primitive: it fails
        // instead of overwriting when another writer already owns the target.
        await adapter.copy(bootstrap.sourcePath, this.claimSourcePath);
      } catch (error) {
        if (await this.fileEquals(
          adapter,
          this.claimSourcePath,
          CLAIM_SOURCE_CONTENT,
        )) {
          return;
        }
        if (await adapter.exists(this.claimSourcePath, true)) {
          throw new Error("AI analysis claim source conflicts with an existing file");
        }
        throw error;
      }
      if (!(await this.fileEquals(
        adapter,
        this.claimSourcePath,
        CLAIM_SOURCE_CONTENT,
      ))) {
        throw new Error("AI analysis claim source could not be initialized safely");
      }
    } finally {
      await this.removeIfExact(adapter, bootstrap.sourcePath, CLAIM_SOURCE_CONTENT);
      await this.removeEmptyDirectory(adapter, bootstrap.directoryPath);
    }
  }

  private async createClaimBootstrap(
    adapter: BoundAnalysisAdapter,
    transactionId: string,
  ): Promise<{ directoryPath: string; sourcePath: string }> {
    for (let attempt = 0; attempt < MAX_TEMP_ATTEMPTS; attempt += 1) {
      const directoryPath = normalizePath(
        `${this.analysisDirectory}/.claim-bootstrap-${transactionId}-${attempt}`,
      );
      try {
        // Vault.createFolder throws when the path already exists, so a
        // successful call proves this writer exclusively owns the bootstrap
        // directory. DataAdapter.mkdir is intentionally idempotent and cannot
        // provide that ownership guarantee.
        await adapter.createFolder(directoryPath);
      } catch (error) {
        if (await adapter.exists(directoryPath, true)) continue;
        throw error;
      }
      const sourcePath = normalizePath(`${directoryPath}/source`);
      try {
        await adapter.write(sourcePath, CLAIM_SOURCE_CONTENT);
        if (!(await this.fileEquals(adapter, sourcePath, CLAIM_SOURCE_CONTENT))) {
          throw new Error("AI analysis bootstrap source could not be verified");
        }
        return { directoryPath, sourcePath };
      } catch (error) {
        await this.removeIfExact(adapter, sourcePath, CLAIM_SOURCE_CONTENT);
        await this.removeEmptyDirectory(adapter, directoryPath);
        throw error;
      }
    }
    throw new Error("Could not allocate an AI analysis bootstrap directory");
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

  private expectedArtifactPath(
    value: unknown,
    result: AiAnalysisResult,
  ): string {
    if (
      typeof value !== "string" ||
      !value ||
      value.startsWith("/") ||
      value.includes("\\") ||
      value.includes("\0") ||
      /^[A-Za-z]:/u.test(value) ||
      normalizePath(value) !== value
    ) {
      throw new AnalysisArtifactVerificationError();
    }
    const directory = this.itemDirectory(result.itemId);
    const prefix = `${directory}/`;
    if (!value.startsWith(prefix)) {
      throw new AnalysisArtifactVerificationError();
    }
    const filename = value.slice(prefix.length);
    if (!filename || filename.includes("/")) {
      throw new AnalysisArtifactVerificationError();
    }
    const stem = `${utcPathTimestamp(result.createdAt)}-${result.operation}`;
    if (filename === `${stem}.md`) return value;
    if (!filename.startsWith(`${stem}-`) || !filename.endsWith(".md")) {
      throw new AnalysisArtifactVerificationError();
    }
    const suffix = filename.slice(stem.length + 1, -3);
    const collisionIndex = Number(suffix);
    if (
      !Number.isSafeInteger(collisionIndex) ||
      collisionIndex < 2 ||
      collisionIndex > MAX_COLLISION_ATTEMPTS ||
      String(collisionIndex) !== suffix
    ) {
      throw new AnalysisArtifactVerificationError();
    }
    return value;
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

  private async removeEmptyDirectory(
    adapter: BoundAnalysisAdapter,
    path: string,
  ): Promise<void> {
    try {
      await adapter.rmdir(path, false);
    } catch {
      // Preserve ambiguous/non-empty directories rather than deleting recursively.
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

function frozenArtifacts(
  artifacts: AiAnalysisArtifact[],
): AiAnalysisArtifact[] {
  return Object.freeze(artifacts) as unknown as AiAnalysisArtifact[];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function snapshotListedFiles(value: unknown): string[] | undefined {
  const record = plainRecord(value);
  const files = denseStringArray(ownData(record, "files"));
  const folders = denseStringArray(ownData(record, "folders"));
  return files && folders ? files : undefined;
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    const prototype = Reflect.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function ownData(
  record: Record<string, unknown> | undefined,
  key: string,
): unknown {
  if (!record) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function denseStringArray(value: unknown): string[] | undefined {
  try {
    if (!Array.isArray(value)) return undefined;
    const result: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) ||
        typeof descriptor.value !== "string") {
        return undefined;
      }
      result.push(descriptor.value);
    }
    return result;
  } catch {
    return undefined;
  }
}
