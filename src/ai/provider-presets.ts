import type { AiConnection, AiProtocol, AiProviderKind } from "./ai-types";
import { normalizeAiConnection } from "./connection-validation";

export interface AiProviderPreset {
  providerKind: AiProviderKind;
  protocol: AiProtocol;
  baseUrl?: string;
}

export const AI_PROVIDER_PRESETS = [
  {
    providerKind: "kimi",
    protocol: "openai-chat",
    baseUrl: "https://api.moonshot.cn/v1",
  },
  {
    providerKind: "deepseek",
    protocol: "openai-chat",
    baseUrl: "https://api.deepseek.com",
  },
  {
    providerKind: "qwen",
    protocol: "openai-chat",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  },
  {
    providerKind: "glm",
    protocol: "openai-chat",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
  },
  {
    providerKind: "openai",
    protocol: "openai-chat",
    baseUrl: "https://api.openai.com/v1",
  },
  {
    providerKind: "claude",
    protocol: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
  },
  {
    providerKind: "openai-compatible",
    protocol: "openai-chat",
  },
  {
    providerKind: "anthropic-compatible",
    protocol: "anthropic-messages",
  },
] as const satisfies readonly AiProviderPreset[];

export function getAiProviderPreset(
  providerKind: AiProviderKind,
): AiProviderPreset | undefined {
  return AI_PROVIDER_PRESETS.find(
    (preset) => preset.providerKind === providerKind,
  );
}

export interface CreateAiConnectionInput {
  id: string;
  name: string;
  providerKind: AiProviderKind;
  baseUrl?: string;
  model: string;
}

/** Creates metadata defaults only; callers store the key in DesktopSecretStore. */
export function createAiConnection(
  input: CreateAiConnectionInput,
): AiConnection {
  const preset = getAiProviderPreset(input.providerKind);
  const connection = preset
    ? normalizeAiConnection({
        id: input.id,
        name: input.name,
        providerKind: input.providerKind,
        protocol: preset.protocol,
        baseUrl: preset.baseUrl ?? input.baseUrl,
        model: input.model,
        timeoutMs: 60_000,
        maxInputCharacters: 80_000,
        enabled: true,
      })
    : undefined;
  if (!connection) throw new Error("Invalid AI connection");
  return connection;
}
