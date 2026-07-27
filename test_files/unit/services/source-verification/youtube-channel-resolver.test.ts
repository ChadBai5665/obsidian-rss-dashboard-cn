import { describe, expect, it } from "vitest";
import {
  resolveYouTubeChannel,
} from "../../../../src/services/source-verification/youtube-channel-resolver.js";

const CHANNEL_ID = "UC_x5XG1OV2P6uZZ5FSM9Ttw";
const FEED_URL = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`;
const CHANNEL_HTML = `<html><head><link rel="canonical" href="https://www.youtube.com/channel/${CHANNEL_ID}"></head></html>`;
const CHANNEL_JSON = `<script>var data = {"channelId":"${CHANNEL_ID}"};</script>`;
const FEED_XML = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>OpenAI</title><entry><title>Latest video</title><published>2026-07-27T10:00:00Z</published></entry></feed>`;

describe("resolveYouTubeChannel", () => {
  it("resolves a canonical channel ID to its official feed and latest video metadata", async () => {
    const requested: string[] = [];

    const result = await resolveYouTubeChannel(CHANNEL_ID, {
      request: async (url) => {
        requested.push(url);
        return { url, text: FEED_XML };
      },
    });

    expect(requested).toEqual([FEED_URL]);
    expect(result).toEqual({
      channelId: CHANNEL_ID,
      channelName: "OpenAI",
      channelUrl: `https://www.youtube.com/channel/${CHANNEL_ID}`,
      feedUrl: FEED_URL,
      latestTitle: "Latest video",
      latestPubDate: "2026-07-27T10:00:00Z",
      hasEntries: true,
    });
  });

  it.each([
    ["https://www.youtube.com/@OpenAI", "https://www.youtube.com/@OpenAI"],
    ["https://www.youtube.com/c/OpenAI", "https://www.youtube.com/c/OpenAI"],
  ])("resolves %s by discovering its channel ID", async (input, channelUrl) => {
    const requested: string[] = [];

    const result = await resolveYouTubeChannel(input, {
      request: async (url) => {
        requested.push(url);
        return {
          url,
          text:
            url === channelUrl
              ? input.includes("/c/")
                ? CHANNEL_JSON
                : CHANNEL_HTML
              : FEED_XML,
        };
      },
    });

    expect(requested).toEqual([channelUrl, FEED_URL]);
    expect(result.channelId).toBe(CHANNEL_ID);
    expect(result.channelUrl).toBe(
      `https://www.youtube.com/channel/${CHANNEL_ID}`,
    );
  });

  it("rejects a channel page that does not disclose a channel ID", async () => {
    const result = resolveYouTubeChannel("@OpenAI", {
      request: async (url) => ({ url, text: "<html><head></head></html>" }),
    });

    await expect(result).rejects.toEqual(
      expect.objectContaining({
        code: "youtube-channel-not-found",
        message: "youtube-channel-not-found",
      }),
    );
  });

  it.each([
    "https://www.youtube.com/watch?v=abc",
    "https://www.youtube.com/playlist?list=abc",
  ])("rejects unsupported YouTube routes: %s", async (input) => {
    const result = resolveYouTubeChannel(input, {
      request: async (url) => ({ url, text: FEED_XML }),
    });

    await expect(result).rejects.toMatchObject({ code: "youtube-not-channel" });
  });
});
