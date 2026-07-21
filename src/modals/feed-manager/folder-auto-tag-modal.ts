import { Modal, App, Setting, Notice } from "obsidian";
import type RssDashboardPlugin from "../../../main";
import type { Tag } from "../../types/types";
import type { FolderExistingArticleAction } from "../../utils/folder-tag-sync";
import { shouldUseMobileSidebarLayout } from "../../utils/platform-utils";
import { addTagMultiSelectControl } from "../../components/tag-multi-select-control";
import { createTranslator } from "../../i18n";

export class FolderAutoTagModal extends Modal {
  plugin: RssDashboardPlugin;
  folderPath: string;
  selectedTagNames: string[];
  includeSubfolders: boolean = true;
  existingArticlesAction: FolderExistingArticleAction = "none";
  onSave: (
    tags: Tag[],
    includeSubfolders: boolean,
    existingArticlesAction: FolderExistingArticleAction,
  ) => Promise<void>;

  constructor(
    app: App,
    plugin: RssDashboardPlugin,
    folderPath: string,
    selectedTagNames: string[],
    onSave: (
      tags: Tag[],
      includeSubfolders: boolean,
      existingArticlesAction: FolderExistingArticleAction,
    ) => Promise<void>,
  ) {
    super(app);
    this.plugin = plugin;
    this.folderPath = folderPath;
    this.selectedTagNames = selectedTagNames;
    this.onSave = onSave;
  }

  onOpen() {
    const t = createTranslator(this.plugin.settings.locale ?? "zh-CN");
    const { contentEl } = this;
    this.modalEl.className +=
      " rss-dashboard-modal rss-dashboard-modal-container";

    if (shouldUseMobileSidebarLayout()) {
      this.modalEl.addClass("rss-mobile-feed-manager-modal");
      const closeBtn = this.modalEl.querySelector(".modal-close-button");
      if (closeBtn) {
        closeBtn.remove();
      }
    }

    contentEl.empty();
    new Setting(contentEl).setName(t("modal.folderAuto.title")).setHeading();

    contentEl.createDiv({
      cls: "add-feed-subtitle",
      text: t("modal.folderAuto.desc", { folder: this.folderPath }),
    });

    const autoTagSetting = new Setting(contentEl)
      .setName(t("modal.folderAuto.tags"))
      .setDesc(
        t("modal.folderAuto.tagsDesc"),
      );

    addTagMultiSelectControl({
      setting: autoTagSetting,
      availableTags: this.plugin.settings.availableTags,
      selectedTagNames: this.selectedTagNames,
      triggerEmptyLabel: t("modal.tags.none"),
      menuTitle: t("modal.folderAuto.select"),
      mobileSheetTitle: t("modal.folderAuto.tags"),
      locale: this.plugin.settings.locale ?? "zh-CN",
      onChange: (selected) => {
        this.selectedTagNames = selected;
      },
    });

    new Setting(contentEl).setName(t("modal.folderAuto.options")).setHeading();

    new Setting(contentEl)
      .setName(t("modal.folderAuto.includeSubfolders"))
      .setDesc(
        t("modal.folderAuto.includeSubfoldersDesc"),
      )
      .addToggle((toggle) =>
        toggle.setValue(this.includeSubfolders).onChange((value) => {
          this.includeSubfolders = value;
        }),
      );

    new Setting(contentEl)
      .setName(t("modal.folderAuto.existing"))
      .setDesc(
        t("modal.folderAuto.existingDesc"),
      )
      .addDropdown((dropdown) => {
        dropdown
          .addOption("none", t("modal.folderAuto.dontUpdate"))
          .addOption("sync", t("modal.folderAuto.sync"))
          .addOption("remove_all", t("modal.folderAuto.removeAll"))
          .setValue(this.existingArticlesAction)
          .onChange((value) => {
            this.existingArticlesAction =
              value as FolderExistingArticleAction;
          });
      });

    const buttonContainer = contentEl.createDiv({
      cls: "rss-dashboard-modal-buttons",
    });

    const cancelButton = buttonContainer.createEl("button", {
      text: t("common.cancel"),
      cls: "rss-dashboard-cancel-button",
    });
    cancelButton.addEventListener("click", () => this.close());

    const saveButton = buttonContainer.createEl("button", {
      text: t("common.save"),
      cls: "rss-dashboard-primary-button",
    });

    saveButton.addEventListener("click", () => {
      const selectedTagObjects = this.plugin.settings.availableTags.filter(
        (tag) => this.selectedTagNames.includes(tag.name),
      );

      void (async () => {
        try {
          await this.onSave(
            selectedTagObjects,
            this.includeSubfolders,
            this.existingArticlesAction,
          );
          this.close();
        } catch (error) {
          console.error("Error applying folder auto-tags:", error);
          new Notice(t("modal.folderAuto.error", {
            error: error instanceof Error ? error.message : "Unknown error",
          }));
        }
      })();
    });
  }
}
