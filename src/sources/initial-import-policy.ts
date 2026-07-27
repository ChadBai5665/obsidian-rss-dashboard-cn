import type { FeedItem } from "../types/types";

export type InitialImportPolicy =
  | { mode: "from-now" }
  | { mode: "lookback-days"; days: number }
  | { mode: "since-date"; since: string }
  | { mode: "all-available" };

export interface InitialImportProgress {
  status: "pending" | "running" | "paused-limit" | "stopped" | "completed" | "failed";
  pagesFetched: number;
  itemsImported: number;
  earliestImportedAt?: string;
  nextCursor?: string;
  replyCursor?: string;
}

export const DEFAULT_INITIAL_IMPORT_POLICY: InitialImportPolicy =
  Object.freeze({ mode: "lookback-days", days: 7 });

const INITIAL_IMPORT_PROGRESS_STATUSES = new Set<InitialImportProgress["status"]>([
  "pending",
  "running",
  "paused-limit",
  "stopped",
  "completed",
  "failed",
]);
const MAX_CURSOR_LENGTH = 4_096;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;

export function normalizeInitialImportPolicy(
  value: unknown,
): InitialImportPolicy | undefined {
  if (value === undefined) return { ...DEFAULT_INITIAL_IMPORT_POLICY };

  const record = dataRecord(value);
  const mode = ownData(record, "mode");
  if (!record || !mode.present || typeof mode.value !== "string") {
    return undefined;
  }

  if (mode.value === "from-now" || mode.value === "all-available") {
    return { mode: mode.value };
  }
  if (mode.value === "lookback-days") {
    const days = ownData(record, "days");
    return days.present && isSafeInteger(days.value, 1, 3_650)
      ? { mode: "lookback-days", days: days.value }
      : undefined;
  }
  if (mode.value === "since-date") {
    const since = ownData(record, "since");
    return since.present && isCalendarDate(since.value)
      ? { mode: "since-date", since: since.value }
      : undefined;
  }
  return undefined;
}

export function normalizeInitialImportProgress(
  value: unknown,
): InitialImportProgress | undefined {
  const record = dataRecord(value);
  if (!record) return undefined;

  const status = ownData(record, "status");
  const pagesFetched = ownData(record, "pagesFetched");
  const itemsImported = ownData(record, "itemsImported");
  if (
    !status.present ||
    !INITIAL_IMPORT_PROGRESS_STATUSES.has(
      status.value as InitialImportProgress["status"],
    ) ||
    !pagesFetched.present ||
    !isSafeInteger(pagesFetched.value, 0, Number.MAX_SAFE_INTEGER) ||
    !itemsImported.present ||
    !isSafeInteger(itemsImported.value, 0, Number.MAX_SAFE_INTEGER)
  ) {
    return undefined;
  }

  const output: InitialImportProgress = {
    status: status.value as InitialImportProgress["status"],
    pagesFetched: pagesFetched.value,
    itemsImported: itemsImported.value,
  };
  const earliestImportedAt = optionalString(record, "earliestImportedAt");
  const nextCursor = optionalCursor(record, "nextCursor");
  const replyCursor = optionalCursor(record, "replyCursor");
  if (
    earliestImportedAt.invalid ||
    nextCursor.invalid ||
    replyCursor.invalid
  ) {
    return undefined;
  }
  if (earliestImportedAt.value !== undefined) {
    output.earliestImportedAt = earliestImportedAt.value;
  }
  if (nextCursor.value !== undefined) output.nextCursor = nextCursor.value;
  if (replyCursor.value !== undefined) output.replyCursor = replyCursor.value;
  return output;
}

export function filterItemsForInitialImport(
  items: readonly FeedItem[],
  policy: InitialImportPolicy,
  now: Date,
): FeedItem[] {
  if (policy.mode === "from-now") return [];
  if (policy.mode === "all-available") return [...items];

  const nowMs = now.getTime();
  const cutoff = policy.mode === "lookback-days"
    ? nowMs - policy.days * MILLISECONDS_PER_DAY
    : calendarDateStartMs(policy.since);
  return items.filter((item) => {
    const publishedAt = Date.parse(item.pubDate);
    return Number.isFinite(publishedAt) && publishedAt >= cutoff;
  });
}

function dataRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function ownData(
  record: Record<string, unknown> | undefined,
  key: string,
):
  | { present: false; accessor: boolean }
  | { present: true; value: unknown; accessor: false } {
  if (!record) return { present: false, accessor: false };
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor) return { present: false, accessor: false };
    if (!("value" in descriptor)) return { present: false, accessor: true };
    return { present: true, value: descriptor.value, accessor: false };
  } catch {
    return { present: false, accessor: false };
  }
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
): { invalid: boolean; value?: string } {
  const field = ownData(record, key);
  if (!field.present) return { invalid: field.accessor };
  return typeof field.value === "string"
    ? { invalid: false, value: field.value }
    : { invalid: true };
}

function optionalCursor(
  record: Record<string, unknown>,
  key: string,
): { invalid: boolean; value?: string } {
  const field = optionalString(record, key);
  if (field.invalid || field.value === undefined) return field;
  return field.value.length <= MAX_CURSOR_LENGTH && isPrintable(field.value)
    ? field
    : { invalid: true };
}

function isSafeInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function calendarDateStartMs(value: string): number {
  const [year, month, day] = value.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

function isPrintable(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      codePoint <= 31 ||
      (codePoint >= 127 && codePoint <= 159)
    ) {
      return false;
    }
  }
  return true;
}
