import { App, Modal, Setting } from "obsidian";
import type { FeedStorageMode } from "../../types/types";
import { createTranslator, type Locale } from "../../i18n";

export type StorageTransitionAction =
  | "cancel"
  | "export-data-json"
  | "apply";

export type MetadataCleanupAction = "keep" | "delete";

export interface StorageTransitionOptions {
  currentMode: FeedStorageMode;
  targetMode: FeedStorageMode;
  storageFolder: string;
}

export interface MetadataCleanupOptions {
  previousLocationLabel: string;
}

export class StorageTransitionModal extends Modal {
  private readonly currentMode: FeedStorageMode;
  private readonly targetMode: FeedStorageMode;
  private readonly storageFolder: string;
  private action: StorageTransitionAction = "cancel";
  private resolvePromise: ((value: StorageTransitionAction) => void) | null =
    null;

  constructor(
    app: App,
    options: StorageTransitionOptions,
    private readonly locale: Locale = "zh-CN",
  ) {
    super(app);
    this.currentMode = options.currentMode;
    this.targetMode = options.targetMode;
    this.storageFolder = options.storageFolder;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    this.modalEl.addClass("rss-dashboard-modal");
    this.modalEl.addClass("rss-dashboard-modal-container");
    this.modalEl.addClass("rss-storage-transition-modal");

    if (this.targetMode === "legacy-json") {
      this.renderShardsToLegacyModal(contentEl);
      return;
    }

    this.renderLegacyToShardsModal(contentEl);
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.resolvePromise?.(this.action);
  }

  waitForClose(): Promise<StorageTransitionAction> {
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
    });
  }

  private renderLegacyToShardsModal(contentEl: HTMLElement): void {
    const t = createTranslator(this.locale);
    contentEl.createEl("h2", { text: t("settings.modal.storageChangeTitle") });
    if (this.currentMode === "legacy-json") {
      contentEl.createEl("p", {
        text: t("settings.modal.legacyToV1"),
      });
      contentEl.createEl("p", {
        text: t("settings.modal.backupBeforeStorage"),
      });
    } else if (this.targetMode === "vault-shards-v2") {
      contentEl.createEl("p", {
        text: t("settings.modal.upgradeV2"),
      });
    } else {
      contentEl.createEl("p", {
        text: t("settings.modal.switchV1"),
      });
    }
    contentEl.createEl("p", {
      text: t("settings.modal.shardWrittenTo", { folder: this.storageFolder }),
    });

    const buttonsSetting = new Setting(contentEl);
    buttonsSetting.controlEl.addClass("rss-dashboard-modal-buttons");
    buttonsSetting.controlEl.addClass("rss-storage-transition-buttons");
    buttonsSetting
      .addButton((btn) =>
        btn.setButtonText(t("common.cancel")).onClick(() => {
          this.action = "cancel";
          this.close();
        }),
      )
      .addButton((btn) =>
        btn.setButtonText(t("settings.modal.exportData")).onClick(() => {
          this.action = "export-data-json";
          this.close();
        }),
      )
      .addButton((btn) =>
        btn
          .setButtonText(t("settings.storage.apply"))
          .setCta()
          .onClick(() => {
            this.action = "apply";
            this.close();
          }),
      );
  }

  private renderShardsToLegacyModal(contentEl: HTMLElement): void {
    const t = createTranslator(this.locale);
    contentEl.createEl("h2", { text: t("settings.modal.storageChangeTitle") });
    contentEl.createEl("p", {
      text: t("settings.modal.v1ToLegacy"),
    });
    contentEl.createEl("p", {
      text: t("settings.modal.legacyRecoveryCopyNotice", {
        folder: this.storageFolder,
      }),
    });
    contentEl.createEl("p", {
      text: t("settings.modal.manualShardCleanupHelp"),
    });

    const buttonsSetting = new Setting(contentEl);
    buttonsSetting.controlEl.addClass("rss-dashboard-modal-buttons");
    buttonsSetting.controlEl.addClass("rss-storage-transition-buttons");
    buttonsSetting
      .addButton((btn) =>
        btn.setButtonText(t("common.cancel")).onClick(() => {
          this.action = "cancel";
          this.close();
        }),
      )
      .addButton((btn) =>
        btn
          .setButtonText(t("settings.modal.switchKeepRecoveryCopy"))
          .setCta()
          .onClick(() => {
            this.action = "apply";
            this.close();
          }),
      );
  }
}

export class MetadataCleanupModal extends Modal {
  private readonly previousLocationLabel: string;
  private action: MetadataCleanupAction = "keep";
  private resolvePromise: ((value: MetadataCleanupAction) => void) | null =
    null;

  constructor(
    app: App,
    options: MetadataCleanupOptions,
    private readonly locale: Locale = "zh-CN",
  ) {
    super(app);
    this.previousLocationLabel = options.previousLocationLabel;
  }

  onOpen(): void {
    const t = createTranslator(this.locale);
    const { contentEl } = this;
    contentEl.empty();

    this.modalEl.addClass("rss-dashboard-modal");
    this.modalEl.addClass("rss-dashboard-modal-container");

    contentEl.createEl("h2", { text: t("settings.modal.deletePreviousMetadata") });
    contentEl.createEl("p", {
      text: t("settings.modal.metadataMigrated"),
    });
    contentEl.createEl("p", {
      text: t("settings.modal.previousMetadata", { path: this.previousLocationLabel }),
    });
    contentEl.createEl("p", {
      text: t("settings.modal.metadataCleanupHelp"),
    });

    const buttonsSetting = new Setting(contentEl);
    buttonsSetting.controlEl.addClass("rss-dashboard-modal-buttons");
    buttonsSetting
      .addButton((btn) =>
        btn.setButtonText(t("settings.modal.keepPrevious")).onClick(() => {
          this.action = "keep";
          this.close();
        }),
      )
      .addButton((btn) =>
        btn
          .setButtonText(t("settings.modal.deletePrevious"))
          .setWarning()
          .onClick(() => {
            this.action = "delete";
            this.close();
          }),
      );
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.resolvePromise?.(this.action);
  }

  waitForClose(): Promise<MetadataCleanupAction> {
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
    });
  }
}
