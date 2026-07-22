import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const files = [
  "src/views/discover-view.ts",
  "src/views/kagi-smallweb-view.ts",
  "src/views/podcast-player.ts",
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
    ];

    expect(forbidden.filter((literal) => source.includes(literal))).toEqual([]);
  });
});
