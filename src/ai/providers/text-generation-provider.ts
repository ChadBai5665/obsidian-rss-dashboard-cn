import { requestUrl } from "obsidian";
import {
  ProviderError,
  abortedProviderError,
  malformedProviderResponse,
  providerErrorForStatus,
} from "./provider-error";

const parseUnknownJson = JSON.parse as (text: string) => unknown;

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

export function validateGenerationRequest(
  request: TextGenerationRequest,
): void {
  if (
    typeof request !== "object" ||
    request === null ||
    typeof request.system !== "string" ||
    typeof request.user !== "string" ||
    !Number.isSafeInteger(request.maxOutputTokens) ||
    request.maxOutputTokens <= 0
  ) {
    throw new ProviderError(
      "invalid-request",
      "The AI generation request is invalid.",
    );
  }
}

export async function performAiRequest(
  transport: AiTransport,
  request: AiTransportRequest,
  timeoutMs: number,
  apiKey: string,
): Promise<SafeAiResponse> {
  if (request.signal?.aborted) throw abortedProviderError();

  let pending: unknown;
  try {
    pending = transport(request);
  } catch {
    throw networkProviderError();
  }

  const response = await raceTransport(pending, timeoutMs, request.signal);
  return extractSafeResponse(response, apiKey);
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
    try {
      const parsed = parseUnknownJson(text);
      return { status, json: parsed, requestId };
    } catch {
      throw malformedProviderResponse();
    }
  }
  if (json !== undefined) return { status, json, requestId };
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
  pending: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = () => finish(() => reject(abortedProviderError()));
    const timeout = window.setTimeout(
      () => finish(() => reject(new ProviderError(
        "timeout",
        "The AI provider request timed out.",
      ))),
      timeoutMs,
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
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
