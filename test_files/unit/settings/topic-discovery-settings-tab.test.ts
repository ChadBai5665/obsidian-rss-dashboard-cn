import { beforeEach, describe, expect, it, vi } from "vitest";
import * as obsidian from "obsidian";
import { renderTopicDiscoverySettingsTab } from "../../../src/settings/tabs/topic-discovery-settings-tab";
import { DEFAULT_SETTINGS, type RssDashboardSettings } from "../../../src/types/types";
import { createXTopicSourceConfig } from "../../../src/sources/source-config";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";

beforeEach(() => {
  installObsidianDomPolyfills();
  document.body.empty();
  vi.restoreAllMocks();
});

describe("renderTopicDiscoverySettingsTab", () => {
  it("shows topic definitions, neutral categories, and request estimates", () => {
    const settings: RssDashboardSettings = structuredClone(DEFAULT_SETTINGS);
    settings.locale = "zh-CN";
    const sourceConfig = createXTopicSourceConfig({
      id: "agent-methods",
      name: "AI 方法论",
      includeKeywords: ["agent"],
      priorityAccounts: ["openai"],
    });
    settings.feeds = [{
      feedId: sourceConfig.id,
      sourceKind: "x-topic",
      sourceConfig,
      title: sourceConfig.name,
      url: "tikhub://x-topic/agent-methods",
      folder: "",
      items: [],
      lastUpdated: 0,
    }];
    const containerEl = document.body.createDiv();

    renderTopicDiscoverySettingsTab(containerEl, {
      app: obsidian.App.createMock(),
      settings,
      saveSettings: vi.fn(async () => {}),
    });

    expect(containerEl.textContent).toContain("主题发现");
    expect(containerEl.textContent).toContain("AI 方法论");
    expect(containerEl.textContent).toContain("最新、平台 Top、重点账号命中");
    expect(containerEl.textContent).toContain("预计每次刷新 3 次请求");
    expect(containerEl.textContent).toContain("单次上限 40 次；每日上限 100 次");
  });

  it("restores the exact feed graph when topic persistence fails", async () => {
    const settings: RssDashboardSettings = structuredClone(DEFAULT_SETTINGS);
    const originalReference = settings.feeds;
    const before = structuredClone(settings.feeds);
    const containerEl = document.body.createDiv();
    renderTopicDiscoverySettingsTab(containerEl, {
      app: obsidian.App.createMock(),
      settings,
      saveSettings: vi.fn(async () => { throw new Error("save failed"); }),
    });
    Array.from(containerEl.querySelectorAll("button"))
      .find((button) => button.textContent === "添加主题")!.click();
    const modal = document.body.querySelector<HTMLElement>(".modal-content")!;
    const namedInput = (label: string): HTMLInputElement => {
      const setting = Array.from(modal.querySelectorAll<HTMLElement>(".setting-item"))
        .find((element) => element.querySelector(".setting-item-name")?.textContent === label)!;
      return setting.querySelector<HTMLInputElement>("input")!;
    };
    const name = namedInput("主题名称");
    name.value = "AI 工具";
    name.dispatchEvent(new Event("input"));
    const includes = namedInput("包含关键词");
    includes.value = "agent";
    includes.dispatchEvent(new Event("input"));
    Array.from(modal.querySelectorAll("button"))
      .find((button) => button.textContent === "保存")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settings.feeds).toStrictEqual(before);
    expect(settings.feeds).toBe(originalReference);
  });
});
