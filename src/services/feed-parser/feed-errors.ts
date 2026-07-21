export const EMPTY_FEED_ERROR_MESSAGE =
  "Feed is valid, but it currently has no items or entries to import.";

export class EmptyFeedError extends Error {
  constructor(message = EMPTY_FEED_ERROR_MESSAGE) {
    super(message);
    this.name = "EmptyFeedError";
  }
}

export function isEmptyFeedError(error: unknown): error is EmptyFeedError {
  return (
    error instanceof EmptyFeedError ||
    (error instanceof Error && error.name === "EmptyFeedError")
  );
}

export function getFeedErrorMessage(error: unknown): string {
  if (isEmptyFeedError(error)) {
    return EMPTY_FEED_ERROR_MESSAGE;
  }

  return isTimeoutFeedError(error)
    ? "Source refresh timed out."
    : "Source refresh failed.";
}

export function formatFeedParseNoticeMessage(
  error: unknown,
  prefix = "Error parsing feed",
): string {
  if (isEmptyFeedError(error)) {
    return EMPTY_FEED_ERROR_MESSAGE;
  }

  return `${prefix}: ${getFeedErrorMessage(error)}`;
}

/** Convert an untrusted parser error into a fixed, non-sensitive UI message. */
export function parseFetchErrorMessage(error: unknown): string {
  if (isEmptyFeedError(error)) {
    return EMPTY_FEED_ERROR_MESSAGE;
  }
  return isTimeoutFeedError(error)
    ? "Source refresh timed out."
    : "Source refresh failed.";
}

export function isTimeoutFeedError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return message === "Timed out" || message === "Source refresh timed out.";
}
