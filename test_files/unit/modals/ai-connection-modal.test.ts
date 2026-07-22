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
  } = {},
) {
  const secretStore = {
    get: vi.fn(async () => API_KEY),
    set: options.secretSet ?? vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  };
  const onSave = options.onSave ?? vi.fn(async () => {});
  const modal = new AiConnectionModal(new obsidian.App(), {
    locale: "zh-CN",
    existing: options.existing,
    secretStore,
    createConnectionId: () => CONNECTION_ID,
    onSave,
  });
  modal.open();
  return { modal, onSave, secretStore };
}

beforeEach(() => {
  installObsidianDomPolyfills();
  document.body.empty();
  vi.restoreAllMocks();
});

describe("AiConnectionModal", () => {
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
    expect(secretFailure.modal.contentEl.textContent).toContain("连接已保存，但无法安全保存密钥");
    expect(secretFailure.modal.contentEl.textContent).not.toContain(API_KEY);
    expect(secretFailure.modal.containerEl.isConnected).toBe(true);
  });
});
