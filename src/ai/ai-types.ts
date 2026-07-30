export type AiProtocol = "openai-chat" | "anthropic-messages";

export type AiThinkingMode =
  | "platform-default"
  | "disabled"
  | "enabled"
  | "adaptive";

export type AiReasoningEffort =
  | "platform-default"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "max";

export type AiResponseMode = "stream" | "complete";

export type AiProviderKind =
  | "kimi"
  | "deepseek"
  | "qwen"
  | "glm"
  | "openai"
  | "claude"
  | "minimax-cn"
  | "minimax-global"
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
  /** Missing on legacy records; request resolution supplies safe defaults. */
  thinkingMode?: AiThinkingMode;
  /** Used only when the selected provider/model supports an effort control. */
  reasoningEffort?: AiReasoningEffort;
  /** Missing legacy values retain the original streaming behavior. */
  responseMode?: AiResponseMode;
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
