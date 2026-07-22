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

export const MAX_AI_TIMEOUT_MS = 600_000;
/** Omission marker plus at least one retained character from each end. */
export const MIN_AI_INPUT_CHARACTERS = 15;
/** Provider boundary for the complete system + user request text. */
export const MAX_AI_REQUEST_CHARACTERS = 1_000_000;
/** Reserved for prompts, source metadata, delimiters, and later envelope growth. */
export const AI_PROMPT_ENVELOPE_RESERVE_CHARACTERS = 100_000;
export const MAX_AI_SELECTED_CONTENT_CHARACTERS =
  MAX_AI_REQUEST_CHARACTERS - AI_PROMPT_ENVELOPE_RESERVE_CHARACTERS;
