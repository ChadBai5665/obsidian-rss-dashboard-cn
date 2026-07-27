import { describe, expect, it } from "vitest";
import {
  normalizeRssWebsiteInput,
  normalizeXAccountInput,
  normalizeYouTubeInput,
} from "../../../../src/services/source-verification/source-identifier.js";

describe("source identifier normalization", () => {
  it("normalizes an RSS or website HTTP(S) URL", () => {
    expect(normalizeRssWebsiteInput("https://example.com/news").href).toBe(
      "https://example.com/news",
    );
  });

  it.each([
    "ftp://example.com/feed.xml",
    "https://user:password@example.com/feed.xml",
    "https://example.com/with space",
    "https://example.com/with\u0000control",
    "https://example.com/" + "a".repeat(2_030),
  ])("rejects an unsafe RSS or website URL", (input) => {
    expect(() => normalizeRssWebsiteInput(input)).toThrow();
  });

  it("normalizes an X handle or supported profile URL", () => {
    expect(normalizeXAccountInput("OpenAI")).toBe("openai");
    expect(normalizeXAccountInput("@OpenAI")).toBe("openai");
    expect(normalizeXAccountInput("https://x.com/OpenAI")).toBe("openai");
  });

  it.each([
    "https://x.com/OpenAI/status/1",
    "https://x.com/search?q=OpenAI",
    "https://x.com/home",
    "@open-ai",
    "open ai",
    "openai\u0000",
    "a".repeat(16),
    "x".repeat(2_049),
  ])("rejects an X non-profile route or invalid handle", (input) => {
    expect(() => normalizeXAccountInput(input)).toThrow();
  });

  it("normalizes supported YouTube channel identifiers", () => {
    expect(normalizeYouTubeInput("https://www.youtube.com/@OpenAI")).toEqual({
      kind: "handle",
      value: "OpenAI",
    });
    expect(normalizeYouTubeInput("@OpenAI")).toEqual({
      kind: "handle",
      value: "OpenAI",
    });
    expect(normalizeYouTubeInput("UC_x5XG1OV2P6uZZ5FSM9Ttw")).toEqual({
      kind: "channel-id",
      value: "UC_x5XG1OV2P6uZZ5FSM9Ttw",
    });
    expect(
      normalizeYouTubeInput(
        "https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw",
      ),
    ).toEqual({
      kind: "channel-url",
      value: "https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw",
    });
  });

  it.each([
    "https://www.youtube.com/watch?v=abc",
    "https://www.youtube.com/playlist?list=abc",
    "https://www.youtube.com/results?search_query=OpenAI",
    "https://user:password@www.youtube.com/@OpenAI",
    "https://www.youtube.com/@Open AI",
    "https://www.youtube.com/@OpenAI\u0000",
    "https://www.example.com/@OpenAI",
    "@open ai",
    "@" + "a".repeat(2_048),
  ])("rejects a non-channel or unsafe YouTube input", (input) => {
    expect(() => normalizeYouTubeInput(input)).toThrow();
  });

  it("uses the stable YouTube non-channel error code", () => {
    expect(() =>
      normalizeYouTubeInput("https://www.youtube.com/watch?v=abc"),
    ).toThrow("youtube-not-channel");
  });
});
