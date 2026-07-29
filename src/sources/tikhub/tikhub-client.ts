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
import type {
  TikHubBudgetReservation,
  TikHubRequestBudgetLike,
} from "./request-budget";

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
  signal?: AbortSignal;
}

export interface TikHubUserRequest extends CommonRequestInput {
  handle: string;
  cursor?: string;
}

export interface TikHubAccountRequest {
  apiKey: string;
  signal?: AbortSignal;
}

export interface TikHubSearchRequest extends CommonRequestInput {
  query: string;
  searchType: TikHubSearchType;
  cursor?: string;
  /** Opaque client-owned topic-search capability. */
  batch?: TikHubBatchHandle;
}

export interface TikHubYouTubeCaptionRequest {
  apiKey: string;
  videoId: string;
  languageCode?: string;
  format?: "txt";
  signal?: AbortSignal;
}

export interface TikHubYouTubeCaptionResultRequest {
  apiKey: string;
  jobId: string;
  format: "txt";
  signal?: AbortSignal;
}

declare const batchHandleType: unique symbol;
export type TikHubBatchHandle = object & {
  readonly [batchHandleType]: "TikHubBatchHandle";
};

interface TikHubBatchState {
  budget: TikHubRequestBudgetLike;
  reservation: TikHubBudgetReservation;
  total: number;
  markAttempted: () => void;
  releaseUnused: () => Promise<number>;
}

const BATCH_BRAND = Symbol("tikhub-client-batch");
const MAX_TIKHUB_RESPONSE_TEXT_LENGTH = 5_000_000;
const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/u;
const YOUTUBE_LANGUAGE_CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const TIKHUB_JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

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
  private readonly batchBrand = Object.freeze({});
  private readonly activeBatchHandles = new WeakSet<object>();
  private readonly batchStates = new WeakMap<object, TikHubBatchState>();

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

  async verifyAccount(input: TikHubAccountRequest): Promise<void> {
    await this.request<void>(
      "/api/v1/tikhub/user/get_user_info",
      {},
      input,
      undefined,
      false,
    );
  }

  async fetchYouTubeCaptions<T = unknown>(
    input: TikHubYouTubeCaptionRequest,
  ): Promise<TikHubResult<T>> {
    const videoId = requirePattern(
      input.videoId,
      YOUTUBE_VIDEO_ID,
      "YouTube video ID",
    );
    const query: Record<string, string> = { video_id: videoId };
    if (input.languageCode !== undefined || input.format !== undefined) {
      const languageCode = requirePattern(
        input.languageCode,
        YOUTUBE_LANGUAGE_CODE,
        "YouTube caption language code",
      );
      if (input.format !== "txt") {
        throw new TikHubClientError(
          "invalid-query",
          "TikHub YouTube caption format is invalid.",
        );
      }
      query.language_code = languageCode;
      query.format = "txt";
    }
    return await this.request<T>(
      "/api/v1/youtube/web_v2/get_video_captions",
      query,
      input,
    );
  }

  async fetchYouTubeCaptionResult<T = unknown>(
    input: TikHubYouTubeCaptionResultRequest,
  ): Promise<TikHubResult<T>> {
    const jobId = requirePattern(input.jobId, TIKHUB_JOB_ID, "caption job ID");
    if (input.format !== "txt") {
      throw new TikHubClientError(
        "invalid-query",
        "TikHub YouTube caption format is invalid.",
      );
    }
    const result = await this.requestYouTubeCaptionResult<T>(jobId, input);
    requireMatchingCaptionJobId(result.data, jobId);
    return result;
  }

  async fetchUserPosts<T = unknown>(
    input: TikHubUserRequest,
  ): Promise<TikHubResult<T>> {
    return await this.request<T>(
      "/api/v1/twitter/web/fetch_user_post_tweet",
      withCursor(
        { screen_name: requireNonBlank(input.handle, "account handle") },
        input.cursor,
      ),
      input,
    );
  }

  async fetchUserProfile<T = unknown>(
    input: TikHubUserRequest,
  ): Promise<TikHubResult<T>> {
    return await this.request<T>(
      "/api/v1/twitter/web/fetch_user_profile",
      withCursor(
        { screen_name: requireNonBlank(input.handle, "account handle") },
        input.cursor,
      ),
      input,
    );
  }

  async fetchUserReplies<T = unknown>(
    input: TikHubUserRequest,
  ): Promise<TikHubResult<T>> {
    return await this.request<T>(
      "/api/v1/twitter/web/fetch_user_tweet_replies",
      withCursor(
        { screen_name: requireNonBlank(input.handle, "account handle") },
        input.cursor,
      ),
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
      withCursor(
        { keyword: query, search_type: input.searchType },
        input.cursor,
      ),
      input,
      input.batch,
    );
  }

  /** Reserves an exact topic batch and returns a capability bound to this client. */
  async reserveBatch(count: 2 | 3): Promise<TikHubBatchHandle> {
    if (count !== 2 && count !== 3) throw invalidBatchError();
    const candidate = await this.budget.reserve(count);
    const state = snapshotBatchReservation(candidate, count, this.budget);
    if (!state) {
      await releaseMalformedReservation(candidate);
      throw invalidBatchError();
    }

    const handle = Object.create(null) as object;
    Object.defineProperty(handle, BATCH_BRAND, {
      value: this.batchBrand,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    Object.freeze(handle);
    this.activeBatchHandles.add(handle);
    this.batchStates.set(handle, state);
    return handle as TikHubBatchHandle;
  }

  /** Releases only the unused tail and permanently invalidates the handle. */
  async releaseBatch(handle: TikHubBatchHandle): Promise<number> {
    const state = this.requireBatchState(handle);
    this.activeBatchHandles.delete(handle);
    this.batchStates.delete(handle);
    try {
      const released = await state.releaseUnused();
      if (
        !Number.isSafeInteger(released) ||
        released < 0 ||
        currentBatchRemaining(state) !== 0
      ) throw invalidBatchError();
      return released;
    } catch {
      throw invalidBatchError();
    }
  }

  private async request<T>(
    endpoint: string,
    query: Record<string, string>,
    input: CommonRequestInput,
    batch?: TikHubBatchHandle,
    requireData = true,
  ): Promise<TikHubResult<T>> {
    const apiKey = input.apiKey.trim();
    if (!apiKey) {
      throw new TikHubClientError("missing-key", "TikHub API key is not configured.");
    }

    const url = new URL(endpoint, `${this.baseUrl}/`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);

    const batchState = batch === undefined
      ? undefined
      : this.requireBatchState(batch);
    const ownsReservation = batchState === undefined;
    const reservation = batchState?.reservation ?? await this.budget.reserve(1);
    try {
      if (input.signal?.aborted) throw abortedError();
      if (batchState) this.assertActiveBatch(batch as TikHubBatchHandle, batchState);
      else if (reservation.remaining <= 0) throw invalidBatchError();

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
      if (batchState) {
        this.commitBatchAttempt(batch as TikHubBatchHandle, batchState);
      } else {
        reservation.markAttempted();
      }

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
      return this.projectResponse<T>(response, apiKey, requireData);
    } finally {
      if (ownsReservation) await reservation.releaseUnused();
    }
  }

  /** The only budget-free request capability: fixed YouTube result polling. */
  private async requestYouTubeCaptionResult<T>(
    jobId: string,
    input: TikHubYouTubeCaptionResultRequest,
  ): Promise<TikHubResult<T>> {
    const apiKey = input.apiKey.trim();
    if (!apiKey) {
      throw new TikHubClientError("missing-key", "TikHub API key is not configured.");
    }
    const url = new URL(
      "/api/v1/youtube/web_v2/get_video_captions_result",
      `${this.baseUrl}/`,
    );
    url.searchParams.set("job_id", jobId);
    url.searchParams.set("format", "txt");
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

    return this.projectResponse<T>(response, apiKey);
  }

  private projectResponse<T>(
    response: TikHubTransportResponse,
    apiKey: string,
    requireData = true,
  ): TikHubResult<T> {
    const extractedResponse = extractTransportResponse(response, apiKey);
    if (extractedResponse.status < 200 || extractedResponse.status >= 300) {
      throw errorForStatus(
        extractedResponse.status,
        extractedResponse.headerRequestId,
      );
    }

    let envelope: unknown;
    try {
      envelope = JSON.parse(extractedResponse.text);
    } catch {
      throw new TikHubClientError(
        "malformed-response",
        "TikHub returned malformed JSON.",
        extractedResponse.status,
        extractedResponse.headerRequestId,
      );
    }
    if (!isEnvelope(envelope)) {
      throw new TikHubClientError(
        "malformed-response",
        "TikHub returned an invalid response envelope.",
        extractedResponse.status,
        extractedResponse.headerRequestId,
      );
    }

    const requestId =
      safeTikHubRequestId(envelope.request_id, apiKey) ??
      safeTikHubRequestId(envelope.requestId, apiKey) ??
      extractedResponse.headerRequestId;
    if (envelope.code !== 200) {
      throw errorForProviderCode(envelope.code, requestId);
    }
    if (requireData && !("data" in envelope)) {
      throw new TikHubClientError(
        "malformed-response",
        "TikHub response data is missing.",
        extractedResponse.status,
        requestId,
      );
    }

    return requestId
      ? { data: envelope.data as T, requestId }
      : { data: envelope.data as T };
  }

  private requireBatchState(handle: TikHubBatchHandle): TikHubBatchState {
    if (
      (typeof handle !== "object" && typeof handle !== "function") ||
      handle === null
    ) throw invalidBatchError();
    let brand: PropertyDescriptor | undefined;
    try {
      brand = Object.getOwnPropertyDescriptor(handle, BATCH_BRAND);
    } catch {
      throw invalidBatchError();
    }
    const state = this.batchStates.get(handle);
    if (
      !brand ||
      !("value" in brand) ||
      brand.value !== this.batchBrand ||
      !this.activeBatchHandles.has(handle) ||
      !state ||
      state.budget !== this.budget
    ) throw invalidBatchError();
    return state;
  }

  private assertActiveBatch(
    handle: TikHubBatchHandle,
    state: TikHubBatchState,
  ): void {
    const remaining = currentBatchRemaining(state);
    if (
      this.requireBatchState(handle) !== state ||
      !Number.isSafeInteger(remaining) ||
      remaining <= 0
    ) {
      throw invalidBatchError();
    }
  }

  private commitBatchAttempt(
    handle: TikHubBatchHandle,
    state: TikHubBatchState,
  ): void {
    this.assertActiveBatch(handle, state);
    const before = currentBatchRemaining(state);
    try {
      state.markAttempted();
    } catch {
      throw invalidBatchError();
    }
    if (currentBatchRemaining(state) !== before - 1) throw invalidBatchError();
  }
}

function snapshotBatchReservation(
  value: unknown,
  expected: number,
  budget: TikHubRequestBudgetLike,
): TikHubBatchState | undefined {
  try {
    if (typeof value !== "object" || value === null) return undefined;
    const total = Object.getOwnPropertyDescriptor(value, "total");
    const remaining = Object.getOwnPropertyDescriptor(value, "remaining");
    const markAttempted = Object.getOwnPropertyDescriptor(value, "markAttempted");
    const releaseUnused = Object.getOwnPropertyDescriptor(value, "releaseUnused");
    const totalValue: unknown = total && "value" in total ? total.value : undefined;
    const remainingValue: unknown = remaining && "value" in remaining
      ? remaining.value
      : undefined;
    const markAttemptedValue: unknown =
      markAttempted && "value" in markAttempted
        ? markAttempted.value
        : undefined;
    const releaseUnusedValue: unknown =
      releaseUnused && "value" in releaseUnused
        ? releaseUnused.value
        : undefined;
    if (
      totalValue !== expected ||
      remainingValue !== expected ||
      typeof markAttemptedValue !== "function" ||
      typeof releaseUnusedValue !== "function"
    ) return undefined;
    return {
      budget,
      reservation: value as TikHubBudgetReservation,
      total: expected,
      markAttempted: () => {
        Reflect.apply(markAttemptedValue, value, []);
      },
      releaseUnused: async () => {
        const released: unknown = await Reflect.apply(
          releaseUnusedValue,
          value,
          [],
        );
        return typeof released === "number" ? released : Number.NaN;
      },
    };
  } catch {
    return undefined;
  }
}

function currentBatchRemaining(state: TikHubBatchState): number {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(
      state.reservation,
      "remaining",
    );
    const remaining: unknown = descriptor && "value" in descriptor
      ? descriptor.value
      : undefined;
    return typeof remaining === "number" &&
      Number.isSafeInteger(remaining) &&
      remaining >= 0 &&
      remaining <= state.total
      ? remaining
      : Number.NaN;
  } catch {
    return Number.NaN;
  }
}

async function releaseMalformedReservation(value: unknown): Promise<void> {
  try {
    if (typeof value !== "object" || value === null) return;
    const descriptor = Object.getOwnPropertyDescriptor(value, "releaseUnused");
    const releaseUnused: unknown = descriptor && "value" in descriptor
      ? descriptor.value
      : undefined;
    if (typeof releaseUnused !== "function") {
      return;
    }
    await Reflect.apply(releaseUnused, value, []);
  } catch {
    // A malformed budget result remains rejected with a static client error.
  }
}

function invalidBatchError(): TikHubClientError {
  return new TikHubClientError(
    "invalid-batch",
    "TikHub batch reservation is invalid or inactive.",
  );
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
    let normalizedRequest: Promise<T>;
    try {
      normalizedRequest = Promise.resolve(request);
    } catch (error) {
      finish(() => reject(asTransportError(error)));
      return;
    }
    normalizedRequest.then(
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

function extractTransportResponse(
  response: unknown,
  apiKey: string,
): TikHubTransportResponse & { headerRequestId?: string } {
  try {
    const status = ownDataProperty(response, "status");
    const text = ownDataProperty(response, "text");
    const headers = ownDataProperty(response, "headers", true);
    if (
      typeof status !== "number" ||
      !Number.isInteger(status) ||
      status < 100 ||
      status > 599 ||
      typeof text !== "string" ||
      text.length > MAX_TIKHUB_RESPONSE_TEXT_LENGTH
    ) {
      throw new Error("invalid transport response");
    }

    let headerRequestId: string | undefined;
    if (headers !== undefined) {
      if (!isObjectRecord(headers)) throw new Error("invalid transport headers");
      for (const key of Object.getOwnPropertyNames(headers)) {
        if (key.toLowerCase() !== "x-request-id") continue;
        const value = ownDataProperty(headers, key);
        headerRequestId = safeTikHubRequestId(value, apiKey);
        break;
      }
    }

    return headerRequestId
      ? { status, text, headers: {}, headerRequestId }
      : { status, text, headers: {} };
  } catch {
    throw new TikHubClientError(
      "malformed-response",
      "TikHub returned an invalid transport response.",
    );
  }
}

function ownDataProperty(
  value: unknown,
  key: string,
  optional = false,
): unknown {
  if (!isObjectRecord(value)) throw new Error("invalid object");
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) {
    if (optional) return undefined;
    throw new Error("missing property");
  }
  if (!("value" in descriptor)) throw new Error("accessor property rejected");
  return descriptor.value;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function withCursor(
  query: Record<string, string>,
  cursor: string | undefined,
): Record<string, string> {
  const normalized = cursor?.trim();
  return normalized ? { ...query, cursor: normalized } : query;
}

function requirePattern(
  value: unknown,
  pattern: RegExp,
  label: string,
): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new TikHubClientError("invalid-query", `TikHub ${label} is invalid.`);
  }
  return value;
}

function requireMatchingCaptionJobId(value: unknown, expectedJobId: string): void {
  try {
    if (!isObjectRecord(value)) throw new Error("invalid caption result");
    const descriptor = Object.getOwnPropertyDescriptor(value, "job_id");
    if (
      !descriptor ||
      !("value" in descriptor) ||
      descriptor.value !== expectedJobId
    ) {
      throw new Error("invalid caption result");
    }
  } catch {
    throw new TikHubClientError(
      "malformed-response",
      "TikHub returned an invalid caption job result.",
    );
  }
}

function abortedError(): TikHubClientError {
  return new TikHubClientError("aborted", "TikHub request was cancelled.");
}
