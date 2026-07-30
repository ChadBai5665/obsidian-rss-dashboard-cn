import { Setting } from "obsidian";
import { createTranslator } from "../../i18n";
import type { RssDashboardSettings } from "../../types/types";

export interface SourcesSettingsPlugin {
  settings: RssDashboardSettings;
  activateView(): Promise<void>;
}

export function renderSourcesSettingsTab(
  containerEl: HTMLElement,
  plugin: SourcesSettingsPlugin,
): void {
  const t = createTranslator(plugin.settings.locale ?? "zh-CN");
  new Setting(containerEl).setName(t("settings.sources.heading")).setHeading();

  new Setting(containerEl)
    .setName(t("settings.sources.accountSubscriptions"))
    .setDesc(t("settings.sources.accountSubscriptionsDesc"))
    .addButton((button) => {
      button
        .setButtonText(t("command.openDashboard"))
        .setCta()
        .onClick(() => {
          void plugin.activateView();
        });
    });
}
