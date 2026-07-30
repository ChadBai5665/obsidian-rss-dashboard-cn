import { App, Modal } from "obsidian";
import { createTranslator, type Locale } from "../i18n";

export interface OperationJournalClearModalOptions {
  readonly locale: Locale;
  clear(): Promise<void>;
  onCleared(): Promise<void> | void;
}

export class OperationJournalClearModal extends Modal {
  private pending = false;
  private disposed = true;
  private generation = 0;

  constructor(
    app: App,
    private readonly options: OperationJournalClearModalOptions,
  ) {
    super(app);
  }

  override onOpen(): void {
    const generation = ++this.generation;
    this.pending = false;
    this.disposed = false;
    const t = createTranslator(this.options.locale);
    this.contentEl.empty();
    this.modalEl.addClass("rss-dashboard-modal");

    this.contentEl.createEl("h2", {
      text: t("operationJournal.clearModal.title"),
    });
    this.contentEl.createEl("p", {
      text: t("operationJournal.clearModal.desc"),
    });
    const preserved = this.contentEl.createEl("ul");
    const preservedKeys = [
      "operationJournal.clearModal.preserveConfiguration",
      "operationJournal.clearModal.preserveKeys",
      "operationJournal.clearModal.preserveSubscriptions",
      "operationJournal.clearModal.preserveTranscripts",
      "operationJournal.clearModal.preserveCollection",
      "operationJournal.clearModal.preserveAnalyses",
      "operationJournal.clearModal.preserveMarkdown",
    ] as const;
    for (const key of preservedKeys) {
      preserved.createEl("li", { text: t(key) });
    }

    const failure = this.contentEl.createEl("p", {
      text: t("operationJournal.clearModal.failed"),
      cls: "mod-warning",
    });
    failure.hidden = true;

    const controls = this.contentEl.createDiv({
      cls: "rss-dashboard-modal-buttons",
    });
    const cancel = controls.createEl("button", {
      text: t("operationJournal.clearModal.cancel"),
      attr: { type: "button" },
    });
    const confirm = controls.createEl("button", {
      text: t("operationJournal.clearModal.confirm"),
      cls: "mod-warning",
      attr: { type: "button" },
    });

    cancel.addEventListener("click", () => {
      if (!this.pending) this.close();
    });
    confirm.addEventListener("click", () => {
      if (this.pending || this.disposed) return;
      this.pending = true;
      cancel.disabled = true;
      confirm.disabled = true;
      failure.hidden = true;

      void Promise.resolve()
        .then(() => this.options.clear())
        .then(() => {
          if (!this.disposed && this.generation === generation) this.close();
          try {
            void Promise.resolve(this.options.onCleared()).catch(
              () => undefined,
            );
          } catch {
            // Clearing already succeeded; a refresh failure stays contained.
          }
        })
        .catch(() => {
          if (this.disposed || this.generation !== generation) return;
          this.pending = false;
          cancel.disabled = false;
          confirm.disabled = false;
          failure.hidden = false;
        });
    });
  }

  override onClose(): void {
    this.disposed = true;
    this.generation += 1;
    this.contentEl.empty();
  }
}
