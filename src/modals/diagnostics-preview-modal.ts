import { App, Modal } from "obsidian";
import { createTranslator, type Locale } from "../i18n";

export interface DiagnosticsPreviewModalOptions {
  locale: Locale;
  kind?: "diagnostics" | "operation-journal";
  preview: Readonly<{ token: string; text: string }>;
  copyPreview(token: string, preview: string): Promise<void> | void;
  revokePreview(token: string): void;
}

export class DiagnosticsPreviewModal extends Modal {
  private copyStarted = false;
  private previewRevoked = false;
  private lifecycleGeneration = 0;

  constructor(app: App, private readonly options: DiagnosticsPreviewModalOptions) {
    super(app);
  }

  override onOpen(): void {
    const generation = ++this.lifecycleGeneration;
    this.copyStarted = false;
    this.previewRevoked = false;
    const t = createTranslator(this.options.locale);
    const isJournal = this.options.kind === "operation-journal";
    this.contentEl.empty();
    this.modalEl.addClass("rss-dashboard-modal");
    this.contentEl.createEl("h2", {
      text: t(
        isJournal
          ? "operationJournal.preview.title"
          : "diagnostics.preview.title",
      ),
    });
    this.contentEl.createEl("p", {
      text: t(
        isJournal
          ? "operationJournal.preview.desc"
          : "diagnostics.preview.desc",
      ),
    });
    this.contentEl.createEl("pre", {
      cls: "rss-dashboard-diagnostics-preview",
      text: this.options.preview.text,
      attr: { tabindex: "0" },
    });
    const controls = this.contentEl.createDiv({
      cls: "rss-dashboard-modal-buttons",
    });
    const cancel = controls.createEl("button", {
      text: t(
        isJournal
          ? "operationJournal.preview.cancel"
          : "diagnostics.preview.cancel",
      ),
    });
    const copy = controls.createEl("button", {
      text: t(
        isJournal
          ? "operationJournal.preview.copy"
          : "diagnostics.preview.copy",
      ),
      cls: "mod-cta",
    });
    cancel.addEventListener("click", () => this.close());
    copy.addEventListener("click", () => {
      if (this.copyStarted) return;
      this.copyStarted = true;
      copy.disabled = true;
      cancel.disabled = true;
      void Promise.resolve()
        .then(() =>
          this.options.copyPreview(
          this.options.preview.token,
          this.options.preview.text,
          ),
        )
        .catch(() => undefined)
        .finally(() => {
          if (this.lifecycleGeneration === generation) this.close();
        });
    });
  }

  override onClose(): void {
    this.lifecycleGeneration += 1;
    if (!this.previewRevoked) {
      this.previewRevoked = true;
      try {
        this.options.revokePreview(this.options.preview.token);
      } catch {
        // Closing must remain safe even when a dependency is unavailable.
      }
    }
    this.contentEl.empty();
  }
}
