import { ANALYSIS_MARKDOWN_PROVENANCE_NOTE } from "./analysis-markdown";
import type { AiProviderKind } from "./ai-types";
import {
  AI_ANALYSIS_CONTENT_BASES,
  AI_ANALYSIS_OPERATIONS,
  AI_ANALYSIS_PROVIDER_KINDS,
  isCanonicalAiAnalysisTimestamp,
  isValidAiAnalysisSourceUrl,
  MAX_AI_ANALYSIS_INPUT_CHARACTER_COUNT,
  MAX_AI_ANALYSIS_METADATA_CHARACTERS,
  MAX_AI_ANALYSIS_TEXT_CHARACTERS,
  safeAnalysisText,
} from "./analysis-result";
import type { AiOperation } from "./prompts/prompt-types";
import type { ContentBasis } from "../collection/collected-item";
import { normalizeConnectionId } from "../security/connection-id";

const STABLE_ITEM_ID = /^[a-f0-9]{64}$/u;
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OPERATIONS: ReadonlySet<string> = new Set(AI_ANALYSIS_OPERATIONS);
const PROVIDER_KINDS: ReadonlySet<string> =
  new Set(AI_ANALYSIS_PROVIDER_KINDS);
const CONTENT_BASES: ReadonlySet<string> =
  new Set(AI_ANALYSIS_CONTENT_BASES);
const FRONTMATTER_PREFIX = "---\n";
const BODY_SEPARATOR =
  `\n---\n\n${ANALYSIS_MARKDOWN_PROVENANCE_NOTE}\n`;
const MAX_COLLISION_INDEX = 10_000;

export interface AiAnalysisArtifact {
  path: string;
  record: Readonly<AiAnalysisHistoryRecord>;
}

export interface AiAnalysisHistoryRecord {
  schemaVersion: 1;
  id: string;
  itemId: string;
  sourceUrl?: string;
  operation: AiOperation;
  createdAt: string;
  connectionId?: string;
  connectionName: string;
  providerKind: AiProviderKind;
  model: string;
  contentBasis: ContentBasis;
  inputCharacterCount: number;
  inputTruncated: boolean;
  text: string;
}

interface ParsedArtifactPath {
  itemId: string;
  operation: AiOperation;
  createdAt: string;
}

/**
 * Parses only the exact schema-v1 Markdown emitted by this repository. Invalid
 * or noncanonical input is data, never an exception.
 */
export function parseAnalysisMarkdown(
  value: unknown,
  pathValue: unknown,
  analysisRootValue: unknown,
): AiAnalysisArtifact | null {
  if (typeof value !== "string") return null;
  const parsedPath = parseArtifactPath(pathValue, analysisRootValue);
  if (!parsedPath) return null;
  try {
    const separatorIndex = value.indexOf(BODY_SEPARATOR);
    if (
      !value.startsWith(FRONTMATTER_PREFIX) ||
      separatorIndex < FRONTMATTER_PREFIX.length
    ) {
      return null;
    }
    const frontmatter = value.slice(
      FRONTMATTER_PREFIX.length,
      separatorIndex,
    );
    const body = value.slice(separatorIndex + BODY_SEPARATOR.length);
    if (!body.endsWith("\n")) return null;
    const text = body.slice(0, -1);
    const lines = frontmatter.split("\n");
    if (lines.length !== 12 && lines.length !== 13) return null;

    let index = 0;
    if (lines[index++] !== "schemaVersion: 1") return null;
    const id = parseCanonicalString(lines[index++], "resultId: ");
    const itemId = parseCanonicalString(lines[index++], "sourceItemId: ");
    const sourceUrl = parseNullableCanonicalString(lines[index++], "sourceUrl: ");
    const operation = parseCanonicalString(lines[index++], "operation: ");
    const createdAt = parseCanonicalString(lines[index++], "createdAt: ");
    const hasConnectionId = lines.length === 13;
    const connectionId = hasConnectionId
      ? parseCanonicalString(lines[index++], "connectionId: ")
      : undefined;
    const connectionName = parseCanonicalString(
      lines[index++],
      "connectionName: ",
    );
    const providerKind = parseCanonicalString(
      lines[index++],
      "providerKind: ",
    );
    const model = parseCanonicalString(lines[index++], "model: ");
    const contentBasis = parseCanonicalString(
      lines[index++],
      "contentBasis: ",
    );
    const inputCharacterCount = parseCanonicalInteger(
      lines[index++],
      "inputCharacterCount: ",
    );
    const inputTruncated = parseCanonicalBoolean(
      lines[index++],
      "inputTruncated: ",
    );

    if (
      index !== lines.length ||
      id === undefined ||
      itemId === undefined ||
      sourceUrl === INVALID ||
      operation === undefined ||
      createdAt === undefined ||
      (hasConnectionId && connectionId === undefined) ||
      connectionName === undefined ||
      providerKind === undefined ||
      model === undefined ||
      contentBasis === undefined ||
      inputCharacterCount === undefined ||
      inputTruncated === undefined ||
      !CANONICAL_UUID.test(id) ||
      !STABLE_ITEM_ID.test(itemId) ||
      itemId !== parsedPath.itemId ||
      (sourceUrl !== undefined && !isValidAiAnalysisSourceUrl(sourceUrl)) ||
      !OPERATIONS.has(operation) ||
      operation !== parsedPath.operation ||
      !isCanonicalAiAnalysisTimestamp(createdAt) ||
      createdAt !== parsedPath.createdAt ||
      (connectionId !== undefined &&
        normalizeConnectionId(connectionId) !== connectionId) ||
      !safeAnalysisText(
        connectionName,
        MAX_AI_ANALYSIS_METADATA_CHARACTERS,
      ) ||
      !PROVIDER_KINDS.has(providerKind) ||
      !safeAnalysisText(model, MAX_AI_ANALYSIS_METADATA_CHARACTERS) ||
      !CONTENT_BASES.has(contentBasis) ||
      inputCharacterCount < 0 ||
      inputCharacterCount > MAX_AI_ANALYSIS_INPUT_CHARACTER_COUNT ||
      !safeAnalysisText(text, MAX_AI_ANALYSIS_TEXT_CHARACTERS)
    ) {
      return null;
    }

    const record: AiAnalysisHistoryRecord = Object.freeze({
      schemaVersion: 1,
      id,
      itemId,
      ...(sourceUrl === undefined ? {} : { sourceUrl }),
      operation,
      createdAt,
      connectionId,
      connectionName,
      providerKind: providerKind as AiProviderKind,
      model,
      contentBasis: contentBasis as ContentBasis,
      inputCharacterCount,
      inputTruncated,
      text,
    });
    return Object.freeze({
      path: pathValue as string,
      record,
    });
  } catch {
    return null;
  }
}

/** Returns the stable item ID only for a canonical repository artifact path. */
export function analysisArtifactPathItemId(
  pathValue: unknown,
  analysisRootValue: unknown,
): string | undefined {
  return parseArtifactPath(pathValue, analysisRootValue)?.itemId;
}

function parseArtifactPath(
  pathValue: unknown,
  analysisRootValue: unknown,
): ParsedArtifactPath | undefined {
  if (
    typeof pathValue !== "string" ||
    typeof analysisRootValue !== "string" ||
    !safeRelativePath(pathValue) ||
    !safeRelativePath(analysisRootValue)
  ) {
    return undefined;
  }
  const prefix = `${analysisRootValue}/`;
  if (!pathValue.startsWith(prefix)) return undefined;
  const relative = pathValue.slice(prefix.length);
  const segments = relative.split("/");
  if (segments.length !== 2) return undefined;
  const [itemId, filename] = segments;
  if (!itemId || !filename || !STABLE_ITEM_ID.test(itemId)) return undefined;

  const timestampMatch = /^(\d{8}T\d{9})-(.+)\.md$/u.exec(filename);
  if (!timestampMatch?.[1] || !timestampMatch[2]) return undefined;
  const timestamp = timestampMatch[1];
  const remainder = timestampMatch[2];
  let operation: AiOperation | undefined;
  let collisionSuffix: string | undefined;
  for (const candidate of AI_ANALYSIS_OPERATIONS) {
    if (remainder === candidate) {
      operation = candidate;
      break;
    }
    if (remainder.startsWith(`${candidate}-`)) {
      operation = candidate;
      collisionSuffix = remainder.slice(candidate.length + 1);
      break;
    }
  }
  if (!operation) return undefined;
  if (collisionSuffix !== undefined) {
    const collisionIndex = Number(collisionSuffix);
    if (
      !Number.isSafeInteger(collisionIndex) ||
      collisionIndex < 2 ||
      collisionIndex > MAX_COLLISION_INDEX ||
      String(collisionIndex) !== collisionSuffix
    ) {
      return undefined;
    }
  }
  const createdAt = timestampToCanonicalUtc(timestamp);
  if (!createdAt) return undefined;
  return { itemId, operation, createdAt };
}

function timestampToCanonicalUtc(value: string): string | undefined {
  const createdAt =
    `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` +
    `T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}` +
    `.${value.slice(15, 18)}Z`;
  return isCanonicalAiAnalysisTimestamp(createdAt) ? createdAt : undefined;
}

function safeRelativePath(value: string): boolean {
  if (
    !value ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    /^[A-Za-z]:/u.test(value)
  ) {
    return false;
  }
  const segments = value.split("/");
  return segments.every(
    (segment) => segment !== "" && segment !== "." && segment !== "..",
  );
}

function parseCanonicalString(
  line: string | undefined,
  prefix: string,
): string | undefined {
  if (!line?.startsWith(prefix)) return undefined;
  const encoded = line.slice(prefix.length);
  try {
    const value = JSON.parse(encoded) as unknown;
    return typeof value === "string" && JSON.stringify(value) === encoded
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

const INVALID = Symbol("invalid-analysis-source-url");

function parseNullableCanonicalString(
  line: string | undefined,
  prefix: string,
): string | undefined | typeof INVALID {
  if (!line?.startsWith(prefix)) return INVALID;
  const encoded = line.slice(prefix.length);
  if (encoded === "null") return undefined;
  return parseCanonicalString(line, prefix) ?? INVALID;
}

function parseCanonicalInteger(
  line: string | undefined,
  prefix: string,
): number | undefined {
  if (!line?.startsWith(prefix)) return undefined;
  const encoded = line.slice(prefix.length);
  if (!/^(0|[1-9]\d*)$/u.test(encoded)) return undefined;
  const value = Number(encoded);
  return Number.isSafeInteger(value) && String(value) === encoded
    ? value
    : undefined;
}

function parseCanonicalBoolean(
  line: string | undefined,
  prefix: string,
): boolean | undefined {
  if (line === `${prefix}true`) return true;
  if (line === `${prefix}false`) return false;
  return undefined;
}
