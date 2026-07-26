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
  onClose?(): void;
}

export class XTopicSourceModal extends Modal {
  private lifecycleEpoch = 0;

  constructor(
    app: App,
    private readonly options: XTopicSourceModalOptions,
  ) {
    super(app);
  }

  onOpen(): void {
    const lifecycleToken = ++this.lifecycleEpoch;
    const t = createTranslator(this.options.locale ?? "zh-CN");
    const { contentEl } = this;
    contentEl.empty();
    this.modalEl.addClass("rss-dashboard-modal");
    this.modalEl.addClass("rss-dashboard-form-modal");

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
    const fieldSetting = (): Setting => {
      const result = new Setting(contentEl);
      result.settingEl.addClass("rss-dashboard-form-field");
      return result;
    };

    fieldSetting()
      .setName(t("modal.xTopic.name"))
      .addText((text) => text
        .setValue(name)
        .onChange((value) => { name = value; }));
    fieldSetting()
      .setName(t("modal.xTopic.includeKeywords"))
      .setDesc(t("modal.xTopic.listDesc"))
      .addText((text) => text
        .setValue(includeKeywords)
        .onChange((value) => { includeKeywords = value; }));
    fieldSetting()
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
    fieldSetting()
      .setName(t("modal.xTopic.priorityAccounts"))
      .setDesc(t("modal.xTopic.priorityAccountsDesc"))
      .addText((text) => text
        .setValue(priorityAccounts)
        .onChange((value) => {
          priorityAccounts = value;
          updateEstimate();
        }));
    fieldSetting()
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
    fieldSetting()
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
    errorEl.setAttribute("role", "alert");
    errorEl.setAttribute("aria-live", "polite");

    let inFlight = false;
    let cancelButtonEl: HTMLButtonElement | undefined;
    let saveButtonEl: HTMLButtonElement | undefined;
    const isCurrent = (): boolean =>
      this.lifecycleEpoch === lifecycleToken && contentEl.isConnected;
    const setBusy = (busy: boolean): void => {
      for (const buttonEl of [cancelButtonEl, saveButtonEl]) {
        if (!buttonEl) continue;
        buttonEl.disabled = busy;
        buttonEl.setAttribute("aria-disabled", String(busy));
      }
    };

    const actionSetting = new Setting(contentEl);
    actionSetting.settingEl.addClass("rss-dashboard-form-actions");
    actionSetting
      .addButton((button) => {
        cancelButtonEl = button.buttonEl;
        button
          .setButtonText(t("common.cancel"))
          .onClick(() => {
            if (!inFlight) this.close();
          });
      })
      .addButton((button) => {
        saveButtonEl = button.buttonEl;
        button
          .setButtonText(t("common.save"))
          .setCta()
          .onClick(() => {
            if (inFlight || !isCurrent()) return;
            inFlight = true;
            setBusy(true);
            void (async () => {
            try {
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
              await this.options.onSave(config);
              if (isCurrent()) this.close();
            } catch {
              if (isCurrent()) errorEl.setText(t("modal.xTopic.saveFailed"));
            } finally {
              if (isCurrent()) {
                inFlight = false;
                setBusy(false);
              }
            }
            })();
          });
      });
  }

  onClose(): void {
    this.lifecycleEpoch += 1;
    try {
      this.contentEl.empty();
    } finally {
      this.options.onClose?.();
    }
  }
}

function splitList(value: string): string[] {
  return value.split(/[\n,]/u).map((entry) => entry.trim()).filter(Boolean);
}
