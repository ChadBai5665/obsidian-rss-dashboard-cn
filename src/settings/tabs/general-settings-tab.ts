/**
 * General Settings Tab renderer.
 *
 * Extracted from the monolithic settings-tab.ts.
 * Exports:
 *   - renderGeneralSettingsTab(containerEl, plugin) — main render function
 *   - REFRESH_INTERVAL_PRESETS, isPresetRefreshInterval  — testable helpers
 *   - MAX_ITEMS_PRESETS, isPresetMaxItems                — testable helpers
 *   - AUTO_DELETE_PRESETS, isPresetAutoDeleteDuration    — testable helpers
 */
import { App, Notice, Setting, WorkspaceLeaf } from "obsidian";
import { setCssProps } from "../../utils/platform-utils";
import { normalizeRefreshIntervalMinutes } from "../../utils/validation";
import { isPresetRefreshInterval } from "../../utils/refresh-intervals";
export {
  REFRESH_INTERVAL_PRESETS,
  isPresetRefreshInterval,
} from "../../utils/refresh-intervals";
import {
  getPageSizeOptions,
  PAGE_SIZE_OPTIONS,
} from "../../utils/page-size-options";
import { ApplyMaxItemsToExistingFeedsModal } from "../modals/settings-modals";
import type { RssDashboardSettings } from "../../types/types";
import { PREDEFINED_PROXIES } from "../../utils/proxy-utils";
import { createTranslator } from "../../i18n";

export interface GeneralSettingsPlugin {
  app: App;
  settingTab: { display(): void } | null;
  settings: RssDashboardSettings;
  saveSettings(): Promise<void>;
  getActiveDashboardView(): Promise<{
    leaf: WorkspaceLeaf;
    render(): void;
  } | null>;
  importPortableDataBundleFromFile(file: File): Promise<void>;
  exportPortableDataBundle(): Promise<void>;
  applyFeedLimitsToAllFeeds(): Promise<void>;
  refreshLocalizedViews?(): void;
  refreshFeeds(): Promise<void>;
}

// ── Pure preset helpers (exported for testing) ───────────────────────────────

export const MAX_ITEMS_PRESETS = [0, 10, 25, 50, 100, 200, 500, 1000];
export const AUTO_DELETE_PRESETS = [0, 1, 3, 7, 14, 30, 60, 90, 180, 365];

export function isPresetMaxItems(value: number): boolean {
  return MAX_ITEMS_PRESETS.includes(value);
}

export function isPresetAutoDeleteDuration(value: number): boolean {
  return AUTO_DELETE_PRESETS.includes(value);
}

// ── Tab renderer ─────────────────────────────────────────────────────────────

export function renderGeneralSettingsTab(
  containerEl: HTMLElement,
  plugin: GeneralSettingsPlugin,
): void {
  const t = createTranslator(plugin.settings.locale);
  new Setting(containerEl)
    .setName(t("settings.language"))
    .setDesc(t("settings.languageDesc"))
    .addDropdown((dropdown) =>
      dropdown
        .addOption("zh-CN", t("settings.languageChinese"))
        .addOption("en", t("settings.languageEnglish"))
        .setValue(plugin.settings.locale)
        .onChange(async (value) => {
          plugin.settings.locale = value === "en" ? "en" : "zh-CN";
          await plugin.saveSettings();
          plugin.refreshLocalizedViews?.();
          plugin.settingTab?.display();
          new Notice(createTranslator(plugin.settings.locale)("notice.commandNamesReload"));
        }),
    );

  new Setting(containerEl)
    .setName(t("settings.general.viewStyle"))
    .setDesc(t("settings.general.viewStyleDesc"))
    .addDropdown((dropdown) =>
      dropdown
        .addOption("list", t("settings.general.listView"))
        .addOption("card", t("settings.general.cardView"))
        .addOption("feed", t("settings.general.feedView"))
        .setValue(plugin.settings.viewStyle)
        .onChange(async (value: string) => {
          plugin.settings.viewStyle = value as "list" | "card" | "feed";
          await plugin.saveSettings();
          const view = await plugin.getActiveDashboardView();
          if (view) {
            await plugin.app.workspace.revealLeaf(view.leaf);
            view.render();
          }
        }),
    );

  new Setting(containerEl)
    .setName(t("settings.general.dashboardLocation"))
    .setDesc(t("settings.general.dashboardLocationDesc"))
    .addDropdown((dropdown) =>
      dropdown
        .addOption("main", t("settings.general.mainView"))
        .addOption("right-sidebar", t("settings.general.rightSidebar"))
        .addOption("left-sidebar", t("settings.general.leftSidebar"))
        .setValue(plugin.settings.viewLocation)
        .onChange(async (value: string) => {
          plugin.settings.viewLocation =
            value as import("../../types/types").ViewLocation;
          await plugin.saveSettings();
        }),
    );

  new Setting(containerEl)
    .setName(t("settings.general.readerLocation"))
    .setDesc(t("settings.general.readerLocationDesc"))
    .addDropdown((dropdown) =>
      dropdown
        .addOption("main", t("settings.general.mainViewSplit"))
        .addOption("right-sidebar", t("settings.general.rightSidebar"))
        .addOption("left-sidebar", t("settings.general.leftSidebar"))
        .addOption("inline", t("settings.general.inline"))
        .addOption("external-browser", t("settings.general.externalBrowser"))
        .setValue(plugin.settings.readerViewLocation || "main")
        .onChange(async (value: string) => {
          plugin.settings.readerViewLocation =
            value as import("../../types/types").ViewLocation;
          await plugin.saveSettings();
        }),
    );

  new Setting(containerEl)
    .setName(t("settings.general.savedLocation"))
    .setDesc(t("settings.general.savedLocationDesc"))
    .addDropdown((dropdown) =>
      dropdown
        .addOption("main", t("settings.general.mainViewSplit"))
        .addOption("right-sidebar", t("settings.general.rightSidebar"))
        .addOption("left-sidebar", t("settings.general.leftSidebar"))
        .addOption("inline", t("settings.general.inline"))
        .setValue(plugin.settings.savedArticleOpenLocation || "main")
        .onChange(async (value: string) => {
          plugin.settings.savedArticleOpenLocation =
            value as import("../../types/types").ViewLocation;
          await plugin.saveSettings();
        }),
    );

  new Setting(containerEl)
    .setName(t("settings.general.webViewer"))
    .setDesc(t("settings.general.webViewerDesc"))
    .addToggle((toggle) =>
      toggle
        .setValue(plugin.settings.useWebViewer || false)
        .onChange(async (value) => {
          plugin.settings.useWebViewer = value;
          await plugin.saveSettings();
        }),
    );

  new Setting(containerEl)
    .setName(t("settings.general.pageSize"))
    .setDesc(t("settings.general.pageSizeDesc"))
    .addDropdown((dropdown) => {
      const pageSizes = [
        plugin.settings.allArticlesPageSize,
        plugin.settings.unreadArticlesPageSize,
        plugin.settings.readArticlesPageSize,
        plugin.settings.savedArticlesPageSize,
        plugin.settings.starredArticlesPageSize,
      ];
      const uniqueSizes = new Set(pageSizes);
      const isMixed = uniqueSizes.size > 1;

      if (isMixed) {
        dropdown.addOption("mixed", t("settings.general.mixedPageSize"));
      }

      const options = getPageSizeOptions(plugin.settings.allArticlesPageSize);
      for (const size of options) {
        const label =
          size === 0
            ? t("settings.general.all")
            : PAGE_SIZE_OPTIONS.includes(
                  size as (typeof PAGE_SIZE_OPTIONS)[number],
                )
              ? String(size)
              : t("settings.general.currentPageSize", { size });
        dropdown.addOption(String(size), label);
      }

      dropdown.setValue(
        isMixed ? "mixed" : String(plugin.settings.allArticlesPageSize),
      );

      dropdown.onChange(async (value) => {
        if (value === "mixed") {
          return;
        }
        const size = Number(value);
        if (!Number.isFinite(size) || size < 0) {
          return;
        }

        plugin.settings.allArticlesPageSize = size;
        plugin.settings.unreadArticlesPageSize = size;
        plugin.settings.readArticlesPageSize = size;
        plugin.settings.savedArticlesPageSize = size;
        plugin.settings.starredArticlesPageSize = size;

        await plugin.saveSettings();
        const view = await plugin.getActiveDashboardView();
        if (view) {
          await plugin.app.workspace.revealLeaf(view.leaf);
          view.render();
        }
      });
    });

  new Setting(containerEl).setName(t("settings.general.globalFeeds")).setHeading();

  // ── Refresh interval ──────────────────────────────────────────────────────
  const refreshIntervalSetting = new Setting(containerEl)
    .setName(t("settings.general.refreshInterval"))
    .setDesc(t("settings.general.refreshIntervalDesc"));

  let refreshInterval = plugin.settings.refreshInterval;
  let refreshIntervalCustomInput: HTMLInputElement | null = null;

  refreshIntervalSetting.addDropdown((dropdown) => {
    dropdown
      .addOption("0", t("settings.general.off"))
      .addOption("5", t("settings.general.minutes", { count: 5 }))
      .addOption("10", t("settings.general.minutes", { count: 10 }))
      .addOption("15", t("settings.general.minutes", { count: 15 }))
      .addOption("30", t("settings.general.minutes", { count: 30 }))
      .addOption("60", t("settings.general.hours", { count: 1, plural: "" }))
      .addOption("120", t("settings.general.hours", { count: 2, plural: "s" }))
      .addOption("240", t("settings.general.hours", { count: 4, plural: "s" }))
      .addOption("480", t("settings.general.hours", { count: 8, plural: "s" }))
      .addOption("720", t("settings.general.hours", { count: 12, plural: "s" }))
      .addOption("1440", t("settings.general.hours", { count: 24, plural: "s" }))
      .addOption("custom", t("settings.general.custom"))
      .setValue(
        isPresetRefreshInterval(refreshInterval)
          ? refreshInterval.toString()
          : "custom",
      )
      .onChange((value) => {
        if (value === "custom") {
          if (!refreshIntervalCustomInput) {
            refreshIntervalCustomInput =
              refreshIntervalSetting.controlEl.createEl("input", {
                type: "number",
                placeholder: t("settings.general.enterMinutes"),
                cls: "rss-custom-input",
              });
            refreshIntervalCustomInput.min = "0";
            refreshIntervalCustomInput.value =
              refreshInterval > 0 ? refreshInterval.toString() : "";
            refreshIntervalCustomInput.addEventListener("change", () => {
              void (async () => {
                const parsed = parseInt(
                  refreshIntervalCustomInput?.value || "",
                  10,
                );
                refreshInterval = normalizeRefreshIntervalMinutes(
                  Number.isFinite(parsed) ? parsed : 0,
                );
                if (refreshIntervalCustomInput) {
                  refreshIntervalCustomInput.value = refreshInterval.toString();
                }
                plugin.settings.refreshInterval = refreshInterval;
                await plugin.saveSettings();
              })();
            });
          }
          refreshIntervalCustomInput.removeClass("hidden");
          refreshIntervalCustomInput.addClass("visible");
          return;
        }

        refreshIntervalCustomInput?.removeClass("visible");
        refreshIntervalCustomInput?.addClass("hidden");
        refreshInterval = normalizeRefreshIntervalMinutes(parseInt(value, 10));
        void (async () => {
          plugin.settings.refreshInterval = refreshInterval;
          await plugin.saveSettings();
        })();
      });
  });

  new Setting(containerEl)
    .setName(t("settings.general.startupDelay"))
    .setDesc(t("settings.general.startupDelayDesc"))
    .addText((text) =>
      text
        .setValue(String(plugin.settings.startupRefreshDelaySeconds))
        .onChange(async (value) => {
          const parsed = Number(value);
          if (!Number.isFinite(parsed) || parsed < 0) return;
          plugin.settings.startupRefreshDelaySeconds = Math.floor(parsed);
          await plugin.saveSettings();
        }),
    );

  new Setting(containerEl).setName(t("settings.general.dailyCollection")).setHeading();

  new Setting(containerEl)
    .setName(t("settings.general.dailyCollection"))
    .setDesc(t("settings.general.dailyCollectionDesc"))
    .addToggle((toggle) =>
      toggle.setValue(plugin.settings.collection.enabled).onChange(async (value) => {
        plugin.settings.collection.enabled = value;
        await plugin.saveSettings();
      }),
    );

  const renderCollectionFolder = (
    nameKey:
      | "settings.general.collectionDataFolder"
      | "settings.general.dailyIndexFolder"
      | "settings.general.savedNotesFolder",
    descKey:
      | "settings.general.collectionDataFolderDesc"
      | "settings.general.dailyIndexFolderDesc"
      | "settings.general.savedNotesFolderDesc",
    settingKey: "dataFolder" | "dailyIndexFolder" | "savedNoteFolder",
  ) => {
    new Setting(containerEl)
      .setName(t(nameKey))
      .setDesc(t(descKey))
      .addText((text) =>
        text
          .setValue(plugin.settings.collection[settingKey])
          .onChange(async (value) => {
            plugin.settings.collection[settingKey] = value.trim();
            await plugin.saveSettings();
          }),
      );
  };

  renderCollectionFolder(
    "settings.general.collectionDataFolder",
    "settings.general.collectionDataFolderDesc",
    "dataFolder",
  );
  renderCollectionFolder(
    "settings.general.dailyIndexFolder",
    "settings.general.dailyIndexFolderDesc",
    "dailyIndexFolder",
  );
  renderCollectionFolder(
    "settings.general.savedNotesFolder",
    "settings.general.savedNotesFolderDesc",
    "savedNoteFolder",
  );

  // ── Max items ─────────────────────────────────────────────────────────────
  let maxItemsPromptTimer: number | null = null;
  let maxItemsPromptOpen = false;
  let pendingMaxItemsChange: { oldValue: number; newValue: number } | null =
    null;

  const queueMaxItemsApplyPrompt = (oldValue: number, newValue: number) => {
    pendingMaxItemsChange = { oldValue, newValue };
    if (maxItemsPromptOpen) return;
    if (maxItemsPromptTimer) {
      window.clearTimeout(maxItemsPromptTimer);
    }
    maxItemsPromptTimer = window.setTimeout(() => {
      maxItemsPromptTimer = null;
      if (maxItemsPromptOpen) return;
      const change = pendingMaxItemsChange;
      pendingMaxItemsChange = null;
      if (!change || change.newValue === change.oldValue) return;

      maxItemsPromptOpen = true;
      void (async () => {
        const modal = new ApplyMaxItemsToExistingFeedsModal(plugin.app, {
          newLimit: change.newValue,
          increased: change.newValue > change.oldValue,
        }, plugin.settings.locale);
        modal.open();
        const action = await modal.waitForClose();
        maxItemsPromptOpen = false;

        if (action === "cancel") return;

        for (const feed of plugin.settings.feeds) {
          feed.maxItemsLimit = change.newValue;
        }

        await plugin.applyFeedLimitsToAllFeeds();

        if (action === "apply-refresh") {
          await plugin.refreshFeeds();
        } else if (change.newValue > change.oldValue) {
          new Notice(
            t("settings.general.maxItemsApplied"),
          );
        }
      })();
    }, 700);
  };

  const applyMaxItemsValue = (nextValue: number) => {
    void (async () => {
      const oldValue = plugin.settings.maxItems;
      if (oldValue === nextValue) return;

      plugin.settings.maxItems = nextValue;
      await plugin.saveSettings();
      const view = await plugin.getActiveDashboardView();
      if (view) {
        await plugin.app.workspace.revealLeaf(view.leaf);
        view.render();
      }

      queueMaxItemsApplyPrompt(oldValue, nextValue);
    })();
  };

  const maxItemsSetting = new Setting(containerEl)
    .setName(t("settings.general.maxItems"))
    .setDesc(t("settings.general.maxItemsDesc"));

  let maxItemsLimit = plugin.settings.maxItems;
  let maxItemsCustomInput: HTMLInputElement | null = null;

  maxItemsSetting.addDropdown((dropdown) => {
    dropdown
      .addOption("0", t("settings.general.unlimited"))
      .addOption("10", t("settings.general.items", { count: 10 }))
      .addOption("25", t("settings.general.items", { count: 25 }))
      .addOption("50", t("settings.general.items", { count: 50 }))
      .addOption("100", t("settings.general.items", { count: 100 }))
      .addOption("200", t("settings.general.items", { count: 200 }))
      .addOption("500", t("settings.general.items", { count: 500 }))
      .addOption("1000", t("settings.general.items", { count: 1000 }))
      .addOption("custom", t("settings.general.custom"))
      .setValue(
        isPresetMaxItems(maxItemsLimit) ? maxItemsLimit.toString() : "custom",
      )
      .onChange((value) => {
        if (value === "custom") {
          if (!maxItemsCustomInput) {
            maxItemsCustomInput = maxItemsSetting.controlEl.createEl("input", {
              type: "number",
              placeholder: t("settings.general.enterNumber"),
              cls: "rss-custom-input",
            });
            maxItemsCustomInput.min = "1";
            maxItemsCustomInput.value =
              maxItemsLimit > 0 ? maxItemsLimit.toString() : "";
            maxItemsCustomInput.addEventListener("change", () => {
              const parsed = parseInt(maxItemsCustomInput?.value || "", 10);
              maxItemsLimit = Number.isFinite(parsed) ? parsed : 0;
              applyMaxItemsValue(maxItemsLimit);
            });
          }
          maxItemsCustomInput.removeClass("hidden");
          maxItemsCustomInput.addClass("visible");
          return;
        }

        maxItemsCustomInput?.removeClass("visible");
        maxItemsCustomInput?.addClass("hidden");
        maxItemsLimit = parseInt(value, 10) || 0;
        applyMaxItemsValue(maxItemsLimit);
      });
  });

  // ── Auto-delete duration ──────────────────────────────────────────────────
  const defaultAutoDeleteSetting = new Setting(containerEl)
    .setName(t("settings.general.autoDelete"))
    .setDesc(t("settings.general.autoDeleteDesc"));

  let defaultDuration = plugin.settings.defaultAutoDeleteDuration;
  let autoDeleteCustomInput: HTMLInputElement | null = null;

  defaultAutoDeleteSetting.addDropdown((dropdown) => {
    dropdown
      .addOption("0", t("settings.general.disabled"))
      .addOption("1", t("settings.general.days", { count: 1 }))
      .addOption("3", t("settings.general.days", { count: 3 }))
      .addOption("7", t("settings.general.weeks", { count: 1 }))
      .addOption("14", t("settings.general.weeks", { count: 2 }))
      .addOption("30", t("settings.general.months", { count: 1 }))
      .addOption("60", t("settings.general.months", { count: 2 }))
      .addOption("90", t("settings.general.months", { count: 3 }))
      .addOption("180", t("settings.general.months", { count: 6 }))
      .addOption("365", t("settings.general.year"))
      .addOption("custom", t("settings.general.custom"))
      .setValue(
        isPresetAutoDeleteDuration(defaultDuration)
          ? defaultDuration.toString()
          : "custom",
      )
      .onChange((value) => {
        if (value === "custom") {
          if (!autoDeleteCustomInput) {
            autoDeleteCustomInput = defaultAutoDeleteSetting.controlEl.createEl(
              "input",
              {
                type: "number",
                placeholder: t("settings.general.enterDays"),
                cls: "rss-custom-input",
              },
            );
            autoDeleteCustomInput.min = "1";
            autoDeleteCustomInput.value =
              defaultDuration > 0 ? defaultDuration.toString() : "";
            autoDeleteCustomInput.addEventListener("change", () => {
              void (async () => {
                const parsed = parseInt(autoDeleteCustomInput?.value || "", 10);
                defaultDuration = Number.isFinite(parsed) ? parsed : 0;
                plugin.settings.defaultAutoDeleteDuration = defaultDuration;
                await plugin.saveSettings();
              })();
            });
          }

          autoDeleteCustomInput.removeClass("hidden");
          autoDeleteCustomInput.addClass("visible");
          return;
        }

        autoDeleteCustomInput?.removeClass("visible");
        autoDeleteCustomInput?.addClass("hidden");
        defaultDuration = parseInt(value, 10) || 0;
        void (async () => {
          plugin.settings.defaultAutoDeleteDuration = defaultDuration;
          await plugin.saveSettings();
        })();
      });
  });

  // ── Proxy ─────────────────────────────────────────────────────────────────
  new Setting(containerEl).setName(t("settings.general.proxy")).setHeading();

  new Setting(containerEl)
    .setName(t("settings.general.enableCors"))
    .setDesc(t("settings.general.enableCorsDesc"))
    .addToggle((toggle) => {
      toggle
        .setValue(plugin.settings.corsProxyEnabled ?? false)
        .onChange(async (value) => {
          plugin.settings.corsProxyEnabled = value;
          await plugin.saveSettings();
          // Re-render the full settings tab to show/hide the URL input.
          // The tab instance calls this renderer so we use a custom event.
          containerEl.dispatchEvent(new CustomEvent("rss-settings-refresh"));
        });
    });

  if (plugin.settings.corsProxyEnabled) {
    const proxySetting = new Setting(containerEl)
      .setName(t("settings.general.proxyUrl"))
      .setDesc(t("settings.general.proxyUrlDesc"));
    proxySetting.settingEl.addClass("rss-proxy-setting-item");

    let textComponent: import("obsidian").TextComponent;
    let saveButton: import("obsidian").ButtonComponent | null = null;
    let lastSavedProxyUrl = (plugin.settings.corsProxyUrl || "").trim();
    let pendingProxyUrl = lastSavedProxyUrl;

    const commitProxyUrl = async (rawValue: string): Promise<void> => {
      const value = rawValue.trim();
      if (value === lastSavedProxyUrl) return;

      if (value === "") {
        plugin.settings.corsProxyUrl = "";
        lastSavedProxyUrl = "";
        pendingProxyUrl = "";
        await plugin.saveSettings();
        return;
      }

      const { isValidUrl } = await import("../../utils/validation");
      const validation = isValidUrl(value);
      if (!validation.valid) {
        pendingProxyUrl = lastSavedProxyUrl;
        textComponent.setValue(lastSavedProxyUrl);
        new Notice(t("settings.general.invalidUrl"));
        return;
      }

      plugin.settings.corsProxyUrl = value;
      lastSavedProxyUrl = value;
      pendingProxyUrl = value;
      await plugin.saveSettings();
    };

    proxySetting
      .addDropdown((dropdown) => {
        dropdown.addOption("", t("settings.general.selectProxy"));
        dropdown.addOption("auto", t("settings.general.autoCycleProxy"));
        PREDEFINED_PROXIES.forEach((proxy) => {
          dropdown.addOption(proxy.url, proxy.label);
        });
        dropdown.addOption("custom", t("settings.general.addProxy"));

        const currentUrl = plugin.settings.corsProxyUrl || "";
        const isPredefined = PREDEFINED_PROXIES.some(
          (p) => p.url === currentUrl,
        );
        if (isPredefined) {
          dropdown.setValue(currentUrl);
        } else if (currentUrl) {
          dropdown.setValue("custom");
        } else {
          dropdown.setValue("");
        }

        dropdown.onChange((value: string) => {
          if (value === "custom") {
            if (saveButton)
              void import("../../utils/platform-utils").then(
                ({ setCssProps }) =>
                  setCssProps(saveButton!.buttonEl, { display: "" }),
              );
          } else {
            if (saveButton)
              void import("../../utils/platform-utils").then(
                ({ setCssProps }) =>
                  setCssProps(saveButton!.buttonEl, { display: "none" }),
              );
            if (value !== "") {
              textComponent.setValue(value);
              void (async () => {
                plugin.settings.corsProxyUrl = value;
                lastSavedProxyUrl = value;
                pendingProxyUrl = value;
                await plugin.saveSettings();
              })();
            }
          }
        });
      })
      .addText((text) => {
        textComponent = text;
        text
          .setPlaceholder("https://proxy.com/?url=")
          .setValue(plugin.settings.corsProxyUrl || "")
          .onChange((value) => {
            pendingProxyUrl = value;
          });

        text.inputEl.addEventListener("blur", () => {
          void commitProxyUrl(pendingProxyUrl);
        });
        text.inputEl.addEventListener("keydown", (evt: KeyboardEvent) => {
          if (evt.key !== "Enter") return;
          void commitProxyUrl(text.getValue());
          text.inputEl.blur();
        });

        setCssProps(text.inputEl, {
          flex: "1 1 auto",
          minWidth: "150px",
        });

        proxySetting.addExtraButton((cb) => {
          cb.setIcon("x")
            .setTooltip(t("settings.general.clear"))
            .onClick(async () => {
              text.setValue("");
              plugin.settings.corsProxyUrl = "";
              lastSavedProxyUrl = "";
              pendingProxyUrl = "";
              await plugin.saveSettings();
            });
        });
      })
      .addButton((btn) => {
        saveButton = btn;
        btn
          .setIcon("save")
          .setTooltip(t("settings.general.saveToList"))
          .onClick(async () => {
            const customUrl = textComponent.getValue().trim();
            const { isValidUrl } = await import("../../utils/validation");
            const validation = isValidUrl(customUrl);
            if (validation.valid) {
              plugin.settings.corsProxyUrl = customUrl;
              lastSavedProxyUrl = customUrl;
              pendingProxyUrl = customUrl;
              await plugin.saveSettings();
              new Notice(t("settings.general.proxySaved"));
              containerEl.dispatchEvent(
                new CustomEvent("rss-settings-refresh"),
              );
            } else {
              new Notice(t("settings.general.invalidUrl"));
            }
          });

        const currentUrl = plugin.settings.corsProxyUrl || "";
        const isPredefined =
          currentUrl === "auto" ||
          PREDEFINED_PROXIES.some((p) => p.url === currentUrl);
        if (isPredefined || !currentUrl) {
          void import("../../utils/platform-utils").then(({ setCssProps }) =>
            setCssProps(btn.buttonEl, { display: "none" }),
          );
        }
      });
  }
}
