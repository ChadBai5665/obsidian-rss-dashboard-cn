import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderAboutTab } from "../../../src/settings/tabs/about-settings-tab";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";

beforeEach(() => {
  installObsidianDomPolyfills();
  document.body.empty();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("renderAboutTab()", () => {
  it("renders name/version and link buttons with safe attrs", () => {
    const containerEl = document.createElement("div");
    document.body.appendChild(containerEl);
    const plugin = {
      manifest: {
        name: "RSS Dashboard",
        version: "9.9.9",
      },
    };

    renderAboutTab(containerEl, plugin as unknown as import("../../../main").default);

    expect(
      containerEl.querySelector(".rss-dashboard-about-title")?.textContent,
    ).toBe("RSS Dashboard");
    expect(
      containerEl.querySelector(".rss-dashboard-about-version")?.textContent,
    ).toBe("v9.9.9");

    const links = Array.from(
      containerEl.querySelectorAll("a.rss-dashboard-about-btn"),
    );
    expect(links.length).toBeGreaterThanOrEqual(6);

    for (const link of links) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
      expect(link.getAttribute("href")).toMatch(/^https?:\/\//);
      expect(link.textContent?.length).toBeGreaterThan(0);
    }
  });

  it("renders Chinese about copy by default and keeps English selectable", () => {
    const chineseContainer = document.createElement("div");
    renderAboutTab(
      chineseContainer,
      { manifest: { name: "RSS 信息台", version: "1.0.0" }, settings: { locale: "zh-CN" } } as unknown as import("../../../main").default,
    );
    expect(chineseContainer.textContent).toContain("免费开源的 Obsidian 社区插件");
    expect(chineseContainer.textContent).toContain("支持开发");

    const englishContainer = document.createElement("div");
    renderAboutTab(
      englishContainer,
      { manifest: { name: "RSS Dashboard", version: "1.0.0" }, settings: { locale: "en" } } as unknown as import("../../../main").default,
    );
    expect(englishContainer.textContent).toContain("free, open source community plugin");
  });
});
