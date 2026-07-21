import { Modal, App, Setting } from "obsidian";
import { createTranslator, type Locale } from "../i18n";

/**
 * A simple confirmation modal shown after a successful data import.
 */
export class ImportSuccessModal extends Modal {
  private message: string;

  constructor(app: App, message: string, private locale: Locale = "zh-CN") {
    super(app);
    this.message = message;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    this.modalEl.addClass("rss-dashboard-modal");
    this.modalEl.addClass("rss-dashboard-modal-container");

    const t = createTranslator(this.locale);
    new Setting(contentEl).setName(t("modal.importSuccess.title")).setHeading();

    contentEl.createEl("p", {
      text: this.message,
      cls: "rss-dashboard-modal-message",
    });

    const buttonContainer = contentEl.createDiv({
      cls: "rss-dashboard-modal-buttons",
    });

    const okButton = buttonContainer.createEl("button", {
      text: t("common.ok"),
      cls: "rss-dashboard-primary-button",
    });
    okButton.onclick = () => this.close();
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
