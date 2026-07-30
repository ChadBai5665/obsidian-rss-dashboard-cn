import { normalizePath, type Vault } from "obsidian";
import { toLocalCalendarDate } from "../refresh/local-calendar-day";
import {
  snapshotOperationEvent,
  type OperationEvent,
} from "./operation-event";

export const OPERATION_JOURNAL_RETENTION_DAYS = 30;
export const OPERATION_JOURNAL_MAX_TOTAL_BYTES = 10 * 1024 * 1024;
export const OPERATION_JOURNAL_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const OPERATION_JOURNAL_MAX_READ_EVENTS = 20_000;

export interface OperationJournalReadResult {
  readonly events: readonly OperationEvent[];
  readonly incompleteDates: readonly string[];
  readonly corruptDates: readonly string[];
  readonly truncated: boolean;
}

export interface OperationJournalStats {
  readonly bytes: number;
  readonly days: number;
  readonly eventCount: number;
  readonly earliestDate?: string;
}

export interface OperationJournalAppendResult {
  readonly maintenanceIncomplete: boolean;
}

interface JournalFile {
  readonly date: string;
  readonly ordinal: number;
  readonly path: string;
}

interface SizedJournalFile extends JournalFile {
  readonly size: number;
}

const JOURNAL_FILE_NAME = /^\d{4}-\d{2}-\d{2}\.jsonl$/u;
const DAY_MS = 24 * 60 * 60 * 1_000;
const vaultMutationQueues = new WeakMap<
  object,
  Map<string, Promise<void>>
>();
const vaultMaintenanceDates = new WeakMap<object, Map<string, string>>();

export class OperationJournalRepository {
  private readonly dataRoot: string;

  constructor(
    private readonly vault: Vault,
    dataRoot: string,
  ) {
    const trimmedRoot = dataRoot.trim();
    assertSafeDataRoot(trimmedRoot);
    this.dataRoot = normalizePath(trimmedRoot);
  }

  async append(
    event: OperationEvent,
  ): Promise<OperationJournalAppendResult> {
    const snapshot = snapshotOperationEvent(event);
    const occurredAt = new Date(snapshot.occurredAt);
    const localDate = toLocalCalendarDate(occurredAt);
    const path = this.pathForDate(localDate);
    const line = `${JSON.stringify(snapshot)}\n`;

    return this.withMutation(async () => {
      await this.ensureJournalDirectory();
      let maintenanceIncomplete = false;
      if (this.lastMaintenanceDate() !== localDate) {
        this.setLastMaintenanceDate(localDate);
        try {
          await this.pruneUnlocked(occurredAt);
        } catch {
          maintenanceIncomplete = true;
        }
      }

      if (await this.vault.adapter.exists(path)) {
        await this.vault.adapter.append(path, line);
      } else {
        await this.vault.create(path, line);
      }
      return Object.freeze({ maintenanceIncomplete });
    });
  }

  async readRange(input: {
    days: 7 | 30;
    now: Date;
    maxEvents?: number;
  }): Promise<OperationJournalReadResult> {
    const todayOrdinal = localDayOrdinal(input.now);
    const earliestOrdinal = todayOrdinal - (input.days - 1);
    const eventLimit = normalizeEventLimit(input.maxEvents);
    const files = (await this.listControlledFiles())
      .filter(
        (file) =>
          file.ordinal >= earliestOrdinal && file.ordinal <= todayOrdinal,
      )
      .sort((left, right) => right.date.localeCompare(left.date));
    const events: OperationEvent[] = [];
    const incompleteDates = new Set<string>();
    const corruptDates = new Set<string>();
    let truncated = eventLimit === 0 && files.length > 0;
    let totalCharacters = 0;

    fileLoop: for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
      const file = files[fileIndex];
      if (file === undefined || events.length >= eventLimit) {
        truncated ||= file !== undefined;
        break;
      }

      let size: number;
      try {
        const stat = await this.vault.adapter.stat(file.path);
        if (stat === null || stat.type !== "file") continue;
        size = stat.size;
      } catch {
        corruptDates.add(file.date);
        truncated = true;
        continue;
      }
      if (size > OPERATION_JOURNAL_MAX_FILE_BYTES) {
        truncated = true;
        continue;
      }
      if (totalCharacters + size > OPERATION_JOURNAL_MAX_TOTAL_BYTES) {
        truncated = true;
        break;
      }

      let raw: string;
      try {
        raw = await this.vault.adapter.read(file.path);
      } catch {
        corruptDates.add(file.date);
        truncated = true;
        continue;
      }
      if (raw.length > OPERATION_JOURNAL_MAX_FILE_BYTES) {
        truncated = true;
        continue;
      }
      if (
        totalCharacters + raw.length > OPERATION_JOURNAL_MAX_TOTAL_BYTES
      ) {
        truncated = true;
        break;
      }
      totalCharacters += raw.length;

      const complete = raw.endsWith("\n");
      const lines = raw.split("\n");
      lines.pop();
      if (!complete) incompleteDates.add(file.date);

      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        if (events.length >= eventLimit) {
          truncated = true;
          break fileLoop;
        }
        const rawLine = lines[lineIndex];
        if (rawLine === undefined) continue;
        const finalCompleteLine = lineIndex === lines.length - 1;
        try {
          const parsed: unknown = JSON.parse(rawLine);
          if (hasUnknownSchema(parsed)) truncated = true;
          events.push(snapshotOperationEvent(parsed));
        } catch {
          if (finalCompleteLine) incompleteDates.add(file.date);
          else corruptDates.add(file.date);
        }
      }

      if (events.length >= eventLimit && fileIndex < files.length - 1) {
        truncated = true;
        break;
      }
    }

    return Object.freeze({
      events: Object.freeze(events),
      incompleteDates: Object.freeze([...incompleteDates]),
      corruptDates: Object.freeze([...corruptDates]),
      truncated,
    });
  }

  async prune(now: Date): Promise<void> {
    await this.withMutation(async () => this.pruneUnlocked(now));
  }

  async stats(now: Date): Promise<OperationJournalStats> {
    localDayOrdinal(now);
    const files = (await this.listControlledFiles()).sort((left, right) =>
      left.date.localeCompare(right.date),
    );
    let bytes = 0;
    let eventCount = 0;
    let days = 0;
    let earliestDate: string | undefined;
    let totalCharacters = 0;

    for (const file of files) {
      let size: number;
      try {
        const stat = await this.vault.adapter.stat(file.path);
        if (stat === null || stat.type !== "file") continue;
        size = stat.size;
      } catch {
        continue;
      }
      bytes += size;
      days += 1;
      earliestDate ??= file.date;
      if (
        eventCount >= OPERATION_JOURNAL_MAX_READ_EVENTS ||
        size > OPERATION_JOURNAL_MAX_FILE_BYTES ||
        totalCharacters + size > OPERATION_JOURNAL_MAX_TOTAL_BYTES
      ) {
        continue;
      }

      let raw: string;
      try {
        raw = await this.vault.adapter.read(file.path);
      } catch {
        continue;
      }
      if (
        raw.length > OPERATION_JOURNAL_MAX_FILE_BYTES ||
        totalCharacters + raw.length > OPERATION_JOURNAL_MAX_TOTAL_BYTES
      ) {
        continue;
      }
      totalCharacters += raw.length;
      const lines = raw.split("\n");
      if (raw.endsWith("\n")) lines.pop();
      else lines.pop();
      for (const rawLine of lines) {
        if (eventCount >= OPERATION_JOURNAL_MAX_READ_EVENTS) break;
        try {
          snapshotOperationEvent(JSON.parse(rawLine) as unknown);
          eventCount += 1;
        } catch {
          // Statistics count valid projected events only.
        }
      }
    }

    return Object.freeze({
      bytes,
      days,
      eventCount,
      ...(earliestDate === undefined ? {} : { earliestDate }),
    });
  }

  async clear(): Promise<void> {
    await this.withMutation(async () => {
      const files = (await this.listControlledFiles()).sort((left, right) =>
        left.date.localeCompare(right.date),
      );
      for (const file of files) await this.vault.adapter.remove(file.path);
    });
  }

  private get stateDirectory(): string {
    return normalizePath(`${this.dataRoot}/state`);
  }

  private get journalDirectory(): string {
    return normalizePath(`${this.stateDirectory}/operation-journal`);
  }

  private pathForDate(date: string): string {
    return normalizePath(`${this.journalDirectory}/${date}.jsonl`);
  }

  private async pruneUnlocked(now: Date): Promise<void> {
    const todayOrdinal = localDayOrdinal(now);
    const today = toLocalCalendarDate(now);
    const sizedFiles: SizedJournalFile[] = [];
    for (const file of await this.listControlledFiles()) {
      const stat = await this.vault.adapter.stat(file.path);
      if (stat !== null && stat.type === "file") {
        sizedFiles.push({ ...file, size: stat.size });
      }
    }
    sizedFiles.sort((left, right) => left.date.localeCompare(right.date));

    const retained: SizedJournalFile[] = [];
    const oldestRetainedOrdinal =
      todayOrdinal - (OPERATION_JOURNAL_RETENTION_DAYS - 1);
    for (const file of sizedFiles) {
      if (file.ordinal < oldestRetainedOrdinal) {
        await this.vault.adapter.remove(file.path);
      } else {
        retained.push(file);
      }
    }

    let totalBytes = retained.reduce((total, file) => total + file.size, 0);
    for (const file of retained) {
      if (totalBytes <= OPERATION_JOURNAL_MAX_TOTAL_BYTES) break;
      if (file.date === today) continue;
      await this.vault.adapter.remove(file.path);
      totalBytes -= file.size;
    }
  }

  private async listControlledFiles(): Promise<JournalFile[]> {
    if (!(await this.vault.adapter.exists(this.journalDirectory))) return [];
    const listing = await this.vault.adapter.list(this.journalDirectory);
    const prefix = `${this.journalDirectory}/`;
    const files: JournalFile[] = [];
    for (const path of listing.files) {
      if (!path.startsWith(prefix)) continue;
      const name = path.slice(prefix.length);
      if (name.includes("/") || !JOURNAL_FILE_NAME.test(name)) continue;
      const date = name.slice(0, -".jsonl".length);
      const ordinal = strictDateOrdinal(date);
      if (ordinal === undefined || path !== this.pathForDate(date)) continue;
      files.push({ date, ordinal, path });
    }
    return files;
  }

  private async ensureJournalDirectory(): Promise<void> {
    await this.ensureDirectory(this.dataRoot);
    await this.ensureDirectory(this.stateDirectory);
    await this.ensureDirectory(this.journalDirectory);
  }

  private async ensureDirectory(path: string): Promise<void> {
    if (!(await this.vault.adapter.exists(path))) {
      await this.vault.adapter.mkdir(path);
    }
  }

  private lastMaintenanceDate(): string | undefined {
    return vaultMaintenanceDates.get(this.vault)?.get(this.journalDirectory);
  }

  private setLastMaintenanceDate(date: string): void {
    const dates =
      vaultMaintenanceDates.get(this.vault) ?? new Map<string, string>();
    vaultMaintenanceDates.set(this.vault, dates);
    dates.set(this.journalDirectory, date);
  }

  private async withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const queues =
      vaultMutationQueues.get(this.vault) ?? new Map<string, Promise<void>>();
    vaultMutationQueues.set(this.vault, queues);
    const previous = queues.get(this.journalDirectory) ?? Promise.resolve();
    const mutation = previous.then(operation);
    const recoveredQueue = mutation.then(
      () => undefined,
      () => undefined,
    );
    queues.set(this.journalDirectory, recoveredQueue);

    try {
      return await mutation;
    } finally {
      if (queues.get(this.journalDirectory) === recoveredQueue) {
        queues.delete(this.journalDirectory);
        if (queues.size === 0) vaultMutationQueues.delete(this.vault);
      }
    }
  }
}

function normalizeEventLimit(value: number | undefined): number {
  if (value === undefined) return OPERATION_JOURNAL_MAX_READ_EVENTS;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Invalid operation journal event limit.");
  }
  return Math.min(value, OPERATION_JOURNAL_MAX_READ_EVENTS);
}

function localDayOrdinal(date: Date): number {
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError("Invalid operation journal time.");
  }
  const ordinal = strictDateOrdinal(toLocalCalendarDate(date));
  if (ordinal === undefined) {
    throw new TypeError("Invalid operation journal time.");
  }
  return ordinal;
}

function strictDateOrdinal(value: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }
  return Math.floor(date.getTime() / DAY_MS);
}

function hasUnknownSchema(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.prototype.hasOwnProperty.call(value, "schemaVersion") &&
    Reflect.get(value, "schemaVersion") !== 1
  );
}

function assertSafeDataRoot(folder: string): void {
  if (
    !folder ||
    folder.startsWith("/") ||
    folder.includes("\\") ||
    folder.includes("\0") ||
    /^[A-Za-z]:/u.test(folder)
  ) {
    throw new Error("Invalid operation journal data folder");
  }
  if (
    folder
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("Invalid operation journal data folder");
  }
}
