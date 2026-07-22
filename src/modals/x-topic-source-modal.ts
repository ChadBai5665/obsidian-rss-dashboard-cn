import { App, Modal, Setting } from "obsidian";
import { createTranslator, type Locale } from "../i18n";
import {
  createXTopicSourceConfig,
  normalizeXHandle,
  type XTopicSourceConfig,
} from "../sources/source-config";
import { buildXTopicSearchPlan } from "../sources/tikhub/x-search-query";

const WINDOW_DAYS = [1, 3, 7, 14, 30] as const;

export interface XTopicSourceModalOptions {
  locale?: Locale;
  existing?: XTopicSourceConfig;
  existingTopics: readonly XTopicSourceConfig[];
  maxRequestsPerRun: number;
  maxRequestsPerDay: number;
  onSave(config: XTopicSourceConfig): Promise<void> | void;
}

export class XTopicSourceModal extends Modal {
  constructor(
    app: App,
    private readonly options: XTopicSourceModalOptions,
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
        ? "modal.xTopic.editTitle"
        : "modal.xTopic.addTitle"),
    });
    let name = this.options.existing?.name ?? "";
    let includeKeywords = this.options.existing?.includeKeywords.join(", ") ?? "";
    let excludeKeywords = this.options.existing?.excludeKeywords.join(", ") ?? "";
    let priorityAccounts = this.options.existing?.priorityAccounts.join(", ") ?? "";
    let folder = this.options.existing?.folder ?? "";
    let windowDays: XTopicSourceConfig["windowDays"] =
      this.options.existing?.windowDays ?? 7;

    new Setting(contentEl)
      .setName(t("modal.xTopic.name"))
      .addText((text) => text
        .setValue(name)
        .onChange((value) => { name = value; }));
    new Setting(contentEl)
      .setName(t("modal.xTopic.includeKeywords"))
      .setDesc(t("modal.xTopic.listDesc"))
      .addText((text) => text
        .setValue(includeKeywords)
        .onChange((value) => { includeKeywords = value; }));
    new Setting(contentEl)
      .setName(t("modal.xTopic.excludeKeywords"))
      .setDesc(t("modal.xTopic.listDesc"))
      .addText((text) => text
        .setValue(excludeKeywords)
        .onChange((value) => { excludeKeywords = value; }));

    const estimateEl = contentEl.createEl("p", {
      cls: "rss-dashboard-request-estimate",
    });
    const updateEstimate = (): void => {
      const hasPriority = splitList(priorityAccounts).some((entry) =>
        normalizeXHandle(entry) !== undefined);
      estimateEl.setText(t("settings.tikhub.estimatedRefreshRequests", {
        count: hasPriority ? 3 : 2,
      }));
    };
    new Setting(contentEl)
      .setName(t("modal.xTopic.priorityAccounts"))
      .setDesc(t("modal.xTopic.priorityAccountsDesc"))
      .addText((text) => text
        .setValue(priorityAccounts)
        .onChange((value) => {
          priorityAccounts = value;
          updateEstimate();
        }));
    new Setting(contentEl)
      .setName(t("modal.xTopic.window"))
      .addDropdown((dropdown) => {
        for (const days of WINDOW_DAYS) {
          dropdown.addOption(String(days), t("modal.xTopic.days", { count: days }));
        }
        return dropdown.setValue(String(windowDays)).onChange((value) => {
          const parsed = Number(value);
          if (WINDOW_DAYS.includes(parsed as (typeof WINDOW_DAYS)[number])) {
            windowDays = parsed as XTopicSourceConfig["windowDays"];
          }
        });
      });
    new Setting(contentEl)
      .setName(t("modal.xTopic.folder"))
      .addText((text) => text
        .setValue(folder)
        .onChange((value) => { folder = value; }));

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
            if (!name.trim()) {
              errorEl.setText(t("modal.xTopic.invalidName"));
              return;
            }
            if (splitList(includeKeywords).length === 0) {
              errorEl.setText(t("modal.xTopic.includeRequired"));
              return;
            }
            const duplicate = this.options.existingTopics.some((topic) =>
              topic.id !== this.options.existing?.id &&
              topic.name.normalize("NFC").trim().toLowerCase() ===
                name.normalize("NFC").trim().toLowerCase(),
            );
            if (duplicate) {
              errorEl.setText(t("modal.xTopic.duplicate"));
              return;
            }
            let config: XTopicSourceConfig;
            try {
              config = createXTopicSourceConfig({
                id: this.options.existing?.id,
                name,
                includeKeywords: splitList(includeKeywords),
                excludeKeywords: splitList(excludeKeywords),
                priorityAccounts: splitList(priorityAccounts),
                windowDays,
                folder,
              });
              buildXTopicSearchPlan(config, new Date());
            } catch {
              errorEl.setText(t("modal.xTopic.invalidQuery"));
              return;
            }
            try {
              await this.options.onSave(config);
              this.close();
            } catch {
              errorEl.setText(t("modal.xTopic.saveFailed"));
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
