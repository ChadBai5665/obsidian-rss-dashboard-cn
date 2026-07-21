import { Modal, App, Setting, Notice } from "obsidian";
import type RssDashboardPlugin from "../../main";
import { createTranslator } from "../i18n";

/**
 * Shown on every plugin load when the user's storage mode is not vault-shards-v2
 * and they have not permanently dismissed the prompt.
 *
 * Buttons:
 *  - "Upgrade Now" — backs up data, migrates to v2, sets dismissed flag
 *  - "Remind Me Later" — closes with no flag change (shows again next load)
 *  - "Never Show Again" — sets dismissed flag permanently, no migration
 */
export class StorageMigrationModal extends Modal {
  private plugin: RssDashboardPlugin;

  constructor(app: App, plugin: RssDashboardPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const t = createTranslator(this.plugin.settings.locale ?? "zh-CN");
    const { contentEl } = this;
    contentEl.empty();

    this.modalEl.addClass("rss-dashboard-modal");
    this.modalEl.addClass("rss-dashboard-modal-container");

    new Setting(contentEl)
      .setName(t("modal.storageMigration.title"))
      .setHeading();

    contentEl.createEl("p", {
      text: t("modal.storageMigration.desc", {
        mode: this.plugin.settings.storageMode,
      }),
      cls: "rss-dashboard-modal-message",
    });

    contentEl.createEl("p", {
      text: t("modal.storageMigration.backup"),
      cls: "rss-dashboard-modal-message",
    });

    const buttonContainer = contentEl.createDiv({
      cls: "rss-dashboard-modal-buttons",
    });

    // "Never Show Again" — leftmost, lowest priority
    const neverButton = buttonContainer.createEl("button", {
      text: t("modal.storageMigration.never"),
    });
    neverButton.onclick = async () => {
      this.plugin.settings.storageMigrationDismissedPermanently = true;
      await this.plugin.saveSettings();
      this.close();
    };

    // "Remind Me Later" — middle, stateless dismiss
    const laterButton = buttonContainer.createEl("button", {
      text: t("modal.storageMigration.later"),
    });
    laterButton.onclick = () => {
      // No flag set — modal will appear again next plugin load
      this.close();
    };

    // "Upgrade Now" — rightmost CTA
    const upgradeButton = buttonContainer.createEl("button", {
      text: t("modal.storageMigration.upgrade"),
      cls: "mod-cta",
    });
    upgradeButton.onclick = async () => {
      upgradeButton.disabled = true;
      laterButton.disabled = true;
      neverButton.disabled = true;
      upgradeButton.textContent = t("modal.storageMigration.upgrading");

      try {
        await this.plugin.backupAndMigrateStorageToV2();
        new Notice(t("modal.storageMigration.success"));
      } catch (error) {
        console.error("Migration failed:", error);
        new Notice(t("modal.storageMigration.failed"));
      } finally {
        this.close();
      }
    };
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
