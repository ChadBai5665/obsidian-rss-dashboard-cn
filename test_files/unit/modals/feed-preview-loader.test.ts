import { beforeEach, describe, expect, it, vi } from "vitest";
import { MediaService } from "../../../src/services/media-service";

const loadFeedForPreviewMock = vi.fn();

vi.mock("../../../src/services/feed-parser", () => ({
  loadFeedForPreview: loadFeedForPreviewMock,
  resolvePodcastPlatformUrl: vi.fn(),
}));

vi.mock("../../../src/utils/podcast-platforms", () => ({
  detectPodcastPlatform: vi.fn(),
}));

describe("resolveAndLoadPreview", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    loadFeedForPreviewMock.mockReset().mockResolvedValue({
      title: "OpenAI",
      latestPubDate: "2026-07-27T10:00:00.000Z",
      hasEntries: true,
    });
  });

  it("resolves YouTube handles before generic Mastodon discovery", async () => {
    const { getDefaultFolderForResolvedFeed, resolveAndLoadPreview } =
      await import("../../../src/modals/feed-manager/feed-preview-loader");
    vi.spyOn(MediaService, "getYouTubeRssFeed").mockResolvedValue(
      "https://www.youtube.com/feeds/videos.xml?channel_id=UC_x5XG1OV2P6uZZ5FSM9Ttw",
    );
    vi.spyOn(MediaService, "getMastodonRssFeed").mockResolvedValue(
      "https://mastodon.social/@OpenAI.rss",
    );

    const result = await resolveAndLoadPreview(
      "https://www.youtube.com/@OpenAI",
    );

    expect(result.detectedType).toBe("youtube");
    expect(result.isMastodonConversion).toBe(false);
    expect(getDefaultFolderForResolvedFeed(result, {})).toBe("Videos");
  });
});
