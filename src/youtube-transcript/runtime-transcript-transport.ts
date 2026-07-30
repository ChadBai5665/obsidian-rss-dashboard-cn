import { request as httpsRequest } from "node:https";
import { Buffer } from "node:buffer";
import type {
  TranscriptHttpResponse,
  TranscriptHttpTransport,
} from "./innertube-transcript-provider";

export interface RuntimeTranscriptResponse {
  readonly statusCode?: number;
  readonly headers: Readonly<
    Record<string, string | readonly string[] | undefined>
  >;
  on(event: "data", listener: (chunk: unknown) => void): this;
  on(event: "end", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  once(event: "close", listener: () => void): this;
  off(event: "data", listener: (chunk: unknown) => void): this;
  off(event: "end", listener: () => void): this;
  off(event: "error", listener: (error: Error) => void): this;
}

export interface RuntimeTranscriptRequest {
  on(event: "error", listener: (error: Error) => void): this;
  once(event: "close", listener: () => void): this;
  off(event: "error", listener: (error: Error) => void): this;
  armTimeout(timeoutMs: number, listener: () => void): this;
  disarmTimeout(): void;
  end(body?: string): void;
  destroy(error?: Error): void;
}

export type RuntimeTranscriptRequestFactory = (
  url: URL,
  options: {
    method: "GET" | "POST";
    headers: Readonly<Record<string, string>>;
  },
  onResponse: (response: RuntimeTranscriptResponse) => void,
) => RuntimeTranscriptRequest;

export interface RuntimeTranscriptTransportOptions {
  request?: RuntimeTranscriptRequestFactory;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

const MAX_URL_CHARACTERS = 8_192;
const MAX_REQUEST_BODY_BYTES = 2_000_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_REQUEST_HEADERS = 32;
const MAX_HEADER_VALUE_CHARACTERS = 8_192;
const DEFAULT_TIMEOUT_MS = 20_000;
const BLOCKED_REQUEST_HEADERS = new Set([
  "authorization",
  "connection",
  "cookie",
  "host",
  "proxy-authorization",
  "set-cookie",
  "transfer-encoding",
]);
const EXPOSED_RESPONSE_HEADERS = new Set(["content-type", "location"]);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;

const defaultRequest: RuntimeTranscriptRequestFactory = (
  url,
  options,
  onResponse,
) => {
  const client = httpsRequest(
    url,
    { method: options.method, headers: options.headers },
    onResponse,
  );
  const wrapper: RuntimeTranscriptRequest = {
    on: (event, listener) => {
      client.on(event, listener);
      return wrapper;
    },
    once: (event, listener) => {
      client.once(event, listener);
      return wrapper;
    },
    off: (event, listener) => {
      client.off(event, listener);
      return wrapper;
    },
    armTimeout: (timeoutMs, listener) => {
      client.setTimeout(timeoutMs, listener);
      return wrapper;
    },
    disarmTimeout: () => client.setTimeout(0),
    end: (body) => client.end(body),
    destroy: (error) => client.destroy(error),
  };
  return wrapper;
};

/**
 * Creates one bounded HTTPS request at a time. Redirect decisions stay inside
 * the transcript providers, where every Location is revalidated by boundary.
 */
export function createRuntimeTranscriptHttpTransport(
  options: RuntimeTranscriptTransportOptions = {},
): TranscriptHttpTransport {
  const requestFactory = options.request ?? defaultRequest;
  const timeoutMs = boundedPositiveInteger(
    options.timeoutMs,
    DEFAULT_TIMEOUT_MS,
    60_000,
  );
  const maxResponseBytes = boundedPositiveInteger(
    options.maxResponseBytes,
    MAX_RESPONSE_BYTES,
    MAX_RESPONSE_BYTES,
  );

  return async (input) => {
    const url = validateUrl(input.url);
    const headers = validateRequestHeaders(input.headers);
    if (input.method !== "GET" && input.method !== "POST") {
      throw new Error("Unsafe transcript request method");
    }
    if (
      input.body !== undefined &&
      Buffer.byteLength(input.body, "utf8") > MAX_REQUEST_BODY_BYTES
    ) {
      throw new Error("Transcript request body is too large");
    }
    if (input.signal?.aborted) {
      throw new Error("Transcript request aborted");
    }

    return await new Promise<TranscriptHttpResponse>((resolve, reject) => {
      let settled = false;
      let request: RuntimeTranscriptRequest | undefined;
      let response: RuntimeTranscriptResponse | undefined;
      let onResponseData: ((chunk: unknown) => void) | undefined;
      let onResponseEnd: (() => void) | undefined;
      let onResponseError: ((error: Error) => void) | undefined;
      let terminationRequested = false;
      let requestTerminationSinkInstalled = false;
      let responseTerminationSinkInstalled = false;
      const terminalErrorSink = (): void => undefined;
      const installTerminationSinks = (): void => {
        if (request && !requestTerminationSinkInstalled) {
          try {
            request.on("error", terminalErrorSink);
            requestTerminationSinkInstalled = true;
            request.once("close", () => {
              try {
                request?.off("error", terminalErrorSink);
              } catch {
                // The emitter is already terminating; no further action exists.
              }
              requestTerminationSinkInstalled = false;
            });
          } catch {
            // A closing request may reject listener installation.
          }
        }
        if (response && !responseTerminationSinkInstalled) {
          try {
            response.on("error", terminalErrorSink);
            responseTerminationSinkInstalled = true;
            response.once("close", () => {
              try {
                response?.off("error", terminalErrorSink);
              } catch {
                // The emitter is already terminating; no further action exists.
              }
              responseTerminationSinkInstalled = false;
            });
          } catch {
            // A closing response may reject listener installation.
          }
        }
      };
      const onRequestError = (error: Error): void => {
        terminate(stableError(error, "Transcript request failed"));
      };
      const cleanup = (): void => {
        input.signal?.removeEventListener("abort", onAbort);
        try {
          request?.disarmTimeout();
        } catch {
          // Cleanup remains best effort after the promise is already settled.
        }
        try {
          request?.off("error", onRequestError);
        } catch {
          // Cleanup remains best effort after the promise is already settled.
        }
        try {
          if (response && onResponseData) response.off("data", onResponseData);
          if (response && onResponseEnd) response.off("end", onResponseEnd);
          if (response && onResponseError) response.off("error", onResponseError);
        } catch {
          // Cleanup remains best effort after the promise is already settled.
        }
      };
      const finish = (
        error: Error | undefined,
        value?: TranscriptHttpResponse,
      ): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else if (value) resolve(value);
        else reject(new Error("Transcript request failed"));
      };
      const terminate = (error: Error): void => {
        if (settled) return;
        terminationRequested = true;
        installTerminationSinks();
        finish(error);
        safelyDestroy(request);
      };
      const onAbort = (): void => {
        if (settled) return;
        terminate(new Error("Transcript request aborted"));
      };

      try {
        request = requestFactory(
          url,
          { method: input.method, headers },
          (nextResponse) => {
            if (settled) return;
            response = nextResponse;
            try {
              const status = nextResponse.statusCode;
              if (!Number.isInteger(status) || status === undefined || status < 100 || status > 599) {
                terminate(new Error("Invalid transcript response status"));
                return;
              }
              const rawHeaders = nextResponse.headers;
              const responseHeaders = projectResponseHeaders(rawHeaders);
              const declaredLength = rawHeaders["content-length"];
              if (
                typeof declaredLength === "string" &&
                Number.parseInt(declaredLength, 10) > maxResponseBytes
              ) {
                terminate(new Error("Transcript response is too large"));
                return;
              }
              const chunks: Buffer[] = [];
              let bytes = 0;
              onResponseData = (chunk) => {
                if (settled) return;
                try {
                  const buffer = toBuffer(chunk);
                  bytes += buffer.byteLength;
                  if (bytes > maxResponseBytes) {
                    terminate(new Error("Transcript response is too large"));
                    return;
                  }
                  chunks.push(buffer);
                } catch (error) {
                  terminate(stableError(error, "Invalid transcript response body"));
                }
              };
              onResponseEnd = () => {
                if (settled) return;
                try {
                  finish(undefined, {
                    status,
                    headers: responseHeaders,
                    text: Buffer.concat(chunks, bytes).toString("utf8"),
                  });
                } catch (error) {
                  terminate(stableError(error, "Invalid transcript response body"));
                }
              };
              onResponseError = (error) => {
                if (settled) return;
                terminate(stableError(error, "Transcript response failed"));
              };
              nextResponse.on("data", onResponseData);
              nextResponse.on("end", onResponseEnd);
              nextResponse.on("error", onResponseError);
            } catch (error) {
              terminate(stableError(error, "Invalid transcript response headers"));
            }
          },
        );
        if (settled) {
          if (terminationRequested) {
            installTerminationSinks();
            safelyDestroy(request);
          }
          cleanup();
          return;
        }
        request.on("error", onRequestError);
        request.armTimeout(timeoutMs, () => {
          if (settled) return;
          terminate(new Error("Transcript request timed out"));
        });
        input.signal?.addEventListener("abort", onAbort, { once: true });
        if (input.signal?.aborted) {
          onAbort();
          return;
        }
        request.end(input.body);
      } catch (error) {
        terminate(stableError(error, "Transcript request failed"));
      }
    });
  };
}

function safelyDestroy(request: RuntimeTranscriptRequest | undefined): void {
  try {
    request?.destroy();
  } catch {
    // The transport promise has already been settled with a stable error.
  }
}

function validateUrl(raw: string): URL {
  if (raw.length === 0 || raw.length > MAX_URL_CHARACTERS) {
    throw new Error("Unsafe transcript request URL");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Unsafe transcript request URL");
  }
  const host = url.hostname.toLowerCase();
  const allowedHost =
    host === "youtube.com" ||
    host.endsWith(".youtube.com") ||
    host === "googlevideo.com" ||
    host.endsWith(".googlevideo.com");
  if (
    url.protocol !== "https:" ||
    !allowedHost ||
    url.username !== "" ||
    url.password !== "" ||
    (url.port !== "" && url.port !== "443") ||
    url.hash !== ""
  ) {
    throw new Error("Unsafe transcript request URL");
  }
  return url;
}

function validateRequestHeaders(
  input: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const entries = Object.entries(input);
  if (entries.length > MAX_REQUEST_HEADERS) {
    throw new Error("Unsafe transcript request headers");
  }
  const headers: Record<string, string> = {};
  let hasEncoding = false;
  for (const [name, value] of entries) {
    const lower = name.toLowerCase();
    if (
      !HEADER_NAME.test(name) ||
      BLOCKED_REQUEST_HEADERS.has(lower) ||
      typeof value !== "string" ||
      value.length > MAX_HEADER_VALUE_CHARACTERS ||
      /[\r\n\0]/u.test(value) ||
      (lower === "accept-encoding" && value.toLowerCase() !== "identity")
    ) {
      throw new Error("Unsafe transcript request headers");
    }
    if (lower === "accept-encoding") hasEncoding = true;
    headers[name] = value;
  }
  if (!hasEncoding) headers["Accept-Encoding"] = "identity";
  return Object.freeze(headers);
}

function projectResponseHeaders(
  input: Readonly<Record<string, string | readonly string[] | undefined>>,
): Record<string, string> {
  const projected: Record<string, string> = {};
  for (const [name, rawValue] of Object.entries(input)) {
    const lower = name.toLowerCase();
    if (!EXPOSED_RESPONSE_HEADERS.has(lower) || rawValue === undefined) continue;
    const value = Array.isArray(rawValue) ? rawValue.join(", ") : rawValue;
    if (
      typeof value !== "string" ||
      value.length > MAX_HEADER_VALUE_CHARACTERS ||
      /[\r\n\0]/u.test(value)
    ) {
      throw new Error("Invalid transcript response headers");
    }
    projected[lower] = value;
  }
  return projected;
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === "string") return Buffer.from(chunk, "utf8");
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  throw new Error("Invalid transcript response body");
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new Error("Invalid transcript transport limit");
  }
  return value;
}

function stableError(error: unknown, message: string): Error {
  return error instanceof Error && error.message === message
    ? error
    : new Error(message);
}
