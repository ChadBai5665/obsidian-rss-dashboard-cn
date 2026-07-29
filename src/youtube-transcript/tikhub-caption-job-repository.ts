import { normalizePath, type DataAdapter, type Vault } from "obsidian";
import { isCanonicalConnectionId } from "../security/connection-id";
import { isValidYouTubeVideoId } from "./transcript-types";
import { isValidYouTubeCaptionLanguageCode } from "./youtube-caption-language-code";

export interface TikHubCaptionJobRecord {
  schemaVersion: 1;
  itemId: string;
  videoId: string;
  stage: "tracks" | "content";
  languageCode?: string;
  format: "txt";
  jobId: string;
  connectionId: string;
  createdAt: string;
  lastCheckedAt: string;
  status: "processing";
}

export interface TikHubCaptionJobIdentity {
  key: string;
  jobId: string;
  connectionId: string;
}

const ITEM_ID = /^[a-f0-9]{64}$/u;
const JOB_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const STORE_FIELDS = ["schemaVersion", "jobs"] as const;
const IDENTITY_FIELDS = ["key", "jobId", "connectionId"] as const;
const TRACK_JOB_FIELDS = [
  "schemaVersion",
  "itemId",
  "videoId",
  "stage",
  "format",
  "jobId",
  "connectionId",
  "createdAt",
  "lastCheckedAt",
  "status",
] as const;
const CONTENT_JOB_FIELDS = [
  "schemaVersion",
  "itemId",
  "videoId",
  "stage",
  "languageCode",
  "format",
  "jobId",
  "connectionId",
  "createdAt",
  "lastCheckedAt",
  "status",
] as const;

/** One mutation queue per physical Vault object and repository path. */
const vaultMutationQueues = new WeakMap<object, Map<string, Promise<void>>>();
let transactionSequence = 0;

export function captionJobKey(
  itemId: string,
  videoId: string,
  stage: TikHubCaptionJobRecord["stage"],
  languageCode?: string,
): string {
  if (typeof itemId !== "string" || !ITEM_ID.test(itemId)) {
    throw new Error("Invalid TikHub caption job item ID.");
  }
  if (typeof videoId !== "string" || !isValidYouTubeVideoId(videoId)) {
    throw new Error("Invalid TikHub caption job video ID.");
  }
  if (stage === "tracks") {
    if (languageCode !== undefined) {
      throw new Error("Track-list caption jobs cannot have a language code.");
    }
    return `${itemId}:${videoId}:tracks`;
  }
  if (
    stage !== "content" ||
    !isValidYouTubeCaptionLanguageCode(languageCode)
  ) {
    throw new Error("Content caption jobs require a valid language code.");
  }
  return `${itemId}:${videoId}:content:${languageCode}`;
}

/**
 * Stores only resumable TikHub caption job identities. It never persists
 * credentials, provider payloads, or transcript content.
 */
export class TikHubCaptionJobRepository {
  private readonly dataRoot: string;

  constructor(
    private readonly vault: Vault,
    dataRoot: string,
  ) {
    const trimmedRoot = dataRoot.trim();
    assertSafeDataRoot(trimmedRoot);
    this.dataRoot = normalizePath(trimmedRoot);
  }

  async read(key: string): Promise<TikHubCaptionJobRecord | null> {
    assertCaptionJobKey(key);
    return await this.withLock(async () => {
      const record = (await this.readJobs()).get(key);
      return record ? cloneRecord(record) : null;
    });
  }

  async write(record: TikHubCaptionJobRecord): Promise<void> {
    const projected = projectRecord(record);
    const key = keyForRecord(projected);
    await this.withLock(async () => {
      const jobs = await this.readJobs();
      jobs.set(key, projected);
      await this.atomicWrite(serializeJobs(jobs));
    });
  }

  async createIfAbsent(record: TikHubCaptionJobRecord): Promise<boolean> {
    const projected = projectRecord(record);
    const key = keyForRecord(projected);
    return await this.withLock(async () => {
      const jobs = await this.readJobs();
      if (jobs.has(key)) return false;
      jobs.set(key, projected);
      await this.atomicWrite(serializeJobs(jobs));
      return true;
    });
  }

  async replaceIfCurrent(
    identity: TikHubCaptionJobIdentity,
    replacement: TikHubCaptionJobRecord,
  ): Promise<boolean> {
    const projectedIdentity = projectIdentity(identity);
    const projectedReplacement = projectRecord(replacement);
    if (
      keyForRecord(projectedReplacement) !== projectedIdentity.key ||
      projectedReplacement.jobId !== projectedIdentity.jobId ||
      projectedReplacement.connectionId !== projectedIdentity.connectionId
    ) {
      throw invalidReplacement();
    }
    return await this.withLock(async () => {
      const jobs = await this.readJobs();
      const current = jobs.get(projectedIdentity.key);
      if (!current || !matchesIdentity(current, projectedIdentity)) return false;
      jobs.set(projectedIdentity.key, projectedReplacement);
      await this.atomicWrite(serializeJobs(jobs));
      return true;
    });
  }

  async removeIfCurrent(
    identity: TikHubCaptionJobIdentity,
  ): Promise<boolean> {
    const projectedIdentity = projectIdentity(identity);
    return await this.withLock(async () => {
      const jobs = await this.readJobs();
      const current = jobs.get(projectedIdentity.key);
      if (!current || !matchesIdentity(current, projectedIdentity)) return false;
      jobs.delete(projectedIdentity.key);
      await this.atomicWrite(serializeJobs(jobs));
      return true;
    });
  }

  async remove(key: string): Promise<void> {
    assertCaptionJobKey(key);
    await this.withLock(async () => {
      const jobs = await this.readJobs();
      if (!jobs.delete(key)) return;
      await this.atomicWrite(serializeJobs(jobs));
    });
  }

  private get stateDirectory(): string {
    return normalizePath(`${this.dataRoot}/state`);
  }

  private get jobsPath(): string {
    return normalizePath(`${this.stateDirectory}/youtube-caption-jobs.json`);
  }

  private async readJobs(): Promise<Map<string, TikHubCaptionJobRecord>> {
    await this.recoverAtomicTarget();
    if (!(await this.vault.adapter.exists(this.jobsPath))) return new Map();
    return parseJobs(await this.vault.adapter.read(this.jobsPath));
  }

  private async atomicWrite(content: string): Promise<void> {
    await this.recoverAtomicTarget();
    await this.ensureDirectory(this.dataRoot);
    await this.ensureDirectory(this.stateDirectory);
    const adapter = this.vault.adapter as Partial<DataAdapter>;
    if (typeof adapter.rename !== "function" || typeof adapter.remove !== "function") {
      throw new Error("Atomic TikHub caption job storage is unavailable.");
    }

    const writeId = nextTransactionId();
    const tempPath = `${this.jobsPath}.tmp-${writeId}`;
    const backupPath = `${this.jobsPath}.backup-${writeId}`;
    try {
      await this.vault.adapter.write(tempPath, content);
    } catch (error) {
      await this.bestEffortRemove(tempPath);
      throw error;
    }

    if (!(await this.vault.adapter.exists(this.jobsPath))) {
      try {
        await adapter.rename.call(this.vault.adapter, tempPath, this.jobsPath);
      } catch (error) {
        await this.bestEffortRemove(tempPath);
        throw error;
      }
      return;
    }

    try {
      await adapter.rename.call(this.vault.adapter, this.jobsPath, backupPath);
    } catch (error) {
      await this.bestEffortRemove(tempPath);
      throw error;
    }
    try {
      await adapter.rename.call(this.vault.adapter, tempPath, this.jobsPath);
    } catch (replaceError) {
      try {
        await adapter.rename.call(this.vault.adapter, backupPath, this.jobsPath);
      } catch {
        throw new Error(
          "TikHub caption job replacement failed and requires recovery.",
        );
      } finally {
        await this.bestEffortRemove(tempPath);
      }
      throw replaceError;
    }
    await this.bestEffortRemove(backupPath);
  }

  private async recoverAtomicTarget(): Promise<void> {
    if (!(await this.vault.adapter.exists(this.stateDirectory))) return;
    const listed = await this.vault.adapter.list(this.stateDirectory);
    const backups = listed.files
      .filter((candidate) => candidate.startsWith(`${this.jobsPath}.backup-`))
      .sort()
      .reverse();
    const temps = listed.files.filter((candidate) =>
      candidate.startsWith(`${this.jobsPath}.tmp-`)
    );

    if (await this.vault.adapter.exists(this.jobsPath)) {
      parseJobs(await this.vault.adapter.read(this.jobsPath));
      await this.cleanupSiblings([...backups, ...temps]);
      return;
    }

    const adapter = this.vault.adapter as Partial<DataAdapter>;
    if (typeof adapter.rename !== "function") {
      if (backups.length > 0) {
        throw new Error("TikHub caption job storage requires recovery.");
      }
      return;
    }

    let restored: string | undefined;
    for (const backup of backups) {
      try {
        parseJobs(await this.vault.adapter.read(backup));
        await adapter.rename.call(this.vault.adapter, backup, this.jobsPath);
        restored = backup;
        break;
      } catch {
        // Only a complete, valid repository backup can become the final file.
      }
    }
    if (restored) {
      await this.cleanupSiblings(
        [...backups, ...temps].filter((candidate) => candidate !== restored),
      );
      return;
    }
    if (backups.length > 0) {
      throw new Error("TikHub caption job storage requires recovery.");
    }
    await this.cleanupSiblings(temps);
  }

  private async ensureDirectory(path: string): Promise<void> {
    if (await this.vault.adapter.exists(path)) return;
    try {
      await this.vault.adapter.mkdir(path);
    } catch (error) {
      if (!(await this.vault.adapter.exists(path))) throw error;
    }
  }

  private async cleanupSiblings(paths: readonly string[]): Promise<void> {
    for (const path of paths) await this.bestEffortRemove(path);
  }

  private async bestEffortRemove(path: string): Promise<void> {
    const adapter = this.vault.adapter as Partial<DataAdapter>;
    if (typeof adapter.remove !== "function") return;
    try {
      if (await this.vault.adapter.exists(path)) {
        await adapter.remove.call(this.vault.adapter, path);
      }
    } catch {
      // A later access retries cleanup without replacing the primary result.
    }
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const queues = vaultMutationQueues.get(this.vault) ??
      new Map<string, Promise<void>>();
    vaultMutationQueues.set(this.vault, queues);
    const previous = queues.get(this.jobsPath) ?? Promise.resolve();
    const running = previous.catch(() => undefined).then(operation);
    const settled = running.then(() => undefined, () => undefined);
    queues.set(this.jobsPath, settled);
    try {
      return await running;
    } finally {
      if (queues.get(this.jobsPath) === settled) queues.delete(this.jobsPath);
      if (queues.size === 0) vaultMutationQueues.delete(this.vault);
    }
  }
}

function parseJobs(raw: string): Map<string, TikHubCaptionJobRecord> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw invalidStore();
  }
  try {
    const store = plainRecord(value);
    if (!store || !hasExactDataFields(store, STORE_FIELDS)) throw invalidStore();
    if (ownData(store, "schemaVersion") !== 1) throw invalidStore();
    const persistedJobs = plainRecord(ownData(store, "jobs"));
    if (!persistedJobs) throw invalidStore();

    const jobs = new Map<string, TikHubCaptionJobRecord>();
    for (const key of Reflect.ownKeys(persistedJobs)) {
      if (typeof key !== "string") throw invalidStore();
      assertCaptionJobKey(key);
      const record = projectRecord(ownData(persistedJobs, key));
      if (keyForRecord(record) !== key) throw invalidStore();
      jobs.set(key, record);
    }
    return jobs;
  } catch {
    throw invalidStore();
  }
}

function serializeJobs(jobs: ReadonlyMap<string, TikHubCaptionJobRecord>): string {
  const persistedJobs: Record<string, TikHubCaptionJobRecord> = Object.create(null) as
    Record<string, TikHubCaptionJobRecord>;
  for (const [key, record] of [...jobs.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    persistedJobs[key] = cloneRecord(record);
  }
  return `${JSON.stringify({ schemaVersion: 1, jobs: persistedJobs }, null, 2)}\n`;
}

function projectRecord(value: unknown): TikHubCaptionJobRecord {
  try {
    const record = plainRecord(value);
    if (!record) throw invalidRecord();
    const stageValue = ownData(record, "stage");
    if (stageValue !== "tracks" && stageValue !== "content") {
      throw invalidRecord();
    }
    const stage = stageValue;
    const fields = stage === "tracks"
      ? TRACK_JOB_FIELDS
      : stage === "content"
        ? CONTENT_JOB_FIELDS
        : undefined;
    if (!fields || !hasExactDataFields(record, fields)) throw invalidRecord();

    const projected: TikHubCaptionJobRecord = {
      schemaVersion: ownData(record, "schemaVersion") as 1,
      itemId: ownData(record, "itemId") as string,
      videoId: ownData(record, "videoId") as string,
      stage,
      ...(stage === "content"
        ? { languageCode: ownData(record, "languageCode") as string }
        : {}),
      format: ownData(record, "format") as "txt",
      jobId: ownData(record, "jobId") as string,
      connectionId: ownData(record, "connectionId") as string,
      createdAt: ownData(record, "createdAt") as string,
      lastCheckedAt: ownData(record, "lastCheckedAt") as string,
      status: ownData(record, "status") as "processing",
    };
    assertRecordValues(projected);
    return projected;
  } catch {
    throw invalidRecord();
  }
}

function projectIdentity(value: unknown): TikHubCaptionJobIdentity {
  try {
    const identity = plainRecord(value);
    if (!identity || !hasExactDataFields(identity, IDENTITY_FIELDS)) {
      throw invalidIdentity();
    }
    const projected: TikHubCaptionJobIdentity = {
      key: ownData(identity, "key") as string,
      jobId: ownData(identity, "jobId") as string,
      connectionId: ownData(identity, "connectionId") as string,
    };
    assertCaptionJobKey(projected.key);
    if (
      typeof projected.jobId !== "string" ||
      !JOB_ID.test(projected.jobId) ||
      !isCanonicalConnectionId(projected.connectionId)
    ) {
      throw invalidIdentity();
    }
    return projected;
  } catch {
    throw invalidIdentity();
  }
}

function matchesIdentity(
  record: TikHubCaptionJobRecord,
  identity: TikHubCaptionJobIdentity,
): boolean {
  return keyForRecord(record) === identity.key &&
    record.jobId === identity.jobId &&
    record.connectionId === identity.connectionId;
}

function assertRecordValues(record: TikHubCaptionJobRecord): void {
  if (
    record.schemaVersion !== 1 ||
    typeof record.itemId !== "string" ||
    !ITEM_ID.test(record.itemId) ||
    typeof record.videoId !== "string" ||
    !isValidYouTubeVideoId(record.videoId) ||
    record.format !== "txt" ||
    typeof record.jobId !== "string" ||
    !JOB_ID.test(record.jobId) ||
    !isCanonicalConnectionId(record.connectionId) ||
    !isIsoTimestamp(record.createdAt) ||
    !isIsoTimestamp(record.lastCheckedAt) ||
    record.lastCheckedAt < record.createdAt ||
    record.status !== "processing"
  ) {
    throw invalidRecord();
  }
  captionJobKey(
    record.itemId,
    record.videoId,
    record.stage,
    record.languageCode,
  );
}

function keyForRecord(record: TikHubCaptionJobRecord): string {
  return captionJobKey(
    record.itemId,
    record.videoId,
    record.stage,
    record.languageCode,
  );
}

function assertCaptionJobKey(key: unknown): asserts key is string {
  if (typeof key !== "string") throw new Error("Invalid TikHub caption job key.");
  const [itemId, videoId, stage, languageCode, ...extra] = key.split(":");
  if (extra.length > 0) throw new Error("Invalid TikHub caption job key.");
  try {
    if (captionJobKey(
      itemId,
      videoId,
      stage as TikHubCaptionJobRecord["stage"],
      languageCode,
    ) !== key) {
      throw new Error("Invalid TikHub caption job key.");
    }
  } catch {
    throw new Error("Invalid TikHub caption job key.");
  }
}

function cloneRecord(record: TikHubCaptionJobRecord): TikHubCaptionJobRecord {
  return {
    schemaVersion: record.schemaVersion,
    itemId: record.itemId,
    videoId: record.videoId,
    stage: record.stage,
    ...(record.languageCode === undefined
      ? {}
      : { languageCode: record.languageCode }),
    format: record.format,
    jobId: record.jobId,
    connectionId: record.connectionId,
    createdAt: record.createdAt,
    lastCheckedAt: record.lastCheckedAt,
    status: record.status,
  };
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? value as Record<string, unknown>
    : undefined;
}

function hasExactDataFields(
  record: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(record);
  if (
    keys.length !== expected.length ||
    keys.some((key) => typeof key !== "string" || !expected.includes(key))
  ) {
    return false;
  }
  return expected.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor !== undefined && "value" in descriptor;
  });
}

function ownData(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !("value" in descriptor)) throw invalidRecord();
  return descriptor.value;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function assertSafeDataRoot(value: string): void {
  const segments = value.split("/");
  if (
    !value ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    /^[A-Za-z]:/u.test(value) ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("Invalid TikHub caption job data root.");
  }
}

function invalidRecord(): Error {
  return new Error("Invalid TikHub caption job record.");
}

function invalidStore(): Error {
  return new Error("TikHub caption job storage is corrupt.");
}

function invalidIdentity(): Error {
  return new Error("Invalid TikHub caption job identity.");
}

function invalidReplacement(): Error {
  return new Error("Invalid TikHub caption job replacement.");
}

function nextTransactionId(): string {
  const uuid = window.crypto?.randomUUID?.();
  const random = uuid?.replace(/-/gu, "") ?? secureRandomSuffix();
  return `${Date.now()}-${transactionSequence++}-${random}`;
}

function secureRandomSuffix(): string {
  const words = new Uint32Array(4);
  window.crypto.getRandomValues(words);
  return Array.from(words, (word) => word.toString(16).padStart(8, "0")).join("");
}
