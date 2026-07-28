import { Buffer } from "node:buffer";
import {
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
} from "node:http";
import { request as httpsRequest } from "node:https";
import {
  clearTimeout as cancelTimeout,
  setTimeout as scheduleTimeout,
} from "node:timers";
import { readTrustedAbortState } from "../trusted-abort";
import {
  ProviderError,
  abortedProviderError,
  malformedProviderResponse,
  providerResponseTooLarge,
} from "./provider-error";
import type {
  AiStreamingTransport,
  AiStreamingTransportResponse,
  AiTransportRequest,
} from "./text-generation-provider";

export const MAX_AI_STREAM_REQUEST_BODY_BYTES = 4_500_000;
export const MAX_AI_STREAM_RESPONSE_BYTES = 4_000_000;
export const MAX_AI_STREAM_RESPONSE_CHUNKS = 20_000;
export const MAX_AI_STREAM_JSON_BODY_BYTES = 4_000_000;
export const MAX_AI_STREAM_REDIRECTS = 3;
export const DEFAULT_AI_STREAM_TIMEOUT_MS = 120_000;

const MAX_TIMEOUT_MS = 600_000;
const MAX_URL_CHARACTERS = 8_192;
const MAX_REQUEST_HEADERS = 32;
const MAX_HEADER_VALUE_BYTES = 16_384;
const MAX_REQUEST_HEADER_BYTES = 65_536;
const MAX_RESPONSE_HEADER_CHARACTERS = 1_024;
const MAX_REQUEST_ID_CHARACTERS = 256;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const POST_PRESERVING_REDIRECT_STATUSES = new Set([307, 308]);
const BLOCKED_REQUEST_HEADERS = new Set([
  "connection",
  "content-length",
  "cookie",
  "host",
  "proxy-authorization",
  "set-cookie",
  "transfer-encoding",
]);
const DANGEROUS_OBJECT_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

const SIGNAL_EVENT_TARGET = Reflect.getPrototypeOf(AbortSignal.prototype) as object;
const ADD_ABORT_LISTENER: unknown = Object.getOwnPropertyDescriptor(
  SIGNAL_EVENT_TARGET,
  "addEventListener",
)?.value;
const REMOVE_ABORT_LISTENER: unknown = Object.getOwnPropertyDescriptor(
  SIGNAL_EVENT_TARGET,
  "removeEventListener",
)?.value;

export interface NodeAiStreamingTransportOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxResponseChunks?: number;
  maxJsonBodyBytes?: number;
  maxRedirects?: number;
}

interface TransportLimits {
  timeoutMs: number;
  maxResponseBytes: number;
  maxResponseChunks: number;
  maxJsonBodyBytes: number;
  maxRedirects: number;
}

interface SafeTransportRequest {
  url: URL;
  headers: Readonly<Record<string, string>>;
  sensitiveValues: readonly string[];
  body: string;
  signal?: AbortSignal;
}

interface RedirectResult {
  kind: "redirect";
  url: URL;
}

interface ResponseResult {
  kind: "response";
  response: AiStreamingTransportResponse;
}

type HopResult = RedirectResult | ResponseResult;

/**
 * Creates the desktop-only Node transport used by streaming AI providers.
 * It performs one request at a time and never retries a provider operation.
 */
export function createNodeAiStreamingTransport(
  options: NodeAiStreamingTransportOptions = {},
): AiStreamingTransport {
  const limits = normalizeLimits(options);

  return async (input, onChunk) => {
    if (typeof onChunk !== "function") throw invalidRequestError();
    const safeRequest = snapshotRequest(input);
    const deadline = Date.now() + limits.timeoutMs;
    let url = safeRequest.url;
    let redirects = 0;

    while (true) {
      if (safeRequest.signal) {
        const aborted = readTrustedAbortState(safeRequest.signal);
        if (aborted === undefined) throw invalidRequestError();
        if (aborted) throw abortedProviderError();
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw timeoutError();
      const result = await requestHop(
        safeRequest,
        url,
        onChunk,
        limits,
        remainingMs,
      );
      if (result.kind === "response") return result.response;
      if (redirects >= limits.maxRedirects) throw networkError();
      redirects += 1;
      url = result.url;
    }
  };
}

export const nodeAiStreamingTransport = createNodeAiStreamingTransport();

/** Validates a redirect before any authorization-bearing follow-up request. */
export function validateAiStreamingRedirect(
  current: URL,
  location: string,
): URL {
  const safeCurrent = validateRequestUrl(current.href, false);
  if (
    typeof location !== "string" ||
    location.length === 0 ||
    location.length > MAX_URL_CHARACTERS ||
    hasControlOrWhitespace(location) ||
    location.includes("\\")
  ) throw networkError();

  let next: URL;
  try {
    if (/^https?:\/\//iu.test(location)) {
      next = validateRequestUrl(location, false);
    } else if (location.startsWith("//")) {
      next = validateRequestUrl(`${safeCurrent.protocol}${location}`, false);
    } else {
      next = validateRequestUrl(new URL(location, safeCurrent).href, false);
    }
  } catch {
    throw networkError();
  }
  if (safeCurrent.protocol === "https:" && next.protocol !== "https:") {
    throw networkError();
  }
  if (safeCurrent.origin !== next.origin) throw networkError();
  return next;
}

async function requestHop(
  input: SafeTransportRequest,
  url: URL,
  onChunk: (chunk: Uint8Array) => void,
  limits: TransportLimits,
  timeoutMs: number,
): Promise<HopResult> {
  return await new Promise<HopResult>((resolve, reject) => {
    let settled = false;
    let request: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    let timer: ReturnType<typeof scheduleTimeout> | undefined;
    let abortListenerAdded = false;
    let responseBytes = 0;
    let responseChunks = 0;
    let responseEnded = false;
    let responseData: ((chunk: unknown) => void) | undefined;
    let responseEnd: (() => void) | undefined;
    let responseError: ((error: Error) => void) | undefined;
    let responseAborted: (() => void) | undefined;
    let responseClose: (() => void) | undefined;
    const jsonChunks: Buffer[] = [];

    const requestError = (_error: Error): void => {
      terminate(networkError());
    };
    const onAbort = (): void => terminate(abortedProviderError());
    const removeAbortListener = (): void => {
      if (
        !abortListenerAdded ||
        !input.signal ||
        typeof REMOVE_ABORT_LISTENER !== "function"
      ) return;
      abortListenerAdded = false;
      try {
        Reflect.apply(REMOVE_ABORT_LISTENER, input.signal, ["abort", onAbort]);
      } catch {
        // The public promise is already settling; cleanup remains best effort.
      }
    };
    const cleanup = (): void => {
      if (timer !== undefined) {
        cancelTimeout(timer);
        timer = undefined;
      }
      removeAbortListener();
      try {
        request?.off("error", requestError);
      } catch {
        // A closing Node request may reject listener changes.
      }
      try {
        if (response && responseData) response.off("data", responseData);
        if (response && responseEnd) response.off("end", responseEnd);
        if (response && responseError) response.off("error", responseError);
        if (response && responseAborted) response.off("aborted", responseAborted);
        if (response && responseClose) response.off("close", responseClose);
      } catch {
        // A closing Node response may reject listener changes.
      }
      jsonChunks.length = 0;
    };
    const finish = (error: ProviderError | undefined, value?: HopResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else if (value) resolve(value);
      else reject(networkError());
    };
    const terminate = (error: ProviderError): void => {
      if (settled) return;
      installTerminalErrorSink(request);
      installTerminalErrorSink(response);
      finish(error);
      safelyDestroy(response);
      safelyDestroy(request);
    };
    const completeAndClose = (value: HopResult): void => {
      if (settled) return;
      installTerminalErrorSink(request);
      installTerminalErrorSink(response);
      finish(undefined, value);
      safelyDestroy(response);
      safelyDestroy(request);
    };

    try {
      if (input.signal) {
        const aborted = readTrustedAbortState(input.signal);
        if (
          aborted === undefined ||
          typeof ADD_ABORT_LISTENER !== "function" ||
          typeof REMOVE_ABORT_LISTENER !== "function"
        ) {
          finish(invalidRequestError());
          return;
        }
        Reflect.apply(ADD_ABORT_LISTENER, input.signal, [
          "abort",
          onAbort,
          { once: true },
        ]);
        abortListenerAdded = true;
        if (aborted || readTrustedAbortState(input.signal)) {
          onAbort();
          return;
        }
      }

      timer = scheduleTimeout(() => terminate(timeoutError()), timeoutMs);
      const requestFunction = url.protocol === "http:" ? httpRequest : httpsRequest;
      request = requestFunction(
        url,
        { method: "POST", headers: input.headers },
        (nextResponse) => {
          if (settled) {
            safelyDestroy(nextResponse);
            return;
          }
          response = nextResponse;
          try {
            const status = nextResponse.statusCode;
            if (
              status === undefined ||
              !Number.isInteger(status) ||
              status < 100 ||
              status > 599
            ) {
              terminate(malformedProviderResponse());
              return;
            }
            const contentTypeHeader = safeSingleHeader(
              nextResponse.headers["content-type"],
              MAX_RESPONSE_HEADER_CHARACTERS,
            );
            const contentType = normalizedContentType(contentTypeHeader);
            const projectedHeaders: Record<string, string> = {};
            if (contentTypeHeader) projectedHeaders["content-type"] = contentTypeHeader;
            const requestId = responseRequestId(
              nextResponse,
              input.sensitiveValues,
            );

            if (REDIRECT_STATUSES.has(status)) {
              const location = safeSingleHeader(
                nextResponse.headers.location,
                MAX_URL_CHARACTERS,
              );
              if (!location) {
                completeAndClose({
                  kind: "response",
                  response: responseResult(
                    status,
                    projectedHeaders,
                    contentType,
                    requestId,
                  ),
                });
                return;
              }
              if (!POST_PRESERVING_REDIRECT_STATUSES.has(status)) {
                terminate(networkError());
                return;
              }
              let redirect: URL;
              try {
                redirect = validateAiStreamingRedirect(url, location);
              } catch {
                terminate(networkError());
                return;
              }
              completeAndClose({ kind: "redirect", url: redirect });
              return;
            }

            if (status < 200 || status >= 300) {
              completeAndClose({
                kind: "response",
                response: responseResult(
                  status,
                  projectedHeaders,
                  contentType,
                  requestId,
                ),
              });
              return;
            }

            const bodyLimit = contentType === "application/json"
              ? Math.min(limits.maxResponseBytes, limits.maxJsonBodyBytes)
              : limits.maxResponseBytes;
            const declaredLength = declaredContentLength(nextResponse);
            if (declaredLength !== undefined && declaredLength > bodyLimit) {
              terminate(providerResponseTooLarge());
              return;
            }

            responseData = (chunk) => {
              if (settled) return;
              let buffer: Buffer;
              try {
                buffer = safeBuffer(chunk);
              } catch {
                terminate(malformedProviderResponse());
                return;
              }
              const nextBytes = responseBytes + buffer.byteLength;
              const nextChunks = responseChunks + 1;
              if (
                !Number.isSafeInteger(nextBytes) ||
                nextBytes > bodyLimit ||
                nextChunks > limits.maxResponseChunks
              ) {
                terminate(providerResponseTooLarge());
                return;
              }
              responseBytes = nextBytes;
              responseChunks = nextChunks;
              if (contentType === "text/event-stream") {
                try {
                  onChunk(new Uint8Array(buffer));
                } catch {
                  terminate(malformedProviderResponse());
                }
              } else if (contentType === "application/json") {
                jsonChunks.push(buffer);
              }
            };
            responseEnd = () => {
              if (settled) return;
              responseEnded = true;
              let bodyText: string | undefined;
              if (contentType === "application/json") {
                try {
                  const bytes = Buffer.concat(jsonChunks, responseBytes);
                  bodyText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
                } catch {
                  terminate(malformedProviderResponse());
                  return;
                }
              }
              installTerminalErrorSink(request);
              installTerminalErrorSink(response);
              finish(undefined, {
                kind: "response",
                response: responseResult(
                  status,
                  projectedHeaders,
                  contentType,
                  requestId,
                  bodyText,
                ),
              });
            };
            responseError = (_error) => terminate(networkError());
            responseAborted = () => terminate(networkError());
            responseClose = () => {
              if (!settled && !responseEnded) terminate(networkError());
            };
            nextResponse.on("data", responseData);
            nextResponse.on("end", responseEnd);
            nextResponse.on("error", responseError);
            nextResponse.on("aborted", responseAborted);
            nextResponse.on("close", responseClose);
          } catch {
            terminate(malformedProviderResponse());
          }
        },
      );
      request.on("error", requestError);
      request.end(input.body);
    } catch {
      terminate(networkError());
    }
  });
}

function snapshotRequest(input: AiTransportRequest): SafeTransportRequest {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw invalidRequestError();
    }
    const prototype = Reflect.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) {
      throw invalidRequestError();
    }
    const keys = Reflect.ownKeys(input);
    const allowed = new Set(["url", "method", "headers", "body", "signal"]);
    if (
      keys.length < 4 ||
      keys.length > 5 ||
      keys.some((key) => typeof key !== "string" || !allowed.has(key))
    ) throw invalidRequestError();
    const snapshot = new Map<string, unknown>();
    for (const key of keys) {
      if (typeof key !== "string") throw invalidRequestError();
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !("value" in descriptor)) throw invalidRequestError();
      snapshot.set(key, descriptor.value);
    }
    if (
      !snapshot.has("url") ||
      !snapshot.has("method") ||
      !snapshot.has("headers") ||
      !snapshot.has("body")
    ) throw invalidRequestError();
    const method = snapshot.get("method");
    const body = snapshot.get("body");
    const rawUrl = snapshot.get("url");
    if (method !== "POST" || typeof body !== "string" || typeof rawUrl !== "string") {
      throw invalidRequestError();
    }
    if (Buffer.byteLength(body, "utf8") > MAX_AI_STREAM_REQUEST_BODY_BYTES) {
      throw invalidRequestError();
    }
    const headers = snapshotHeaders(snapshot.get("headers"));
    let signal: AbortSignal | undefined;
    const signalValue = snapshot.get("signal");
    if (signalValue !== undefined) {
      if (readTrustedAbortState(signalValue) === undefined) {
        throw invalidRequestError();
      }
      signal = signalValue as AbortSignal;
    }
    return {
      url: validateRequestUrl(rawUrl, true),
      headers: headers.values,
      sensitiveValues: headers.sensitiveValues,
      body,
      signal,
    };
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw invalidRequestError();
  }
}

function snapshotHeaders(input: unknown): {
  values: Readonly<Record<string, string>>;
  sensitiveValues: readonly string[];
} {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalidRequestError();
  }
  const prototype = Reflect.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalidRequestError();
  }
  const keys = Reflect.ownKeys(input);
  if (keys.length > MAX_REQUEST_HEADERS) throw invalidRequestError();
  const values = Object.create(null) as Record<string, string>;
  const sensitiveValues: string[] = [];
  const normalizedNames = new Set<string>();
  let totalBytes = 0;
  for (const key of keys) {
    if (typeof key !== "string" || !HEADER_NAME.test(key)) {
      throw invalidRequestError();
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") {
      throw invalidRequestError();
    }
    const name = key.toLowerCase();
    const value = descriptor.value;
    if (
      normalizedNames.has(name) ||
      BLOCKED_REQUEST_HEADERS.has(name) ||
      DANGEROUS_OBJECT_KEYS.has(name) ||
      hasControlCharacters(value)
    ) throw invalidRequestError();
    const valueBytes = Buffer.byteLength(value, "utf8");
    totalBytes += Buffer.byteLength(key, "utf8") + valueBytes;
    if (
      valueBytes > MAX_HEADER_VALUE_BYTES ||
      totalBytes > MAX_REQUEST_HEADER_BYTES
    ) throw invalidRequestError();
    normalizedNames.add(name);
    Object.defineProperty(values, key, {
      configurable: false,
      enumerable: true,
      value,
      writable: false,
    });
    if (isSensitiveHeader(name)) {
      appendUnique(sensitiveValues, value);
      const credential = structuredCredential(value);
      if (credential) appendUnique(sensitiveValues, credential);
    }
  }
  return {
    values: Object.freeze(values),
    sensitiveValues: Object.freeze(sensitiveValues),
  };
}

function normalizeLimits(options: NodeAiStreamingTransportOptions): TransportLimits {
  return Object.freeze({
    timeoutMs: boundedOption(
      options.timeoutMs,
      DEFAULT_AI_STREAM_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    ),
    maxResponseBytes: boundedOption(
      options.maxResponseBytes,
      MAX_AI_STREAM_RESPONSE_BYTES,
      MAX_AI_STREAM_RESPONSE_BYTES,
    ),
    maxResponseChunks: boundedOption(
      options.maxResponseChunks,
      MAX_AI_STREAM_RESPONSE_CHUNKS,
      MAX_AI_STREAM_RESPONSE_CHUNKS,
    ),
    maxJsonBodyBytes: boundedOption(
      options.maxJsonBodyBytes,
      MAX_AI_STREAM_JSON_BODY_BYTES,
      MAX_AI_STREAM_JSON_BODY_BYTES,
    ),
    maxRedirects: boundedOption(
      options.maxRedirects,
      MAX_AI_STREAM_REDIRECTS,
      MAX_AI_STREAM_REDIRECTS,
      true,
    ),
  });
}

function boundedOption(
  value: number | undefined,
  fallback: number,
  maximum: number,
  allowZero = false,
): number {
  if (value === undefined) return fallback;
  if (
    !Number.isSafeInteger(value) ||
    value < (allowZero ? 0 : 1) ||
    value > maximum
  ) throw invalidRequestError();
  return value;
}

function validateRequestUrl(raw: string, initial: boolean): URL {
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    raw.length > MAX_URL_CHARACTERS ||
    hasControlOrWhitespace(raw) ||
    raw.includes("\\")
  ) throw initial ? invalidRequestError() : networkError();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw initial ? invalidRequestError() : networkError();
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.hostname === "" ||
    url.port === "0" ||
    url.hash !== ""
  ) throw initial ? invalidRequestError() : networkError();
  if (url.protocol === "http:" && !hasExactRawLoopbackAuthority(raw, url)) {
    throw initial ? invalidRequestError() : networkError();
  }
  return url;
}

function hasExactRawLoopbackAuthority(raw: string, parsed: URL): boolean {
  const match = /^http:\/\/([^/?#]+)/iu.exec(raw);
  if (!match) return false;
  const authority = match[1];
  if (!authority || authority.includes("@") || authority.startsWith("[")) {
    return false;
  }
  const colon = authority.lastIndexOf(":");
  const rawHostname = (colon >= 0 ? authority.slice(0, colon) : authority).toLowerCase();
  if (rawHostname.includes(":")) return false;
  return (
    (rawHostname === "localhost" || rawHostname === "127.0.0.1") &&
    parsed.hostname.toLowerCase() === rawHostname
  );
}

function declaredContentLength(response: IncomingMessage): number | undefined {
  const raw = response.headers["content-length"];
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !/^(0|[1-9][0-9]*)$/u.test(raw)) {
    throw malformedProviderResponse();
  }
  const length = Number(raw);
  if (!Number.isSafeInteger(length) || length < 0) {
    throw providerResponseTooLarge();
  }
  return length;
}

function responseRequestId(
  response: IncomingMessage,
  sensitiveValues: readonly string[],
): string | undefined {
  const raw = response.headers["x-request-id"] ?? response.headers["request-id"];
  const requestId = safeSingleHeader(raw, MAX_REQUEST_ID_CHARACTERS)?.trim();
  if (!requestId || hasControlCharacters(requestId)) return undefined;
  for (const secret of sensitiveValues) {
    if (secret && (requestId === secret || requestId.includes(secret))) {
      return undefined;
    }
  }
  return requestId;
}

function safeSingleHeader(
  value: string | readonly string[] | undefined,
  maximum: number,
): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    hasControlCharacters(value)
  ) return undefined;
  return value;
}

function normalizedContentType(value: string | undefined): string {
  if (!value) return "";
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mediaType === "text/event-stream" || mediaType === "application/json"
    ? mediaType
    : "";
}

function responseResult(
  status: number,
  headers: Record<string, string>,
  contentType: string,
  requestId?: string,
  bodyText?: string,
): AiStreamingTransportResponse {
  const result: AiStreamingTransportResponse = {
    status,
    headers: Object.freeze({ ...headers }),
    contentType,
  };
  if (requestId !== undefined) result.requestId = requestId;
  if (bodyText !== undefined) result.bodyText = bodyText;
  return Object.freeze(result);
}

function safeBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  throw malformedProviderResponse();
}

function installTerminalErrorSink(
  emitter: ClientRequest | IncomingMessage | undefined,
): void {
  if (!emitter || emitter.closed) return;
  const sink = (): void => undefined;
  const remove = (): void => {
    try {
      emitter.off("error", sink);
      emitter.off("close", remove);
    } catch {
      // The emitter is already closed.
    }
  };
  try {
    emitter.on("error", sink);
    emitter.once("close", remove);
    if (emitter.closed) remove();
  } catch {
    // A closing emitter may reject listener installation.
  }
}

function safelyDestroy(
  stream: ClientRequest | IncomingMessage | undefined,
): void {
  try {
    stream?.destroy();
  } catch {
    // The promise has already settled with a stable public result or error.
  }
}

function isSensitiveHeader(name: string): boolean {
  return name === "authorization" ||
    name === "x-api-key" ||
    name.endsWith("-api-key") ||
    name.includes("token");
}

function structuredCredential(value: string): string | undefined {
  const separator = value.indexOf(" ");
  if (separator <= 0 || !HEADER_NAME.test(value.slice(0, separator))) {
    return undefined;
  }
  const credential = value.slice(separator + 1).trim();
  return credential || undefined;
}

function appendUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

function hasControlOrWhitespace(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code <= 32 || (code >= 127 && code <= 159))) {
      return true;
    }
  }
  return false;
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

function invalidRequestError(): ProviderError {
  return new ProviderError("invalid-request", "The AI provider request is invalid.");
}

function networkError(): ProviderError {
  return new ProviderError(
    "network-failure",
    "The AI provider network request failed.",
  );
}

function timeoutError(): ProviderError {
  return new ProviderError("timeout", "The AI provider request timed out.");
}
