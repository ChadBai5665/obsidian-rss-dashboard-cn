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
  private static readonly TRUSTED_PREVIEW_TTL_MS = 5 * 60_000;
  private settings: RssDashboardSettings;
  private isMobile: boolean;
  private getPortableDataBundle?: () => PortableDataBundle;
  private importPublicSettingsBundle?: (settings: unknown) => Promise<void>;
  private readonly getSafeDiagnosticsInput?: () => SafeDiagnosticsInput;
  private readonly getSafeOperationJournalExport?: (
    days: 7 | 30,
  ) => Promise<string>;
  private readonly getLocale: () => Locale;
  private readonly trustedPreviews = new Map<
    string,
    { kind: "diagnostics" | "operation-journal"; text: string; expiresAt: number }
  >();
  private readonly createPreviewToken: () => string;

  constructor(options: {
    settings: RssDashboardSettings;
    isMobile: boolean;
    getPortableDataBundle?: () => PortableDataBundle;
    importPublicSettingsBundle?: (settings: unknown) => Promise<void>;
    getSafeDiagnosticsInput?: () => SafeDiagnosticsInput;
    getSafeOperationJournalExport?: (days: 7 | 30) => Promise<string>;
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
    this.getSafeOperationJournalExport =
      options.getSafeOperationJournalExport;
    this.createPreviewToken =
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
    return this.createTrustedPreview("diagnostics", text);
  }

  async copySafeDiagnosticsPreview(
    token: string,
    preview: string,
  ): Promise<void> {
    await this.copyTrustedPreview(
      "diagnostics",
      token,
      preview,
      "service.diagnostics.copied",
      "service.diagnostics.copyFailed",
    );
  }

  revokeSafeDiagnosticsPreview(token: string): void {
    this.revokeTrustedPreview("diagnostics", token);
  }

  revokeAllSafeDiagnosticsPreviews(): void {
    this.revokeTrustedPreviewsByKind("diagnostics");
  }

  async createOperationJournalPreview(
    days: 7 | 30,
  ): Promise<Readonly<{ token: string; text: string }>> {
    if (!this.getSafeOperationJournalExport) {
      throw new Error("Operation journal export is unavailable.");
    }
    if (days !== 7 && days !== 30) {
      throw new Error("Unable to create an operation journal preview.");
    }
    const text = await this.getSafeOperationJournalExport(days);
    if (typeof text !== "string") {
      throw new Error("Unable to create an operation journal preview.");
    }
    return this.createTrustedPreview("operation-journal", text);
  }

  async copyOperationJournalPreview(
    token: string,
    exactText: string,
  ): Promise<void> {
    await this.copyTrustedPreview(
      "operation-journal",
      token,
      exactText,
      "service.operationJournal.copied",
      "service.operationJournal.copyFailed",
    );
  }

  revokeOperationJournalPreview(token: string): void {
    this.revokeTrustedPreview("operation-journal", token);
  }

  revokeAllOperationJournalPreviews(): void {
    this.revokeTrustedPreviewsByKind("operation-journal");
  }

  private createTrustedPreview(
    kind: "diagnostics" | "operation-journal",
    text: string,
  ): Readonly<{ token: string; text: string }> {
    this.revokeTrustedPreviewsByKind(kind);
    const token = this.createPreviewToken();
    if (
      typeof token !== "string" ||
      token.length === 0 ||
      token.length > 256 ||
      this.trustedPreviews.has(token)
    ) {
      throw new Error("Unable to create a trusted preview token.");
    }
    this.trustedPreviews.set(token, {
      kind,
      text,
      expiresAt: Date.now() + ImportExportService.TRUSTED_PREVIEW_TTL_MS,
    });
    return Object.freeze({ token, text });
  }

  private async copyTrustedPreview(
    kind: "diagnostics" | "operation-journal",
    token: string,
    exactText: string,
    copiedKey:
      | "service.diagnostics.copied"
      | "service.operationJournal.copied",
    failedKey:
      | "service.diagnostics.copyFailed"
      | "service.operationJournal.copyFailed",
  ): Promise<void> {
    this.purgeExpiredTrustedPreviews();
    if (typeof token !== "string" || typeof exactText !== "string") {
      new Notice(this.t(failedKey));
      return;
    }
    const trustedPreview = this.trustedPreviews.get(token);
    this.trustedPreviews.delete(token);
    if (
      trustedPreview === undefined ||
      trustedPreview.kind !== kind ||
      trustedPreview.text !== exactText
    ) {
      new Notice(this.t(failedKey));
      return;
    }
    const result = await copyTextToClipboard(exactText);
    new Notice(this.t(result === "copied" ? copiedKey : failedKey));
  }

  private revokeTrustedPreview(
    kind: "diagnostics" | "operation-journal",
    token: string,
  ): void {
    if (typeof token !== "string") return;
    const trustedPreview = this.trustedPreviews.get(token);
    if (trustedPreview?.kind === kind) this.trustedPreviews.delete(token);
  }

  private revokeTrustedPreviewsByKind(
    kind: "diagnostics" | "operation-journal",
  ): void {
    for (const [token, preview] of this.trustedPreviews) {
      if (preview.kind === kind) this.trustedPreviews.delete(token);
    }
  }

  private purgeExpiredTrustedPreviews(): void {
    const now = Date.now();
    for (const [token, preview] of this.trustedPreviews) {
      if (preview.expiresAt <= now) {
        this.trustedPreviews.delete(token);
      }
    }
  }
}
