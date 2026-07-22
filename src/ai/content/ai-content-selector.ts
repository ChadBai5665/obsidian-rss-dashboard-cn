import type { CollectedItem, ContentBasis, SourceType } from "../../collection/collected-item";
import type { CachedItemContent } from "../../collection/content-repository";
import type { FullArticleFetchResult } from "../../utils/fetch-helpers";
import { MAX_AI_SELECTED_CONTENT_CHARACTERS } from "../ai-types";
import {
  raceWithTrustedAbort,
  readTrustedAbortState,
  type TrustedAbortRaceOptions,
} from "../trusted-abort";
import {
  AI_CONTENT_OMISSION_MARKER,
  limitAiContent,
  markAiContentTruncated,
} from "./content-size";

const STABLE_ITEM_ID = /^[a-f0-9]{64}$/u;
const MAX_TITLE_CHARACTERS = 20_000;
const MAX_SOURCE_NAME_CHARACTERS = 20_000;
const MAX_SOURCE_URL_CHARACTERS = 8_192;
const FETCHABLE_SOURCE_TYPES = new Set<SourceType>([
  "rss",
  "atom",
  "json",
  "podcast",
  "website",
]);
const X_SOURCE_TYPES = new Set<SourceType>(["x-account", "x-topic"]);
const SOURCE_TYPES = new Set<SourceType>([
  ...FETCHABLE_SOURCE_TYPES,
  "youtube",
  "x-account",
  "x-topic",
]);

export interface SelectedAiContent {
  itemId: string;
  title: string;
  sourceName: string;
  sourceUrl?: string;
  content: string;
  basis: ContentBasis;
  characterCount: number;
  truncated: boolean;
}

/** Narrow interface prevents the selector from enumerating or scanning a vault. */
export interface AiContentRepository {
  read(itemId: string): Promise<CachedItemContent | null>;
}

export interface AiFullTextFetchRequest {
  itemId: string;
  url: string;
  signal?: AbortSignal;
}

export type AiFullTextFetcher = (
  request: AiFullTextFetchRequest,
) => Promise<FullArticleFetchResult>;

export interface AiContentSelectorDependencies {
  contentRepository: AiContentRepository;
  fullTextFetcher?: AiFullTextFetcher;
}

export interface SelectAiContentInput {
  item: CollectedItem;
  maxInputCharacters: number;
  /** True only after the user explicitly requested an AI action with full text. */
  fetchFullText: boolean;
  signal?: AbortSignal;
}

interface SelectedItemSnapshot {
  id: string;
  sourceType: SourceType;
  title: string;
  sourceName: string;
  sourceUrl?: string;
  excerpt?: string;
}

interface NormalizedSourceContent {
  text: string;
  sourceWasBounded: boolean;
}

/** Selects content for one item only; it has no API for vault-wide discovery. */
export class AiContentSelector {
  private readonly contentRepository: AiContentRepository;
  private readonly fullTextFetcher?: AiFullTextFetcher;

  constructor(dependencies: AiContentSelectorDependencies) {
    this.contentRepository = dependencies.contentRepository;
    this.fullTextFetcher = dependencies.fullTextFetcher;
  }

  async select(input: SelectAiContentInput): Promise<SelectedAiContent> {
    const request = snapshotSelectionRequest(input);
    throwIfAborted(request.signal);
    const selectedItem = snapshotItem(request.item);

    if (selectedItem.sourceType === "youtube") {
      return createRequiredSelection(
        selectedItem,
        joinTitleAndDescription(selectedItem.title, selectedItem.excerpt),
        "title-description",
        request.maxInputCharacters,
      );
    }

    const cached = await this.readCurrentItemContent(
      selectedItem.id,
      request.signal,
    );
    const cachedText = snapshotCachedFullText(cached, selectedItem.id);
    if (cachedText) {
      const cachedSelection = createSelection(
        selectedItem,
        cachedText,
        "full-text",
        request.maxInputCharacters,
      );
      if (cachedSelection) return cachedSelection;
    }

    if (
      request.fetchFullText &&
      this.fullTextFetcher &&
      FETCHABLE_SOURCE_TYPES.has(selectedItem.sourceType) &&
      selectedItem.sourceUrl
    ) {
      const fetched = await this.fetchExplicitFullText(
        selectedItem,
        request.signal,
      );
      if (fetched) {
        const fetchedSelection = createSelection(
          selectedItem,
          fetched,
          "full-text",
          request.maxInputCharacters,
        );
        if (fetchedSelection) return fetchedSelection;
      }
    }

    const basis: ContentBasis = X_SOURCE_TYPES.has(selectedItem.sourceType)
      ? "x-post"
      : "feed";
    return createRequiredSelection(
      selectedItem,
      selectedItem.excerpt ?? selectedItem.title,
      basis,
      request.maxInputCharacters,
    );
  }

  private async readCurrentItemContent(
    itemId: string,
    signal: AbortSignal | undefined,
  ): Promise<CachedItemContent | null> {
    try {
      return await raceWithTrustedAbort<CachedItemContent | null>(
        () => this.contentRepository.read(itemId),
        selectorAbortRaceOptions(signal),
      );
    } catch (error) {
      if (isAbortError(error)) throw error;
      return null;
    }
  }

  private async fetchExplicitFullText(
    item: SelectedItemSnapshot,
    signal: AbortSignal | undefined,
  ): Promise<string | undefined> {
    try {
      const result = await raceWithTrustedAbort<FullArticleFetchResult | undefined>(
        () => this.fullTextFetcher?.({
          itemId: item.id,
          url: item.sourceUrl as string,
          signal,
        }),
        selectorAbortRaceOptions(signal),
      );
      return snapshotFetchedFullText(result);
    } catch (error) {
      if (isAbortError(error)) throw error;
      return undefined;
    }
  }
}

function createSelection(
  item: SelectedItemSnapshot,
  rawContent: string,
  basis: ContentBasis,
  requestedLimit: number,
): SelectedAiContent | undefined {
  const normalized = normalizeSourceContent(rawContent);
  if (!normalized.text) return undefined;
  const effectiveLimit = Math.min(
    validateInputLimit(requestedLimit),
    MAX_AI_SELECTED_CONTENT_CHARACTERS,
  );
  let limited = limitAiContent(normalized.text, effectiveLimit);

  if (normalized.sourceWasBounded && !limited.truncated) {
    limited = markAiContentTruncated(normalized.text, effectiveLimit);
  }

  return {
    itemId: item.id,
    title: item.title,
    sourceName: item.sourceName,
    ...(item.sourceUrl ? { sourceUrl: item.sourceUrl } : {}),
    content: limited.content,
    basis,
    characterCount: limited.characterCount,
    truncated: limited.truncated,
  };
}

function createRequiredSelection(
  item: SelectedItemSnapshot,
  rawContent: string,
  basis: ContentBasis,
  requestedLimit: number,
): SelectedAiContent {
  const selected = createSelection(item, rawContent, basis, requestedLimit) ??
    createSelection(item, item.title, basis, requestedLimit);
  if (!selected) throw new Error("Selected item has no readable content");
  return selected;
}

function normalizeSourceContent(rawContent: string): NormalizedSourceContent {
  const scanned = scanVisibleHtml(rawContent);
  return {
    text: scanned.text,
    sourceWasBounded: scanned.visibleTextWasBounded,
  };
}

interface VisibleHtmlScan {
  text: string;
  visibleTextWasBounded: boolean;
}

interface ParsedHtmlTag {
  end: number;
  name: string;
  closing: boolean;
  complete: boolean;
  rawTextNameBoundaryValid: boolean;
}

/** Single-pass HTML scan with bounded visible-text memory and a real tail ring. */
function scanVisibleHtml(input: string): VisibleHtmlScan {
  const collector = new NormalizedVisibleTextCollector(
    MAX_AI_SELECTED_CONTENT_CHARACTERS,
  );
  let index = 0;
  let blockedTag: "script" | "style" | undefined;

  while (index < input.length) {
    if (blockedTag) {
      const opening = input.indexOf("<", index);
      if (opening === -1) break;
      const tag = parseHtmlTag(input, opening);
      if (
        tag?.complete &&
        tag.closing &&
        tag.name === blockedTag &&
        tag.rawTextNameBoundaryValid
      ) {
        blockedTag = undefined;
        collector.separate();
      }
      index = tag?.end ?? opening + 1;
      continue;
    }

    const opening = input.indexOf("<", index);
    if (opening === -1) {
      collector.appendTextRange(input, index, input.length);
      break;
    }
    collector.appendTextRange(input, index, opening);

    if (input.startsWith("<!--", opening)) {
      const closing = input.indexOf("-->", opening + 4);
      if (closing === -1) break;
      collector.separate();
      index = closing + 3;
      continue;
    }

    const tag = parseHtmlTag(input, opening);
    if (!tag) {
      collector.appendTextRange(input, opening, opening + 1);
      index = opening + 1;
      continue;
    }
    if (!tag.complete) {
      collector.appendTextRange(input, opening, input.length);
      break;
    }
    collector.separate();
    if (
      !tag.closing &&
      tag.rawTextNameBoundaryValid &&
      (tag.name === "script" || tag.name === "style")
    ) {
      blockedTag = tag.name;
    }
    index = tag.end;
  }

  return collector.finish();
}

function parseHtmlTag(input: string, start: number): ParsedHtmlTag | undefined {
  let cursor = start + 1;
  let closing = false;
  if (input[cursor] === "/") {
    closing = true;
    cursor += 1;
  }
  if (cursor >= input.length || isHtmlWhitespace(input.charCodeAt(cursor))) {
    return undefined;
  }

  const nameStart = cursor;
  const declaration = input[cursor] === "!" || input[cursor] === "?";
  if (!declaration && !isAsciiLetterCode(input.charCodeAt(cursor))) {
    return undefined;
  }
  while (cursor < input.length && isAsciiTagNameCode(input.charCodeAt(cursor))) {
    cursor += 1;
  }
  const hasName = cursor > nameStart;
  const name = hasName && cursor - nameStart <= 32
    ? input.slice(nameStart, cursor).toLowerCase()
    : hasName ? "other" : "";
  const rawTextNameBoundaryValid =
    cursor < input.length && isRawTextTagNameBoundary(input.charCodeAt(cursor));
  if (!hasName && input[cursor] !== "!" && input[cursor] !== "?") {
    return undefined;
  }

  let quote: "\"" | "'" | undefined;
  for (; cursor < input.length; cursor += 1) {
    const character = input[cursor];
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (character === ">") {
      return {
        end: cursor + 1,
        name,
        closing,
        complete: true,
        rawTextNameBoundaryValid,
      };
    }
  }
  return {
    end: input.length,
    name,
    closing,
    complete: false,
    rawTextNameBoundaryValid,
  };
}

function isRawTextTagNameBoundary(code: number): boolean {
  return isHtmlWhitespace(code) || code === 47 || code === 62;
}

function isAsciiLetterCode(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isAsciiTagNameCode(code: number): boolean {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 45 ||
    code === 58
  );
}

function isHtmlWhitespace(code: number): boolean {
  return code === 9 || code === 10 || code === 12 || code === 13 || code === 32;
}

class BoundedVisibleTextCollector {
  private readonly leadingLimit: number;
  private readonly trailingLimit: number;
  private readonly initial: Uint16Array;
  private initialLength = 0;
  private bounded = false;
  private leading = "";
  private readonly trailing: Uint16Array;
  private trailingLength = 0;
  private trailingWriteIndex = 0;

  constructor(private readonly limit: number) {
    this.leadingLimit = Math.floor(limit / 2);
    this.trailingLimit = limit - this.leadingLimit;
    this.initial = new Uint16Array(limit);
    this.trailing = new Uint16Array(this.trailingLimit);
  }

  appendCodeUnit(code: number): void {
    if (!this.bounded && this.initialLength < this.limit) {
      this.initial[this.initialLength] = code;
      this.initialLength += 1;
      return;
    }
    if (!this.bounded) {
      this.bounded = true;
      this.leading = codeUnitsToString(
        this.initial.subarray(0, this.leadingLimit),
      );
      this.writeTrailingCodes(this.initial, 0, this.initialLength);
    }
    this.writeTrailingCode(code);
  }

  finish(): VisibleHtmlScan {
    if (!this.bounded) {
      return {
        text: codeUnitsToString(this.initial.subarray(0, this.initialLength)),
        visibleTextWasBounded: false,
      };
    }
    return {
      text: `${this.leading}${this.readTrailing()}`,
      visibleTextWasBounded: true,
    };
  }

  private writeTrailingCode(code: number): void {
    this.trailing[this.trailingWriteIndex] = code;
    this.trailingWriteIndex =
      (this.trailingWriteIndex + 1) % this.trailingLimit;
    this.trailingLength = Math.min(
      this.trailingLength + 1,
      this.trailingLimit,
    );
  }

  private writeTrailingCodes(
    source: Uint16Array,
    rangeStart: number,
    end: number,
  ): void {
    let start = rangeStart;
    if (end - start >= this.trailingLimit) {
      start = end - this.trailingLimit;
      this.trailingLength = 0;
      this.trailingWriteIndex = 0;
    }
    for (let index = start; index < end; index += 1) {
      this.trailing[this.trailingWriteIndex] = source[index];
      this.trailingWriteIndex =
        (this.trailingWriteIndex + 1) % this.trailingLimit;
      this.trailingLength = Math.min(
        this.trailingLength + 1,
        this.trailingLimit,
      );
    }
  }

  private readTrailing(): string {
    const start =
      (this.trailingWriteIndex - this.trailingLength + this.trailingLimit) %
      this.trailingLimit;
    const codes = new Uint16Array(this.trailingLength);
    for (let index = 0; index < this.trailingLength; index += 1) {
      codes[index] = this.trailing[(start + index) % this.trailingLimit];
    }
    return codeUnitsToString(codes);
  }
}

/** Decodes basic entities and collapses visible whitespace before bounding. */
class NormalizedVisibleTextCollector {
  private readonly collector: BoundedVisibleTextCollector;
  private hasText = false;
  private pendingSeparator = false;

  constructor(limit: number) {
    this.collector = new BoundedVisibleTextCollector(limit);
  }

  appendTextRange(source: string, start: number, end: number): void {
    let index = start;
    while (index < end) {
      if (source.charCodeAt(index) === 38) {
        const entity = readBasicHtmlEntity(source, index, end);
        if (entity) {
          this.appendDecoded(entity.value);
          index = entity.end;
          continue;
        }
      }
      this.appendNormalizedCodeUnit(source.charCodeAt(index));
      index += 1;
    }
  }

  separate(): void {
    if (this.hasText) this.pendingSeparator = true;
  }

  finish(): VisibleHtmlScan {
    return this.collector.finish();
  }

  private appendDecoded(value: string): void {
    for (let index = 0; index < value.length; index += 1) {
      this.appendNormalizedCodeUnit(value.charCodeAt(index));
    }
  }

  private appendNormalizedCodeUnit(code: number): void {
    if (isVisibleWhitespace(code)) {
      this.separate();
      return;
    }
    if (this.pendingSeparator) {
      this.collector.appendCodeUnit(32);
      this.pendingSeparator = false;
    }
    this.collector.appendCodeUnit(code);
    this.hasText = true;
  }
}

interface DecodedHtmlEntity {
  value: string;
  end: number;
}

function readBasicHtmlEntity(
  source: string,
  start: number,
  end: number,
): DecodedHtmlEntity | undefined {
  const semicolon = source.indexOf(";", start + 1);
  if (semicolon === -1 || semicolon >= end || semicolon - start > 9) {
    return undefined;
  }
  const token = source.slice(start + 1, semicolon);
  if (!/^(?:#x[0-9a-f]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos|nbsp)$/iu.test(token)) {
    return undefined;
  }
  const match = source.slice(start, semicolon + 1);
  return {
    value: decodeHtmlEntity(match, token),
    end: semicolon + 1,
  };
}

function isVisibleWhitespace(code: number): boolean {
  return (
    code === 9 ||
    code === 10 ||
    code === 11 ||
    code === 12 ||
    code === 13 ||
    code === 32 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

function codeUnitsToString(codes: Uint16Array): string {
  const chunks: string[] = [];
  const size = 8_192;
  for (let offset = 0; offset < codes.length; offset += size) {
    const numbers: number[] = [];
    const end = Math.min(offset + size, codes.length);
    for (let index = offset; index < end; index += 1) {
      numbers.push(codes[index]);
    }
    chunks.push(String.fromCharCode(...numbers));
  }
  return chunks.join("");
}

function decodeHtmlEntity(match: string, token: string): string {
  const normalized = token.toLowerCase();
  const named: Readonly<Record<string, string>> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: "\"",
    apos: "'",
    nbsp: " ",
  };
  if (Object.prototype.hasOwnProperty.call(named, normalized)) {
    return named[normalized];
  }
  const codePoint = normalized.startsWith("#x")
    ? Number.parseInt(normalized.slice(2), 16)
    : Number.parseInt(normalized.slice(1), 10);
  if (
    !Number.isInteger(codePoint) ||
    codePoint <= 0 ||
    codePoint > 0x10ffff ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  ) {
    return match;
  }
  return String.fromCodePoint(codePoint);
}

function joinTitleAndDescription(title: string, excerpt: string | undefined): string {
  return excerpt ? `${title}\n${excerpt}` : title;
}

function snapshotSelectionRequest(input: SelectAiContentInput): {
  item: CollectedItem;
  maxInputCharacters: number;
  fetchFullText: boolean;
  signal?: AbortSignal;
} {
  const record = plainRecord(input);
  const item = ownData(record, "item");
  const maxInputCharacters = ownData(record, "maxInputCharacters");
  const fetchFullText = ownData(record, "fetchFullText");
  const signal = ownOptionalData(record, "signal");
  if (
    !record ||
    typeof item !== "object" ||
    item === null ||
    typeof maxInputCharacters !== "number" ||
    typeof fetchFullText !== "boolean" ||
    (signal !== undefined && readTrustedAbortState(signal) === undefined)
  ) {
    throw new Error("Invalid AI content selection request");
  }
  return {
    item: item as CollectedItem,
    maxInputCharacters: validateInputLimit(maxInputCharacters),
    fetchFullText,
    ...(signal === undefined ? {} : { signal: signal as AbortSignal }),
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal && readTrustedAbortState(signal)) {
    throw createSelectionAbortError();
  }
}

function selectorAbortRaceOptions(
  signal: AbortSignal | undefined,
): TrustedAbortRaceOptions {
  return {
    signal,
    createAbortError: createSelectionAbortError,
    createInvalidSignalError: () => new Error(
      "Invalid AI content selection request",
    ),
  };
}

function createSelectionAbortError(): DOMException {
  return new DOMException("AI content selection cancelled", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function snapshotItem(item: CollectedItem): SelectedItemSnapshot {
  const record = plainRecord(item);
  const id = ownData(record, "id");
  const sourceType = ownData(record, "sourceType");
  const title = boundedText(ownData(record, "title"), MAX_TITLE_CHARACTERS);
  const sourceName = boundedText(
    ownData(record, "sourceName"),
    MAX_SOURCE_NAME_CHARACTERS,
  );
  const sourceUrl = safeSourceUrl(ownOptionalData(record, "url"));
  const excerptValue = ownOptionalData(record, "excerpt");
  const excerpt = typeof excerptValue === "string" ? excerptValue : undefined;

  if (
    !record ||
    typeof id !== "string" ||
    !STABLE_ITEM_ID.test(id) ||
    typeof sourceType !== "string" ||
    !SOURCE_TYPES.has(sourceType as SourceType) ||
    !title ||
    !sourceName ||
    (excerptValue !== undefined && typeof excerptValue !== "string")
  ) {
    throw new Error("Invalid selected item");
  }

  return {
    id,
    sourceType: sourceType as SourceType,
    title,
    sourceName,
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(excerpt ? { excerpt } : {}),
  };
}

function snapshotCachedFullText(
  value: CachedItemContent | null,
  itemId: string,
): string | undefined {
  const record = plainRecord(value);
  if (!record) return undefined;
  const cachedItemId = ownData(record, "itemId");
  const contentBasis = ownData(record, "contentBasis");
  const text = ownData(record, "text");
  return cachedItemId === itemId && contentBasis === "full-text" && typeof text === "string" && text.trim()
    ? text
    : undefined;
}

function snapshotFetchedFullText(
  value: FullArticleFetchResult | undefined,
): string | undefined {
  const record = plainRecord(value);
  if (!record) return undefined;
  const failureType = ownData(record, "failureType");
  const content = ownData(record, "content");
  return failureType === "none" && typeof content === "string" && content.trim()
    ? content
    : undefined;
}

function validateInputLimit(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < AI_CONTENT_OMISSION_MARKER.length + 2
  ) {
    throw new Error("Invalid AI input character limit");
  }
  return value;
}

function boundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string" || value.length > maxLength) return undefined;
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized || undefined;
}

function safeSourceUrl(value: unknown): string | undefined {
  if (
    value === undefined ||
    typeof value !== "string" ||
    value.length > MAX_SOURCE_URL_CHARACTERS ||
    hasControlCharacters(value)
  ) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username ||
      parsed.password
    ) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159))
    ) {
      return true;
    }
  }
  return false;
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    const prototype = Reflect.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null
      ? (value as Record<string, unknown>)
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

function ownOptionalData(
  record: Record<string, unknown> | undefined,
  key: string,
): unknown {
  return ownData(record, key);
}
