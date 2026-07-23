import { Notice } from "obsidian";
import type {
  Feed,
  Folder,
  PortableDataBundle,
  RssDashboardSettings,
} from "../types/types";
import { OpmlManager } from "./opml-manager";
import { createTranslator, type Locale, type Translator } from "../i18n";
import {
  exportBlob,
  copyTextToClipboard,
  type ExportBlobResult,
} from "../utils/export-utils";
import {
  buildPublicPortableBundleExport,
  buildPublicSettingsExport,
  preparePublicSettingsImport,
  assertPublicSettingsJsonTextBudget,
} from "../security/public-settings-export";
import {
  stringifySafeDiagnostics,
  type SafeDiagnosticsInput,
} from "../security/safe-diagnostics";

/**
 * Service for import/export functionality: JSON settings, OPML feeds, and clipboard operations.
 * Extracted from RssDashboardPlugin to allow isolated testing.
 */
export class ImportExportService {
  private static readonly DIAGNOSTICS_PREVIEW_TTL_MS = 5 * 60_000;
  private settings: RssDashboardSettings;
  private isMobile: boolean;
  private getPortableDataBundle?: () => PortableDataBundle;
  private importPublicSettingsBundle?: (settings: unknown) => Promise<void>;
  private readonly getSafeDiagnosticsInput?: () => SafeDiagnosticsInput;
  private readonly getLocale: () => Locale;
  private readonly trustedDiagnosticsPreviews = new Map<
    string,
    { text: string; expiresAt: number }
  >();
  private readonly createDiagnosticsToken: () => string;

  constructor(options: {
    settings: RssDashboardSettings;
    isMobile: boolean;
    getPortableDataBundle?: () => PortableDataBundle;
    importPublicSettingsBundle?: (settings: unknown) => Promise<void>;
    getSafeDiagnosticsInput?: () => SafeDiagnosticsInput;
    createDiagnosticsToken?: () => string;
    getLocale?: () => Locale;
    /** Legacy fixed-locale option retained for direct integration compatibility. */
    locale?: Locale;
  }) {
    this.settings = options.settings;
    this.isMobile = options.isMobile;
    this.getPortableDataBundle = options.getPortableDataBundle;
    this.importPublicSettingsBundle = options.importPublicSettingsBundle;
    this.getSafeDiagnosticsInput = options.getSafeDiagnosticsInput;
    this.createDiagnosticsToken =
      options.createDiagnosticsToken ?? (() => activeWindow.crypto.randomUUID());
    this.getLocale = options.getLocale ?? (() => options.locale ?? "en");
  }

  private t(
    key: Parameters<Translator>[0],
    params?: Parameters<Translator>[1],
  ): string {
    return createTranslator(this.getLocale())(key, params);
  }

  getUserSettingsJson(): string {
    return JSON.stringify(
      buildPublicSettingsExport(this.settings, { includeSources: false }),
      null,
      2,
    );
  }

  async exportUserSettingsJson(): Promise<void> {
    const filename = "usersettings.json";
    try {
      const blob = new Blob([this.getUserSettingsJson()], {
        type: "application/json",
      });
      const result = await exportBlob({
        blob,
        filename,
        isMobile: this.isMobile,
      });
      this.showExportNotice(result, filename);
    } catch {
      this.showExportNotice("failed", filename);
    }
  }

  async exportDataJson(): Promise<void> {
    const filename = "data.json";
    try {
      const snapshot = buildPublicSettingsExport(this.settings, {
        includeSources: true,
      });
      const blob = new Blob([JSON.stringify(snapshot, null, 2)], {
        type: "application/json",
      });
      const result = await exportBlob({
        blob,
        filename,
        isMobile: this.isMobile,
      });
      this.showExportNotice(result, filename);
    } catch {
      this.showExportNotice("failed", filename);
    }
  }

  async exportOpml(): Promise<void> {
    const filename = "feeds.opml";
    try {
      const snapshot = buildPublicSettingsExport(this.settings, {
        includeSources: true,
      });
      const opmlContent = OpmlManager.generateOpml(
        snapshot.feeds as unknown as Feed[],
        snapshot.folders as unknown as Folder[],
      );
      const blob = new Blob([opmlContent], { type: "text/xml" });
      const result = await exportBlob({
        blob,
        filename,
        isMobile: this.isMobile,
      });
      this.showExportNotice(result, filename);
    } catch {
      this.showExportNotice("failed", filename);
    }
  }

  async exportPortableDataBundle(): Promise<void> {
    const filename = "rss-dashboard-portable-bundle.json";
    try {
      const bundle = this.getPortableDataBundle?.();
      if (!bundle) throw new Error("missing-bundle");
      const snapshot = buildPublicPortableBundleExport(bundle);
      const blob = new Blob([JSON.stringify(snapshot, null, 2)], {
        type: "application/json",
      });
      const result = await exportBlob({
        blob,
        filename,
        isMobile: this.isMobile,
      });
      this.showExportNotice(result, filename);
    } catch {
      this.showExportNotice("failed", filename);
    }
  }

  async importPortableDataBundleFromFile(file: File): Promise<void> {
    const text = await file.text();
    assertPublicSettingsJsonTextBudget(text);
    let parsed: unknown;

    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(
        `Invalid portable bundle JSON${error instanceof Error ? `: ${error.message}` : ""}`,
      );
    }

    if (!this.importPublicSettingsBundle) {
      throw new Error(
        "Portable bundle import is not available in this context",
      );
    }
    const bundle = buildPublicPortableBundleExport(parsed);
    const importedSettings = preparePublicSettingsImport(bundle.metadata, {
      includeSources: true,
    });
    await this.importPublicSettingsBundle(importedSettings);
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
    try {
      const snapshot = buildPublicSettingsExport(this.settings, {
        includeSources: true,
      });
      const result = await copyTextToClipboard(
        JSON.stringify(snapshot, null, 2),
      );
      this.showCopyNotice(result, filename);
    } catch {
      this.showCopyNotice("failed", filename);
    }
  }

  async copyUserSettingsJsonToClipboard(): Promise<void> {
    const filename = "usersettings.json";
    try {
      const result = await copyTextToClipboard(this.getUserSettingsJson());
      this.showCopyNotice(result, filename);
    } catch {
      this.showCopyNotice("failed", filename);
    }
  }

  async copyOpmlToClipboard(): Promise<void> {
    const filename = "feeds.opml";
    try {
      const snapshot = buildPublicSettingsExport(this.settings, {
        includeSources: true,
      });
      const opmlContent = OpmlManager.generateOpml(
        snapshot.feeds as unknown as Feed[],
        snapshot.folders as unknown as Folder[],
      );
      const result = await copyTextToClipboard(opmlContent);
      this.showCopyNotice(result, filename);
    } catch {
      this.showCopyNotice("failed", filename);
    }
  }

  public showCopyNotice(result: "copied" | "failed", filename: string): void {
    if (result === "copied") {
      new Notice(this.t("service.import.copied", { filename }));
      return;
    }
    new Notice(this.t("service.import.copyFailed", { filename }));
  }

  createSafeDiagnosticsPreview(): Readonly<{ token: string; text: string }> {
    if (!this.getSafeDiagnosticsInput) {
      throw new Error("Safe diagnostics are unavailable.");
    }
    const text = stringifySafeDiagnostics(this.getSafeDiagnosticsInput());
    this.revokeAllSafeDiagnosticsPreviews();
    const token = this.createDiagnosticsToken();
    if (
      typeof token !== "string" ||
      token.length === 0 ||
      token.length > 256 ||
      this.trustedDiagnosticsPreviews.has(token)
    ) {
      throw new Error("Unable to create a diagnostics preview token.");
    }
    this.trustedDiagnosticsPreviews.set(token, {
      text,
      expiresAt:
        Date.now() + ImportExportService.DIAGNOSTICS_PREVIEW_TTL_MS,
    });
    return Object.freeze({ token, text });
  }

  async copySafeDiagnosticsPreview(
    token: string,
    preview: string,
  ): Promise<void> {
    this.purgeExpiredDiagnosticsPreviews();
    const trustedPreview = this.trustedDiagnosticsPreviews.get(token);
    this.trustedDiagnosticsPreviews.delete(token);
    if (trustedPreview === undefined || trustedPreview.text !== preview) {
      new Notice(this.t("service.diagnostics.copyFailed"));
      return;
    }
    const result = await copyTextToClipboard(preview);
    new Notice(
      this.t(
        result === "copied"
          ? "service.diagnostics.copied"
          : "service.diagnostics.copyFailed",
      ),
    );
  }

  revokeSafeDiagnosticsPreview(token: string): void {
    this.trustedDiagnosticsPreviews.delete(token);
  }

  revokeAllSafeDiagnosticsPreviews(): void {
    this.trustedDiagnosticsPreviews.clear();
  }

  private purgeExpiredDiagnosticsPreviews(): void {
    const now = Date.now();
    for (const [token, preview] of this.trustedDiagnosticsPreviews) {
      if (preview.expiresAt <= now) {
        this.trustedDiagnosticsPreviews.delete(token);
      }
    }
  }
}
