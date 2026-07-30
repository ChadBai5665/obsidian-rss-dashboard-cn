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

interface XmlFrame {
  name: string;
  contentStart: number;
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
      appendCaptionWindow(lines, plainTextLines(eventText));
    }
    return finalizeTranscript(lines);
  } catch (error) {
    throw stableParserFailure(error);
  }
}

export function parseWebVttTranscript(payload: string): string {
  try {
    assertBoundedPayload(payload, true);
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
      assertBoundedSegment(cueText);
      appendCaptionWindow(lines, plainTextLines(cueText));
    }
    return finalizeTranscript(lines);
  } catch (error) {
    throw stableParserFailure(error);
  }
}

export function parseSrvTranscript(payload: string): string {
  try {
    assertBoundedPayload(payload, true);
    const documentBody = payload.trim().replace(/^<\?xml\s[^?]*\?>\s*/iu, "");
    validateXmlDocument(documentBody);

    const lines: string[] = [];
    let nodeCount = 0;
    for (const match of documentBody.matchAll(XML_CAPTION_NODE)) {
      nodeCount += 1;
      if (nodeCount > MAX_CAPTION_EVENTS) throw unavailable();
      const nodeName = match[1]?.toLowerCase();
      const attributes = match[2] ?? "";
      const content = match[3] ?? "";
      assertBoundedSegment(content);
      if (nodeName === "text") {
        validateRequiredXmlTimestamp(attributes, "start");
        validateOptionalXmlTimestamp(attributes, "dur");
      } else if (nodeName === "p") {
        validateRequiredXmlTimestamp(attributes, "t");
        validateOptionalXmlTimestamp(attributes, "d");
      } else {
        throw unavailable();
      }
      appendCaptionWindow(lines, plainTextLines(content));
    }
    return finalizeTranscript(lines);
  } catch (error) {
    throw stableParserFailure(error);
  }
}

function assertBoundedPayload(
  payload: string,
  allowLeadingByteOrderMark = false,
): void {
  if (!payload || payload.length > MAX_RAW_PAYLOAD_BYTES) throw unavailable();
  if (new TextEncoder().encode(payload).byteLength > MAX_RAW_PAYLOAD_BYTES) {
    throw unavailable();
  }
  assertSafeText(payload, allowLeadingByteOrderMark);
}

function assertSafeText(
  value: string,
  allowLeadingByteOrderMark = false,
): void {
  for (let index = 0; index < value.length; index += 1) {
    const first = value.charCodeAt(index);
    let codePoint: number;
    if (first >= 0xd800 && first <= 0xdbff) {
      const second = value.charCodeAt(index + 1);
      if (second < 0xdc00 || second > 0xdfff) throw unavailable();
      codePoint = (first - 0xd800) * 0x400 + (second - 0xdc00) + 0x10000;
      index += 1;
    } else if (first >= 0xdc00 && first <= 0xdfff) {
      throw unavailable();
    } else {
      codePoint = first;
    }

    if (allowLeadingByteOrderMark && index === 0 && codePoint === 0xfeff) {
      continue;
    }

    const unsafeC0 =
      codePoint <= 8 ||
      codePoint === 11 ||
      codePoint === 12 ||
      (codePoint >= 14 && codePoint <= 31);
    const unsafeDeleteOrC1 = codePoint >= 127 && codePoint <= 159;
    if (unsafeC0 || unsafeDeleteOrC1 || isDangerousFormatControl(codePoint)) {
      throw unavailable();
    }
  }
}

function isDangerousFormatControl(codePoint: number): boolean {
  return (
    codePoint === 0x00ad ||
    codePoint === 0x061c ||
    codePoint === 0x180e ||
    codePoint === 0x200b ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2060 && codePoint <= 0x206f) ||
    codePoint === 0xfeff ||
    (codePoint >= 0xfff9 && codePoint <= 0xfffb) ||
    (codePoint >= 0x1d173 && codePoint <= 0x1d17a) ||
    codePoint === 0xe0001 ||
    (codePoint >= 0xe0020 && codePoint <= 0xe007f)
  );
}

function assertBoundedSegment(value: string): void {
  if (value.length > MAX_SEGMENT_CHARACTERS) throw unavailable();
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

function validateXmlDocument(value: string): void {
  const stack: XmlFrame[] = [];
  let cursor = 0;
  let rootName: "transcript" | "timedtext" | undefined;
  let rootCount = 0;
  let headCount = 0;
  let bodyCount = 0;
  let segmentCount = 0;

  for (const match of value.matchAll(MARKUP_TOKEN)) {
    const index = match.index ?? 0;
    const textBeforeTag = value.slice(cursor, index);
    if (textBeforeTag.includes("<")) throw unavailable();
    if (hasDisallowedXmlText(stack, textBeforeTag)) throw unavailable();
    cursor = index + match[0].length;

    const token = (match[1] ?? "").trim();
    if (!token) throw unavailable();
    if (/^(?:!|\?)/u.test(token)) continue;

    const closing = token.startsWith("/");
    const selfClosing = token.endsWith("/");
    const name = token
      .replace(/^\//u, "")
      .match(/^([A-Za-z][A-Za-z0-9-]*)/u)?.[1]
      ?.toLowerCase();
    if (!name) throw unavailable();

    if (closing) {
      const frame = stack.pop();
      if (!frame || frame.name !== name) throw unavailable();
      if (name === "text" || name === "p" || name === "s") {
        assertBoundedSegment(value.slice(frame.contentStart, index));
      }
      continue;
    }

    const parent = stack[stack.length - 1]?.name;
    if (stack.length === 0) {
      rootCount += 1;
      if (
        rootCount !== 1 ||
        (name !== "transcript" && name !== "timedtext") ||
        selfClosing
      ) {
        throw unavailable();
      }
      rootName = name;
    } else if (!rootName || !isAllowedXmlChild(rootName, parent, name)) {
      throw unavailable();
    }

    if (rootName === "timedtext" && parent === "timedtext") {
      if (name === "head") {
        headCount += 1;
        if (headCount > 1) throw unavailable();
      } else if (name === "body") {
        bodyCount += 1;
        if (bodyCount > 1) throw unavailable();
      }
    }
    if (rootName === "timedtext" && name === "s") {
      segmentCount += 1;
      if (segmentCount > MAX_CAPTION_SEGMENTS) throw unavailable();
    }

    if (!selfClosing && name !== "br") {
      stack.push({ name, contentStart: cursor });
    }
  }

  const trailingText = value.slice(cursor);
  if (
    trailingText.includes("<") ||
    trailingText.trim() ||
    stack.length > 0 ||
    rootCount !== 1 ||
    !rootName ||
    (rootName === "timedtext" && bodyCount !== 1)
  ) {
    throw unavailable();
  }
}

function hasDisallowedXmlText(
  stack: readonly XmlFrame[],
  value: string,
): boolean {
  if (!value.trim()) return false;
  const parent = stack[stack.length - 1]?.name;
  return (
    parent === undefined ||
    parent === "transcript" ||
    parent === "timedtext" ||
    parent === "body"
  );
}

function isAllowedXmlChild(
  rootName: "transcript" | "timedtext",
  parent: string | undefined,
  name: string,
): boolean {
  if (rootName === "transcript") {
    if (parent === "transcript") return name === "text";
    return name !== "text" && name !== "p" && name !== "s";
  }

  if (parent === "timedtext") return name === "head" || name === "body";
  if (parent === "body") return name === "p";
  if (parent === "p") return name === "s" || name === "br" || name === "font";
  if (parent === "s") return name === "br" || name === "font";
  return name !== "body" && name !== "p" && name !== "s" && name !== "text";
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
  const transcript = sourceLines.join("\n").trim();
  if (!transcript || transcript.length > MAX_TRANSCRIPT_CHARACTERS) {
    throw unavailable();
  }
  return transcript;
}

function appendCaptionWindow(
  output: string[],
  sourceWindow: readonly string[],
): void {
  const window: string[] = [];
  for (const line of sourceWindow) appendProgressiveLine(window, line);
  if (window.length === 0) return;

  let overlap = Math.min(output.length, window.length);
  while (overlap > 0) {
    let matches = true;
    for (let index = 0; index < overlap; index += 1) {
      if (output[output.length - overlap + index] !== window[index]) {
        matches = false;
        break;
      }
    }
    if (matches) break;
    overlap -= 1;
  }

  for (let index = overlap; index < window.length; index += 1) {
    const line = window[index];
    if (line) appendProgressiveLine(output, line);
  }
}

function appendProgressiveLine(lines: string[], line: string): void {
  const previous = lines[lines.length - 1];
  if (previous === line || previous?.startsWith(line)) return;
  if (previous && line.startsWith(previous)) {
    lines[lines.length - 1] = line;
  } else {
    lines.push(line);
  }
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
