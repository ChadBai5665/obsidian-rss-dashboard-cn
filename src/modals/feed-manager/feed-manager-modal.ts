import { Modal, App, Setting, setIcon, Notice } from "obsidian";
import type RssDashboardPlugin from "../../../main";
import { ImportOpmlModal } from "../import-opml-modal";
import { shouldUseMobileSidebarLayout } from "../../utils/platform-utils";
import { createTranslator } from "../../i18n";

export class FeedManagerModal extends Modal {
  plugin: RssDashboardPlugin;

  constructor(app: App, plugin: RssDashboardPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const t = createTranslator(this.plugin.settings.locale ?? "zh-CN");
    const { contentEl } = this;
    const isMobile = shouldUseMobileSidebarLayout();

    this.modalEl.className +=
      " rss-dashboard-modal rss-dashboard-modal-container";
    if (isMobile) {
      this.modalEl.addClass("rss-mobile-feed-manager-modal");
    }

    contentEl.empty();

    new Setting(contentEl).setName(t("modal.feedManager.title")).setHeading();

    // Single button row for all four actions
    const buttonRow = contentEl.createDiv({
      cls: "feed-manager-button-row",
    });

    // Add feed button
    const addFeedBtn = buttonRow.createEl("button", {
      cls: "feed-manager-add-button",
    });
    addFeedBtn.createSpan({ text: t("modal.feedManager.add") });
    addFeedBtn.onclick = () => {
      this.plugin.openAddSourceModal();
    };

    // Import OPML button
    const importOpmlBtn = buttonRow.createEl("button", {
      cls: "feed-manager-import-button",
    });
    setIcon(importOpmlBtn, "upload");
    importOpmlBtn.createSpan({ text: ` ${t("modal.feedManager.import")}` });
    importOpmlBtn.onclick = () => {
      new ImportOpmlModal(this.app, this.plugin, () => this.close()).open();
    };

    // Export OPML button
    const exportOpmlBtn = buttonRow.createEl("button", {
      cls: "feed-manager-export-button",
    });
    setIcon(exportOpmlBtn, "download");
    exportOpmlBtn.createSpan({ text: ` ${t("modal.feedManager.export")}` });
    exportOpmlBtn.onclick = () => {
      this.plugin.exportOpml();
    };

    // Delete All button
    const deleteAllBtn = buttonRow.createEl("button", {
      cls: "feed-manager-delete-all-button",
    });
    setIcon(deleteAllBtn, "trash-2");
    deleteAllBtn.createSpan({ text: ` ${t("modal.feedManager.deleteAll")}` });
    deleteAllBtn.onclick = () => {
      if (this.plugin.settings.feeds.length === 0) {
        new Notice(t("modal.feedManager.noneToDelete"));
        return;
      }

      const confirmModal = new Modal(this.app);
      confirmModal.modalEl.addClass("rss-dashboard-confirm-modal");

      const { contentEl } = confirmModal;
      contentEl.empty();

      new Setting(contentEl)
        .setName(t("modal.feedManager.deleteAllTitle"))
        .setHeading();
      contentEl.createEl("p", {
        text: t("modal.feedManager.deleteAllDesc", {
          count: this.plugin.settings.feeds.length,
        }),
      });

      const buttonsSetting = new Setting(contentEl);
      buttonsSetting.controlEl.addClass("rss-dashboard-modal-buttons");
      buttonsSetting
        .addButton((btn) =>
          btn.setButtonText(t("common.cancel")).onClick(() => {
            confirmModal.close();
          }),
        )
        .addButton((btn) =>
          btn
            .setButtonText(t("modal.feedManager.deleteAll"))
            .setWarning()
            .onClick(async () => {
              this.plugin.settings.feeds = [];
              await this.plugin.saveSettings();
              
              const dashboardView = await this.plugin.getActiveDashboardView();
              if (dashboardView) {
                dashboardView.refresh();
              }

              this.close();
              confirmModal.close();
              new Notice(t("modal.feedManager.deletedAll"));
            }),
        );

      confirmModal.open();
    };
  }

  onClose() {
    this.contentEl?.empty();
  }
}
