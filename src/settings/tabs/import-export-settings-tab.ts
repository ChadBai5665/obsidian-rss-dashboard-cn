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
import { AutoBackupSettings } from "../../types/types";
import { createTranslator } from "../../i18n";
import { DiagnosticsPreviewModal } from "../../modals/diagnostics-preview-modal";
import { OperationJournalClearModal } from "../../modals/operation-journal-clear-modal";

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
  plugin: RssDashboardPlugin, operationJournal?: OperationJournalSettingsPort,
): void {
  const isCurrentRender = beginSettingsRender(containerEl, plugin);
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
              try {
                await plugin.importDataJsonFromFile(file);
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
                console.error("[RSS Dashboard] Shard data import failed:", e);
                new Notice(t("settings.import.shardsFailed"));
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
                console.error("[RSS Dashboard] Preferences import failed:", e);
                new Notice(t("settings.import.preferencesFailed"));
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
  // ── Opt-in safe diagnostics ──────────────────────────────────────────────
  const diagnosticsSection = containerEl.createDiv();
  new Setting(diagnosticsSection)
    .setName(t("settings.diagnostics.title"))
    .setDesc(t("settings.diagnostics.desc"))
    .setHeading();
  new Setting(diagnosticsSection).addButton((button) =>
    button
      .setIcon("clipboard-list")
      .setButtonText(t("settings.diagnostics.preview"))
      .onClick(() => {
        try {
          const preview = snapshotTrustedPreview(plugin.createSafeDiagnosticsPreview());
          new DiagnosticsPreviewModal(plugin.app, {
            locale: plugin.settings.locale ?? "zh-CN",
            preview,
            copyPreview: (token, exactPreview) =>
              plugin.copySafeDiagnosticsPreview(token, exactPreview),
            revokePreview: (token) =>
              plugin.revokeSafeDiagnosticsPreview(token),
          }).open();
        } catch {
          new Notice(t("settings.diagnostics.unavailable"));
        }
      }),
  );
  renderOperationJournalSettings(diagnosticsSection, plugin, resolveOperationJournalSettings(plugin, operationJournal), t, isCurrentRender);
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

export interface OperationJournalSettingsPort {
  stats(): Promise<
    import("../../operation-journal/operation-journal-repository").OperationJournalStats
  >;
  createPreview(
    days: 7 | 30,
  ): Promise<Readonly<{ token: string; text: string }>>;
  copyPreview(token: string, exactText: string): Promise<void>;
  revokePreview(token: string): void;
  clear(): Promise<void>;
  openDashboard(): Promise<void>;
}

const settingsRenderGenerations = new WeakMap<object, number>();
const operationJournalClearFlights = new WeakMap<object, Promise<void>>();

function resolveOperationJournalSettings(
  plugin: RssDashboardPlugin,
  explicit: OperationJournalSettingsPort | undefined,
): OperationJournalSettingsPort | undefined {
  if (explicit !== undefined) return explicit;
  try {
    const provider = (
      plugin as RssDashboardPlugin & {
        getOperationJournalSettings?: () => OperationJournalSettingsPort;
      }
    ).getOperationJournalSettings;
    return typeof provider === "function" ? provider.call(plugin) : undefined;
  } catch {
    return undefined;
  }
}

function beginSettingsRender(
  containerEl: HTMLElement,
  plugin: RssDashboardPlugin,
): (ownedElement?: HTMLElement) => boolean {
  const renderGeneration =
    (settingsRenderGenerations.get(plugin) ?? 0) + 1;
  settingsRenderGenerations.set(plugin, renderGeneration);
  try {
    plugin.revokeAllSafeDiagnosticsPreviews();
  } catch {
    // A diagnostics cleanup failure must not prevent the settings tab opening.
  }
  return (ownedElement?: HTMLElement): boolean =>
    settingsRenderGenerations.get(plugin) === renderGeneration &&
    containerEl.isConnected &&
    (ownedElement === undefined || containerEl.contains(ownedElement));
}

function clearOperationJournalOnce(
  operationJournal: OperationJournalSettingsPort,
): Promise<void> {
  const existing = operationJournalClearFlights.get(operationJournal);
  if (existing !== undefined) return existing;
  const started = Promise.resolve().then(() => operationJournal.clear());
  const flight = started.finally(() => {
    if (operationJournalClearFlights.get(operationJournal) === flight) {
      operationJournalClearFlights.delete(operationJournal);
    }
  });
  operationJournalClearFlights.set(operationJournal, flight);
  return flight;
}

function renderOperationJournalSettings(
  diagnosticsSection: HTMLElement,
  plugin: RssDashboardPlugin,
  operationJournal: OperationJournalSettingsPort | undefined,
  t: ReturnType<typeof createTranslator>,
  isCurrentRender: (ownedElement?: HTMLElement) => boolean,
): void {
  const journalSetting = new Setting(diagnosticsSection)
    .setName(t("settings.operationJournal.title"))
    .setDesc(
      operationJournal
        ? t("settings.operationJournal.loading")
        : t("settings.operationJournal.unavailable"),
    );
  let statsGeneration = 0;
  const refreshJournalStats = async (): Promise<void> => {
    const requestGeneration = ++statsGeneration;
    if (!operationJournal) return;
    try {
      const stats = snapshotOperationJournalStats(
        await operationJournal.stats(),
      );
      if (
        requestGeneration !== statsGeneration ||
        !isCurrentRender(journalSetting.settingEl)
      ) {
        return;
      }
      journalSetting.setDesc(
        t("settings.operationJournal.stats", {
          bytes: formatJournalBytes(stats.bytes),
          days: stats.days,
          earliest:
            stats.earliestDate ?? t("settings.operationJournal.noRecords"),
        }),
      );
    } catch {
      if (
        requestGeneration === statsGeneration &&
        isCurrentRender(journalSetting.settingEl)
      ) {
        journalSetting.setDesc(t("settings.operationJournal.unavailable"));
      }
    }
  };

  let previewPending = false;
  journalSetting
    .addButton((button) => {
      button
        .setIcon("clipboard-list")
        .setButtonText(t("settings.operationJournal.view"))
        .onClick(() => {
          if (!operationJournal) return;
          void Promise.resolve()
            .then(() => operationJournal.openDashboard())
            .catch(() => {
              if (isCurrentRender(journalSetting.settingEl)) {
                new Notice(t("settings.operationJournal.unavailable"));
              }
            });
        });
      button.buttonEl.disabled = operationJournal === undefined;
    })
    .addButton((button) => {
      button
        .setIcon("download")
        .setButtonText(t("settings.operationJournal.export"))
        .onClick(() => {
          if (!operationJournal || previewPending) return;
          previewPending = true;
          button.buttonEl.disabled = true;
          void Promise.resolve()
            .then(() => operationJournal.createPreview(30))
            .then((candidate) => {
              const preview = snapshotTrustedPreview(candidate);
              if (!isCurrentRender(journalSetting.settingEl)) {
                try {
                  operationJournal.revokePreview(preview.token);
                } catch {
                  // A stale preview remains unusable after its five-minute TTL.
                }
                return;
              }
              new DiagnosticsPreviewModal(plugin.app, {
                locale: plugin.settings.locale ?? "zh-CN",
                kind: "operation-journal",
                preview,
                copyPreview: (token, exactText) =>
                  operationJournal.copyPreview(token, exactText),
                revokePreview: (token) =>
                  operationJournal.revokePreview(token),
              }).open();
            })
            .catch(() => {
              if (isCurrentRender(journalSetting.settingEl)) {
                new Notice(t("settings.operationJournal.previewUnavailable"));
              }
            })
            .finally(() => {
              previewPending = false;
              if (isCurrentRender(journalSetting.settingEl)) {
                button.buttonEl.disabled = false;
              }
            });
        });
      button.buttonEl.disabled = operationJournal === undefined;
    })
    .addButton((button) => {
      button
        .setIcon("trash-2")
        .setButtonText(t("settings.operationJournal.clear"))
        .setWarning()
        .onClick(() => {
          if (!operationJournal) return;
          try {
            new OperationJournalClearModal(plugin.app, {
              locale: plugin.settings.locale ?? "zh-CN",
              clear: () => clearOperationJournalOnce(operationJournal),
              onCleared: () => refreshJournalStats(),
            }).open();
          } catch {
            if (isCurrentRender(journalSetting.settingEl)) {
              new Notice(t("settings.operationJournal.unavailable"));
            }
          }
        });
      button.buttonEl.disabled = operationJournal === undefined;
    });
  void refreshJournalStats();
}

function snapshotTrustedPreview(
  value: unknown,
): Readonly<{ token: string; text: string }> {
  if (value === null || typeof value !== "object") {
    throw new Error("Invalid trusted preview.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const token = descriptors.token;
  const text = descriptors.text;
  if (
    token === undefined ||
    text === undefined ||
    "get" in token ||
    "get" in text ||
    typeof token.value !== "string" ||
    typeof text.value !== "string"
  ) {
    throw new Error("Invalid trusted preview.");
  }
  return Object.freeze({ token: token.value, text: text.value });
}

function snapshotOperationJournalStats(
  value: unknown,
): import("../../operation-journal/operation-journal-repository").OperationJournalStats {
  if (value === null || typeof value !== "object") {
    throw new Error("Invalid operation journal statistics.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const bytes = descriptors.bytes;
  const days = descriptors.days;
  const eventCount = descriptors.eventCount;
  const earliestDate = descriptors.earliestDate;
  if (
    bytes === undefined ||
    days === undefined ||
    eventCount === undefined ||
    "get" in bytes ||
    "get" in days ||
    "get" in eventCount ||
    (earliestDate !== undefined && "get" in earliestDate) ||
    !isNonNegativeInteger(bytes.value) ||
    !isNonNegativeInteger(days.value) ||
    !isNonNegativeInteger(eventCount.value) ||
    (earliestDate !== undefined &&
      (typeof earliestDate.value !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/u.test(earliestDate.value)))
  ) {
    throw new Error("Invalid operation journal statistics.");
  }
  return Object.freeze({
    bytes: bytes.value,
    days: days.value,
    eventCount: eventCount.value,
    ...(earliestDate === undefined
      ? {}
      : { earliestDate: earliestDate.value as string }),
  });
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function formatJournalBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) {
    return `${formatSingleDecimal(bytes / 1_024)} KB`;
  }
  return `${formatSingleDecimal(bytes / (1_024 * 1_024))} MB`;
}

function formatSingleDecimal(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
