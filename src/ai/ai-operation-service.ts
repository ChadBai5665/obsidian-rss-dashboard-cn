import type {
  AiConnection,
  AiProviderKind,
  AiSettings,
} from "./ai-types";
import {
  normalizeAiConnection,
  normalizeAiSettings,
} from "./connection-validation";
import type {
  AiContentSelector,
  SelectedAiContent,
} from "./content/ai-content-selector";
import type { AiSecretReader } from "./providers/provider-factory";
import { createTextGenerationProvider } from "./providers/provider-factory";
import {
  ProviderError,
  type ProviderErrorCode,
} from "./providers/provider-error";
import type {
  TextGenerationProvider,
  TextGenerationResult,
} from "./providers/text-generation-provider";
import { buildAiPrompt } from "./prompts/prompt-builder";
import type { AiOperation } from "./prompts/prompt-types";
import {
  raceWithTrustedAbort,
  readTrustedAbortState,
} from "./trusted-abort";
import type { CollectedItem, ContentBasis } from "../collection/collected-item";
import { normalizeConnectionId } from "../security/connection-id";

const AI_OPERATIONS = new Set<AiOperation>([
  "summary",
  "translate-zh-cn",
  "core-points",
  "deep-analysis",
]);
const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;

export type AiOperationErrorCode =
  | ProviderErrorCode
  | "connection-not-found"
  | "invalid-operation"
  | "selection-failed";

const ERROR_MESSAGES: Readonly<Record<AiOperationErrorCode, string>> =
  Object.freeze({
    "missing-key": "The AI API key is not configured.",
    "invalid-connection": "The AI connection is invalid.",
    "connection-disabled": "The AI connection is disabled.",
    "invalid-request": "The AI operation request is invalid.",
    "invalid-key": "AI provider authentication failed.",
    "insufficient-balance": "The AI provider account balance is insufficient.",
    timeout: "The AI provider request timed out.",
    "rate-limited": "The AI provider rate limit was reached.",
    "provider-failure": "The AI provider is unavailable.",
    "provider-rejected": "The AI provider rejected the request.",
    "network-failure": "The AI provider network request failed.",
    aborted: "The AI operation was cancelled.",
    "malformed-response": "The AI provider returned an invalid response.",
    "response-too-large": "The AI provider response exceeded the safe limit.",
    "empty-output": "The AI provider returned no usable text.",
    "secret-store-failure": "The external AI secret store could not be read.",
    "connection-not-found": "The selected AI connection was not found.",
    "invalid-operation": "The selected AI operation is invalid.",
    "selection-failed": "The selected item content could not be prepared.",
  });

/** A static public projection: no provider envelope, headers, or secret text. */
export class AiOperationError extends Error {
  constructor(readonly code: AiOperationErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "AiOperationError";
  }
}

export interface AiOperationResult {
  operation: AiOperation;
  itemId: string;
  connectionId: string;
  connectionName: string;
  providerKind: AiProviderKind;
  model: string;
  contentBasis: ContentBasis;
  inputCharacterCount: number;
  inputTruncated: boolean;
  text: string;
}

export interface AiOperationRunInput {
  operation: AiOperation;
  item: CollectedItem;
  connectionId: string;
  fetchFullText: boolean;
  signal?: AbortSignal;
}

export interface AiPreparedOperationRunInput {
  operation: AiOperation;
  itemId: string;
  connectionId: string;
  connection: AiConnection;
  selectedContent: SelectedAiContent;
  signal?: AbortSignal;
}

export type AiOperationProviderFactory = (
  connection: AiConnection,
  secretStore: AiSecretReader,
) => Promise<TextGenerationProvider>;

export interface AiOperationServiceDependencies {
  getAiSettings: () => AiSettings;
  secretStore: AiSecretReader;
  contentSelector: Pick<AiContentSelector, "select">;
  providerFactory?: AiOperationProviderFactory;
}

/** Manual-only orchestration. This service exposes no refresh, import, save, or timer hook. */
export class AiOperationService {
  private readonly getAiSettings: () => AiSettings;
  private readonly secretStore: AiSecretReader;
  private readonly contentSelector: Pick<AiContentSelector, "select">;
  private readonly providerFactory: AiOperationProviderFactory;

  constructor(dependencies: AiOperationServiceDependencies) {
    this.getAiSettings = dependencies.getAiSettings;
    this.secretStore = dependencies.secretStore;
    this.contentSelector = dependencies.contentSelector;
    this.providerFactory = dependencies.providerFactory ?? createTextGenerationProvider;
  }

  async run(input: AiOperationRunInput): Promise<AiOperationResult> {
    const request = snapshotRunInput(input);
    const connection = this.selectedConnection(request.connectionId);

    const provider = await this.runStage<TextGenerationProvider>(
      () => this.providerFactory(connection, this.secretStore),
      request.signal,
      "provider",
    );
    const selectedContent = await this.runStage<SelectedAiContent>(
      () => this.contentSelector.select({
        item: request.item,
        maxInputCharacters: connection.maxInputCharacters,
        fetchFullText: request.fetchFullText,
        ...(request.signal ? { signal: request.signal } : {}),
      }),
      request.signal,
      "selection",
    );
    const prompt = buildPromptSafely(
      request.operation,
      selectedContent,
      connection.maxInputCharacters,
    );
    const generated = await this.runStage<TextGenerationResult>(
      () => provider.generate({
        system: prompt.system,
        user: prompt.user,
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        ...(request.signal ? { signal: request.signal } : {}),
      }),
      request.signal,
      "provider",
    );
    const text = safeOutputText(generated);

    return {
      operation: request.operation,
      itemId: selectedContent.itemId,
      connectionId: connection.id,
      connectionName: connection.name,
      providerKind: connection.providerKind,
      model: connection.model,
      contentBasis: prompt.contentBasis,
      inputCharacterCount: prompt.inputCharacterCount,
      inputTruncated: prompt.inputTruncated,
      text,
    };
  }

  /** Sends the already-previewed content snapshot without selecting again. */
  async runPrepared(
    input: AiPreparedOperationRunInput,
  ): Promise<AiOperationResult> {
    const request = snapshotPreparedRunInput(input);
    const connection = this.selectedConnection(request.connectionId);
    if (!sameConnection(connection, request.connection)) {
      throw new AiOperationError("invalid-connection");
    }
    const prompt = buildPromptSafely(
      request.operation,
      request.selectedContent,
      connection.maxInputCharacters,
    );
    const provider = await this.runStage<TextGenerationProvider>(
      () => this.providerFactory(connection, this.secretStore),
      request.signal,
      "provider",
    );
    const generated = await this.runStage<TextGenerationResult>(
      () => provider.generate({
        system: prompt.system,
        user: prompt.user,
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        ...(request.signal ? { signal: request.signal } : {}),
      }),
      request.signal,
      "provider",
    );
    const text = safeOutputText(generated);

    return {
      operation: request.operation,
      itemId: request.itemId,
      connectionId: connection.id,
      connectionName: connection.name,
      providerKind: connection.providerKind,
      model: connection.model,
      contentBasis: prompt.contentBasis,
      inputCharacterCount: prompt.inputCharacterCount,
      inputTruncated: prompt.inputTruncated,
      text,
    };
  }

  private selectedConnection(connectionId: string): AiConnection {
    let settings: AiSettings;
    try {
      settings = normalizeAiSettings(this.getAiSettings());
    } catch {
      throw new AiOperationError("connection-not-found");
    }
    const connection = settings.connections.find(({ id }) => id === connectionId);
    if (!connection) throw new AiOperationError("connection-not-found");
    return connection;
  }

  private async runStage<T>(
    start: () => unknown,
    signal: AbortSignal | undefined,
    stage: "selection" | "provider",
  ): Promise<T> {
    try {
      return await raceWithTrustedAbort<T>(start, {
        signal,
        createAbortError: () => new AiOperationError("aborted"),
        createInvalidSignalError: () => new AiOperationError("invalid-request"),
      });
    } catch (error) {
      throw publicOperationError(error, stage);
    }
  }
}

interface RunInputSnapshot {
  operation: AiOperation;
  item: CollectedItem;
  connectionId: string;
  fetchFullText: boolean;
  signal?: AbortSignal;
}

interface PreparedRunInputSnapshot {
  operation: AiOperation;
  itemId: string;
  connectionId: string;
  connection: AiConnection;
  selectedContent: SelectedAiContent;
  signal?: AbortSignal;
}

function snapshotRunInput(input: AiOperationRunInput): RunInputSnapshot {
  const record = plainRecord(input);
  const operation = ownData(record, "operation");
  const item = ownData(record, "item");
  const rawConnectionId = ownData(record, "connectionId");
  const fetchFullText = ownData(record, "fetchFullText");
  const signal = ownOptionalData(record, "signal");
  if (typeof operation !== "string" || !AI_OPERATIONS.has(operation as AiOperation)) {
    throw new AiOperationError("invalid-operation");
  }
  const connectionId = normalizeConnectionId(rawConnectionId);
  if (!connectionId) throw new AiOperationError("connection-not-found");
  if (
    !record ||
    typeof item !== "object" ||
    item === null ||
    typeof fetchFullText !== "boolean" ||
    (signal !== undefined && readTrustedAbortState(signal) === undefined)
  ) throw new AiOperationError("invalid-request");
  return {
    operation: operation as AiOperation,
    item: item as CollectedItem,
    connectionId,
    fetchFullText,
    ...(signal === undefined ? {} : { signal: signal as AbortSignal }),
  };
}

function snapshotPreparedRunInput(
  input: AiPreparedOperationRunInput,
): PreparedRunInputSnapshot {
  const record = plainRecord(input);
  const operation = ownData(record, "operation");
  const itemId = ownData(record, "itemId");
  const rawConnectionId = ownData(record, "connectionId");
  const connection = normalizeAiConnection(ownData(record, "connection"));
  const selectedContent = ownData(record, "selectedContent");
  const signal = ownOptionalData(record, "signal");
  const selectedRecord = plainRecord(selectedContent);
  if (
    typeof operation !== "string" ||
    !AI_OPERATIONS.has(operation as AiOperation) ||
    typeof itemId !== "string" ||
    !/^[a-f0-9]{64}$/u.test(itemId) ||
    !connection ||
    ownData(selectedRecord, "itemId") !== itemId ||
    (signal !== undefined && readTrustedAbortState(signal) === undefined)
  ) {
    throw new AiOperationError("selection-failed");
  }
  const connectionId = normalizeConnectionId(rawConnectionId);
  if (!connectionId || connection.id !== connectionId) {
    throw new AiOperationError("connection-not-found");
  }
  return {
    operation: operation as AiOperation,
    itemId,
    connectionId,
    connection,
    selectedContent: selectedContent as SelectedAiContent,
    ...(signal === undefined ? {} : { signal: signal as AbortSignal }),
  };
}

function sameConnection(left: AiConnection, right: AiConnection): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.providerKind === right.providerKind &&
    left.protocol === right.protocol &&
    left.baseUrl === right.baseUrl &&
    left.model === right.model &&
    left.timeoutMs === right.timeoutMs &&
    left.maxInputCharacters === right.maxInputCharacters &&
    left.enabled === right.enabled
  );
}

function buildPromptSafely(
  operation: AiOperation,
  selectedContent: SelectedAiContent,
  maxContentCharacters: number,
) {
  try {
    return buildAiPrompt({ operation, selectedContent, maxContentCharacters });
  } catch {
    throw new AiOperationError("selection-failed");
  }
}

function safeOutputText(result: TextGenerationResult): string {
  const record = plainRecord(result);
  const text = ownData(record, "text");
  if (typeof text !== "string" || !text.trim()) {
    throw new AiOperationError("empty-output");
  }
  return text;
}

function publicOperationError(
  error: unknown,
  stage: "selection" | "provider",
): AiOperationError {
  if (error instanceof AiOperationError) return error;
  if (error instanceof ProviderError) return new AiOperationError(error.code);
  if (isAbortError(error)) return new AiOperationError("aborted");
  return new AiOperationError(
    stage === "selection" ? "selection-failed" : "provider-failure",
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
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
  if (!record) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return !descriptor || !("value" in descriptor) ? undefined : descriptor.value;
  } catch {
    return undefined;
  }
}
