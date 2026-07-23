const MAX_EVENTS = 10_000;
const MAX_AGGREGATE = 1_000_000_000;
const VERSION_PATTERN = /^[0-9]+(?:\.[0-9A-Za-z-]+){1,4}$/u;
const SOURCE_KINDS = new Set(["feed", "x-account", "x-topic"]);
const STATUS_CODES = new Set([
  "ok",
  "source-failed",
  "missing-key",
  "invalid-key",
  "budget-exhausted",
  "rate-limited",
  "timeout",
  "network-failure",
  "provider-unavailable",
  "invalid-source",
]);
const AGGREGATE_KEYS = new Set([
  "enabledAiConnections",
  "failedSources",
  "enabledSources",
]);

export interface SafeDiagnosticsInput {
  readonly pluginVersion: unknown;
  readonly obsidianVersion: unknown;
  readonly osName: unknown;
  readonly generatedAt: unknown;
  readonly lastRefreshAt?: unknown;
  readonly sourceKinds: unknown;
  readonly statusCodes: unknown;
  readonly aggregateCounts: unknown;
}

export interface SafeDiagnostics extends Readonly<Record<string, unknown>> {
  readonly pluginVersion: string;
  readonly obsidianVersion: string;
  readonly os: "macOS" | "Windows" | "Linux" | "Other" | "unknown";
  readonly generatedAt: string;
  readonly lastRefreshAt?: string;
  readonly sourceCounts: Readonly<Record<string, number>>;
  readonly statusCounts: Readonly<Record<string, number>>;
  readonly aggregateCounts: Readonly<Record<string, number>>;
}

export class SafeDiagnosticsError extends Error {
  constructor() {
    super("Unable to build safe diagnostics.");
    this.name = "SafeDiagnosticsError";
  }
}

export function buildSafeDiagnostics(input: unknown): SafeDiagnostics {
  try {
    const source = objectRecord(input);
    const pluginVersion = version(requiredData(source, "pluginVersion"));
    const obsidianVersion = version(requiredData(source, "obsidianVersion"));
    const generatedAt = isoTimestamp(requiredData(source, "generatedAt"));
    const lastRefresh = optionalData(source, "lastRefreshAt");
    const sourceCounts = countBuckets(
      denseArray(requiredData(source, "sourceKinds")),
      SOURCE_KINDS,
    );
    const statusCounts = countBuckets(
      denseArray(requiredData(source, "statusCodes")),
      STATUS_CODES,
    );
    const aggregateCounts = copyAggregateCounts(
      requiredData(source, "aggregateCounts"),
    );
    const output = createRecord();
    output.pluginVersion = pluginVersion;
    output.obsidianVersion = obsidianVersion;
    output.os = coarseOs(requiredData(source, "osName"));
    output.generatedAt = generatedAt;
    if (lastRefresh.present) output.lastRefreshAt = isoTimestamp(lastRefresh.value);
    output.sourceCounts = sourceCounts;
    output.statusCounts = statusCounts;
    output.aggregateCounts = aggregateCounts;
    return deepFreeze(output) as SafeDiagnostics;
  } catch (error) {
    if (error instanceof SafeDiagnosticsError) throw error;
    throw new SafeDiagnosticsError();
  }
}

export function stringifySafeDiagnostics(input: unknown): string {
  return JSON.stringify(buildSafeDiagnostics(input), null, 2);
}

function countBuckets(values: unknown[], allowed: ReadonlySet<string>): Record<string, number> {
  const counts = createRecord() as Record<string, number>;
  for (const value of values) {
    const bucket = typeof value === "string" && allowed.has(value) ? value : "unknown";
    counts[bucket] = (counts[bucket] ?? 0) + 1;
  }
  return counts;
}

function copyAggregateCounts(value: unknown): Record<string, number> {
  const source = objectRecord(value);
  const output = createRecord() as Record<string, number>;
  const keys = Reflect.ownKeys(source);
  for (const key of keys) {
    if (typeof key !== "string" || !AGGREGATE_KEYS.has(key)) {
      throw new SafeDiagnosticsError();
    }
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor || !("value" in descriptor)) throw new SafeDiagnosticsError();
    if (
      typeof descriptor.value !== "number" ||
      !Number.isSafeInteger(descriptor.value) ||
      descriptor.value < 0 ||
      descriptor.value > MAX_AGGREGATE
    ) {
      throw new SafeDiagnosticsError();
    }
    output[key] = descriptor.value;
  }
  return output;
}

function version(value: unknown): string {
  if (typeof value !== "string" || value.length > 64 || !VERSION_PATTERN.test(value)) {
    throw new SafeDiagnosticsError();
  }
  return value;
}

function isoTimestamp(value: unknown): string {
  if (typeof value !== "string" || value.length !== 24) throw new SafeDiagnosticsError();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new SafeDiagnosticsError();
  }
  return value;
}

function coarseOs(value: unknown): SafeDiagnostics["os"] {
  if (typeof value !== "string") return "unknown";
  switch (value.toLowerCase()) {
    case "darwin":
    case "macos":
    case "mac":
      return "macOS";
    case "win32":
    case "windows":
      return "Windows";
    case "linux":
      return "Linux";
    case "other":
      return "Other";
    default:
      return "unknown";
  }
}

function denseArray(value: unknown): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new SafeDiagnosticsError();
  }
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value as unknown;
  if (
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > MAX_EVENTS
  ) {
    throw new SafeDiagnosticsError();
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1 || !keys.includes("length")) {
    throw new SafeDiagnosticsError();
  }
  const output: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) throw new SafeDiagnosticsError();
    output.push(descriptor.value);
  }
  return output;
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SafeDiagnosticsError();
  }
  return value as Record<string, unknown>;
}

function optionalData(record: Record<string, unknown>, key: string): { present: false } | { present: true; value: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor) return { present: false };
  if (!("value" in descriptor)) throw new SafeDiagnosticsError();
  return { present: true, value: descriptor.value };
}

function requiredData(record: Record<string, unknown>, key: string): unknown {
  const value = optionalData(record, key);
  if (!value.present) throw new SafeDiagnosticsError();
  return value.value;
}

function createRecord(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}
