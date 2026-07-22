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
  const minimumLimit = AI_CONTENT_OMISSION_MARKER.length + 2;
  if (
    typeof content !== "string" ||
    !Number.isSafeInteger(maxInputCharacters) ||
    maxInputCharacters < minimumLimit
  ) {
    throw new Error("Invalid AI input character limit");
  }

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
