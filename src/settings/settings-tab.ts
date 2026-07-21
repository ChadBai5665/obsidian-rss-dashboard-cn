/**
 * RSS Dashboard Settings Tab — Orchestrator
 *
 * This file was refactored from a 3151-line monolith.
 * Each settings tab now lives in its own file under src/settings/tabs/.
 * Modal classes live in src/settings/modals/settings-modals.ts.
 *
 * This file is responsible ONLY for:
 *   1. Rendering the tab bar UI
 *   2. Delegating content rendering to the appropriate tab renderer
 *
 * Tab name constants / predicates are in ./tab-names.ts (zero Obsidian deps)
 * so tests can import them without pulling in PluginSettingTab.
 */
import { App, PluginSettingTab } from "obsidian";
import RssDashboardPlugin from "./../../main";
// Re-export pure helpers for backwards compatibility with any external imports.
export {
  SETTINGS_TAB_IDS,
  getInitialTab,
  getSettingsTabLabel,
  isValidSettingsTab,
  normalizeSettingsTabId,
} from "./tab-names";
export type { SettingsTabId } from "./tab-names";

// Tab renderer imports
import { renderGeneralSettingsTab } from "./tabs/general-settings-tab";
import { renderStorageSettingsTab } from "./tabs/storage-settings-tab";
import { renderDisplaySettingsTab } from "./tabs/display-settings-tab";
import { renderSidebarSettingsTab } from "./tabs/sidebar-settings-tab";
import { renderMediaSettingsTab } from "./tabs/media-settings-tab";
import { renderArticleSavingSettingsTab } from "./tabs/article-saving-settings-tab";
import { renderRulesSettingsTab } from "./tabs/rules-settings-tab";
import { renderHighlightsSettingsTab } from "./tabs/highlights-settings-tab";
import { renderImportExportSettingsTab } from "./tabs/import-export-settings-tab";
import { renderTagsSettingsTab } from "./tabs/tags-settings-tab";
import { renderAboutTab } from "./tabs/about-settings-tab";
import {
  SETTINGS_TAB_IDS,
  SettingsTabId,
  getSettingsTabLabel,
  normalizeSettingsTabId,
  getInitialTab,
} from "./tab-names";
import { createTranslator } from "../i18n";

// ── Main class ────────────────────────────────────────────────────────────────

export class RssDashboardSettingTab extends PluginSettingTab {
  plugin: RssDashboardPlugin;
  private currentTab: SettingsTabId = getInitialTab();
  private pendingSection: string | null = null;

  constructor(app: App, plugin: RssDashboardPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /** Programmatically switch to a named tab and re-render. */
  public activateTab(tabName: string, sectionName?: string): void {
    const tabId = normalizeSettingsTabId(tabName);
    if (tabId) {
      this.currentTab = tabId;
      this.pendingSection = sectionName ?? null;
      this.display();
    }
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // ── Tab bar ──────────────────────────────────────────────────────────────
    const tabBar = containerEl.createDiv("rss-dashboard-settings-tab-bar");
    const t = createTranslator(this.plugin.settings.locale);
    SETTINGS_TAB_IDS.forEach((tab) => {
      const tabBtn = tabBar.createEl("button", {
        text: getSettingsTabLabel(tab, t),
        cls:
          "rss-dashboard-settings-tab-btn" +
          (this.currentTab === tab ? " active" : ""),
      });
      tabBtn.onclick = () => {
        this.currentTab = tab;
        this.display();
      };
    });

    // ── Tab content ──────────────────────────────────────────────────────────
    const tabContent = containerEl.createDiv(
      "rss-dashboard-settings-tab-content",
    );

    /** Shorthand refresh callback passed to tab renderers that need it. */
    const onRefresh = () => this.display();

    // Listen for CustomEvents emitted by tab renderers that need a full refresh
    // (e.g. the General tab's CORS proxy toggle) without holding a class reference.
    tabContent.addEventListener("rss-settings-refresh", onRefresh);

    switch (this.currentTab) {
      case "general":
        renderGeneralSettingsTab(tabContent, this.plugin);
        this.pendingSection = null;
        break;
      case "storage":
        renderStorageSettingsTab(tabContent, this.plugin);
        this.pendingSection = null;
        break;
      case "display":
        renderDisplaySettingsTab(
          tabContent,
          this.plugin,
          onRefresh,
          this.pendingSection ?? undefined,
        );
        this.pendingSection = null;
        break;
      case "sidebar":
        renderSidebarSettingsTab(
          tabContent,
          this.plugin,
          onRefresh,
          this.pendingSection ?? undefined,
        );
        this.pendingSection = null;
        break;
      case "media":
        renderMediaSettingsTab(tabContent, this.plugin);
        this.pendingSection = null;
        break;
      case "article-saving":
        renderArticleSavingSettingsTab(tabContent, this.plugin, onRefresh);
        this.pendingSection = null;
        break;
      case "rules":
        renderRulesSettingsTab(tabContent, this.plugin, onRefresh);
        this.pendingSection = null;
        break;
      case "highlights":
        renderHighlightsSettingsTab(tabContent, this.plugin, onRefresh);
        this.pendingSection = null;
        break;
      case "import-export":
        renderImportExportSettingsTab(tabContent, this.plugin);
        this.pendingSection = null;
        break;
      case "tags":
        renderTagsSettingsTab(tabContent, this.plugin, onRefresh);
        this.pendingSection = null;
        break;
      case "about":
        renderAboutTab(tabContent, this.plugin);
        this.pendingSection = null;
        break;
    }
  }
}
