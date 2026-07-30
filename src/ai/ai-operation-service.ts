import type {
  AiConnection,
  AiProviderKind,
  AiSettings,
} from "./ai-types";
import {
  normalizeAiConnection,
  normalizeAiSettings,
} from "./connection-validation";
import { resolveAiConnectionForRequest } from "./provider-presets";
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
  TextDeltaHandler,
  TextGenerationProvider,
  TextGenerationResult,
} from "./providers/text-generation-provider";
import { outputCharacterLimit } from "./providers/text-generation-provider";
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

export interface AiOperationPreparedMetadata {
  readonly connectionName: string;
  readonly providerKind: AiProviderKind;
  readonly model: string;
  readonly contentBasis: ContentBasis;
}

export type AiOperationPreparedHandler = (
  metadata: Readonly<AiOperationPreparedMetadata>,
) => void;

export interface AiOperationRunInput {
  operation: AiOperation;
  item: CollectedItem;
  connectionId: string;
  fetchFullText: boolean;
  signal?: AbortSignal;
  onTextDelta?: TextDeltaHandler;
  onPrepared?: AiOperationPreparedHandler;
}

export interface AiPreparedOperationRunInput {
  operation: AiOperation;
  itemId: string;
  connectionId: string;
  connection: AiConnection;
  selectedContent: SelectedAiContent;
  signal?: AbortSignal;
  onTextDelta?: TextDeltaHandler;
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
    const effectiveConnection = resolveAiConnectionForRequest(connection);
    if (!effectiveConnection) throw new AiOperationError("invalid-connection");

    const provider = await this.runStage<TextGenerationProvider>(
      () => this.providerFactory(effectiveConnection, this.secretStore),
      request.signal,
      "provider",
    );
    const selectedContent = await this.runStage<SelectedAiContent>(
      () => this.contentSelector.select({
        item: request.item,
        maxInputCharacters: effectiveConnection.maxInputCharacters,
        fetchFullText: request.fetchFullText,
        ...(request.signal ? { signal: request.signal } : {}),
      }),
      request.signal,
      "selection",
    );
    const prompt = buildPromptSafely(
      request.operation,
      selectedContent,
      effectiveConnection.maxInputCharacters,
    );
    notifyPrepared(request.onPrepared, effectiveConnection, prompt.contentBasis);
    const text = await this.generateText(
      provider,
      prompt,
      request.signal,
      request.onTextDelta,
    );

    return {
      operation: request.operation,
      itemId: selectedContent.itemId,
      connectionId: effectiveConnection.id,
      connectionName: effectiveConnection.name,
      providerKind: effectiveConnection.providerKind,
      model: effectiveConnection.model,
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
    const effectiveConnection = resolveAiConnectionForRequest(connection);
    if (!effectiveConnection) throw new AiOperationError("invalid-connection");
    const prompt = buildPromptSafely(
      request.operation,
      request.selectedContent,
      effectiveConnection.maxInputCharacters,
    );
    const provider = await this.runStage<TextGenerationProvider>(
      () => this.providerFactory(effectiveConnection, this.secretStore),
      request.signal,
      "provider",
    );
    const text = await this.generateText(
      provider,
      prompt,
      request.signal,
      request.onTextDelta,
    );

    return {
      operation: request.operation,
      itemId: request.itemId,
      connectionId: effectiveConnection.id,
      connectionName: effectiveConnection.name,
      providerKind: effectiveConnection.providerKind,
      model: effectiveConnection.model,
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

  private async generateText(
    provider: TextGenerationProvider,
    prompt: ReturnType<typeof buildPromptSafely>,
    signal: AbortSignal | undefined,
    onTextDelta: TextDeltaHandler | undefined,
  ): Promise<string> {
    const forwarder = new SafeTextDeltaForwarder(
      outputCharacterLimit(DEFAULT_MAX_OUTPUT_TOKENS),
      signal,
      onTextDelta,
    );
    let generated: TextGenerationResult;
    try {
      generated = await this.runStage<TextGenerationResult>(
        () => provider.generate({
          system: prompt.system,
          user: prompt.user,
          maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
          ...(signal ? { signal } : {}),
        }, forwarder.handler),
        signal,
        "provider",
      );
    } finally {
      forwarder.stop();
    }
    return safeOutputTextWithDeltaInvariant(generated, forwarder);
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
  onTextDelta?: TextDeltaHandler;
  onPrepared?: AiOperationPreparedHandler;
}

interface PreparedRunInputSnapshot {
  operation: AiOperation;
  itemId: string;
  connectionId: string;
  connection: AiConnection;
  selectedContent: SelectedAiContent;
  signal?: AbortSignal;
  onTextDelta?: TextDeltaHandler;
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
  const onTextDelta = snapshotOptionalTextDelta(record);
  const onPrepared = snapshotOptionalPrepared(record);
  return {
    operation: operation as AiOperation,
    item: item as CollectedItem,
    connectionId,
    fetchFullText,
    ...(signal === undefined ? {} : { signal: signal as AbortSignal }),
    ...(onTextDelta ? { onTextDelta } : {}),
    ...(onPrepared ? { onPrepared } : {}),
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
  const onTextDelta = snapshotOptionalTextDelta(record);
  return {
    operation: operation as AiOperation,
    itemId,
    connectionId,
    connection,
    selectedContent: selectedContent as SelectedAiContent,
    ...(signal === undefined ? {} : { signal: signal as AbortSignal }),
    ...(onTextDelta ? { onTextDelta } : {}),
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

function safeOutputTextWithDeltaInvariant(
  result: TextGenerationResult,
  forwarder: SafeTextDeltaForwarder,
): string {
  forwarder.assertValid();
  let text: string;
  try {
    text = safeOutputText(result);
  } catch (error) {
    if (forwarder.hasDeltas()) {
      throw new AiOperationError("malformed-response");
    }
    throw error;
  }
  forwarder.assertMatches(text);
  return text;
}

class SafeTextDeltaForwarder {
  private readonly chunks: string[] = [];
  private characters = 0;
  private failure: "malformed-response" | "response-too-large" | undefined;
  private terminal = false;

  readonly handler: TextDeltaHandler = (value) => {
    if (this.terminal) return;
    const aborted = this.signal
      ? readTrustedAbortState(this.signal)
      : false;
    if (aborted !== false) {
      this.terminal = true;
      return;
    }
    if (typeof value !== "string" || value.length === 0) {
      this.fail("malformed-response");
      return;
    }
    const nextCharacters = this.characters + value.length;
    if (
      !Number.isSafeInteger(nextCharacters) ||
      nextCharacters > this.maximumCharacters
    ) {
      this.fail("response-too-large");
      return;
    }
    this.characters = nextCharacters;
    this.chunks.push(value);
    if (!this.callback) return;
    try {
      const callbackResult = Reflect.apply(
        this.callback,
        undefined,
        [value],
      ) as unknown;
      consumeCallbackRejection(callbackResult);
    } catch {
      // Caller/UI callback failures cannot change provider completion.
    }
  };

  constructor(
    private readonly maximumCharacters: number,
    private readonly signal: AbortSignal | undefined,
    private readonly callback: TextDeltaHandler | undefined,
  ) {}

  stop(): void {
    this.terminal = true;
  }

  hasDeltas(): boolean {
    return this.chunks.length > 0;
  }

  assertValid(): void {
    if (this.failure) throw new AiOperationError(this.failure);
  }

  assertMatches(text: string): void {
    if (this.chunks.length > 0 && this.chunks.join("") !== text) {
      throw new AiOperationError("malformed-response");
    }
  }

  private fail(code: "malformed-response" | "response-too-large"): void {
    this.failure = code;
    this.terminal = true;
  }
}

function consumeCallbackRejection(value: unknown): void {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) return;
  const assimilated = Promise.resolve(value);
  void Promise.prototype.then.call(
    assimilated,
    undefined,
    () => undefined,
  );
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

function snapshotOptionalTextDelta(
  record: Record<string, unknown> | undefined,
): TextDeltaHandler | undefined {
  if (!record) throw new AiOperationError("invalid-request");
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, "onTextDelta");
    if (!descriptor) {
      if (Reflect.has(record, "onTextDelta")) {
        throw new AiOperationError("invalid-request");
      }
      return undefined;
    }
    if (!("value" in descriptor) || typeof descriptor.value !== "function") {
      throw new AiOperationError("invalid-request");
    }
    return descriptor.value as TextDeltaHandler;
  } catch (error) {
    if (error instanceof AiOperationError) throw error;
    throw new AiOperationError("invalid-request");
  }
}

function snapshotOptionalPrepared(
  record: Record<string, unknown> | undefined,
): AiOperationPreparedHandler | undefined {
  if (!record) throw new AiOperationError("invalid-request");
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, "onPrepared");
    if (!descriptor) {
      if (Reflect.has(record, "onPrepared")) {
        throw new AiOperationError("invalid-request");
      }
      return undefined;
    }
    if (!("value" in descriptor) || typeof descriptor.value !== "function") {
      throw new AiOperationError("invalid-request");
    }
    return descriptor.value as AiOperationPreparedHandler;
  } catch (error) {
    if (error instanceof AiOperationError) throw error;
    throw new AiOperationError("invalid-request");
  }
}

function notifyPrepared(
  observer: AiOperationPreparedHandler | undefined,
  connection: AiConnection,
  contentBasis: ContentBasis,
): void {
  if (!observer) return;
  const metadata: Readonly<AiOperationPreparedMetadata> = Object.freeze({
    connectionName: connection.name,
    providerKind: connection.providerKind,
    model: connection.model,
    contentBasis,
  });
  try {
    const outcome = Reflect.apply(observer, undefined, [metadata]) as unknown;
    consumeCallbackRejection(outcome);
  } catch {
    // Optional observers cannot change provider execution or business results.
  }
}
