import { parseFeedPreviewFromText } from "../feed-parser/feed-preview.js";
import {
  normalizeYouTubeInput,
  type YouTubeIdentifier,
} from "./source-identifier.js";

const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/u;

export interface YouTubeChannelVerification {
  channelId: string;
  channelName: string;
  channelUrl: string;
  feedUrl: string;
  latestTitle?: string;
  latestPubDate?: string;
  hasEntries: boolean;
}

export type YouTubeChannelRequest = (
  url: string,
) => Promise<{ url: string; text: string; contentType?: string }>;

export interface YouTubeChannelResolverOptions {
  request: YouTubeChannelRequest;
}

export class YouTubeChannelResolverError extends Error {
  constructor(
    readonly code:
      | "youtube-channel-not-found"
      | "youtube-request-failed"
      | "youtube-feed-invalid",
  ) {
    super(code);
    this.name = "YouTubeChannelResolverError";
  }
}

export async function resolveYouTubeChannel(
  input: string,
  options: YouTubeChannelResolverOptions,
): Promise<YouTubeChannelVerification> {
  const identifier = normalizeYouTubeInput(input);
  const channelId = await resolveChannelId(identifier, options);
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const feed = await request(feedUrl, options);
  const preview = parseFeedPreviewFromText(feed.text, feedUrl);

  if (!preview) {
    throw new YouTubeChannelResolverError("youtube-feed-invalid");
  }

  return {
    channelId,
    channelName: preview.title,
    channelUrl: `https://www.youtube.com/channel/${channelId}`,
    feedUrl,
    latestTitle: preview.latestTitle || undefined,
    latestPubDate: preview.latestPubDate || undefined,
    hasEntries: preview.hasEntries,
  };
}

async function resolveChannelId(
  identifier: YouTubeIdentifier,
  options: YouTubeChannelResolverOptions,
): Promise<string> {
  if (identifier.kind === "channel-id") return identifier.value;

  if (
    identifier.kind === "channel-url" &&
    identifier.value.startsWith("https://www.youtube.com/channel/")
  ) {
    const segments = identifier.value.split("/");
    const channelId = segments[segments.length - 1];
    if (channelId && CHANNEL_ID.test(channelId)) return channelId;
  }

  const channelUrl =
    identifier.kind === "handle"
      ? `https://www.youtube.com/@${identifier.value}`
      : identifier.value;
  const page = await request(channelUrl, options);
  const channelId = extractChannelId(page.text);
  if (!channelId) {
    throw new YouTubeChannelResolverError("youtube-channel-not-found");
  }
  return channelId;
}

async function request(
  url: string,
  options: YouTubeChannelResolverOptions,
): Promise<{ url: string; text: string; contentType?: string }> {
  try {
    return await options.request(url);
  } catch {
    throw new YouTubeChannelResolverError("youtube-request-failed");
  }
}

function extractChannelId(html: string): string | undefined {
  const patterns = [
    /(?:[?&]channel_id=|channel_id=)(UC[A-Za-z0-9_-]{22})/u,
    /youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})/u,
    /(?:channelId|externalId|ucid)"?\s*[:=]\s*"(UC[A-Za-z0-9_-]{22})"/u,
    /data-channel-external-id="(UC[A-Za-z0-9_-]{22})"/u,
  ];

  for (const pattern of patterns) {
    const channelId = html.match(pattern)?.[1];
    if (channelId && CHANNEL_ID.test(channelId)) return channelId;
  }
  return undefined;
}
