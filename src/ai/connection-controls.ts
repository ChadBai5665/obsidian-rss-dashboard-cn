import type {
  AiConnection,
  AiProviderKind,
  AiReasoningEffort,
  AiResponseMode,
  AiThinkingMode,
} from "./ai-types";

export interface AiConnectionControlCapabilities {
  thinkingModes: readonly AiThinkingMode[];
  reasoningEfforts: readonly AiReasoningEffort[];
}

const STANDARD_EFFORTS = Object.freeze([
  "minimal",
  "low",
  "medium",
  "high",
  "max",
] as const);

export function aiConnectionControlCapabilities(
  providerKind: AiProviderKind,
): AiConnectionControlCapabilities {
  switch (providerKind) {
    case "kimi":
      return {
        thinkingModes: ["platform-default", "disabled", "enabled"],
        reasoningEfforts: ["low", "high", "max"],
      };
    case "deepseek":
      return { thinkingModes: ["disabled", "enabled"], reasoningEfforts: ["high", "max"] };
    case "qwen":
      return { thinkingModes: ["disabled", "enabled"], reasoningEfforts: STANDARD_EFFORTS };
    case "glm":
      return { thinkingModes: ["disabled", "enabled"], reasoningEfforts: [] };
    case "minimax-cn":
    case "minimax-global":
      return { thinkingModes: ["disabled", "adaptive"], reasoningEfforts: [] };
    case "openai":
      return {
        thinkingModes: ["platform-default", "disabled", "enabled"],
        reasoningEfforts: STANDARD_EFFORTS,
      };
    case "claude":
    case "anthropic-compatible":
      return {
        thinkingModes: ["platform-default", "adaptive"],
        reasoningEfforts: ["low", "medium", "high", "max"],
      };
    case "openai-compatible":
      return {
        thinkingModes: ["platform-default", "disabled", "enabled", "adaptive"],
        reasoningEfforts: STANDARD_EFFORTS,
      };
  }
}

export function defaultAiThinkingMode(
  providerKind: AiProviderKind,
): AiThinkingMode {
  if (providerKind === "kimi") return "platform-default";
  return aiConnectionControlCapabilities(providerKind).thinkingModes.includes(
    "disabled",
  )
    ? "disabled"
    : "platform-default";
}

export function effectiveAiThinkingMode(
  connection: AiConnection,
): AiThinkingMode {
  const supported = aiConnectionControlCapabilities(
    connection.providerKind,
  ).thinkingModes;
  return connection.thinkingMode && supported.includes(connection.thinkingMode)
    ? connection.thinkingMode
    : defaultAiThinkingMode(connection.providerKind);
}

export function effectiveAiReasoningEffort(
  connection: AiConnection,
): AiReasoningEffort {
  const supported = aiConnectionControlCapabilities(
    connection.providerKind,
  ).reasoningEfforts;
  return connection.reasoningEffort && supported.includes(connection.reasoningEffort)
    ? connection.reasoningEffort
    : "platform-default";
}

export function effectiveAiResponseMode(
  connection: AiConnection,
): AiResponseMode {
  return connection.responseMode === "complete" ? "complete" : "stream";
}
