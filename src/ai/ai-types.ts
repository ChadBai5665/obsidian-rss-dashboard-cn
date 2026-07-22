export type AiProtocol = "openai-chat" | "anthropic-messages";

export type AiProviderKind =
  | "kimi"
  | "deepseek"
  | "qwen"
  | "glm"
  | "openai"
  | "claude"
  | "openai-compatible"
  | "anthropic-compatible";

/** Non-secret connection metadata. API keys are stored outside the vault. */
export interface AiConnection {
  id: string;
  name: string;
  providerKind: AiProviderKind;
  protocol: AiProtocol;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxInputCharacters: number;
  enabled: boolean;
}

export interface AiSettings {
  connections: AiConnection[];
  defaultConnectionId?: string;
}
