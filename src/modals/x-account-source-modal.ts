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
  existingRetention?: Readonly<{
    autoDeleteDuration: number;
    maxItemsLimit: number;
  }>;
  maxRequestsPerRun: number;
  maxRequestsPerDay: number;
  onSave(
    config: XAccountSourceConfig,
    retention: Readonly<{
      autoDeleteDuration: number;
      maxItemsLimit: number;
    }>,
  ): Promise<void> | void;
  /** Changed identities must return to the verified onboarding flow. */
  onIdentityChange?(normalizedHandle: string): Promise<void> | void;
  onClose?(): void;
}

export class XAccountSourceModal extends Modal {
  private lifecycleEpoch = 0;

  constructor(
    app: App,
    private readonly options: XAccountSourceModalOptions,
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
    if (this.options.existing) {
      this.modalEl.addClass("rss-dashboard-x-account-options-modal");
    }

    contentEl.createEl("h2", {
      text: t(this.options.existing
        ? "modal.xAccount.editTitle"
        : "modal.xAccount.addTitle"),
    });

    let handle = this.options.existing?.handle ?? "";
    let displayName = this.options.existing?.displayName ?? "";
    let folder = this.options.existing?.folder ?? "";
    let topics = this.options.existing?.topics.join(", ") ?? "";
    let autoDeleteDuration = this.options.existingRetention?.autoDeleteDuration ?? 0;
    let maxItemsLimit = this.options.existingRetention?.maxItemsLimit ?? 0;
    let includeReplies = this.options.existing?.includeReplies ?? false;
    let includeReposts = this.options.existing?.includeReposts ?? false;
    const fieldSetting = (): Setting => {
      const result = new Setting(contentEl);
      result.settingEl.addClass("rss-dashboard-form-field");
      return result;
    };

    fieldSetting()
      .setName(t("modal.xAccount.handle"))
      .setDesc(t("modal.xAccount.handleDesc"))
      .addText((text) => text
        .setPlaceholder(t("modal.xAccount.handlePlaceholder"))
        .setValue(handle)
        .onChange((value) => { handle = value; }));
    fieldSetting()
      .setName(t("modal.xAccount.displayName"))
      .addText((text) => {
        text.inputEl.readOnly = this.options.existing !== undefined;
        return text
          .setValue(displayName)
          .onChange((value) => { displayName = value; });
      });
    fieldSetting()
      .setName(t("modal.xAccount.folder"))
      .addText((text) => text
        .setValue(folder)
        .onChange((value) => { folder = value; }));
    fieldSetting()
      .setName(t("modal.xAccount.topics"))
      .setDesc(t("modal.xAccount.topicsDesc"))
      .addText((text) => text
        .setValue(topics)
        .onChange((value) => { topics = value; }));
    fieldSetting()
      .setName(t("modal.xAccount.autoDelete"))
      .setDesc(t("modal.feed.autoDeleteDesc"))
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "0";
        return text
          .setValue(String(autoDeleteDuration))
          .onChange((value) => {
            autoDeleteDuration = nonNegativeInteger(value);
          });
      });
    fieldSetting()
      .setName(t("modal.xAccount.maxItems"))
      .setDesc(t("modal.feed.maxItemsDesc"))
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "0";
        return text
          .setValue(String(maxItemsLimit))
          .onChange((value) => {
            maxItemsLimit = nonNegativeInteger(value);
          });
      });

    const estimateEl = contentEl.createEl("p", {
      cls: "rss-dashboard-request-estimate",
    });
    const updateEstimate = (): void => {
      estimateEl.setText(t("settings.tikhub.estimatedRefreshRequests", {
        count: includeReplies ? 2 : 1,
      }));
    };

    fieldSetting()
      .setName(t("modal.xAccount.includeReplies"))
      .setDesc(t("modal.xAccount.repliesWarning"))
      .addToggle((toggle) => toggle
        .setValue(includeReplies)
        .onChange((value) => {
          includeReplies = value;
          updateEstimate();
        }));
    fieldSetting()
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
              if (
                this.options.existing &&
                normalizedHandle !== this.options.existing.handle
              ) {
                await this.options.onIdentityChange?.(normalizedHandle);
                if (isCurrent()) this.close();
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
              await this.options.onSave(config, {
                autoDeleteDuration,
                maxItemsLimit,
              });
              if (isCurrent()) this.close();
            } catch {
              if (isCurrent()) errorEl.setText(t("modal.xAccount.saveFailed"));
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

function nonNegativeInteger(value: string): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}
