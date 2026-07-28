import type { AiConnection } from "../ai-types";
import { resolveAiConnectionForRequest } from "../provider-presets";
import {
  ProviderError,
  abortedProviderError,
  malformedProviderResponse,
  providerErrorForStatus,
  providerResponseTooLarge,
} from "./provider-error";
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

export interface OpenAiChatProviderOptions {
  connection: AiConnection;
  apiKey: string;
  transport?: AiStreamingTransport;
  /** Opt-in only. Compatible providers are never probed or retried. */
  supportsStoreFalse?: boolean;
  usesMaxCompletionTokens?: boolean;
}

interface OpenAiPrivateState {
  apiKey: string;
  baseUrl: string;
  model: string;
  usesMaxCompletionTokens: boolean;
}

interface OpenAiStreamMetadata {
  requestId?: string;
  inputTokens?: number;
  outputTokens?: number;
}

const PRIVATE_STATE = new WeakMap<OpenAiChatProvider, OpenAiPrivateState>();
const parseUnknownJson = JSON.parse as (text: string) => unknown;

export class OpenAiChatProvider implements TextGenerationProvider {
  private readonly transport: AiStreamingTransport;
  private readonly supportsStoreFalse: boolean;

  constructor(options: OpenAiChatProviderOptions) {
    const connection = resolveAiConnectionForRequest(options.connection);
    if (!connection || connection.protocol !== "openai-chat") {
      throw new ProviderError(
        "invalid-connection",
        "The OpenAI-compatible connection is invalid.",
      );
    }
    const apiKey = validatedApiKey(options.apiKey);
    this.transport = options.transport ?? createNodeAiStreamingTransport({
      timeoutMs: connection.timeoutMs,
    });
    this.supportsStoreFalse = options.supportsStoreFalse === true;
    PRIVATE_STATE.set(this, {
      apiKey,
      baseUrl: connection.baseUrl,
      model: connection.model,
      usesMaxCompletionTokens: options.usesMaxCompletionTokens === true,
    });
  }

  async generate(
    request: TextGenerationRequest,
    onTextDelta?: TextDeltaHandler,
  ): Promise<TextGenerationResult> {
    const snapshot = snapshotGenerationRequest(request);
    if (snapshot.signalWasAborted) throw abortedProviderError();
    const state = requirePrivateState(this);
    const body: Record<string, unknown> = {
      model: state.model,
      messages: [
        { role: "system", content: snapshot.system },
        { role: "user", content: snapshot.user },
      ],
      stream: true,
    };
    body[state.usesMaxCompletionTokens
      ? "max_completion_tokens"
      : "max_tokens"] = snapshot.maxOutputTokens;
    if (this.supportsStoreFalse) body.store = false;

    const collector = new FinalTextCollector(
      outputCharacterLimit(snapshot.maxOutputTokens),
      state.apiKey,
      onTextDelta,
    );
    const stream = new OpenAiStreamState(collector, state.apiKey);
    let chunkCount = 0;
    let protocolFailure: ProviderError | undefined;
    const response = await invokeStreamingTransport(
      this.transport,
      {
        url: `${state.baseUrl}/chat/completions`,
        method: "POST",
        headers: {
          Authorization: `Bearer ${state.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
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
      const result = parseOpenAiResult(
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

class OpenAiStreamState {
  private readonly decoder = new BoundedSseDecoder();
  private done = false;
  private finishSeen = false;
  private usageSeen = false;
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

  finish(): OpenAiStreamMetadata {
    for (const current of this.decoder.finish()) this.consume(current);
    if (!this.done) throw malformedProviderResponse();
    return {
      ...(this.requestId ? { requestId: this.requestId } : {}),
      ...(this.inputTokens !== undefined ? { inputTokens: this.inputTokens } : {}),
      ...(this.outputTokens !== undefined ? { outputTokens: this.outputTokens } : {}),
    };
  }

  private consume(current: ServerSentEvent): void {
    if (this.done) throw malformedProviderResponse();
    if (current.data === "[DONE]") {
      this.done = true;
      return;
    }
    const root = plainDataRecord(parseEventJson(current.data));
    if (!root) throw malformedProviderResponse();
    this.captureRequestId(ownData(root, "id"));
    this.captureUsage(root);

    const choices = denseDataArray(ownData(root, "choices"), 2);
    if (!choices || choices.length > 1) throw malformedProviderResponse();
    if (choices.length === 0) {
      if (!this.usageSeen) throw malformedProviderResponse();
      return;
    }
    const choice = plainDataRecord(choices[0]);
    if (!choice) throw malformedProviderResponse();
    const index = ownData(choice, "index");
    if (index !== undefined && index !== 0) throw malformedProviderResponse();
    const delta = plainDataRecord(ownData(choice, "delta"));
    if (!delta) throw malformedProviderResponse();
    const role = ownData(delta, "role");
    if (role !== undefined && role !== "assistant") {
      throw malformedProviderResponse();
    }
    const contentPresent = hasOwnData(delta, "content");
    const content = ownData(delta, "content");
    if (contentPresent && content !== null && typeof content !== "string") {
      throw malformedProviderResponse();
    }
    if (typeof content === "string" && content.length > 0) {
      if (this.finishSeen) throw malformedProviderResponse();
      this.collector.append(content);
    }

    const finishPresent = hasOwnData(choice, "finish_reason");
    const finishReason = ownData(choice, "finish_reason");
    if (finishPresent && finishReason !== null) {
      if (typeof finishReason !== "string" || !finishReason || this.finishSeen) {
        throw malformedProviderResponse();
      }
      this.finishSeen = true;
    }
  }

  private captureRequestId(value: unknown): void {
    const next = safeProviderRequestId(value, this.apiKey);
    if (!next) return;
    if (this.requestId !== undefined && this.requestId !== next) {
      throw malformedProviderResponse();
    }
    this.requestId = next;
  }

  private captureUsage(root: Record<string, unknown>): void {
    if (!hasOwnData(root, "usage")) return;
    if (this.usageSeen) throw malformedProviderResponse();
    const usage = plainDataRecord(ownData(root, "usage"));
    if (!usage) throw malformedProviderResponse();
    const inputTokens = optionalUsageInteger(usage, "prompt_tokens");
    const outputTokens = optionalUsageInteger(usage, "completion_tokens");
    if (inputTokens === null || outputTokens === null) {
      throw malformedProviderResponse();
    }
    this.usageSeen = true;
    this.inputTokens = inputTokens;
    this.outputTokens = outputTokens;
  }
}

class FinalTextCollector {
  private value = "";
  private pending = "";

  constructor(
    private readonly maximum: number,
    private readonly apiKey: string,
    private readonly onTextDelta?: TextDeltaHandler,
  ) {}

  append(delta: string): void {
    const nextLength = this.value.length + delta.length;
    if (!Number.isSafeInteger(nextLength) || nextLength > this.maximum) {
      throw providerResponseTooLarge();
    }
    this.value += delta;
    this.pending += delta;
    if (this.value.includes(this.apiKey)) {
      throw new ProviderError("empty-output", "The AI provider returned no text.");
    }
    const hold = Math.max(0, this.apiKey.length - 1);
    const emitLength = Math.max(0, this.pending.length - hold);
    if (emitLength > 0) {
      emitSafely(this.onTextDelta, this.pending.slice(0, emitLength));
      this.pending = this.pending.slice(emitLength);
    }
  }

  finish(): string {
    emitSafely(this.onTextDelta, this.pending);
    this.pending = "";
    const text = this.value.trim();
    if (!text) {
      throw new ProviderError("empty-output", "The AI provider returned no text.");
    }
    return text;
  }
}

function parseOpenAiResult(
  value: unknown,
  headerRequestId: string | undefined,
  apiKey: string,
  maximumOutputCharacters: number,
): TextGenerationResult {
  const root = plainDataRecord(value);
  if (!root) throw malformedProviderResponse();
  const choices = denseDataArray(ownData(root, "choices"), 10_000);
  if (!choices) throw malformedProviderResponse();
  if (choices.length === 0) {
    throw new ProviderError("empty-output", "The AI provider returned no text.");
  }
  const choice = plainDataRecord(choices[0]);
  const message = choice && plainDataRecord(ownData(choice, "message"));
  const content = message && ownData(message, "content");
  if (typeof content !== "string") throw malformedProviderResponse();
  const text = content.trim();
  if (text.length > maximumOutputCharacters) throw providerResponseTooLarge();
  if (!text || text.includes(apiKey)) {
    throw new ProviderError("empty-output", "The AI provider returned no text.");
  }

  const usagePresent = hasOwnData(root, "usage");
  const usage = usagePresent ? plainDataRecord(ownData(root, "usage")) : undefined;
  if (usagePresent && !usage) throw malformedProviderResponse();
  const inputTokens = optionalUsageInteger(usage, "prompt_tokens");
  const outputTokens = optionalUsageInteger(usage, "completion_tokens");
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
    if (error.code === "empty-output") {
      return new ProviderError("empty-output", "The AI provider returned no text.");
    }
  }
  return malformedProviderResponse();
}

function parseEventJson(text: string): unknown {
  try {
    return parseUnknownJson(text);
  } catch {
    throw malformedProviderResponse();
  }
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

function requirePrivateState(provider: OpenAiChatProvider): OpenAiPrivateState {
  const state = PRIVATE_STATE.get(provider);
  if (!state) {
    throw new ProviderError("missing-key", "The AI API key is not configured.");
  }
  return state;
}
