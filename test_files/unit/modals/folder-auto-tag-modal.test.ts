import { beforeEach, describe, expect, it, vi } from "vitest";
import * as obsidian from "obsidian";
import type RssDashboardPlugin from "../../../main";
import { FolderAutoTagModal } from "../../../src/modals/feed-manager/folder-auto-tag-modal";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createPlugin(locale: "zh-CN" | "en") {
  return {
    settings: {
      locale,
      availableTags: [{ name: "AI", color: "#123456" }],
    },
  } as unknown as RssDashboardPlugin;
}

beforeEach(() => {
  installObsidianDomPolyfills();
  document.body.empty();
  vi.restoreAllMocks();
});

describe("FolderAutoTagModal", () => {
  it.each([
    ["zh-CN", "为文件夹订阅源自动添加标签", "配置“行业/AI”的自动标签", "保存"],
    [
      "en",
      "Auto-tag feeds in folder",
      'Configure auto-tags for "行业/AI"',
      "Save",
    ],
  ] as const)(
    "renders localized validation context and calls save in %s",
    async (locale, title, description, saveLabel) => {
      const onSave = vi.fn(async () => {});
      const modal = new FolderAutoTagModal(
        new obsidian.App(),
        createPlugin(locale),
        "行业/AI",
        ["AI"],
        onSave,
      );
      modal.open();
      expect(modal.contentEl.textContent).toContain(title);
      expect(modal.contentEl.textContent).toContain(description);

      const save = Array.from(modal.contentEl.querySelectorAll("button")).find(
        (button) => button.textContent === saveLabel,
      )!;
      save.click();
      await flushPromises();
      expect(onSave).toHaveBeenCalledWith(
        [{ name: "AI", color: "#123456" }],
        true,
        "none",
      );
    },
  );

  it.each([
    ["zh-CN", "无法应用文件夹自动标签，请查看控制台了解详情。"],
    ["en", "Could not apply folder auto-tags. Check the console for details."],
  ] as const)(
    "localizes unknown callback failures in %s",
    async (locale, expected) => {
      const raw = "folder callback secret";
      const onSave = vi.fn(async () => {
        throw new Error(raw);
      });
      const noticeSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const modal = new FolderAutoTagModal(
        new obsidian.App(),
        createPlugin(locale),
        "行业/AI",
        [],
        onSave,
      );
      modal.open();
      const saveLabel = locale === "zh-CN" ? "保存" : "Save";
      Array.from(modal.contentEl.querySelectorAll("button"))
        .find((button) => button.textContent === saveLabel)!
        .click();
      await flushPromises();

      expect(noticeSpy).toHaveBeenCalledWith("[Stub Notice]", expected);
      expect(noticeSpy.mock.calls.flat().join(" ")).not.toContain(raw);
      expect(errorSpy.mock.calls.flat().join(" ")).toContain(raw);
    },
  );
});
