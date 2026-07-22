import { beforeEach, describe, expect, it, vi } from "vitest";
import * as obsidian from "obsidian";
import { renderSourcesSettingsTab } from "../../../src/settings/tabs/sources-settings-tab";
import { DEFAULT_SETTINGS, type RssDashboardSettings } from "../../../src/types/types";
import { createXAccountSourceConfig } from "../../../src/sources/source-config";
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

function accountInput(modal: HTMLElement): HTMLInputElement {
  const setting = Array.from(modal.querySelectorAll<HTMLElement>(".setting-item"))
    .find((element) => element.querySelector(".setting-item-name")?.textContent === "X 账号");
  const input = setting?.querySelector<HTMLInputElement>("input");
  if (!input) throw new Error("Missing account input");
  return input;
}

function fillAccountModal(modal: HTMLElement, handle: string): void {
  const input = accountInput(modal);
  input.value = handle;
  input.dispatchEvent(new Event("input"));
}

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

  it("restores the exact feed graph when account persistence fails", async () => {
    const pluginSettings = settings();
    const originalReference = pluginSettings.feeds;
    const before = structuredClone(pluginSettings.feeds);
    const containerEl = document.body.createDiv();
    renderSourcesSettingsTab(containerEl, {
      app: obsidian.App.createMock(),
      settings: pluginSettings,
      saveSettings: vi.fn(async () => { throw new Error("save failed"); }),
    });
    Array.from(containerEl.querySelectorAll("button"))
      .find((button) => button.textContent === "添加 X 账号")!.click();
    const modal = document.body.querySelector<HTMLElement>(".modal-content")!;
    const handleSetting = Array.from(modal.querySelectorAll<HTMLElement>(".setting-item"))
      .find((element) => element.querySelector(".setting-item-name")?.textContent === "X 账号")!;
    const input = handleSetting.querySelector<HTMLInputElement>("input")!;
    input.value = "AnthropicAI";
    input.dispatchEvent(new Event("input"));
    Array.from(modal.querySelectorAll("button"))
      .find((button) => button.textContent === "保存")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pluginSettings.feeds).toStrictEqual(before);
    expect(pluginSettings.feeds).toBe(originalReference);
  });

  it("opens only one account modal and releases every trigger when it closes", () => {
    const containerEl = document.body.createDiv();
    const pluginSettings = settings();
    renderSourcesSettingsTab(containerEl, {
      app: obsidian.App.createMock(),
      settings: pluginSettings,
      saveSettings: vi.fn(async () => {}),
    });
    const add = button(containerEl, "添加 X 账号");

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

  it("rechecks the current feed graph so two stale account modals commit one id", async () => {
    const pluginSettings = structuredClone(DEFAULT_SETTINGS);
    pluginSettings.feeds = [];
    const saveSettings = vi.fn(async () => {});
    const plugin = { app: obsidian.App.createMock(), settings: pluginSettings, saveSettings };
    const firstContainer = document.body.createDiv();
    const secondContainer = document.body.createDiv();
    renderSourcesSettingsTab(firstContainer, plugin);
    renderSourcesSettingsTab(secondContainer, plugin);
    button(firstContainer, "添加 X 账号").click();
    button(secondContainer, "添加 X 账号").click();
    const modals = Array.from(document.body.querySelectorAll<HTMLElement>(".modal-content"));
    fillAccountModal(modals[0], "OpenAI");
    fillAccountModal(modals[1], "@openai");

    button(modals[0], "保存").click();
    await flushPromises();
    button(modals[1], "保存").click();
    await flushPromises();

    const accounts = pluginSettings.feeds.filter((feed) => feed.sourceKind === "x-account");
    expect(accounts).toHaveLength(1);
    expect(new Set(accounts.map((feed) => feed.feedId)).size).toBe(1);
    expect(saveSettings).toHaveBeenCalledTimes(1);
  });

  it("rejects a stale account modal when a different id claimed its canonical handle", async () => {
    const pluginSettings = structuredClone(DEFAULT_SETTINGS);
    pluginSettings.feeds = [];
    const saveSettings = vi.fn(async () => {});
    const containerEl = document.body.createDiv();
    renderSourcesSettingsTab(containerEl, {
      app: obsidian.App.createMock(),
      settings: pluginSettings,
      saveSettings,
    });
    button(containerEl, "添加 X 账号").click();
    const modal = document.body.querySelector<HTMLElement>(".modal-content")!;
    fillAccountModal(modal, "OpenAI");
    const claimed = createXAccountSourceConfig({ id: "legacy-openai", handle: "openai" });
    pluginSettings.feeds.push({
      feedId: claimed.id,
      sourceKind: "x-account",
      sourceConfig: claimed,
      title: "OpenAI",
      url: "tikhub://x-account/openai",
      folder: "",
      items: [],
      lastUpdated: 0,
    });

    button(modal, "保存").click();
    await flushPromises();

    expect(pluginSettings.feeds).toHaveLength(1);
    expect(pluginSettings.feeds[0].feedId).toBe("legacy-openai");
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("finishes a late account save without refreshing or reviving a disposed tab", async () => {
    const pending = deferred<void>();
    const pluginSettings = structuredClone(DEFAULT_SETTINGS);
    pluginSettings.feeds = [];
    const containerEl = document.body.createDiv();
    const refresh = vi.fn();
    containerEl.addEventListener("rss-settings-refresh", refresh);
    renderSourcesSettingsTab(containerEl, {
      app: obsidian.App.createMock(),
      settings: pluginSettings,
      saveSettings: vi.fn(() => pending.promise),
    });
    const add = button(containerEl, "添加 X 账号");
    add.click();
    const modal = document.body.querySelector<HTMLElement>(".modal-content")!;
    fillAccountModal(modal, "OpenAI");
    button(modal, "保存").click();

    containerEl.dispatchEvent(new CustomEvent("rss-settings-dispose"));
    containerEl.remove();
    expect(document.body.querySelector(".modal-container")).toBeNull();
    add.click();
    expect(document.body.querySelector(".modal-container")).toBeNull();
    pending.resolve();
    await flushPromises();

    expect(pluginSettings.feeds.filter((feed) => feed.sourceKind === "x-account"))
      .toHaveLength(1);
    expect(refresh).not.toHaveBeenCalled();
  });
});
