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

type ObsidianHTMLElement = HTMLElement & {
  empty: () => void;
  createDiv: () => HTMLDivElement;
};

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function cloneSettings(): typeof DEFAULT_SETTINGS {
  return JSON.parse(
    JSON.stringify(DEFAULT_SETTINGS),
  ) as typeof DEFAULT_SETTINGS;
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
  return {
    app: obsidian.App.createMock(),
    settings: cloneSettings(),
    saveSettings: vi.fn(async () => {}),
    exportDataJson: vi.fn(async () => {}),
    copyDataJsonToClipboard: vi.fn(async () => {}),
    importUserSettingsJsonFromFile: vi.fn(async () => {}),
    exportUserSettingsJson: vi.fn(async () => {}),
    copyUserSettingsJsonToClipboard: vi.fn(async () => {}),
    exportOpml: vi.fn(async () => {}),
    copyOpmlToClipboard: vi.fn(async () => {}),
    exportPortableDataBundle: vi.fn(async () => {}),
    importPortableDataBundleFromFile: vi.fn(async () => {}),
    getActiveDashboardView: vi.fn(async () => null),
    performFactoryReset: vi.fn(async () => {}),
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
        ).find((button) => button.textContent === "Import data.json")!;
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
        (button) => button.textContent === "Factory reset",
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

      const portableSetting = getSettingByName(containerEl, "Shard data");
      expect(portableSetting.textContent).toContain("cross-device migration");

      const buttons = Array.from(
        containerEl.querySelectorAll<HTMLButtonElement>("button"),
      ).map((button) => button.textContent?.trim());
      expect(buttons).toContain("Import shard data");
      expect(buttons).toContain("Export shard data");
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
        (button) => button.textContent === "Export shard data",
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
