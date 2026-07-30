import { beforeEach, describe, expect, it, vi } from "vitest";
import * as obsidian from "obsidian";
import {
  buildDefaultAutoBackupSettings,
  FactoryResetConfirmModal,
  getBackupFilename,
  renderImportExportSettingsTab,
} from "../../../src/settings/tabs/import-export-settings-tab";
import { DEFAULT_SETTINGS } from "../../../src/types/types";
import {
  FACTORY_RESET_LOCAL_STORAGE_KEYS,
  buildFactoryResetSettings,
} from "../../../src/utils/settings-loader";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";
import type RssDashboardPlugin from "../../../main";
import { ImportSuccessModal } from "../../../src/modals/import-success-modal";
import { DiagnosticsPreviewModal } from "../../../src/modals/diagnostics-preview-modal";
import { OperationJournalClearModal } from "../../../src/modals/operation-journal-clear-modal";
import type { OperationJournalSettingsPort } from "../../../src/settings/tabs/import-export-settings-tab";

type ObsidianHTMLElement = HTMLElement & {
  empty: () => void;
  createDiv: () => HTMLDivElement;
};

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function cloneSettings(): typeof DEFAULT_SETTINGS {
  const settings = JSON.parse(
    JSON.stringify(DEFAULT_SETTINGS),
  ) as typeof DEFAULT_SETTINGS;
  settings.locale = "en";
  return settings;
}

function createContainerEl(): HTMLDivElement {
  return (document.body as ObsidianHTMLElement).createDiv();
}

function getSettingByName(containerEl: HTMLElement, name: string): HTMLElement {
  const settingEls = Array.from(containerEl.querySelectorAll(".setting-item"));
  const match = settingEls.find((el) => {
    const nameEl = el.querySelector(".setting-item-name");
    return nameEl?.textContent === name;
  });

  if (!match) {
    throw new Error(`Setting not found: ${name}`);
  }

  return match as HTMLElement;
}

function createPlugin() {
  const plugin = {
    app: obsidian.App.createMock(),
    settings: cloneSettings(),
    saveSettings: vi.fn(async () => {}),
    exportDataJson: vi.fn(async () => {}),
    copyDataJsonToClipboard: vi.fn(async () => {}),
    importDataJsonFromFile: vi.fn(async (_file: File) => {}),
    importUserSettingsJsonFromFile: vi.fn(async () => {}),
    exportUserSettingsJson: vi.fn(async () => {}),
    copyUserSettingsJsonToClipboard: vi.fn(async () => {}),
    exportOpml: vi.fn(async () => {}),
    copyOpmlToClipboard: vi.fn(async () => {}),
    exportPortableDataBundle: vi.fn(async () => {}),
    importPortableDataBundleFromFile: vi.fn(async () => {}),
    createSafeDiagnosticsPreview: vi.fn(() => ({
      token: "preview-token",
      text: '{"pluginVersion":"0.1.0"}',
    })),
    copySafeDiagnosticsPreview: vi.fn(async () => {}),
    revokeSafeDiagnosticsPreview: vi.fn(),
    revokeAllSafeDiagnosticsPreviews: vi.fn(),
    getActiveDashboardView: vi.fn(async () => null),
    performFactoryReset: vi.fn(async () => {}),
  };
  plugin.importDataJsonFromFile.mockImplementation(async (file: File) => {
    const imported = JSON.parse(await file.text()) as { locale?: "en" | "zh-CN" };
    if (imported.locale) plugin.settings.locale = imported.locale;
  });
  return plugin;
}

function createOperationJournalPort(
  overrides: Partial<OperationJournalSettingsPort> = {},
): OperationJournalSettingsPort {
  return {
    stats: vi.fn(async () => ({
      bytes: 1_536,
      days: 3,
      eventCount: 8,
      earliestDate: "2026-07-28",
    })),
    createPreview: vi.fn(async () =>
      Object.freeze({ token: "journal-preview", text: "SAFE JOURNAL" }),
    ),
    copyPreview: vi.fn(async () => {}),
    revokePreview: vi.fn(),
    clear: vi.fn(async () => {}),
    openDashboard: vi.fn(async () => {}),
    ...overrides,
  };
}

beforeEach(() => {
  installObsidianDomPolyfills();
  (document.body as ObsidianHTMLElement).empty();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("Auto Backup Helpers", () => {
  describe("buildDefaultAutoBackupSettings()", () => {
    it("returns the expected default values (OPML/Userdata true, DataJson false)", () => {
      const defaults = buildDefaultAutoBackupSettings();
      expect(defaults).toEqual({
        backupDataJson: false,
        backupOpml: true,
        backupUserdata: true,
      });
    });

    it("returns a fresh object on each call", () => {
      const a = buildDefaultAutoBackupSettings();
      const b = buildDefaultAutoBackupSettings();
      expect(a).not.toBe(b);

      // Mutate a, b should be unchanged
      a.backupDataJson = true;
      expect(b.backupDataJson).toBe(false);
    });
  });

  describe("getBackupFilename()", () => {
    it("appends .backup to standard filenames", () => {
      expect(getBackupFilename("data.json")).toBe("data.json.backup");
      expect(getBackupFilename("feeds.opml")).toBe("feeds.opml.backup");
      expect(getBackupFilename("userdata.json")).toBe("userdata.json.backup");
    });

    it("handles filenames without extensions", () => {
      expect(getBackupFilename("myfile")).toBe("myfile.backup");
    });

    it("handles empty string", () => {
      expect(getBackupFilename("")).toBe(".backup");
    });

    it("appends .backup even if it already ends in .backup", () => {
      expect(getBackupFilename("data.json.backup")).toBe(
        "data.json.backup.backup",
      );
    });
  });

  describe("Factory reset helpers", () => {
    it("returns the expected plugin-managed local storage keys", () => {
      expect(FACTORY_RESET_LOCAL_STORAGE_KEYS).toEqual([
        "rss-discover-filters",
        "rss-podcast-progress",
        "rss-first-launch-coachmark-shown",
      ]);
    });

    it("builds a fresh factory-reset settings object with fresh folder timestamps", () => {
      vi.spyOn(Date, "now").mockReturnValue(123456789);

      const a = buildFactoryResetSettings();
      const b = buildFactoryResetSettings();

      expect(a).toEqual({
        ...DEFAULT_SETTINGS,
        folders: DEFAULT_SETTINGS.folders.map((folder) => ({
          ...folder,
          subfolders: [],
          createdAt: 123456789,
          modifiedAt: 123456789,
        })),
      });
      expect(a).not.toBe(b);
      expect(a.display).not.toBe(DEFAULT_SETTINGS.display);
      expect(a.availableTags).not.toBe(DEFAULT_SETTINGS.availableTags);
      expect(a.folders).not.toBe(DEFAULT_SETTINGS.folders);

      a.display.showSummary = false;
      a.availableTags[0].name = "Changed";
      expect(DEFAULT_SETTINGS.display.showSummary).toBe(true);
      expect(DEFAULT_SETTINGS.availableTags[0]?.name).toBe("Important");
    });
  });

  describe("renderImportExportSettingsTab() factory reset section", () => {
    it.each([
      ["导入 data.json", "importDataJsonFromFile", "导入失败"],
      ["导入安全配置", "importPortableDataBundleFromFile", "无法导入安全配置"],
      ["导入 usersettings.json", "importUserSettingsJsonFromFile", "无法导入用户偏好"],
    ] as const)("shows a safe localized error for %s", async (buttonLabel, method, expected) => {
      const containerEl = createContainerEl();
      const plugin = createPlugin();
      plugin.settings.locale = "zh-CN";
      plugin[method].mockRejectedValue(new Error("secret-token-from-file"));
      const noticeSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      renderImportExportSettingsTab(
        containerEl,
        plugin as unknown as RssDashboardPlugin,
      );

      const button = Array.from(containerEl.querySelectorAll("button")).find(
        (candidate) => candidate.textContent === buttonLabel,
      ) as HTMLButtonElement;
      button.click();
      const input = Array.from(
        document.body.querySelectorAll<HTMLInputElement>('input[type="file"]'),
      ).at(-1)!;
      Object.defineProperty(input, "files", {
        configurable: true,
        value: [new File(["{}"], "input.json", { type: "application/json" })],
      });
      input.dispatchEvent(new Event("change"));
      await flushPromises();

      const notices = noticeSpy.mock.calls
        .filter(([prefix]) => prefix === "[Stub Notice]")
        .map(([, message]) => String(message));
      expect(notices.join(" ")).toContain(expected);
      expect(notices.join(" ")).not.toContain("secret-token-from-file");
    });

    it.each([
      [
        "zh-CN",
        "en",
        "Import successful",
        "Data imported successfully! Your dashboard has been updated.",
      ],
      ["en", "zh-CN", "导入成功", "数据导入成功，仪表盘已更新。"],
    ] as const)(
      "uses the imported final locale for the real data.json success handler (%s to %s)",
      async (initialLocale, importedLocale, expectedTitle, expectedBody) => {
        const containerEl = createContainerEl();
        const plugin = createPlugin();
        plugin.settings.locale = initialLocale;
        const openSpy = vi
          .spyOn(ImportSuccessModal.prototype, "open")
          .mockImplementation(function openImportSuccess() {
            this.onOpen();
            return this;
          });
        renderImportExportSettingsTab(
          containerEl,
          plugin as unknown as RssDashboardPlugin,
        );
        const importButton = Array.from(
          containerEl.querySelectorAll<HTMLButtonElement>("button"),
        ).find((button) => button.textContent === (initialLocale === "zh-CN" ? "导入 data.json" : "Import data.json"))!;
        importButton.click();
        const fileInput = Array.from(
          document.body.querySelectorAll<HTMLInputElement>(
            'input[type="file"]',
          ),
        ).at(-1)!;
        Object.defineProperty(fileInput, "files", {
          configurable: true,
          value: [
            new File(
              [JSON.stringify({ locale: importedLocale })],
              "data.json",
              {
                type: "application/json",
              },
            ),
          ],
        });
        fileInput.dispatchEvent(new Event("change"));
        await flushPromises();
        await flushPromises();

        expect(plugin.settings.locale).toBe(importedLocale);
        expect(openSpy).toHaveBeenCalledTimes(1);
        const successModal = openSpy.mock.instances[0] as ImportSuccessModal;
        expect(successModal.contentEl.textContent).toContain(expectedTitle);
        expect(successModal.contentEl.textContent).toContain(expectedBody);
      },
    );

    it("opens the shared localized modal from the real factory-reset button", async () => {
      const containerEl = createContainerEl();
      const plugin = createPlugin();
      plugin.settings.locale = "zh-CN";
      const openSpy = vi
        .spyOn(FactoryResetConfirmModal.prototype, "open")
        .mockImplementation(function openSharedModal() {
          this.onOpen();
          return this;
        });
      vi.spyOn(
        FactoryResetConfirmModal.prototype,
        "waitForClose",
      ).mockResolvedValue(false);

      renderImportExportSettingsTab(
        containerEl,
        plugin as unknown as RssDashboardPlugin,
      );
      const resetButton = Array.from(
        containerEl.querySelectorAll<HTMLButtonElement>("button"),
      ).find(
        (button) => button.textContent === "恢复出厂设置",
      ) as HTMLButtonElement;
      resetButton.click();
      await flushPromises();

      const modal = openSpy.mock.instances[0] as FactoryResetConfirmModal;
      expect(modal.contentEl.textContent).toContain("恢复出厂设置？");
      expect(modal.contentEl.textContent).toContain("取消");
      expect(modal.contentEl.textContent).toContain("不会被删除");
    });

    it("renders shard data actions", () => {
      const containerEl = createContainerEl();
      const plugin = createPlugin();

      renderImportExportSettingsTab(
        containerEl,
        plugin as unknown as RssDashboardPlugin,
      );

      const portableSetting = getSettingByName(containerEl, "Safe configuration migration");
      expect(portableSetting.textContent).toContain("Collected article bodies");

      const buttons = Array.from(
        containerEl.querySelectorAll<HTMLButtonElement>("button"),
      ).map((button) => button.textContent?.trim());
      expect(buttons).toContain("Import safe configuration");
      expect(buttons).toContain("Export safe configuration");
    });

    it("opens a preview before any diagnostics copy and wires the exact text", () => {
      const containerEl = createContainerEl();
      const plugin = createPlugin();
      const openSpy = vi
        .spyOn(DiagnosticsPreviewModal.prototype, "open")
        .mockImplementation(function openPreview() {
          this.onOpen();
          return this;
        });

      renderImportExportSettingsTab(
        containerEl,
        plugin as unknown as RssDashboardPlugin,
      );
      expect(plugin.revokeAllSafeDiagnosticsPreviews).toHaveBeenCalledTimes(1);
      const diagnostics = Array.from(
        containerEl.querySelectorAll<HTMLButtonElement>("button"),
      ).find((candidate) => candidate.textContent === "Preview diagnostics");
      diagnostics?.click();

      expect(plugin.createSafeDiagnosticsPreview).toHaveBeenCalledTimes(1);
      expect(plugin.copySafeDiagnosticsPreview).not.toHaveBeenCalled();
      expect(openSpy).toHaveBeenCalledTimes(1);
      const modal = openSpy.mock.instances[0] as DiagnosticsPreviewModal;
      expect(modal.contentEl.querySelector("pre")?.textContent).toBe(
        '{"pluginVersion":"0.1.0"}',
      );
    });

    it("renders concise journal statistics and opens the top-level dashboard journal", async () => {
      const containerEl = createContainerEl();
      const plugin = createPlugin();
      const port = createOperationJournalPort();

      renderImportExportSettingsTab(
        containerEl,
        plugin as unknown as RssDashboardPlugin,
        port,
      );
      await flushPromises();

      const journal = getSettingByName(containerEl, "Operation journal");
      expect(journal.textContent).toContain("1.5 KB");
      expect(journal.textContent).toContain("3 record days");
      expect(journal.textContent).toContain("2026-07-28");

      const view = Array.from(
        journal.querySelectorAll<HTMLButtonElement>("button"),
      ).find((candidate) => candidate.textContent === "View operation journal")!;
      view.click();
      await flushPromises();
      expect(port.openDashboard).toHaveBeenCalledTimes(1);
    });

    it("previews the safe 30-day journal before a second explicit copy click", async () => {
      const containerEl = createContainerEl();
      const plugin = createPlugin();
      const port = createOperationJournalPort();
      const openSpy = vi
        .spyOn(DiagnosticsPreviewModal.prototype, "open")
        .mockImplementation(function openPreview() {
          this.onOpen();
          return this;
        });
      renderImportExportSettingsTab(
        containerEl,
        plugin as unknown as RssDashboardPlugin,
        port,
      );

      const exportButton = Array.from(
        containerEl.querySelectorAll<HTMLButtonElement>("button"),
      ).find(
        (candidate) => candidate.textContent === "Export sanitized journal",
      )!;
      exportButton.click();
      await flushPromises();

      expect(port.createPreview).toHaveBeenCalledWith(30);
      expect(port.copyPreview).not.toHaveBeenCalled();
      const modal = openSpy.mock.instances[0] as DiagnosticsPreviewModal;
      expect(modal.contentEl.querySelector("pre")?.textContent).toBe(
        "SAFE JOURNAL",
      );
      const copy = Array.from(
        modal.contentEl.querySelectorAll<HTMLButtonElement>("button"),
      ).find(
        (candidate) => candidate.textContent === "Copy sanitized journal",
      )!;
      copy.click();
      await flushPromises();
      expect(port.copyPreview).toHaveBeenCalledWith(
        "journal-preview",
        "SAFE JOURNAL",
      );
    });

    it("offers a controlled unavailable state when no settings port exists", async () => {
      const containerEl = createContainerEl();
      const plugin = createPlugin();
      renderImportExportSettingsTab(
        containerEl,
        plugin as unknown as RssDashboardPlugin,
      );
      await flushPromises();

      const journal = getSettingByName(containerEl, "Operation journal");
      expect(journal.textContent).toContain(
        "Operation journal controls are temporarily unavailable.",
      );
      expect(
        Array.from(journal.querySelectorAll<HTMLButtonElement>("button")).every(
          (control) => control.disabled,
        ),
      ).toBe(true);
    });

    it("accepts the optional plugin facade that Task 11 can compose", async () => {
      const containerEl = createContainerEl();
      const plugin = createPlugin();
      const port = createOperationJournalPort();
      const pluginWithFacade = {
        ...plugin,
        getOperationJournalSettings: vi.fn(() => port),
      };

      renderImportExportSettingsTab(
        containerEl,
        pluginWithFacade as unknown as RssDashboardPlugin,
      );
      await flushPromises();

      expect(pluginWithFacade.getOperationJournalSettings).toHaveBeenCalledTimes(1);
      expect(port.stats).toHaveBeenCalledTimes(1);
      expect(
        getSettingByName(containerEl, "Operation journal").textContent,
      ).toContain("1.5 KB");
    });

    it("refreshes statistics after a successful clear", async () => {
      const containerEl = createContainerEl();
      const plugin = createPlugin();
      const port = createOperationJournalPort();
      const openSpy = vi
        .spyOn(OperationJournalClearModal.prototype, "open")
        .mockImplementation(function openClear() {
          this.onOpen();
          return this;
        });
      renderImportExportSettingsTab(
        containerEl,
        plugin as unknown as RssDashboardPlugin,
        port,
      );
      await flushPromises();

      const clearButton = Array.from(
        containerEl.querySelectorAll<HTMLButtonElement>("button"),
      ).find((candidate) => candidate.textContent === "Clear journal")!;
      clearButton.click();
      const modal = openSpy.mock.instances[0] as OperationJournalClearModal;
      const confirm = Array.from(
        modal.contentEl.querySelectorAll<HTMLButtonElement>("button"),
      ).find(
        (candidate) => candidate.textContent === "Clear operation journal",
      )!;
      confirm.click();
      await flushPromises();
      await flushPromises();

      expect(port.clear).toHaveBeenCalledTimes(1);
      expect(port.stats).toHaveBeenCalledTimes(2);
    });

    it("shares one clear across concurrent modals and releases the lock after failure", async () => {
      const first = deferred<void>();
      const port = createOperationJournalPort({
        clear: vi
          .fn()
          .mockImplementationOnce(() => first.promise)
          .mockResolvedValueOnce(undefined),
      });
      const containerEl = createContainerEl();
      const plugin = createPlugin();
      const openSpy = vi
        .spyOn(OperationJournalClearModal.prototype, "open")
        .mockImplementation(function openClear() {
          this.onOpen();
          return this;
        });
      renderImportExportSettingsTab(
        containerEl,
        plugin as unknown as RssDashboardPlugin,
        port,
      );
      await flushPromises();
      const clearButton = Array.from(
        containerEl.querySelectorAll<HTMLButtonElement>("button"),
      ).find((candidate) => candidate.textContent === "Clear journal")!;

      clearButton.click();
      clearButton.click();
      const firstModal = openSpy.mock.instances[0] as OperationJournalClearModal;
      const secondModal = openSpy.mock.instances[1] as OperationJournalClearModal;
      const confirm = (modal: OperationJournalClearModal) =>
        Array.from(
          modal.contentEl.querySelectorAll<HTMLButtonElement>("button"),
        ).find(
          (candidate) => candidate.textContent === "Clear operation journal",
        )!;
      confirm(firstModal).click();
      confirm(secondModal).click();
      await Promise.resolve();
      await Promise.resolve();

      expect(port.clear).toHaveBeenCalledTimes(1);
      first.reject(new Error("partial clear"));
      await flushPromises();
      expect(port.stats).toHaveBeenCalledTimes(1);

      confirm(firstModal).click();
      await flushPromises();
      expect(port.clear).toHaveBeenCalledTimes(2);
      expect(port.stats).toHaveBeenCalledTimes(2);
    });

    it("ignores stale statistics after the tab is replaced", async () => {
      let resolveOld!: (value: {
        bytes: number;
        days: number;
        eventCount: number;
        earliestDate?: string;
      }) => void;
      const oldStats = new Promise<{
        bytes: number;
        days: number;
        eventCount: number;
        earliestDate?: string;
      }>((resolve) => {
        resolveOld = resolve;
      });
      const containerEl = createContainerEl();
      const plugin = createPlugin();
      renderImportExportSettingsTab(
        containerEl,
        plugin as unknown as RssDashboardPlugin,
        createOperationJournalPort({ stats: vi.fn(() => oldStats) }),
      );

      containerEl.empty();
      renderImportExportSettingsTab(
        containerEl,
        plugin as unknown as RssDashboardPlugin,
        createOperationJournalPort({
          stats: vi.fn(async () => ({
            bytes: 2_048,
            days: 2,
            eventCount: 4,
            earliestDate: "2026-07-29",
          })),
        }),
      );
      await flushPromises();
      resolveOld({
        bytes: 999_999,
        days: 99,
        eventCount: 99,
        earliestDate: "1900-01-01",
      });
      await flushPromises();

      expect(containerEl.textContent).toContain("2 KB");
      expect(containerEl.textContent).not.toContain("999,999");
      expect(containerEl.textContent).not.toContain("1900-01-01");
    });

    it("delegates data.json mutation to the transactional plugin entrypoint", async () => {
      const containerEl = createContainerEl();
      const plugin = createPlugin();
      renderImportExportSettingsTab(
        containerEl,
        plugin as unknown as RssDashboardPlugin,
      );
      const button = Array.from(
        containerEl.querySelectorAll<HTMLButtonElement>("button"),
      ).find((candidate) => candidate.textContent === "Import data.json")!;
      button.click();
      const input = Array.from(
        document.body.querySelectorAll<HTMLInputElement>('input[type="file"]'),
      ).at(-1)!;
      Object.defineProperty(input, "files", {
        configurable: true,
        value: [new File([JSON.stringify({ locale: "zh-CN" })], "data.json")],
      });
      input.dispatchEvent(new Event("change"));
      await flushPromises();
      await flushPromises();

      expect(plugin.importDataJsonFromFile).toHaveBeenCalledWith(
        expect.objectContaining({ name: "data.json" }),
      );
      expect(plugin.saveSettings).not.toHaveBeenCalled();
    });

    it("calls shard data export when Export shard data is clicked", () => {
      const containerEl = createContainerEl();
      const plugin = createPlugin();

      renderImportExportSettingsTab(
        containerEl,
        plugin as unknown as RssDashboardPlugin,
      );

      const exportButton = Array.from(
        containerEl.querySelectorAll<HTMLButtonElement>("button"),
      ).find(
        (button) => button.textContent === "Export safe configuration",
      ) as HTMLButtonElement;

      exportButton.click();
      expect(plugin.exportPortableDataBundle).toHaveBeenCalledTimes(1);
    });

    it("renders Factory Reset after the Auto backups section", () => {
      const containerEl = createContainerEl();
      const plugin = createPlugin();

      renderImportExportSettingsTab(
        containerEl,
        plugin as unknown as RssDashboardPlugin,
      );

      const settingNames = Array.from(
        containerEl.querySelectorAll<HTMLElement>(".setting-item-name"),
      ).map((el) => el.textContent?.trim());

      expect(settingNames.indexOf("Auto backups")).toBeGreaterThan(-1);
      expect(settingNames.indexOf("Factory reset")).toBeGreaterThan(
        settingNames.indexOf("Auto backups"),
      );

      const resetSetting = getSettingByName(containerEl, "Factory reset");
      expect(resetSetting.textContent).toContain(
        "Restore all plugin settings to their default values",
      );
    });

    it("does not reset when the confirmation modal is cancelled", async () => {
      const containerEl = createContainerEl();
      const plugin = createPlugin();

      const openSpy = vi
        .spyOn(FactoryResetConfirmModal.prototype, "open")
        .mockImplementation(() => {});
      vi.spyOn(
        FactoryResetConfirmModal.prototype,
        "waitForClose",
      ).mockResolvedValue(false);

      renderImportExportSettingsTab(
        containerEl,
        plugin as unknown as RssDashboardPlugin,
      );

      const resetButton = Array.from(
        containerEl.querySelectorAll<HTMLButtonElement>("button"),
      ).find(
        (button) => button.textContent === "Factory reset",
      ) as HTMLButtonElement;
      expect(resetButton).toBeTruthy();

      resetButton.click();
      await flushPromises();

      expect(openSpy).toHaveBeenCalledTimes(1);
      expect(plugin.performFactoryReset).not.toHaveBeenCalled();
    });

    it("runs the factory reset when the confirmation modal is confirmed", async () => {
      const containerEl = createContainerEl();
      const plugin = createPlugin();

      const openSpy = vi
        .spyOn(FactoryResetConfirmModal.prototype, "open")
        .mockImplementation(() => {});
      vi.spyOn(
        FactoryResetConfirmModal.prototype,
        "waitForClose",
      ).mockResolvedValue(true);

      renderImportExportSettingsTab(
        containerEl,
        plugin as unknown as RssDashboardPlugin,
      );

      const resetButton = Array.from(
        containerEl.querySelectorAll<HTMLButtonElement>("button"),
      ).find(
        (button) => button.textContent === "Factory reset",
      ) as HTMLButtonElement;

      resetButton.click();
      await flushPromises();

      expect(openSpy).toHaveBeenCalledTimes(1);
      expect(plugin.performFactoryReset).toHaveBeenCalledTimes(1);
    });
  });
});
