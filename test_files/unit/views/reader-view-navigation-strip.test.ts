import { describe, it, expect, beforeEach, vi } from "vitest";
import { ReaderView } from "../../../src/views/reader-view";
import {
  FeedItem,
  RssDashboardSettings,
  DEFAULT_SETTINGS,
} from "../../../src/types/types";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";

installObsidianDomPolyfills();

class MockLeaf {
  app: unknown;
  view: unknown;
  constructor(app: unknown) {
    this.app = app;
  }
  detach = vi.fn();
}

type ReaderViewInternals = {
  contentEl: HTMLElement;
  readingContainer: HTMLElement;
  fetchFullArticleContent: ReturnType<typeof vi.fn>;
  stripNavigationChromeFromHtml: (html: string) => string;
};

function getInternals(view: ReaderView): ReaderViewInternals {
  return view as unknown as ReaderViewInternals;
}

function makeItem(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    title: "Feed Title",
    link: "https://example.com/article",
    description: "",
    content: "",
    pubDate: new Date().toISOString(),
    guid: "guid-1",
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

describe("ReaderView full-article nav/breadcrumb stripping", () => {
  let readerView: ReaderView;
  let mockSettings: RssDashboardSettings;

  beforeEach(async () => {
    const mockApp = {
      workspace: {
        getLeavesOfType: vi.fn().mockReturnValue([]),
        setActiveLeaf: vi.fn(),
        revealLeaf: vi.fn(),
      },
      vault: {
        getAbstractFileByPath: vi.fn(),
      },
    };

    mockSettings = { ...DEFAULT_SETTINGS, useWebViewer: false };

    const mockLeaf = new MockLeaf(mockApp);
    readerView = new ReaderView(
      mockLeaf as never,
      mockSettings,
      { saveArticle: vi.fn() } as never,
      vi.fn(),
      vi.fn(),
    );

    getInternals(readerView).contentEl = document.createElement("div");
    await readerView.onOpen();
  });

  it("awaits durable read status before refreshing reader controls", async () => {
    let resolveUpdate!: (value: boolean) => void;
    const durableUpdate = new Promise<boolean>((resolve) => {
      resolveUpdate = resolve;
    });
    const update = vi.fn(() => durableUpdate);
    const mockApp = {
      workspace: { getLeavesOfType: vi.fn().mockReturnValue([]) },
      vault: { getAbstractFileByPath: vi.fn() },
    };
    const view = new ReaderView(
      new MockLeaf(mockApp) as never,
      { ...DEFAULT_SETTINGS, useWebViewer: false },
      { saveArticle: vi.fn() } as never,
      vi.fn(),
      update,
    );
    const controls = vi.fn();
    const internals = view as unknown as {
      currentItem: FeedItem | null;
      readToggleButton: HTMLElement | null;
      toggleReadStatus: () => Promise<void>;
      updateToggleButtons: () => void;
    };
    internals.currentItem = makeItem({ read: false });
    internals.readToggleButton = document.createElement("button");
    internals.updateToggleButtons = controls;

    const pending = internals.toggleReadStatus();
    const duplicate = internals.toggleReadStatus();
    expect(pending).toBeInstanceOf(Promise);
    expect(update).toHaveBeenCalledTimes(1);
    expect(internals.readToggleButton.classList.contains("pending")).toBe(true);
    expect(internals.readToggleButton.getAttribute("aria-disabled")).toBe("true");
    expect(controls).not.toHaveBeenCalled();
    resolveUpdate(false);
    await Promise.all([pending, duplicate]);

    expect(update).toHaveBeenCalledWith(
      internals.currentItem,
      { read: true },
      false,
    );
    expect(controls).not.toHaveBeenCalled();
    expect(internals.readToggleButton.classList.contains("pending")).toBe(false);
    expect(internals.readToggleButton.getAttribute("aria-disabled")).toBe("false");
  });

  it("removes breadcrumb nav near the top but preserves article text", async () => {
    const html = `
      <nav data-testid="breadcrumb-container">
        <ol>
          <li><a href="https://example.com/">Home</a></li>
          <li><a href="https://example.com/section">Section</a></li>
        </ol>
      </nav>
      <h1>Headline Here</h1>
      <p>${"x".repeat(260)}</p>
    `;

    getInternals(readerView).fetchFullArticleContent = vi
      .fn()
      .mockResolvedValue(html);

    await readerView.displayItem(makeItem());

    const container = getInternals(readerView).readingContainer;
    const content = container.querySelector<HTMLElement>(
      ".rss-reader-article-content",
    );
    expect(content).toBeTruthy();
    expect(content?.querySelector("nav")).toBeNull();
    expect((content?.textContent || "").includes("x".repeat(40))).toBe(true);
  });

  it("does not remove deep nav beyond the conservative cutoff", async () => {
    const spacer = Array.from({ length: 40 }, () => "<span>t</span>").join("");
    const html = `
      <p>${"x".repeat(260)}</p>
      ${spacer}
      <nav data-testid="breadcrumb-container">
        <ol>
          <li><a href="https://example.com/">Home</a></li>
          <li><a href="https://example.com/section">Section</a></li>
        </ol>
      </nav>
      <p>tail</p>
    `;

    getInternals(readerView).fetchFullArticleContent = vi
      .fn()
      .mockResolvedValue(html);

    await readerView.displayItem(makeItem());

    const container = getInternals(readerView).readingContainer;
    const content = container.querySelector<HTMLElement>(
      ".rss-reader-article-content",
    );
    expect(content).toBeTruthy();
    expect(content?.querySelector("nav")).toBeTruthy();
  });

  it("stripNavigationChromeFromHtml removes breadcrumb nav", () => {
    const html = `
      <nav data-testid="breadcrumb-container"><ol><li><a href="/">Home</a></li></ol></nav>
      <p>Keep me</p>
    `;

    const cleaned =
      getInternals(readerView).stripNavigationChromeFromHtml(html);
    const doc = new DOMParser().parseFromString(cleaned, "text/html");
    expect(doc.body.querySelector("nav")).toBeNull();
    expect(doc.body.textContent || "").toContain("Keep me");
  });
});
