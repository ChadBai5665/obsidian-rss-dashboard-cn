/**
 * Rules Settings Tab renderer.
 *
 * Extracted from the monolithic settings-tab.ts.
 * Exports:
 *   - renderRulesSettingsTab(containerEl, plugin, onRefresh)
 */
import { Setting } from "obsidian";
import RssDashboardPlugin from "../../../main";
import { renderKeywordFilterEditor } from "../../components/keyword-filter-editor";
import { createTranslator } from "../../i18n";

export function renderRulesSettingsTab(
  containerEl: HTMLElement,
  plugin: RssDashboardPlugin,
  onRefresh: () => void,
): void {
  const t = createTranslator(plugin.settings.locale ?? "zh-CN");
  new Setting(containerEl).setName(t("settings.rules.heading")).setHeading();
  containerEl.createEl("p", {
    cls: "rss-dashboard-settings-description",
    text: t("settings.rules.description"),
  });

  if (!plugin.settings.keywordRules) {
    plugin.settings.keywordRules = {
      includeLogic: "AND",
      bypassAll: false,
      rules: [],
    };
  }

  const editorContainer = containerEl.createDiv({
    cls: "rss-keyword-filter-editor",
  });

  renderKeywordFilterEditor({
    containerEl: editorContainer,
    state: {
      includeLogic: plugin.settings.keywordRules.includeLogic,
      rules: plugin.settings.keywordRules.rules,
    },
    onChange: (nextState) => {
      plugin.settings.keywordRules.includeLogic = nextState.includeLogic;
      plugin.settings.keywordRules.rules = nextState.rules;
      void (async () => {
        await plugin.saveSettings();
        plugin.notifyFiltersUpdated({
          source: "settings-rules-tab",
          timestamp: Date.now(),
        });
      })();
      onRefresh();
    },
  });
}
