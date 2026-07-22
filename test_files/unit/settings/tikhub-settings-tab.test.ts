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
const syntheticCredential = (): string => ["runtime", "credential", "value"].join("-");

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

function harness(options: {
  confirmed?: boolean;
  hasSecret?: boolean;
  connectionId?: string;
  getStatus?: () => Promise<{ hasSecret: boolean }>;
  testConnection?: ReturnType<typeof vi.fn>;
  confirmPaidRequest?: ReturnType<typeof vi.fn>;
  confirmDeleteSecret?: ReturnType<typeof vi.fn>;
  saveSettings?: ReturnType<typeof vi.fn>;
  createConnectionId?: () => string;
} = {}) {
  const settings: RssDashboardSettings = structuredClone(DEFAULT_SETTINGS);
  settings.locale = "zh-CN";
  settings.tikhub.connectionId = options.connectionId ?? CONNECTION_ID;
  settings.tikhub.enabled = true;
  settings.feeds = [{
    title: "RSS",
    url: "https://example.com/rss.xml",
    folder: "",
    items: [],
    lastUpdated: 0,
  }];
  const secretStore = {
    getStatus: vi.fn(options.getStatus ?? (async () => ({ hasSecret: options.hasSecret ?? false }))),
    get: vi.fn(async () => syntheticCredential()),
    set: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  };
  const plugin = {
    app: obsidian.App.createMock(),
    settings,
    saveSettings: options.saveSettings ?? vi.fn(async () => {}),
  };
  const testConnection = options.testConnection ?? vi.fn(async () => {});
  const confirmPaidRequest = options.confirmPaidRequest ?? vi.fn(async () => options.confirmed ?? false);
  const confirmDeleteSecret = options.confirmDeleteSecret ?? vi.fn(async () => options.confirmed ?? false);
  const containerEl = document.body.createDiv();
  renderTikHubSettingsTab(containerEl, plugin, {
    secretStore,
    testConnection,
    confirmPaidRequest,
    confirmDeleteSecret,
    createConnectionId: options.createConnectionId ?? (() => CONNECTION_ID),
  });
  return {
    containerEl,
    plugin,
    secretStore,
    testConnection,
    confirmPaidRequest,
    confirmDeleteSecret,
  };
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
    const credential = syntheticCredential();
    input.value = credential;
    input.dispatchEvent(new Event("input"));

    getButton(keySetting, "保存密钥").click();
    await flushPromises();

    expect(test.secretStore.set).toHaveBeenCalledWith(CONNECTION_ID, credential);
    expect(input.value).toBe("");
    expect(JSON.stringify(test.plugin.settings)).not.toContain(credential);
    expect(test.plugin.saveSettings).not.toHaveBeenCalled();
    expect(test.containerEl.textContent).toContain("已配置");
    expect(test.containerEl.textContent).not.toContain(credential);
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
      syntheticCredential(),
      expect.objectContaining({
        maxRequestsPerRun: 40,
        maxRequestsPerDay: 100,
      }),
    );
  });

  it("clears the key synchronously and gates double clicks for save, test, and delete", async () => {
    const confirmation = deferred<boolean>();
    const confirmPaidRequest = vi.fn(() => confirmation.promise);
    const createConnectionId = vi.fn(() => CONNECTION_ID);
    const test = harness({
      connectionId: "",
      confirmPaidRequest,
      createConnectionId,
    });
    const keySetting = getSetting(test.containerEl, "API 密钥");
    const input = keySetting.querySelector<HTMLInputElement>("input")!;
    const save = getButton(keySetting, "保存密钥");
    input.value = syntheticCredential();
    save.click();
    save.click();
    expect(input.value).toBe("");
    expect(save.disabled).toBe(true);
    expect(save.getAttribute("aria-disabled")).toBe("true");
    await flushPromises();
    expect(createConnectionId).toHaveBeenCalledTimes(1);
    expect(test.plugin.saveSettings).toHaveBeenCalledTimes(1);
    expect(test.secretStore.set).toHaveBeenCalledTimes(1);

    await flushPromises();
    input.value = syntheticCredential();
    const testButton = getButton(test.containerEl, "测试连接（预计 1 次请求）");
    testButton.click();
    testButton.click();
    expect(input.value).toBe("");
    expect(confirmPaidRequest).toHaveBeenCalledTimes(1);
    expect(testButton.disabled).toBe(true);
    confirmation.resolve(false);
    await flushPromises();

    input.value = syntheticCredential();
    const deleteButton = getButton(keySetting, "删除密钥");
    deleteButton.click();
    deleteButton.click();
    expect(input.value).toBe("");
    expect(test.confirmDeleteSecret).toHaveBeenCalledTimes(1);
  });

  it("rolls back a generated connection identity and restores controls after key failures", async () => {
    const saveSettings = vi.fn(async () => { throw new Error("save failed"); });
    const test = harness({ connectionId: "", confirmed: true, saveSettings });
    const keySetting = getSetting(test.containerEl, "API 密钥");
    const input = keySetting.querySelector<HTMLInputElement>("input")!;
    const save = getButton(keySetting, "保存密钥");
    input.value = syntheticCredential();
    save.click();
    expect(input.value).toBe("");
    expect(save.disabled).toBe(true);
    await flushPromises();
    expect(test.plugin.settings.tikhub.connectionId).toBe("");
    expect(test.secretStore.set).not.toHaveBeenCalled();
    expect(save.disabled).toBe(false);
    expect(save.getAttribute("aria-disabled")).toBe("false");

    document.body.empty();
    const deletion = harness({ confirmed: true });
    deletion.secretStore.delete.mockRejectedValueOnce(new Error("delete failed"));
    const remove = getButton(deletion.containerEl, "删除密钥");
    remove.click();
    expect(remove.disabled).toBe(true);
    await flushPromises();
    expect(deletion.secretStore.delete).toHaveBeenCalledTimes(1);
    expect(remove.disabled).toBe(false);
    expect(remove.getAttribute("aria-disabled")).toBe("false");
  });

  it("updates every cap display immediately, restores the last valid value, and freezes the test snapshot", async () => {
    const confirmation = deferred<boolean>();
    const confirmPaidRequest = vi.fn(() => confirmation.promise);
    const test = harness({ confirmed: true, confirmPaidRequest });
    const runInput = getSetting(test.containerEl, "单次刷新请求上限")
      .querySelector<HTMLInputElement>("input")!;
    const dayInput = getSetting(test.containerEl, "每日请求上限")
      .querySelector<HTMLInputElement>("input")!;

    runInput.value = "7";
    runInput.dispatchEvent(new Event("change"));
    expect(test.containerEl.textContent).toContain("单次上限 7 次；每日上限 100 次");
    await flushPromises();
    dayInput.value = "11";
    dayInput.dispatchEvent(new Event("change"));
    expect(test.containerEl.textContent).toContain("单次上限 7 次；每日上限 11 次");
    await flushPromises();
    runInput.value = "0";
    runInput.dispatchEvent(new Event("change"));
    expect(runInput.value).toBe("7");

    getButton(test.containerEl, "测试连接（预计 1 次请求）").click();
    test.plugin.settings.tikhub.baseUrl = "https://changed.example.com";
    test.plugin.settings.tikhub.maxRequestsPerRun = 99;
    confirmation.resolve(true);
    await flushPromises();
    expect(test.testConnection).toHaveBeenCalledWith(
      syntheticCredential(),
      expect.objectContaining({
        baseUrl: "https://api.tikhub.dev",
        maxRequestsPerRun: 7,
        maxRequestsPerDay: 11,
      }),
    );
  });

  it("ignores a late initial secret status after a confirmed delete", async () => {
    const status = deferred<{ hasSecret: boolean }>();
    const test = harness({ confirmed: true, getStatus: () => status.promise });
    getButton(test.containerEl, "删除密钥").click();
    await flushPromises();
    expect(test.containerEl.textContent).toContain("状态：未配置");
    status.resolve({ hasSecret: true });
    await flushPromises();
    expect(test.containerEl.textContent).toContain("状态：未配置");
    expect(test.containerEl.textContent).not.toContain("状态：已配置");
  });

  it("invalidates a confirmed paid test when its rendered settings page is disposed", async () => {
    const confirmation = deferred<boolean>();
    const test = harness({
      confirmPaidRequest: vi.fn(() => confirmation.promise),
    });
    getButton(test.containerEl, "测试连接（预计 1 次请求）").click();
    test.containerEl.remove();
    confirmation.resolve(true);
    await flushPromises();
    expect(test.secretStore.get).not.toHaveBeenCalled();
    expect(test.testConnection).not.toHaveBeenCalled();
  });

  it("marks asynchronous status output as a polite live region", () => {
    const test = harness();
    for (const element of test.containerEl.querySelectorAll(
      ".rss-dashboard-secret-status, .rss-dashboard-connection-status",
    )) {
      expect(element.getAttribute("role")).toBe("status");
      expect(element.getAttribute("aria-live")).toBe("polite");
    }
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

    const credential = syntheticCredential();
    await runTikHubConnectionTest(credential, {
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
      headers: { Authorization: `Bearer ${credential}` },
    });
    const ledger = JSON.parse(await app.vault.adapter.read(
      ".rss-dashboard-data/state/tikhub-requests.json",
    )) as { count: number };
    expect(ledger.count).toBe(1);
  });
});
