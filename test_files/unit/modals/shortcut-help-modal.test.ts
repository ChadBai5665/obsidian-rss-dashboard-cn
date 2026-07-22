import { describe, it, expect, beforeEach, vi } from "vitest";
import { App, TFile } from "obsidian";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";
import {
  SHORTCUT_SECTIONS,
  ShortcutHelpModal,
} from "../../../src/modals/shortcut-help-modal";

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ShortcutHelpModal", () => {
  beforeEach(() => {
    installObsidianDomPolyfills();
    document.body.empty();
  });

  function createMockApp(): App {
    return {} as unknown as App;
  }

  it("defaults the UI to Simplified Chinese and uses one typed descriptor source", () => {
    const modal = new ShortcutHelpModal(createMockApp());
    modal.onOpen();
    expect(modal.contentEl.textContent).toContain("常规导航");
    expect(modal.contentEl.textContent).toContain("打开帮助对话框");
    expect(SHORTCUT_SECTIONS).toHaveLength(5);
    expect(
      SHORTCUT_SECTIONS.reduce(
        (count, section) => count + section.items.length,
        0,
      ),
    ).toBe(40);
  });

  it("renders the help modal with correct sections", () => {
    const app = createMockApp();
    const modal = new ShortcutHelpModal(app, {
      locale: "en",
    } as ConstructorParameters<typeof ShortcutHelpModal>[1]);

    // Simulate Obsidian Modal open behavior
    modal.onOpen();

    const content = modal.contentEl;
    expect(content.querySelector(".rss-dashboard-header")).toBeDefined();

    // Should have general navigation section
    const textContent = content.textContent;
    expect(textContent).toContain("General Navigation");
    expect(textContent).toContain("Open Help Dialog");
    expect(textContent).toContain("Focus dashboard view");
    expect(textContent).toContain("Focus sidebar");
    expect(textContent).toContain("Focus reader view");
    expect(textContent).toContain("Shift + l");
    expect(textContent).toContain("Shift + o / Shift + Enter");

    modal.onClose();
  });

  it("has a compliant clickable-icon for the close button", () => {
    const app = createMockApp();
    const modal = new ShortcutHelpModal(app, {
      locale: "en",
    } as ConstructorParameters<typeof ShortcutHelpModal>[1]);

    modal.onOpen();

    const closeBtn = modal.contentEl.querySelector(
      ".rss-dashboard-header-close-button.clickable-icon",
    );
    expect(closeBtn).not.toBeNull();
    if (closeBtn) {
      expect(closeBtn.getAttribute("role")).toBe("button");
      expect(closeBtn.getAttribute("tabindex")).toBe("0");
    }

    modal.onClose();
  });

  it.each([
    [
      "zh-CN",
      "快捷键",
      "常规导航",
      "打开帮助对话框",
      "快捷键已保存到“知识库/keyboard-shortcuts.md”",
    ],
    [
      "en",
      "Keyboard Shortcuts",
      "General Navigation",
      "Open Help Dialog",
      'Keyboard shortcuts saved to "知识库/keyboard-shortcuts.md"',
    ],
  ] as const)(
    "saves localized UI-derived Markdown and a parameterized path notice in %s",
    async (locale, title, section, action, expectedNotice) => {
      const app = App.createMock();
      const noticeSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
      const modal = new ShortcutHelpModal(app, {
        locale,
        articleSaving: { defaultFolder: "知识库" },
      } as ConstructorParameters<typeof ShortcutHelpModal>[1]);
      modal.open();

      modal.contentEl
        .querySelector<HTMLAnchorElement>(".rss-dashboard-save-shortcuts-link")!
        .click();
      await flushPromises();

      const file = app.vault.getAbstractFileByPath(
        "知识库/keyboard-shortcuts.md",
      );
      if (!(file instanceof TFile)) {
        throw new Error("Expected localized shortcut note to be created");
      }
      const markdown = await app.vault.read(file);
      expect(markdown).toContain(`# ${title}`);
      expect(markdown).toContain(`## ${section}`);
      expect(markdown).toContain(action);
      expect(modal.contentEl.textContent).toContain(section);
      expect(noticeSpy).toHaveBeenCalledWith("[Stub Notice]", expectedNotice);
    },
  );

  it.each([
    ["zh-CN", "创建快捷键笔记文件夹失败，请查看控制台了解详情。"],
    [
      "en",
      "Failed to create the shortcut note folder. Check the console for details.",
    ],
  ] as const)(
    "localizes folder creation failures in %s",
    async (locale, expected) => {
      const app = App.createMock();
      const raw = "mkdir secret";
      vi.spyOn(app.vault, "createFolder").mockRejectedValue(new Error(raw));
      const noticeSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const modal = new ShortcutHelpModal(app, {
        locale,
        articleSaving: { defaultFolder: "知识库" },
      } as ConstructorParameters<typeof ShortcutHelpModal>[1]);
      modal.open();

      modal.contentEl
        .querySelector<HTMLAnchorElement>(".rss-dashboard-save-shortcuts-link")!
        .click();
      await flushPromises();

      expect(noticeSpy).toHaveBeenCalledWith("[Stub Notice]", expected);
      expect(noticeSpy.mock.calls.flat().join(" ")).not.toContain(raw);
      expect(errorSpy.mock.calls.flat().join(" ")).toContain(raw);
    },
  );

  it.each([
    ["zh-CN", "保存快捷键失败，请查看控制台了解详情。"],
    ["en", "Failed to save keyboard shortcuts. Check the console for details."],
  ] as const)(
    "localizes unknown save failures in %s",
    async (locale, expected) => {
      const app = App.createMock();
      const raw = "vault secret";
      vi.spyOn(app.vault, "create").mockRejectedValue(new Error(raw));
      const noticeSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const modal = new ShortcutHelpModal(app, {
        locale,
        articleSaving: { defaultFolder: "/" },
      } as ConstructorParameters<typeof ShortcutHelpModal>[1]);
      modal.open();

      modal.contentEl
        .querySelector<HTMLAnchorElement>(".rss-dashboard-save-shortcuts-link")!
        .click();
      await flushPromises();

      expect(noticeSpy).toHaveBeenCalledWith("[Stub Notice]", expected);
      expect(noticeSpy.mock.calls.flat().join(" ")).not.toContain(raw);
      expect(errorSpy.mock.calls.flat().join(" ")).toContain(raw);
    },
  );
});
