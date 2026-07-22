import { MediaService } from "../../services/media-service";
import { MastodonService } from "../../services/mastodon-service";
import {
  loadFeedForPreview,
  resolvePodcastPlatformUrl,
} from "../../services/feed-parser";
import { detectPodcastPlatform } from "../../utils/podcast-platforms";
import { createTranslator, type Locale } from "../../i18n";

export type FeedPreviewType = "rss" | "podcast" | "youtube";

export interface FeedPreviewLoaderOptions {
  corsProxyEnabled?: boolean;
  corsProxyUrl?: string;
  locale?: Locale;
}

export interface FeedPreviewLoadResult {
  detectedType: FeedPreviewType;
  inputUrl: string;
  finalUrl: string;
  isXConversion: boolean;
  isMastodonConversion: boolean;
  title: string;
  latestPubDate?: string;
  hasEntries: boolean;
}

export interface MediaFolderDefaults {
  defaultTwitterFolder?: string;
  defaultMastodonFolder?: string;
  defaultYouTubeFolder?: string;
  defaultPodcastFolder?: string;
  defaultRssFolder?: string;
}

function isYouTubePageUrl(url: string): boolean {
  if (!url) return false;
  if (!MediaService.isYouTubeFeed(url)) return false;
  if (url.includes("youtube.com/feeds/videos.xml")) return false;
  return true;
}

function isYouTubeRssFeedUrl(url: string): boolean {
  if (!url) return false;
  return url.includes("youtube.com/feeds/videos.xml");
}

export function formatLatestEntryLabel(
  latestPubDate?: string,
  now = Date.now(),
  locale: Locale = "zh-CN",
): string {
  const t = createTranslator(locale);
  if (!latestPubDate) return t("modal.feed.notAvailable");
  const date = new Date(latestPubDate);
  if (!Number.isFinite(date.getTime())) return t("modal.feed.notAvailable");
  const daysAgo = Math.floor((now - date.getTime()) / (1000 * 60 * 60 * 24));
  return daysAgo === 0
    ? t("modal.feed.today")
    : t("modal.feed.daysAgo", { count: daysAgo });
}

export function getPreviewConversionNotice(
  preview: Pick<
    FeedPreviewLoadResult,
    "isXConversion" | "isMastodonConversion"
  >,
  locale: Locale = "zh-CN",
): string {
  const t = createTranslator(locale);
  if (preview.isXConversion) {
    return t("modal.feed.xConversion");
  }

  if (preview.isMastodonConversion) {
    return t("modal.feed.mastodonConversion");
  }

  return "";
}

export function shouldAutoAssignFolder(
  currentFolder: string,
  media?: MediaFolderDefaults,
): boolean {
  const normalizedFolder = currentFolder.trim();
  if (!normalizedFolder || normalizedFolder === "Uncategorized") {
    return true;
  }

  const autoAssignedFolders = new Set([
    media?.defaultTwitterFolder || "Twitter",
    media?.defaultMastodonFolder || "Mastodon",
    media?.defaultYouTubeFolder || "Videos",
    media?.defaultPodcastFolder || "Podcast",
    media?.defaultRssFolder || "RSS",
    "Twitter",
    "Mastodon",
    "Videos",
    "Podcast",
    "RSS",
  ]);

  return autoAssignedFolders.has(normalizedFolder);
}

export function getDefaultFolderForResolvedFeed(
  preview: Pick<
    FeedPreviewLoadResult,
    | "detectedType"
    | "inputUrl"
    | "finalUrl"
    | "isXConversion"
    | "isMastodonConversion"
  >,
  media?: MediaFolderDefaults,
): string {
  const isNitterFeed = !!MediaService.normalizeNitterUrlToRss(preview.finalUrl);
  if (preview.isXConversion || isNitterFeed) {
    return media?.defaultTwitterFolder || "Twitter";
  }

  if (
    preview.isMastodonConversion ||
    MastodonService.isResolvedFeedUrl(preview.inputUrl)
  ) {
    return media?.defaultMastodonFolder || "Mastodon";
  }

  if (preview.detectedType === "youtube") {
    return media?.defaultYouTubeFolder || "Videos";
  }

  if (preview.detectedType === "podcast") {
    return media?.defaultPodcastFolder || "Podcast";
  }

  return media?.defaultRssFolder || "RSS";
}

export async function resolveAndLoadPreview(
  inputUrl: string,
  options?: FeedPreviewLoaderOptions,
): Promise<FeedPreviewLoadResult> {
  const t = createTranslator(options?.locale ?? "zh-CN");
  let url = inputUrl;
  let finalUrl = inputUrl;
  let detectedType: FeedPreviewType = "rss";
  let isXConversion = false;
  let isMastodonConversion = false;

  const normalizedNitterUrl = MediaService.normalizeNitterUrlToRss(url);
  if (normalizedNitterUrl) {
    url = normalizedNitterUrl;
    finalUrl = normalizedNitterUrl;
  }

  if (MediaService.isXUrl(url)) {
    const nitterUrl = MediaService.getNitterRssFeed(url);
    if (nitterUrl) {
      url = nitterUrl;
      finalUrl = nitterUrl;
      isXConversion = true;
    }
  }

  if (MediaService.isMastodonUrl(url)) {
    const mastodonFeedUrl = await MediaService.getMastodonRssFeed(url);
    if (!mastodonFeedUrl) {
      throw new Error(t("modal.feed.mastodonResolve"));
    }

    url = mastodonFeedUrl;
    finalUrl = mastodonFeedUrl;
    isMastodonConversion = true;
  }

  if (isYouTubePageUrl(url)) {
    detectedType = "youtube";
    const rssUrl = await MediaService.getYouTubeRssFeed(url);
    if (!rssUrl) {
      throw new Error(t("modal.feed.youtubeResolve"));
    }
    url = rssUrl;
    finalUrl = rssUrl;
  } else if (MediaService.isYouTubeFeed(url) && isYouTubeRssFeedUrl(url)) {
    detectedType = "youtube";
  } else {
    const platform = detectPodcastPlatform(url);
    if (platform) {
      if (platform.id === "pocketcasts" && !options?.corsProxyEnabled) {
        throw new Error(t("modal.feed.pocketCastsCors"));
      }

      detectedType = "podcast";
      const resolvedUrl = await resolvePodcastPlatformUrl(
        url,
        options?.corsProxyUrl,
      );
      if (!resolvedUrl) {
        throw new Error(t("modal.feed.podcastResolve"));
      }
      url = resolvedUrl;
      finalUrl = resolvedUrl;
    }
  }

  const feedData = await loadFeedForPreview(finalUrl);

  return {
    detectedType,
    inputUrl,
    finalUrl,
    isXConversion,
    isMastodonConversion,
    title: feedData.title,
    latestPubDate: feedData.latestPubDate,
    hasEntries: feedData.hasEntries,
  };
}
