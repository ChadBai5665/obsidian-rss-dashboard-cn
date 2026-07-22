import type { AiConnection } from "../ai-types";
import { normalizeAiConnection } from "../connection-validation";
import { ProviderError, malformedProviderResponse } from "./provider-error";
import {
  type AiTransport,
  denseDataArray,
  hasOwnData,
  obsidianAiTransport,
  optionalUsageInteger,
  ownData,
  performAiRequest,
  plainDataRecord,
  resultWithOptionalMetadata,
  safeProviderRequestId,
  type TextGenerationProvider,
  type TextGenerationRequest,
  type TextGenerationResult,
  validApiKeyValue,
  validateGenerationRequest,
} from "./text-generation-provider";

export type { AiTransport, AiTransportRequest } from "./text-generation-provider";

export interface AnthropicMessagesProviderOptions {
  connection: AiConnection;
  apiKey: string;
  transport?: AiTransport;
}

interface AnthropicPrivateState {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

const PRIVATE_STATE = new WeakMap<
  AnthropicMessagesProvider,
  AnthropicPrivateState
>();

export class AnthropicMessagesProvider implements TextGenerationProvider {
  private readonly transport: AiTransport;

  constructor(options: AnthropicMessagesProviderOptions) {
    const connection = normalizeAiConnection(options.connection);
    if (!connection || connection.protocol !== "anthropic-messages") {
      throw new ProviderError(
        "invalid-connection",
        "The Anthropic-compatible connection is invalid.",
      );
    }
    const apiKey = validatedApiKey(options.apiKey);
    this.transport = options.transport ?? obsidianAiTransport;
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
    validateGenerationRequest(request);
    const state = requirePrivateState(this);
    const response = await performAiRequest(
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
          max_tokens: request.maxOutputTokens,
          system: request.system,
          messages: [{ role: "user", content: request.user }],
        }),
        ...(request.signal ? { signal: request.signal } : {}),
      },
      state.timeoutMs,
      state.apiKey,
    );
    return parseAnthropicResult(
      response.json,
      response.requestId,
      state.apiKey,
    );
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
): TextGenerationResult {
  const root = plainDataRecord(value);
  if (!root) throw malformedProviderResponse();
  const blocks = denseDataArray(ownData(root, "content"), 100_000);
  if (!blocks) throw malformedProviderResponse();
  if (blocks.length === 0) {
    throw new ProviderError("empty-output", "The AI provider returned no text.");
  }

  const textParts: string[] = [];
  for (const blockValue of blocks) {
    const block = plainDataRecord(blockValue);
    if (!block) throw malformedProviderResponse();
    const type = ownData(block, "type");
    if (typeof type !== "string") throw malformedProviderResponse();
    if (type !== "text") continue;
    const text = ownData(block, "text");
    if (typeof text !== "string") throw malformedProviderResponse();
    textParts.push(text);
  }
  const text = textParts.join("").trim();
  if (!text || text.includes(apiKey)) {
    throw new ProviderError("empty-output", "The AI provider returned no text.");
  }

  const usagePresent = hasOwnData(root, "usage");
  const usageValue = ownData(root, "usage");
  const usage = usagePresent ? plainDataRecord(usageValue) : undefined;
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
