import {
  MAX_AI_SELECTED_CONTENT_CHARACTERS,
  MAX_AI_TIMEOUT_MS,
  type AiConnection,
  type AiProviderKind,
  type AiSettings,
} from "./ai-types";
import type { AiProviderPreset } from "./provider-presets";
import { normalizeConnectionId } from "../security/connection-id";

const VALIDATION_PROVIDER_PRESETS = Object.freeze({
  kimi: Object.freeze({
    providerKind: "kimi",
    protocol: "openai-chat",
    baseUrl: "https://api.moonshot.cn/v1",
  }),
  deepseek: Object.freeze({
    providerKind: "deepseek",
    protocol: "openai-chat",
    baseUrl: "https://api.deepseek.com",
  }),
  qwen: Object.freeze({
    providerKind: "qwen",
    protocol: "openai-chat",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  }),
  glm: Object.freeze({
    providerKind: "glm",
    protocol: "openai-chat",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
  }),
  openai: Object.freeze({
    providerKind: "openai",
    protocol: "openai-chat",
    baseUrl: "https://api.openai.com/v1",
  }),
  claude: Object.freeze({
    providerKind: "claude",
    protocol: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
  }),
  "openai-compatible": Object.freeze({
    providerKind: "openai-compatible",
    protocol: "openai-chat",
  }),
  "anthropic-compatible": Object.freeze({
    providerKind: "anthropic-compatible",
    protocol: "anthropic-messages",
  }),
} as const satisfies Readonly<Record<AiProviderKind, AiProviderPreset>>);

const CONNECTION_KEYS = new Set([
  "id",
  "name",
  "providerKind",
  "protocol",
  "baseUrl",
  "model",
  "timeoutMs",
  "maxInputCharacters",
  "enabled",
]);
const SETTINGS_KEYS = new Set(["connections", "defaultConnectionId"]);
const WHITESPACE = /\s/u;
const MAX_CONNECTIONS = 1_000;

export function normalizeAiConnection(
  value: unknown,
): AiConnection | undefined {
  const record = plainRecord(value);
  if (!record || !hasExactOwnDataKeys(record, CONNECTION_KEYS)) {
    return undefined;
  }

  const id = normalizedId(ownData(record, "id"));
  const name = normalizedText(ownData(record, "name"));
  const model = normalizedText(ownData(record, "model"));
  const providerKind = ownData(record, "providerKind");
  const preset = providerPreset(providerKind);
  const protocol = ownData(record, "protocol");
  const baseUrl = preset
    ? normalizeAiBaseUrl(ownData(record, "baseUrl"), preset.providerKind)
    : undefined;
  const timeoutMs = ownData(record, "timeoutMs");
  const maxInputCharacters = ownData(record, "maxInputCharacters");
  const enabled = ownData(record, "enabled");

  if (
    !id ||
    !name ||
    !model ||
    !preset ||
    protocol !== preset.protocol ||
    !baseUrl ||
    (preset.baseUrl !== undefined && baseUrl !== preset.baseUrl) ||
    !positiveSafeInteger(timeoutMs) ||
    timeoutMs > MAX_AI_TIMEOUT_MS ||
    !positiveSafeInteger(maxInputCharacters) ||
    maxInputCharacters > MAX_AI_SELECTED_CONTENT_CHARACTERS ||
    typeof enabled !== "boolean"
  ) {
    return undefined;
  }

  return {
    id,
    name,
    providerKind: preset.providerKind,
    protocol: preset.protocol,
    baseUrl,
    model,
    timeoutMs,
    maxInputCharacters,
    enabled,
  };
}

export function normalizeAiSettings(value: unknown): AiSettings {
  const record = plainRecord(value);
  if (!record || !hasAllowedOwnDataKeys(record, SETTINGS_KEYS)) {
    return { connections: [] };
  }
  const entries = ownDenseArray(ownData(record, "connections"));
  if (!entries) return { connections: [] };

  const connections: AiConnection[] = [];
  const ids = new Set<string>();
  for (const entry of entries) {
    const connection = normalizeAiConnection(entry);
    if (!connection || ids.has(connection.id)) return { connections: [] };
    ids.add(connection.id);
    connections.push(connection);
  }

  if (!hasOwnData(record, "defaultConnectionId")) return { connections };
  const defaultConnectionId = normalizedId(
    ownData(record, "defaultConnectionId"),
  );
  return defaultConnectionId && ids.has(defaultConnectionId)
    ? { connections, defaultConnectionId }
    : { connections };
}

/**
 * Normalizes a provider base URL without accepting URL parser rewrites as local
 * host authorization. Compatible relays may use exact localhost/127.0.0.1 HTTP.
 */
export function normalizeAiBaseUrl(
  value: unknown,
  providerKind: AiProviderKind,
): string | undefined {
  const preset = providerPreset(providerKind);
  if (!preset) return undefined;
  if (typeof value !== "string" || hasControlCharacters(value)) {
    return undefined;
  }
  const candidate = value.trim();
  if (
    !candidate ||
    WHITESPACE.test(candidate) ||
    candidate.includes("\\") ||
    candidate.includes("?") ||
    candidate.includes("#") ||
    !/^https?:\/\//iu.test(candidate)
  ) {
    return undefined;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(candidate);
  } catch {
    return undefined;
  }
  if (hasControlCharacters(decoded) || decoded.includes("\\")) {
    return undefined;
  }

  const authorityMatch = /^https?:\/\/([^/?#]*)(\/[^?#]*)?$/iu.exec(candidate);
  if (!authorityMatch || !authorityMatch[1]) return undefined;
  const rawPath = authorityMatch[2] ?? "";
  if (hasDotPathSegment(rawPath)) return undefined;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return undefined;
  }

  if (url.protocol === "http:") {
    if (
      providerKind !== "openai-compatible" &&
      providerKind !== "anthropic-compatible"
    ) {
      return undefined;
    }
    const rawHost = rawHttpHostname(authorityMatch[1]);
    if (rawHost !== "localhost" && rawHost !== "127.0.0.1") {
      return undefined;
    }
  }

  const path = url.pathname.replace(/\/+$/u, "");
  const normalized = `${url.origin}${path}`;
  return preset.baseUrl !== undefined && normalized !== preset.baseUrl
    ? undefined
    : normalized;
}

function providerPreset(value: unknown): AiProviderPreset | undefined {
  return typeof value === "string" && hasOwn(VALIDATION_PROVIDER_PRESETS, value)
    ? VALIDATION_PROVIDER_PRESETS[value as AiProviderKind]
    : undefined;
}

function hasOwn(object: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function normalizedText(value: unknown): string | undefined {
  if (typeof value !== "string" || hasControlCharacters(value)) {
    return undefined;
  }
  const text = value.normalize("NFC").trim();
  return text || undefined;
}

function normalizedId(value: unknown): string | undefined {
  return normalizeConnectionId(value);
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159))
    ) {
      return true;
    }
  }
  return false;
}

function hasDotPathSegment(rawPath: string): boolean {
  try {
    return rawPath.split("/").some((segment) => {
      const decoded = decodeURIComponent(segment).toLowerCase();
      return decoded === "." || decoded === "..";
    });
  } catch {
    return true;
  }
}

function rawHttpHostname(authority: string): string | undefined {
  if (authority.includes("@") || authority.startsWith("[")) return undefined;
  const colon = authority.indexOf(":");
  return (colon === -1 ? authority : authority.slice(0, colon)).toLowerCase();
}

function ownDenseArray(value: unknown): unknown[] | undefined {
  try {
    if (
      !Array.isArray(value) ||
      Reflect.getPrototypeOf(value) !== Array.prototype
    ) {
      return undefined;
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const length: unknown =
      lengthDescriptor && "value" in lengthDescriptor
        ? lengthDescriptor.value
        : undefined;
    if (
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > MAX_CONNECTIONS
    ) {
      return undefined;
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length + 1 || !keys.includes("length")) {
      return undefined;
    }
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor)) return undefined;
      result.push(descriptor.value);
    }
    return result;
  } catch {
    return undefined;
  }
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    const prototype = Reflect.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function hasExactOwnDataKeys(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  try {
    const keys = Reflect.ownKeys(record);
    return (
      keys.length === allowed.size &&
      keys.every(
        (key) =>
          typeof key === "string" &&
          allowed.has(key) &&
          hasOwnData(record, key),
      )
    );
  } catch {
    return false;
  }
}

function hasAllowedOwnDataKeys(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  try {
    const keys = Reflect.ownKeys(record);
    return (
      keys.every(
        (key) =>
          typeof key === "string" &&
          allowed.has(key) &&
          hasOwnData(record, key),
      ) && hasOwnData(record, "connections")
    );
  } catch {
    return false;
  }
}

function hasOwnData(record: Record<string, unknown>, key: string): boolean {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return Boolean(descriptor && "value" in descriptor);
  } catch {
    return false;
  }
}

function ownData(record: Record<string, unknown>, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}
