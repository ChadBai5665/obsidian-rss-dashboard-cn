import { beforeEach, describe, expect, it, vi } from "vitest";
import * as obsidian from "obsidian";
import { FeedMetadata } from "../../../src/types/discover-types";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";

const fetchFeedXmlMock = vi.fn();

vi.mock("../../../src/services/feed-parser", () => ({
  fetchFeedXml: fetchFeedXmlMock,
}));

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

const oneArticleFeed = `<?xml version="1.0"?>
  <rss><channel><item><title>Ok</title><link>x</link></item></channel></rss>`;

const baseFeed = {
  id: "test-feed",
  title: "Example Feed",
  url: "https://example.com/feed.xml",
  imageUrl: "",
  summary: "A short summary",
  type: "Blog",
  domain: ["Tech"],
  subdomain: [],
  area: [],
  topic: [],
  tags: ["AI"],
};

describe("FeedPreviewModal", () => {
  it("renders localized retry and empty copy in Simplified Chinese", async () => {
    const { FeedPreviewModal } =
      await import("../../../src/modals/feed-preview-modal");
    fetchFeedXmlMock.mockResolvedValueOnce("<rss><channel></channel></rss>");
    const modal = new FeedPreviewModal(new obsidian.App(), baseFeed);
    modal.open();
    await flushPromises();

    expect(modal.contentEl.textContent).toContain("此订阅源中未找到文章");
  });

  it("defaults unknown preview errors to safe Simplified Chinese copy", async () => {
    const { FeedPreviewModal } =
      await import("../../../src/modals/feed-preview-modal");
    fetchFeedXmlMock.mockRejectedValueOnce(new Error("raw preview secret"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const modal = new FeedPreviewModal(new obsidian.App(), baseFeed);
    modal.open();
    await flushPromises();

    expect(modal.contentEl.textContent).toContain("无法加载订阅源预览");
    expect(modal.contentEl.textContent).not.toContain("raw preview secret");
    expect(errorSpy.mock.calls.flat().join(" ")).toContain(
      "raw preview secret",
    );
  });

  beforeEach(() => {
    installObsidianDomPolyfills();
    document.body.empty();
    Object.defineProperty(window, "innerWidth", {
      value: 1400,
      configurable: true,
    });
    fetchFeedXmlMock.mockReset();
    vi.restoreAllMocks();
  });

  it("renders latest articles and opens links on click", async () => {
    const { FeedPreviewModal } =
      await import("../../../src/modals/feed-preview-modal");

    fetchFeedXmlMock.mockResolvedValue(
      `<?xml version="1.0"?>
      <rss xmlns:content="http://purl.org/rss/1.0/modules/content/">
        <channel>
          <item>
            <title>One</title>
            <link>https://example.com/1</link>
            <description><![CDATA[<p>Hello &amp; <b>world</b></p>]]></description>
            <pubDate>2026-03-20T00:00:00.000Z</pubDate>
            <author>Jane</author>
            <content:encoded><![CDATA[<img src="https://example.com/img.jpg" />]]></content:encoded>
          </item>
          <item>
            <title>Two</title>
            <link>https://example.com/2</link>
            <description>Plain</description>
            <pubDate>2026-03-21T00:00:00.000Z</pubDate>
          </item>
        </channel>
      </rss>`,
    );

    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    const app = obsidian.App.createMock();
    const modal = new FeedPreviewModal(
      app as unknown as obsidian.App,
      baseFeed as unknown as FeedMetadata,
      true,
      "en",
    );
    modal.open();

    await flushPromises();

    expect(fetchFeedXmlMock).toHaveBeenCalledWith(
      "https://example.com/feed.xml",
      true,
    );
    expect(modal.contentEl.querySelector(".feed-preview-grid")).toBeTruthy();
    expect(modal.contentEl.textContent).toContain("Latest 2 articles");

    const firstTitle = modal.contentEl.querySelector(
      ".feed-preview-article-title",
    ) as HTMLHeadingElement;
    expect(firstTitle.textContent).toBe("One");

    const firstDescription = modal.contentEl.querySelector(
      ".feed-preview-article-description",
    ) as HTMLDivElement;
    expect(firstDescription.textContent).toContain("Hello & world");
    expect(firstDescription.textContent).not.toContain("<p>");

    firstTitle.click();
    expect(openSpy).toHaveBeenCalledWith("https://example.com/1", "_blank");
  });

  it("removes an article image container on image error", async () => {
    const { FeedPreviewModal } =
      await import("../../../src/modals/feed-preview-modal");

    fetchFeedXmlMock.mockResolvedValue(
      `<?xml version="1.0"?>
      <rss>
        <channel>
          <item>
            <title>One</title>
            <link>https://example.com/1</link>
            <description>Desc</description>
            <enclosure type="image/jpeg" url="https://example.com/img.jpg" />
          </item>
        </channel>
      </rss>`,
    );

    const app = obsidian.App.createMock();
    const modal = new FeedPreviewModal(
      app as unknown as obsidian.App,
      baseFeed as unknown as FeedMetadata,
      true,
      "en",
    );
    modal.open();

    await flushPromises();

    const imageContainer = modal.contentEl.querySelector(
      ".feed-preview-article-image-container",
    ) as HTMLDivElement;
    expect(imageContainer).toBeTruthy();

    const img = imageContainer.querySelector("img") as HTMLImageElement;
    img.dispatchEvent(new Event("error"));

    expect(
      modal.contentEl.querySelector(".feed-preview-article-image-container"),
    ).toBeFalsy();
  });

  it("replaces a Chinese error with loading and then successful content on retry", async () => {
    const { FeedPreviewModal } =
      await import("../../../src/modals/feed-preview-modal");

    const firstRequest = createDeferred<string>();
    const retryRequest = createDeferred<string>();
    fetchFeedXmlMock
      .mockReturnValueOnce(firstRequest.promise)
      .mockReturnValueOnce(retryRequest.promise);

    const app = obsidian.App.createMock();
    const modal = new FeedPreviewModal(
      app as unknown as obsidian.App,
      baseFeed as unknown as FeedMetadata,
      true,
    );
    modal.open();

    firstRequest.reject(new Error("boom"));
    await flushPromises();

    expect(modal.contentEl.textContent).toContain("无法加载订阅源预览");
    expect(modal.contentEl.textContent).not.toContain("boom");

    const retryBtn = modal.contentEl.querySelector(
      "button.mod-cta",
    ) as HTMLButtonElement;
    expect(retryBtn?.textContent).toBe("重试");

    retryBtn.click();

    expect(modal.contentEl.querySelectorAll(".feed-preview-loading")).toHaveLength(
      1,
    );
    expect(modal.contentEl.querySelectorAll(".feed-preview-error")).toHaveLength(
      0,
    );
    expect(modal.contentEl.querySelectorAll(".feed-preview-empty")).toHaveLength(
      0,
    );
    expect(modal.contentEl.querySelectorAll(".feed-preview-content")).toHaveLength(
      0,
    );

    retryRequest.resolve(oneArticleFeed);
    await flushPromises();

    expect(fetchFeedXmlMock).toHaveBeenCalledTimes(2);
    expect(modal.contentEl.querySelectorAll(".feed-preview-loading")).toHaveLength(
      0,
    );
    expect(modal.contentEl.querySelectorAll(".feed-preview-error")).toHaveLength(
      0,
    );
    expect(modal.contentEl.querySelectorAll(".feed-preview-content")).toHaveLength(
      1,
    );
    expect(modal.contentEl.textContent).toContain("最新 1 篇文章");
  });

  it("keeps exactly one English error after a failed retry", async () => {
    const { FeedPreviewModal } =
      await import("../../../src/modals/feed-preview-modal");

    const retryRequest = createDeferred<string>();
    fetchFeedXmlMock
      .mockRejectedValueOnce(new Error("first raw error"))
      .mockReturnValueOnce(retryRequest.promise);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const modal = new FeedPreviewModal(
      obsidian.App.createMock() as unknown as obsidian.App,
      baseFeed as unknown as FeedMetadata,
      true,
      "en",
    );
    modal.open();
    await flushPromises();

    const retryBtn = modal.contentEl.querySelector(
      "button.mod-cta",
    ) as HTMLButtonElement;
    retryBtn.click();

    expect(modal.contentEl.querySelectorAll(".feed-preview-loading")).toHaveLength(
      1,
    );
    expect(modal.contentEl.querySelectorAll(".feed-preview-error")).toHaveLength(
      0,
    );

    retryRequest.reject(new Error("second raw error"));
    await flushPromises();

    expect(modal.contentEl.querySelectorAll(".feed-preview-loading")).toHaveLength(
      0,
    );
    expect(modal.contentEl.querySelectorAll(".feed-preview-error")).toHaveLength(
      1,
    );
    expect(modal.contentEl.textContent).toContain(
      "Could not load the feed preview",
    );
    expect(modal.contentEl.textContent).not.toContain("first raw error");
    expect(modal.contentEl.textContent).not.toContain("second raw error");
  });

  it("replaces an empty state with loading before a later successful load", async () => {
    const { FeedPreviewModal } =
      await import("../../../src/modals/feed-preview-modal");

    const reloadRequest = createDeferred<string>();
    fetchFeedXmlMock
      .mockResolvedValueOnce("<rss><channel></channel></rss>")
      .mockReturnValueOnce(reloadRequest.promise);

    const modal = new FeedPreviewModal(
      obsidian.App.createMock() as unknown as obsidian.App,
      baseFeed as unknown as FeedMetadata,
      true,
      "en",
    );
    modal.open();
    await flushPromises();

    expect(modal.contentEl.querySelectorAll(".feed-preview-empty")).toHaveLength(
      1,
    );

    const reload = (
      modal as unknown as { loadFeedPreview: () => Promise<void> }
    ).loadFeedPreview();

    expect(modal.contentEl.querySelectorAll(".feed-preview-empty")).toHaveLength(
      0,
    );
    expect(modal.contentEl.querySelectorAll(".feed-preview-loading")).toHaveLength(
      1,
    );

    reloadRequest.resolve(oneArticleFeed);
    await reload;

    expect(modal.contentEl.querySelectorAll(".feed-preview-loading")).toHaveLength(
      0,
    );
    expect(modal.contentEl.querySelectorAll(".feed-preview-content")).toHaveLength(
      1,
    );
  });

  it("ignores an older request that completes after a newer request", async () => {
    const { FeedPreviewModal } =
      await import("../../../src/modals/feed-preview-modal");

    const olderRequest = createDeferred<string>();
    const newerRequest = createDeferred<string>();
    fetchFeedXmlMock
      .mockReturnValueOnce(olderRequest.promise)
      .mockReturnValueOnce(newerRequest.promise);

    const modal = new FeedPreviewModal(
      obsidian.App.createMock() as unknown as obsidian.App,
      baseFeed as unknown as FeedMetadata,
      true,
      "en",
    );
    modal.open();
    const newerLoad = (
      modal as unknown as { loadFeedPreview: () => Promise<void> }
    ).loadFeedPreview();

    newerRequest.resolve(oneArticleFeed);
    await newerLoad;
    olderRequest.resolve("<rss><channel></channel></rss>");
    await flushPromises();

    expect(modal.contentEl.querySelectorAll(".feed-preview-loading")).toHaveLength(
      0,
    );
    expect(modal.contentEl.querySelectorAll(".feed-preview-empty")).toHaveLength(
      0,
    );
    expect(modal.contentEl.querySelectorAll(".feed-preview-content")).toHaveLength(
      1,
    );
    expect(modal.contentEl.textContent).toContain("Latest 1 articles");
  });

  it("shows an empty state when no articles are found", async () => {
    const { FeedPreviewModal } =
      await import("../../../src/modals/feed-preview-modal");

    fetchFeedXmlMock.mockResolvedValue(
      `<?xml version="1.0"?><rss><channel></channel></rss>`,
    );

    const app = obsidian.App.createMock();
    const modal = new FeedPreviewModal(
      app as unknown as obsidian.App,
      baseFeed as unknown as FeedMetadata,
      true,
      "en",
    );
    modal.open();

    await flushPromises();

    expect(modal.contentEl.textContent).toContain(
      "No articles found in this feed",
    );
  });
});
