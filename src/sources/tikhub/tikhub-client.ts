import { requestUrl } from "obsidian";
import type { TikHubSettings } from "../../types/types";
import type {
  TikHubClientErrorCode,
  TikHubEnvelope,
  TikHubResult,
  TikHubSearchType,
} from "./tikhub-types";
import {
  normalizeTikHubBaseUrl,
  safeTikHubRequestId,
} from "./tikhub-types";
import type { TikHubRequestBudgetLike } from "./request-budget";

export interface TikHubTransportRequest {
  url: string;
  method: "GET";
  headers: { Authorization: string };
}

export interface TikHubTransportResponse {
  status: number;
  text: string;
  headers?: Record<string, string>;
}

export type TikHubTransport = (
  request: TikHubTransportRequest,
) => Promise<TikHubTransportResponse>;

export interface TikHubClientOptions {
  baseUrl: TikHubSettings["baseUrl"];
  timeoutMs: number;
  budget: TikHubRequestBudgetLike;
  transport?: TikHubTransport;
}

interface CommonRequestInput {
  apiKey: string;
  cursor?: string;
  signal?: AbortSignal;
}

export interface TikHubUserRequest extends CommonRequestInput {
  handle: string;
}

export interface TikHubSearchRequest extends CommonRequestInput {
  query: string;
  searchType: TikHubSearchType;
}

export class TikHubClientError extends Error {
  constructor(
    readonly code: TikHubClientErrorCode,
    message: string,
    readonly status?: number,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "TikHubClientError";
  }
}

export class TikHubClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly budget: TikHubRequestBudgetLike;
  private readonly transport: TikHubTransport;

  constructor(options: TikHubClientOptions) {
    const baseUrl = normalizeTikHubBaseUrl(options.baseUrl);
    if (!baseUrl) throw new Error("TikHub base URL must be an HTTPS origin.");
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new Error("TikHub timeout must be a positive integer.");
    }
    this.baseUrl = baseUrl;
    this.timeoutMs = options.timeoutMs;
    this.budget = options.budget;
    this.transport = options.transport ?? obsidianTransport;
  }

  async fetchUserPosts<T = unknown>(
    input: TikHubUserRequest,
  ): Promise<TikHubResult<T>> {
    return await this.request<T>(
      "/api/v1/twitter/web/fetch_user_post_tweet",
      { screen_name: requireNonBlank(input.handle, "account handle") },
      input,
    );
  }

  async fetchUserReplies<T = unknown>(
    input: TikHubUserRequest,
  ): Promise<TikHubResult<T>> {
    return await this.request<T>(
      "/api/v1/twitter/web/fetch_user_tweet_replies",
      { screen_name: requireNonBlank(input.handle, "account handle") },
      input,
    );
  }

  async fetchSearchTimeline<T = unknown>(
    input: TikHubSearchRequest,
  ): Promise<TikHubResult<T>> {
    const query = requireNonBlank(input.query, "search query");
    if (input.searchType !== "Latest" && input.searchType !== "Top") {
      throw new TikHubClientError("invalid-query", "TikHub search type is invalid.");
    }
    return await this.request<T>(
      "/api/v1/twitter/web/fetch_search_timeline",
      { keyword: query, search_type: input.searchType },
      input,
    );
  }

  private async request<T>(
    endpoint: string,
    query: Record<string, string>,
    input: CommonRequestInput,
  ): Promise<TikHubResult<T>> {
    const apiKey = input.apiKey;
    if (!apiKey.trim()) {
      throw new TikHubClientError("missing-key", "TikHub API key is not configured.");
    }

    const url = new URL(endpoint, `${this.baseUrl}/`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    if (input.cursor?.trim()) url.searchParams.set("cursor", input.cursor.trim());

    const reservation = await this.budget.reserve(1);
    try {
      if (input.signal?.aborted) throw abortedError();

      let pendingRequest: Promise<TikHubTransportResponse>;
      try {
        pendingRequest = this.transport({
          url: url.toString(),
          method: "GET",
          headers: { Authorization: `Bearer ${apiKey}` },
        });
      } catch (error) {
        throw errorForTransportFailure(error);
      }
      reservation.markAttempted();
      let response: TikHubTransportResponse;
      try {
        response = await raceRequest(
          pendingRequest,
          this.timeoutMs,
          input.signal,
        );
      } catch (error) {
        if (isTikHubClientError(error)) throw error;
        throw errorForTransportFailure(error);
      }

      const headerRequestId = requestIdFromHeaders(response.headers);
      if (response.status < 200 || response.status >= 300) {
        throw errorForStatus(response.status, headerRequestId);
      }

      let envelope: unknown;
      try {
        envelope = JSON.parse(response.text);
      } catch {
        throw new TikHubClientError(
          "malformed-response",
          "TikHub returned malformed JSON.",
          response.status,
          headerRequestId,
        );
      }
      if (!isEnvelope(envelope)) {
        throw new TikHubClientError(
          "malformed-response",
          "TikHub returned an invalid response envelope.",
          response.status,
          headerRequestId,
        );
      }

      const requestId =
        safeTikHubRequestId(envelope.request_id) ??
        safeTikHubRequestId(envelope.requestId) ??
        headerRequestId;
      if (envelope.code !== 200) {
        throw errorForProviderCode(envelope.code, requestId);
      }
      if (!("data" in envelope)) {
        throw new TikHubClientError(
          "malformed-response",
          "TikHub response data is missing.",
          response.status,
          requestId,
        );
      }

      return requestId
        ? { data: envelope.data as T, requestId }
        : { data: envelope.data as T };
    } finally {
      await reservation.releaseUnused();
    }
  }
}

async function obsidianTransport(
  request: TikHubTransportRequest,
): Promise<TikHubTransportResponse> {
  const response = await requestUrl({
    url: request.url,
    method: request.method,
    headers: request.headers,
    throw: false,
  });
  return {
    status: response.status,
    text: response.text,
    headers: response.headers,
  };
}

function raceRequest<T>(
  request: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = () => finish(() => reject(abortedError()));
    const timeout = window.setTimeout(
      () =>
        finish(() =>
          reject(new TikHubClientError("timeout", "TikHub request timed out.")),
        ),
      timeoutMs,
    );

    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    request.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(asTransportError(error))),
    );
  });
}

function asTransportError(error: unknown): Error {
  const normalized = new Error("TikHub network request failed.");
  const status = extractStatus(error);
  return status === undefined ? normalized : Object.assign(normalized, { status });
}

function errorForProviderCode(code: number, requestId?: string): TikHubClientError {
  if (Number.isInteger(code) && code >= 100 && code <= 599) {
    return errorForStatus(code, requestId);
  }
  return new TikHubClientError(
    "provider-rejected",
    "TikHub rejected the request.",
    undefined,
    requestId,
  );
}

function errorForTransportFailure(error: unknown): TikHubClientError {
  const status = extractStatus(error);
  return status === undefined
    ? new TikHubClientError("network-failure", "TikHub network request failed.")
    : errorForStatus(status);
}

function errorForStatus(status: number, requestId?: string): TikHubClientError {
  if (status === 401 || status === 403) {
    return new TikHubClientError(
      "invalid-key",
      "TikHub authentication failed.",
      status,
      requestId,
    );
  }
  if (status === 402) {
    return new TikHubClientError(
      "insufficient-balance",
      "TikHub account balance is insufficient.",
      status,
      requestId,
    );
  }
  if (status === 429) {
    return new TikHubClientError(
      "rate-limited",
      "TikHub request rate limit reached.",
      status,
      requestId,
    );
  }
  if (status === 422) {
    return new TikHubClientError(
      "invalid-query",
      "TikHub rejected the request parameters.",
      status,
      requestId,
    );
  }
  if (status >= 500) {
    return new TikHubClientError(
      "provider-failure",
      "TikHub provider is unavailable.",
      status,
      requestId,
    );
  }
  return new TikHubClientError(
    "provider-rejected",
    "TikHub rejected the request.",
    status,
    requestId,
  );
}

function requestIdFromHeaders(
  headers: Record<string, string> | undefined,
): string | undefined {
  if (!headers) return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "x-request-id") return safeTikHubRequestId(value);
  }
  return undefined;
}

function isEnvelope(value: unknown): value is TikHubEnvelope {
  return isRecord(value) && typeof value.code === "number";
}

function extractStatus(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  try {
    const status = error.status;
    return typeof status === "number" && Number.isInteger(status) ? status : undefined;
  } catch {
    return undefined;
  }
}

function isTikHubClientError(error: unknown): error is TikHubClientError {
  try {
    return error instanceof TikHubClientError;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonBlank(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new TikHubClientError("invalid-query", `TikHub ${label} is required.`);
  }
  return normalized;
}

function abortedError(): TikHubClientError {
  return new TikHubClientError("aborted", "TikHub request was cancelled.");
}
