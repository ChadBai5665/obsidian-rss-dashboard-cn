import type { AiProviderKind } from "./ai-types";
import type { AiOperation } from "./prompts/prompt-types";
import type { ContentBasis } from "../collection/collected-item";
import { normalizeConnectionId } from "../security/connection-id";

const STABLE_ITEM_ID = /^[a-f0-9]{64}$/u;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OPERATIONS = new Set<AiOperation>([
  "summary",
  "translate-zh-cn",
  "core-points",
  "deep-analysis",
]);
const PROVIDER_KINDS = new Set<AiProviderKind>([
  "kimi",
  "deepseek",
  "qwen",
  "glm",
  "openai",
  "claude",
  "minimax-cn",
  "minimax-global",
  "openai-compatible",
  "anthropic-compatible",
]);
const CONTENT_BASES = new Set<ContentBasis>([
  "feed",
  "full-text",
  "youtube-transcript",
  "title-description",
  "x-post",
  "linked-page",
]);
const MAX_METADATA_CHARACTERS = 20_000;
const MAX_SOURCE_URL_CHARACTERS = 8_192;
const MAX_ANALYSIS_TEXT_CHARACTERS = 1_000_000;
const MAX_INPUT_CHARACTER_COUNT = 1_000_000;

export interface AiAnalysisResult {
  schemaVersion: 1;
  id: string;
  itemId: string;
  sourceUrl?: string;
  operation: AiOperation;
  createdAt: string;
  connectionId: string;
  connectionName: string;
  providerKind: AiProviderKind;
  model: string;
  contentBasis: ContentBasis;
  inputCharacterCount: number;
  inputTruncated: boolean;
  text: string;
}

/**
 * Copies only durable, non-secret fields from an untrusted caller. The copy also
 * prevents a later caller mutation from changing a file while it is being saved.
 */
export function snapshotAiAnalysisResult(value: unknown): AiAnalysisResult {
  const record = plainRecord(value);
  const schemaVersion = ownData(record, "schemaVersion");
  const id = ownData(record, "id");
  const itemId = ownData(record, "itemId");
  const sourceUrl = ownOptionalData(record, "sourceUrl");
  const operation = ownData(record, "operation");
  const createdAt = ownData(record, "createdAt");
  const connectionId = ownData(record, "connectionId");
  const connectionName = ownData(record, "connectionName");
  const providerKind = ownData(record, "providerKind");
  const model = ownData(record, "model");
  const contentBasis = ownData(record, "contentBasis");
  const inputCharacterCount = ownData(record, "inputCharacterCount");
  const inputTruncated = ownData(record, "inputTruncated");
  const text = ownData(record, "text");

  if (typeof text === "string" && !text.trim()) {
    throw new Error("AI analysis output must not be empty");
  }
  if (
    !record ||
    schemaVersion !== 1 ||
    typeof id !== "string" ||
    !CANONICAL_UUID.test(id) ||
    typeof itemId !== "string" ||
    !STABLE_ITEM_ID.test(itemId) ||
    (sourceUrl !== undefined && !validSourceUrl(sourceUrl)) ||
    typeof operation !== "string" ||
    !OPERATIONS.has(operation as AiOperation) ||
    typeof createdAt !== "string" ||
    !isCanonicalUtcTimestamp(createdAt) ||
    typeof connectionId !== "string" ||
    normalizeConnectionId(connectionId) !== connectionId ||
    !safeText(connectionName, MAX_METADATA_CHARACTERS) ||
    typeof providerKind !== "string" ||
    !PROVIDER_KINDS.has(providerKind as AiProviderKind) ||
    !safeText(model, MAX_METADATA_CHARACTERS) ||
    typeof contentBasis !== "string" ||
    !CONTENT_BASES.has(contentBasis as ContentBasis) ||
    typeof inputCharacterCount !== "number" ||
    !Number.isSafeInteger(inputCharacterCount) ||
    inputCharacterCount < 0 ||
    inputCharacterCount > MAX_INPUT_CHARACTER_COUNT ||
    typeof inputTruncated !== "boolean" ||
    !safeText(text, MAX_ANALYSIS_TEXT_CHARACTERS)
  ) {
    throw new Error("Invalid AI analysis result");
  }

  return {
    schemaVersion: 1,
    id,
    itemId,
    ...(sourceUrl === undefined ? {} : { sourceUrl }),
    operation: operation as AiOperation,
    createdAt,
    connectionId,
    connectionName,
    providerKind: providerKind as AiProviderKind,
    model,
    contentBasis: contentBasis as ContentBasis,
    inputCharacterCount,
    inputTruncated,
    text,
  };
}

function isCanonicalUtcTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    return false;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function validSourceUrl(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > MAX_SOURCE_URL_CHARACTERS ||
    /\s/u.test(value) ||
    hasDangerousControlOrInvalidUnicode(value) ||
    value.includes("\\")
  ) {
    return false;
  }

  const rawPath = /^https?:\/\/[^/?#]*(\/[^?#]*)?/iu.exec(value)?.[1] ?? "";
  let decodedPath = rawPath;
  let fullyDecoded = false;
  try {
    for (let index = 0; index < 16; index += 1) {
      const decoded = decodeURIComponent(decodedPath);
      if (decoded === decodedPath) {
        fullyDecoded = true;
        break;
      }
      decodedPath = decoded;
    }
  } catch {
    return false;
  }
  if (
    !fullyDecoded ||
    /\s/u.test(decodedPath) ||
    decodedPath.includes("\\") ||
    hasDangerousControlOrInvalidUnicode(decodedPath) ||
    decodedPath.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    return false;
  }

  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function safeText(value: unknown, maxCharacters: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxCharacters &&
    Boolean(value.trim()) &&
    !hasDangerousControlOrInvalidUnicode(value)
  );
}

function hasDangerousControlOrInvalidUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (
      (codeUnit <= 31 && codeUnit !== 9 && codeUnit !== 10 && codeUnit !== 13) ||
      (codeUnit >= 127 && codeUnit <= 159)
    ) {
      return true;
    }
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
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

function ownOptionalData(
  record: Record<string, unknown> | undefined,
  key: string,
): unknown {
  return ownData(record, key);
}
