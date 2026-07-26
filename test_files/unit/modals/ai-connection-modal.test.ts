import { beforeEach, describe, expect, it, vi } from "vitest";
import * as obsidian from "obsidian";
import { AiConnectionModal } from "../../../src/modals/ai-connection-modal";
import { createAiConnection } from "../../../src/ai/provider-presets";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";

const CONNECTION_ID = "9a76f539-c9ec-4c45-a8e5-156cc6740a8d";
const API_KEY = ["modal", "secret", "value"].join("-");

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
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

function setting(modal: AiConnectionModal, name: string): HTMLElement {
  const result = Array.from(
    modal.contentEl.querySelectorAll<HTMLElement>(".setting-item"),
  ).find((element) =>
    element.querySelector(".setting-item-name")?.textContent === name,
  );
  if (!result) throw new Error(`Missing setting: ${name}`);
  return result;
}

function button(modal: AiConnectionModal, label: string): HTMLButtonElement {
  const result = Array.from(modal.contentEl.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === label,
  );
  if (!(result instanceof HTMLButtonElement)) {
    throw new Error(`Missing button: ${label}`);
  }
  return result;
}

function setInput(modal: AiConnectionModal, name: string, value: string): void {
  const input = setting(modal, name).querySelector<HTMLInputElement>("input")!;
  input.value = value;
  input.dispatchEvent(new Event("input"));
}

function harness(
  options: {
    existing?: ReturnType<typeof createAiConnection>;
    onSave?: ReturnType<typeof vi.fn>;
    secretSet?: ReturnType<typeof vi.fn>;
    onPersisted?: ReturnType<typeof vi.fn>;
    testConnection?: ReturnType<typeof vi.fn>;
    runTransaction?: <T>(operation: () => Promise<T>) => Promise<T>;
    createConnectionId?: () => string;
  } = {},
) {
  const secretStore = {
    get: vi.fn(async () => API_KEY),
    set: options.secretSet ?? vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  };
  const onSave = options.onSave ?? vi.fn(async () => {});
  const onPersisted = options.onPersisted ?? vi.fn();
  const modal = new AiConnectionModal(new obsidian.App(), {
    locale: "zh-CN",
    existing: options.existing,
    secretStore,
    createConnectionId: options.createConnectionId ?? (() => CONNECTION_ID),
    onSave,
    onPersisted,
    ...(options.testConnection
      ? { testConnection: options.testConnection }
      : {}),
    ...(options.runTransaction ? { runTransaction: options.runTransaction } : {}),
  });
  modal.open();
  return { modal, onSave, onPersisted, secretStore };
}

beforeEach(() => {
  installObsidianDomPolyfills();
  document.body.empty();
  vi.restoreAllMocks();
});

describe("AiConnectionModal", () => {
  it("uses a responsive modal layout hook for the connection form", () => {
    const { modal } = harness();

    expect(modal.modalEl.classList).toContain(
      "rss-dashboard-ai-connection-modal",
    );
    expect(
      modal.contentEl.querySelectorAll(".rss-dashboard-ai-connection-field"),
    ).toHaveLength(7);
  });

  it("shows all eight provider choices and fills protocol/base URL without inventing a model", () => {
    const { modal } = harness();
    const provider = setting(modal, "服务商或兼容接口")
      .querySelector<HTMLSelectElement>("select")!;
    expect(Array.from(provider.options).map(({ value }) => value)).toEqual([
      "kimi",
      "deepseek",
      "qwen",
      "glm",
      "openai",
      "claude",
      "openai-compatible",
      "anthropic-compatible",
    ]);
    expect(Array.from(provider.options).map(({ textContent }) => textContent)).toEqual([
      "Kimi",
      "DeepSeek",
      "千问（Qwen）",
      "智谱 GLM",
      "OpenAI",
      "Claude",
      "OpenAI 兼容中转站",
      "Anthropic 兼容中转站",
    ]);

    expect(setting(modal, "接口协议").textContent).toContain("OpenAI Chat Completions");
    expect(setting(modal, "接口地址").querySelector<HTMLInputElement>("input")!.value)
      .toBe("https://api.moonshot.cn/v1");
    expect(setting(modal, "模型 ID").querySelector<HTMLInputElement>("input")!.value)
      .toBe("");

    provider.value = "qwen";
    provider.dispatchEvent(new Event("change"));
    expect(setting(modal, "接口地址").querySelector<HTMLInputElement>("input")!.value)
      .toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
    expect(modal.contentEl.textContent).toContain("工作空间或区域");
    expect(modal.contentEl.textContent).toContain("模型 ID 必须与当前账户和区域匹配");

    provider.value = "claude";
    provider.dispatchEvent(new Event("change"));
    expect(setting(modal, "接口协议").textContent).toContain("Anthropic Messages");
    expect(modal.contentEl.textContent).toContain("Anthropic API 密钥或兼容中转站");
    expect(modal.contentEl.textContent).toContain("Claude Code 登录不会自动导入");
  });

  it("requires an explicit model ID and accepts only safe relay base URLs", async () => {
    const { modal, onSave } = harness();
    setInput(modal, "连接名称", "我的 Kimi");
    button(modal, "保存").click();
    await flushPromises();
    expect(onSave).not.toHaveBeenCalled();
    expect(modal.contentEl.textContent).toContain("请输入模型 ID");

    const provider = setting(modal, "服务商或兼容接口")
      .querySelector<HTMLSelectElement>("select")!;
    provider.value = "openai-compatible";
    provider.dispatchEvent(new Event("change"));
    setInput(modal, "模型 ID", "relay-model");
    setInput(modal, "接口地址", "http://evil.example.com/v1");
    button(modal, "保存").click();
    await flushPromises();
    expect(onSave).not.toHaveBeenCalled();
    expect(modal.contentEl.textContent).toContain("请输入安全的接口地址");

    setInput(modal, "接口地址", "http://127.0.0.1:11434/v1");
    button(modal, "保存").click();
    await flushPromises();
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      id: CONNECTION_ID,
      providerKind: "openai-compatible",
      protocol: "openai-chat",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "relay-model",
    }));
  });

  it("persists metadata before a new key, clears the key immediately, and never puts it in metadata", async () => {
    const save = vi.fn(async () => {});
    const test = harness({ onSave: save });
    setInput(test.modal, "连接名称", "工作模型");
    setInput(test.modal, "模型 ID", "model-owned-by-account");
    const keyInput = setting(test.modal, "API 密钥")
      .querySelector<HTMLInputElement>("input")!;
    expect(keyInput.type).toBe("password");
    keyInput.value = API_KEY;
    keyInput.dispatchEvent(new Event("input"));

    const saveButton = button(test.modal, "保存");
    saveButton.click();
    saveButton.click();
    expect(keyInput.value).toBe("");
    expect(saveButton.disabled).toBe(true);
    await flushPromises();

    expect(save).toHaveBeenCalledTimes(1);
    expect(test.secretStore.set).toHaveBeenCalledTimes(1);
    expect(test.secretStore.set).toHaveBeenCalledWith(CONNECTION_ID, API_KEY);
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(
      test.secretStore.set.mock.invocationCallOrder[0],
    );
    expect(JSON.stringify(save.mock.calls[0][0])).not.toContain(API_KEY);
  });

  it("keeps the entered key when another form field fails validation", async () => {
    const test = harness();
    setInput(test.modal, "连接名称", "待补模型");
    setInput(test.modal, "API 密钥", API_KEY);
    const keyInput = setting(test.modal, "API 密钥")
      .querySelector<HTMLInputElement>("input")!;

    button(test.modal, "保存").click();
    await flushPromises();

    expect(test.onSave).not.toHaveBeenCalled();
    expect(test.secretStore.set).not.toHaveBeenCalled();
    expect(keyInput.value).toBe(API_KEY);
    expect(test.modal.contentEl.textContent).toContain("请输入模型 ID");

    setInput(test.modal, "模型 ID", "account-model");
    button(test.modal, "保存").click();
    await flushPromises();

    expect(test.secretStore.set).toHaveBeenCalledWith(CONNECTION_ID, API_KEY);
  });

  it("tests the current form and unsaved key without persisting either", async () => {
    const testConnection = vi.fn(async () => ({
      status: "success" as const,
    }));
    const test = harness({ testConnection });
    setInput(test.modal, "连接名称", "先测试再保存");
    setInput(test.modal, "模型 ID", "account-model");
    setInput(test.modal, "API 密钥", API_KEY);

    button(test.modal, "测试连接").click();
    await flushPromises();

    expect(testConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        id: CONNECTION_ID,
        name: "先测试再保存",
        model: "account-model",
      }),
      API_KEY,
      expect.any(AbortController),
    );
    expect(test.onSave).not.toHaveBeenCalled();
    expect(test.secretStore.set).not.toHaveBeenCalled();
    expect(
      setting(test.modal, "API 密钥").querySelector<HTMLInputElement>("input")!
        .value,
    ).toBe(API_KEY);
    expect(test.modal.contentEl.textContent).toContain(
      "连接成功；API 密钥尚未保存，请点击“保存”。",
    );
  });

  it("clears a stale test result when the draft connection changes", async () => {
    const testConnection = vi.fn(async () => ({
      status: "success" as const,
    }));
    const test = harness({ testConnection });
    setInput(test.modal, "连接名称", "测试结果失效");
    setInput(test.modal, "模型 ID", "account-model");
    setInput(test.modal, "API 密钥", API_KEY);

    button(test.modal, "测试连接").click();
    await flushPromises();
    expect(test.modal.contentEl.textContent).toContain(
      "连接成功；API 密钥尚未保存，请点击“保存”。",
    );

    setInput(test.modal, "模型 ID", "another-model");

    expect(test.modal.contentEl.textContent).not.toContain(
      "连接成功；API 密钥尚未保存，请点击“保存”。",
    );
  });

  it("does not apply a late test result to a draft changed in flight", async () => {
    const outcome = deferred<{ status: "success" }>();
    const testConnection = vi.fn(() => outcome.promise);
    const test = harness({ testConnection });
    setInput(test.modal, "连接名称", "测试中修改");
    setInput(test.modal, "模型 ID", "model-before-test");
    setInput(test.modal, "API 密钥", API_KEY);

    button(test.modal, "测试连接").click();
    await flushPromises();
    setInput(test.modal, "模型 ID", "model-after-test");
    outcome.resolve({ status: "success" });
    await flushPromises();

    expect(test.modal.contentEl.textContent).not.toContain(
      "连接成功；API 密钥尚未保存，请点击“保存”。",
    );
  });

  it("waits for a deferred key write before announcing the final persisted state", async () => {
    const keyWrite = deferred<void>();
    const transaction = vi.fn(async <T>(operation: () => Promise<T>) =>
      await operation());
    const test = harness({
      secretSet: vi.fn(() => keyWrite.promise),
      runTransaction: transaction,
    });
    setInput(test.modal, "连接名称", "延迟密钥");
    setInput(test.modal, "模型 ID", "account-model");
    setInput(test.modal, "API 密钥", API_KEY);
    button(test.modal, "保存").click();
    await flushPromises();

    expect(test.onSave).toHaveBeenCalledTimes(1);
    expect(test.secretStore.set).toHaveBeenCalledTimes(1);
    expect(test.onPersisted).not.toHaveBeenCalled();
    expect(test.modal.containerEl.isConnected).toBe(true);

    keyWrite.resolve();
    await flushPromises();
    expect(test.onPersisted).toHaveBeenCalledWith(
      expect.objectContaining({ id: CONNECTION_ID }),
      "key-saved",
    );
    expect(test.modal.containerEl.isConnected).toBe(false);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("defers the close callback until an in-flight key write has settled", async () => {
    const keyWrite = deferred<void>();
    const onClose = vi.fn();
    const onPersisted = vi.fn();
    const secretStore = {
      set: vi.fn(() => keyWrite.promise),
    };
    const modal = new AiConnectionModal(new obsidian.App(), {
      locale: "zh-CN",
      secretStore,
      createConnectionId: () => CONNECTION_ID,
      onSave: vi.fn(async () => {}),
      onPersisted,
      onClose,
    });
    modal.open();
    setInput(modal, "连接名称", "关闭竞态");
    setInput(modal, "模型 ID", "account-model");
    setInput(modal, "API 密钥", API_KEY);
    button(modal, "保存").click();
    await flushPromises();

    modal.close();
    expect(onClose).not.toHaveBeenCalled();
    expect(onPersisted).not.toHaveBeenCalled();
    keyWrite.resolve();
    await flushPromises();

    expect(onPersisted).toHaveBeenCalledWith(
      expect.objectContaining({ id: CONNECTION_ID }),
      "key-saved",
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("reuses the same generated UUID when a failed key write is retried in the same modal", async () => {
    const secondId = "7355ea63-b509-4da9-a2cf-3db29665f9e1";
    const ids = [CONNECTION_ID, secondId];
    const createConnectionId = vi.fn(() => ids.shift()!);
    const secretSet = vi.fn()
      .mockRejectedValueOnce(new Error(API_KEY))
      .mockResolvedValueOnce(undefined);
    const test = harness({ createConnectionId, secretSet });
    setInput(test.modal, "连接名称", "重试密钥");
    setInput(test.modal, "模型 ID", "account-model");
    setInput(test.modal, "API 密钥", API_KEY);
    button(test.modal, "保存").click();
    await flushPromises();
    expect(test.modal.containerEl.isConnected).toBe(true);

    setInput(test.modal, "API 密钥", API_KEY);
    button(test.modal, "保存").click();
    await flushPromises();

    expect(createConnectionId).toHaveBeenCalledTimes(1);
    expect(test.onSave.mock.calls.map(([connection]) => connection.id)).toEqual([
      CONNECTION_ID,
      CONNECTION_ID,
    ]);
    expect(test.onPersisted.mock.calls.map(([, status]) => status)).toEqual([
      "key-failed",
      "key-saved",
    ]);
    expect(test.modal.containerEl.isConnected).toBe(false);
  });

  it("edits metadata with an empty key field without reading, revealing, or replacing the stored key", async () => {
    const existing = createAiConnection({
      id: CONNECTION_ID,
      name: "原连接",
      providerKind: "deepseek",
      model: "deepseek-chat",
    });
    const test = harness({ existing });
    const keyInput = setting(test.modal, "API 密钥")
      .querySelector<HTMLInputElement>("input")!;
    expect(keyInput.value).toBe("");
    expect(test.modal.contentEl.textContent).not.toContain(API_KEY);
    setInput(test.modal, "连接名称", "新名称");
    button(test.modal, "保存").click();
    await flushPromises();

    expect(test.secretStore.get).not.toHaveBeenCalled();
    expect(test.secretStore.set).not.toHaveBeenCalled();
    expect(test.onSave).toHaveBeenCalledWith(expect.objectContaining({
      id: CONNECTION_ID,
      name: "新名称",
    }));
  });

  it("lets the user enable or disable a connection as ordinary non-secret metadata", async () => {
    const existing = {
      ...createAiConnection({
        id: CONNECTION_ID,
        name: "停用连接",
        providerKind: "openai",
        model: "account-model",
      }),
      enabled: false,
    };
    const test = harness({ existing });
    const enabled = setting(test.modal, "启用连接")
      .querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(enabled.checked).toBe(false);
    enabled.click();
    button(test.modal, "保存").click();
    await flushPromises();

    expect(test.onSave).toHaveBeenCalledWith(expect.objectContaining({
      id: CONNECTION_ID,
      enabled: true,
    }));
    expect(test.secretStore.set).not.toHaveBeenCalled();
  });

  it("does not touch a key when metadata save fails and reports secret write failure without leaking it", async () => {
    const metadataFailure = harness({
      onSave: vi.fn(async () => { throw new Error("metadata failed"); }),
    });
    setInput(metadataFailure.modal, "连接名称", "连接");
    setInput(metadataFailure.modal, "模型 ID", "model");
    setInput(metadataFailure.modal, "API 密钥", API_KEY);
    button(metadataFailure.modal, "保存").click();
    await flushPromises();
    expect(metadataFailure.secretStore.set).not.toHaveBeenCalled();
    expect(metadataFailure.modal.contentEl.textContent).toContain("无法保存连接设置");
    expect(metadataFailure.modal.contentEl.textContent).not.toContain(API_KEY);

    document.body.empty();
    const secretFailure = harness({
      secretSet: vi.fn(async () => { throw new Error(API_KEY); }),
    });
    setInput(secretFailure.modal, "连接名称", "连接");
    setInput(secretFailure.modal, "模型 ID", "model");
    setInput(secretFailure.modal, "API 密钥", API_KEY);
    button(secretFailure.modal, "保存").click();
    await flushPromises();
    expect(secretFailure.onSave).toHaveBeenCalledTimes(1);
    expect(secretFailure.onPersisted).toHaveBeenCalledWith(
      expect.objectContaining({ id: CONNECTION_ID }),
      "key-failed",
    );
    expect(secretFailure.modal.contentEl.textContent).toContain(
      "连接已保存，但无法确认密钥保存状态",
    );
    expect(secretFailure.modal.contentEl.textContent).not.toContain(API_KEY);
    expect(secretFailure.modal.containerEl.isConnected).toBe(true);
  });
});
