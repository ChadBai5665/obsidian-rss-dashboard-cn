import { requestUrl } from "obsidian";
import {
  ProviderError,
  abortedProviderError,
  malformedProviderResponse,
  providerErrorForStatus,
  providerResponseTooLarge,
} from "./provider-error";

const parseUnknownJson = JSON.parse as (text: string) => unknown;
// Invoked only through Reflect.apply with the candidate signal as receiver.
// eslint-disable-next-line @typescript-eslint/unbound-method
const ABORTED_GETTER = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  "aborted",
)?.get;
const ABORT_SIGNAL_EVENT_TARGET = Reflect.getPrototypeOf(
  AbortSignal.prototype,
) as object;
const ADD_EVENT_LISTENER: unknown = Object.getOwnPropertyDescriptor(
  ABORT_SIGNAL_EVENT_TARGET,
  "addEventListener",
)?.value;
const REMOVE_EVENT_LISTENER: unknown = Object.getOwnPropertyDescriptor(
  ABORT_SIGNAL_EVENT_TARGET,
  "removeEventListener",
)?.value;

export const MAX_AI_OUTPUT_TOKENS = 65_536;
export const MAX_AI_RESPONSE_CHARACTERS = 1_000_000;
export const MAX_AI_OUTPUT_CHARACTERS = 500_000;
const MAX_AI_REQUEST_CHARACTERS = 1_000_000;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 10_000;
const MAX_JSON_KEYS_PER_OBJECT = 1_000;
const MAX_JSON_ARRAY_LENGTH = 10_000;

export interface TextGenerationRequest {
  system: string;
  user: string;
  maxOutputTokens: number;
  signal?: AbortSignal;
}

export interface TextGenerationResult {
  text: string;
  providerRequestId?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface TextGenerationProvider {
  generate(request: TextGenerationRequest): Promise<TextGenerationResult>;
}

export interface TextGenerationRequestSnapshot {
  system: string;
  user: string;
  maxOutputTokens: number;
  signal?: AbortSignal;
  signalWasAborted: boolean;
}

export interface AiTransportRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
  /** The caller's original signal. The default Obsidian transport races it locally. */
  signal?: AbortSignal;
}

export interface AiTransportResponse {
  status: number;
  headers?: Record<string, string>;
  /** Tests and alternative transports can supply already-parsed plain JSON. */
  json?: unknown;
  /** The default transport supplies raw text so malformed JSON stays distinguishable. */
  text?: string;
}

export type AiTransport = (
  request: AiTransportRequest,
) => unknown;

export interface SafeAiResponse {
  status: number;
  json: unknown;
  requestId?: string;
}

export async function obsidianAiTransport(
  request: AiTransportRequest,
): Promise<AiTransportResponse> {
  const response = await requestUrl({
    url: request.url,
    method: request.method,
    headers: request.headers,
    body: request.body,
    throw: false,
  });
  return {
    status: response.status,
    headers: response.headers,
    text: response.text,
  };
}

export function snapshotGenerationRequest(
  value: unknown,
): TextGenerationRequestSnapshot {
  const snapshot = exactRequestSnapshot(value);
  const system = snapshot.get("system");
  const user = snapshot.get("user");
  const maxOutputTokens = snapshot.get("maxOutputTokens");
  const signalValue = snapshot.get("signal");
  if (
    typeof system !== "string" ||
    typeof user !== "string" ||
    system.length + user.length > MAX_AI_REQUEST_CHARACTERS ||
    typeof maxOutputTokens !== "number" ||
    !Number.isSafeInteger(maxOutputTokens) ||
    maxOutputTokens <= 0 ||
    maxOutputTokens > MAX_AI_OUTPUT_TOKENS
  ) throw invalidGenerationRequest();

  if (signalValue === undefined) {
    return { system, user, maxOutputTokens, signalWasAborted: false };
  }
  const signalWasAborted = trustedAbortedState(signalValue);
  return {
    system,
    user,
    maxOutputTokens,
    signal: signalValue as AbortSignal,
    signalWasAborted,
  };
}

function exactRequestSnapshot(value: unknown): ReadonlyMap<string, unknown> {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw invalidGenerationRequest();
    }
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw invalidGenerationRequest();
    }
    const keys = Reflect.ownKeys(value);
    const allowed = new Set(["system", "user", "maxOutputTokens", "signal"]);
    if (
      keys.length < 3 ||
      keys.length > 4 ||
      keys.some((key) => typeof key !== "string" || !allowed.has(key))
    ) throw invalidGenerationRequest();

    const snapshot = new Map<string, unknown>();
    for (const key of keys) {
      if (typeof key !== "string") throw invalidGenerationRequest();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) throw invalidGenerationRequest();
      snapshot.set(key, descriptor.value as unknown);
    }
    if (
      !snapshot.has("system") ||
      !snapshot.has("user") ||
      !snapshot.has("maxOutputTokens")
    ) throw invalidGenerationRequest();
    return snapshot;
  } catch {
    throw invalidGenerationRequest();
  }
}

export async function performAiRequest(
  transport: AiTransport,
  request: AiTransportRequest,
  timeoutMs: number,
  apiKey: string,
  signalWasAborted = false,
): Promise<SafeAiResponse> {
  if (signalWasAborted) throw abortedProviderError();
  const response = await raceTransport(
    () => transport(request),
    timeoutMs,
    request.signal,
  );
  return extractSafeResponse(response, apiKey);
}

export function outputCharacterLimit(maxOutputTokens: number): number {
  return Math.min(MAX_AI_OUTPUT_CHARACTERS, maxOutputTokens * 16);
}

export function plainDataRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return undefined;
    }
    return value as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function ownData(
  record: Record<string, unknown>,
  key: string,
): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

export function hasOwnData(
  record: Record<string, unknown>,
  key: string,
): boolean {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return Boolean(descriptor && "value" in descriptor);
  } catch {
    return false;
  }
}

export function denseDataArray(
  value: unknown,
  maximum = 100_000,
): unknown[] | undefined {
  try {
    if (!Array.isArray(value) || Reflect.getPrototypeOf(value) !== Array.prototype) {
      return undefined;
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const length: unknown = lengthDescriptor && "value" in lengthDescriptor
      ? lengthDescriptor.value
      : undefined;
    if (
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > maximum
    ) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length + 1 || !keys.includes("length")) return undefined;

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

export function optionalUsageInteger(
  record: Record<string, unknown> | undefined,
  key: string,
): number | undefined | null {
  if (!record) return undefined;
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(record, key);
  } catch {
    return null;
  }
  if (!descriptor) return undefined;
  if (!("value" in descriptor)) return null;
  const value: unknown = descriptor.value;
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : null;
}

export function safeProviderRequestId(
  value: unknown,
  apiKey: string,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const candidate = value.trim();
  if (!candidate || candidate.length > 256 || hasControlCharacters(candidate)) {
    return undefined;
  }
  if (candidate === apiKey || candidate.includes(apiKey)) return undefined;
  return candidate;
}

export function validApiKeyValue(value: unknown): value is string {
  return typeof value === "string" &&
    Boolean(value) &&
    value === value.trim() &&
    !hasControlCharacters(value);
}

export function resultWithOptionalMetadata(
  text: string,
  requestId: string | undefined,
  inputTokens: number | undefined,
  outputTokens: number | undefined,
): TextGenerationResult {
  const result: TextGenerationResult = { text };
  if (requestId !== undefined) result.providerRequestId = requestId;
  if (inputTokens !== undefined) result.inputTokens = inputTokens;
  if (outputTokens !== undefined) result.outputTokens = outputTokens;
  return result;
}

function extractSafeResponse(response: unknown, apiKey: string): SafeAiResponse {
  const record = plainDataRecord(response);
  if (!record) throw malformedProviderResponse();
  const status = ownData(record, "status");
  if (
    typeof status !== "number" ||
    !Number.isInteger(status) ||
    status < 100 ||
    status > 599
  ) throw malformedProviderResponse();

  const requestId = safeHeaderRequestId(ownData(record, "headers"), apiKey);
  if (status < 200 || status >= 300) {
    throw providerErrorForStatus(status, requestId);
  }

  const text = ownData(record, "text");
  const json = ownData(record, "json");
  if (typeof text === "string") {
    if (text.length > MAX_AI_RESPONSE_CHARACTERS) {
      throw providerResponseTooLarge();
    }
    let parsed: unknown;
    try {
      parsed = parseUnknownJson(text);
    } catch {
      throw malformedProviderResponse();
    }
    assertBoundedPlainJson(parsed);
    return { status, json: parsed, requestId };
  }
  if (json !== undefined) {
    assertBoundedPlainJson(json);
    return { status, json, requestId };
  }
  throw malformedProviderResponse();
}

function safeHeaderRequestId(
  headers: unknown,
  apiKey: string,
): string | undefined {
  if (headers === undefined) return undefined;
  const record = plainDataRecord(headers);
  if (!record) return undefined;
  for (const key of Object.getOwnPropertyNames(record)) {
    if (key.toLowerCase() !== "x-request-id" && key.toLowerCase() !== "request-id") {
      continue;
    }
    return safeProviderRequestId(ownData(record, key), apiKey);
  }
  return undefined;
}

function raceTransport(
  start: () => unknown,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let listenerAdded = false;
    let timeout: number | undefined;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) window.clearTimeout(timeout);
      if (listenerAdded && signal && typeof REMOVE_EVENT_LISTENER === "function") {
        try {
          Reflect.apply(REMOVE_EVENT_LISTENER, signal, ["abort", onAbort]);
        } catch {
          // Cleanup failure must never leave the public promise pending.
        }
      }
      action();
    };
    const onAbort = () => finish(() => reject(abortedProviderError()));
    if (signal) {
      try {
        if (typeof ADD_EVENT_LISTENER !== "function") {
          throw invalidGenerationRequest();
        }
        Reflect.apply(ADD_EVENT_LISTENER, signal, ["abort", onAbort, { once: true }]);
        listenerAdded = true;
        if (trustedAbortedState(signal)) {
          onAbort();
          return;
        }
      } catch {
        finish(() => reject(invalidGenerationRequest()));
        return;
      }
    }
    timeout = window.setTimeout(
      () => finish(() => reject(new ProviderError(
        "timeout",
        "The AI provider request timed out.",
      ))),
      timeoutMs,
    );

    let pending: unknown;
    try {
      pending = start();
    } catch {
      finish(() => reject(networkProviderError()));
      return;
    }
    let normalized: Promise<unknown>;
    try {
      normalized = Promise.resolve(pending);
    } catch {
      finish(() => reject(networkProviderError()));
      return;
    }
    normalized.then(
      (value) => finish(() => resolve(value)),
      () => finish(() => reject(networkProviderError())),
    );
  });
}

function trustedAbortedState(value: unknown): boolean {
  if (!ABORTED_GETTER || (typeof value !== "object" && typeof value !== "function") || value === null) {
    throw invalidGenerationRequest();
  }
  try {
    const aborted: unknown = Reflect.apply(ABORTED_GETTER, value, []);
    if (typeof aborted !== "boolean") throw invalidGenerationRequest();
    return aborted;
  } catch {
    throw invalidGenerationRequest();
  }
}

function assertBoundedPlainJson(root: unknown): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  let stringCharacters = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    nodes += 1;
    if (nodes > MAX_JSON_NODES || current.depth > MAX_JSON_DEPTH) {
      throw providerResponseTooLarge();
    }
    const value = current.value;
    if (typeof value === "string") {
      stringCharacters += value.length;
      if (stringCharacters > MAX_AI_RESPONSE_CHARACTERS) {
        throw providerResponseTooLarge();
      }
      continue;
    }
    if (
      value === null ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) continue;
    if (typeof value !== "object") throw malformedProviderResponse();
    if (seen.has(value)) throw malformedProviderResponse();
    seen.add(value);

    if (Array.isArray(value)) {
      const length = ownArrayLength(value);
      if (length !== undefined && length > MAX_JSON_ARRAY_LENGTH) {
        throw providerResponseTooLarge();
      }
      const entries = denseDataArray(value, MAX_JSON_ARRAY_LENGTH);
      if (!entries) throw malformedProviderResponse();
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        stack.push({ value: entries[index], depth: current.depth + 1 });
      }
      continue;
    }

    const record = plainDataRecord(value);
    if (!record) throw malformedProviderResponse();
    let keys: string[];
    try {
      keys = Object.getOwnPropertyNames(record);
    } catch {
      throw malformedProviderResponse();
    }
    if (keys.length > MAX_JSON_KEYS_PER_OBJECT) throw providerResponseTooLarge();
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      stack.push({
        value: ownData(record, keys[index]),
        depth: current.depth + 1,
      });
    }
  }
}

function ownArrayLength(value: unknown[]): number | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, "length");
    const length: unknown = descriptor && "value" in descriptor
      ? descriptor.value
      : undefined;
    return typeof length === "number" && Number.isSafeInteger(length) && length >= 0
      ? length
      : undefined;
  } catch {
    return undefined;
  }
}

function invalidGenerationRequest(): ProviderError {
  return new ProviderError(
    "invalid-request",
    "The AI generation request is invalid.",
  );
}

function networkProviderError(): ProviderError {
  return new ProviderError(
    "network-failure",
    "The AI provider network request failed.",
  );
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code <= 31 || (code >= 127 && code <= 159))) {
      return true;
    }
  }
  return false;
}
