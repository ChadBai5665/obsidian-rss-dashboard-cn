export type ProviderErrorCode =
  | "missing-key"
  | "invalid-connection"
  | "connection-disabled"
  | "invalid-request"
  | "invalid-key"
  | "insufficient-balance"
  | "timeout"
  | "rate-limited"
  | "provider-failure"
  | "provider-rejected"
  | "network-failure"
  | "aborted"
  | "malformed-response"
  | "empty-output"
  | "secret-store-failure";

/** A deliberately small, static public error projection. */
export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly status?: number,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export function providerErrorForStatus(
  status: number,
  requestId?: string,
): ProviderError {
  if (status === 400) {
    return new ProviderError(
      "invalid-request",
      "The AI provider rejected the request or model.",
      status,
      requestId,
    );
  }
  if (status === 401 || status === 403) {
    return new ProviderError(
      "invalid-key",
      "AI provider authentication failed.",
      status,
      requestId,
    );
  }
  if (status === 402) {
    return new ProviderError(
      "insufficient-balance",
      "The AI provider account balance is insufficient.",
      status,
      requestId,
    );
  }
  if (status === 408 || status === 504) {
    return new ProviderError(
      "timeout",
      "The AI provider request timed out.",
      status,
      requestId,
    );
  }
  if (status === 429) {
    return new ProviderError(
      "rate-limited",
      "The AI provider rate limit was reached.",
      status,
      requestId,
    );
  }
  if (status >= 500) {
    return new ProviderError(
      "provider-failure",
      "The AI provider is unavailable.",
      status,
      requestId,
    );
  }
  return new ProviderError(
    "provider-rejected",
    "The AI provider rejected the request.",
    status,
    requestId,
  );
}

export function abortedProviderError(): ProviderError {
  return new ProviderError("aborted", "The AI provider request was cancelled.");
}

export function malformedProviderResponse(): ProviderError {
  return new ProviderError(
    "malformed-response",
    "The AI provider returned an invalid response.",
  );
}
