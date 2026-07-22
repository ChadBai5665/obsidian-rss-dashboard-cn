import { App, Modal, Setting } from "obsidian";
import { createTranslator, type Locale } from "../i18n";
import {
  createXAccountSourceConfig,
  normalizeXHandle,
  type XAccountSourceConfig,
} from "../sources/source-config";

export interface XAccountSourceModalOptions {
  locale?: Locale;
  existing?: XAccountSourceConfig;
  existingAccounts: readonly XAccountSourceConfig[];
  maxRequestsPerRun: number;
  maxRequestsPerDay: number;
  onSave(config: XAccountSourceConfig): Promise<void> | void;
}

export class XAccountSourceModal extends Modal {
  constructor(
    app: App,
    private readonly options: XAccountSourceModalOptions,
  ) {
    super(app);
  }

  onOpen(): void {
    const t = createTranslator(this.options.locale ?? "zh-CN");
    const { contentEl } = this;
    contentEl.empty();
    this.modalEl.addClass("rss-dashboard-modal");

    contentEl.createEl("h2", {
      text: t(this.options.existing
        ? "modal.xAccount.editTitle"
        : "modal.xAccount.addTitle"),
    });

    let handle = this.options.existing?.handle ?? "";
    let displayName = this.options.existing?.displayName ?? "";
    let folder = this.options.existing?.folder ?? "";
    let topics = this.options.existing?.topics.join(", ") ?? "";
    let includeReplies = this.options.existing?.includeReplies ?? false;
    let includeReposts = this.options.existing?.includeReposts ?? false;

    new Setting(contentEl)
      .setName(t("modal.xAccount.handle"))
      .setDesc(t("modal.xAccount.handleDesc"))
      .addText((text) => text
        .setPlaceholder(t("modal.xAccount.handlePlaceholder"))
        .setValue(handle)
        .onChange((value) => { handle = value; }));
    new Setting(contentEl)
      .setName(t("modal.xAccount.displayName"))
      .addText((text) => text
        .setValue(displayName)
        .onChange((value) => { displayName = value; }));
    new Setting(contentEl)
      .setName(t("modal.xAccount.folder"))
      .addText((text) => text
        .setValue(folder)
        .onChange((value) => { folder = value; }));
    new Setting(contentEl)
      .setName(t("modal.xAccount.topics"))
      .setDesc(t("modal.xAccount.topicsDesc"))
      .addText((text) => text
        .setValue(topics)
        .onChange((value) => { topics = value; }));

    const estimateEl = contentEl.createEl("p", {
      cls: "rss-dashboard-request-estimate",
    });
    const updateEstimate = (): void => {
      estimateEl.setText(t("settings.tikhub.estimatedRefreshRequests", {
        count: includeReplies ? 2 : 1,
      }));
    };

    new Setting(contentEl)
      .setName(t("modal.xAccount.includeReplies"))
      .setDesc(t("modal.xAccount.repliesWarning"))
      .addToggle((toggle) => toggle
        .setValue(includeReplies)
        .onChange((value) => {
          includeReplies = value;
          updateEstimate();
        }));
    new Setting(contentEl)
      .setName(t("modal.xAccount.includeReposts"))
      .setDesc(t("modal.xAccount.repostsDesc"))
      .addToggle((toggle) => toggle
        .setValue(includeReposts)
        .onChange((value) => { includeReposts = value; }));

    updateEstimate();
    contentEl.createEl("p", {
      text: t("settings.tikhub.requestCaps", {
        run: this.options.maxRequestsPerRun,
        day: this.options.maxRequestsPerDay,
      }),
      cls: "rss-dashboard-request-caps",
    });
    const errorEl = contentEl.createEl("p", {
      cls: "rss-dashboard-validation-error",
    });

    new Setting(contentEl)
      .addButton((button) => button
        .setButtonText(t("common.cancel"))
        .onClick(() => this.close()))
      .addButton((button) => button
        .setButtonText(t("common.save"))
        .setCta()
        .onClick(() => {
          void (async () => {
            errorEl.setText("");
            const normalizedHandle = normalizeXHandle(handle);
            if (!normalizedHandle) {
              errorEl.setText(t("modal.xAccount.invalidHandle"));
              return;
            }
            const duplicate = this.options.existingAccounts.some((account) =>
              account.id !== this.options.existing?.id &&
              account.handle === normalizedHandle,
            );
            if (duplicate) {
              errorEl.setText(t("modal.xAccount.duplicate"));
              return;
            }

            let config: XAccountSourceConfig;
            try {
              config = createXAccountSourceConfig({
                id: this.options.existing?.id,
                handle: normalizedHandle,
                displayName,
                includeReplies,
                includeReposts,
                folder,
                topics: splitList(topics),
              });
            } catch {
              errorEl.setText(t("modal.xAccount.invalidHandle"));
              return;
            }
            try {
              await this.options.onSave(config);
              this.close();
            } catch {
              errorEl.setText(t("modal.xAccount.saveFailed"));
            }
          })();
        }));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function splitList(value: string): string[] {
  return value.split(/[\n,]/u).map((entry) => entry.trim()).filter(Boolean);
}
