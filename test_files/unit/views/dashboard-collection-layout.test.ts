import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

describe("Dashboard collection layout contract", () => {
  it("bounds collection scrolling while preserving a minimum feed-reader height", () => {
    const css = readFileSync(
      resolve(process.cwd(), "src/styles/articles.css"),
      "utf8",
    );

    expect(css).toMatch(
      /\.rss-dashboard-collection-sections\s*\{[\s\S]*max-height:\s*35vh;/,
    );
    expect(css).toMatch(
      /\.rss-dashboard-collection-list\s*\{[\s\S]*overflow:\s*auto;/,
    );
    expect(css).toMatch(
      /\.rss-dashboard-articles\s*\{[\s\S]*min-height:\s*8rem;/,
    );
  });
});
