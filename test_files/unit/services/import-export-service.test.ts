/**
 * Phase 2 (Red) → Phase 3 (Green) — ImportExportService unit tests
 *
 * Covers:
 *   - getUserSettingsJson: omits feeds/folders/availableTags; produces valid JSON
 *   - showExportNotice: fires correct Notice for each result variant
 *   - showCopyNotice: fires correct Notice for copied/failed
 *   - exportOpml: calls exportBlob with a text/xml blob
 *   - exportDataJson: calls exportBlob with an application/json blob containing full settings
 */
import { describe, it, expect, vi, beforeEach, type MockInstance } from "vitest";
import type { RssDashboardSettings, PortableDataBundle } from "../../../src/types/types";
import type { Locale } from "../../../src/i18n";

vi.mock("../../../src/utils/export-utils", () => ({
  exportBlob: vi.fn().mockResolvedValue("downloaded"),
  copyTextToClipboard: vi.fn().mockResolvedValue("copied"),
}));

vi.mock("../../../src/services/opml-manager", () => ({
  OpmlManager: {
    generateOpml: vi.fn().mockReturnValue("<opml>mock</opml>"),
  },
}));

import { ImportExportService } from "../../../src/services/import-export-service";
import { copyTextToClipboard, exportBlob } from "../../../src/utils/export-utils";
import { OpmlManager } from "../../../src/services/opml-manager";

function makeSettings(overrides?: object): RssDashboardSettings {
  return {
    feeds: [
      {
        title: "Test",
        url: "https://example.com/feed",
        folder: "News",
        items: [],
        lastUpdated: 0,
      },
    ],
    folders: [{ name: "News", subfolders: [], createdAt: 0, modifiedAt: 0 }],
    availableTags: [{ name: "tech", color: "#fff" }],
    refreshInterval: 60,
    ...overrides,
  } as unknown as RssDashboardSettings;
}

function getNoticeMessages(spy: MockInstance): string[] {
  return spy.mock.calls
    .filter((call: unknown[]): call is [string, string] => call[0] === "[Stub Notice]")
    .map((call: [string, string]) => String(call[1]));
}

describe("ImportExportService", () => {
  let consoleLogSpy: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  describe("getUserSettingsJson", () => {
    it("omits feeds, folders, and availableTags from output", () => {
      const svc = new ImportExportService({
        settings: makeSettings(),
        isMobile: false,
      });
      const parsed = JSON.parse(svc.getUserSettingsJson()) as Record<string, unknown>;
      expect(parsed).not.toHaveProperty("feeds");
      expect(parsed).not.toHaveProperty("folders");
      expect(parsed).not.toHaveProperty("availableTags");
      expect(parsed).toHaveProperty("refreshInterval", 60);
    });

    it("produces valid JSON", () => {
      const svc = new ImportExportService({
        settings: makeSettings(),
        isMobile: false,
      });
      expect(() => { JSON.parse(svc.getUserSettingsJson()); }).not.toThrow();
    });
  });

  describe("showExportNotice", () => {
    it("reads the locale provider again for each notice", () => {
      let locale: Locale = "zh-CN";
      const svc = new ImportExportService({
        settings: makeSettings(),
        isMobile: false,
        getLocale: () => locale,
      });

      svc.showExportNotice("downloaded", "data.json");
      locale = "en";
      svc.showExportNotice("downloaded", "data.json");

      expect(getNoticeMessages(consoleLogSpy)).toContain("正在下载 data.json");
      expect(getNoticeMessages(consoleLogSpy)).toContain("Downloading data.json");
    });

    it('fires "Downloading <filename>" for "downloaded"', () => {
      const svc = new ImportExportService({
        settings: makeSettings(),
        isMobile: false,
      });
      svc.showExportNotice("downloaded", "data.json");
      expect(getNoticeMessages(consoleLogSpy)).toContain(
        "Downloading data.json",
      );
    });

    it('fires "Opened save menu for <filename>" for "shared"', () => {
      const svc = new ImportExportService({
        settings: makeSettings(),
        isMobile: false,
      });
      svc.showExportNotice("shared", "feeds.opml");
      expect(getNoticeMessages(consoleLogSpy)).toContain(
        "Opened save menu for feeds.opml",
      );
    });

    it('fires "Export canceled" for "canceled"', () => {
      const svc = new ImportExportService({
        settings: makeSettings(),
        isMobile: false,
      });
      svc.showExportNotice("canceled", "data.json");
      expect(getNoticeMessages(consoleLogSpy)).toContain("Export canceled");
    });

    it('fires "Unable to export <filename>" for "failed"', () => {
      const svc = new ImportExportService({
        settings: makeSettings(),
        isMobile: false,
      });
      svc.showExportNotice("failed", "data.json");
      expect(getNoticeMessages(consoleLogSpy)).toContain(
        "Unable to export data.json",
      );
    });
  });

  describe("showCopyNotice", () => {
    it('fires "Copied <filename> to clipboard" for "copied"', () => {
      const svc = new ImportExportService({
        settings: makeSettings(),
        isMobile: false,
      });
      svc.showCopyNotice("copied", "data.json");
      expect(getNoticeMessages(consoleLogSpy)).toContain(
        "Copied data.json to clipboard",
      );
    });

    it('fires "Unable to copy <filename>" for "failed"', () => {
      const svc = new ImportExportService({
        settings: makeSettings(),
        isMobile: false,
      });
      svc.showCopyNotice("failed", "data.json");
      expect(getNoticeMessages(consoleLogSpy)).toContain(
        "Unable to copy data.json",
      );
    });
  });

  describe("exportOpml", () => {
    it("calls exportBlob with a text/xml blob", async () => {
      const svc = new ImportExportService({
        settings: makeSettings(),
        isMobile: false,
      });
      await svc.exportOpml();
      expect(exportBlob).toHaveBeenCalledWith(
        expect.objectContaining({
          blob: expect.objectContaining({ type: "text/xml" }) as unknown as Blob,
          filename: "feeds.opml",
        }),
      );
    });

    it("fails before OPML generation when a subscription URL contains credentials", async () => {
      const svc = new ImportExportService({
        settings: makeSettings({
          feeds: [
            {
              title: "Private",
              url: "https://example.com/feed?token=PRIVATE_OPML_TOKEN_CANARY",
              folder: "News",
              items: [],
              lastUpdated: 0,
            },
          ],
        }),
        isMobile: false,
      });
      await svc.exportOpml();
      expect(OpmlManager.generateOpml).not.toHaveBeenCalled();
      expect(exportBlob).not.toHaveBeenCalled();
    });
  });

  describe("exportDataJson", () => {
    it("exports only the public settings schema and never collected/private state", async () => {
      const settings = makeSettings({
        feeds: [
          {
            title: "Allowed feed",
            url: "https://example.com/feed.xml",
            folder: "News",
            items: [{ content: "PRIVATE_EXPORT_BODY_CANARY" }],
            lastUpdated: 123,
            lastFetchError: "PRIVATE_EXPORT_ERROR_CANARY",
          },
        ],
        apiKey: "PRIVATE_EXPORT_KEY_CANARY",
        futureUnknown: "PRIVATE_FUTURE_FIELD_CANARY",
      });
      const svc = new ImportExportService({ settings, isMobile: false });
      await svc.exportDataJson();
      expect(exportBlob).toHaveBeenCalledWith(
        expect.objectContaining({
          blob: expect.objectContaining({ type: "application/json" }) as unknown as Blob,
          filename: "data.json",
        }),
      );
      const call = vi.mocked(exportBlob).mock.calls[0][0] as unknown as { blob: Blob; filename: string };
      const text = await call.blob.text();
      const parsed = JSON.parse(text) as Record<string, unknown>;
      expect(parsed).toHaveProperty("feeds");
      expect(text).not.toContain("PRIVATE_EXPORT_BODY_CANARY");
      expect(text).not.toContain("PRIVATE_EXPORT_ERROR_CANARY");
      expect(text).not.toContain("PRIVATE_EXPORT_KEY_CANARY");
      expect(text).not.toContain("PRIVATE_FUTURE_FIELD_CANARY");
    });

    it("does not download or copy a partial result when an allowed structure is invalid", async () => {
      const settings = makeSettings();
      const originalFeeds = settings.feeds;
      const getter = vi.fn(() => originalFeeds);
      Object.defineProperty(settings, "feeds", { enumerable: true, get: getter });
      const svc = new ImportExportService({ settings, isMobile: false });

      await svc.exportDataJson();
      await svc.copyDataJsonToClipboard();

      expect(getter).not.toHaveBeenCalled();
      expect(exportBlob).not.toHaveBeenCalled();
      expect(copyTextToClipboard).not.toHaveBeenCalled();
    });

    it("does not download or copy a partial result when the shared export budget is exceeded", async () => {
      const settings = makeSettings();
      const longTitle = "x".repeat(4_096);
      settings.feeds = Array.from({ length: 1_300 }, (_, index) => ({
        ...settings.feeds[0],
        title: `${longTitle.slice(0, -String(index).length)}${index}`,
        items: [],
      }));
      const svc = new ImportExportService({ settings, isMobile: false });

      await svc.exportDataJson();
      await svc.copyDataJsonToClipboard();

      expect(exportBlob).not.toHaveBeenCalled();
      expect(copyTextToClipboard).not.toHaveBeenCalled();
    });
  });

  describe("exportPortableDataBundle", () => {
    it("exports a portable bundle JSON payload when a provider is supplied", async () => {
      const settings = makeSettings();
      const svc = new ImportExportService({
        settings,
        isMobile: false,
        getPortableDataBundle: () => {
          return {
            version: 1,
            exportedAt: 123,
            storageMode: "vault-shards",
            metadata: { ...settings, feeds: [] },
            shards: [],
            markdownMirrorFallbackPlanned: true,
          } as unknown as PortableDataBundle;
        },
      });

      await svc.exportPortableDataBundle();

      expect(exportBlob).toHaveBeenCalledWith(
        expect.objectContaining({
          filename: "rss-dashboard-portable-bundle.json",
        }),
      );
      const call = vi.mocked(exportBlob).mock.calls[0][0] as unknown as { blob: Blob; filename: string };
      const text = await call.blob.text();
      const parsed = JSON.parse(text) as Record<string, unknown>;
      expect(parsed.storageMode).toBe("vault-shards");
      expect(parsed.shards).toEqual([]);
      expect(JSON.stringify(parsed)).not.toContain("items");
    });
  });

  describe("importPortableDataBundleFromFile", () => {
    it("parses bundle JSON and passes it to the import callback", async () => {
      const importPublicSettingsBundle = vi.fn().mockResolvedValue(undefined);
      const svc = new ImportExportService({
        settings: makeSettings(),
        isMobile: false,
        importPublicSettingsBundle,
      });

      const file = new File(
        [
          JSON.stringify({
            version: 1,
            exportedAt: 123,
            storageMode: "vault-shards",
            metadata: { ...makeSettings(), feeds: [] },
            shards: [],
            markdownMirrorFallbackPlanned: true,
          }),
        ],
        "portable-bundle.json",
        { type: "application/json" },
      );

      await svc.importPortableDataBundleFromFile(file);

      expect(importPublicSettingsBundle).toHaveBeenCalledTimes(1);
      expect(importPublicSettingsBundle).toHaveBeenCalledWith(
        expect.objectContaining({
          feeds: [],
        }),
      );
      expect(getNoticeMessages(consoleLogSpy)).toContain(
        "Portable data bundle imported",
      );
    });

    it("throws a helpful error when bundle JSON is invalid", async () => {
      const svc = new ImportExportService({
        settings: makeSettings(),
        isMobile: false,
        importPortableDataBundle: vi.fn().mockResolvedValue(undefined),
      });

      const file = new File(["{bad json"], "portable-bundle.json", {
        type: "application/json",
      });

      await expect(svc.importPortableDataBundleFromFile(file)).rejects.toThrow(
        "Invalid portable bundle JSON",
      );
    });

    it("does not report portable import success when the transactional callback rejects", async () => {
      const svc = new ImportExportService({
        settings: makeSettings(),
        isMobile: false,
        importPublicSettingsBundle: vi
          .fn()
          .mockRejectedValue(new Error("transaction-rollback")),
      });
      const file = new File(
        [
          JSON.stringify({
            version: 1,
            exportedAt: 123,
            storageMode: "vault-shards",
            metadata: { ...makeSettings(), feeds: [] },
            shards: [],
            markdownMirrorFallbackPlanned: false,
          }),
        ],
        "portable.json",
      );

      await expect(svc.importPortableDataBundleFromFile(file)).rejects.toThrow(
        "transaction-rollback",
      );
      expect(getNoticeMessages(consoleLogSpy)).not.toContain(
        "Portable data bundle imported",
      );
    });
  });

  describe("safe diagnostics", () => {
    it("builds a token-bound preview without touching the clipboard and copies only the exact pair", async () => {
      const tokens = ["preview-one", "preview-two"];
      const svc = new ImportExportService({
        settings: makeSettings(),
        isMobile: false,
        getSafeDiagnosticsInput: () => ({
          pluginVersion: "0.1.0",
          obsidianVersion: "1.8.7",
          osName: "linux",
          generatedAt: "2026-07-22T10:00:00.000Z",
          sourceKinds: ["feed"],
          statusCodes: ["ok"],
          aggregateCounts: { failedSources: 0 },
        }),
        createDiagnosticsToken: () => tokens.shift()!,
      });

      const preview = svc.createSafeDiagnosticsPreview();
      expect(copyTextToClipboard).not.toHaveBeenCalled();
      await svc.copySafeDiagnosticsPreview(preview.token, preview.text);
      expect(copyTextToClipboard).toHaveBeenCalledTimes(1);
      expect(copyTextToClipboard).toHaveBeenCalledWith(preview.text);

      await svc.copySafeDiagnosticsPreview(preview.token, preview.text);
      expect(copyTextToClipboard).toHaveBeenCalledTimes(1);

      const second = svc.createSafeDiagnosticsPreview();
      expect(second.text).toBe(preview.text);
      expect(second.token).not.toBe(preview.token);
      await svc.copySafeDiagnosticsPreview(preview.token, second.text);
      expect(copyTextToClipboard).toHaveBeenCalledTimes(1);
      await svc.copySafeDiagnosticsPreview(second.token, second.text);
      expect(copyTextToClipboard).toHaveBeenCalledTimes(2);
    });

    it("consumes the one-time token on clipboard failure and never logs diagnostic content", async () => {
      vi.mocked(copyTextToClipboard).mockResolvedValueOnce("failed");
      const svc = new ImportExportService({
        settings: makeSettings(),
        isMobile: false,
        locale: "en",
        getSafeDiagnosticsInput: () => ({
          pluginVersion: "0.1.0",
          obsidianVersion: "1.8.7",
          osName: "linux",
          generatedAt: "2026-07-22T10:00:00.000Z",
          sourceKinds: [],
          statusCodes: [],
          aggregateCounts: {},
        }),
        createDiagnosticsToken: () => "failed-preview",
      });
      const preview = svc.createSafeDiagnosticsPreview();
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      await svc.copySafeDiagnosticsPreview(preview.token, preview.text);
      await svc.copySafeDiagnosticsPreview(preview.token, preview.text);
      expect(getNoticeMessages(consoleLogSpy)).toContain(
        "Unable to copy diagnostics",
      );
      expect(copyTextToClipboard).toHaveBeenCalledTimes(1);
      expect(consoleLogSpy.mock.calls.flat().join(" ")).not.toContain(preview.text);
      expect(errorSpy.mock.calls.flat().join(" ")).not.toContain(preview.text);
    });

    it("keeps only one preview owner and expires an unconsumed token", async () => {
      const tokens = ["owner-one", "owner-two"];
      let now = 1_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const svc = new ImportExportService({
        settings: makeSettings(),
        isMobile: false,
        getSafeDiagnosticsInput: () => ({
          pluginVersion: "0.1.0",
          obsidianVersion: "1.8.7",
          osName: "linux",
          generatedAt: "2026-07-22T10:00:00.000Z",
          sourceKinds: [],
          statusCodes: [],
          aggregateCounts: {},
        }),
        createDiagnosticsToken: () => tokens.shift()!,
      });

      const first = svc.createSafeDiagnosticsPreview();
      const second = svc.createSafeDiagnosticsPreview();
      await svc.copySafeDiagnosticsPreview(first.token, first.text);
      expect(copyTextToClipboard).not.toHaveBeenCalled();

      now += 5 * 60_000 + 1;
      await svc.copySafeDiagnosticsPreview(second.token, second.text);
      expect(copyTextToClipboard).not.toHaveBeenCalled();
    });

    it("exposes explicit revocation for modal close and settings rerender", async () => {
      const svc = new ImportExportService({
        settings: makeSettings(),
        isMobile: false,
        getSafeDiagnosticsInput: () => ({
          pluginVersion: "0.1.0",
          obsidianVersion: "1.8.7",
          osName: "linux",
          generatedAt: "2026-07-22T10:00:00.000Z",
          sourceKinds: [],
          statusCodes: [],
          aggregateCounts: {},
        }),
        createDiagnosticsToken: () => "revoked-preview",
      });
      const preview = svc.createSafeDiagnosticsPreview();
      const revocation = svc as unknown as {
        revokeSafeDiagnosticsPreview?: (token: string) => void;
      };

      expect(revocation.revokeSafeDiagnosticsPreview).toBeTypeOf("function");
      revocation.revokeSafeDiagnosticsPreview?.(preview.token);
      await svc.copySafeDiagnosticsPreview(preview.token, preview.text);
      expect(copyTextToClipboard).not.toHaveBeenCalled();
    });
  });
});
