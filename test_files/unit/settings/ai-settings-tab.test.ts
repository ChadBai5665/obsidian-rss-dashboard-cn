import { beforeEach, describe, expect, it, vi } from "vitest";
import * as obsidian from "obsidian";
import { ProviderError } from "../../../src/ai/providers/provider-error";
import { createTextGenerationProvider } from "../../../src/ai/providers/provider-factory";
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

function connectionNames(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      ".rss-dashboard-ai-connection .setting-item-name",
    ),
  ).map((element) => element.textContent ?? "");
}

interface CapturedEditorOptions {
  existing?: unknown;
  onSave(connection: ReturnType<typeof createAiConnection>): Promise<void>;
  testConnection?: (
    connection: ReturnType<typeof createAiConnection>,
    pendingKey: string | undefined,
    controller: AbortController,
  ) => Promise<{
    status: "success" | "cancelled" | "error";
    message?: string;
  }>;
  onPersisted?: (
    connection: ReturnType<typeof createAiConnection>,
    status: "unchanged" | "key-saved" | "key-failed",
  ) => void;
  onClose?: () => void;
  runTransaction?: <T>(operation: () => Promise<T>) => Promise<T>;
}

async function persistEditor(
  editor: CapturedEditorOptions,
  connection: ReturnType<typeof createAiConnection>,
): Promise<void> {
  if (editor.runTransaction) {
    await editor.runTransaction(() => editor.onSave(connection));
    return;
  }
  await editor.onSave(connection);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function harness(options: {
  saveSettings?: ReturnType<typeof vi.fn>;
  confirmPaidRequest?: ReturnType<typeof vi.fn>;
  confirmDeleteKey?: ReturnType<typeof vi.fn>;
  confirmDeleteConnection?: ReturnType<typeof vi.fn>;
  providerFactory?: ReturnType<typeof vi.fn>;
  firstEnabled?: boolean;
  getStatus?: () => Promise<{ hasSecret: boolean }>;
  secretGet?: ReturnType<typeof vi.fn>;
  secretSet?: ReturnType<typeof vi.fn>;
  secretDelete?: ReturnType<typeof vi.fn>;
  connectionModels?: { first?: string; second?: string };
  firstProviderKind?: "kimi" | "minimax-cn";
} = {}) {
  const settings: RssDashboardSettings = structuredClone(DEFAULT_SETTINGS);
  settings.locale = "zh-CN";
  settings.ai.connections = [
    createAiConnection({
      id: FIRST_ID,
      name: "Kimi 工作",
      providerKind: options.firstProviderKind ?? "kimi",
      model: options.connectionModels?.first ?? "moonshot-model",
    }),
    createAiConnection({
      id: SECOND_ID,
      name: "Claude 研究",
      providerKind: "claude",
      model: options.connectionModels?.second ?? "claude-account-model",
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
    get: options.secretGet ?? vi.fn(async () => API_KEY),
    set: options.secretSet ?? vi.fn(async () => {}),
    delete: options.secretDelete ?? vi.fn(async () => {}),
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
  it("shows the resolved default model for blank connections and preserves pinned labels", () => {
    const test = harness({
      firstProviderKind: "minimax-cn",
      connectionModels: { first: "" },
    });

    expect(row(test.containerEl, "Kimi 工作").textContent)
      .toContain("默认（MiniMax-M3）");
    expect(row(test.containerEl, "Claude 研究").textContent)
      .toContain("claude-account-model");
  });

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
    const add = test.openedEditors[0] as CapturedEditorOptions;
    const edit = test.openedEditors[1] as CapturedEditorOptions;
    expect(add.existing).toBeUndefined();
    expect(edit.existing).toEqual(test.plugin.settings.ai.connections[0]);

    const added = createAiConnection({
      id: "7b6fa3dc-3f23-4619-a4be-6516ad4f6150",
      name: "中转站",
      providerKind: "openai-compatible",
      baseUrl: "https://relay.example.com/v1",
      model: "relay-model",
    });
    await persistEditor(add, added);
    expect(test.plugin.settings.ai.connections.at(-1)).toEqual(added);
    expect(test.plugin.saveSettings).toHaveBeenCalledTimes(1);

    test.plugin.saveSettings.mockRejectedValueOnce(new Error("save failed"));
    const changed = { ...test.plugin.settings.ai.connections[0], name: "不会留下" };
    await expect(persistEditor(edit, changed)).rejects.toThrow();
    expect(test.plugin.settings.ai.connections[0].name).toBe("Kimi 工作");
  });

  it("rejects an add collision instead of silently overwriting an existing UUID", async () => {
    const test = harness();
    button(test.containerEl, "添加连接").click();
    const add = test.openedEditors[0] as CapturedEditorOptions;
    const collision = createAiConnection({
      id: FIRST_ID.toUpperCase(),
      name: "碰撞连接",
      providerKind: "openai",
      model: "account-model",
    });

    await expect(persistEditor(add, collision)).rejects.toThrow();
    expect(test.plugin.settings.ai.connections[0].name).toBe("Kimi 工作");
    expect(test.plugin.saveSettings).not.toHaveBeenCalled();
  });

  it("refreshes only after the modal reports the final key state", async () => {
    const test = harness();
    let refreshes = 0;
    test.containerEl.addEventListener("rss-settings-refresh", () => {
      refreshes += 1;
    });
    button(test.containerEl, "添加连接").click();
    const add = test.openedEditors[0] as CapturedEditorOptions;
    const added = createAiConnection({
      id: "84794c18-dd50-4128-8498-01ed2a508006",
      name: "延迟状态",
      providerKind: "deepseek",
      model: "account-model",
    });

    await persistEditor(add, added);
    expect(refreshes).toBe(0);
    add.onPersisted?.(added, "key-saved");
    expect(refreshes).toBe(1);
  });

  it("tests draft modal metadata with the entered key without saving it first", async () => {
    const pendingKey = ["draft", "modal", "key"].join("-");
    const generate = vi.fn(async () => ({ text: "OK" }));
    const providerFactory = vi.fn(async (
      _connection: ReturnType<typeof createAiConnection>,
      secretStore: { get(connectionId: string): Promise<string | undefined> },
    ) => {
      expect("set" in secretStore).toBe(false);
      expect("delete" in secretStore).toBe(false);
      expect(await secretStore.get("84794c18-dd50-4128-8498-01ed2a508006"))
        .toBe(pendingKey);
      return { generate };
    });
    const test = harness({ providerFactory });
    button(test.containerEl, "添加连接").click();
    const add = test.openedEditors[0] as CapturedEditorOptions;
    const draft = createAiConnection({
      id: "84794c18-dd50-4128-8498-01ed2a508006",
      name: "弹窗草稿",
      providerKind: "deepseek",
      model: "account-model",
    });

    const result = await add.testConnection?.(
      draft,
      pendingKey,
      new AbortController(),
    );

    expect(result).toEqual({ status: "success" });
    expect(test.confirmPaidRequest).toHaveBeenCalledWith(draft);
    expect(generate).toHaveBeenCalledWith({
      system: "",
      user: "回复 OK",
      maxOutputTokens: 32,
      signal: expect.any(AbortSignal),
    });
    expect(test.secretStore.set).not.toHaveBeenCalled();
    expect(test.plugin.saveSettings).not.toHaveBeenCalled();
  });

  it("tests a stored key through a runtime read-only secret wrapper", async () => {
    const generate = vi.fn(async () => ({ text: "OK" }));
    const providerFactory = vi.fn(async (
      _connection: ReturnType<typeof createAiConnection>,
      secretStore: { get(connectionId: string): Promise<string | undefined> },
    ) => {
      expect("set" in secretStore).toBe(false);
      expect("delete" in secretStore).toBe(false);
      expect(await secretStore.get(FIRST_ID)).toBe(API_KEY);
      return { generate };
    });
    const test = harness({ providerFactory });
    button(row(test.containerEl, "Kimi 工作"), "编辑").click();
    const edit = test.openedEditors[0] as CapturedEditorOptions;
    const existing = test.plugin.settings.ai.connections[0];

    const result = await edit.testConnection?.(
      existing,
      undefined,
      new AbortController(),
    );

    expect(result).toEqual({ status: "success" });
    expect(test.secretStore.set).not.toHaveBeenCalled();
    expect(test.secretStore.delete).not.toHaveBeenCalled();
  });

  it("keeps the global paid-test gate active until an aborted draft request settles", async () => {
    const underlying = deferred<{
      status: number;
      headers: Record<string, string>;
      contentType: string;
      bodyText: string;
    }>();
    const transport = vi.fn((_request, _onChunk) => underlying.promise);
    const providerFactory = vi.fn(async (
      connection: ReturnType<typeof createAiConnection>,
      secretStore: { get(connectionId: string): Promise<string | undefined> },
    ) => await createTextGenerationProvider(connection, secretStore, { transport }));
    const test = harness({ providerFactory });
    button(test.containerEl, "添加连接").click();
    const add = test.openedEditors[0] as CapturedEditorOptions;
    const draft = createAiConnection({
      id: "84794c18-dd50-4128-8498-01ed2a508006",
      name: "弹窗草稿",
      providerKind: "deepseek",
      model: "account-model",
    });
    const controller = new AbortController();

    const result = add.testConnection?.(draft, API_KEY, controller);
    await flushPromises();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(button(row(test.containerEl, "Kimi 工作"), "测试连接").disabled)
      .toBe(true);

    controller.abort();
    await flushPromises();
    expect(button(row(test.containerEl, "Kimi 工作"), "测试连接").disabled)
      .toBe(true);

    underlying.resolve({
      status: 200,
      headers: {},
      contentType: "application/json",
      bodyText: JSON.stringify({ choices: [{ message: { content: "OK" } }] }),
    });
    await result;
    await flushPromises();
    expect(button(row(test.containerEl, "Kimi 工作"), "测试连接").disabled)
      .toBe(false);
  });

  it("keeps the renderer alive after key failure so a same-modal retry can refresh to configured", async () => {
    let hasSecret = false;
    const test = harness({
      getStatus: async () => ({ hasSecret }),
    });
    let refreshes = 0;
    test.containerEl.addEventListener("rss-settings-refresh", () => {
      refreshes += 1;
      test.containerEl.dispatchEvent(new CustomEvent("rss-settings-dispose"));
      test.containerEl.empty();
      renderAiSettingsTab(test.containerEl, test.plugin, {
        secretStore: test.secretStore,
        providerFactory: test.providerFactory,
        confirmPaidRequest: test.confirmPaidRequest,
        confirmDeleteKey: test.confirmDeleteKey,
        confirmDeleteConnection: test.confirmDeleteConnection,
      });
    });
    button(test.containerEl, "添加连接").click();
    const add = test.openedEditors[0] as CapturedEditorOptions;
    const added = createAiConnection({
      id: "a4f4e412-dd79-4c17-9435-ac7e6f083758",
      name: "重试连接",
      providerKind: "kimi",
      model: "account-model",
    });

    await persistEditor(add, added);
    add.onPersisted?.(added, "key-failed");
    expect(refreshes).toBe(0);

    await persistEditor(add, added);
    hasSecret = true;
    add.onPersisted?.(added, "key-saved");
    await flushPromises();
    expect(refreshes).toBe(1);
    expect(row(test.containerEl, "重试连接").textContent).toContain("已配置密钥");
  });

  it("refreshes saved metadata when a key-failed modal is closed without retrying", async () => {
    const test = harness();
    let refreshes = 0;
    test.containerEl.addEventListener("rss-settings-refresh", () => {
      refreshes += 1;
    });
    button(test.containerEl, "添加连接").click();
    const add = test.openedEditors[0] as CapturedEditorOptions;
    const added = createAiConnection({
      id: "e3218f4a-d916-4e6c-8a5e-b51179ca6d35",
      name: "无密钥连接",
      providerKind: "deepseek",
      model: "account-model",
    });
    await persistEditor(add, added);
    add.onPersisted?.(added, "key-failed");
    expect(refreshes).toBe(0);
    add.onClose?.();
    expect(refreshes).toBe(1);
  });

  it("serializes mutations across renderer lifetimes so an old rejection cannot erase a newer save", async () => {
    const firstSave = deferred<void>();
    const persisted: RssDashboardSettings["ai"][] = [];
    const saveSettings = vi.fn()
      .mockImplementationOnce(() => firstSave.promise)
      .mockImplementationOnce(async function (this: void) {
        persisted.push(structuredClone(test.plugin.settings.ai));
      });
    const test = harness({ saveSettings });
    button(row(test.containerEl, "Claude 研究"), "上移").click();
    await flushPromises();
    expect(saveSettings).toHaveBeenCalledTimes(1);

    test.containerEl.dispatchEvent(new CustomEvent("rss-settings-dispose"));
    test.containerEl.remove();
    const openedEditors: unknown[] = [];
    const secondContainer = document.body.createDiv();
    renderAiSettingsTab(secondContainer, test.plugin, {
      secretStore: test.secretStore,
      providerFactory: test.providerFactory,
      confirmPaidRequest: test.confirmPaidRequest,
      confirmDeleteKey: test.confirmDeleteKey,
      confirmDeleteConnection: test.confirmDeleteConnection,
      createEditor: (options) => ({
        open: () => { openedEditors.push(options); },
        close: () => {},
      }),
    });
    button(secondContainer, "添加连接").click();
    const add = openedEditors[0] as CapturedEditorOptions;
    const third = createAiConnection({
      id: "9f27215d-d56b-4253-9e27-ac59bbfbb1d7",
      name: "稍后成功",
      providerKind: "glm",
      model: "account-model",
    });
    const addPromise = persistEditor(add, third);
    await flushPromises();

    firstSave.reject(new Error("old renderer save failed"));
    await flushPromises();
    await addPromise;

    expect(saveSettings).toHaveBeenCalledTimes(2);
    expect(test.plugin.settings.ai.connections.map(({ id }) => id)).toEqual([
      FIRST_ID,
      SECOND_ID,
      third.id,
    ]);
    expect(persisted.at(-1)?.connections.map(({ id }) => id)).toEqual([
      FIRST_ID,
      SECOND_ID,
      third.id,
    ]);
  });

  it("refreshes the current renderer after an old renderer rolls back", async () => {
    const firstSave = deferred<void>();
    const test = harness({ saveSettings: vi.fn(() => firstSave.promise) });
    button(row(test.containerEl, "Claude 研究"), "上移").click();
    await flushPromises();

    test.containerEl.dispatchEvent(new CustomEvent("rss-settings-dispose"));
    test.containerEl.remove();
    const currentContainer = document.body.createDiv();
    const dependencies = {
      secretStore: test.secretStore,
      providerFactory: test.providerFactory,
      confirmPaidRequest: test.confirmPaidRequest,
      confirmDeleteKey: test.confirmDeleteKey,
      confirmDeleteConnection: test.confirmDeleteConnection,
    };
    currentContainer.addEventListener("rss-settings-refresh", () => {
      currentContainer.dispatchEvent(new CustomEvent("rss-settings-dispose"));
      currentContainer.empty();
      renderAiSettingsTab(currentContainer, test.plugin, dependencies);
    });
    renderAiSettingsTab(currentContainer, test.plugin, dependencies);
    expect(connectionNames(currentContainer)).toEqual([
      "Claude 研究",
      "Kimi 工作",
    ]);

    firstSave.reject(new Error("old renderer save failed"));
    await flushPromises();
    await flushPromises();

    expect(test.plugin.settings.ai.connections.map(({ id }) => id)).toEqual([
      FIRST_ID,
      SECOND_ID,
    ]);
    expect(connectionNames(currentContainer)).toEqual([
      "Kimi 工作",
      "Claude 研究",
    ]);
  });

  it("shows a metadata rollback failure in the current lifecycle renderer", async () => {
    const test = harness({
      saveSettings: vi.fn(async () => { throw new Error("save failed"); }),
    });
    const dependencies = {
      secretStore: test.secretStore,
      providerFactory: test.providerFactory,
      confirmPaidRequest: test.confirmPaidRequest,
      confirmDeleteKey: test.confirmDeleteKey,
      confirmDeleteConnection: test.confirmDeleteConnection,
    };
    test.containerEl.addEventListener("rss-settings-refresh", () => {
      test.containerEl.dispatchEvent(new CustomEvent("rss-settings-dispose"));
      test.containerEl.empty();
      renderAiSettingsTab(test.containerEl, test.plugin, dependencies);
    });

    button(row(test.containerEl, "Claude 研究"), "上移").click();
    await flushPromises();
    await flushPromises();

    expect(test.plugin.settings.ai.connections.map(({ id }) => id)).toEqual([
      FIRST_ID,
      SECOND_ID,
    ]);
    expect(connectionNames(test.containerEl)).toEqual([
      "Kimi 工作",
      "Claude 研究",
    ]);
    expect(test.containerEl.textContent).toContain("无法保存连接设置");
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
    const metadataFailureDependencies = {
      secretStore: metadataFailure.secretStore,
      providerFactory: metadataFailure.providerFactory,
      confirmPaidRequest: metadataFailure.confirmPaidRequest,
      confirmDeleteKey: metadataFailure.confirmDeleteKey,
      confirmDeleteConnection: metadataFailure.confirmDeleteConnection,
    };
    metadataFailure.containerEl.addEventListener("rss-settings-refresh", () => {
      metadataFailure.containerEl.dispatchEvent(
        new CustomEvent("rss-settings-dispose"),
      );
      metadataFailure.containerEl.empty();
      renderAiSettingsTab(
        metadataFailure.containerEl,
        metadataFailure.plugin,
        metadataFailureDependencies,
      );
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
    expect(metadataFailure.containerEl.textContent).toContain(
      "删除未完成，连接已保留",
    );

    document.body.empty();
    let storedKey: string | undefined = API_KEY;
    const keyFailure = harness({
      secretGet: vi.fn(async () => storedKey),
      secretDelete: vi.fn(async () => {
        storedKey = undefined;
        throw new Error("delete failed after rename");
      }),
      secretSet: vi.fn(async (_id: string, key: string) => {
        storedKey = key;
      }),
    });
    button(row(keyFailure.containerEl, "Kimi 工作"), "删除连接").click();
    await flushPromises();
    await flushPromises();
    expect(keyFailure.plugin.settings.ai.connections.map(({ id }) => id))
      .toContain(FIRST_ID);
    expect(keyFailure.plugin.settings.ai.defaultConnectionId).toBe(FIRST_ID);
    expect(keyFailure.plugin.saveSettings).not.toHaveBeenCalled();
    expect(keyFailure.secretStore.set).toHaveBeenCalledWith(FIRST_ID, API_KEY);
    expect(storedKey).toBe(API_KEY);
    expect(keyFailure.containerEl.textContent).toContain("删除未完成，连接已保留");
  });

  it("reports uncertain key state when a delete clears then rejects and restoration also fails", async () => {
    let storedKey: string | undefined = API_KEY;
    const test = harness({
      secretGet: vi.fn(async () => storedKey),
      secretDelete: vi.fn(async () => {
        storedKey = undefined;
        throw new Error(API_KEY);
      }),
      secretSet: vi.fn(async () => { throw new Error(API_KEY); }),
    });
    const dependencies = {
      secretStore: test.secretStore,
      providerFactory: test.providerFactory,
      confirmPaidRequest: test.confirmPaidRequest,
      confirmDeleteKey: test.confirmDeleteKey,
      confirmDeleteConnection: test.confirmDeleteConnection,
    };
    test.containerEl.addEventListener("rss-settings-refresh", () => {
      test.containerEl.dispatchEvent(new CustomEvent("rss-settings-dispose"));
      test.containerEl.empty();
      renderAiSettingsTab(test.containerEl, test.plugin, dependencies);
    });
    button(row(test.containerEl, "Kimi 工作"), "删除连接").click();
    await flushPromises();
    await flushPromises();

    expect(test.plugin.settings.ai.connections.map(({ id }) => id)).toContain(FIRST_ID);
    expect(test.plugin.saveSettings).not.toHaveBeenCalled();
    expect(storedKey).toBeUndefined();
    expect(test.containerEl.textContent).toContain("无法确认密钥状态，请重新配置");
    expect(test.containerEl.textContent).not.toContain(API_KEY);
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
    expect(test.containerEl.textContent).toContain("无法确认密钥状态，请重新配置");
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
      maxOutputTokens: 32,
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
    const underlying = deferred<{
      status: number;
      headers: Record<string, string>;
      contentType: string;
      bodyText: string;
    }>();
    const transport = vi.fn((_request, _onChunk) => underlying.promise);
    const providerFactory = vi.fn(async (
      connection: ReturnType<typeof createAiConnection>,
      secretStore: { get(connectionId: string): Promise<string | undefined> },
    ) => await createTextGenerationProvider(connection, secretStore, { transport }));
    const test = harness({ providerFactory });
    button(row(test.containerEl, "Kimi 工作"), "测试连接").click();
    await flushPromises();
    expect(transport).toHaveBeenCalledTimes(1);
    button(row(test.containerEl, "Kimi 工作"), "取消测试").click();
    await flushPromises();
    expect(test.containerEl.textContent).toContain("停止等待，已发送请求仍可能计费");
    expect(button(row(test.containerEl, "Kimi 工作"), "测试连接").disabled)
      .toBe(true);
    expect(button(row(test.containerEl, "Claude 研究"), "测试连接").disabled)
      .toBe(true);

    test.containerEl.dispatchEvent(new CustomEvent("rss-settings-dispose"));
    test.containerEl.remove();
    const currentContainer = document.body.createDiv();
    renderAiSettingsTab(currentContainer, test.plugin, {
      secretStore: test.secretStore,
      providerFactory,
      confirmPaidRequest: test.confirmPaidRequest,
      confirmDeleteKey: test.confirmDeleteKey,
      confirmDeleteConnection: test.confirmDeleteConnection,
    });
    expect(button(row(currentContainer, "Kimi 工作"), "测试连接").disabled)
      .toBe(true);
    expect(button(row(currentContainer, "Claude 研究"), "测试连接").disabled)
      .toBe(true);

    underlying.resolve({
      status: 200,
      json: { choices: [{ message: { content: "OK" } }] },
    });
    await flushPromises();
    await flushPromises();
    expect(button(row(currentContainer, "Kimi 工作"), "测试连接").disabled)
      .toBe(false);
  });

  it("maps provider failures to distinct static localized messages", () => {
    const t = createTranslator("zh-CN");
    const cases = [
      ["missing-key", "尚未配置 API 密钥。"],
      ["invalid-key", "API 密钥无效或已过期。"],
      ["insufficient-balance", "账户余额不足。"],
      ["rate-limited", "请求频率已达上限，请稍后再试。"],
      ["timeout", "连接测试超时。"],
      ["aborted", "已停止等待，已发送请求仍可能计费；后台请求结束前不能再次测试。"],
      ["network-failure", "网络连接失败。"],
    ] as const;
    for (const [code, message] of cases) {
      expect(getAiConnectionMessage(new ProviderError(code, API_KEY), t))
        .toBe(message);
    }
  });
});
