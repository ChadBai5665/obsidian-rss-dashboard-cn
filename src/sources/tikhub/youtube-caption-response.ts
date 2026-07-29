import type {
  TikHubCaptionResponse,
  TikHubCaptionTrack,
} from "./tikhub-types";

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/u;
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const LANGUAGE_CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const MAX_TRACKS = 256;
const MAX_LANGUAGE_NAME_LENGTH = 256;
const MAX_CAPTION_TEXT_LENGTH = 1_000_000;
const MAX_MESSAGE_LENGTH = 512;

const TRACK_LIST_KEYS = ["video_id", "captions"] as const;
const EMPTY_TRACK_LIST_KEYS = [
  "video_id",
  "captions",
  "message",
  "message_zh",
] as const;
const PROCESSING_KEYS = ["video_id", "status", "job_id"] as const;
const PENDING_KEYS = ["status", "job_id"] as const;
const CONTENT_KEYS = [
  "video_id",
  "language_code",
  "language_name",
  "format",
  "content",
] as const;
const COMPLETED_CONTENT_KEYS = [
  "job_id",
  "status",
  "language_code",
  "language_name",
  "format",
  "content",
  "available_languages",
] as const;

export class InvalidTikHubCaptionResponseError extends Error {
  readonly code = "invalid-tikhub-caption-response";

  constructor() {
    super("TikHub returned an invalid caption response.");
    this.name = "InvalidTikHubCaptionResponseError";
  }
}

/** Projects a documented TikHub caption shape without traversing provider data. */
export function parseTikHubCaptionResponse(
  value: unknown,
  expectedVideoId: string,
): TikHubCaptionResponse {
  try {
    if (!VIDEO_ID.test(expectedVideoId)) throw invalidResponse();
    const record = plainRecord(value);
    if (!record) throw invalidResponse();

    if (
      hasExactKeys(record, TRACK_LIST_KEYS) ||
      hasExactKeys(record, EMPTY_TRACK_LIST_KEYS)
    ) {
      return parseTrackList(record, expectedVideoId);
    }
    if (hasExactKeys(record, PROCESSING_KEYS)) {
      return parseProcessing(record, expectedVideoId);
    }
    if (hasExactKeys(record, PENDING_KEYS)) return parsePending(record);
    if (isSynchronousContentShape(record)) {
      return parseContent(record, expectedVideoId, false);
    }
    if (isCompletedContentShape(record)) {
      return parseContent(record, expectedVideoId, true);
    }
    throw invalidResponse();
  } catch (error) {
    if (error instanceof InvalidTikHubCaptionResponseError) throw error;
    throw invalidResponse();
  }
}

function parseTrackList(
  record: Record<string, unknown>,
  expectedVideoId: string,
): TikHubCaptionResponse {
  requireExpectedVideoId(record, expectedVideoId);
  const captions = denseOwnArray(ownData(record, "captions"), MAX_TRACKS);
  if (!captions) throw invalidResponse();
  if (captions.length === 0) {
    const hasMessages = hasExactKeys(record, EMPTY_TRACK_LIST_KEYS);
    if (hasMessages) {
      requireDiscardedMessage(ownData(record, "message"));
      requireDiscardedMessage(ownData(record, "message_zh"));
    }
    return { kind: "no-captions", videoId: expectedVideoId };
  }
  if (hasExactKeys(record, EMPTY_TRACK_LIST_KEYS)) throw invalidResponse();

  const tracks: TikHubCaptionTrack[] = [];
  const byLanguage = new Map<string, TikHubCaptionTrack>();
  for (const value of captions) {
    const trackRecord = plainRecord(value);
    if (
      !trackRecord ||
      (!hasExactKeys(trackRecord, ["language_code", "language_name"]) &&
        !hasExactKeys(trackRecord, [
          "language_code",
          "language_name",
          "is_generated",
        ]))
    ) {
      throw invalidResponse();
    }
    const track = parseLanguage(trackRecord);
    const existing = byLanguage.get(track.languageCode);
    if (existing) {
      if (
        existing.languageName !== track.languageName ||
        existing.isGenerated !== track.isGenerated
      ) {
        throw invalidResponse();
      }
      continue;
    }
    byLanguage.set(track.languageCode, track);
    tracks.push(track);
  }
  return { kind: "tracks", videoId: expectedVideoId, tracks };
}

function parseProcessing(
  record: Record<string, unknown>,
  expectedVideoId: string,
): TikHubCaptionResponse {
  requireExpectedVideoId(record, expectedVideoId);
  if (ownData(record, "status") !== "processing") throw invalidResponse();
  return {
    kind: "processing",
    videoId: expectedVideoId,
    jobId: requireJobId(ownData(record, "job_id")),
  };
}

function parsePending(record: Record<string, unknown>): TikHubCaptionResponse {
  const status = ownData(record, "status");
  if (status !== "queued" && status !== "active") throw invalidResponse();
  return { kind: "pending", jobId: requireJobId(ownData(record, "job_id")) };
}

function parseContent(
  record: Record<string, unknown>,
  expectedVideoId: string,
  completed: boolean,
): TikHubCaptionResponse {
  if (completed) {
    if (ownData(record, "status") !== "completed") throw invalidResponse();
    requireJobId(ownData(record, "job_id"));
  } else {
    requireExpectedVideoId(record, expectedVideoId);
  }
  if (ownData(record, "format") !== "txt") throw invalidResponse();
  const language = parseLanguage(record);
  if (Object.prototype.hasOwnProperty.call(record, "available_languages")) {
    const available = parseAvailableLanguages(
      ownData(record, "available_languages"),
    );
    if (!available.includes(language.languageCode)) throw invalidResponse();
  }
  const content = ownData(record, "content");
  if (
    typeof content !== "string" ||
    content.length === 0 ||
    !content.trim() ||
    content.length > MAX_CAPTION_TEXT_LENGTH ||
    hasDisallowedControl(content, true)
  ) {
    throw invalidResponse();
  }
  return {
    kind: "content",
    videoId: expectedVideoId,
    ...language,
    text: content,
  };
}

function isSynchronousContentShape(record: Record<string, unknown>): boolean {
  return [
    CONTENT_KEYS,
    [...CONTENT_KEYS, "available_languages"],
    [...CONTENT_KEYS, "is_generated"],
    [...CONTENT_KEYS, "available_languages", "is_generated"],
  ].some((keys) => hasExactKeys(record, keys));
}

function isCompletedContentShape(record: Record<string, unknown>): boolean {
  return hasExactKeys(record, COMPLETED_CONTENT_KEYS) ||
    hasExactKeys(record, [...COMPLETED_CONTENT_KEYS, "is_generated"]);
}

function parseAvailableLanguages(value: unknown): string[] {
  const entries = denseOwnArray(value, MAX_TRACKS);
  if (!entries || entries.length === 0) throw invalidResponse();
  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (
      typeof entry !== "string" ||
      !LANGUAGE_CODE.test(entry) ||
      seen.has(entry)
    ) {
      throw invalidResponse();
    }
    seen.add(entry);
    result.push(entry);
  }
  return result;
}

function requireDiscardedMessage(value: unknown): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_MESSAGE_LENGTH ||
    value.trim() !== value ||
    hasDisallowedControl(value, false)
  ) {
    throw invalidResponse();
  }
}

function parseLanguage(record: Record<string, unknown>): TikHubCaptionTrack {
  const languageCode = ownData(record, "language_code");
  const languageName = ownData(record, "language_name");
  if (
    typeof languageCode !== "string" ||
    !LANGUAGE_CODE.test(languageCode) ||
    typeof languageName !== "string" ||
    languageName.length === 0 ||
    languageName.length > MAX_LANGUAGE_NAME_LENGTH ||
    languageName.trim() !== languageName ||
    hasDisallowedControl(languageName, false)
  ) {
    throw invalidResponse();
  }

  const inferredGenerated = languageCode.startsWith("a.");
  const generatedDescriptor = ownDescriptor(record, "is_generated");
  if (generatedDescriptor) {
    const explicit = dataValue(generatedDescriptor);
    if (typeof explicit !== "boolean" || explicit !== inferredGenerated) {
      throw invalidResponse();
    }
  }
  return {
    languageCode,
    languageName,
    isGenerated: inferredGenerated,
  };
}

function requireExpectedVideoId(
  record: Record<string, unknown>,
  expectedVideoId: string,
): void {
  if (ownData(record, "video_id") !== expectedVideoId) throw invalidResponse();
}

function requireJobId(value: unknown): string {
  if (typeof value !== "string" || !JOB_ID.test(value)) throw invalidResponse();
  return value;
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? value as Record<string, unknown>
    : undefined;
}

function denseOwnArray(value: unknown, maximum: number): unknown[] | undefined {
  if (!Array.isArray(value) || Reflect.getPrototypeOf(value) !== Array.prototype) {
    return undefined;
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor)) return undefined;
  const length: unknown = lengthDescriptor.value;
  if (
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > maximum
  ) {
    return undefined;
  }
  const keys = Reflect.ownKeys(value);
  const expected = new Set<PropertyKey>([
    "length",
    ...Array.from({ length }, (_, index) => String(index)),
  ]);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    return undefined;
  }
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) return undefined;
    result.push(descriptor.value);
  }
  return result;
}

function hasExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(record);
  return keys.length === expected.length &&
    keys.every((key) => typeof key === "string" && expected.includes(key));
}

function ownData(record: Record<string, unknown>, key: string): unknown {
  const descriptor = ownDescriptor(record, key);
  if (!descriptor) throw invalidResponse();
  return dataValue(descriptor);
}

function ownDescriptor(
  record: Record<string, unknown>,
  key: string,
): PropertyDescriptor | undefined {
  return Object.getOwnPropertyDescriptor(record, key);
}

function dataValue(descriptor: PropertyDescriptor): unknown {
  if (!("value" in descriptor)) throw invalidResponse();
  return descriptor.value;
}

function hasDisallowedControl(value: string, allowTextWhitespace: boolean): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) return true;
    if (allowTextWhitespace && (codePoint === 9 || codePoint === 10 || codePoint === 13)) {
      continue;
    }
    if (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159)) return true;
  }
  return false;
}

function invalidResponse(): InvalidTikHubCaptionResponseError {
  return new InvalidTikHubCaptionResponseError();
}
