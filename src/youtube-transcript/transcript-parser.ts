import {
  YouTubeTranscriptError,
  type YouTubeCaptionFormat,
} from "./transcript-types";

const MAX_RAW_PAYLOAD_BYTES = 2_000_000;
const MAX_CAPTION_EVENTS = 20_000;
const MAX_CAPTION_SEGMENTS = 10_000;
const MAX_SEGMENT_CHARACTERS = 16_000;
const MAX_TRANSCRIPT_CHARACTERS = 1_000_000;

const HTML_ENTITY = /&(#(?:x[0-9a-f]+|[0-9]+)|amp|apos|gt|lt|nbsp|quot);/giu;
const MARKUP_TOKEN = /<([^<>]*)>/gu;
const XML_CAPTION_NODE = /<(text|p)\b([^>]*)>([\s\S]*?)<\/\1\s*>/giu;

interface Json3Event {
  tStartMs?: unknown;
  dDurationMs?: unknown;
  segs?: unknown;
}

export function parseTranscriptPayload(
  format: YouTubeCaptionFormat,
  payload: string,
): string {
  switch (format) {
    case "json3":
      return parseJson3Transcript(payload);
    case "srv3":
      return parseSrvTranscript(payload);
    case "vtt":
      return parseWebVttTranscript(payload);
  }
}

export function parseJson3Transcript(payload: string): string {
  try {
    assertBoundedPayload(payload);
    const parsed: unknown = JSON.parse(payload);
    if (!isRecord(parsed) || !Array.isArray(parsed.events)) {
      throw unavailable();
    }
    if (parsed.events.length > MAX_CAPTION_EVENTS) throw unavailable();

    const lines: string[] = [];
    let segmentCount = 0;
    for (const value of parsed.events) {
      if (!isRecord(value)) throw unavailable();
      const event: Json3Event = value;
      validateOptionalTimestamp(event.tStartMs);
      validateOptionalTimestamp(event.dDurationMs);
      if (event.segs === undefined) continue;
      if (!Array.isArray(event.segs)) throw unavailable();
      segmentCount += event.segs.length;
      if (segmentCount > MAX_CAPTION_SEGMENTS) throw unavailable();

      let eventText = "";
      for (const segment of event.segs) {
        if (!isRecord(segment) || typeof segment.utf8 !== "string") {
          throw unavailable();
        }
        if (segment.utf8.length > MAX_SEGMENT_CHARACTERS) throw unavailable();
        assertSafeText(segment.utf8);
        eventText += segment.utf8;
        if (eventText.length > MAX_TRANSCRIPT_CHARACTERS) throw unavailable();
      }
      lines.push(...plainTextLines(eventText));
    }
    return finalizeTranscript(lines);
  } catch (error) {
    throw stableParserFailure(error);
  }
}

export function parseWebVttTranscript(payload: string): string {
  try {
    assertBoundedPayload(payload);
    const normalized = payload.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
    const firstBreak = normalized.indexOf("\n");
    const firstLine = (
      firstBreak === -1 ? normalized : normalized.slice(0, firstBreak)
    ).trim();
    if (!/^WEBVTT(?:[ \t].*)?$/u.test(firstLine)) throw unavailable();

    const remaining = firstBreak === -1 ? "" : normalized.slice(firstBreak + 1);
    const headerSeparator = remaining.match(/\n[ \t]*\n/u);
    let cuePayload: string;
    if (remaining.startsWith("\n")) {
      cuePayload = remaining.slice(1);
    } else if (headerSeparator?.index !== undefined) {
      cuePayload = remaining.slice(
        headerSeparator.index + headerSeparator[0].length,
      );
    } else {
      throw unavailable();
    }
    const blocks = cuePayload.split(/\n[ \t]*\n+/u);
    const lines: string[] = [];
    let cueCount = 0;

    for (const rawBlock of blocks) {
      const block = rawBlock.trim();
      if (!block) continue;
      const blockLines = block.split("\n");
      const kind = blockLines[0]?.trim() ?? "";
      if (/^(?:NOTE(?:[ \t]|$)|STYLE$|REGION$)/u.test(kind)) continue;

      let timingIndex = blockLines[0]?.includes("-->") ? 0 : 1;
      if (!blockLines[timingIndex]?.includes("-->")) throw unavailable();
      validateVttTiming(blockLines[timingIndex] ?? "");
      cueCount += 1;
      if (cueCount > MAX_CAPTION_EVENTS) throw unavailable();

      const cueText = blockLines.slice(timingIndex + 1).join("\n");
      lines.push(...plainTextLines(cueText));
    }
    return finalizeTranscript(lines);
  } catch (error) {
    throw stableParserFailure(error);
  }
}

export function parseSrvTranscript(payload: string): string {
  try {
    assertBoundedPayload(payload);
    const documentBody = payload.trim().replace(/^<\?xml\s[^?]*\?>\s*/iu, "");
    validateMarkup(documentBody);
    if (
      !/^<(transcript|timedtext)\b[^>]*>[\s\S]*<\/\1>$/iu.test(documentBody)
    ) {
      throw unavailable();
    }

    const lines: string[] = [];
    let nodeCount = 0;
    for (const match of documentBody.matchAll(XML_CAPTION_NODE)) {
      nodeCount += 1;
      if (nodeCount > MAX_CAPTION_EVENTS) throw unavailable();
      const nodeName = match[1]?.toLowerCase();
      const attributes = match[2] ?? "";
      const content = match[3] ?? "";
      if (nodeName === "text") {
        validateRequiredXmlTimestamp(attributes, "start");
        validateOptionalXmlTimestamp(attributes, "dur");
      } else if (nodeName === "p") {
        validateRequiredXmlTimestamp(attributes, "t");
        validateOptionalXmlTimestamp(attributes, "d");
      } else {
        throw unavailable();
      }
      lines.push(...plainTextLines(content));
    }
    return finalizeTranscript(lines);
  } catch (error) {
    throw stableParserFailure(error);
  }
}

function assertBoundedPayload(payload: string): void {
  if (!payload || payload.length > MAX_RAW_PAYLOAD_BYTES) throw unavailable();
  if (new TextEncoder().encode(payload).byteLength > MAX_RAW_PAYLOAD_BYTES) {
    throw unavailable();
  }
  assertSafeText(payload);
}

function assertSafeText(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const unsafeC0 =
      code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31);
    const unsafeDeleteOrC1 = code >= 127 && code <= 159;
    if (unsafeC0 || unsafeDeleteOrC1) throw unavailable();
  }
}

function validateOptionalTimestamp(value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw unavailable();
  }
}

function validateVttTiming(timing: string): void {
  const match = timing.match(/^(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/u);
  if (!match) throw unavailable();
  const start = parseVttTimestamp(match[1] ?? "");
  const end = parseVttTimestamp(match[2] ?? "");
  if (end < start) throw unavailable();
}

function parseVttTimestamp(value: string): number {
  const match = value.match(/^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)\.(\d{3})$/u);
  if (!match) throw unavailable();
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const milliseconds = Number(match[4]);
  const total = ((hours * 60 + minutes) * 60 + seconds) * 1_000 + milliseconds;
  if (!Number.isSafeInteger(total)) throw unavailable();
  return total;
}

function validateRequiredXmlTimestamp(attributes: string, name: string): void {
  const value = readXmlAttribute(attributes, name);
  if (value === undefined) throw unavailable();
  validateXmlTimestamp(value);
}

function validateOptionalXmlTimestamp(attributes: string, name: string): void {
  const value = readXmlAttribute(attributes, name);
  if (value !== undefined) validateXmlTimestamp(value);
}

function readXmlAttribute(
  attributes: string,
  name: string,
): string | undefined {
  const expression = new RegExp(
    `(?:^|\\s)${name}\\s*=\\s*(["'])([^"']*)\\1`,
    "u",
  );
  return attributes.match(expression)?.[2];
}

function validateXmlTimestamp(value: string): void {
  if (!/^\d+(?:\.\d+)?$/u.test(value)) throw unavailable();
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue < 0) throw unavailable();
}

function plainTextLines(value: string): string[] {
  if (!value) return [];
  assertSafeText(value);
  const withoutMarkup = stripMarkup(value);
  const decoded = decodeHtmlEntities(withoutMarkup).normalize("NFC");
  assertSafeText(decoded);
  return decoded
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t \u00A0]+/gu, " ").trim())
    .filter(Boolean);
}

function stripMarkup(value: string): string {
  validateMarkup(value);
  return value.replace(/<br\s*\/?>/giu, "\n").replace(MARKUP_TOKEN, "");
}

function validateMarkup(value: string): void {
  const stack: string[] = [];
  let cursor = 0;
  for (const match of value.matchAll(MARKUP_TOKEN)) {
    const index = match.index ?? 0;
    if (value.slice(cursor, index).includes("<")) throw unavailable();
    cursor = index + match[0].length;
    const token = (match[1] ?? "").trim();
    if (!token) throw unavailable();
    if (/^\d{2,}:\d{2}(?::\d{2})?\.\d{3}$/u.test(token)) continue;
    if (/^(?:!|\?)/u.test(token)) continue;

    const closing = token.startsWith("/");
    const selfClosing = token.endsWith("/");
    const name = token
      .replace(/^\//u, "")
      .match(/^([A-Za-z][A-Za-z0-9-]*)/u)?.[1]
      ?.toLowerCase();
    if (!name) throw unavailable();
    if (closing) {
      if (stack.pop() !== name) throw unavailable();
    } else if (!selfClosing && name !== "br") {
      stack.push(name);
    }
  }
  if (value.slice(cursor).includes("<") || stack.length > 0)
    throw unavailable();
}

function decodeHtmlEntities(value: string): string {
  return value.replace(HTML_ENTITY, (entity, body: string) => {
    const lowered = body.toLowerCase();
    if (lowered === "amp") return "&";
    if (lowered === "apos") return "'";
    if (lowered === "gt") return ">";
    if (lowered === "lt") return "<";
    if (lowered === "nbsp") return " ";
    if (lowered === "quot") return '"';

    const hexadecimal = lowered.startsWith("#x");
    const digits = body.slice(hexadecimal ? 2 : 1);
    const codePoint = Number.parseInt(digits, hexadecimal ? 16 : 10);
    if (!Number.isSafeInteger(codePoint) || codePoint > 0x10ffff) {
      throw unavailable();
    }
    try {
      return String.fromCodePoint(codePoint);
    } catch {
      throw unavailable();
    }
  });
}

function finalizeTranscript(sourceLines: readonly string[]): string {
  const lines: string[] = [];
  for (const line of sourceLines) {
    if (!line) continue;
    const previous = lines[lines.length - 1];
    if (previous === line || previous?.startsWith(line)) continue;
    if (previous && line.startsWith(previous)) {
      lines[lines.length - 1] = line;
    } else {
      lines.push(line);
    }
  }
  const transcript = lines.join("\n").trim();
  if (!transcript || transcript.length > MAX_TRANSCRIPT_CHARACTERS) {
    throw unavailable();
  }
  return transcript;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unavailable(): YouTubeTranscriptError {
  return new YouTubeTranscriptError("temporarily-unavailable");
}

function stableParserFailure(error: unknown): YouTubeTranscriptError {
  if (error instanceof YouTubeTranscriptError) return error;
  return unavailable();
}
