const MAX_INPUT_CHARACTERS = 2_048;
const HTTP_PROTOCOLS = new Set(["http:", "https:"]);
const X_HOSTS = new Set([
  "x.com",
  "www.x.com",
  "twitter.com",
  "www.twitter.com",
]);
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
]);
const X_RESERVED_PATHS = new Set([
  "home",
  "explore",
  "search",
  "notifications",
  "messages",
  "settings",
  "i",
  "intent",
]);
const X_HANDLE = /^[a-z0-9_]{1,15}$/u;
const YOUTUBE_CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/u;
const YOUTUBE_HANDLE = /^[\p{L}\p{N}._-]+$/u;

export type YouTubeIdentifier =
  | { kind: "handle"; value: string }
  | { kind: "channel-id"; value: string }
  | { kind: "channel-url"; value: string };

export type SourceIdentifierErrorCode =
  | "input-empty"
  | "input-too-long"
  | "input-unsafe"
  | "url-invalid"
  | "url-not-http"
  | "url-credentials"
  | "x-unsupported-host"
  | "x-not-profile"
  | "x-invalid-handle"
  | "youtube-unsupported-host"
  | "youtube-not-channel"
  | "youtube-invalid-handle";

/** A localization-safe failure code that never includes user-provided input. */
export class SourceIdentifierError extends Error {
  constructor(readonly code: SourceIdentifierErrorCode) {
    super(code);
    this.name = "SourceIdentifierError";
  }
}

export function normalizeRssWebsiteInput(input: string): URL {
  return parseHttpUrl(input);
}

export function normalizeXAccountInput(input: string): string {
  const candidate = normalizeInput(input);
  if (looksLikeUrl(candidate)) {
    const url = parseHttpUrl(candidate);
    if (!X_HOSTS.has(url.hostname)) {
      throw sourceError("x-unsupported-host");
    }

    const path = pathSegments(url);
    if (path.length !== 1 || X_RESERVED_PATHS.has(path[0].toLowerCase())) {
      throw sourceError("x-not-profile");
    }
    return normalizeXHandle(path[0]);
  }

  return normalizeXHandle(
    candidate.startsWith("@") ? candidate.slice(1) : candidate,
  );
}

export function normalizeYouTubeInput(input: string): YouTubeIdentifier {
  const candidate = normalizeInput(input);
  if (!looksLikeUrl(candidate)) {
    if (YOUTUBE_CHANNEL_ID.test(candidate)) {
      return { kind: "channel-id", value: candidate };
    }
    return {
      kind: "handle",
      value: normalizeYouTubeHandle(stripAt(candidate)),
    };
  }

  const url = parseHttpUrl(candidate);
  if (!YOUTUBE_HOSTS.has(url.hostname)) {
    throw sourceError("youtube-unsupported-host");
  }

  const path = pathSegments(url);
  if (path.length === 1 && path[0].startsWith("@")) {
    return { kind: "handle", value: normalizeYouTubeHandle(path[0].slice(1)) };
  }
  if (
    path.length === 2 &&
    path[0] === "channel" &&
    YOUTUBE_CHANNEL_ID.test(path[1])
  ) {
    return {
      kind: "channel-url",
      value: `https://www.youtube.com/channel/${path[1]}`,
    };
  }
  if (
    path.length === 2 &&
    (path[0] === "c" || path[0] === "user") &&
    isSafeChannelPath(path[1])
  ) {
    return {
      kind: "channel-url",
      value: `https://www.youtube.com/${path[0]}/${path[1]}`,
    };
  }

  throw sourceError("youtube-not-channel");
}

function normalizeInput(input: string): string {
  if (input.length > MAX_INPUT_CHARACTERS) throw sourceError("input-too-long");
  if (!input || hasUnsafeCharacters(input)) throw sourceError("input-unsafe");

  const normalized = input.normalize("NFC");
  if (!normalized) throw sourceError("input-empty");
  return normalized;
}

function parseHttpUrl(input: string): URL {
  const candidate = normalizeInput(input);
  let decoded: string;
  try {
    decoded = decodeURIComponent(candidate);
  } catch {
    throw sourceError("url-invalid");
  }
  if (hasUnsafeCharacters(decoded) || decoded.includes("\\")) {
    throw sourceError("input-unsafe");
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw sourceError("url-invalid");
  }
  if (!HTTP_PROTOCOLS.has(url.protocol) || !url.hostname) {
    throw sourceError("url-not-http");
  }
  if (url.username || url.password) throw sourceError("url-credentials");
  return url;
}

function normalizeXHandle(value: string): string {
  const handle = value.normalize("NFC").toLowerCase();
  if (!X_HANDLE.test(handle)) throw sourceError("x-invalid-handle");
  return handle;
}

function normalizeYouTubeHandle(value: string): string {
  const handle = value.normalize("NFC");
  const length = Array.from(handle).length;
  if (length < 3 || length > 30 || !YOUTUBE_HANDLE.test(handle)) {
    throw sourceError("youtube-invalid-handle");
  }
  return handle;
}

function stripAt(value: string): string {
  return value.startsWith("@") ? value.slice(1) : value;
}

function isSafeChannelPath(value: string): boolean {
  return Array.from(value).length <= 100 && /^[\p{L}\p{N}._-]+$/u.test(value);
}

function pathSegments(url: URL): string[] {
  return url.pathname.split("/").filter(Boolean).map(decodePathSegment);
}

function decodePathSegment(segment: string): string {
  try {
    const decoded = decodeURIComponent(segment).normalize("NFC");
    if (!decoded || hasUnsafeCharacters(decoded))
      throw sourceError("input-unsafe");
    return decoded;
  } catch (error) {
    if (error instanceof SourceIdentifierError) throw error;
    throw sourceError("url-invalid");
  }
}

function hasUnsafeCharacters(value: string): boolean {
  return /[\p{C}\s]/u.test(value);
}

function looksLikeUrl(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(value);
}

function sourceError(code: SourceIdentifierErrorCode): SourceIdentifierError {
  return new SourceIdentifierError(code);
}
