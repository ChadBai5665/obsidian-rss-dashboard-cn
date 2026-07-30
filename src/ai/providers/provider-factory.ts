import type { AiConnection, AiProviderKind } from "../ai-types";
import { resolveAiConnectionForRequest } from "../provider-presets";
import type { DesktopSecretStore } from "../../security/desktop-secret-store";
import { AnthropicMessagesProvider } from "./anthropic-messages-provider";
import { OpenAiChatProvider } from "./openai-chat-provider";
import { ProviderError } from "./provider-error";
import type {
  AiStreamingTransport,
  TextGenerationProvider,
} from "./text-generation-provider";
import { validApiKeyValue } from "./text-generation-provider";

export interface AiSecretReader {
  get(connectionId: string): Promise<string | undefined>;
}

export interface ProviderFactoryOptions {
  transport?: AiStreamingTransport;
}

const STORE_FALSE_CAPABLE_PROVIDER_KINDS: ReadonlySet<AiProviderKind> =
  new Set<AiProviderKind>(["openai"]);
const MAX_COMPLETION_TOKEN_PROVIDER_KINDS: ReadonlySet<AiProviderKind> =
  new Set<AiProviderKind>(["minimax-cn", "minimax-global"]);

export async function createTextGenerationProvider(
  connectionValue: AiConnection,
  secretStore: Pick<DesktopSecretStore, "get"> | AiSecretReader,
  options: ProviderFactoryOptions = {},
): Promise<TextGenerationProvider> {
  const connection = resolveAiConnectionForRequest(connectionValue);
  if (!connection) {
    throw new ProviderError(
      "invalid-connection",
      "The AI connection is invalid.",
    );
  }
  if (!connection.enabled) {
    throw new ProviderError(
      "connection-disabled",
      "The AI connection is disabled.",
    );
  }

  let apiKey: string | undefined;
  try {
    apiKey = await secretStore.get(connection.id);
  } catch {
    throw new ProviderError(
      "secret-store-failure",
      "The external AI secret store could not be read.",
    );
  }
  if (!validApiKey(apiKey)) {
    throw new ProviderError("missing-key", "The AI API key is not configured.");
  }

  if (connection.protocol === "openai-chat") {
    return new OpenAiChatProvider({
      connection,
      apiKey,
      ...(options.transport ? { transport: options.transport } : {}),
      supportsStoreFalse: STORE_FALSE_CAPABLE_PROVIDER_KINDS.has(
        connection.providerKind,
      ),
      usesMaxCompletionTokens: MAX_COMPLETION_TOKEN_PROVIDER_KINDS.has(
        connection.providerKind,
      ),
    });
  }
  return new AnthropicMessagesProvider({
    connection,
    apiKey,
    ...(options.transport ? { transport: options.transport } : {}),
  });
}

function validApiKey(value: unknown): value is string {
  return validApiKeyValue(value);
}
