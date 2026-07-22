import { MIN_AI_INPUT_CHARACTERS } from "../ai-types";

export const AI_CONTENT_OMISSION_MARKER = "[中间内容因输入上限省略]";

export interface LimitedAiContent {
  content: string;
  characterCount: number;
  truncated: boolean;
}

/**
 * Bounds model input without implying that the middle of an article was read.
 * Character counts use JavaScript string length because provider limits and the
 * rest of the plugin use the same UTF-16 representation.
 */
export function limitAiContent(
  content: string,
  maxInputCharacters: number,
): LimitedAiContent {
  validateLimit(content, maxInputCharacters);

  if (content.length <= maxInputCharacters) {
    return {
      content,
      characterCount: content.length,
      truncated: false,
    };
  }

  const retainedCharacters =
    maxInputCharacters - AI_CONTENT_OMISSION_MARKER.length;
  const requestedStartLength = Math.floor(retainedCharacters / 2);
  const requestedEndLength = retainedCharacters - requestedStartLength;
  const start = safeLeadingSlice(content, requestedStartLength);
  const end = safeTrailingSlice(content, requestedEndLength);
  const bounded = `${start}${AI_CONTENT_OMISSION_MARKER}${end}`;

  return {
    content: bounded,
    characterCount: bounded.length,
    truncated: true,
  };
}

/** Marks an upstream bounded scan while keeping the retained visible ends. */
export function markAiContentTruncated(
  content: string,
  maxInputCharacters: number,
): LimitedAiContent {
  validateLimit(content, maxInputCharacters);
  if (content.length + AI_CONTENT_OMISSION_MARKER.length <= maxInputCharacters) {
    const marked = `${content}${AI_CONTENT_OMISSION_MARKER}`;
    return {
      content: marked,
      characterCount: marked.length,
      truncated: true,
    };
  }

  const retainedCharacters =
    maxInputCharacters - AI_CONTENT_OMISSION_MARKER.length;
  const requestedStartLength = Math.floor(retainedCharacters / 2);
  const requestedEndLength = retainedCharacters - requestedStartLength;
  const marked = `${safeLeadingSlice(content, requestedStartLength)}` +
    `${AI_CONTENT_OMISSION_MARKER}` +
    `${safeTrailingSlice(content, requestedEndLength)}`;
  return {
    content: marked,
    characterCount: marked.length,
    truncated: true,
  };
}

function validateLimit(content: string, maxInputCharacters: number): void {
  if (
    typeof content !== "string" ||
    !Number.isSafeInteger(maxInputCharacters) ||
    maxInputCharacters < MIN_AI_INPUT_CHARACTERS
  ) {
    throw new Error("Invalid AI input character limit");
  }
}

function safeLeadingSlice(value: string, requestedLength: number): string {
  let end = requestedLength;
  if (end > 0 && isHighSurrogate(value.charCodeAt(end - 1))) {
    end -= 1;
  }
  return value.slice(0, end);
}

function safeTrailingSlice(value: string, requestedLength: number): string {
  let start = value.length - requestedLength;
  if (start < value.length && isLowSurrogate(value.charCodeAt(start))) {
    start += 1;
  }
  return value.slice(start);
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}
