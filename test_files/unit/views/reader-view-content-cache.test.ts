import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReaderView } from "../../../src/views/reader-view";
import {
  DEFAULT_SETTINGS,
  type FeedItem,
  type RssDashboardSettings,
} from "../../../src/types/types";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";

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

function createReader(): ReaderView {
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
    useWebViewer: false,
    corsProxyEnabled: false,
  };
  const reader = new ReaderView(
    new MockLeaf(app) as never,
    settings,
    { saveArticle: vi.fn(), checkSavedFileExists: vi.fn(() => true) } as never,
    vi.fn(),
    vi.fn(),
  );
  (reader as unknown as { contentEl: HTMLElement }).contentEl =
    document.createElement("div");
  return reader;
}

describe("ReaderView explicit full-text content cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
    contentReadMock.mockResolvedValue(null);
    contentWriteMock.mockImplementation(async (content) =>
      `.rss-dashboard-data/content/${content.itemId}.md`,
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
      expect.stringMatching(/^\.rss-dashboard-data\/content\/[a-f0-9]{64}\.md$/),
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
    contentReadMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
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
    let resolveFirst: ((value: { content: string; failureType: "none" }) => void) | undefined;
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

  it("retains a durable cache when collection metadata repair fails", async () => {
    const reader = createReader();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    updateContentMetadataMock.mockRejectedValue(new Error("metadata unavailable"));
    await reader.onOpen();

    await reader.displayItem(makeItem());

    expect(contentWriteMock).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(
      "[RSS Dashboard] Content metadata sync failed; cached content will be repaired on next access.",
    );
    warning.mockRestore();
  });
});
