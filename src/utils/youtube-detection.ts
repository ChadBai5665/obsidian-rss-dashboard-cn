import type { FeedItem } from "../types/types";

export function isYouTubeItem(item: Pick<FeedItem, "link" | "feedUrl">): boolean {
  return [item.link, item.feedUrl].some(isYouTubeUrl);
}

export function isYouTubeUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const host = new URL(value).hostname.toLowerCase();
    return (
      host === "youtu.be" ||
      host === "youtube.com" ||
      host.endsWith(".youtube.com") ||
      host === "youtube-nocookie.com" ||
      host.endsWith(".youtube-nocookie.com")
    );
  } catch {
    return false;
  }
}
