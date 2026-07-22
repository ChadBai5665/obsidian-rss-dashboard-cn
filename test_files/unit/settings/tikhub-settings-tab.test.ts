import { beforeEach, describe, expect, it, vi } from "vitest";
import * as obsidian from "obsidian";
import { DEFAULT_SETTINGS, type RssDashboardSettings } from "../../../src/types/types";
import {
  getTikHubConnectionMessage,
  renderTikHubSettingsTab,
  runTikHubConnectionTest,
} from "../../../src/settings/tabs/tikhub-settings-tab";
import { TikHubClientError } from "../../../src/sources/tikhub/tikhub-client";
import { createTranslator } from "../../../src/i18n";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";

const CONNECTION_ID = "d4eb3f58-b672-4f73-b9f3-9cd2f0e57a8d";

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function getSetting(container: HTMLElement, name: string): HTMLElement {
  const match = Array.from(container.querySelectorAll<HTMLElement>(".setting-item"))
    .find((element) => element.querySelector(".setting-item-name")?.textContent === name);
  if (!match) throw new Error(`Missing setting: ${name}`);
  return match;
}

function getButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button"))
    .find((candidate) => candidate.textContent === label);
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing button: ${label}`);
  return button;
}

function harness(options: { confirmed?: boolean; hasSecret?: boolean } = {}) {
  const settings: RssDashboardSettings = structuredClone(DEFAULT_SETTINGS);
  settings.locale = "zh-CN";
  settings.tikhub.connectionId = CONNECTION_ID;
  settings.tikhub.enabled = true;
  settings.feeds = [{
    title: "RSS",
    url: "https://example.com/rss.xml",
    folder: "",
    items: [],
    lastUpdated: 0,
  }];
  const secretStore = {
    getStatus: vi.fn(async () => ({ hasSecret: options.hasSecret ?? false })),
    get: vi.fn(async () => "stored-secret"),
    set: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  };
  const plugin = {
    app: obsidian.App.createMock(),
    settings,
    saveSettings: vi.fn(async () => {}),
  };
  const testConnection = vi.fn(async () => {});
  const confirmPaidRequest = vi.fn(async () => options.confirmed ?? false);
  const confirmDeleteSecret = vi.fn(async () => options.confirmed ?? false);
  const containerEl = document.body.createDiv();
  renderTikHubSettingsTab(containerEl, plugin, {
    secretStore,
    testConnection,
    confirmPaidRequest,
    confirmDeleteSecret,
    createConnectionId: () => CONNECTION_ID,
  });
  return { containerEl, plugin, secretStore, testConnection, confirmPaidRequest };
}

beforeEach(() => {
  installObsidianDomPolyfills();
  document.body.empty();
  vi.restoreAllMocks();
});

describe("renderTikHubSettingsTab", () => {
  it("disables TikHub without deleting source definitions", async () => {
    const test = harness();
    const before = structuredClone(test.plugin.settings.feeds);
    const toggle = getSetting(test.containerEl, "启用 TikHub")
      .querySelector<HTMLInputElement>('input[type="checkbox"]')!;

    toggle.click();
    await flushPromises();

    expect(test.plugin.settings.tikhub.enabled).toBe(false);
    expect(test.plugin.settings.feeds).toEqual(before);
    expect(test.plugin.saveSettings).toHaveBeenCalledTimes(1);
  });

  it("offers mainland and overseas presets and saves only validated custom HTTPS origins", async () => {
    const test = harness();
    const preset = getSetting(test.containerEl, "接口地址")
      .querySelector<HTMLSelectElement>("select")!;
    expect(Array.from(preset.options).map(({ value }) => value)).toEqual([
      "https://api.tikhub.dev",
      "https://api.tikhub.io",
      "custom",
    ]);

    preset.value = "custom";
    preset.dispatchEvent(new Event("change"));
    const custom = getSetting(test.containerEl, "自定义 HTTPS 地址")
      .querySelector<HTMLInputElement>("input")!;
    custom.value = "https://gateway.example.com/path";
    custom.dispatchEvent(new Event("input"));
    getButton(test.containerEl, "应用地址").click();
    await flushPromises();
    expect(test.plugin.settings.tikhub.baseUrl).toBe("https://api.tikhub.dev");
    expect(test.containerEl.textContent).toContain("必须是仅包含域名的 HTTPS 地址");

    custom.value = "https://gateway.example.com/";
    custom.dispatchEvent(new Event("input"));
    getButton(test.containerEl, "应用地址").click();
    await flushPromises();
    expect(test.plugin.settings.tikhub.baseUrl).toBe("https://gateway.example.com");
  });

  it("stores the key outside settings, masks and clears the input, and shows status only", async () => {
    const test = harness();
    const keySetting = getSetting(test.containerEl, "API 密钥");
    const input = keySetting.querySelector<HTMLInputElement>("input")!;
    expect(input.type).toBe("password");
    expect(input.value).toBe("");
    input.value = "key-never-persisted";
    input.dispatchEvent(new Event("input"));

    getButton(keySetting, "保存密钥").click();
    await flushPromises();

    expect(test.secretStore.set).toHaveBeenCalledWith(CONNECTION_ID, "key-never-persisted");
    expect(input.value).toBe("");
    expect(JSON.stringify(test.plugin.settings)).not.toContain("key-never-persisted");
    expect(test.plugin.saveSettings).not.toHaveBeenCalled();
    expect(test.containerEl.textContent).toContain("已配置");
    expect(test.containerEl.textContent).not.toContain("key-never-persisted");
  });

  it("requires deletion confirmation, removes only the external key, and disables paid refresh", async () => {
    const declined = harness({ confirmed: false, hasSecret: true });
    const definitions = structuredClone(declined.plugin.settings.feeds);
    getButton(declined.containerEl, "删除密钥").click();
    await flushPromises();
    expect(declined.secretStore.delete).not.toHaveBeenCalled();
    expect(declined.plugin.settings.tikhub.enabled).toBe(true);

    document.body.empty();
    const confirmed = harness({ confirmed: true, hasSecret: true });
    getButton(confirmed.containerEl, "删除密钥").click();
    await flushPromises();
    expect(confirmed.secretStore.delete).toHaveBeenCalledWith(CONNECTION_ID);
    expect(confirmed.plugin.settings.tikhub.enabled).toBe(false);
    expect(confirmed.plugin.settings.feeds).toEqual(definitions);
    expect(confirmed.containerEl.textContent).toContain("状态：未配置");
  });

  it("makes exactly one test request only after an explicit click and confirmation", async () => {
    const declined = harness({ confirmed: false, hasSecret: true });
    await flushPromises();
    expect(declined.testConnection).not.toHaveBeenCalled();
    getButton(declined.containerEl, "测试连接（预计 1 次请求）").click();
    await flushPromises();
    expect(declined.confirmPaidRequest).toHaveBeenCalledTimes(1);
    expect(declined.testConnection).not.toHaveBeenCalled();

    document.body.empty();
    const confirmed = harness({ confirmed: true, hasSecret: true });
    getButton(confirmed.containerEl, "测试连接（预计 1 次请求）").click();
    await flushPromises();
    expect(confirmed.testConnection).toHaveBeenCalledTimes(1);
    expect(confirmed.testConnection).toHaveBeenCalledWith(
      "stored-secret",
      expect.objectContaining({
        maxRequestsPerRun: 40,
        maxRequestsPerDay: 100,
      }),
    );
  });

  it("shows caps before testing and distinguishes invalid keys from low balance in Chinese", () => {
    const test = harness();
    expect(test.containerEl.textContent).toContain("预计 1 次请求");
    expect(test.containerEl.textContent).toContain("单次上限 40 次；每日上限 100 次");
    const t = createTranslator("zh-CN");
    expect(getTikHubConnectionMessage(new TikHubClientError("invalid-key", "x"), t))
      .toBe("密钥无效或已过期，请重新配置。");
    expect(getTikHubConnectionMessage(new TikHubClientError("insufficient-balance", "x"), t))
      .toBe("TikHub 余额不足，请充值或降低刷新频率。");
  });
});

describe("runTikHubConnectionTest", () => {
  it("uses one read-only account request through the configured run/day budget", async () => {
    const app = obsidian.App.createMock();
    const transport = vi.fn(async () => ({
      status: 200,
      text: JSON.stringify({ code: 200, data: {} }),
    }));

    await runTikHubConnectionTest("stored-secret", {
      app,
      connectionId: CONNECTION_ID,
      baseUrl: "https://api.tikhub.dev",
      timeoutMs: 20_000,
      dataFolder: ".rss-dashboard-data",
      maxRequestsPerRun: 1,
      maxRequestsPerDay: 1,
      transport,
    });

    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledWith({
      url: "https://api.tikhub.dev/api/v1/twitter/web/fetch_user_post_tweet?screen_name=x",
      method: "GET",
      headers: { Authorization: "Bearer stored-secret" },
    });
    const ledger = JSON.parse(await app.vault.adapter.read(
      ".rss-dashboard-data/state/tikhub-requests.json",
    )) as { count: number };
    expect(ledger.count).toBe(1);
  });
});
