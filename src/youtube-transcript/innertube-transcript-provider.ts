import { parseTranscriptPayload } from "./transcript-parser";
import {
  assertYouTubeVideoId,
  YouTubeTranscriptError,
  type YouTubeCaptionTrack,
  type YouTubeTranscript,
} from "./transcript-types";

export interface TranscriptHttpRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface TranscriptHttpResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
}

export type TranscriptHttpTransport = (
  request: TranscriptHttpRequest,
) => Promise<TranscriptHttpResponse>;

interface InnerTubeSession {
  apiKey: string;
  webClientVersion: string;
  visitorData: string;
}

interface ClientDescriptor {
  clientName: "ANDROID" | "WEB" | "IOS";
  clientHeaderName: "1" | "3" | "5";
  clientVersion?: string;
  userAgent: string;
  extraContext?: Readonly<Record<string, string | number>>;
}

interface RegisteredTrack {
  videoId: string;
  snapshot: YouTubeCaptionTrack;
}

type RequestBoundary = "watch" | "player" | "caption";
type PlayerProjection =
  | { kind: "tracks"; tracks: YouTubeCaptionTrack[] }
  | { kind: "structurally-unsupported" };

const WATCH_PAGE_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";
const WATCH_URL_PREFIX = "https://www.youtube.com/watch?v=";
const PLAYER_URL_PREFIX = "https://www.youtube.com/youtubei/v1/player";
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_REDIRECTS = 3;
const MAX_TRACKS = 100;
const MAX_URL_CHARACTERS = 8_192;
const MAX_LANGUAGE_NAME_CHARACTERS = 200;
const PROVIDER_DEADLINE_MS = 20_000;

const CLIENTS: readonly ClientDescriptor[] = Object.freeze([
  Object.freeze({
    clientName: "ANDROID",
    clientHeaderName: "3",
    clientVersion: "20.10.38",
    userAgent:
      "com.google.android.youtube/20.10.38 (Linux; U; Android 14; en_US; Pixel 8 Pro; Build/AP1A.240405.002)",
    extraContext: Object.freeze({
      clientFormFactor: "SMALL_FORM_FACTOR",
      androidSdkVersion: 34,
      osName: "Android",
      osVersion: "14",
      platform: "MOBILE",
    }),
  }),
  Object.freeze({
    clientName: "WEB",
    clientHeaderName: "1",
    userAgent: WATCH_PAGE_USER_AGENT,
  }),
  Object.freeze({
    clientName: "IOS",
    clientHeaderName: "5",
    clientVersion: "20.10.4",
    userAgent:
      "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3 like Mac OS X; en_US)",
    extraContext: Object.freeze({
      deviceMake: "Apple",
      deviceModel: "iPhone16,2",
      osName: "iPhone",
      osVersion: "18.3.0.22D5054f",
      platform: "MOBILE",
    }),
  }),
]);

class ProviderDeadline {
  readonly signal: AbortSignal;

  private readonly controller = new AbortController();
  private readonly callerSignal: AbortSignal | undefined;
  private readonly onCallerAbort: () => void;
  private timeoutId: number | undefined;
  private cause: "caller" | "timeout" | undefined;
  private disposed = false;

  constructor(callerSignal: AbortSignal | undefined) {
    this.signal = this.controller.signal;
    this.callerSignal = callerSignal;
    this.onCallerAbort = () => this.abort("caller");

    if (callerSignal?.aborted) {
      this.abort("caller");
      return;
    }
    callerSignal?.addEventListener("abort", this.onCallerAbort, {
      once: true,
    });
    this.timeoutId = window.setTimeout(() => {
      this.timeoutId = undefined;
      this.abort("timeout");
    }, PROVIDER_DEADLINE_MS);
  }

  assertActive(): void {
    if (this.signal.aborted) throw stableError(this.failureCode());
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    this.assertActive();
    const pendingOperation = Promise.resolve().then(operation);
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(stableError(this.failureCode()));
      this.signal.addEventListener("abort", onAbort, { once: true });
      if (this.signal.aborted) onAbort();
    });
    try {
      return await Promise.race([pendingOperation, aborted]);
    } finally {
      if (onAbort) this.signal.removeEventListener("abort", onAbort);
    }
  }

  failureCode(): "aborted" | "timeout" {
    if (this.callerSignal?.aborted || this.cause === "caller") {
      return "aborted";
    }
    return "timeout";
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timeoutId !== undefined) {
      window.clearTimeout(this.timeoutId);
      this.timeoutId = undefined;
    }
    this.callerSignal?.removeEventListener("abort", this.onCallerAbort);
  }

  private abort(cause: "caller" | "timeout"): void {
    if (this.cause !== undefined) return;
    this.cause = cause;
    this.controller.abort();
  }
}

export class InnerTubeTranscriptProvider {
  private readonly registeredTracks = new WeakMap<
    YouTubeCaptionTrack,
    RegisteredTrack
  >();

  constructor(private readonly transport: TranscriptHttpTransport) {}

  async listTracks(
    requestedVideoId: string,
    signal?: AbortSignal,
  ): Promise<YouTubeCaptionTrack[]> {
    const videoId = assertYouTubeVideoId(requestedVideoId);
    const deadline = new ProviderDeadline(signal);
    try {
      deadline.assertActive();
      const watchUrl = `${WATCH_URL_PREFIX}${videoId}&hl=en&persist_hl=1&has_verified=1&bpctr=9999999999`;
      const watchResponse = await this.requestWithRedirects(
        {
          url: watchUrl,
          method: "GET",
          headers: watchHeaders(),
          body: undefined,
          signal: deadline.signal,
        },
        "watch",
        deadline,
      );
      const session = extractSession(watchResponse.text);

      for (const client of CLIENTS) {
        deadline.assertActive();
        const projection = await this.requestPlayer(
          videoId,
          session,
          client,
          deadline,
        );
        if (projection.kind === "structurally-unsupported") continue;
        for (const track of projection.tracks) {
          this.registeredTracks.set(track, {
            videoId,
            snapshot: track,
          });
        }
        return projection.tracks;
      }

      throw stableError("temporarily-unavailable");
    } catch (error) {
      throw normalizeFailure(error, deadline);
    } finally {
      deadline.dispose();
    }
  }

  async fetchTrack(
    track: YouTubeCaptionTrack,
    signal?: AbortSignal,
  ): Promise<YouTubeTranscript> {
    const deadline = new ProviderDeadline(signal);
    try {
      deadline.assertActive();
      const registered = this.registeredTracks.get(track);
      if (!registered || track !== registered.snapshot) {
        throw stableError("temporarily-unavailable");
      }

      const response = await this.requestWithRedirects(
        {
          url: registered.snapshot.url,
          method: "GET",
          headers: captionHeaders(registered.videoId),
          body: undefined,
          signal: deadline.signal,
        },
        "caption",
        deadline,
      );
      deadline.assertActive();
      const text = parseTranscriptPayload(
        registered.snapshot.format,
        response.text,
      );
      return {
        videoId: registered.videoId,
        languageCode: registered.snapshot.languageCode,
        languageName: registered.snapshot.languageName,
        isGenerated: registered.snapshot.isGenerated,
        provider: "innertube",
        text,
      };
    } catch (error) {
      throw normalizeFailure(error, deadline);
    } finally {
      deadline.dispose();
    }
  }

  private async requestPlayer(
    videoId: string,
    session: InnerTubeSession,
    client: ClientDescriptor,
    deadline: ProviderDeadline,
  ): Promise<PlayerProjection> {
    const clientVersion = client.clientVersion ?? session.webClientVersion;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Accept-Language": "en-US,en;q=0.9",
      "Content-Type": "application/json",
      Origin: "https://www.youtube.com",
      Referer: `${WATCH_URL_PREFIX}${videoId}`,
      "User-Agent": client.userAgent,
      "X-YouTube-Client-Name": client.clientHeaderName,
      "X-YouTube-Client-Version": clientVersion,
    };
    if (session.visitorData) {
      headers["X-Goog-Visitor-Id"] = session.visitorData;
    }

    const body = JSON.stringify({
      context: {
        client: {
          hl: "en",
          gl: "US",
          utcOffsetMinutes: 0,
          visitorData: session.visitorData,
          clientName: client.clientName,
          clientVersion,
          ...(client.extraContext ?? {}),
        },
        request: { useSsl: true },
      },
      videoId,
    });
    const playerUrl = new URL(PLAYER_URL_PREFIX);
    playerUrl.searchParams.set("key", session.apiKey);
    playerUrl.searchParams.set("prettyPrint", "false");
    const response = await this.requestWithRedirects(
      {
        url: playerUrl.toString(),
        method: "POST",
        headers,
        body,
        signal: deadline.signal,
      },
      "player",
      deadline,
    );
    return projectPlayerResponse(response.text, videoId);
  }

  private async requestWithRedirects(
    initialRequest: TranscriptHttpRequest,
    boundary: RequestBoundary,
    deadline: ProviderDeadline,
  ): Promise<TranscriptHttpResponse> {
    let request = snapshotRequest(initialRequest);
    validateOutboundUrl(request.url, boundary);

    for (
      let redirectCount = 0;
      redirectCount <= MAX_REDIRECTS;
      redirectCount += 1
    ) {
      deadline.assertActive();
      let response: TranscriptHttpResponse;
      try {
        response = validateResponse(
          await deadline.run(() => this.transport(request)),
        );
      } catch (error) {
        throw normalizeFailure(error, deadline);
      }
      deadline.assertActive();

      if (isRedirect(response.status)) {
        if (redirectCount === MAX_REDIRECTS || response.status === 303) {
          throw stableError("temporarily-unavailable");
        }
        const location = readHeader(response.headers, "location");
        if (!location || location.length > MAX_URL_CHARACTERS) {
          throw stableError("temporarily-unavailable");
        }
        let redirectedUrl: URL;
        try {
          redirectedUrl = new URL(location, request.url);
        } catch {
          throw stableError("temporarily-unavailable");
        }
        validateOutboundUrl(redirectedUrl.href, boundary);
        const priorOrigin = new URL(request.url).origin;
        request = snapshotRequest({
          ...request,
          url: redirectedUrl.href,
          headers:
            redirectedUrl.origin === priorOrigin
              ? request.headers
              : headersForCrossOriginRedirect(request.headers),
        });
        continue;
      }

      assertSuccessfulStatus(response.status);
      return response;
    }

    throw stableError("temporarily-unavailable");
  }
}

function watchHeaders(): Record<string, string> {
  return {
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    "User-Agent": WATCH_PAGE_USER_AGENT,
  };
}

function captionHeaders(videoId: string): Record<string, string> {
  return {
    Accept: "application/json,text/plain;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    Origin: "https://www.youtube.com",
    Referer: `${WATCH_URL_PREFIX}${videoId}`,
    "User-Agent": WATCH_PAGE_USER_AGENT,
  };
}

function snapshotRequest(
  request: TranscriptHttpRequest,
): TranscriptHttpRequest {
  return Object.freeze({
    url: request.url,
    method: request.method,
    headers: Object.freeze({ ...request.headers }),
    body: request.body,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
}

function headersForCrossOriginRedirect(
  headers: Record<string, string>,
): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (
      normalized === "authorization" ||
      normalized === "cookie" ||
      normalized === "origin" ||
      normalized === "referer" ||
      normalized.startsWith("x-")
    ) {
      continue;
    }
    safe[name] = value;
  }
  return safe;
}

function validateResponse(
  value: TranscriptHttpResponse,
): TranscriptHttpResponse {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.status) ||
    typeof value.text !== "string" ||
    !isRecord(value.headers)
  ) {
    throw stableError("temporarily-unavailable");
  }
  const contentLength = readHeader(value.headers, "content-length");
  if (
    contentLength !== undefined &&
    (!/^\d+$/u.test(contentLength) ||
      Number(contentLength) > MAX_RESPONSE_BYTES)
  ) {
    throw stableError("temporarily-unavailable");
  }
  if (
    value.text.length > MAX_RESPONSE_BYTES ||
    new TextEncoder().encode(value.text).byteLength > MAX_RESPONSE_BYTES
  ) {
    throw stableError("temporarily-unavailable");
  }
  return value;
}

function readHeader(
  headers: Record<string, string>,
  requestedName: string,
): string | undefined {
  for (const name of Object.getOwnPropertyNames(headers)) {
    if (name.toLowerCase() !== requestedName.toLowerCase()) continue;
    const descriptor = Object.getOwnPropertyDescriptor(headers, name);
    if (!descriptor || !("value" in descriptor)) return undefined;
    return typeof descriptor.value === "string" ? descriptor.value : undefined;
  }
  return undefined;
}

function isRedirect(status: number): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}

function assertSuccessfulStatus(status: number): void {
  if (status >= 200 && status < 300) return;
  if (status === 404 || status === 410) {
    throw stableError("video-unavailable");
  }
  if (status === 401 || status === 403) {
    throw stableError("login-required");
  }
  if (status === 408 || status === 504) throw stableError("timeout");
  throw stableError("temporarily-unavailable");
}

function validateOutboundUrl(
  urlValue: string,
  boundary: RequestBoundary,
): void {
  if (!urlValue || urlValue.length > MAX_URL_CHARACTERS) {
    throw stableError("temporarily-unavailable");
  }
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    throw stableError("temporarily-unavailable");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443")
  ) {
    throw stableError("temporarily-unavailable");
  }

  if (boundary === "caption") {
    if (!isCaptionHost(url.hostname) || url.pathname !== "/api/timedtext") {
      throw stableError("temporarily-unavailable");
    }
    return;
  }
  if (!isYouTubeHost(url.hostname)) {
    throw stableError("temporarily-unavailable");
  }
  if (boundary === "watch" && url.pathname !== "/watch") {
    throw stableError("temporarily-unavailable");
  }
  if (boundary === "player" && url.pathname !== "/youtubei/v1/player") {
    throw stableError("temporarily-unavailable");
  }
}

function isYouTubeHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "youtube.com" || host.endsWith(".youtube.com");
}

function isCaptionHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    isYouTubeHost(host) ||
    host === "googlevideo.com" ||
    host.endsWith(".googlevideo.com")
  );
}

function extractSession(html: string): InnerTubeSession {
  const apiKey = extractJsonString(html, "INNERTUBE_API_KEY");
  const webClientVersion =
    extractJsonString(html, "INNERTUBE_CLIENT_VERSION") ??
    extractJsonString(html, "clientVersion");
  const visitorData =
    extractJsonString(html, "VISITOR_DATA") ??
    extractJsonString(html, "visitorData") ??
    "";
  if (
    !apiKey ||
    !/^[A-Za-z0-9_-]{16,128}$/u.test(apiKey) ||
    !webClientVersion ||
    !/^[A-Za-z0-9._-]{1,64}$/u.test(webClientVersion) ||
    !/^[A-Za-z0-9._%=-]{0,512}$/u.test(visitorData)
  ) {
    throw stableError("temporarily-unavailable");
  }
  return { apiKey, webClientVersion, visitorData };
}

function extractJsonString(input: string, key: string): string | undefined {
  const expression = new RegExp(
    `"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`,
    "u",
  );
  const encoded = input.match(expression)?.[1];
  if (encoded === undefined || encoded.length > 1_024) return undefined;
  try {
    const value: unknown = JSON.parse(`"${encoded}"`);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function projectPlayerResponse(
  responseText: string,
  videoId: string,
): PlayerProjection {
  let value: unknown;
  try {
    value = JSON.parse(responseText);
  } catch {
    throw stableError("temporarily-unavailable");
  }
  if (!isRecord(value)) throw stableError("temporarily-unavailable");

  const playability = ownRecord(value, "playabilityStatus");
  if (!playability) return { kind: "structurally-unsupported" };
  const status = ownString(playability, "status");
  if (!status) return { kind: "structurally-unsupported" };
  if (status !== "OK") {
    throw mapPlayabilityFailure(status, collectPlayabilityReason(playability));
  }

  const captionsDescriptor = Object.getOwnPropertyDescriptor(value, "captions");
  if (!captionsDescriptor) throw stableError("no-captions");
  if (!("value" in captionsDescriptor) || !isRecord(captionsDescriptor.value)) {
    return { kind: "structurally-unsupported" };
  }
  const captions = captionsDescriptor.value;
  const renderer = ownRecord(captions, "playerCaptionsTracklistRenderer");
  if (!renderer) return { kind: "structurally-unsupported" };
  const rawTracks = ownValue(renderer, "captionTracks");
  if (!Array.isArray(rawTracks)) {
    return { kind: "structurally-unsupported" };
  }
  if (rawTracks.length === 0) throw stableError("no-captions");
  if (rawTracks.length > MAX_TRACKS) {
    throw stableError("temporarily-unavailable");
  }

  const tracks = rawTracks.map((track) => projectTrack(track, videoId));
  return { kind: "tracks", tracks };
}

function mapPlayabilityFailure(
  status: string,
  reason: string,
): YouTubeTranscriptError {
  const normalizedStatus = status.toUpperCase();
  const normalizedReason = reason.toLowerCase();
  if (
    normalizedReason.includes("bot") ||
    normalizedReason.includes("captcha") ||
    normalizedReason.includes("unusual traffic")
  ) {
    return stableError("temporarily-unavailable");
  }
  if (
    normalizedStatus === "LOGIN_REQUIRED" ||
    normalizedReason.includes("sign in") ||
    normalizedReason.includes("age")
  ) {
    return stableError("login-required");
  }
  if (
    normalizedStatus === "ERROR" ||
    normalizedStatus === "UNPLAYABLE" ||
    normalizedStatus === "LIVE_STREAM_OFFLINE" ||
    normalizedReason.includes("unavailable") ||
    normalizedReason.includes("private") ||
    normalizedReason.includes("removed")
  ) {
    return stableError("video-unavailable");
  }
  return stableError("temporarily-unavailable");
}

function collectPlayabilityReason(
  playability: Record<string, unknown>,
): string {
  const reason = ownString(playability, "reason") ?? "";
  if (reason.length > 1_000) return "";
  return reason;
}

function projectTrack(value: unknown, videoId: string): YouTubeCaptionTrack {
  if (!isRecord(value)) throw stableError("temporarily-unavailable");
  const baseUrl = ownString(value, "baseUrl");
  const languageCode = ownString(value, "languageCode");
  const languageName = readLanguageName(ownValue(value, "name"));
  const kind = ownValue(value, "kind");
  if (
    !baseUrl ||
    baseUrl.length > MAX_URL_CHARACTERS ||
    !languageCode ||
    !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u.test(languageCode) ||
    !languageName ||
    languageName.length > MAX_LANGUAGE_NAME_CHARACTERS ||
    (kind !== undefined && typeof kind !== "string")
  ) {
    throw stableError("temporarily-unavailable");
  }

  validatePlainText(languageName);
  validateOutboundUrl(baseUrl, "caption");
  const url = new URL(baseUrl);
  if (url.searchParams.get("v") !== videoId || url.searchParams.has("tlang")) {
    throw stableError("temporarily-unavailable");
  }
  url.searchParams.set("fmt", "json3");
  validateOutboundUrl(url.href, "caption");

  return Object.freeze({
    languageCode,
    languageName: languageName.normalize("NFC"),
    isGenerated: kind === "asr",
    source: "innertube",
    url: url.href,
    format: "json3",
  });
}

function readLanguageName(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const simpleText = ownString(value, "simpleText");
  if (simpleText) return simpleText;
  const runs = ownValue(value, "runs");
  if (!Array.isArray(runs) || runs.length === 0 || runs.length > 10) {
    return undefined;
  }
  let text = "";
  for (const run of runs) {
    if (!isRecord(run)) return undefined;
    const part = ownString(run, "text");
    if (!part) return undefined;
    text += part;
    if (text.length > MAX_LANGUAGE_NAME_CHARACTERS) return undefined;
  }
  return text;
}

function validatePlainText(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code <= 8 ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      (code >= 127 && code <= 159)
    ) {
      throw stableError("temporarily-unavailable");
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ownValue(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function ownRecord(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const candidate = ownValue(value, key);
  return isRecord(candidate) ? candidate : undefined;
}

function ownString(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const candidate = ownValue(value, key);
  return typeof candidate === "string" ? candidate : undefined;
}

function normalizeFailure(
  error: unknown,
  deadline: ProviderDeadline,
): YouTubeTranscriptError {
  if (deadline.signal.aborted) return stableError(deadline.failureCode());
  if (error instanceof YouTubeTranscriptError) return error;
  const name = readErrorField(error, "name");
  const code = readErrorField(error, "code");
  if (name === "AbortError" || code === "ABORT_ERR") {
    return stableError("aborted");
  }
  if (
    name === "TimeoutError" ||
    code === "ETIMEDOUT" ||
    code === "ESOCKETTIMEDOUT"
  ) {
    return stableError("timeout");
  }
  return stableError("temporarily-unavailable");
}

function readErrorField(error: unknown, key: string): string | undefined {
  if (!isRecord(error)) return undefined;
  const own = ownString(error, key);
  if (own !== undefined) return own;
  if (
    key === "name" &&
    typeof DOMException !== "undefined" &&
    error instanceof DOMException
  ) {
    return error.name;
  }
  return undefined;
}

function stableError(
  code: ConstructorParameters<typeof YouTubeTranscriptError>[0],
): YouTubeTranscriptError {
  return new YouTubeTranscriptError(code);
}
