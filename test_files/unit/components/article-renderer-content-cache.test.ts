import { beforeEach, describe, expect, it, vi } from "vitest";
import { ArticleRenderer } from "../../../src/components/article-renderer";
import type { YouTubeTranscriptCachedItemContent } from "../../../src/collection/content-repository";
import { DEFAULT_SETTINGS, type FeedItem, type RssDashboardSettings } from "../../../src/types/types";
import type {
  YouTubeTranscriptRequest,
  YouTubeTranscriptServiceResult,
} from "../../../src/youtube-transcript/youtube-transcript-service";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";

const fetchMock = vi.hoisted(() => vi.fn());
const readMock = vi.hoisted(() => vi.fn());
const writeMock = vi.hoisted(() => vi.fn());
const metadataMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/utils/full-article-fetch", async () => ({
  ...(await vi.importActual<typeof import("../../../src/utils/full-article-fetch")>("../../../src/utils/full-article-fetch")),
  fetchFullArticleContentWithOutcome: fetchMock,
}));
vi.mock("../../../src/collection/content-repository", () => ({
  ContentRepository: class {
    read = readMock;
    write = writeMock;
    pathFor = (id: string) => `.rss-dashboard-data/content/${id}.md`;
    transaction = async (
      id: string,
      operation: (transaction: {
        read: typeof readMock;
        write: typeof writeMock;
        pathFor: () => string;
      }) => Promise<unknown>,
    ) =>
      await operation({
        read: readMock,
        write: writeMock,
        pathFor: () => `.rss-dashboard-data/content/${id}.md`,
      });
  },
}));
vi.mock("../../../src/collection/collection-repository", () => ({
  CollectionRepository: class { updateContentMetadata = metadataMock; },
}));

installObsidianDomPolyfills();

function item(overrides: Partial<FeedItem> = {}): FeedItem {
  return { title: "Inline", link: "https://example.com/inline", description: "<p>fallback</p>", content: "", pubDate: "2026-07-21T00:00:00.000Z", guid: "inline", read: false, starred: false, tags: [], feedTitle: "Feed", feedUrl: "https://example.com/rss", coverImage: "", mediaType: "article", saved: false, ...overrides };
}

function renderer(
  locale: "zh-CN" | "en" = "en",
  options: Record<string, unknown> = {},
): ArticleRenderer {
  return new ArticleRenderer({
    app: { workspace: { getLeavesOfType: vi.fn().mockReturnValue([]) }, vault: { adapter: {} } } as never,
    settings: { ...DEFAULT_SETTINGS, locale, corsProxyEnabled: false } as RssDashboardSettings,
    onArticleSave: vi.fn(), onArticleUpdate: vi.fn(),
    ...options,
  });
}

function transcript(
  itemId: string,
  overrides: Partial<YouTubeTranscriptCachedItemContent> = {},
): YouTubeTranscriptCachedItemContent {
  return {
    schemaVersion: 2,
    contentBasis: "youtube-transcript",
    itemId,
    sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    fetchedAt: "2026-07-28T06:00:00.000Z",
    videoId: "dQw4w9WgXcQ",
    languageCode: "en",
    languageName: "English",
    isGenerated: false,
    provider: "innertube",
    text: "Inline cached transcript.",
    ...overrides,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe("ArticleRenderer explicit content cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readMock.mockResolvedValue(null);
    writeMock.mockImplementation(async (content) => `.rss-dashboard-data/content/${content.itemId}.md`);
    metadataMock.mockResolvedValue(undefined);
    fetchMock.mockResolvedValue({ content: `<article><p>${"X".repeat(260)}</p></article>`, failureType: "none" });
  });

  it("caches an inline explicit article open and reuses it on dashboard rerender", async () => {
    const view = renderer(); const container = document.createElement("div"); const article = item();
    await view.render(container, article);
    readMock.mockResolvedValue({ schemaVersion: 1, itemId: "a".repeat(64), fetchedAt: "2026-07-21T00:00:00.000Z", contentBasis: "full-text", text: `<article><p>${"Y".repeat(260)}</p></article>` });
    await view.render(container, article);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(metadataMock).toHaveBeenCalled();
  });

  it("returns the content basis of the content rendered by the current request", async () => {
    const view = renderer();
    const container = document.createElement("div");

    await expect(view.render(container, item())).resolves.toBe("full-text");
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(metadataMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce({ content: "", failureType: "network" });
    await expect(view.render(container, item({ guid: "fallback", link: "https://example.com/fallback" })))
      .resolves.toBe("feed");
  });

  it("keeps a bounded renderer-session result when durable cache writing fails", async () => {
    writeMock.mockRejectedValueOnce(new Error("disk unavailable"));
    const view = renderer(); const container = document.createElement("div"); const article = item();
    await view.render(container, article);
    await view.render(container, article);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not render late content after inline renderer disposal", async () => {
    let resolveFetch: ((value: { content: string; failureType: "none" }) => void) | undefined;
    fetchMock.mockImplementation(() => new Promise((resolve) => { resolveFetch = resolve; }));
    const view = renderer(); const container = document.createElement("div");
    const rendering = view.render(container, item());
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    view.dispose();
    resolveFetch?.({ content: `<article><p>${"L".repeat(260)}</p></article>`, failureType: "none" });
    await rendering;
    expect(container.childElementCount).toBe(0);
    expect((view as unknown as { sessionContent: Map<string, unknown> }).sessionContent.size).toBe(0);
  });

  it.each(["https://youtube.com/watch?v=x", "https://www.youtube.com/watch?v=x", "https://m.youtube.com/watch?v=x", "https://youtu.be/x"])("never fetches a YouTube article URL: %s", async (link) => {
    await renderer().render(document.createElement("div"), item({ link, mediaType: "article" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readMock).not.toHaveBeenCalled();
  });

  it("never fetches an item from a YouTube feed even if its media type is article", async () => {
    await renderer().render(document.createElement("div"), item({ feedUrl: "https://www.youtube.com/feeds/videos.xml?channel_id=secret", mediaType: "article" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readMock).not.toHaveBeenCalled();
  });

  it("uses the same external-first and lazy-preview controls for an inline YouTube item", async () => {
    const container = document.createElement("div");

    await renderer("zh-CN").render(
      container,
      item({
        guid: "inline-youtube",
        mediaType: "video",
        videoId: "dQw4w9WgXcQ",
        link: "https://youtu.be/dQw4w9WgXcQ",
      }),
    );

    const external = container.querySelector<HTMLAnchorElement>(
      ".rss-video-youtube-button",
    );
    expect(external?.getAttribute("href")).toBe(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );
    expect(external?.textContent).toContain("在浏览器中播放");
    expect(container.querySelector("iframe")).toBeNull();

    container
      .querySelector<HTMLButtonElement>(".rss-video-inline-toggle")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(container.querySelector<HTMLIFrameElement>("iframe")?.src).toContain(
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    );
  });

  it("mounts the transcript panel for inline YouTube and restores cache only through the shared service", async () => {
    const get = vi.fn();
    const readCached = vi.fn(async (request: { itemId: string }) =>
      transcript(request.itemId),
    );
    const onContentBasisChange = vi.fn();
    const runtime = {
      identity: "test-root",
      service: { get, readCached, revokeChoiceSet: vi.fn() },
    };
    const resolveRuntime = vi.fn(() => runtime);
    const view = renderer("en", {
      youtubeTranscript: { resolveRuntime },
      onContentBasisChange,
    });
    const container = document.createElement("div");
    const video = item({
      guid: "inline-youtube-cache",
      mediaType: "video",
      videoId: "dQw4w9WgXcQ",
      link: "https://youtu.be/dQw4w9WgXcQ",
    });

    await expect(view.render(container, video)).resolves.toBe(
      "youtube-transcript",
    );

    expect(resolveRuntime).toHaveBeenCalled();
    expect(readCached).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: expect.stringMatching(/^[a-f0-9]{64}$/),
        videoId: "dQw4w9WgXcQ",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(get).not.toHaveBeenCalled();
    expect(
      container
        .querySelector<HTMLElement>(".rss-youtube-transcript-panel")
        ?.getAttribute("data-state"),
    ).toBe("cached");
    expect(container.textContent).toContain("Inline cached transcript.");
    expect(onContentBasisChange).toHaveBeenCalledWith(
      video,
      "youtube-transcript",
    );
  });

  it("supports inline fetch, track choice, and explicit refresh through the shared runtime", async () => {
    const requests: YouTubeTranscriptRequest[] = [];
    const get = vi.fn(async (request: YouTubeTranscriptRequest) => {
      requests.push(request);
      if (requests.length === 1) {
        return {
          status: "selection-required",
          choiceSetId: "choice-set-inline",
          tracks: [
            {
              id: "track-inline-en",
              languageCode: "en",
              languageName: "English",
              isGenerated: false,
              provider: "innertube",
            },
          ],
        } satisfies YouTubeTranscriptServiceResult;
      }
      return {
        status: "ready",
        source: "fresh",
        content: transcript(request.itemId, {
          text: requests.length === 2
            ? "Selected inline transcript."
            : "Refreshed inline transcript.",
        }),
      } satisfies YouTubeTranscriptServiceResult;
    });
    const runtime = {
      identity: "test-root",
      service: {
        get,
        readCached: vi.fn(async () => null),
        revokeChoiceSet: vi.fn(),
      },
    };
    const view = renderer("en", {
      youtubeTranscript: {
        resolveRuntime: () => runtime,
      },
    });
    const container = document.createElement("div");

    await view.render(container, item({
      guid: "inline-youtube-actions",
      mediaType: "video",
      videoId: "dQw4w9WgXcQ",
      link: "https://youtu.be/dQw4w9WgXcQ",
    }));
    container
      .querySelector<HTMLButtonElement>(".rss-youtube-transcript-fetch")
      ?.click();
    await vi.waitFor(() =>
      expect(
        container.querySelector(".rss-youtube-transcript-language"),
      ).not.toBeNull(),
    );
    container
      .querySelector<HTMLButtonElement>(".rss-youtube-transcript-language")
      ?.click();
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Selected inline transcript."),
    );
    container
      .querySelector<HTMLButtonElement>(".rss-youtube-transcript-refresh")
      ?.click();
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Refreshed inline transcript."),
    );

    expect(requests[0]).toMatchObject({ refresh: false });
    expect(requests[1]).toMatchObject({ trackId: "track-inline-en" });
    expect(requests[2]).toMatchObject({ refresh: true });
  });

  it("destroys the previous inline transcript generation and revokes its choice lease on rerender", async () => {
    const pending = deferred<YouTubeTranscriptServiceResult>();
    let activeSignal: AbortSignal | undefined;
    const revokeChoiceSet = vi.fn();
    const get = vi
      .fn(async (request: YouTubeTranscriptRequest) => {
        activeSignal = request.signal;
        return await pending.promise;
      })
      .mockResolvedValueOnce({
        status: "selection-required",
        choiceSetId: "choice-set-old-inline",
        tracks: [{
          id: "old-inline-track",
          languageCode: "en",
          languageName: "English",
          isGenerated: false,
          provider: "innertube",
        }],
      });
    const runtime = {
      identity: "test-root",
      service: {
        get,
        readCached: vi.fn(async () => null),
        revokeChoiceSet,
      },
    };
    const view = renderer("en", {
      youtubeTranscript: {
        resolveRuntime: () => runtime,
      },
    });
    const container = document.createElement("div");
    const video = item({
      guid: "inline-youtube-old",
      mediaType: "video",
      videoId: "dQw4w9WgXcQ",
      link: "https://youtu.be/dQw4w9WgXcQ",
    });

    await view.render(container, video);
    container
      .querySelector<HTMLButtonElement>(".rss-youtube-transcript-fetch")
      ?.click();
    await vi.waitFor(() =>
      expect(container.querySelector(".rss-youtube-transcript-language"))
        .not.toBeNull(),
    );
    container
      .querySelector<HTMLButtonElement>(".rss-youtube-transcript-language")
      ?.click();
    await vi.waitFor(() => expect(activeSignal).toBeDefined());

    await view.render(container, item({ guid: "next-article" }));

    expect(activeSignal?.aborted).toBe(true);
    expect(revokeChoiceSet).toHaveBeenCalledWith("choice-set-old-inline");
    pending.resolve({
      status: "ready",
      source: "fresh",
      content: transcript("a".repeat(64), { text: "Stale inline text." }),
    });
    await Promise.resolve();
    expect(container.textContent).not.toContain("Stale inline text.");
    expect(container.querySelector(".rss-youtube-transcript-panel")).toBeNull();
  });

  it("contains inline transcript runtime failures and never mounts a panel for non-YouTube items", async () => {
    const resolveRuntime = vi.fn(() => {
      throw new Error("invalid transcript root");
    });
    const view = renderer("en", {
      youtubeTranscript: { resolveRuntime },
    });
    const container = document.createElement("div");

    await expect(view.render(container, item({
      guid: "inline-youtube-broken-runtime",
      mediaType: "video",
      videoId: "dQw4w9WgXcQ",
      link: "https://youtu.be/dQw4w9WgXcQ",
    }))).resolves.toBe("title-description");
    expect(container.textContent).toContain("Inline");
    expect(
      container
        .querySelector<HTMLElement>(".rss-youtube-transcript-panel")
        ?.getAttribute("data-state"),
    ).toBe("temporarily-unavailable");

    resolveRuntime.mockClear();
    await view.render(container, item({ guid: "ordinary-article" }));
    expect(resolveRuntime).not.toHaveBeenCalled();
    expect(container.querySelector(".rss-youtube-transcript-panel")).toBeNull();
  });

  it.each([
    ["zh-CN", "未找到视频 URL，无法播放此视频播客。"],
    ["en", "Video URL not found. Cannot play this video podcast."],
  ] as const)("renders the inline %s missing-video-podcast state without the generic watch-source fallback", async (locale, expected) => {
    const container = document.createElement("div");

    await expect(renderer(locale).render(container, item({
      guid: `inline-missing-video-${locale}`,
      mediaType: "video",
      mediaContentType: "video/mp4",
      videoUrl: undefined,
      link: "https://example.com/video-source",
    }))).resolves.toBe("title-description");

    expect(container.querySelector(".rss-reader-error")?.textContent).toContain(expected);
    expect(container.querySelector(".rss-reader-video-banner")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
