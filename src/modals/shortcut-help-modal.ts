import { Modal, App, setIcon, Notice } from "obsidian";
import type { RssDashboardSettings } from "../types/types";
import {
  createTranslator,
  type TranslationKey,
  type Translator,
} from "../i18n";

interface ShortcutItemDescriptor {
  readonly key: string;
  readonly descriptionKey: TranslationKey;
}

interface ShortcutSectionDescriptor {
  readonly titleKey: TranslationKey;
  readonly items: readonly ShortcutItemDescriptor[];
}

/** Shared source for both the live help UI and the generated Vault note. */
export const SHORTCUT_SECTIONS: readonly ShortcutSectionDescriptor[] = [
  {
    titleKey: "modal.shortcuts.section.general",
    items: [
      { key: "?", descriptionKey: "modal.shortcuts.action.openHelp" },
      { key: "Esc", descriptionKey: "modal.shortcuts.action.close" },
      { key: "r", descriptionKey: "modal.shortcuts.action.refresh" },
    ],
  },
  {
    titleKey: "modal.shortcuts.section.dashboard",
    items: [
      {
        key: "Shift + s",
        descriptionKey: "modal.shortcuts.action.focusSidebar",
      },
      {
        key: "Shift + r",
        descriptionKey: "modal.shortcuts.action.focusReader",
      },
      { key: "Shift + 1", descriptionKey: "modal.shortcuts.action.filterAll" },
      {
        key: "Shift + 2",
        descriptionKey: "modal.shortcuts.action.filterUnread",
      },
      { key: "Shift + 3", descriptionKey: "modal.shortcuts.action.filterRead" },
      { key: "1", descriptionKey: "modal.shortcuts.action.listView" },
      { key: "2", descriptionKey: "modal.shortcuts.action.cardView" },
      { key: "3", descriptionKey: "modal.shortcuts.action.feedView" },
    ],
  },
  {
    titleKey: "modal.shortcuts.section.reader",
    items: [
      {
        key: "Shift + d",
        descriptionKey: "modal.shortcuts.action.focusDashboard",
      },
      {
        key: "Shift + s",
        descriptionKey: "modal.shortcuts.action.focusSidebar",
      },
      {
        key: "Shift + r",
        descriptionKey: "modal.shortcuts.action.focusReader",
      },
      {
        key: "ArrowUp / ArrowDown",
        descriptionKey: "modal.shortcuts.action.scrollVertical",
      },
      {
        key: "ArrowLeft / ArrowRight",
        descriptionKey: "modal.shortcuts.action.scrollHorizontal",
      },
      {
        key: "PageUp / PageDown",
        descriptionKey: "modal.shortcuts.action.scrollPage",
      },
      {
        key: "Home / End",
        descriptionKey: "modal.shortcuts.action.jumpBoundary",
      },
      { key: "= / +", descriptionKey: "modal.shortcuts.action.fontIncrease" },
      { key: "- / _", descriptionKey: "modal.shortcuts.action.fontDecrease" },
      { key: "0", descriptionKey: "modal.shortcuts.action.fontReset" },
    ],
  },
  {
    titleKey: "modal.shortcuts.section.article",
    items: [
      {
        key: "Arrow keys",
        descriptionKey: "modal.shortcuts.action.cardNavigation",
      },
      {
        key: "o / Enter",
        descriptionKey: "modal.shortcuts.action.openArticle",
      },
      { key: "k", descriptionKey: "modal.shortcuts.action.closeReader" },
      { key: "j", descriptionKey: "modal.shortcuts.action.previousArticle" },
      { key: "l", descriptionKey: "modal.shortcuts.action.nextArticle" },
      { key: "m", descriptionKey: "modal.shortcuts.action.toggleRead" },
      { key: ",", descriptionKey: "modal.shortcuts.action.readAndNext" },
      {
        key: "Shift + a",
        descriptionKey: "modal.shortcuts.action.markAllRead",
      },
      { key: "f", descriptionKey: "modal.shortcuts.action.toggleStar" },
      { key: "t", descriptionKey: "modal.shortcuts.action.addTags" },
      { key: "s", descriptionKey: "modal.shortcuts.action.saveContent" },
    ],
  },
  {
    titleKey: "modal.shortcuts.section.sidebar",
    items: [
      { key: "Shift + l", descriptionKey: "modal.shortcuts.action.nextItem" },
      {
        key: "Shift + j",
        descriptionKey: "modal.shortcuts.action.previousItem",
      },
      {
        key: "ArrowUp / ArrowDown",
        descriptionKey: "modal.shortcuts.action.moveFocus",
      },
      {
        key: "ArrowLeft / ArrowRight",
        descriptionKey: "modal.shortcuts.action.jumpFolders",
      },
      {
        key: "Shift + o / Shift + Enter",
        descriptionKey: "modal.shortcuts.action.openFocused",
      },
      {
        key: "Shift + x",
        descriptionKey: "modal.shortcuts.action.toggleFolder",
      },
      {
        key: "Shift + d",
        descriptionKey: "modal.shortcuts.action.deleteSource",
      },
      {
        key: "Shift + r",
        descriptionKey: "modal.shortcuts.action.renameSource",
      },
    ],
  },
] as const;

export class ShortcutHelpModal extends Modal {
  constructor(
    app: App,
    private settings?: RssDashboardSettings,
  ) {
    super(app);
  }

  private getTranslator(): Translator {
    return createTranslator(this.settings?.locale ?? "zh-CN");
  }

  onOpen() {
    const t = this.getTranslator();
    const { contentEl } = this;
    contentEl.empty();
    this.modalEl.addClass("rss-dashboard-modal");
    this.modalEl.addClass("rss-dashboard-modal-container");
    this.modalEl.addClass("rss-shortcut-help-modal");

    const header = contentEl.createDiv({ cls: "rss-dashboard-header" });
    header.createDiv({
      cls: "rss-dashboard-header-title",
      text: t("modal.shortcuts.title"),
    });

    const saveLink = header.createEl("a", {
      cls: "rss-dashboard-save-shortcuts-link",
      text: t("modal.shortcuts.save"),
      href: "#",
    });
    saveLink.addEventListener("click", (event: Event) => {
      event.preventDefault();
      void this.saveShortcutsToVault();
    });

    const closeBtn = header.createDiv({
      cls: "rss-dashboard-header-close-button clickable-icon",
      attr: {
        role: "button",
        tabindex: "0",
        "aria-label": t("common.close"),
      },
    });
    setIcon(closeBtn, "x");
    const handleClose = (event: Event) => {
      event.preventDefault();
      this.close();
    };
    closeBtn.addEventListener("click", handleClose);
    closeBtn.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") {
        handleClose(event);
      }
    });

    const body = contentEl.createDiv({ cls: "rss-dashboard-modal-content" });
    for (const section of SHORTCUT_SECTIONS) {
      this.renderSection(body, section, t);
    }
  }

  private async saveShortcutsToVault(): Promise<void> {
    const t = this.getTranslator();
    try {
      let content = `# ${t("modal.shortcuts.markdownTitle")}\n\n`;
      for (const section of SHORTCUT_SECTIONS) {
        content += `## ${t(section.titleKey)}\n\n`;
        content += `| ${t("modal.shortcuts.shortcut")} | ${t("modal.shortcuts.action")} |\n`;
        content += "|----------|--------|\n";
        for (const item of section.items) {
          content += `| ${item.key} | ${t(item.descriptionKey)} |\n`;
        }
        content += "\n";
      }

      const configuredFolder = this.settings?.articleSaving.defaultFolder;
      const saveFolder = configuredFolder?.trim() ? configuredFolder : "/";
      const vault = this.app.vault;
      const folderPath =
        saveFolder === "/" ? "" : saveFolder.replace(/^\/|\/$/g, "");

      if (folderPath && !vault.getAbstractFileByPath(folderPath)) {
        try {
          await vault.createFolder(folderPath);
        } catch (error) {
          console.error(
            "[RSS Dashboard] Failed to create shortcut note folder:",
            folderPath,
            error,
          );
          new Notice(t("modal.shortcuts.folderCreateFailed"));
          return;
        }
      }

      const fileName = t("modal.shortcuts.fileName");
      const filePath = folderPath ? `${folderPath}/${fileName}` : fileName;
      try {
        const existingFile = vault.getAbstractFileByPath(filePath);
        if (existingFile) {
          await this.app.fileManager.trashFile(existingFile);
        }
      } catch (error) {
        console.warn(
          "[RSS Dashboard] Could not remove existing shortcut note:",
          filePath,
          error,
        );
      }

      const file = await vault.create(filePath, content);
      new Notice(t("modal.shortcuts.saved", { path: file.path }));
    } catch (error) {
      console.error(
        "[RSS Dashboard] Failed to save keyboard shortcuts:",
        error,
      );
      new Notice(t("modal.shortcuts.saveFailed"));
    }
  }

  private renderSection(
    container: HTMLElement,
    descriptor: ShortcutSectionDescriptor,
    t: Translator,
  ) {
    const section = container.createDiv({ cls: "rss-shortcut-section" });
    section.createEl("h3", { text: t(descriptor.titleKey) });

    const grid = section.createDiv({ cls: "rss-shortcut-grid" });
    for (const item of descriptor.items) {
      const row = grid.createDiv({ cls: "rss-shortcut-row" });
      row.createDiv({
        cls: "rss-shortcut-desc",
        text: t(item.descriptionKey),
      });
      const keyContainer = row.createDiv({
        cls: "rss-shortcut-key-container",
      });
      keyContainer.createEl("kbd", { text: item.key });
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}
