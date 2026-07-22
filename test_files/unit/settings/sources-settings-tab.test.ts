import { beforeEach, describe, expect, it, vi } from "vitest";
import * as obsidian from "obsidian";
import { renderSourcesSettingsTab } from "../../../src/settings/tabs/sources-settings-tab";
import { DEFAULT_SETTINGS, type RssDashboardSettings } from "../../../src/types/types";
import { createXAccountSourceConfig } from "../../../src/sources/source-config";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";

function settings(): RssDashboardSettings {
  const value = structuredClone(DEFAULT_SETTINGS);
  value.locale = "zh-CN";
  const sourceConfig = createXAccountSourceConfig({
    handle: "OpenAI",
    displayName: "OpenAI",
    folder: "X",
  });
  value.feeds = [
    {
      feedId: sourceConfig.id,
      sourceKind: "x-account",
      sourceConfig,
      title: "OpenAI",
      url: "tikhub://x-account/openai",
      folder: "X",
      items: [],
      lastUpdated: 0,
    },
  ];
  return value;
}

beforeEach(() => {
  installObsidianDomPolyfills();
  document.body.empty();
  vi.restoreAllMocks();
});

describe("renderSourcesSettingsTab", () => {
  it("shows configured account definitions and their request estimate before editing", () => {
    const containerEl = document.body.createDiv();
    const plugin = {
      app: obsidian.App.createMock(),
      settings: settings(),
      saveSettings: vi.fn(async () => {}),
    };

    renderSourcesSettingsTab(containerEl, plugin);

    expect(containerEl.textContent).toContain("X 账号订阅");
    expect(containerEl.textContent).toContain("@openai");
    expect(containerEl.textContent).toContain("预计每次刷新 1 次请求");
    expect(containerEl.textContent).toContain("单次上限 40 次；每日上限 100 次");
    expect(Array.from(containerEl.querySelectorAll("button")).some(
      (button) => button.textContent === "添加 X 账号",
    )).toBe(true);
  });
});
