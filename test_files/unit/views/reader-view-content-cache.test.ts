import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReaderView } from "../../../src/views/reader-view";
import {
  DEFAULT_SETTINGS,
  type FeedItem,
  type RssDashboardSettings,
} from "../../../src/types/types";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";
import type { YouTubeTranscriptCachedItemContent } from "../../../src/collection/content-repository";
import type {
  YouTubeTranscriptRequest,
  YouTubeTranscriptServiceResult,
} from "../../../src/youtube-transcript/youtube-transcript-service";

const fetchFullArticleContentWithOutcomeMock = vi.hoisted(() => vi.fn());
const contentReadMock = vi.hoisted(() => vi.fn());
const contentWriteMock = vi.hoisted(() => vi.fn());
const contentRemoveMock = vi.hoisted(() => vi.fn());
const updateContentMetadataMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/utils/full-article-fetch", async () => {
  const actual = await vi.importActual<
    typeof import("../../../src/utils/full-article-fetch")
  >("../../../src/utils/full-article-fetch");
  return {
    ...actual,
    fetchFullArticleContentWithOutcome: fetchFullArticleContentWithOutcomeMock,
  };
});

vi.mock("../../../src/collection/content-repository", () => ({
  ContentRepository: class {
    read = contentReadMock;
    write = contentWriteMock;
    remove = contentRemoveMock;
    pathFor = (itemId: string) => `.rss-dashboard-data/content/${itemId}.md`;
    transaction = async (
      itemId: string,
      operation: (transaction: {
        read(): Promise<unknown>;
        write(content: unknown): Promise<string>;
        pathFor(): string;
      }) => Promise<unknown>,
    ) => await operation({
      read: async () => await contentReadMock(itemId),
      write: async (content) => await contentWriteMock(content),
      pathFor: () => `.rss-dashboard-data/content/${itemId}.md`,
    });
  },
}));

vi.mock("../../../src/collection/collection-repository", () => ({
  CollectionRepository: class {
    updateContentMetadata = updateContentMetadataMock;
  },
}));

installObsidianDomPolyfills();

class MockLeaf {
  app: unknown;
  constructor(app: unknown) {
    this.app = app;
  }
  detach = vi.fn();
}

function makeItem(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    title: "Cacheable Article",
    link: "https://example.com/cacheable",
    description: "<p>Feed fallback.</p>",
    content: "",
    pubDate: "2026-07-21T10:00:00.000Z",
    guid: "cacheable-guid",
    read: false,
    starred: false,
    tags: [],
    feedTitle: "Example Feed",
    feedUrl: "https://example.com/rss.xml",
    coverImage: "",
    mediaType: "article",
    saved: false,
    ...overrides,
  };
}

function createReader(
  options?: ConstructorParameters<typeof ReaderView>[5],
): ReaderView {
  const app = {
    workspace: {
      getLeavesOfType: vi.fn().mockReturnValue([]),
      setActiveLeaf: vi.fn(),
      revealLeaf: vi.fn(),
    },
    vault: {
      adapter: {},
      getAbstractFileByPath: vi.fn(),
    },
  };
  const settings: RssDashboardSettings = {
    ...DEFAULT_SETTINGS,
    locale: "en",
    useWebViewer: false,
    corsProxyEnabled: false,
  };
  const reader = new ReaderView(
    new MockLeaf(app) as never,
    settings,
    { saveArticle: vi.fn(), checkSavedFileExists: vi.fn(() => true) } as never,
    vi.fn(),
    vi.fn(),
    options,
  );
  (reader as unknown as { contentEl: HTMLElement }).contentEl =
    document.createElement("div");
  return reader;
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
    text: "A cached transcript restored locally.",
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

describe("ReaderView explicit full-text content cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
    contentReadMock.mockResolvedValue(null);
    contentWriteMock.mockImplementation(
      async (content) => `.rss-dashboard-data/content/${content.itemId}.md`,
    );
    updateContentMetadataMock.mockResolvedValue(undefined);
    fetchFullArticleContentWithOutcomeMock.mockResolvedValue({
      content: `<article><p>${"A".repeat(260)}</p></article>`,
      failureType: "none",
    });
  });

  it("fetches only when a normal article is explicitly opened, then caches durable full text", async () => {
    const reader = createReader();
    const item = makeItem();
    await reader.onOpen();

    await reader.displayItem(item);

    expect(fetchFullArticleContentWithOutcomeMock).toHaveBeenCalledTimes(1);
    expect(contentWriteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        contentBasis: "full-text",
        sourceUrl: item.link,
      }),
    );
    expect(updateContentMetadataMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringMatching(
        /^\.rss-dashboard-data\/content\/[a-f0-9]{64}\.md$/,
      ),
    );
  });

  it("keeps feed content and creates no cache file after a restricted or empty extraction", async () => {
    const reader = createReader();
    const item = makeItem();
    fetchFullArticleContentWithOutcomeMock.mockResolvedValue({
      content: "",
      failureType: "restricted",
    });
    await reader.onOpen();

    await reader.displayItem(item);

    expect(contentWriteMock).not.toHaveBeenCalled();
    expect(updateContentMetadataMock).not.toHaveBeenCalled();
    expect(
      (reader as unknown as { readingContainer: HTMLElement }).readingContainer
        .textContent,
    ).toContain("Feed fallback.");
  });

  it("reuses cached full text on a later explicit open without another network request", async () => {
    const cachedText = `<article><p>${"B".repeat(260)}</p></article>`;
    contentReadMock.mockResolvedValueOnce(null).mockResolvedValueOnce({
      schemaVersion: 1,
      itemId: "a".repeat(64),
      fetchedAt: "2026-07-21T12:00:00.000Z",
      contentBasis: "full-text",
      text: cachedText,
    });
    const reader = createReader();
    const item = makeItem();
    await reader.onOpen();

    await reader.displayItem(item);
    await reader.displayItem(item);

    expect(fetchFullArticleContentWithOutcomeMock).toHaveBeenCalledTimes(1);
    expect(contentWriteMock).toHaveBeenCalledTimes(1);
    expect(
      (reader as unknown as { currentFullContent: string }).currentFullContent,
    ).toBe(cachedText);
  });

  it("deduplicates overlapping opens of the same article and ignores a stale completion", async () => {
    let resolveFirst:
      | ((value: { content: string; failureType: "none" }) => void)
      | undefined;
    fetchFullArticleContentWithOutcomeMock.mockImplementation(
      () =>
        new Promise<{ content: string; failureType: "none" }>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const reader = createReader();
    const first = makeItem({ title: "First", guid: "first-guid" });
    await reader.onOpen();

    const openingOne = reader.displayItem(first);
    const openingTwo = reader.displayItem(first);
    await vi.waitFor(() => {
      expect(fetchFullArticleContentWithOutcomeMock).toHaveBeenCalledTimes(1);
    });

    resolveFirst?.({
      content: `<article><p>${"C".repeat(260)}</p></article>`,
      failureType: "none",
    });
    await Promise.all([openingOne, openingTwo]);

    expect(reader.getDisplayText()).toBe("First");
  });

  it("does not render late fetched content after the reader closes", async () => {
    let resolveFetch:
      | ((value: { content: string; failureType: "none" }) => void)
      | undefined;
    fetchFullArticleContentWithOutcomeMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const reader = createReader();
    await reader.onOpen();
    const opening = reader.displayItem(makeItem());
    await vi.waitFor(() =>
      expect(fetchFullArticleContentWithOutcomeMock).toHaveBeenCalledTimes(1),
    );
    await reader.onClose();
    resolveFetch?.({
      content: `<article><p>${"Z".repeat(260)}</p></article>`,
      failureType: "none",
    });
    await opening;

    expect(reader.getDisplayText()).toBe("RSS reader");
    expect(
      (reader as unknown as { readingContainer: HTMLElement }).readingContainer
        .childElementCount,
    ).toBe(0);
  });

  it("does not let a late first item replace a newer item", async () => {
    const resolvers: Array<
      (value: { content: string; failureType: "none" }) => void
    > = [];
    fetchFullArticleContentWithOutcomeMock.mockImplementation(
      () => new Promise((resolve) => resolvers.push(resolve)),
    );
    const reader = createReader();
    await reader.onOpen();
    const firstOpen = reader.displayItem(
      makeItem({ title: "Old", guid: "old", link: "https://example.com/old" }),
    );
    const secondOpen = reader.displayItem(
      makeItem({ title: "New", guid: "new", link: "https://example.com/new" }),
    );
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    resolvers[1]({
      content: `<article><p>${"N".repeat(260)}</p></article>`,
      failureType: "none",
    });
    await secondOpen;
    resolvers[0]({
      content: `<article><p>${"O".repeat(260)}</p></article>`,
      failureType: "none",
    });
    await firstOpen;
    expect(reader.getDisplayText()).toBe("New");
  });

  it("never fetches or caches YouTube video content", async () => {
    const reader = createReader();
    const item = makeItem({
      link: "https://www.youtube.com/watch?v=abc123",
      mediaType: "video",
      videoId: "abc123",
    });
    await reader.onOpen();

    await reader.displayItem(item);

    expect(fetchFullArticleContentWithOutcomeMock).not.toHaveBeenCalled();
    expect(contentReadMock).not.toHaveBeenCalled();
    expect(contentWriteMock).not.toHaveBeenCalled();
  });

  it("restores a YouTube transcript cache inline without provider or process work", async () => {
    const serviceGet = vi.fn();
    const cacheRead = vi.fn(async (itemId: string) => transcript(itemId));
    const reader = createReader({
      youtubeTranscript: {
        service: { get: serviceGet },
        contentRepository: { read: cacheRead },
      },
    });
    const item = makeItem({
      title: "Transcript video",
      link: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      mediaType: "video",
      videoId: "dQw4w9WgXcQ",
    });
    await reader.onOpen();

    await reader.displayItem(item);

    const reading = (reader as unknown as { readingContainer: HTMLElement })
      .readingContainer;
    const panel = reading.querySelector<HTMLElement>(
      ".rss-youtube-transcript-panel",
    );
    const description = reading.querySelector<HTMLElement>(
      ".rss-video-description",
    );
    expect(cacheRead).toHaveBeenCalledTimes(1);
    expect(serviceGet).not.toHaveBeenCalled();
    expect(panel?.getAttribute("data-state")).toBe("cached");
    expect(panel?.textContent).toContain("A cached transcript restored locally.");
    expect(
      panel && description
        ? panel.compareDocumentPosition(description) & Node.DOCUMENT_POSITION_FOLLOWING
        : 0,
    ).not.toBe(0);
    expect(document.body.querySelector(".modal")).toBeNull();
  });

  it("fetches only after the inline action and updates the visible content basis", async () => {
    const pending = deferred<YouTubeTranscriptServiceResult>();
    const requests: YouTubeTranscriptRequest[] = [];
    const serviceGet = vi.fn(async (request: YouTubeTranscriptRequest) => {
      requests.push(request);
      return await pending.promise;
    });
    const reader = createReader({
      youtubeTranscript: {
        service: { get: serviceGet },
        contentRepository: { read: vi.fn(async () => null) },
      },
    });
    const item = makeItem({
      title: "Transcript video",
      link: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      mediaType: "video",
      videoId: "dQw4w9WgXcQ",
    });
    await reader.onOpen();
    await reader.displayItem(item);

    const reading = (reader as unknown as { readingContainer: HTMLElement })
      .readingContainer;
    expect(serviceGet).not.toHaveBeenCalled();
    reading
      .querySelector<HTMLButtonElement>(".rss-youtube-transcript-fetch")
      ?.click();
    expect(
      reading
        .querySelector<HTMLElement>(".rss-youtube-transcript-panel")
        ?.getAttribute("data-state"),
    ).toBe("checking");

    await vi.waitFor(() => expect(requests).toHaveLength(1));
    pending.resolve({
      status: "ready",
      source: "fresh",
      content: transcript(requests[0].itemId, { text: "Fresh transcript." }),
    });
    await vi.waitFor(() =>
      expect(reading.textContent).toContain("Fresh transcript."),
    );

    expect(requests[0]?.refresh).toBe(false);
    expect(reading.textContent).toContain("YouTube transcript");
  });

  it("uses refresh only for the explicit re-fetch action", async () => {
    const serviceGet = vi.fn(async (request: YouTubeTranscriptRequest) => ({
      status: "ready" as const,
      source: "fresh" as const,
      content: transcript(request.itemId, { text: "Refreshed transcript." }),
    }));
    const reader = createReader({
      youtubeTranscript: {
        service: { get: serviceGet },
        contentRepository: {
          read: vi.fn(async (itemId: string) => transcript(itemId)),
        },
      },
    });
    await reader.onOpen();
    await reader.displayItem(makeItem({
      link: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      mediaType: "video",
      videoId: "dQw4w9WgXcQ",
    }));

    const reading = (reader as unknown as { readingContainer: HTMLElement })
      .readingContainer;
    reading
      .querySelector<HTMLButtonElement>(".rss-youtube-transcript-refresh")
      ?.click();
    await vi.waitFor(() => expect(serviceGet).toHaveBeenCalledTimes(1));

    expect(serviceGet).toHaveBeenCalledWith(
      expect.objectContaining({ refresh: true, signal: expect.any(AbortSignal) }),
    );
  });

  it("aborts an active transcript action when switching items and ignores its late result", async () => {
    const pending = deferred<YouTubeTranscriptServiceResult>();
    let firstRequest:
      | { itemId: string; signal?: AbortSignal }
      | undefined;
    const serviceGet = vi.fn(async (request: YouTubeTranscriptRequest) => {
      firstRequest = request;
      return await pending.promise;
    });
    const reader = createReader({
      youtubeTranscript: {
        service: { get: serviceGet },
        contentRepository: { read: vi.fn(async () => null) },
      },
    });
    await reader.onOpen();
    await reader.displayItem(makeItem({
      guid: "first-video",
      link: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      mediaType: "video",
      videoId: "dQw4w9WgXcQ",
    }));
    const reading = (reader as unknown as { readingContainer: HTMLElement })
      .readingContainer;
    reading
      .querySelector<HTMLButtonElement>(".rss-youtube-transcript-fetch")
      ?.click();
    await vi.waitFor(() => expect(firstRequest).toBeDefined());

    await reader.displayItem(makeItem({
      title: "New video",
      guid: "second-video",
      link: "https://www.youtube.com/watch?v=M7lc1UVf-VE",
      mediaType: "video",
      videoId: "M7lc1UVf-VE",
    }));
    expect(firstRequest?.signal?.aborted).toBe(true);

    pending.resolve({
      status: "ready",
      source: "fresh",
      content: transcript(firstRequest!.itemId, { text: "Stale transcript." }),
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(reading.textContent).toContain("New video");
    expect(reading.textContent).not.toContain("Stale transcript.");
  });

  it("retains a durable cache when collection metadata repair fails", async () => {
    const reader = createReader();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    updateContentMetadataMock.mockRejectedValue(
      new Error("metadata unavailable"),
    );
    await reader.onOpen();

    await reader.displayItem(makeItem());

    expect(contentWriteMock).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(
      "[RSS Dashboard] Content metadata sync failed; cached content will be repaired on next access.",
    );
    warning.mockRestore();
  });
});
