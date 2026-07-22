import type { TranslationKey, Translator } from "../../i18n";
import { isValidFeedTitle } from "../../utils/validation";

const FEED_TITLE_ERROR_KEYS = {
  empty: "modal.feed.titleEmpty",
  leadingDot: "modal.feed.titleLeadingDot",
  invalid: "modal.feed.titleInvalid",
} satisfies Record<string, TranslationKey>;

/** Keeps validation's legacy English diagnostics out of user-visible notices. */
export function getLocalizedFeedTitleError(
  title: string,
  t: Translator,
): string | null {
  const validation = isValidFeedTitle(title);
  if (validation.valid) {
    return null;
  }

  const trimmedTitle = title.trim();
  const key = !trimmedTitle
    ? FEED_TITLE_ERROR_KEYS.empty
    : trimmedTitle.startsWith(".")
      ? FEED_TITLE_ERROR_KEYS.leadingDot
      : FEED_TITLE_ERROR_KEYS.invalid;
  return t(key);
}
