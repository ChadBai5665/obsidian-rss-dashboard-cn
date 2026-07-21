/**
 * Tests for pure helper functions extracted from the General settings tab.
 *
 * Functions under test:
 *   - isPresetRefreshInterval(value) — checks if a number is a preset dropdown option
 *   - isPresetMaxItems(value)        — checks if a number is a preset dropdown option
 *   - isPresetAutoDeleteDuration(value) — checks if a number is a preset dropdown option
 *
 * These helpers power the dropdown "setValue" logic that decides whether to
 * display "Custom..." vs a named preset option.
 */
import { beforeEach, describe, it, expect, vi } from "vitest";
import * as obsidian from "obsidian";
import {
  isPresetRefreshInterval,
  isPresetMaxItems,
  isPresetAutoDeleteDuration,
  REFRESH_INTERVAL_PRESETS,
  MAX_ITEMS_PRESETS,
  AUTO_DELETE_PRESETS,
} from "../../../src/settings/tabs/general-settings-tab";
import { renderGeneralSettingsTab } from "../../../src/settings/tabs/general-settings-tab";
import { DEFAULT_SETTINGS, type RssDashboardSettings } from "../../../src/types/types";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";

function createPlugin(locale: "zh-CN" | "en") {
  return {
    app: obsidian.App.createMock(),
    settingTab: { display: vi.fn() },
    settings: {
      ...JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
      locale,
    } as RssDashboardSettings,
    saveSettings: vi.fn(async () => {}),
    getActiveDashboardView: vi.fn(async () => null),
    importPortableDataBundleFromFile: vi.fn(async () => {}),
    exportPortableDataBundle: vi.fn(async () => {}),
    applyFeedLimitsToAllFeeds: vi.fn(async () => {}),
    refreshFeeds: vi.fn(async () => {}),
  };
}

function renderGeneral(locale: "zh-CN" | "en") {
  const containerEl = document.body.createDiv();
  const plugin = createPlugin(locale);
  renderGeneralSettingsTab(containerEl, plugin);
  return { containerEl, plugin };
}

beforeEach(() => {
  installObsidianDomPolyfills();
  document.body.empty();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  const settingPrototype = obsidian.Setting.prototype as unknown as {
    addExtraButton: (callback: (button: {
      setIcon: () => { setTooltip: () => { onClick: () => unknown } };
    }) => void) => unknown;
  };
  settingPrototype.addExtraButton = function addExtraButton(callback) {
    callback({
      setIcon: () => ({
        setTooltip: () => ({
          onClick: () => undefined,
        }),
      }),
    });
    return this;
  };
});

describe("General settings localization", () => {
  it("renders core controls, language selector, and refresh collection controls in Chinese by default", () => {
    const { containerEl } = renderGeneral("zh-CN");
    expect(containerEl.textContent).toContain("视图样式");
    expect(containerEl.textContent).toContain("界面语言");
    expect(containerEl.textContent).toContain("自动刷新间隔");
    expect(containerEl.textContent).toContain("启动刷新延迟");
    expect(containerEl.textContent).toContain("每日采集");
    expect(containerEl.textContent).toContain("采集数据文件夹");

    const languageSetting = Array.from(containerEl.querySelectorAll(".setting-item")).find(
      (setting) => setting.querySelector(".setting-item-name")?.textContent === "界面语言",
    ) as HTMLElement;
    expect(languageSetting.querySelector('option[value="zh-CN"]')?.textContent).toBe("简体中文");
    expect(languageSetting.querySelector('option[value="en"]')?.textContent).toBe("English");
  });

  it("keeps English wording available when English is selected", () => {
    const { containerEl } = renderGeneral("en");
    expect(containerEl.textContent).toContain("View style");
    expect(containerEl.textContent).toContain("Language");
    expect(containerEl.textContent).toContain("Auto-refresh interval");
    expect(containerEl.textContent).toContain("Startup refresh delay");
    expect(containerEl.textContent).toContain("Daily collection");
    expect(containerEl.textContent).toContain("Collection data folder");
  });

  it("saves a language selection then immediately asks the settings tab to redraw", async () => {
    const { containerEl, plugin } = renderGeneral("zh-CN");
    const languageSetting = Array.from(containerEl.querySelectorAll(".setting-item")).find(
      (setting) => setting.querySelector(".setting-item-name")?.textContent === "界面语言",
    ) as HTMLElement;
    const select = languageSetting.querySelector("select") as HTMLSelectElement;

    select.value = "en";
    select.dispatchEvent(new Event("change"));
    await Promise.resolve();

    expect(plugin.settings.locale).toBe("en");
    expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
    expect(plugin.settingTab.display).toHaveBeenCalledTimes(1);
  });
});

// ── isPresetRefreshInterval ──────────────────────────────────────────────────

describe("isPresetRefreshInterval()", () => {
  it("returns true for every documented preset", () => {
    for (const v of REFRESH_INTERVAL_PRESETS) {
      expect(isPresetRefreshInterval(v), `${v} should be a preset`).toBe(true);
    }
  });

  it("covers the expected preset list [0,5,10,15,30,60,120,240,480,720,1440]", () => {
    const expected = [0, 5, 10, 15, 30, 60, 120, 240, 480, 720, 1440];
    expect(REFRESH_INTERVAL_PRESETS).toEqual(expected);
  });

  it("returns false for a non-preset value", () => {
    expect(isPresetRefreshInterval(45)).toBe(false);
  });

  it("returns true for 0 (Off)", () => {
    expect(isPresetRefreshInterval(0)).toBe(true);
  });

  it("returns false for a negative value", () => {
    expect(isPresetRefreshInterval(-5)).toBe(false);
  });

  it("returns false for a very large custom value", () => {
    expect(isPresetRefreshInterval(2000)).toBe(false);
  });
});

// ── isPresetMaxItems ─────────────────────────────────────────────────────────

describe("isPresetMaxItems()", () => {
  it("returns true for 0 (Unlimited)", () => {
    expect(isPresetMaxItems(0)).toBe(true);
  });

  it("returns true for every named preset", () => {
    for (const v of MAX_ITEMS_PRESETS) {
      expect(isPresetMaxItems(v), `${v} should be a preset`).toBe(true);
    }
  });

  it("covers the expected preset list [0,10,25,50,100,200,500,1000]", () => {
    expect(MAX_ITEMS_PRESETS).toEqual([0, 10, 25, 50, 100, 200, 500, 1000]);
  });

  it("returns false for a non-preset value", () => {
    expect(isPresetMaxItems(75)).toBe(false);
  });

  it("returns false for negative values", () => {
    expect(isPresetMaxItems(-1)).toBe(false);
  });

  it("returns false for a large custom value", () => {
    expect(isPresetMaxItems(9999)).toBe(false);
  });
});

// ── isPresetAutoDeleteDuration ───────────────────────────────────────────────

describe("isPresetAutoDeleteDuration()", () => {
  it("returns true for 0 (Disabled)", () => {
    expect(isPresetAutoDeleteDuration(0)).toBe(true);
  });

  it("returns true for every named preset", () => {
    for (const v of AUTO_DELETE_PRESETS) {
      expect(isPresetAutoDeleteDuration(v), `${v} should be a preset`).toBe(
        true,
      );
    }
  });

  it("covers the expected preset list [0,1,3,7,14,30,60,90,180,365]", () => {
    expect(AUTO_DELETE_PRESETS).toEqual([0, 1, 3, 7, 14, 30, 60, 90, 180, 365]);
  });

  it("returns false for 2 (between 1 and 3)", () => {
    expect(isPresetAutoDeleteDuration(2)).toBe(false);
  });

  it("returns false for a large custom number", () => {
    expect(isPresetAutoDeleteDuration(500)).toBe(false);
  });

  it("returns false for negative values", () => {
    expect(isPresetAutoDeleteDuration(-7)).toBe(false);
  });
});
