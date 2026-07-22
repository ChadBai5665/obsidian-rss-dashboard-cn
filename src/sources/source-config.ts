export type SourceKind = "feed" | "x-account" | "x-topic";

export interface FeedSourceConfig {
  kind: "feed";
}

export interface XAccountSourceConfig {
  kind: "x-account";
  id: string;
  handle: string;
  displayName?: string;
  includeReplies: boolean;
  includeReposts: boolean;
  folder: string;
  topics: string[];
}

export interface XTopicSourceConfig {
  kind: "x-topic";
  id: string;
  name: string;
  includeKeywords: string[];
  excludeKeywords: string[];
  priorityAccounts: string[];
  windowDays: 1 | 3 | 7 | 14 | 30;
  folder: string;
}

export type SourceConfig =
  | FeedSourceConfig
  | XAccountSourceConfig
  | XTopicSourceConfig;

export interface CreateXAccountSourceConfigInput {
  id?: string;
  handle: string;
  displayName?: string;
  includeReplies?: boolean;
  includeReposts?: boolean;
  folder?: string;
  topics?: string[];
}

export interface CreateXTopicSourceConfigInput {
  id?: string;
  name: string;
  includeKeywords?: string[];
  excludeKeywords?: string[];
  priorityAccounts?: string[];
  windowDays?: XTopicSourceConfig["windowDays"];
  folder?: string;
}

const WINDOW_DAYS = new Set<XTopicSourceConfig["windowDays"]>([
  1, 3, 7, 14, 30,
]);
const UNSAFE_IDS = new Set(["__proto__", "constructor", "prototype"]);

function hasOwn(object: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizedText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.normalize("NFC").trim();
  return normalized || undefined;
}

function normalizedId(value: unknown): string | undefined {
  const id = normalizedText(value);
  const canonicalId = id?.toLowerCase();
  return canonicalId &&
    !UNSAFE_IDS.has(canonicalId) &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(canonicalId)
    ? canonicalId
    : undefined;
}

/** X handles intentionally accept only the documented ASCII handle alphabet. */
export function normalizeXHandle(value: unknown): string | undefined {
  const handle = normalizedText(value)?.toLowerCase();
  return handle && /^[a-z0-9_]{1,15}$/.test(handle) ? handle : undefined;
}

function ownDenseStringEntries(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries: string[] = [];
  for (let index = 0; index < value.length; index++) {
    if (!hasOwn(value, index)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      !descriptor ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "string"
    ) {
      return undefined;
    }
    entries.push(descriptor.value);
  }
  return entries;
}

function normalizedStringList(value: unknown): string[] | undefined {
  const entries = ownDenseStringEntries(value);
  if (!entries) return undefined;
  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const text = normalizedText(entry);
    const key = text?.toLowerCase();
    if (!text || !key || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

function normalizedAccountList(value: unknown): string[] | undefined {
  const entries = ownDenseStringEntries(value);
  if (!entries) return undefined;
  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const handle = normalizeXHandle(entry);
    if (!handle || seen.has(handle)) continue;
    seen.add(handle);
    result.push(handle);
  }
  return result;
}

function hasRequiredOwnProperties(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return keys.every((key) => hasOwn(value, key));
}

export function normalizeXAccountSourceConfig(
  value: unknown,
): XAccountSourceConfig | undefined {
  if (
    !isRecord(value) ||
    !hasRequiredOwnProperties(value, [
      "kind",
      "id",
      "handle",
      "includeReplies",
      "includeReposts",
      "folder",
      "topics",
    ])
  ) {
    return undefined;
  }
  const handle = normalizeXHandle(value.handle);
  const id = normalizedId(value.id);
  if (value.kind !== "x-account" || !handle || !id) return undefined;
  const topics = normalizedStringList(value.topics);
  if (!topics) return undefined;
  const displayName = hasOwn(value, "displayName")
    ? normalizedText(value.displayName)
    : undefined;
  return {
    kind: "x-account",
    id,
    handle,
    ...(displayName ? { displayName } : {}),
    includeReplies: value.includeReplies === true,
    includeReposts: value.includeReposts === true,
    folder: normalizedText(value.folder) ?? "",
    topics,
  };
}

export function normalizeXTopicSourceConfig(
  value: unknown,
): XTopicSourceConfig | undefined {
  if (
    !isRecord(value) ||
    !hasRequiredOwnProperties(value, [
      "kind",
      "id",
      "name",
      "includeKeywords",
      "excludeKeywords",
      "priorityAccounts",
      "windowDays",
      "folder",
    ])
  ) {
    return undefined;
  }
  const id = normalizedId(value.id);
  const name = normalizedText(value.name);
  if (
    value.kind !== "x-topic" ||
    !id ||
    !name ||
    !WINDOW_DAYS.has(value.windowDays as XTopicSourceConfig["windowDays"])
  ) {
    return undefined;
  }
  const includeKeywords = normalizedStringList(value.includeKeywords);
  const excludeKeywords = normalizedStringList(value.excludeKeywords);
  const priorityAccounts = normalizedAccountList(value.priorityAccounts);
  if (!includeKeywords || !excludeKeywords || !priorityAccounts)
    return undefined;
  return {
    kind: "x-topic",
    id,
    name,
    includeKeywords,
    excludeKeywords,
    priorityAccounts,
    windowDays: value.windowDays as XTopicSourceConfig["windowDays"],
    folder: normalizedText(value.folder) ?? "",
  };
}

export function normalizeSourceConfig(
  value: unknown,
): SourceConfig | undefined {
  if (!isRecord(value) || !hasOwn(value, "kind")) return undefined;
  if (value.kind === "feed") return { kind: "feed" };
  if (value.kind === "x-account") return normalizeXAccountSourceConfig(value);
  if (value.kind === "x-topic") return normalizeXTopicSourceConfig(value);
  return undefined;
}

function createTopicId(): string {
  const randomUuid =
    typeof window === "undefined" ? undefined : window.crypto?.randomUUID?.();
  return (
    randomUuid ??
    `topic-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
  );
}

export function createXAccountSourceConfig(
  input: CreateXAccountSourceConfigInput,
): XAccountSourceConfig {
  const handle = normalizeXHandle(input.handle);
  if (!handle) throw new Error("Invalid X account handle");
  const result = normalizeXAccountSourceConfig({
    kind: "x-account",
    id: input.id ?? `x-account-${handle}`,
    handle,
    displayName: input.displayName,
    includeReplies: input.includeReplies === true,
    includeReposts: input.includeReposts === true,
    folder: input.folder ?? "",
    topics: input.topics ?? [],
  });
  if (!result) throw new Error("Invalid X account source configuration");
  return result;
}

export function createXTopicSourceConfig(
  input: CreateXTopicSourceConfigInput,
): XTopicSourceConfig {
  const result = normalizeXTopicSourceConfig({
    kind: "x-topic",
    id: input.id ?? createTopicId(),
    name: input.name,
    includeKeywords: input.includeKeywords ?? [],
    excludeKeywords: input.excludeKeywords ?? [],
    priorityAccounts: input.priorityAccounts ?? [],
    windowDays: input.windowDays ?? 7,
    folder: input.folder ?? "",
  });
  if (!result) throw new Error("Invalid X topic source configuration");
  return result;
}

/** Stable synthetic URLs keep X inputs out of the RSS parser path. */
export function sourceConfigUrl(config: unknown): string | undefined {
  const normalized = normalizeSourceConfig(config);
  if (normalized?.kind === "x-account") {
    return `tikhub://x-account/${normalized.handle}`;
  }
  if (normalized?.kind === "x-topic") {
    return `tikhub://x-topic/${normalized.id}`;
  }
  return undefined;
}

export function isSourceKind(value: unknown): value is SourceKind {
  return value === "feed" || value === "x-account" || value === "x-topic";
}

export function inferXSourceKind(
  value: unknown,
): "x-account" | "x-topic" | undefined {
  if (value === "x-account" || value === "x-topic") return value;
  if (
    isRecord(value) &&
    hasOwn(value, "kind") &&
    (value.kind === "x-account" || value.kind === "x-topic")
  ) {
    return value.kind;
  }
  if (typeof value !== "string") return undefined;
  const match =
    /^tikhub:\/\/(x-account|x-topic)\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/.exec(
      value,
    );
  return match?.[1] as "x-account" | "x-topic" | undefined;
}

export function isSyntheticUrlForKind(
  url: unknown,
  kind: "x-account" | "x-topic",
): boolean {
  if (typeof url !== "string") return false;
  const inferred = inferXSourceKind(url);
  if (inferred !== kind) return false;
  const identifier = url.slice(`tikhub://${kind}/`.length);
  return kind === "x-account"
    ? normalizeXHandle(identifier) === identifier
    : normalizedId(identifier) === identifier;
}

/** Returns a fresh list while retaining only the first case-insensitive account. */
export function dedupeXAccountSourceConfigs(
  configs: readonly XAccountSourceConfig[],
): XAccountSourceConfig[] {
  const result: XAccountSourceConfig[] = [];
  const seen = new Set<string>();
  for (const config of configs) {
    const normalized = normalizeXAccountSourceConfig(config);
    if (!normalized || seen.has(normalized.handle)) continue;
    seen.add(normalized.handle);
    result.push(normalized);
  }
  return result;
}
