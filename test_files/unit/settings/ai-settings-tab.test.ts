import { beforeEach, describe, expect, it, vi } from "vitest";
import * as obsidian from "obsidian";
import { ProviderError } from "../../../src/ai/providers/provider-error";
import { createAiConnection } from "../../../src/ai/provider-presets";
import {
  getAiConnectionMessage,
  renderAiSettingsTab,
} from "../../../src/settings/tabs/ai-settings-tab";
import { createTranslator } from "../../../src/i18n";
import { DEFAULT_SETTINGS, type RssDashboardSettings } from "../../../src/types/types";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";

const FIRST_ID = "6c9fd162-f54d-4515-9108-d9260bc984cc";
const SECOND_ID = "b2e6a5d6-f3ad-4330-8781-4c621773e77d";
const API_KEY = ["settings", "secret", "value"].join("-");

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const result = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === label,
  );
  if (!(result instanceof HTMLButtonElement)) {
    throw new Error(`Missing button: ${label}`);
  }
  return result;
}

function row(container: HTMLElement, connectionName: string): HTMLElement {
  const result = Array.from(
    container.querySelectorAll<HTMLElement>(".rss-dashboard-ai-connection"),
  ).find((candidate) => candidate.textContent?.includes(connectionName));
  if (!result) throw new Error(`Missing connection row: ${connectionName}`);
  return result;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function harness(options: {
  saveSettings?: ReturnType<typeof vi.fn>;
  confirmPaidRequest?: ReturnType<typeof vi.fn>;
  confirmDeleteKey?: ReturnType<typeof vi.fn>;
  confirmDeleteConnection?: ReturnType<typeof vi.fn>;
  providerFactory?: ReturnType<typeof vi.fn>;
  firstEnabled?: boolean;
  getStatus?: () => Promise<{ hasSecret: boolean }>;
} = {}) {
  const settings: RssDashboardSettings = structuredClone(DEFAULT_SETTINGS);
  settings.locale = "zh-CN";
  settings.ai.connections = [
    createAiConnection({
      id: FIRST_ID,
      name: "Kimi 工作",
      providerKind: "kimi",
      model: "moonshot-model",
    }),
    createAiConnection({
      id: SECOND_ID,
      name: "Claude 研究",
      providerKind: "claude",
      model: "claude-account-model",
    }),
  ];
  settings.ai.connections[0].enabled = options.firstEnabled ?? true;
  settings.ai.defaultConnectionId = FIRST_ID;
  const plugin = {
    app: obsidian.App.createMock(),
    settings,
    saveSettings: options.saveSettings ?? vi.fn(async () => {}),
  };
  const secretStore = {
    getStatus: vi.fn(options.getStatus ?? (async () => ({ hasSecret: true }))),
    get: vi.fn(async () => API_KEY),
    set: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  };
  const generate = vi.fn(async () => ({ text: "OK" }));
  const providerFactory = options.providerFactory ?? vi.fn(async () => ({ generate }));
  const confirmPaidRequest = options.confirmPaidRequest ?? vi.fn(async () => true);
  const confirmDeleteKey = options.confirmDeleteKey ?? vi.fn(async () => true);
  const confirmDeleteConnection = options.confirmDeleteConnection ?? vi.fn(async () => true);
  const openedEditors: unknown[] = [];
  const containerEl = document.body.createDiv();
  renderAiSettingsTab(containerEl, plugin, {
    secretStore,
    providerFactory,
    confirmPaidRequest,
    confirmDeleteKey,
    confirmDeleteConnection,
    createEditor: (editorOptions) => ({
      open: () => { openedEditors.push(editorOptions); },
      close: () => {},
    }),
  });
  return {
    containerEl,
    plugin,
    secretStore,
    generate,
    providerFactory,
    confirmPaidRequest,
    confirmDeleteKey,
    confirmDeleteConnection,
    openedEditors,
  };
}

beforeEach(() => {
  installObsidianDomPolyfills();
  document.body.empty();
  vi.restoreAllMocks();
});

describe("renderAiSettingsTab", () => {
  it("shows only key status and provider guidance without any secret fingerprint", async () => {
    const test = harness();
    await flushPromises();
    expect(test.containerEl.textContent).toContain("已配置密钥");
    expect(test.containerEl.textContent).not.toContain(API_KEY);
    expect(test.secretStore.get).not.toHaveBeenCalled();
    expect(test.containerEl.textContent).toContain("中转站兼容性不保证");
    expect(test.containerEl.textContent).toContain("模型 ID 必须与当前账户和区域匹配");
    expect(test.containerEl.textContent).toContain("Claude Code 登录不会自动导入");
  });

  it("persists connection order and default metadata without touching secrets", async () => {
    const test = harness();
    button(row(test.containerEl, "Claude 研究"), "上移").click();
    await flushPromises();
    expect(test.plugin.settings.ai.connections.map(({ id }) => id)).toEqual([
      SECOND_ID,
      FIRST_ID,
    ]);
    expect(test.plugin.saveSettings).toHaveBeenCalledTimes(1);

    button(row(test.containerEl, "Claude 研究"), "设为默认").click();
    await flushPromises();
    expect(test.plugin.settings.ai.defaultConnectionId).toBe(SECOND_ID);
    expect(test.plugin.saveSettings).toHaveBeenCalledTimes(2);
    expect(test.secretStore.set).not.toHaveBeenCalled();
    expect(test.secretStore.delete).not.toHaveBeenCalled();
    expect(JSON.stringify(test.plugin.settings)).not.toContain(API_KEY);
  });

  it("opens add/edit editors and commits modal metadata transactionally", async () => {
    const test = harness();
    button(test.containerEl, "添加连接").click();
    button(row(test.containerEl, "Kimi 工作"), "编辑").click();
    expect(test.openedEditors).toHaveLength(2);
    const add = test.openedEditors[0] as {
      existing?: unknown;
      onSave(connection: ReturnType<typeof createAiConnection>): Promise<void>;
    };
    const edit = test.openedEditors[1] as typeof add;
    expect(add.existing).toBeUndefined();
    expect(edit.existing).toEqual(test.plugin.settings.ai.connections[0]);

    const added = createAiConnection({
      id: "7b6fa3dc-3f23-4619-a4be-6516ad4f6150",
      name: "中转站",
      providerKind: "openai-compatible",
      baseUrl: "https://relay.example.com/v1",
      model: "relay-model",
    });
    await add.onSave(added);
    expect(test.plugin.settings.ai.connections.at(-1)).toEqual(added);
    expect(test.plugin.saveSettings).toHaveBeenCalledTimes(1);

    test.plugin.saveSettings.mockRejectedValueOnce(new Error("save failed"));
    const changed = { ...test.plugin.settings.ai.connections[0], name: "不会留下" };
    await expect(edit.onSave(changed)).rejects.toThrow();
    expect(test.plugin.settings.ai.connections[0].name).toBe("Kimi 工作");
  });

  it("rejects an add collision instead of silently overwriting an existing UUID", async () => {
    const test = harness();
    button(test.containerEl, "添加连接").click();
    const add = test.openedEditors[0] as {
      onSave(connection: ReturnType<typeof createAiConnection>): Promise<void>;
    };
    const collision = createAiConnection({
      id: FIRST_ID.toUpperCase(),
      name: "碰撞连接",
      providerKind: "openai",
      model: "account-model",
    });

    await expect(add.onSave(collision)).rejects.toThrow();
    expect(test.plugin.settings.ai.connections[0].name).toBe("Kimi 工作");
    expect(test.plugin.saveSettings).not.toHaveBeenCalled();
  });

  it("keeps delete-key and delete-connection as separate confirmed actions", async () => {
    const declined = harness({
      confirmDeleteKey: vi.fn(async () => false),
      confirmDeleteConnection: vi.fn(async () => false),
    });
    const declinedRow = row(declined.containerEl, "Kimi 工作");
    button(declinedRow, "删除密钥").click();
    button(declinedRow, "删除连接").click();
    await flushPromises();
    expect(declined.secretStore.delete).not.toHaveBeenCalled();
    expect(declined.plugin.saveSettings).not.toHaveBeenCalled();

    document.body.empty();
    const confirmed = harness();
    button(row(confirmed.containerEl, "Kimi 工作"), "删除密钥").click();
    await flushPromises();
    expect(confirmed.secretStore.delete).toHaveBeenCalledWith(FIRST_ID);
    expect(confirmed.plugin.settings.ai.connections).toHaveLength(2);
    expect(confirmed.plugin.saveSettings).not.toHaveBeenCalled();

    button(row(confirmed.containerEl, "Kimi 工作"), "删除连接").click();
    await flushPromises();
    expect(confirmed.plugin.settings.ai.connections.map(({ id }) => id))
      .not.toContain(FIRST_ID);
    expect(confirmed.plugin.saveSettings).toHaveBeenCalledTimes(1);
    expect(confirmed.secretStore.delete).toHaveBeenCalledWith(FIRST_ID);
  });

  it("rolls back metadata deletion failures and restores the connection when key deletion fails", async () => {
    const metadataFailure = harness({
      saveSettings: vi.fn(async () => { throw new Error("metadata failed"); }),
    });
    button(row(metadataFailure.containerEl, "Kimi 工作"), "删除连接").click();
    await flushPromises();
    await flushPromises();
    expect(metadataFailure.plugin.settings.ai.connections.map(({ id }) => id))
      .toContain(FIRST_ID);
    expect(metadataFailure.secretStore.get).toHaveBeenCalledWith(FIRST_ID);
    expect(metadataFailure.secretStore.delete).toHaveBeenCalledWith(FIRST_ID);
    expect(metadataFailure.secretStore.set).toHaveBeenCalledWith(FIRST_ID, API_KEY);
    expect(metadataFailure.plugin.saveSettings).toHaveBeenCalledTimes(1);

    document.body.empty();
    const keyFailure = harness();
    keyFailure.secretStore.delete.mockRejectedValueOnce(new Error("secret failed"));
    button(row(keyFailure.containerEl, "Kimi 工作"), "删除连接").click();
    await flushPromises();
    await flushPromises();
    expect(keyFailure.plugin.settings.ai.connections.map(({ id }) => id))
      .toContain(FIRST_ID);
    expect(keyFailure.plugin.settings.ai.defaultConnectionId).toBe(FIRST_ID);
    expect(keyFailure.plugin.saveSettings).not.toHaveBeenCalled();
    expect(keyFailure.containerEl.textContent).toContain("删除未完成，连接已保留");
  });

  it("retains recoverable metadata when key compensation also fails", async () => {
    const test = harness({
      saveSettings: vi.fn(async () => { throw new Error("metadata failed"); }),
    });
    test.secretStore.set.mockRejectedValueOnce(new Error(API_KEY));
    button(row(test.containerEl, "Kimi 工作"), "删除连接").click();
    await flushPromises();
    await flushPromises();

    expect(test.plugin.settings.ai.connections.map(({ id }) => id)).toContain(FIRST_ID);
    expect(test.containerEl.textContent).toContain("连接已保留，但密钥需要重新配置");
    expect(test.containerEl.textContent).not.toContain(API_KEY);
  });

  it("does not let a late key-status read overwrite a confirmed key deletion", async () => {
    const status = deferred<{ hasSecret: boolean }>();
    const test = harness({ getStatus: () => status.promise });
    button(row(test.containerEl, "Kimi 工作"), "删除密钥").click();
    await flushPromises();
    expect(row(test.containerEl, "Kimi 工作").textContent).toContain("未配置密钥");
    status.resolve({ hasSecret: true });
    await flushPromises();
    expect(row(test.containerEl, "Kimi 工作").textContent).toContain("未配置密钥");
    expect(row(test.containerEl, "Kimi 工作").textContent).not.toContain("已配置密钥");
  });

  it("makes one minimal manual test request after confirmation and blocks duplicate paid clicks", async () => {
    const confirmation = deferred<boolean>();
    const confirmPaidRequest = vi.fn(() => confirmation.promise);
    const test = harness({ confirmPaidRequest });
    const testButton = button(row(test.containerEl, "Kimi 工作"), "测试连接");
    expect(test.providerFactory).not.toHaveBeenCalled();
    testButton.click();
    testButton.click();
    expect(confirmPaidRequest).toHaveBeenCalledTimes(1);
    expect(button(row(test.containerEl, "Claude 研究"), "测试连接").disabled)
      .toBe(true);
    confirmation.resolve(true);
    await flushPromises();

    expect(test.providerFactory).toHaveBeenCalledTimes(1);
    expect(test.providerFactory).toHaveBeenCalledWith(
      expect.objectContaining({ id: FIRST_ID }),
      test.secretStore,
    );
    expect(test.generate).toHaveBeenCalledTimes(1);
    expect(test.generate).toHaveBeenCalledWith({
      system: "",
      user: "回复 OK",
      maxOutputTokens: 8,
      signal: expect.any(AbortSignal),
    });
    expect(test.containerEl.textContent).toContain("连接成功");
  });

  it("does not test disabled/invalid connections and cancels a live request explicitly", async () => {
    const disabled = harness({ firstEnabled: false });
    button(row(disabled.containerEl, "Kimi 工作"), "测试连接").click();
    await flushPromises();
    expect(disabled.providerFactory).not.toHaveBeenCalled();
    expect(disabled.containerEl.textContent).toContain("连接已停用");

    document.body.empty();
    const pending = deferred<{ text: string }>();
    const generate = vi.fn((_request: unknown) => pending.promise);
    const providerFactory = vi.fn(async () => ({ generate }));
    const test = harness({ providerFactory });
    button(row(test.containerEl, "Claude 研究"), "测试连接").click();
    await flushPromises();
    expect(generate).toHaveBeenCalledTimes(1);
    const request = generate.mock.calls[0][0] as { signal: AbortSignal };
    expect(request.signal.aborted).toBe(false);
    button(row(test.containerEl, "Claude 研究"), "取消测试").click();
    expect(request.signal.aborted).toBe(true);
    pending.resolve({ text: "late" });
    await flushPromises();
    expect(test.containerEl.textContent).toContain("测试已取消");
  });

  it("maps provider failures to distinct static localized messages", () => {
    const t = createTranslator("zh-CN");
    const cases = [
      ["missing-key", "尚未配置 API 密钥。"],
      ["invalid-key", "API 密钥无效或已过期。"],
      ["insufficient-balance", "账户余额不足。"],
      ["rate-limited", "请求频率已达上限，请稍后再试。"],
      ["timeout", "连接测试超时。"],
      ["aborted", "测试已取消。"],
      ["network-failure", "网络连接失败。"],
    ] as const;
    for (const [code, message] of cases) {
      expect(getAiConnectionMessage(new ProviderError(code, API_KEY), t))
        .toBe(message);
    }
  });
});
