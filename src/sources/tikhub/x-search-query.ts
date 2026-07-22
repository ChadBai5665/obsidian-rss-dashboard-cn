import type { XTopicSourceConfig } from "../source-config";
import type { TikHubSearchType } from "./tikhub-types";

export type XObservationTag =
  | "latest"
  | "platform-top"
  | "priority-account";

export interface XTopicSearchRequestPlan {
  query: string;
  searchType: TikHubSearchType;
  observationTag: XObservationTag;
}

export interface XTopicSearchPlan {
  requestCount: number;
  requests: XTopicSearchRequestPlan[];
}

export class XSearchQueryError extends Error {
  readonly code = "invalid-x-search-query";

  constructor(message = "Invalid X search query") {
    super(message);
    this.name = "XSearchQueryError";
  }
}

export function buildXTopicSearchPlan(
  config: XTopicSourceConfig,
  now: Date,
): XTopicSearchPlan {
  const includeKeywords = readStringArray(config, "includeKeywords");
  const excludeKeywords = readStringArray(config, "excludeKeywords");
  const priorityAccounts = readStringArray(config, "priorityAccounts");
  const windowDays = readWindowDays(config);
  const includes = normalizeTerms(includeKeywords, true);
  const exclusions = normalizeTerms(excludeKeywords, false);
  const accounts = normalizeAccounts(priorityAccounts);
  const since = localSinceDate(now, windowDays);

  const includeGroup = `(${includes.map(literalTerm).join(" OR ")})`;
  const exclusionClauses = exclusions.map(
    (term) => `-${quotedLiteral(term)}`,
  );
  const baseQuery = [includeGroup, ...exclusionClauses, `since:${since}`].join(
    " ",
  );
  assertQueryLength(baseQuery);

  const requests: XTopicSearchRequestPlan[] = [
    { query: baseQuery, searchType: "Latest", observationTag: "latest" },
    { query: baseQuery, searchType: "Top", observationTag: "platform-top" },
  ];
  if (accounts.length > 0) {
    const priorityQuery = `${baseQuery} (${accounts
      .map((handle) => `from:${handle}`)
      .join(" OR ")})`;
    assertQueryLength(priorityQuery);
    requests.push({
      query: priorityQuery,
      searchType: "Latest",
      observationTag: "priority-account",
    });
  }
  return { requestCount: requests.length, requests };
}

const WINDOWS = new Set([1, 3, 7, 14, 30]);
const X_HANDLE = /^[a-z0-9_]{1,15}$/u;
const SAFE_UNQUOTED = /^[\p{L}\p{N}_]+(?:-[\p{L}\p{N}_]+)*$/u;

function readWindowDays(config: XTopicSourceConfig): number {
  const value = ownData(config, "windowDays");
  if (typeof value !== "number" || !WINDOWS.has(value)) {
    throw new XSearchQueryError();
  }
  return value;
}

function readStringArray(
  config: XTopicSourceConfig,
  key: "includeKeywords" | "excludeKeywords" | "priorityAccounts",
): string[] {
  const value = ownData(config, key);
  if (!Array.isArray(value)) throw new XSearchQueryError();
  try {
    if (Reflect.getPrototypeOf(value) !== Array.prototype) {
      throw new XSearchQueryError();
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const length: unknown =
      lengthDescriptor && "value" in lengthDescriptor
        ? lengthDescriptor.value
        : undefined;
    if (
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > 1_000
    ) {
      throw new XSearchQueryError();
    }
    const result: string[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") {
        throw new XSearchQueryError();
      }
      result.push(descriptor.value);
    }
    return result;
  } catch (error) {
    if (error instanceof XSearchQueryError) throw error;
    throw new XSearchQueryError();
  }
}

function ownData(config: XTopicSourceConfig, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(config, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function normalizeTerms(values: string[], required: boolean): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (hasControl(value)) throw new XSearchQueryError();
    const normalized = value.normalize("NFC").replace(/\s+/gu, " ").trim();
    if (!normalized) continue;
    if (Array.from(normalized).length > 100) {
      throw new XSearchQueryError("Each X search term is limited to 100 code points");
    }
    const key = normalized.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(normalized);
    }
  }
  if (required && result.length === 0) {
    throw new XSearchQueryError("At least one X search include term is required");
  }
  return result;
}

function normalizeAccounts(values: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (hasControl(value)) throw new XSearchQueryError();
    const handle = value.normalize("NFC").trim().toLowerCase();
    if (!X_HANDLE.test(handle)) throw new XSearchQueryError();
    if (!seen.has(handle)) {
      seen.add(handle);
      result.push(handle);
    }
  }
  return result;
}

function literalTerm(term: string): string {
  return SAFE_UNQUOTED.test(term) && term !== "OR" && term !== "AND"
    ? term
    : quotedLiteral(term);
}

function quotedLiteral(term: string): string {
  return `"${term.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

function hasControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 31 || codePoint === 127) return true;
  }
  return false;
}

function localSinceDate(now: Date, windowDays: number): string {
  let timestamp: number;
  let year: number;
  let month: number;
  let date: number;
  try {
    timestamp = Date.prototype.getTime.call(now);
    year = Date.prototype.getFullYear.call(now);
    month = Date.prototype.getMonth.call(now);
    date = Date.prototype.getDate.call(now);
  } catch {
    throw new XSearchQueryError();
  }
  if (!Number.isFinite(timestamp)) throw new XSearchQueryError();
  return new Date(Date.UTC(year, month, date - windowDays))
    .toISOString()
    .slice(0, 10);
}

function assertQueryLength(query: string): void {
  if (Array.from(query).length > 500) {
    throw new XSearchQueryError("The complete X query is limited to 500 code points");
  }
}
