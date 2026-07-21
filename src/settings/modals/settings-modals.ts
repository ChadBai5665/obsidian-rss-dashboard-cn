/**
 * Shared modal classes used by the RSS Dashboard settings tabs.
 *
 * Extracted from settings-tab.ts to break the monolith.
 * Imports are kept minimal — only Obsidian core + platform utils.
 */
import { App, Modal, Setting, TextComponent } from "obsidian";
import {
  setCssProps,
  shouldUseMobileSidebarLayout,
} from "../../utils/platform-utils";
import { createTranslator, type Locale } from "../../i18n";

// ── TemplateNameModal ───────────────────────────────────────────────────────

export class TemplateNameModal extends Modal {
  private result: string | null = null;
  private resolvePromise: ((value: string | null) => void) | null = null;

  constructor(app: App, private readonly locale: Locale = "zh-CN") {
    super(app);
  }

  onOpen() {
    const t = createTranslator(this.locale);
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: t("settings.modal.saveTemplate") });
    contentEl.createEl("p", { text: t("settings.modal.saveTemplateDesc") });

    let inputComponent: TextComponent;
    new Setting(contentEl).setName(t("settings.modal.templateName")).addText((text) => {
      inputComponent = text;
      text.setPlaceholder(t("settings.modal.templatePlaceholder"));
      text.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this.result = text.getValue().trim() || null;
          this.close();
        }
      });
    });

    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText(t("common.cancel")).onClick(() => {
          this.result = null;
          this.close();
        }),
      )
      .addButton((btn) =>
        btn
          .setButtonText(t("common.save"))
          .setCta()
          .onClick(() => {
            this.result = inputComponent.getValue().trim() || null;
            this.close();
          }),
      );

    window.setTimeout(() => {
      inputComponent.inputEl.focus();
    }, 50);
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
    if (this.resolvePromise) {
      this.resolvePromise(this.result);
    }
  }

  waitForClose(): Promise<string | null> {
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
    });
  }
}

// ── HighlightWordEditModal ──────────────────────────────────────────────────

export class HighlightWordEditModal extends Modal {
  private value: string;
  private result: string | null = null;
  private resolvePromise: ((value: string | null) => void) | null = null;

  constructor(
    app: App,
    initialValue: string,
    private readonly locale: Locale = "zh-CN",
  ) {
    super(app);
    this.value = initialValue;
  }

  onOpen() {
    const t = createTranslator(this.locale);
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: t("settings.modal.editHighlight") });

    let inputComponent: TextComponent;
    new Setting(contentEl).setName(t("settings.modal.wordOrPhrase")).addText((text) => {
      inputComponent = text;
      text.setValue(this.value);
      text.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this.result = text.getValue();
          this.close();
        }
      });
    });

    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText(t("common.cancel")).onClick(() => {
          this.result = null;
          this.close();
        }),
      )
      .addButton((btn) =>
        btn
          .setButtonText(t("common.save"))
          .setCta()
          .onClick(() => {
            this.result = inputComponent.getValue();
            this.close();
          }),
      );

    window.setTimeout(() => {
      inputComponent.inputEl.focus();
      inputComponent.inputEl.select();
    }, 50);
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
    if (this.resolvePromise) {
      this.resolvePromise(this.result);
    }
  }

  waitForClose(): Promise<string | null> {
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
    });
  }
}

// ── ConfirmDeleteModal ──────────────────────────────────────────────────────

export class ConfirmDeleteModal extends Modal {
  private targetLabel: string;
  private confirmed = false;
  private resolvePromise: ((value: boolean) => void) | null = null;

  constructor(
    app: App,
    targetLabel: string,
    private readonly locale: Locale = "zh-CN",
  ) {
    super(app);
    this.targetLabel = targetLabel;
  }

  onOpen() {
    const t = createTranslator(this.locale);
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: t("settings.modal.deleteHighlight") });
    contentEl.createEl("p", {
      text: t("settings.modal.deleteHighlightDesc", { label: this.targetLabel }),
    });

    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText(t("common.cancel")).onClick(() => {
          this.confirmed = false;
          this.close();
        }),
      )
      .addButton((btn) =>
        btn
          .setButtonText(t("common.delete"))
          .setWarning()
          .onClick(() => {
            this.confirmed = true;
            this.close();
          }),
      );
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
    if (this.resolvePromise) {
      this.resolvePromise(this.confirmed);
    }
  }

  waitForClose(): Promise<boolean> {
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
    });
  }
}

// ── FactoryResetConfirmModal ────────────────────────────────────────────────

export class FactoryResetConfirmModal extends Modal {
  private confirmed = false;
  private resolvePromise: ((value: boolean) => void) | null = null;

  constructor(app: App, private readonly locale: Locale = "zh-CN") {
    super(app);
  }

  onOpen() {
    const t = createTranslator(this.locale);
    const { contentEl } = this;
    contentEl.empty();

    this.modalEl.addClass("rss-dashboard-modal");
    this.modalEl.addClass("rss-dashboard-modal-container");

    contentEl.createEl("h2", { text: t("settings.modal.factoryReset") });
    contentEl.createEl("p", {
      text: t("settings.modal.factoryResetDesc"),
    });
    contentEl.createEl("p", {
      text: t("settings.modal.factoryResetSavedNotes"),
    });

    const buttonsSetting = new Setting(contentEl);
    buttonsSetting.controlEl.addClass("rss-dashboard-modal-buttons");
    buttonsSetting
      .addButton((btn) =>
        btn
          .setButtonText(t("common.cancel"))
          .onClick(() => {
            this.confirmed = false;
            this.close();
          }),
      )
      .addButton((btn) =>
        btn
          .setButtonText(t("settings.modal.factoryReset"))
          .setWarning()
          .onClick(() => {
            this.confirmed = true;
            this.close();
          }),
      );
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
    this.resolvePromise?.(this.confirmed);
  }

  waitForClose(): Promise<boolean> {
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
    });
  }
}

// ── ApplyMaxItemsToExistingFeedsModal ───────────────────────────────────────

export type ApplyMaxItemsAction = "cancel" | "apply" | "apply-refresh";

export class ApplyMaxItemsToExistingFeedsModal extends Modal {
  private readonly newLimit: number;
  private readonly increased: boolean;
  private action: ApplyMaxItemsAction = "cancel";
  private resolvePromise: ((value: ApplyMaxItemsAction) => void) | null = null;

  constructor(
    app: App,
    options: { newLimit: number; increased: boolean },
    private readonly locale: Locale = "zh-CN",
  ) {
    super(app);
    this.newLimit = options.newLimit;
    this.increased = options.increased;
  }

  onOpen() {
    const t = createTranslator(this.locale);
    const { contentEl } = this;
    contentEl.empty();

    const isMobile = shouldUseMobileSidebarLayout();
    this.modalEl.addClass("rss-dashboard-modal");
    this.modalEl.addClass("rss-dashboard-modal-container");
    if (isMobile) {
      this.modalEl.addClass("rss-mobile-apply-max-items-modal");
    }

    contentEl.createEl("h2", { text: t("settings.modal.applyMaxTitle") });
    contentEl.createEl("p", {
      text: t("settings.modal.applyMaxDesc", { count: this.newLimit }),
    });
    if (this.increased) {
      contentEl.createEl("p", {
        text: t("settings.modal.applyMaxWarning"),
      });
    }

    const buttonsSetting = new Setting(contentEl);
    buttonsSetting.controlEl.addClass("rss-max-items-apply-buttons");
    if (isMobile) {
      setCssProps(buttonsSetting.controlEl, {
        "flex-direction": "column",
        "align-items": "stretch",
        gap: "8px",
      });
    }
    buttonsSetting
      .addButton((btn) => {
        btn.setButtonText(t("common.cancel"));
        if (isMobile) setCssProps(btn.buttonEl, { width: "100%" });
        btn.onClick(() => {
          this.action = "cancel";
          this.close();
        });
      })
      .addButton((btn) => {
        btn.setButtonText(t("settings.modal.applyAll")).setWarning();
        if (isMobile) setCssProps(btn.buttonEl, { width: "100%" });
        btn.onClick(() => {
          this.action = "apply";
          this.close();
        });
      })
      .addButton((btn) => {
        btn.setButtonText(t("settings.modal.applyRefresh")).setWarning();
        if (isMobile) setCssProps(btn.buttonEl, { width: "100%" });
        btn.onClick(() => {
          this.action = "apply-refresh";
          this.close();
        });
      });
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
    this.resolvePromise?.(this.action);
  }

  waitForClose(): Promise<ApplyMaxItemsAction> {
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
    });
  }
}
