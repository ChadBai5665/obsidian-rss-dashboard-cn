import { beforeEach, describe, expect, it, vi } from "vitest";
import { ArticleRenderer } from "../../../src/components/article-renderer";
import { DEFAULT_SETTINGS, type FeedItem, type RssDashboardSettings } from "../../../src/types/types";
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
  },
}));
vi.mock("../../../src/collection/collection-repository", () => ({
  CollectionRepository: class { updateContentMetadata = metadataMock; },
}));

installObsidianDomPolyfills();

function item(overrides: Partial<FeedItem> = {}): FeedItem {
  return { title: "Inline", link: "https://example.com/inline", description: "<p>fallback</p>", content: "", pubDate: "2026-07-21T00:00:00.000Z", guid: "inline", read: false, starred: false, tags: [], feedTitle: "Feed", feedUrl: "https://example.com/rss", coverImage: "", mediaType: "article", saved: false, ...overrides };
}

function renderer(): ArticleRenderer {
  return new ArticleRenderer({
    app: { workspace: { getLeavesOfType: vi.fn().mockReturnValue([]) }, vault: { adapter: {} } } as never,
    settings: { ...DEFAULT_SETTINGS, corsProxyEnabled: false } as RssDashboardSettings,
    onArticleSave: vi.fn(), onArticleUpdate: vi.fn(),
  });
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
});
