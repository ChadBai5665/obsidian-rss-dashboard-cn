import { beforeEach, describe, expect, it, vi } from "vitest";
import * as obsidian from "obsidian";
import { XTopicSourceModal } from "../../../src/modals/x-topic-source-modal";
import { createXTopicSourceConfig } from "../../../src/sources/source-config";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function setting(modal: XTopicSourceModal, name: string): HTMLElement {
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

describe("XTopicSourceModal", () => {
  it("uses the responsive form layout for fields and actions", () => {
    const modal = new XTopicSourceModal(new obsidian.App(), {
      locale: "zh-CN",
      maxRequestsPerRun: 40,
      maxRequestsPerDay: 100,
      existingTopics: [],
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

  it("offers exactly 1, 3, 7, 14, 30 days with 7 selected and updates request math", () => {
    const modal = new XTopicSourceModal(new obsidian.App(), {
      locale: "zh-CN",
      maxRequestsPerRun: 40,
      maxRequestsPerDay: 100,
      existingTopics: [],
      onSave: vi.fn(async () => {}),
    });
    modal.open();

    const windowSelect = setting(modal, "观察窗口").querySelector<HTMLSelectElement>("select")!;
    expect(Array.from(windowSelect.options).map(({ value }) => value)).toEqual([
      "1", "3", "7", "14", "30",
    ]);
    expect(windowSelect.value).toBe("7");
    expect(modal.contentEl.textContent).toContain("预计每次刷新 2 次请求");
    expect(modal.contentEl.textContent).toContain("单次上限 40 次；每日上限 100 次");

    const priority = setting(modal, "重点账号").querySelector<HTMLInputElement>("input")!;
    priority.value = "openai";
    priority.dispatchEvent(new Event("input"));
    expect(modal.contentEl.textContent).toContain("预计每次刷新 3 次请求");
  });

  it("disables modal actions synchronously and submits only once", async () => {
    let resolveSave!: () => void;
    const pending = new Promise<void>((resolve) => { resolveSave = resolve; });
    const onSave = vi.fn(() => pending);
    const modal = new XTopicSourceModal(new obsidian.App(), {
      locale: "zh-CN",
      maxRequestsPerRun: 40,
      maxRequestsPerDay: 100,
      existingTopics: [],
      onSave,
    });
    modal.open();
    const name = setting(modal, "主题名称").querySelector<HTMLInputElement>("input")!;
    const includes = setting(modal, "包含关键词").querySelector<HTMLInputElement>("input")!;
    name.value = "AI 工具";
    name.dispatchEvent(new Event("input"));
    includes.value = "agent";
    includes.dispatchEvent(new Event("input"));
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
    const modal = new XTopicSourceModal(new obsidian.App(), {
      locale: "zh-CN",
      maxRequestsPerRun: 40,
      maxRequestsPerDay: 100,
      existingTopics: [],
      onSave: vi.fn(async () => { throw new Error("save failed"); }),
    });
    modal.open();
    const name = setting(modal, "主题名称").querySelector<HTMLInputElement>("input")!;
    const includes = setting(modal, "包含关键词").querySelector<HTMLInputElement>("input")!;
    name.value = "AI 工具";
    name.dispatchEvent(new Event("input"));
    includes.value = "agent";
    includes.dispatchEvent(new Event("input"));
    const save = Array.from(modal.contentEl.querySelectorAll("button"))
      .find((button) => button.textContent === "保存")!;
    save.click();
    expect(save.disabled).toBe(true);
    await flushPromises();
    expect(save.disabled).toBe(false);
    expect(save.getAttribute("aria-disabled")).toBe("false");
    expect(modal.contentEl.textContent).toContain("无法保存发现主题");
  });

  it("reuses topic/query validation, rejects duplicate topics, and cancel never saves", async () => {
    const onSave = vi.fn(async () => {});
    const modal = new XTopicSourceModal(new obsidian.App(), {
      locale: "zh-CN",
      maxRequestsPerRun: 40,
      maxRequestsPerDay: 100,
      existingTopics: [createXTopicSourceConfig({
        id: "ai-methods",
        name: "AI 方法论",
        includeKeywords: ["agent"],
      })],
      onSave,
    });
    modal.open();
    const name = setting(modal, "主题名称").querySelector<HTMLInputElement>("input")!;
    const includes = setting(modal, "包含关键词").querySelector<HTMLInputElement>("input")!;
    name.value = "AI 方法论";
    name.dispatchEvent(new Event("input"));
    includes.value = "agent";
    includes.dispatchEvent(new Event("input"));
    Array.from(modal.contentEl.querySelectorAll("button"))
      .find((button) => button.textContent === "保存")!.click();
    await flushPromises();
    expect(onSave).not.toHaveBeenCalled();
    expect(modal.contentEl.textContent).toContain("该主题已存在");

    name.value = "新主题";
    name.dispatchEvent(new Event("input"));
    includes.value = "";
    includes.dispatchEvent(new Event("input"));
    Array.from(modal.contentEl.querySelectorAll("button"))
      .find((button) => button.textContent === "保存")!.click();
    await flushPromises();
    expect(onSave).not.toHaveBeenCalled();
    expect(modal.contentEl.textContent).toContain("至少填写一个包含关键词");

    Array.from(modal.contentEl.querySelectorAll("button"))
      .find((button) => button.textContent === "取消")!.click();
    expect(onSave).not.toHaveBeenCalled();
  });
});
