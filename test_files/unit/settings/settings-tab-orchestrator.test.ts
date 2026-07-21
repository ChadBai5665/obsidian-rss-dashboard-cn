import { beforeEach, describe, expect, it, vi } from "vitest";
import * as obsidian from "obsidian";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";
import type RssDashboardPlugin from "../../../main";

vi.mock("../../../src/settings/tabs/general-settings-tab", () => ({
  renderGeneralSettingsTab: vi.fn(),
}));
vi.mock("../../../src/settings/tabs/storage-settings-tab", () => ({
  renderStorageSettingsTab: vi.fn(),
}));
vi.mock("../../../src/settings/tabs/display-settings-tab", () => ({
  renderDisplaySettingsTab: vi.fn(),
}));
vi.mock("../../../src/settings/tabs/media-settings-tab", () => ({
  renderMediaSettingsTab: vi.fn(),
}));
vi.mock("../../../src/settings/tabs/article-saving-settings-tab", () => ({
  renderArticleSavingSettingsTab: vi.fn(),
}));
vi.mock("../../../src/settings/tabs/rules-settings-tab", () => ({
  renderRulesSettingsTab: vi.fn(),
}));
vi.mock("../../../src/settings/tabs/highlights-settings-tab", () => ({
  renderHighlightsSettingsTab: vi.fn(),
}));
vi.mock("../../../src/settings/tabs/import-export-settings-tab", () => ({
  renderImportExportSettingsTab: vi.fn(),
}));
vi.mock("../../../src/settings/tabs/tags-settings-tab", () => ({
  renderTagsSettingsTab: vi.fn(),
}));
vi.mock("../../../src/settings/tabs/sidebar-settings-tab", () => ({
  renderSidebarSettingsTab: vi.fn(),
}));
vi.mock("../../../src/settings/tabs/about-settings-tab", () => ({
  renderAboutTab: vi.fn(),
}));

beforeEach(() => {
  installObsidianDomPolyfills();
  document.body.empty();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("RssDashboardSettingTab (orchestrator)", () => {
  it("renders tab bar + default General tab renderer", async () => {
    const { RssDashboardSettingTab } = await import(
      "../../../src/settings/settings-tab"
    );
    const general = await import("../../../src/settings/tabs/general-settings-tab");

    const app = obsidian.App.createMock();
    const plugin = {
      app,
      settings: { locale: "zh-CN" },
    } as unknown as RssDashboardPlugin;
    const tab = new RssDashboardSettingTab(app, plugin);

    tab.containerEl = document.body.appendChild(document.createElement("div"));
    tab.display();

    const tabButtons = Array.from(
      tab.containerEl.querySelectorAll(".rss-dashboard-settings-tab-btn"),
    );
    expect(tabButtons).toHaveLength(11);
    expect(tabButtons[0].textContent).toBe("常规");

    expect(vi.mocked(general.renderGeneralSettingsTab)).toHaveBeenCalledTimes(1);
  });

  it("switches tabs on button click and via activateTab()", async () => {
    const { RssDashboardSettingTab } = await import(
      "../../../src/settings/settings-tab"
    );
    const rules = await import("../../../src/settings/tabs/rules-settings-tab");
    const about = await import("../../../src/settings/tabs/about-settings-tab");

    const app = obsidian.App.createMock();
    const plugin = {
      app,
      settings: { locale: "zh-CN" },
    } as unknown as RssDashboardPlugin;
    const tab = new RssDashboardSettingTab(app, plugin);
    tab.containerEl = document.body.appendChild(document.createElement("div"));

    tab.display();

    const aboutBtn = Array.from(
      tab.containerEl.querySelectorAll("button"),
    ).find((b) => b.textContent === "关于") as HTMLButtonElement;
    aboutBtn.click();
    expect(vi.mocked(about.renderAboutTab)).toHaveBeenCalledTimes(1);

    tab.activateTab("rules");
    expect(vi.mocked(rules.renderRulesSettingsTab)).toHaveBeenCalledTimes(1);

    const display = await import("../../../src/settings/tabs/display-settings-tab");
    tab.activateTab("display", "Reader");
    expect(vi.mocked(display.renderDisplaySettingsTab)).toHaveBeenLastCalledWith(
      expect.any(HTMLDivElement),
      plugin,
      expect.any(Function),
      "Reader",
    );

    // Invalid tab name is ignored
    vi.mocked(rules.renderRulesSettingsTab).mockClear();
    tab.activateTab("Nope");
    expect(vi.mocked(rules.renderRulesSettingsTab)).toHaveBeenCalledTimes(0);
  });

  it.each([
    ["Display", "display"],
    ["Rules", "rules"],
    ["Highlights", "highlights"],
  ])("accepts legacy %s navigation and renders its stable %s tab", async (legacyName, stableId) => {
    const { RssDashboardSettingTab } = await import("../../../src/settings/settings-tab");
    const app = obsidian.App.createMock();
    const plugin = { app, settings: { locale: "zh-CN" } } as unknown as RssDashboardPlugin;
    const tab = new RssDashboardSettingTab(app, plugin);
    tab.containerEl = document.body.appendChild(document.createElement("div"));

    tab.activateTab(legacyName);

    expect(tab.containerEl.querySelector(".rss-dashboard-settings-tab-btn.active")?.textContent).toBe(
      stableId === "display" ? "显示" : stableId === "rules" ? "规则" : "高亮",
    );
  });

  it("responds to 'rss-settings-refresh' event by re-rendering", async () => {
    const { RssDashboardSettingTab } = await import(
      "../../../src/settings/settings-tab"
    );
    const general = await import("../../../src/settings/tabs/general-settings-tab");

    const app = obsidian.App.createMock();
    const plugin = {
      app,
      settings: { locale: "zh-CN" },
    } as unknown as RssDashboardPlugin;
    const tab = new RssDashboardSettingTab(app, plugin);
    tab.containerEl = document.body.appendChild(document.createElement("div"));

    tab.display();
    expect(vi.mocked(general.renderGeneralSettingsTab)).toHaveBeenCalledTimes(1);

    const contentEl = tab.containerEl.querySelector(
      ".rss-dashboard-settings-tab-content",
    ) as HTMLDivElement;
    expect(contentEl).toBeTruthy();

    contentEl.dispatchEvent(new CustomEvent("rss-settings-refresh"));
    expect(vi.mocked(general.renderGeneralSettingsTab)).toHaveBeenCalledTimes(2);
  });

  it("keeps the stable active tab when the locale is changed and re-rendered", async () => {
    const { RssDashboardSettingTab } = await import(
      "../../../src/settings/settings-tab"
    );
    const display = await import("../../../src/settings/tabs/display-settings-tab");

    const app = obsidian.App.createMock();
    const plugin = {
      app,
      settings: { locale: "zh-CN" },
    } as unknown as RssDashboardPlugin;
    const tab = new RssDashboardSettingTab(app, plugin);
    tab.containerEl = document.body.appendChild(document.createElement("div"));

    tab.activateTab("display");
    plugin.settings.locale = "en";
    tab.display();

    expect(tab.containerEl.querySelector("button")?.textContent).toBe("General");
    expect(vi.mocked(display.renderDisplaySettingsTab)).toHaveBeenLastCalledWith(
      expect.any(HTMLDivElement),
      plugin,
      expect.any(Function),
      undefined,
    );
  });
});
