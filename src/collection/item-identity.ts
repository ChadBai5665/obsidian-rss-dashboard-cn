import { createHash } from "crypto";

const TRACKING_PARAMETER_NAMES = new Set(["fbclid", "gclid"]);

export function canonicalizeUrl(rawUrl: string): string {
  let parsed: URL;

  try {
    parsed = new URL(rawUrl);
  } catch {
    return "";
  }

  parsed.hostname = parsed.hostname.toLowerCase();
  parsed.hash = "";

  if (
    (parsed.protocol === "http:" && parsed.port === "80") ||
    (parsed.protocol === "https:" && parsed.port === "443")
  ) {
    parsed.port = "";
  }

  const parameters = Array.from(parsed.searchParams.entries())
    .filter(([name]) => !isTrackingParameter(name))
    .sort(([leftName, leftValue], [rightName, rightValue]) => {
      if (leftName === rightName) {
        return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
      }

      return leftName < rightName ? -1 : 1;
    });

  parsed.search = "";
  for (const [name, value] of parameters) {
    parsed.searchParams.append(name, value);
  }

  return parsed.toString();
}

export function createCollectedItemId(input: {
  sourceId: string;
  guid?: string;
  url?: string;
  title: string;
  author?: string;
  publishedAt?: string;
}): string {
  const canonicalUrl = input.url ? canonicalizeUrl(input.url) : "";
  const guid = input.guid?.trim();
  const sourceId = normalizeText(input.sourceId);

  const identity = canonicalUrl
    ? ["url", canonicalUrl]
    : guid
      ? ["guid", sourceId, guid]
      : [
          "fallback",
          sourceId,
          normalizeText(input.title),
          normalizeText(input.author ?? ""),
          normalizePublishedAt(input.publishedAt),
        ];

  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

function isTrackingParameter(name: string): boolean {
  const normalizedName = name.toLowerCase();
  return (
    normalizedName.startsWith("utm_") ||
    TRACKING_PARAMETER_NAMES.has(normalizedName)
  );
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizePublishedAt(value: string | undefined): string {
  if (!value) {
    return "";
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? normalizeText(value)
    : parsed.toISOString();
}
