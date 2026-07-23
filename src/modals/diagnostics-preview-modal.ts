import { App, Modal } from "obsidian";
import { createTranslator, type Locale } from "../i18n";

export interface DiagnosticsPreviewModalOptions {
  locale: Locale;
  preview: Readonly<{ token: string; text: string }>;
  copyPreview(token: string, preview: string): Promise<void> | void;
  revokePreview(token: string): void;
}

export class DiagnosticsPreviewModal extends Modal {
  private copyStarted = false;
  private previewRevoked = false;

  constructor(app: App, private readonly options: DiagnosticsPreviewModalOptions) {
    super(app);
  }

  override onOpen(): void {
    this.copyStarted = false;
    this.previewRevoked = false;
    const t = createTranslator(this.options.locale);
    this.contentEl.empty();
    this.modalEl.addClass("rss-dashboard-modal");
    this.contentEl.createEl("h2", { text: t("diagnostics.preview.title") });
    this.contentEl.createEl("p", { text: t("diagnostics.preview.desc") });
    this.contentEl.createEl("pre", {
      cls: "rss-dashboard-diagnostics-preview",
      text: this.options.preview.text,
      attr: { tabindex: "0" },
    });
    const controls = this.contentEl.createDiv({
      cls: "rss-dashboard-modal-buttons",
    });
    const cancel = controls.createEl("button", {
      text: t("diagnostics.preview.cancel"),
    });
    const copy = controls.createEl("button", {
      text: t("diagnostics.preview.copy"),
      cls: "mod-cta",
    });
    cancel.addEventListener("click", () => this.close());
    copy.addEventListener("click", () => {
      if (this.copyStarted) return;
      this.copyStarted = true;
      copy.disabled = true;
      cancel.disabled = true;
      void Promise.resolve(
        this.options.copyPreview(
          this.options.preview.token,
          this.options.preview.text,
        ),
      ).finally(() => this.close());
    });
  }

  override onClose(): void {
    if (!this.previewRevoked) {
      this.previewRevoked = true;
      this.options.revokePreview(this.options.preview.token);
    }
    this.contentEl.empty();
  }
}
