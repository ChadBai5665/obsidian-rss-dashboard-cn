import { createTranslator, type Locale } from "../i18n";
import type { ContentBasis } from "./collected-item";

/** Maps stable stored content-basis identifiers to display copy only. */
export function getContentBasisLabel(
  contentBasis: ContentBasis,
  locale: Locale = "zh-CN",
): string {
  if (contentBasis === "youtube-transcript") {
    return locale === "en" ? "YouTube transcript" : "YouTube 字幕";
  }
  const t = createTranslator(locale);
  const keys: Record<ContentBasis, Parameters<typeof t>[0]> = {
    feed: "reader.contentBasisFeed",
    "full-text": "reader.contentBasisFullText",
    "youtube-transcript": "reader.contentBasisFullText",
    "title-description": "reader.contentBasisTitleDescription",
    "x-post": "reader.contentBasisXPost",
    "linked-page": "reader.contentBasisLinkedPage",
  };
  return t(keys[contentBasis]);
}
