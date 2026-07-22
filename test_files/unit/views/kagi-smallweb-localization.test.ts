import { beforeEach, describe, expect, it, vi } from "vitest";
import { App, WorkspaceLeaf } from "obsidian";
import { DEFAULT_SETTINGS } from "../../../src/types/types";
import { KagiSmallwebView } from "../../../src/views/kagi-smallweb-view";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";

type KagiHarness = {
  renderSmallwebLoading(container: HTMLElement): void;
  renderSmallwebError(container: HTMLElement): void;
  renderSmallwebHeader(container: HTMLElement): void;
  renderSmallwebCard(container: HTMLElement, entry: {
    postTitle: string;
    postUrl: string;
    blogName: string;
    blogUrl: string;
    updatedAt: Date;
    excerpt: string;
    domain: string;
  }): void;
};

function makeView(locale: "zh-CN" | "en") {
  const app = App.createMock();
  const leaf = new WorkspaceLeaf(app);
  const settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  settings.locale = locale;
  const plugin = {
    settings,
    activateDiscoverView: vi.fn(async () => undefined),
    addFeed: vi.fn(async () => true),
    ensureFolderExists: vi.fn(async () => undefined),
    saveSettings: vi.fn(async () => undefined),
    getActiveDashboardView: vi.fn(async () => null),
  };
  return {
    view: new KagiSmallwebView(leaf, plugin as never),
  };
}

describe("Kagi Smallweb localization", () => {
  beforeEach(() => {
    installObsidianDomPolyfills();
    document.body.empty();
  });

  it.each([
    ["zh-CN", "正在加载 Kagi Smallweb", "主题发现", "查看博客"],
    ["en", "Loading Kagi Smallweb", "Discover", "View blog"],
  ] as const)("renders %s chrome while preserving source-authored titles", (locale, loading, back, action) => {
    const { view } = makeView(locale);
    const internal = view as unknown as KagiHarness;
    const container = document.body.createDiv();

    internal.renderSmallwebLoading(container);
    expect(container.textContent).toContain(loading);
    container.empty();
    internal.renderSmallwebHeader(container);
    expect(container.querySelector(".rss-dashboard-nav-button")?.textContent).toContain(back);
    container.empty();
    internal.renderSmallwebCard(container, {
      postTitle: "External post title",
      postUrl: "https://example.com/post",
      blogName: "External blog name",
      blogUrl: "https://example.com",
      updatedAt: new Date(),
      excerpt: "External excerpt",
      domain: "example.com",
    });
    expect(container.textContent).toContain("External blog name");
    expect(container.textContent).toContain("External post title");
    expect(container.textContent).toContain(action);
  });
});
