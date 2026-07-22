import { beforeEach, describe, expect, it, vi } from "vitest";
import * as obsidian from "obsidian";
import { renderTopicDiscoverySettingsTab } from "../../../src/settings/tabs/topic-discovery-settings-tab";
import { DEFAULT_SETTINGS, type RssDashboardSettings } from "../../../src/types/types";
import { createXTopicSourceConfig } from "../../../src/sources/source-config";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const result = Array.from(container.querySelectorAll("button"))
    .find((candidate) => candidate.textContent === label);
  if (!(result instanceof HTMLButtonElement)) throw new Error(`Missing button ${label}`);
  return result;
}

function topicInput(modal: HTMLElement, label: string): HTMLInputElement {
  const setting = Array.from(modal.querySelectorAll<HTMLElement>(".setting-item"))
    .find((element) => element.querySelector(".setting-item-name")?.textContent === label);
  const input = setting?.querySelector<HTMLInputElement>("input");
  if (!input) throw new Error(`Missing topic input ${label}`);
  return input;
}

function fillTopicModal(modal: HTMLElement, name: string): void {
  const nameInput = topicInput(modal, "主题名称");
  nameInput.value = name;
  nameInput.dispatchEvent(new Event("input"));
  const includes = topicInput(modal, "包含关键词");
  includes.value = "agent";
  includes.dispatchEvent(new Event("input"));
}

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

  it("opens only one topic modal and releases every trigger when it closes", () => {
    const pluginSettings = structuredClone(DEFAULT_SETTINGS);
    const sourceConfig = createXTopicSourceConfig({
      id: "existing-topic",
      name: "现有主题",
      includeKeywords: ["existing"],
    });
    pluginSettings.feeds = [{
      feedId: sourceConfig.id,
      sourceKind: "x-topic",
      sourceConfig,
      title: sourceConfig.name,
      url: "tikhub://x-topic/existing-topic",
      folder: "",
      items: [],
      lastUpdated: 0,
    }];
    const containerEl = document.body.createDiv();
    renderTopicDiscoverySettingsTab(containerEl, {
      app: obsidian.App.createMock(),
      settings: pluginSettings,
      saveSettings: vi.fn(async () => {}),
    });
    const add = button(containerEl, "添加主题");

    add.click();
    add.click();

    expect(document.body.querySelectorAll(".modal-container")).toHaveLength(1);
    for (const trigger of containerEl.querySelectorAll("button")) {
      expect(trigger.disabled).toBe(true);
      expect(trigger.getAttribute("aria-disabled")).toBe("true");
    }
    button(document.body, "取消").click();
    for (const trigger of containerEl.querySelectorAll("button")) {
      expect(trigger.disabled).toBe(false);
      expect(trigger.getAttribute("aria-disabled")).toBe("false");
    }
  });

  it("rechecks the current feed graph so two stale topic modals commit one id", async () => {
    const pluginSettings = structuredClone(DEFAULT_SETTINGS);
    pluginSettings.feeds = [];
    const saveSettings = vi.fn(async () => {});
    const plugin = { app: obsidian.App.createMock(), settings: pluginSettings, saveSettings };
    const firstContainer = document.body.createDiv();
    const secondContainer = document.body.createDiv();
    renderTopicDiscoverySettingsTab(firstContainer, plugin);
    renderTopicDiscoverySettingsTab(secondContainer, plugin);
    button(firstContainer, "添加主题").click();
    button(secondContainer, "添加主题").click();
    const modals = Array.from(document.body.querySelectorAll<HTMLElement>(".modal-content"));
    fillTopicModal(modals[0], "AI 方法论");
    fillTopicModal(modals[1], "  ai 方法论  ");

    button(modals[0], "保存").click();
    await flushPromises();
    button(modals[1], "保存").click();
    await flushPromises();

    const topics = pluginSettings.feeds.filter((feed) => feed.sourceKind === "x-topic");
    expect(topics).toHaveLength(1);
    expect(new Set(topics.map((feed) => feed.feedId)).size).toBe(1);
    expect(saveSettings).toHaveBeenCalledTimes(1);
  });

  it("finishes a late topic save without refreshing or reviving a disposed tab", async () => {
    const pending = deferred<void>();
    const pluginSettings = structuredClone(DEFAULT_SETTINGS);
    pluginSettings.feeds = [];
    const containerEl = document.body.createDiv();
    const refresh = vi.fn();
    containerEl.addEventListener("rss-settings-refresh", refresh);
    renderTopicDiscoverySettingsTab(containerEl, {
      app: obsidian.App.createMock(),
      settings: pluginSettings,
      saveSettings: vi.fn(() => pending.promise),
    });
    const add = button(containerEl, "添加主题");
    add.click();
    const modal = document.body.querySelector<HTMLElement>(".modal-content")!;
    fillTopicModal(modal, "AI 方法论");
    button(modal, "保存").click();

    containerEl.dispatchEvent(new CustomEvent("rss-settings-dispose"));
    containerEl.remove();
    expect(document.body.querySelector(".modal-container")).toBeNull();
    add.click();
    expect(document.body.querySelector(".modal-container")).toBeNull();
    pending.resolve();
    await flushPromises();

    expect(pluginSettings.feeds.filter((feed) => feed.sourceKind === "x-topic"))
      .toHaveLength(1);
    expect(refresh).not.toHaveBeenCalled();
  });
});
