import { Notice } from "obsidian";
import type { PortableDataBundle, RssDashboardSettings } from "../types/types";
import { OpmlManager } from "./opml-manager";
import { createTranslator, type Locale, type Translator } from "../i18n";
import {
  exportBlob,
  copyTextToClipboard,
  type ExportBlobResult,
} from "../utils/export-utils";

/**
 * Service for import/export functionality: JSON settings, OPML feeds, and clipboard operations.
 * Extracted from RssDashboardPlugin to allow isolated testing.
 */
export class ImportExportService {
  private settings: RssDashboardSettings;
  private isMobile: boolean;
  private getPortableDataBundle?: () => PortableDataBundle;
  private importPortableDataBundle?: (bundle: unknown) => Promise<void>;
  private readonly getLocale: () => Locale;

  constructor(options: {
    settings: RssDashboardSettings;
    isMobile: boolean;
    getPortableDataBundle?: () => PortableDataBundle;
    importPortableDataBundle?: (bundle: unknown) => Promise<void>;
    getLocale?: () => Locale;
    /** Legacy fixed-locale option retained for direct integration compatibility. */
    locale?: Locale;
  }) {
    this.settings = options.settings;
    this.isMobile = options.isMobile;
    this.getPortableDataBundle = options.getPortableDataBundle;
    this.importPortableDataBundle = options.importPortableDataBundle;
    this.getLocale = options.getLocale ?? (() => options.locale ?? "en");
  }

  private t(
    key: Parameters<Translator>[0],
    params?: Parameters<Translator>[1],
  ): string {
    return createTranslator(this.getLocale())(key, params);
  }

  getUserSettingsJson(): string {
    const {
      feeds: _feeds,
      folders: _folders,
      availableTags: _availableTags,
      ...settingsOnly
    } = this.settings;
    return JSON.stringify(settingsOnly, null, 2);
  }

  async exportUserSettingsJson(): Promise<void> {
    const filename = "usersettings.json";
    const blob = new Blob([this.getUserSettingsJson()], {
      type: "application/json",
    });
    const result = await exportBlob({
      blob,
      filename,
      isMobile: this.isMobile,
    });
    this.showExportNotice(result, filename);
  }

  async exportDataJson(): Promise<void> {
    const filename = "data.json";
    const blob = new Blob([JSON.stringify(this.settings, null, 2)], {
      type: "application/json",
    });
    const result = await exportBlob({
      blob,
      filename,
      isMobile: this.isMobile,
    });
    this.showExportNotice(result, filename);
  }

  async exportOpml(): Promise<void> {
    const opmlContent = OpmlManager.generateOpml(
      this.settings.feeds,
      this.settings.folders,
    );
    const filename = "feeds.opml";
    const blob = new Blob([opmlContent], { type: "text/xml" });
    const result = await exportBlob({
      blob,
      filename,
      isMobile: this.isMobile,
    });
    this.showExportNotice(result, filename);
  }

  async exportPortableDataBundle(): Promise<void> {
    const filename = "rss-dashboard-portable-bundle.json";
    const bundle = this.getPortableDataBundle?.();
    const blob = new Blob(
      [JSON.stringify(bundle ?? { settings: this.settings }, null, 2)],
      {
        type: "application/json",
      },
    );
    const result = await exportBlob({
      blob,
      filename,
      isMobile: this.isMobile,
    });
    this.showExportNotice(result, filename);
  }

  async importPortableDataBundleFromFile(file: File): Promise<void> {
    const text = await file.text();
    let parsed: unknown;

    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(
        `Invalid portable bundle JSON${error instanceof Error ? `: ${error.message}` : ""}`,
      );
    }

    if (!this.importPortableDataBundle) {
      throw new Error(
        "Portable bundle import is not available in this context",
      );
    }

    await this.importPortableDataBundle(parsed);
    new Notice(this.t("service.import.portableImported"));
  }

  public showExportNotice(result: ExportBlobResult, filename: string): void {
    if (result === "downloaded") {
      new Notice(this.t("service.import.downloading", { filename }));
      return;
    }
    if (result === "shared" || result === "opened") {
      new Notice(this.t("service.import.openedSaveMenu", { filename }));
      return;
    }
    if (result === "canceled") {
      new Notice(this.t("service.import.canceled"));
      return;
    }
    new Notice(this.t("service.import.exportFailed", { filename }));
  }

  async copyDataJsonToClipboard(): Promise<void> {
    const filename = "data.json";
    const result = await copyTextToClipboard(
      JSON.stringify(this.settings, null, 2),
    );
    this.showCopyNotice(result, filename);
  }

  async copyUserSettingsJsonToClipboard(): Promise<void> {
    const filename = "usersettings.json";
    const result = await copyTextToClipboard(this.getUserSettingsJson());
    this.showCopyNotice(result, filename);
  }

  async copyOpmlToClipboard(): Promise<void> {
    const filename = "feeds.opml";
    const opmlContent = OpmlManager.generateOpml(
      this.settings.feeds,
      this.settings.folders,
    );
    const result = await copyTextToClipboard(opmlContent);
    this.showCopyNotice(result, filename);
  }

  public showCopyNotice(result: "copied" | "failed", filename: string): void {
    if (result === "copied") {
      new Notice(this.t("service.import.copied", { filename }));
      return;
    }
    new Notice(this.t("service.import.copyFailed", { filename }));
  }
}
