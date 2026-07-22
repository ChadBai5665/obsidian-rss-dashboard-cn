import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const files = [
  "src/views/reader-view.ts",
  "src/views/discover-view.ts",
  "src/views/kagi-smallweb-view.ts",
  "src/views/podcast-player.ts",
  "src/views/video-player.ts",
  "src/settings/tabs/highlights-settings-tab.ts",
  "src/settings/tabs/import-export-settings-tab.ts",
  "src/settings/tabs/tags-settings-tab.ts",
];

describe("Task 5 visible-string audit", () => {
  it("keeps known plugin-owned English literals out of application surfaces", () => {
    const source = files.map((file) => readFileSync(file, "utf8")).join("\n");
    const forbidden = [
      "No feeds match your filters",
      "Loading Kagi Smallweb feed...",
      "Could not load Kagi Smallweb feed.",
      "← Discover",
      "No posts found",
      " View Blog",
      " Following",
      " Unfollow",
      " Add to...",
      'setButtonText("Case")',
      'name: "Default Twitter tag"',
      'text: "Feed description"',
      'text: "No feed description available."',
      'text: "Open video at source"',
      'text: "No related videos found"',
      'text: "Episode details"',
      'text: "Show notes"',
    ];

    expect(forbidden.filter((literal) => source.includes(literal))).toEqual([]);
  });

  it("keeps removed Discover renderers out of the live view", () => {
    const source = readFileSync("src/views/discover-view.ts", "utf8");
    const removedMethods = [
      "renderSidebarHeader(",
      "renderNavTabs(",
      "renderSearch(",
      "renderTypeFilter(",
      "renderCategoryTree(",
      "renderCategoryNode(",
    ];

    expect(removedMethods.filter((method) => source.includes(method))).toEqual([]);
  });

  it("does not trust DOM localization attributes as Reader or Podcast ownership", () => {
    const source = ["src/views/reader-view.ts", "src/views/podcast-player.ts"]
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");

    expect(source).not.toContain("data-rss-reader-i18n-key");
    expect(source).not.toContain("rssReaderI18nKey");
    expect(source).not.toContain("data-podcast-i18n-key");
    expect(source).not.toContain("podcastI18nKey");
  });
});
