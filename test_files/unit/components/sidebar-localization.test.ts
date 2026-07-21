import { beforeEach, describe, expect, it } from "vitest";
import { Sidebar } from "../../../src/components/sidebar";
import { DEFAULT_SETTINGS } from "../../../src/types/types";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";

describe("Sidebar Chinese localization", () => {
  beforeEach(() => installObsidianDomPolyfills());

  it("shows the all-subscriptions navigation in Chinese by default and English on demand", () => {
    const app = { loadLocalStorage: () => "true", saveLocalStorage: () => {} };
    const callbacks = {
      onFolderClick() {},
      onFeedClick() {},
      onTagToggle() {},
      onClearTags() {},
      onTagFilterModeChange() {},
      onToggleTagsCollapse() {},
      onToggleFolderCollapse() {},
      onAddFolder() {},
      onAddSubfolder() {},
      onAddFeed: async () => {},
      onEditFeed() {},
      onDeleteFeed() {},
      onDeleteFolder() {},
      onRefreshFeeds: async () => {},
      onImportOpml() {},
      onExportOpml() {},
      onToggleSidebar() {},
    };
    const render = (locale: "zh-CN" | "en") => {
      const root = document.body.createDiv();
      const settings = { ...DEFAULT_SETTINGS, locale, feeds: [], folders: [] };
      new Sidebar(
        app as never,
        root,
        { settings, saveSettings: async () => {} } as never,
        settings,
        {
          currentFolder: null,
          currentFeed: null,
          selectedTags: [],
          tagsCollapsed: false,
          collapsedFolders: [],
          selectedFolders: [],
        },
        callbacks as never,
      ).render();
      return root;
    };
    expect(
      render("zh-CN").querySelector(".rss-dashboard-all-feeds-button")
        ?.textContent,
    ).toContain("我的订阅");
    document.body.empty();
    expect(
      render("en").querySelector(".rss-dashboard-all-feeds-button")
        ?.textContent,
    ).toContain("All Feeds");
  });
});
