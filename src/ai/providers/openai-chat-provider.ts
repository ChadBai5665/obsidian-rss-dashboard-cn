import type { AiConnection } from "../ai-types";
import { normalizeAiConnection } from "../connection-validation";
import { ProviderError, malformedProviderResponse } from "./provider-error";
import {
  type AiTransport,
  denseDataArray,
  hasOwnData,
  obsidianAiTransport,
  optionalUsageInteger,
  outputCharacterLimit,
  ownData,
  performAiRequest,
  plainDataRecord,
  resultWithOptionalMetadata,
  safeProviderRequestId,
  type TextGenerationProvider,
  type TextGenerationRequest,
  type TextGenerationResult,
  validApiKeyValue,
  snapshotGenerationRequest,
} from "./text-generation-provider";

export type { AiTransport, AiTransportRequest } from "./text-generation-provider";

export interface OpenAiChatProviderOptions {
  connection: AiConnection;
  apiKey: string;
  transport?: AiTransport;
  /** Opt-in only. Compatible providers are never probed or retried. */
  supportsStoreFalse?: boolean;
}

interface OpenAiPrivateState {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

const PRIVATE_STATE = new WeakMap<OpenAiChatProvider, OpenAiPrivateState>();

export class OpenAiChatProvider implements TextGenerationProvider {
  private readonly transport: AiTransport;
  private readonly supportsStoreFalse: boolean;

  constructor(options: OpenAiChatProviderOptions) {
    const connection = normalizeAiConnection(options.connection);
    if (!connection || connection.protocol !== "openai-chat") {
      throw new ProviderError(
        "invalid-connection",
        "The OpenAI-compatible connection is invalid.",
      );
    }
    const apiKey = validatedApiKey(options.apiKey);
    this.transport = options.transport ?? obsidianAiTransport;
    this.supportsStoreFalse = options.supportsStoreFalse === true;
    PRIVATE_STATE.set(this, {
      apiKey,
      baseUrl: connection.baseUrl,
      model: connection.model,
      timeoutMs: connection.timeoutMs,
    });
  }

  async generate(
    request: TextGenerationRequest,
  ): Promise<TextGenerationResult> {
    const snapshot = snapshotGenerationRequest(request);
    const state = requirePrivateState(this);
    const body: Record<string, unknown> = {
      model: state.model,
      messages: [
        { role: "system", content: snapshot.system },
        { role: "user", content: snapshot.user },
      ],
      max_tokens: snapshot.maxOutputTokens,
      stream: false,
    };
    if (this.supportsStoreFalse) body.store = false;

    const response = await performAiRequest(
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
      state.timeoutMs,
      state.apiKey,
      snapshot.signalWasAborted,
    );

    return parseOpenAiResult(
      response.json,
      response.requestId,
      state.apiKey,
      outputCharacterLimit(snapshot.maxOutputTokens),
    );
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
  if (text.length > maximumOutputCharacters) {
    throw new ProviderError(
      "response-too-large",
      "The AI provider response exceeded the safe processing limit.",
    );
  }
  if (!text || text.includes(apiKey)) {
    throw new ProviderError("empty-output", "The AI provider returned no text.");
  }

  const usagePresent = hasOwnData(root, "usage");
  const usageValue = ownData(root, "usage");
  const usage = usagePresent ? plainDataRecord(usageValue) : undefined;
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
