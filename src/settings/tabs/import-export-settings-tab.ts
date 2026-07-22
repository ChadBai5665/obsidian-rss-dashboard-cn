/**
 * Import/Export Settings Tab renderer.
 *
 * Extracted from the monolithic settings-tab.ts.
 * Exports:
 *   - renderImportExportSettingsTab(containerEl, plugin)
 */
import { Notice, Setting } from "obsidian";
import type RssDashboardPlugin from "../../../main";
import { ImportOpmlModal } from "../../modals/import-opml-modal";
import { ImportSuccessModal } from "../../modals/import-success-modal";
import { FactoryResetConfirmModal } from "../modals/settings-modals";
import { AutoBackupSettings, RssDashboardSettings } from "../../types/types";
import { createTranslator } from "../../i18n";
import { loadAndNormalizeSettings } from "../../utils/settings-loader";

/** @deprecated Import from settings-modals; this re-export preserves integrations. */
export { FactoryResetConfirmModal } from "../modals/settings-modals";

/**
 * Returns a fresh copy of the default auto-backup settings.
 */
export function buildDefaultAutoBackupSettings(): AutoBackupSettings {
  return {
    backupDataJson: false,
    backupOpml: true,
    backupUserdata: true,
  };
}

/**
 * Appends .backup to the provided filename.
 */
export function getBackupFilename(filename: string): string {
  return `${filename}.backup`;
}

export function renderImportExportSettingsTab(
  containerEl: HTMLElement,
  plugin: RssDashboardPlugin,
): void {
  const t = createTranslator(plugin.settings.locale ?? "zh-CN");
  // ── data.json ─────────────────────────────────────────────────────────────
  const dataSection = containerEl.createDiv();
  new Setting(dataSection)
    .setName(t("settings.import.data"))
    .setDesc(t("settings.import.dataDesc"))
    .setHeading();

  const dataActionsSetting = new Setting(dataSection);
  dataActionsSetting.settingEl.addClass("rss-dashboard-import-export-actions");
  dataActionsSetting
    .addButton((button) =>
      button
        .setIcon("upload")
        .setButtonText(t("settings.import.importData"))
        .onClick(() => {
          const input = activeDocument.body.createEl("input", {
            attr: { type: "file", accept: ".json,.backup,application/json" },
          });
          input.onchange = () => {
            void (async () => {
              const file = input.files?.[0];
              if (!file) return;
              const text = await file.text();
              try {
                const data = JSON.parse(text) as Partial<RssDashboardSettings>;
                plugin.settings = loadAndNormalizeSettings(
                  Object.assign({}, plugin.settings, data),
                );
                await plugin.saveSettings();
                const view = await plugin.getActiveDashboardView();
                if (view) {
                  await plugin.app.workspace.revealLeaf(view.leaf);
                  view.render();
                }
                const finalLocale = plugin.settings.locale ?? "zh-CN";
                const finalT = createTranslator(finalLocale);
                new ImportSuccessModal(
                  plugin.app,
                  finalT("modal.importSuccess.data"),
                  finalLocale,
                ).open();
              } catch (error) {
                console.error(
                  "[RSS Dashboard] data.json import failed:",
                  error,
                );
                const errorT = createTranslator(
                  plugin.settings.locale ?? "zh-CN",
                );
                new Notice(errorT("modal.importSuccess.dataFailed"));
              }
            })();
          };
          input.click();
        }),
    )
    .addButton((button) =>
      button
        .setIcon("download")
        .setButtonText(t("settings.import.exportData"))
        .onClick(() => {
          void plugin.exportDataJson();
        }),
    )
    .addButton((button) =>
      button
        .setIcon("copy")
        .setTooltip(t("settings.import.copyData"))
        .onClick(() => {
          void plugin.copyDataJsonToClipboard();
        }),
    );

  // ── Shard Data ────────────────────────────────────────────────────────────
  const portableBundleSection = containerEl.createDiv();
  new Setting(portableBundleSection)
    .setName(t("settings.import.shards"))
    .setDesc(t("settings.import.shardsDesc"))
    .setHeading();

  const portableBundleActions = new Setting(portableBundleSection);
  portableBundleActions.settingEl.addClass(
    "rss-dashboard-import-export-actions",
  );
  portableBundleActions
    .addButton((button) =>
      button
        .setIcon("upload")
        .setButtonText(t("settings.import.importShards"))
        .onClick(() => {
          const input = activeDocument.body.createEl("input", {
            attr: { type: "file", accept: ".json,.backup,application/json" },
          });
          input.onchange = () => {
            void (async () => {
              const file = input.files?.[0];
              if (!file) return;
              try {
                await plugin.importPortableDataBundleFromFile(file);
                new ImportSuccessModal(
                  plugin.app,
                  t("modal.importSuccess.shards"),
                  plugin.settings.locale,
                ).open();
              } catch (e) {
                new Notice(
                  `Shard data import failed: ${e instanceof Error ? e.message : "invalid file"}`,
                );
              }
            })();
          };
          input.click();
        }),
    )
    .addButton((button) =>
      button
        .setIcon("download")
        .setButtonText(t("settings.import.exportShards"))
        .onClick(() => {
          void plugin.exportPortableDataBundle();
        }),
    );

  // ── usersettings.json ─────────────────────────────────────────────────────
  const userSettingsSection = containerEl.createDiv();
  new Setting(userSettingsSection)
    .setName(t("settings.import.preferences"))
    .setDesc(t("settings.import.preferencesDesc"))
    .setHeading();

  const userSettingsActions = new Setting(userSettingsSection);
  userSettingsActions.settingEl.addClass("rss-dashboard-import-export-actions");
  userSettingsActions
    .addButton((button) =>
      button
        .setIcon("upload")
        .setButtonText(t("settings.import.importPreferences"))
        .onClick(() => {
          const input = activeDocument.body.createEl("input", {
            attr: { type: "file", accept: ".json,.backup,application/json" },
          });
          input.onchange = () => {
            void (async () => {
              const file = input.files?.[0];
              if (!file) return;
              try {
                await plugin.importUserSettingsJsonFromFile(file);
                new ImportSuccessModal(
                  plugin.app,
                  t("modal.importSuccess.preferences"),
                  plugin.settings.locale,
                ).open();
              } catch (e) {
                new Notice(
                  `Import failed: ${e instanceof Error ? e.message : "invalid file"}`,
                );
              }
            })();
          };
          input.click();
        }),
    )
    .addButton((button) =>
      button
        .setIcon("download")
        .setButtonText(t("settings.import.exportPreferences"))
        .onClick(() => {
          void plugin.exportUserSettingsJson();
        }),
    )
    .addButton((button) =>
      button
        .setIcon("copy")
        .setTooltip(t("settings.import.copyPreferences"))
        .onClick(() => {
          void plugin.copyUserSettingsJsonToClipboard();
        }),
    );

  // ── OPML ──────────────────────────────────────────────────────────────────
  const opmlSection = containerEl.createDiv();
  new Setting(opmlSection)
    .setName("OPML")
    .setDesc(t("settings.import.opmlDesc"))
    .setHeading();

  const opmlActionsSetting = new Setting(opmlSection);
  opmlActionsSetting.settingEl.addClass("rss-dashboard-import-export-actions");
  opmlActionsSetting
    .addButton((button) =>
      button
        .setIcon("upload")
        .setButtonText(t("command.importOpml"))
        .onClick(() => {
          new ImportOpmlModal(plugin.app, plugin).open();
        }),
    )
    .addButton((button) =>
      button
        .setIcon("download")
        .setButtonText(t("command.exportOpml"))
        .onClick(() => plugin.exportOpml()),
    )
    .addButton((button) =>
      button
        .setIcon("copy")
        .setTooltip(t("settings.import.copyOpml"))
        .onClick(() => {
          void plugin.copyOpmlToClipboard();
        }),
    );

  // ── Auto Backups ──────────────────────────────────────────────────────────
  const backupSection = containerEl.createDiv();
  new Setting(backupSection)
    .setName(t("settings.import.backups"))
    .setDesc(t("settings.import.backupsDesc"))
    .setHeading();

  new Setting(backupSection)
    .setName(t("settings.import.backupData"))
    .setDesc(t("settings.import.backupDataDesc"))
    .addToggle((toggle) =>
      toggle
        .setValue(plugin.settings.autoBackup.backupDataJson)
        .onChange(async (value) => {
          plugin.settings.autoBackup.backupDataJson = value;
          await plugin.saveSettings();
        }),
    );

  new Setting(backupSection)
    .setName(t("settings.import.backupFeeds"))
    .setDesc(t("settings.import.backupFeedsDesc"))
    .addToggle((toggle) =>
      toggle
        .setValue(plugin.settings.autoBackup.backupOpml)
        .onChange(async (value) => {
          plugin.settings.autoBackup.backupOpml = value;
          await plugin.saveSettings();
        }),
    );

  new Setting(backupSection)
    .setName(t("settings.import.backupPreferences"))
    .setDesc(t("settings.import.backupPreferencesDesc"))
    .addToggle((toggle) =>
      toggle
        .setValue(plugin.settings.autoBackup.backupUserdata)
        .onChange(async (value) => {
          plugin.settings.autoBackup.backupUserdata = value;
          await plugin.saveSettings();
        }),
    );

  // ── Factory Reset ─────────────────────────────────────────────────────────
  const factoryResetSection = containerEl.createDiv();
  new Setting(factoryResetSection)
    .setName(t("settings.import.reset"))
    .setDesc(t("settings.import.resetDesc"))
    .setHeading();

  const factoryResetActions = new Setting(factoryResetSection);
  factoryResetActions.settingEl.addClass("rss-dashboard-import-export-actions");
  factoryResetActions.addButton((button) =>
    button
      .setIcon("rotate-ccw")
      .setButtonText(t("settings.import.reset"))
      .setWarning()
      .onClick(() => {
        void (async () => {
          const confirmModal = new FactoryResetConfirmModal(
            plugin.app,
            plugin.settings.locale,
          );
          confirmModal.open();
          const shouldReset = await confirmModal.waitForClose();
          if (!shouldReset) {
            return;
          }

          await plugin.performFactoryReset();
        })();
      }),
  );
}
