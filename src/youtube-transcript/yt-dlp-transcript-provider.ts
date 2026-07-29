import { execFile as nodeExecFile } from "node:child_process";
import { constants } from "node:fs";
import { access as nodeAccess } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { env } from "node:process";
import { parseTranscriptPayload } from "./transcript-parser";
import {
  type TranscriptHttpRequest,
  type TranscriptHttpResponse,
  type TranscriptHttpTransport,
} from "./innertube-transcript-provider";
import {
  assertYouTubeVideoId,
  YouTubeTranscriptError,
  type YouTubeCaptionFormat,
  type YouTubeCaptionTrack,
  type YouTubeTranscript,
  type YouTubeTranscriptErrorCode,
} from "./transcript-types";

export interface ExecutableRunner {
  execFile(
    file: string,
    args: readonly string[],
    options: {
      timeout: number;
      maxBuffer: number;
      signal?: AbortSignal;
      certificateFile?: string;
    },
  ): Promise<{ stdout: string; stderr: string }>;
}

export type YtDlpExecutableAccess = (
  executablePath: string,
  mode: number,
) => Promise<void>;

export interface YtDlpTranscriptProviderOptions {
  runner?: ExecutableRunner;
  access?: YtDlpExecutableAccess;
  pathValue?: string;
  homeDirectory?: string;
  certificateFileValue?: string;
  cookiesFromBrowser?: () => "chrome" | "safari" | "firefox" | undefined;
}

interface RegisteredTrack {
  videoId: string;
  snapshot: YouTubeCaptionTrack;
}

type TrackKind = "manual" | "generated";

const WATCH_URL_PREFIX = "https://www.youtube.com/watch?v=";
const FIXED_ARGUMENTS_PREFIX = Object.freeze([
  "--dump-single-json",
  "--skip-download",
  "--no-warnings",
  "--no-playlist",
  "--socket-timeout",
  "15",
  "--",
] as const);
// Browser-cookie extraction can require a macOS keychain round trip before the
// normal network request. Keep this user-initiated fallback bounded, but do not
// abort it at the former 20-second boundary while YouTube is still responding.
const EXECUTION_TIMEOUT_MS = 45_000;
const MAX_PROCESS_BUFFER_BYTES = 2_000_000;
const MAX_METADATA_BYTES = 2_000_000;
const MAX_CAPTION_RESPONSE_BYTES = 2_000_000;
const CAPTION_ACTION_DEADLINE_MS = 20_000;
const MAX_REDIRECTS = 3;
const MAX_URL_CHARACTERS = 8_192;
// yt-dlp exposes YouTube's translated automatic-caption variants as separate
// language keys; current public videos can legitimately exceed 300 entries.
const MAX_LANGUAGES_PER_KIND = 500;
const MAX_FORMATS_PER_LANGUAGE = 50;
const MAX_LANGUAGE_CODE_CHARACTERS = 64;
const MAX_LANGUAGE_NAME_CHARACTERS = 200;
const FORMAT_PRIORITY: readonly YouTubeCaptionFormat[] = Object.freeze([
  "json3",
  "srv3",
  "vtt",
]);

const defaultRunner: ExecutableRunner = Object.freeze({
  execFile(
    file: string,
    args: readonly string[],
    options: {
      timeout: number;
      maxBuffer: number;
      signal?: AbortSignal;
      certificateFile?: string;
    },
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      nodeExecFile(
        file,
        [...args],
        {
          encoding: "utf8",
          shell: false,
          windowsHide: true,
          timeout: options.timeout,
          maxBuffer: options.maxBuffer,
          ...(options.certificateFile
            ? { env: { ...env, SSL_CERT_FILE: options.certificateFile } }
            : {}),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
        (error, stdout, stderr) => {
          if (error) {
            const failure: Error = error;
            reject(failure);
            return;
          }
          resolve({ stdout, stderr });
        },
      );
    });
  },
});

class CaptionActionDeadline {
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
    }, CAPTION_ACTION_DEADLINE_MS);
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

export class YtDlpTranscriptProvider {
  private readonly runner: ExecutableRunner;
  private readonly access: YtDlpExecutableAccess;
  private readonly pathValue: string;
  private readonly homeDirectory: string;
  private readonly certificateFileValue: string;
  private readonly cookiesFromBrowser: () =>
    | "chrome"
    | "safari"
    | "firefox"
    | undefined;
  private readonly registeredTracks = new WeakMap<
    YouTubeCaptionTrack,
    RegisteredTrack
  >();

  constructor(
    private readonly transport: TranscriptHttpTransport,
    options: YtDlpTranscriptProviderOptions = {},
  ) {
    this.runner = options.runner ?? defaultRunner;
    this.access = options.access ?? nodeAccess;
    this.pathValue = options.pathValue ?? env.PATH ?? "";
    this.homeDirectory = options.homeDirectory ?? homedir();
    this.certificateFileValue = options.certificateFileValue ??
      env.SSL_CERT_FILE ?? "";
    this.cookiesFromBrowser = options.cookiesFromBrowser ?? (() => undefined);
  }

  async isAvailable(): Promise<boolean> {
    return (await this.discoverExecutable()) !== undefined;
  }

  async listTracks(
    requestedVideoId: string,
    signal?: AbortSignal,
  ): Promise<YouTubeCaptionTrack[]> {
    const videoId = assertYouTubeVideoId(requestedVideoId);
    assertNotAborted(signal);

    try {
      const executable = await this.discoverExecutable();
      assertNotAborted(signal);
      if (!executable) throw stableError("temporarily-unavailable");
      const certificateFile = await this.discoverCertificateFile();
      assertNotAborted(signal);
      const browser = this.cookiesFromBrowser();
      const args = browser === undefined
        ? [...FIXED_ARGUMENTS_PREFIX, `${WATCH_URL_PREFIX}${videoId}`]
        : [
            ...FIXED_ARGUMENTS_PREFIX.slice(0, -1),
            "--cookies-from-browser",
            browser,
            "--",
            `${WATCH_URL_PREFIX}${videoId}`,
          ];

      let execution: { stdout: string; stderr: string } | undefined =
        await this.runner.execFile(
          executable,
          args,
          {
            timeout: EXECUTION_TIMEOUT_MS,
            maxBuffer: MAX_PROCESS_BUFFER_BYTES,
            ...(certificateFile ? { certificateFile } : {}),
            ...(signal === undefined ? {} : { signal }),
          },
        );
      assertNotAborted(signal);
      let stdout = validateExecution(execution);
      execution = undefined;
      let tracks: YouTubeCaptionTrack[];
      try {
        tracks = projectMetadata(stdout, videoId);
      } finally {
        stdout = "";
      }
      for (const track of tracks) {
        this.registeredTracks.set(track, { videoId, snapshot: track });
      }
      return tracks;
    } catch (error) {
      throw normalizeFailure(error, signal);
    }
  }

  async fetchTrack(
    track: YouTubeCaptionTrack,
    signal?: AbortSignal,
  ): Promise<YouTubeTranscript> {
    const deadline = new CaptionActionDeadline(signal);
    try {
      deadline.assertActive();
      const registered = this.registeredTracks.get(track);
      if (!registered || track !== registered.snapshot) {
        throw stableError("temporarily-unavailable");
      }

      const response = await requestCaptionWithRedirects(
        this.transport,
        registered.snapshot.url,
        registered.videoId,
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
        provider: "yt-dlp",
        text,
      };
    } catch (error) {
      throw normalizeCaptionFailure(error, deadline);
    } finally {
      deadline.dispose();
    }
  }

  private async discoverExecutable(): Promise<string | undefined> {
    for (const candidate of executableCandidates(
      this.pathValue,
      this.homeDirectory,
    )) {
      try {
        await this.access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // An inaccessible candidate is a normal unavailable state.
      }
    }
    return undefined;
  }

  private async discoverCertificateFile(): Promise<string | undefined> {
    for (const candidate of certificateCandidates(this.certificateFileValue)) {
      try {
        await this.access(candidate, constants.R_OK);
        return candidate;
      } catch {
        // Fall through to the next standard trust-store location.
      }
    }
    return undefined;
  }
}

function executableCandidates(
  pathValue: string,
  homeDirectory: string,
): readonly string[] {
  const candidates: string[] = [];
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory) || directory.includes("\0")) {
      continue;
    }
    candidates.push(path.join(directory, "yt-dlp"));
  }
  candidates.push(
    "/opt/homebrew/bin/yt-dlp",
    "/usr/local/bin/yt-dlp",
    path.join(homeDirectory, ".local/bin/yt-dlp"),
  );
  return Object.freeze([...new Set(candidates)]);
}

function certificateCandidates(configured: string): readonly string[] {
  const candidates: string[] = [];
  if (configured && path.isAbsolute(configured) && !configured.includes("\0")) {
    candidates.push(configured);
  }
  candidates.push(
    "/etc/ssl/cert.pem",
    "/etc/ssl/certs/ca-certificates.crt",
    "/opt/homebrew/etc/openssl@3/cert.pem",
    "/usr/local/etc/openssl@3/cert.pem",
  );
  for (const version of ["3.14", "3.13", "3.12", "3.11", "3.10", "3.9"]) {
    candidates.push(
      `/Library/Frameworks/Python.framework/Versions/${version}/lib/python${version}/site-packages/certifi/cacert.pem`,
    );
  }
  return Object.freeze([...new Set(candidates)]);
}

function validateExecution(value: { stdout: string; stderr: string }): string {
  if (
    !isRecord(value) ||
    typeof value.stdout !== "string" ||
    typeof value.stderr !== "string"
  ) {
    throw stableError("temporarily-unavailable");
  }
  assertBoundedString(value.stdout, MAX_METADATA_BYTES);
  return value.stdout;
}

function projectMetadata(
  metadataText: string,
  expectedVideoId: string,
): YouTubeCaptionTrack[] {
  let value: unknown;
  try {
    value = JSON.parse(metadataText);
  } catch {
    throw stableError("temporarily-unavailable");
  }
  if (!isRecord(value) || ownString(value, "id") !== expectedVideoId) {
    throw stableError("temporarily-unavailable");
  }

  const tracks = [
    ...projectTrackCollection(ownOptionalRecord(value, "subtitles"), "manual"),
    ...projectTrackCollection(
      ownOptionalRecord(value, "automatic_captions"),
      "generated",
    ),
  ];
  if (tracks.length === 0) throw stableError("no-captions");
  return tracks;
}

function projectTrackCollection(
  collection: Record<string, unknown> | undefined,
  kind: TrackKind,
): YouTubeCaptionTrack[] {
  if (!collection) return [];
  const languageCodes = Object.getOwnPropertyNames(collection);
  if (languageCodes.length > MAX_LANGUAGES_PER_KIND) {
    throw stableError("temporarily-unavailable");
  }

  const tracks: YouTubeCaptionTrack[] = [];
  for (const languageCode of languageCodes) {
    if (
      languageCode.length === 0 ||
      languageCode.length > MAX_LANGUAGE_CODE_CHARACTERS ||
      !/^[A-Za-z0-9_-]+$/u.test(languageCode)
    ) {
      throw stableError("temporarily-unavailable");
    }
    const entries = ownValue(collection, languageCode);
    if (!Array.isArray(entries) || entries.length > MAX_FORMATS_PER_LANGUAGE) {
      throw stableError("temporarily-unavailable");
    }
    const selected = selectFormat(entries);
    if (!selected) continue;
    const languageName = readLanguageName(selected, languageCode);
    const track = Object.freeze({
      languageCode,
      languageName,
      isGenerated: kind === "generated",
      source: "yt-dlp" as const,
      url: selected.url,
      format: selected.format,
    });
    tracks.push(track);
  }
  return tracks;
}

function selectFormat(entries: readonly unknown[]):
  | {
      entry: Record<string, unknown>;
      format: YouTubeCaptionFormat;
      url: string;
    }
  | undefined {
  for (const format of FORMAT_PRIORITY) {
    for (const entryValue of entries) {
      if (!isRecord(entryValue) || ownString(entryValue, "ext") !== format) {
        continue;
      }
      const url = ownString(entryValue, "url");
      if (!url) throw stableError("temporarily-unavailable");
      validateCaptionUrl(url);
      return { entry: entryValue, format, url };
    }
  }
  return undefined;
}

function readLanguageName(
  selected: { entry: Record<string, unknown> },
  languageCode: string,
): string {
  const value = ownValue(selected.entry, "name");
  if (value === undefined || value === null || value === "") {
    return languageCode;
  }
  if (
    typeof value !== "string" ||
    value.length > MAX_LANGUAGE_NAME_CHARACTERS ||
    containsUnsafeControl(value)
  ) {
    throw stableError("temporarily-unavailable");
  }
  return value.normalize("NFC");
}

async function requestCaptionWithRedirects(
  transport: TranscriptHttpTransport,
  initialUrl: string,
  videoId: string,
  deadline: CaptionActionDeadline,
): Promise<TranscriptHttpResponse> {
  let request = captionRequest(initialUrl, videoId, deadline.signal);
  validateCaptionUrl(request.url);

  for (
    let redirectCount = 0;
    redirectCount <= MAX_REDIRECTS;
    redirectCount += 1
  ) {
    deadline.assertActive();
    const response = validateResponse(
      await deadline.run(() => transport(request)),
    );
    deadline.assertActive();
    if (isRedirect(response.status)) {
      if (redirectCount === MAX_REDIRECTS || response.status === 303) {
        throw stableError("temporarily-unavailable");
      }
      const location = readHeader(response.headers, "location");
      if (!location || location.length > MAX_URL_CHARACTERS) {
        throw stableError("temporarily-unavailable");
      }
      let redirected: URL;
      try {
        redirected = new URL(location, request.url);
      } catch {
        throw stableError("temporarily-unavailable");
      }
      validateCaptionUrl(redirected.href);
      const priorOrigin = new URL(request.url).origin;
      request = captionRequest(
        redirected.href,
        videoId,
        deadline.signal,
        redirected.origin === priorOrigin
          ? request.headers
          : crossOriginCaptionHeaders(request.headers),
      );
      continue;
    }
    assertSuccessfulStatus(response.status);
    return response;
  }
  throw stableError("temporarily-unavailable");
}

function captionRequest(
  url: string,
  videoId: string,
  signal: AbortSignal | undefined,
  headers: Record<string, string> = captionHeaders(videoId),
): TranscriptHttpRequest {
  return Object.freeze({
    url,
    method: "GET" as const,
    headers: Object.freeze({ ...headers }),
    body: undefined,
    ...(signal === undefined ? {} : { signal }),
  });
}

function captionHeaders(videoId: string): Record<string, string> {
  return {
    Accept: "application/json,text/plain;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    Origin: "https://www.youtube.com",
    Referer: `${WATCH_URL_PREFIX}${videoId}`,
  };
}

function crossOriginCaptionHeaders(
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

function validateCaptionUrl(urlValue: string): void {
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
    (url.port && url.port !== "443") ||
    !isCaptionHost(url.hostname) ||
    url.pathname !== "/api/timedtext"
  ) {
    throw stableError("temporarily-unavailable");
  }
}

function isCaptionHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "youtube.com" ||
    host.endsWith(".youtube.com") ||
    host === "googlevideo.com" ||
    host.endsWith(".googlevideo.com")
  );
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
      Number(contentLength) > MAX_CAPTION_RESPONSE_BYTES)
  ) {
    throw stableError("temporarily-unavailable");
  }
  assertBoundedString(value.text, MAX_CAPTION_RESPONSE_BYTES, true);
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

function ownOptionalRecord(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!("value" in descriptor) || !isRecord(descriptor.value)) {
    throw stableError("temporarily-unavailable");
  }
  return descriptor.value;
}

function ownString(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const candidate = ownValue(value, key);
  return typeof candidate === "string" ? candidate : undefined;
}

function ownValue(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) return undefined;
  return descriptor.value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertBoundedString(
  value: string,
  maximumBytes: number,
  allowEmpty = false,
): void {
  if (
    (!allowEmpty && !value) ||
    value.length > maximumBytes ||
    new TextEncoder().encode(value).byteLength > maximumBytes
  ) {
    throw stableError("temporarily-unavailable");
  }
}

function containsUnsafeControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code <= 8 ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      (code >= 127 && code <= 159)
    ) {
      return true;
    }
  }
  return false;
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw stableError("aborted");
}

function stableError(code: YouTubeTranscriptErrorCode): YouTubeTranscriptError {
  return new YouTubeTranscriptError(code);
}

function normalizeFailure(
  error: unknown,
  signal: AbortSignal | undefined,
): YouTubeTranscriptError {
  if (error instanceof YouTubeTranscriptError) return error;
  if (signal?.aborted) return stableError("aborted");
  if (isRecord(error)) {
    const name = ownString(error, "name")?.toLowerCase();
    const code = ownString(error, "code")?.toUpperCase();
    if (name === "aborterror") return stableError("aborted");
    if (
      name === "timeouterror" ||
      code === "ETIMEDOUT" ||
      ownValue(error, "killed") === true
    ) {
      return stableError("timeout");
    }
  }
  return stableError("temporarily-unavailable");
}

function normalizeCaptionFailure(
  error: unknown,
  deadline: CaptionActionDeadline,
): YouTubeTranscriptError {
  if (deadline.signal.aborted) {
    return stableError(deadline.failureCode());
  }
  return normalizeFailure(error, undefined);
}
