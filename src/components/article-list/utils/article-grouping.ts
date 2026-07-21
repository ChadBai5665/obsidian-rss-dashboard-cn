import type { Feed, FeedItem } from "../../../types/types";
import { formatDateWithRelative } from "../../../utils/platform-utils";
import { createTranslator } from "../../../i18n";
import type { Locale } from "../../../i18n";

export function groupArticles(
  articles: FeedItem[],
  groupBy: "feed" | "date" | "folder" | "none",
  getFeedFolderFn?: (feedUrl: string) => string | undefined,
  locale: Locale = "zh-CN",
): Record<string, FeedItem[]> {
  const t = createTranslator(locale);
  if (groupBy === "none") return { [t("dashboard.allArticles")]: articles };

  return articles.reduce(
    (acc, article) => {
      let key: string;
      switch (groupBy) {
        case "feed":
          key = article.feedTitle || t("dashboard.uncategorized");
          break;
        case "date":
          key = formatDateWithRelative(article.pubDate, locale).text;
          break;

        case "folder":
          key =
            getFeedFolderFn?.(article.feedUrl) || t("dashboard.uncategorized");
          break;
        default:
          key = t("dashboard.allArticles");
      }

      if (!acc[key]) {
        acc[key] = [];
      }
      acc[key].push(article);
      return acc;
    },
    {} as Record<string, FeedItem[]>,
  );
}

export function getFeedFolder(
  feedUrl: string,
  settingsFeeds: Feed[],
): string | undefined {
  const feed = settingsFeeds.find((f) => f.url === feedUrl);
  return feed?.folder;
}
