import type { AiConnection, AiProtocol, AiProviderKind } from "./ai-types";
import { normalizeAiConnection } from "./connection-validation";

export interface AiProviderPreset {
  providerKind: AiProviderKind;
  protocol: AiProtocol;
  baseUrl?: string;
  defaultModel?: string;
}

const CANONICAL_PROVIDER_PRESETS = Object.freeze([
  {
    providerKind: "kimi",
    protocol: "openai-chat",
    baseUrl: "https://api.moonshot.cn/v1",
    defaultModel: "kimi-latest",
  },
  {
    providerKind: "deepseek",
    protocol: "openai-chat",
    baseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-v4-pro",
  },
  {
    providerKind: "qwen",
    protocol: "openai-chat",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen3.7-plus",
  },
  {
    providerKind: "glm",
    protocol: "openai-chat",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-5.2",
  },
  {
    providerKind: "openai",
    protocol: "openai-chat",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-5.6",
  },
  {
    providerKind: "claude",
    protocol: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    defaultModel: "claude-sonnet-5",
  },
  {
    providerKind: "minimax-cn",
    protocol: "openai-chat",
    baseUrl: "https://api.minimaxi.com/v1",
    defaultModel: "MiniMax-M3",
  },
  {
    providerKind: "minimax-global",
    protocol: "openai-chat",
    baseUrl: "https://api.minimax.io/v1",
    defaultModel: "MiniMax-M3",
  },
  {
    providerKind: "openai-compatible",
    protocol: "openai-chat",
  },
  {
    providerKind: "anthropic-compatible",
    protocol: "anthropic-messages",
  },
] as const satisfies readonly AiProviderPreset[]);
for (const preset of CANONICAL_PROVIDER_PRESETS) Object.freeze(preset);

/** Public snapshots are frozen and never used as canonical runtime input. */
export const AI_PROVIDER_PRESETS: readonly Readonly<AiProviderPreset>[] =
  Object.freeze(
    CANONICAL_PROVIDER_PRESETS.map((preset) => Object.freeze({ ...preset })),
  );

export function getAiProviderPreset(
  providerKind: AiProviderKind,
): AiProviderPreset | undefined {
  const preset: AiProviderPreset | undefined = CANONICAL_PROVIDER_PRESETS.find(
    (preset) => preset.providerKind === providerKind,
  );
  return preset ? Object.freeze({ ...preset }) : undefined;
}

export function resolveAiConnectionForRequest(
  value: unknown,
): AiConnection | undefined {
  const connection = normalizeAiConnection(value);
  if (!connection) return undefined;
  const preset: AiProviderPreset | undefined = CANONICAL_PROVIDER_PRESETS.find(
    ({ providerKind }) => providerKind === connection.providerKind,
  );
  const model = connection.model || preset?.defaultModel;
  return model ? { ...connection, model } : undefined;
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
  const preset = CANONICAL_PROVIDER_PRESETS.find(
    (candidate) => candidate.providerKind === input.providerKind,
  );
  const baseUrl =
    preset && "baseUrl" in preset ? preset.baseUrl : input.baseUrl;
  const connection = preset
    ? normalizeAiConnection({
        id: input.id,
        name: input.name,
        providerKind: input.providerKind,
        protocol: preset.protocol,
        baseUrl,
        model: input.model,
        timeoutMs: 60_000,
        maxInputCharacters: 80_000,
        enabled: true,
      })
    : undefined;
  if (!connection) throw new Error("Invalid AI connection");
  return connection;
}
