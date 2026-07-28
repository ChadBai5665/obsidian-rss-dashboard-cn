import type { AiConnection } from "../ai-types";
import { resolveAiConnectionForRequest } from "../provider-presets";
import {
  ProviderError,
  abortedProviderError,
  malformedProviderResponse,
  providerErrorForStatus,
  providerResponseTooLarge,
} from "./provider-error";
import { FinalTextCollector } from "./final-text-collector";
import { BoundedSseDecoder, type ServerSentEvent } from "./sse-decoder";
import { createNodeAiStreamingTransport } from "./streaming-ai-transport";
import {
  type AiStreamingTransport,
  type AiStreamingTransportResponse,
  type AiTransportRequest,
  denseDataArray,
  hasOwnData,
  optionalUsageInteger,
  outputCharacterLimit,
  ownData,
  plainDataRecord,
  parseBoundedAiJsonText,
  resultWithOptionalMetadata,
  safeProviderRequestId,
  snapshotGenerationRequest,
  type TextDeltaHandler,
  type TextGenerationProvider,
  type TextGenerationRequest,
  type TextGenerationResult,
  validApiKeyValue,
} from "./text-generation-provider";

export type {
  AiStreamingTransport,
  AiTransportRequest,
} from "./text-generation-provider";

export interface AnthropicMessagesProviderOptions {
  connection: AiConnection;
  apiKey: string;
  transport?: AiStreamingTransport;
}

interface AnthropicPrivateState {
  apiKey: string;
  baseUrl: string;
  model: string;
}

interface AnthropicStreamMetadata {
  requestId?: string;
  inputTokens?: number;
  outputTokens?: number;
}

type AnthropicBlockKind = "text" | "hidden";

const PRIVATE_STATE = new WeakMap<
  AnthropicMessagesProvider,
  AnthropicPrivateState
>();
const ANTHROPIC_LIFECYCLE_EVENT_TYPES = new Set([
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
  "message_delta",
  "message_stop",
]);
const parseUnknownJson = JSON.parse as (text: string) => unknown;

export class AnthropicMessagesProvider implements TextGenerationProvider {
  private readonly transport: AiStreamingTransport;

  constructor(options: AnthropicMessagesProviderOptions) {
    const connection = resolveAiConnectionForRequest(options.connection);
    if (!connection || connection.protocol !== "anthropic-messages") {
      throw new ProviderError(
        "invalid-connection",
        "The Anthropic-compatible connection is invalid.",
      );
    }
    const apiKey = validatedApiKey(options.apiKey);
    this.transport = options.transport ?? createNodeAiStreamingTransport({
      timeoutMs: connection.timeoutMs,
    });
    PRIVATE_STATE.set(this, {
      apiKey,
      baseUrl: connection.baseUrl,
      model: connection.model,
    });
  }

  async generate(
    request: TextGenerationRequest,
    onTextDelta?: TextDeltaHandler,
  ): Promise<TextGenerationResult> {
    const snapshot = snapshotGenerationRequest(request);
    if (snapshot.signalWasAborted) throw abortedProviderError();
    const state = requirePrivateState(this);
    const collector = new FinalTextCollector(
      outputCharacterLimit(snapshot.maxOutputTokens),
      state.apiKey,
      onTextDelta,
    );
    const stream = new AnthropicStreamState(collector, state.apiKey);
    let chunkCount = 0;
    let protocolFailure: ProviderError | undefined;
    const response = await invokeStreamingTransport(
      this.transport,
      {
        url: anthropicMessagesUrl(state.baseUrl),
        method: "POST",
        headers: {
          "x-api-key": state.apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: state.model,
          max_tokens: snapshot.maxOutputTokens,
          system: snapshot.system,
          messages: [{ role: "user", content: snapshot.user }],
          stream: true,
        }),
        ...(snapshot.signal ? { signal: snapshot.signal } : {}),
      },
      (chunk) => {
        chunkCount += 1;
        if (protocolFailure) return;
        try {
          stream.push(chunk);
        } catch (error) {
          protocolFailure = safeProtocolFailure(error);
        }
      },
    );
    const safeResponse = snapshotStreamingResponse(response, state.apiKey);
    if (safeResponse.status < 200 || safeResponse.status >= 300) {
      throw providerErrorForStatus(safeResponse.status, safeResponse.requestId);
    }
    if (protocolFailure) throw protocolFailure;

    if (safeResponse.contentType === "application/json") {
      if (chunkCount !== 0 || safeResponse.bodyText === undefined) {
        throw malformedProviderResponse();
      }
      const result = parseAnthropicResult(
        parseJsonFallback(safeResponse.bodyText),
        safeResponse.requestId,
        state.apiKey,
        outputCharacterLimit(snapshot.maxOutputTokens),
      );
      emitSafely(onTextDelta, result.text);
      return result;
    }
    if (
      safeResponse.contentType !== "text/event-stream" ||
      safeResponse.bodyText !== undefined
    ) throw malformedProviderResponse();

    const metadata = stream.finish();
    return resultWithOptionalMetadata(
      collector.finish(),
      metadata.requestId ?? safeResponse.requestId,
      metadata.inputTokens,
      metadata.outputTokens,
    );
  }
}

class AnthropicStreamState {
  private readonly decoder = new BoundedSseDecoder();
  private readonly blocks = new Map<number, AnthropicBlockKind>();
  private messageStarted = false;
  private messageDeltaSeen = false;
  private stopped = false;
  private nextBlockIndex = 0;
  private requestId: string | undefined;
  private inputTokens: number | undefined;
  private outputTokens: number | undefined;

  constructor(
    private readonly collector: FinalTextCollector,
    private readonly apiKey: string,
  ) {}

  push(chunk: Uint8Array): void {
    for (const current of this.decoder.push(chunk)) this.consume(current);
  }

  finish(): AnthropicStreamMetadata {
    for (const current of this.decoder.finish()) this.consume(current);
    if (!this.stopped) throw malformedProviderResponse();
    return {
      ...(this.requestId ? { requestId: this.requestId } : {}),
      ...(this.inputTokens !== undefined ? { inputTokens: this.inputTokens } : {}),
      ...(this.outputTokens !== undefined ? { outputTokens: this.outputTokens } : {}),
    };
  }

  private consume(current: ServerSentEvent): void {
    if (this.stopped) throw malformedProviderResponse();
    const root = plainDataRecord(parseEventJson(current.data));
    if (!root) throw malformedProviderResponse();
    const type = ownData(root, "type");
    if (typeof type !== "string" || (current.event && current.event !== type)) {
      throw malformedProviderResponse();
    }

    if (type === "ping") return;
    if (type === "error") throw anthropicStreamFailure();
    if (type === "message_start") {
      this.consumeMessageStart(root);
      return;
    }
    if (!ANTHROPIC_LIFECYCLE_EVENT_TYPES.has(type)) return;
    if (!this.messageStarted) throw malformedProviderResponse();
    if (type === "content_block_start") {
      this.consumeBlockStart(root);
      return;
    }
    if (type === "content_block_delta") {
      this.consumeBlockDelta(root);
      return;
    }
    if (type === "content_block_stop") {
      this.consumeBlockStop(root);
      return;
    }
    if (type === "message_delta") {
      this.consumeMessageDelta(root);
      return;
    }
    if (type === "message_stop") {
      if (this.blocks.size !== 0) throw malformedProviderResponse();
      this.stopped = true;
      return;
    }
  }

  private consumeMessageStart(root: Record<string, unknown>): void {
    if (this.messageStarted) throw malformedProviderResponse();
    const message = plainDataRecord(ownData(root, "message"));
    if (!message) throw malformedProviderResponse();
    this.captureRequestId(ownData(message, "id"));
    this.captureUsage(message, true);
    this.messageStarted = true;
  }

  private consumeBlockStart(root: Record<string, unknown>): void {
    if (this.messageDeltaSeen) throw malformedProviderResponse();
    const index = blockIndex(root);
    if (index !== this.nextBlockIndex || this.blocks.has(index)) {
      throw malformedProviderResponse();
    }
    const block = plainDataRecord(ownData(root, "content_block"));
    const type = block && ownData(block, "type");
    if (!block || typeof type !== "string") throw malformedProviderResponse();
    const kind: AnthropicBlockKind = type === "text" ? "text" : "hidden";
    this.blocks.set(index, kind);
    this.nextBlockIndex += 1;
    if (kind === "text") {
      const text = ownData(block, "text");
      if (typeof text !== "string") throw malformedProviderResponse();
      if (text.length > 0) this.collector.append(text);
    }
  }

  private consumeBlockDelta(root: Record<string, unknown>): void {
    if (this.messageDeltaSeen) throw malformedProviderResponse();
    const index = blockIndex(root);
    const kind = this.blocks.get(index);
    if (!kind) throw malformedProviderResponse();
    const delta = plainDataRecord(ownData(root, "delta"));
    const type = delta && ownData(delta, "type");
    if (!delta || typeof type !== "string") throw malformedProviderResponse();
    if (kind === "text") {
      if (type !== "text_delta") throw malformedProviderResponse();
      const text = ownData(delta, "text");
      if (typeof text !== "string") throw malformedProviderResponse();
      if (text.length > 0) this.collector.append(text);
    }
  }

  private consumeBlockStop(root: Record<string, unknown>): void {
    if (this.messageDeltaSeen) throw malformedProviderResponse();
    const index = blockIndex(root);
    if (!this.blocks.delete(index)) throw malformedProviderResponse();
  }

  private consumeMessageDelta(root: Record<string, unknown>): void {
    if (this.messageDeltaSeen || this.blocks.size !== 0) {
      throw malformedProviderResponse();
    }
    const delta = plainDataRecord(ownData(root, "delta"));
    if (!delta) throw malformedProviderResponse();
    this.captureUsage(root, false);
    this.messageDeltaSeen = true;
  }

  private captureRequestId(value: unknown): void {
    const next = safeProviderRequestId(value, this.apiKey);
    if (next) this.requestId = next;
  }

  private captureUsage(root: Record<string, unknown>, inputPhase: boolean): void {
    if (!hasOwnData(root, "usage")) return;
    const usage = plainDataRecord(ownData(root, "usage"));
    if (!usage) throw malformedProviderResponse();
    const inputTokens = optionalUsageInteger(usage, "input_tokens");
    const outputTokens = optionalUsageInteger(usage, "output_tokens");
    if (inputTokens === null || outputTokens === null) {
      throw malformedProviderResponse();
    }
    if (inputPhase) {
      if (inputTokens !== undefined) this.inputTokens = inputTokens;
      if (outputTokens !== undefined) this.outputTokens = outputTokens;
    } else {
      if (inputTokens !== undefined && this.inputTokens !== undefined && inputTokens !== this.inputTokens) {
        throw malformedProviderResponse();
      }
      if (inputTokens !== undefined) this.inputTokens = inputTokens;
      if (outputTokens !== undefined) this.outputTokens = outputTokens;
    }
  }
}

function anthropicMessagesUrl(baseUrl: string): string {
  if (baseUrl.endsWith("/v1/messages")) return baseUrl;
  return baseUrl.endsWith("/v1")
    ? `${baseUrl}/messages`
    : `${baseUrl}/v1/messages`;
}

function parseAnthropicResult(
  value: unknown,
  headerRequestId: string | undefined,
  apiKey: string,
  maximumOutputCharacters: number,
): TextGenerationResult {
  const root = plainDataRecord(value);
  if (!root) throw malformedProviderResponse();
  const contentValue = ownData(root, "content");
  const blocks = denseDataArray(contentValue, 10_000);
  if (!blocks) throw malformedProviderResponse();
  if (blocks.length === 0) {
    throw new ProviderError("empty-output", "The AI provider returned no text.");
  }

  const textParts: string[] = [];
  let textCharacters = 0;
  for (const blockValue of blocks) {
    const block = plainDataRecord(blockValue);
    if (!block) throw malformedProviderResponse();
    const type = ownData(block, "type");
    if (typeof type !== "string") throw malformedProviderResponse();
    if (type !== "text") continue;
    const text = ownData(block, "text");
    if (typeof text !== "string") throw malformedProviderResponse();
    textCharacters += text.length;
    if (textCharacters > maximumOutputCharacters) throw providerResponseTooLarge();
    textParts.push(text);
  }
  const text = textParts.join("").trim();
  if (!text || text.includes(apiKey)) {
    throw new ProviderError("empty-output", "The AI provider returned no text.");
  }

  const usagePresent = hasOwnData(root, "usage");
  const usage = usagePresent ? plainDataRecord(ownData(root, "usage")) : undefined;
  if (usagePresent && !usage) throw malformedProviderResponse();
  const inputTokens = optionalUsageInteger(usage, "input_tokens");
  const outputTokens = optionalUsageInteger(usage, "output_tokens");
  if (inputTokens === null || outputTokens === null) throw malformedProviderResponse();

  const bodyRequestId = safeProviderRequestId(ownData(root, "id"), apiKey);
  return resultWithOptionalMetadata(
    text,
    bodyRequestId ?? headerRequestId,
    inputTokens,
    outputTokens,
  );
}

function parseJsonFallback(text: string): unknown {
  return parseBoundedAiJsonText(text);
}

async function invokeStreamingTransport(
  transport: AiStreamingTransport,
  request: AiTransportRequest,
  onChunk: (chunk: Uint8Array) => void,
): Promise<AiStreamingTransportResponse> {
  try {
    return await transport(request, onChunk);
  } catch (error) {
    throw safeTransportFailure(error);
  }
}

function snapshotStreamingResponse(
  value: unknown,
  apiKey: string,
): AiStreamingTransportResponse {
  const root = plainDataRecord(value);
  if (!root) throw malformedProviderResponse();
  const status = ownData(root, "status");
  const contentType = ownData(root, "contentType");
  const bodyText = ownData(root, "bodyText");
  if (
    typeof status !== "number" ||
    !Number.isInteger(status) ||
    status < 100 ||
    status > 599 ||
    typeof contentType !== "string" ||
    (bodyText !== undefined && typeof bodyText !== "string")
  ) throw malformedProviderResponse();
  const result: AiStreamingTransportResponse = {
    status,
    headers: {},
    contentType,
  };
  const requestId = safeProviderRequestId(ownData(root, "requestId"), apiKey);
  if (requestId) result.requestId = requestId;
  if (bodyText !== undefined) result.bodyText = bodyText;
  return result;
}

function safeTransportFailure(error: unknown): ProviderError {
  if (error instanceof ProviderError) {
    if (error.code === "aborted") return abortedProviderError();
    if (error.code === "malformed-response") return malformedProviderResponse();
    if (error.code === "response-too-large") return providerResponseTooLarge();
    if (error.code === "timeout") {
      return new ProviderError("timeout", "The AI provider request timed out.");
    }
    if (error.code === "invalid-request") {
      return new ProviderError("invalid-request", "The AI provider request is invalid.");
    }
  }
  return new ProviderError(
    "network-failure",
    "The AI provider network request failed.",
  );
}

function safeProtocolFailure(error: unknown): ProviderError {
  if (error instanceof ProviderError) {
    if (error.code === "response-too-large") return providerResponseTooLarge();
    if (error.code === "provider-failure") return anthropicStreamFailure();
    if (error.code === "empty-output") {
      return new ProviderError("empty-output", "The AI provider returned no text.");
    }
  }
  return malformedProviderResponse();
}

function anthropicStreamFailure(): ProviderError {
  return new ProviderError(
    "provider-failure",
    "The AI provider is unavailable.",
  );
}

function parseEventJson(text: string): unknown {
  try {
    return parseUnknownJson(text);
  } catch {
    throw malformedProviderResponse();
  }
}

function blockIndex(root: Record<string, unknown>): number {
  const index = ownData(root, "index");
  if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) {
    throw malformedProviderResponse();
  }
  return index;
}

function emitSafely(handler: TextDeltaHandler | undefined, text: string): void {
  if (!handler || text.length === 0) return;
  try {
    handler(text);
  } catch {
    // UI callback failures never affect provider protocol completion.
  }
}

function validatedApiKey(value: unknown): string {
  if (!validApiKeyValue(value)) {
    throw new ProviderError("missing-key", "The AI API key is not configured.");
  }
  return value;
}

function requirePrivateState(
  provider: AnthropicMessagesProvider,
): AnthropicPrivateState {
  const state = PRIVATE_STATE.get(provider);
  if (!state) {
    throw new ProviderError("missing-key", "The AI API key is not configured.");
  }
  return state;
}
