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
// eslint-disable-next-line @typescript-eslint/no-deprecated -- public compatibility re-export
export { SETTINGS_TAB_NAMES } from "./tab-names";
export type { SettingsTabId } from "./tab-names";
// eslint-disable-next-line @typescript-eslint/no-deprecated -- public compatibility re-export
export type { SettingsTabName } from "./tab-names";

// Tab renderer imports
import { renderGeneralSettingsTab } from "./tabs/general-settings-tab";
import { renderSourcesSettingsTab } from "./tabs/sources-settings-tab";
import { renderTopicDiscoverySettingsTab } from "./tabs/topic-discovery-settings-tab";
import { renderTikHubSettingsTab } from "./tabs/tikhub-settings-tab";
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

const SETTINGS_DISPOSE_EVENT = "rss-settings-dispose";
let settingsTabInstanceSequence = 0;

// ── Main class ────────────────────────────────────────────────────────────────

export class RssDashboardSettingTab extends PluginSettingTab {
  plugin: RssDashboardPlugin;
  private currentTab: SettingsTabId = getInitialTab();
  private pendingSection: string | null = null;
  private readonly accessibilityId = `rss-dashboard-settings-${++settingsTabInstanceSequence}`;
  private activePanelCleanup: (() => void) | undefined;

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

  private tabButtonId(tab: SettingsTabId): string {
    return `${this.accessibilityId}-tab-${tab}`;
  }

  private tabPanelId(tab: SettingsTabId): string {
    return `${this.accessibilityId}-panel-${tab}`;
  }

  private cleanupActivePanel(): void {
    const cleanup = this.activePanelCleanup;
    this.activePanelCleanup = undefined;
    cleanup?.();
  }

  private activateTabFromKeyboard(tab: SettingsTabId): void {
    this.currentTab = tab;
    this.pendingSection = null;
    this.display();
    this.containerEl.querySelector<HTMLElement>(`#${this.tabButtonId(tab)}`)?.focus();
  }

  display(): void {
    const { containerEl } = this;
    this.cleanupActivePanel();
    containerEl.empty();

    // ── Tab bar ──────────────────────────────────────────────────────────────
    const tabBar = containerEl.createDiv("rss-dashboard-settings-tab-bar");
    tabBar.setAttribute("role", "tablist");
    tabBar.setAttribute("aria-orientation", "horizontal");
    const t = createTranslator(this.plugin.settings.locale);
    SETTINGS_TAB_IDS.forEach((tab, index) => {
      const tabBtn = tabBar.createEl("button", {
        text: getSettingsTabLabel(tab, t),
        cls:
          "rss-dashboard-settings-tab-btn" +
          (this.currentTab === tab ? " active" : ""),
      });
      tabBtn.id = this.tabButtonId(tab);
      tabBtn.setAttribute("role", "tab");
      tabBtn.setAttribute("aria-controls", this.tabPanelId(tab));
      tabBtn.setAttribute("aria-selected", String(this.currentTab === tab));
      tabBtn.setAttribute("tabindex", this.currentTab === tab ? "0" : "-1");
      tabBtn.onclick = () => {
        this.currentTab = tab;
        this.display();
      };
      tabBtn.addEventListener("keydown", (event) => {
        let targetIndex: number | undefined;
        if (event.key === "ArrowRight") {
          targetIndex = (index + 1) % SETTINGS_TAB_IDS.length;
        } else if (event.key === "ArrowLeft") {
          targetIndex = (index - 1 + SETTINGS_TAB_IDS.length) % SETTINGS_TAB_IDS.length;
        } else if (event.key === "Home") {
          targetIndex = 0;
        } else if (event.key === "End") {
          targetIndex = SETTINGS_TAB_IDS.length - 1;
        }
        if (targetIndex === undefined) return;
        event.preventDefault();
        this.activateTabFromKeyboard(SETTINGS_TAB_IDS[targetIndex]);
      });
    });

    // ── Tab content ──────────────────────────────────────────────────────────
    const tabContent = containerEl.createDiv(
      "rss-dashboard-settings-tab-content",
    );
    tabContent.id = this.tabPanelId(this.currentTab);
    tabContent.setAttribute("role", "tabpanel");
    tabContent.setAttribute("aria-labelledby", this.tabButtonId(this.currentTab));

    /** Shorthand refresh callback passed to tab renderers that need it. */
    const onRefresh = () => this.display();

    // Listen for CustomEvents emitted by tab renderers that need a full refresh
    // (e.g. the General tab's CORS proxy toggle) without holding a class reference.
    tabContent.addEventListener("rss-settings-refresh", onRefresh);
    let cleaned = false;
    this.activePanelCleanup = () => {
      if (cleaned) return;
      cleaned = true;
      tabContent.removeEventListener("rss-settings-refresh", onRefresh);
      tabContent.dispatchEvent(new CustomEvent(SETTINGS_DISPOSE_EVENT));
    };

    switch (this.currentTab) {
      case "general":
        renderGeneralSettingsTab(tabContent, this.plugin);
        this.pendingSection = null;
        break;
      case "sources":
        renderSourcesSettingsTab(tabContent, this.plugin);
        this.pendingSection = null;
        break;
      case "topic-discovery":
        renderTopicDiscoverySettingsTab(tabContent, this.plugin);
        this.pendingSection = null;
        break;
      case "tikhub":
        renderTikHubSettingsTab(tabContent, this.plugin);
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

  hide(): void {
    this.cleanupActivePanel();
    super.hide();
  }
}
