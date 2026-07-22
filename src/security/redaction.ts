export interface SanitizedExternalError {
  code: string;
  message: string;
}

const MAX_PUBLIC_MESSAGE_LENGTH = 300;
const SENSITIVE_NAMES = "authorization|proxy-authorization|x-api-key|api[-_]?key|token";

/** Removes credentials and all URL query values before text reaches a UI or log. */
export function redactSensitiveText(input: string): string {
  const unfolded = input.replace(/\r?\n[ \t]+/g, " ");
  const withoutQueries = redactUrlQueries(unfolded);
  const withoutBearerTokens = withoutQueries.replace(
    /\bBearer\s+[^\s,;)}\]]+/gi,
    "Bearer [redacted]",
  );
  const withoutHeaderValues = withoutBearerTokens.replace(
    new RegExp(
      `\\b(${SENSITIVE_NAMES})\\s*[:=]\\s*[\\s\\S]*?(?=(?:[;,]\\s*(?:${SENSITIVE_NAMES})\\s*[:=])|[\\r\\n]|$)`,
      "gi",
    ),
    "$1: [redacted]",
  );

  return withoutHeaderValues.replace(/\s+/g, " ").trim();
}

/**
 * Maps arbitrary provider exceptions to a compact, credential-free public form.
 * It intentionally reads only status and message; response payloads are never
 * copied into the result.
 */
export function sanitizeExternalError(error: unknown): SanitizedExternalError {
  const status = extractStatus(error);
  const message = redactSensitiveText(stripResponseBody(extractMessage(error)))
    .slice(0, MAX_PUBLIC_MESSAGE_LENGTH)
    .trim();

  return {
    code: status === undefined ? "external-error" : `external-${status}`,
    message: message || "External provider request failed.",
  };
}

function redactUrlQueries(value: string): string {
  const withoutAbsolute = value.replace(/https?:\/\/[^\s"'<>]+/gi, redactUrl);
  return withoutAbsolute.replace(
    /(?<![\w-])(?:\.{1,2}\/|\/)?[\w.-]+(?:\/[\w./-]*)?\?[^\s"'<>]*/g,
    redactUrl,
  );
}

function redactUrl(rawUrl: string): string {
  const punctuation = /[),.;\]}]+$/.exec(rawUrl)?.[0] ?? "";
  const candidate = punctuation ? rawUrl.slice(0, -punctuation.length) : rawUrl;
  const questionMark = candidate.indexOf("?");
  return questionMark === -1 ? rawUrl : `${candidate.slice(0, questionMark)}${punctuation}`;
}

function extractStatus(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  const directStatus = ownNumber(error, "status");
  if (directStatus !== undefined) return directStatus;
  const response = ownRecord(error, "response");
  return response ? ownNumber(response, "status") : undefined;
}

function extractMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (!isRecord(error)) return "";
  return ownString(error, "message") ?? "";
}

function stripResponseBody(message: string): string {
  return message.replace(/\s+\b(?:response\s+body|response|body|data)\s*[:=][\s\S]*$/i, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ownRecord(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const candidate = ownValue(value, key);
  return isRecord(candidate) ? candidate : undefined;
}

function ownNumber(value: Record<string, unknown>, key: string): number | undefined {
  const candidate = ownValue(value, key);
  return typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 100 && candidate <= 599
    ? candidate
    : undefined;
}

function ownString(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = ownValue(value, key);
  return typeof candidate === "string" ? candidate : undefined;
}

function ownValue(value: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
}
