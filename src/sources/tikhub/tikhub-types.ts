export type TikHubSearchType = "Latest" | "Top";

export interface TikHubResult<T> {
  data: T;
  requestId?: string;
}

export interface TikHubEnvelope<T = unknown> {
  code: number;
  data?: T;
  request_id?: unknown;
  requestId?: unknown;
}

export type TikHubClientErrorCode =
  | "missing-key"
  | "invalid-key"
  | "insufficient-balance"
  | "rate-limited"
  | "invalid-query"
  | "provider-failure"
  | "provider-rejected"
  | "network-failure"
  | "malformed-response"
  | "timeout"
  | "aborted"
  | "invalid-batch";

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function safeTikHubRequestId(
  value: unknown,
  currentApiKey: string,
): string | undefined {
  return typeof value === "string" &&
    SAFE_REQUEST_ID.test(value) &&
    !value.includes(currentApiKey)
    ? value
    : undefined;
}

/** Returns a canonical HTTPS origin, or undefined for any URL with extra components. */
export function normalizeTikHubBaseUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const candidate = value.trim();
  if (!/^https:\/\/[^\s/?#\\]+\/?$/i.test(candidate)) return undefined;

  try {
    const url = new URL(candidate);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.pathname !== "" && url.pathname !== "/") ||
      url.search ||
      url.hash
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}
