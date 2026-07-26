import { beforeEach, describe, expect, it, vi } from "vitest";
import * as obsidian from "obsidian";
import { XAccountSourceModal } from "../../../src/modals/x-account-source-modal";
import { createXAccountSourceConfig } from "../../../src/sources/source-config";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function setting(modal: XAccountSourceModal, name: string): HTMLElement {
  const result = Array.from(modal.contentEl.querySelectorAll<HTMLElement>(".setting-item"))
    .find((element) => element.querySelector(".setting-item-name")?.textContent === name);
  if (!result) throw new Error(`Missing setting ${name}`);
  return result;
}

beforeEach(() => {
  installObsidianDomPolyfills();
  document.body.empty();
  vi.restoreAllMocks();
});

describe("XAccountSourceModal", () => {
  it("uses the responsive form layout for fields and actions", () => {
    const modal = new XAccountSourceModal(new obsidian.App(), {
      locale: "zh-CN",
      maxRequestsPerRun: 40,
      maxRequestsPerDay: 100,
      existingAccounts: [],
      onSave: vi.fn(async () => {}),
    });
    modal.open();

    expect(modal.modalEl.classList).toContain("rss-dashboard-form-modal");
    expect(
      modal.contentEl.querySelectorAll(".rss-dashboard-form-field"),
    ).toHaveLength(6);
    expect(
      modal.contentEl.querySelectorAll(".rss-dashboard-form-actions"),
    ).toHaveLength(1);
  });

  it("defaults replies/reposts off and updates the visible estimate when replies are enabled", () => {
    const modal = new XAccountSourceModal(new obsidian.App(), {
      locale: "zh-CN",
      maxRequestsPerRun: 40,
      maxRequestsPerDay: 100,
      existingAccounts: [],
      onSave: vi.fn(async () => {}),
    });
    modal.open();

    const replies = setting(modal, "包含回复").querySelector<HTMLInputElement>("input")!;
    const reposts = setting(modal, "包含转发").querySelector<HTMLInputElement>("input")!;
    expect(replies.checked).toBe(false);
    expect(reposts.checked).toBe(false);
    expect(modal.contentEl.textContent).toContain("预计每次刷新 1 次请求");
    expect(modal.contentEl.textContent).toContain("开启回复会额外产生 1 次计费请求");
    expect(modal.contentEl.textContent).toContain("单次上限 40 次；每日上限 100 次");

    replies.click();
    expect(modal.contentEl.textContent).toContain("预计每次刷新 2 次请求");
  });

  it("disables modal actions synchronously and submits only once", async () => {
    let resolveSave!: () => void;
    const pending = new Promise<void>((resolve) => { resolveSave = resolve; });
    const onSave = vi.fn(() => pending);
    const modal = new XAccountSourceModal(new obsidian.App(), {
      locale: "zh-CN",
      maxRequestsPerRun: 40,
      maxRequestsPerDay: 100,
      existingAccounts: [],
      onSave,
    });
    modal.open();
    const handle = setting(modal, "X 账号").querySelector<HTMLInputElement>("input")!;
    handle.value = "AnthropicAI";
    handle.dispatchEvent(new Event("input"));
    const save = Array.from(modal.contentEl.querySelectorAll("button"))
      .find((button) => button.textContent === "保存")!;
    save.click();
    save.click();
    expect(save.disabled).toBe(true);
    expect(save.getAttribute("aria-disabled")).toBe("true");
    expect(onSave).toHaveBeenCalledTimes(1);
    resolveSave();
    await flushPromises();
    expect(modal.containerEl.isConnected).toBe(false);
  });

  it("restores modal actions after an asynchronous save failure", async () => {
    const modal = new XAccountSourceModal(new obsidian.App(), {
      locale: "zh-CN",
      maxRequestsPerRun: 40,
      maxRequestsPerDay: 100,
      existingAccounts: [],
      onSave: vi.fn(async () => { throw new Error("save failed"); }),
    });
    modal.open();
    const handle = setting(modal, "X 账号").querySelector<HTMLInputElement>("input")!;
    handle.value = "AnthropicAI";
    handle.dispatchEvent(new Event("input"));
    const save = Array.from(modal.contentEl.querySelectorAll("button"))
      .find((button) => button.textContent === "保存")!;
    save.click();
    expect(save.disabled).toBe(true);
    await flushPromises();
    expect(save.disabled).toBe(false);
    expect(save.getAttribute("aria-disabled")).toBe("false");
    expect(modal.contentEl.textContent).toContain("无法保存 X 账号订阅");
  });

  it("reuses handle validation, rejects duplicates, and cancel never saves", async () => {
    const onSave = vi.fn(async () => {});
    const modal = new XAccountSourceModal(new obsidian.App(), {
      locale: "zh-CN",
      maxRequestsPerRun: 40,
      maxRequestsPerDay: 100,
      existingAccounts: [createXAccountSourceConfig({ handle: "OpenAI" })],
      onSave,
    });
    modal.open();
    const handle = setting(modal, "X 账号").querySelector<HTMLInputElement>("input")!;
    handle.value = "@bad-handle";
    handle.dispatchEvent(new Event("input"));
    Array.from(modal.contentEl.querySelectorAll("button"))
      .find((button) => button.textContent === "保存")!.click();
    await flushPromises();
    expect(onSave).not.toHaveBeenCalled();
    expect(modal.contentEl.textContent).toContain("请输入有效的 X 账号");

    handle.value = "OpenAI";
    handle.dispatchEvent(new Event("input"));
    Array.from(modal.contentEl.querySelectorAll("button"))
      .find((button) => button.textContent === "保存")!.click();
    await flushPromises();
    expect(onSave).not.toHaveBeenCalled();
    expect(modal.contentEl.textContent).toContain("该账号已订阅");

    Array.from(modal.contentEl.querySelectorAll("button"))
      .find((button) => button.textContent === "取消")!.click();
    expect(onSave).not.toHaveBeenCalled();
  });
});
