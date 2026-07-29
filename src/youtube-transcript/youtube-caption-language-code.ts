const MAX_YOUTUBE_CAPTION_LANGUAGE_CODE_CHARACTERS = 64;
const YOUTUBE_CAPTION_LANGUAGE_CODE =
  /^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/u;

/**
 * Accepts the bounded ASCII segment grammar used by YouTube caption providers.
 * Separators are meaningful but may not create leading, trailing, or empty
 * segments, keeping the value safe in request, job-key, and cache boundaries.
 */
export function isValidYouTubeCaptionLanguageCode(
  value: unknown,
): value is string {
  return typeof value === "string" &&
    value.length <= MAX_YOUTUBE_CAPTION_LANGUAGE_CODE_CHARACTERS &&
    YOUTUBE_CAPTION_LANGUAGE_CODE.test(value);
}
