import { normalizePath, type DataAdapter, type Vault } from "obsidian";
import { toLocalCalendarDate } from "../../refresh/local-calendar-day";

export interface TikHubRequestLedgerSnapshot {
  localDate: string;
  count: number;
}

export interface TikHubLedgerReservation {
  readonly total: number;
  readonly remaining: number;
  markAttempted(): void;
  releaseUnused(): Promise<number>;
}

export interface TikHubRequestLedgerLike {
  reserve(count: number, maxRequestsPerDay: number): Promise<TikHubLedgerReservation>;
}

export type TikHubRequestLedgerErrorCode =
  | "daily-limit"
  | "corrupt-ledger"
  | "atomic-write-unavailable";

export class TikHubRequestLedgerError extends Error {
  constructor(
    readonly code: TikHubRequestLedgerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TikHubRequestLedgerError";
  }
}

export interface TikHubRequestLedgerOptions {
  /** Stable, non-secret identity for the physical vault/storage target. */
  storageIdentity: string;
  now?: () => Date;
  randomSuffix?: () => string;
}

/**
 * Process-global serialization covers multiple adapter wrappers in one Node/Electron
 * process. Separate processes must not share this ledger until an inter-process
 * lock or equivalent fail-safe is added.
 */
const mutationQueues = new Map<string, Promise<void>>();

export class TikHubRequestLedger implements TikHubRequestLedgerLike {
  private readonly dataRoot: string;
  private readonly lockKey: string;
  private readonly now: () => Date;
  private readonly randomSuffix: () => string;

  constructor(
    private readonly vault: Vault,
    dataRoot: string,
    options: TikHubRequestLedgerOptions,
  ) {
    const trimmedRoot = dataRoot.trim();
    assertSafeDataRoot(trimmedRoot);
    assertSafeStorageIdentity(options.storageIdentity);
    this.dataRoot = normalizePath(trimmedRoot);
    this.lockKey = `${options.storageIdentity}:${this.ledgerPath}`;
    this.now = options.now ?? (() => new Date());
    this.randomSuffix = options.randomSuffix ?? defaultRandomSuffix;
  }

  async getSnapshot(): Promise<TikHubRequestLedgerSnapshot> {
    return await this.withLock(async () => ({ ...(await this.readCurrentSnapshot()) }));
  }

  async reserve(
    count: number,
    maxRequestsPerDay: number,
  ): Promise<TikHubLedgerReservation> {
    assertPositiveInteger(count, "reservation count");
    assertPositiveInteger(maxRequestsPerDay, "daily request limit");

    const localDate = toLocalCalendarDate(this.now());
    await this.withLock(async () => {
      const current = await this.readCurrentSnapshot();
      const sameDayCount = current.localDate === localDate ? current.count : 0;
      if (sameDayCount + count > maxRequestsPerDay) {
        throw new TikHubRequestLedgerError(
          "daily-limit",
          "TikHub daily request limit reached.",
        );
      }
      await this.writeSnapshot({ localDate, count: sameDayCount + count });
    });

    return new LedgerReservation(this, localDate, count);
  }

  async release(localDate: string, count: number): Promise<void> {
    if (count === 0) return;
    assertPositiveInteger(count, "release count");

    await this.withLock(async () => {
      const current = await this.readCurrentSnapshot();
      if (current.localDate !== localDate) return;
      await this.writeSnapshot({
        localDate,
        count: Math.max(0, current.count - count),
      });
    });
  }

  private get stateDirectory(): string {
    return normalizePath(`${this.dataRoot}/state`);
  }

  private get ledgerPath(): string {
    return normalizePath(`${this.stateDirectory}/tikhub-requests.json`);
  }

  private async readCurrentSnapshot(): Promise<TikHubRequestLedgerSnapshot> {
    if (!(await this.vault.adapter.exists(this.ledgerPath))) {
      if (await this.hasOrphanedWriteArtifact()) {
        throw new TikHubRequestLedgerError(
          "corrupt-ledger",
          "TikHub request ledger requires recovery; paid requests are blocked.",
        );
      }
      return { localDate: toLocalCalendarDate(this.now()), count: 0 };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await this.vault.adapter.read(this.ledgerPath));
    } catch {
      throw new TikHubRequestLedgerError(
        "corrupt-ledger",
        "TikHub request ledger is corrupt; paid requests are blocked.",
      );
    }
    if (!isSnapshot(parsed)) {
      throw new TikHubRequestLedgerError(
        "corrupt-ledger",
        "TikHub request ledger is corrupt; paid requests are blocked.",
      );
    }
    return parsed;
  }

  private async hasOrphanedWriteArtifact(): Promise<boolean> {
    if (!(await this.vault.adapter.exists(this.stateDirectory))) return false;
    let files: string[];
    try {
      ({ files } = await this.vault.adapter.list(this.stateDirectory));
    } catch {
      throw new TikHubRequestLedgerError(
        "atomic-write-unavailable",
        "TikHub request ledger recovery state cannot be inspected.",
      );
    }
    return files.some(
      (path) =>
        path.startsWith(`${this.ledgerPath}.tmp-`) ||
        path.startsWith(`${this.ledgerPath}.backup-`),
    );
  }

  private async writeSnapshot(snapshot: TikHubRequestLedgerSnapshot): Promise<void> {
    await this.ensureDirectory(this.dataRoot);
    await this.ensureDirectory(this.stateDirectory);

    const adapter = this.vault.adapter as Partial<DataAdapter>;
    if (typeof adapter.rename !== "function" || typeof adapter.remove !== "function") {
      throw new TikHubRequestLedgerError(
        "atomic-write-unavailable",
        "TikHub request ledger requires atomic storage support.",
      );
    }

    const tempPath = `${this.ledgerPath}.tmp-${this.randomSuffix()}`;
    const backupPath = `${this.ledgerPath}.backup-${this.randomSuffix()}`;
    await this.vault.adapter.write(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`);

    if (!(await this.vault.adapter.exists(this.ledgerPath))) {
      try {
        await adapter.rename.call(this.vault.adapter, tempPath, this.ledgerPath);
      } catch (error) {
        await this.bestEffortRemove(tempPath);
        throw error;
      }
      return;
    }

    await adapter.rename.call(this.vault.adapter, this.ledgerPath, backupPath);
    try {
      await adapter.rename.call(this.vault.adapter, tempPath, this.ledgerPath);
    } catch (replaceError) {
      try {
        await adapter.rename.call(this.vault.adapter, backupPath, this.ledgerPath);
      } catch {
        throw new TikHubRequestLedgerError(
          "atomic-write-unavailable",
          "TikHub request ledger replacement failed and requires recovery.",
        );
      } finally {
        await this.bestEffortRemove(tempPath);
      }
      throw replaceError;
    }
    await this.bestEffortRemove(backupPath);
  }

  private async ensureDirectory(path: string): Promise<void> {
    if (await this.vault.adapter.exists(path)) return;
    try {
      await this.vault.adapter.mkdir(path);
    } catch (error) {
      if (!(await this.vault.adapter.exists(path))) throw error;
    }
  }

  private async bestEffortRemove(path: string): Promise<void> {
    const adapter = this.vault.adapter as Partial<DataAdapter>;
    if (typeof adapter.remove !== "function") return;
    try {
      if (await this.vault.adapter.exists(path)) {
        await adapter.remove.call(this.vault.adapter, path);
      }
    } catch {
      // A later operation can safely retry cleanup; never replace the primary error.
    }
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = mutationQueues.get(this.lockKey) ?? Promise.resolve();
    const running = previous.catch(() => undefined).then(operation);
    const settled = running.then(() => undefined, () => undefined);
    mutationQueues.set(this.lockKey, settled);
    try {
      return await running;
    } finally {
      if (mutationQueues.get(this.lockKey) === settled) {
        mutationQueues.delete(this.lockKey);
      }
    }
  }
}

class LedgerReservation implements TikHubLedgerReservation {
  private unused: number;

  constructor(
    private readonly ledger: TikHubRequestLedger,
    private readonly localDate: string,
    readonly total: number,
  ) {
    this.unused = total;
  }

  get remaining(): number {
    return this.unused;
  }

  markAttempted(): void {
    if (this.unused < 1) {
      throw new Error("No unused TikHub request reservation remains.");
    }
    this.unused -= 1;
  }

  async releaseUnused(): Promise<number> {
    const released = this.unused;
    if (released === 0) return 0;
    this.unused = 0;
    try {
      await this.ledger.release(this.localDate, released);
      return released;
    } catch (error) {
      this.unused = released;
      throw error;
    }
  }
}

function isSnapshot(value: unknown): value is TikHubRequestLedgerSnapshot {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === 2 &&
    keys.includes("localDate") &&
    keys.includes("count") &&
    typeof value.localDate === "string" &&
    isLocalCalendarDate(value.localDate) &&
    typeof value.count === "number" &&
    Number.isSafeInteger(value.count) &&
    value.count >= 0
  );
}

function isLocalCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (daysInMonth[month - 1] ?? 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`TikHub ${label} must be a positive integer.`);
  }
}

function assertSafeDataRoot(folder: string): void {
  if (
    !folder ||
    folder.startsWith("/") ||
    folder.includes("\\") ||
    folder.includes("\0") ||
    /^[A-Za-z]:/.test(folder) ||
    folder.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("Invalid TikHub request ledger data folder.");
  }
}

function assertSafeStorageIdentity(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[a-z][a-z0-9-]{1,31}:[a-z0-9][a-z0-9._-]{0,94}$/.test(value)
  ) {
    throw new Error("Invalid TikHub request ledger storage identity.");
  }
}

function defaultRandomSuffix(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
