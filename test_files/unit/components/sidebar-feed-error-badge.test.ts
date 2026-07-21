import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  Sidebar,
  SidebarOptions,
  SidebarCallbacks,
} from "../../../src/components/sidebar";
import * as ObsidianStubs from "../../stubs/obsidian";
import type { App } from "../../stubs/obsidian";
import {
  RssDashboardSettings,
  Feed,
} from "../../../src/types/types";
import type RssDashboardPlugin from "../../../main";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";
import { parseFetchErrorMessage } from "../../../src/services/feed-parser/feed-errors";

installObsidianDomPolyfills();

describe("Feed Error Badge Rendering", () => {
  let app: App;
  let container: HTMLElement;
  interface MockPlugin {
    settings: RssDashboardSettings;
    saveSettings: ReturnType<typeof vi.fn>;
  }
  let plugin: MockPlugin;
  let settings: RssDashboardSettings;
  let options: SidebarOptions;
  let callbacks: SidebarCallbacks;

  beforeEach(() => {
    app = ObsidianStubs.App.createMock();
    container = document.createElement("div");
    document.body.appendChild(container);

    settings = {
      feeds: [],
      folders: [],
      display: {
        showFeedUnreadBadges: true,
      },
    } as unknown as RssDashboardSettings;

    options = {
      currentFolder: null,
      currentFeed: null,
      selectedTags: [],
      tagsCollapsed: false,
      collapsedFolders: [],
    };

    callbacks = {} as unknown as SidebarCallbacks;

    plugin = {
      settings,
      saveSettings: vi.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(() => {
    container.remove();
  });

  it("should not render error badge when lastFetchError is absent", () => {
    settings.feeds = [
      {
        title: "Normal Feed",
        url: "url1",
        folder: "Folder 1",
        items: [{ read: false }], // 1 unread
      } as unknown as Feed,
    ];

    const sidebar = new Sidebar(
      app as unknown as import("obsidian").App,
      container,
      plugin as unknown as RssDashboardPlugin,
      settings,
      options,
      callbacks,
    );
    sidebar.render();

    const feedNameContainer = container.querySelector(
      '[data-feed-url="url1"] .rss-dashboard-feed-name-container'
    );
    expect(feedNameContainer).not.toBeNull();

    // Has unread count
    expect(feedNameContainer?.querySelector(".rss-dashboard-feed-unread-count")).not.toBeNull();
    // Does NOT have error badge
    expect(feedNameContainer?.querySelector(".rss-dashboard-feed-error-badge")).toBeNull();
  });

  it("should render error badge with correct attributes when lastFetchError is present", () => {
    settings.feeds = [
      {
        title: "Failed Feed",
        url: "url-fail",
        folder: "Folder 1",
        items: [],
        lastFetchError: "Request failed, status 429",
      } as unknown as Feed,
    ];

    const sidebar = new Sidebar(
      app as unknown as import("obsidian").App,
      container,
      plugin as unknown as RssDashboardPlugin,
      settings,
      options,
      callbacks,
    );
    sidebar.render();

    const errorBadge = container.querySelector(
      '[data-feed-url="url-fail"] .rss-dashboard-feed-error-badge'
    ) as HTMLElement;
    
    expect(errorBadge).not.toBeNull();
    expect(errorBadge.getAttribute("title")).toBe("Request failed, status 429");
    expect(errorBadge.getAttribute("aria-label")).toContain("Request failed, status 429");
    
    // Check it rendered the icon
    expect(errorBadge.dataset.icon).toBe("alert-circle");
  });

  it("should render both unread count and error badge when both exist", () => {
    settings.feeds = [
      {
        title: "Stale Feed",
        url: "url-stale",
        folder: "Folder 1",
        items: [{ read: false }, { read: false }], // 2 unread
        lastFetchError: "Not a valid RSS/Atom feed",
      } as unknown as Feed,
    ];

    const sidebar = new Sidebar(
      app as unknown as import("obsidian").App,
      container,
      plugin as unknown as RssDashboardPlugin,
      settings,
      options,
      callbacks,
    );
    sidebar.render();

    const feedNameContainer = container.querySelector(
      '[data-feed-url="url-stale"] .rss-dashboard-feed-name-container'
    );

    // Should have both
    const unreadCount = feedNameContainer?.querySelector(".rss-dashboard-feed-unread-count");
    const errorBadge = feedNameContainer?.querySelector(".rss-dashboard-feed-error-badge");
    
    expect(unreadCount).not.toBeNull();
    expect(unreadCount?.textContent).toBe("2");
    expect(errorBadge).not.toBeNull();
  });

  it("should not render error badge when feed fetch error badges are hidden", () => {
    settings.display.hideFeedFetchErrorBadges = true;
    settings.feeds = [
      {
        title: "Failed Feed",
        url: "url-hidden-error",
        folder: "Folder 1",
        items: [],
        lastFetchError: "Request failed, status 500",
      } as unknown as Feed,
    ];

    const sidebar = new Sidebar(
      app as unknown as import("obsidian").App,
      container,
      plugin as unknown as RssDashboardPlugin,
      settings,
      options,
      callbacks,
    );
    sidebar.render();

    const feedNameContainer = container.querySelector(
      '[data-feed-url="url-hidden-error"] .rss-dashboard-feed-name-container'
    );

    expect(feedNameContainer?.querySelector(".rss-dashboard-feed-error-badge")).toBeNull();
  });
});

describe("parseFetchErrorMessage", () => {
  it("returns a fixed safe message instead of raw parser details", () => {
    expect(parseFetchErrorMessage("Error: Not a valid RSS/Atom feed"))
      .toBe("Source refresh failed.");
      
    expect(parseFetchErrorMessage("Error: Request failed, status 429"))
      .toBe("Source refresh failed.");
  });

  it("should handle Error objects", () => {
    const err = new Error("Timed out");
    expect(parseFetchErrorMessage(err)).toBe("Source refresh timed out.");
    
    const errWithPrefix = new Error("Error: Some internal issue");
    expect(parseFetchErrorMessage(errWithPrefix)).toBe("Source refresh failed.");
  });

  it("should return Unknown error for non-strings", () => {
    expect(parseFetchErrorMessage(null)).toBe("Source refresh failed.");
  });

  it("does not expose URL queries, headers, API keys, or body fragments", () => {
    const parsed = parseFetchErrorMessage(
      "https://example.com/feed?token=query Authorization: Bearer auth x-api-key=header body-fragment",
    );
    expect(parsed).toBe("Source refresh failed.");
    expect(parsed).not.toContain("query");
    expect(parsed).not.toContain("auth");
    expect(parsed).not.toContain("header");
    expect(parsed).not.toContain("body-fragment");
  });
});
