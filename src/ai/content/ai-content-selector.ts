import type { CollectedItem, ContentBasis, SourceType } from "../../collection/collected-item";
import type { CachedItemContent } from "../../collection/content-repository";
import type { FullArticleFetchResult } from "../../utils/fetch-helpers";
import { htmlToReadableText } from "../../utils/html-text";
import {
  AI_CONTENT_OMISSION_MARKER,
  limitAiContent,
} from "./content-size";

const STABLE_ITEM_ID = /^[a-f0-9]{64}$/u;
const MAX_SOURCE_HTML_CHARACTERS = 1_000_000;
const MAX_SELECTED_CONTENT_CHARACTERS = 1_000_000;
const MAX_TITLE_CHARACTERS = 20_000;
const MAX_SOURCE_NAME_CHARACTERS = 20_000;
const MAX_SOURCE_URL_CHARACTERS = 8_192;
// Invoked only through Reflect.apply with the candidate signal as receiver.
const ABORTED_GETTER = typeof AbortSignal === "undefined"
  ? undefined
  // eslint-disable-next-line @typescript-eslint/unbound-method
  : Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
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

    const cached = await this.readCurrentItemContent(selectedItem.id);
    throwIfAborted(request.signal);
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
  ): Promise<CachedItemContent | null> {
    try {
      return await this.contentRepository.read(itemId);
    } catch {
      return null;
    }
  }

  private async fetchExplicitFullText(
    item: SelectedItemSnapshot,
    signal: AbortSignal | undefined,
  ): Promise<string | undefined> {
    try {
      const result = await this.fullTextFetcher?.({
        itemId: item.id,
        url: item.sourceUrl as string,
        signal,
      });
      throwIfAborted(signal);
      return snapshotFetchedFullText(result);
    } catch {
      throwIfAborted(signal);
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
    MAX_SELECTED_CONTENT_CHARACTERS,
  );
  let limited = limitAiContent(normalized.text, effectiveLimit);

  if (normalized.sourceWasBounded && !limited.truncated) {
    limited = {
      content: limited.content,
      characterCount: limited.characterCount,
      truncated: true,
    };
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
  const executableContentRemoved = rawContent
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, " ")
    .replace(/<(script|style)\b[^>]*>[\s\S]*$/giu, " ");
  const rawLimited = limitAiContent(
    executableContentRemoved,
    MAX_SOURCE_HTML_CHARACTERS,
  );
  const text = htmlToReadableText(rawLimited.content)
    .replace(/\u00a0/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return {
    text,
    sourceWasBounded: rawLimited.truncated,
  };
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
    (signal !== undefined && readAbortState(signal) === undefined)
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
  if (signal && readAbortState(signal)) {
    throw new DOMException("AI content selection cancelled", "AbortError");
  }
}

function readAbortState(value: unknown): boolean | undefined {
  if (!ABORTED_GETTER || typeof value !== "object" || value === null) {
    return undefined;
  }
  try {
    const aborted: unknown = Reflect.apply(ABORTED_GETTER, value, []);
    return typeof aborted === "boolean" ? aborted : undefined;
  } catch {
    return undefined;
  }
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
