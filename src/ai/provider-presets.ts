import type { AiConnection, AiProtocol, AiProviderKind } from "./ai-types";
import { normalizeAiConnection } from "./connection-validation";

export interface AiProviderPreset {
  providerKind: AiProviderKind;
  protocol: AiProtocol;
  baseUrl?: string;
}

const CANONICAL_PROVIDER_PRESETS = Object.freeze([
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
  const preset = CANONICAL_PROVIDER_PRESETS.find(
    (preset) => preset.providerKind === providerKind,
  );
  return preset ? Object.freeze({ ...preset }) : undefined;
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
