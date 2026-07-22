/**
 * Media Settings Tab renderer.
 *
 * Extracted from the monolithic settings-tab.ts.
 * Exports:
 *   - renderMediaSettingsTab(containerEl, plugin)
 */
import { App, Notice, Setting } from "obsidian";
import { PodcastTheme } from "../../types/types";
import type { MediaSettings } from "../../types/types";
import { createTranslator } from "../../i18n";

interface MediaTabSettings {
  locale?: "zh-CN" | "en";
  media: MediaSettings;
}

interface MediaSettingsPlugin {
  app: App;
  settings: MediaTabSettings;
  saveSettings(): Promise<void>;
  clearPlaybackProgress(): Promise<number>;
  getActiveReaderView?(): Promise<{
    updatePodcastTheme: (theme: PodcastTheme) => void;
  } | null>;
}

export function renderMediaSettingsTab(
  containerEl: HTMLElement,
  plugin: MediaSettingsPlugin,
): void {
  const t = createTranslator(plugin.settings.locale ?? "en");
  new Setting(containerEl).setName(t("settings.media.playback")).setHeading();

  new Setting(containerEl)
    .setName(t("settings.media.remember"))
    .setDesc(t("settings.media.rememberDesc"))
    .addToggle((toggle) =>
      toggle
        .setValue(plugin.settings.media.rememberPlaybackProgress ?? true)
        .onChange(async (value) => {
          plugin.settings.media.rememberPlaybackProgress = value;
          await plugin.saveSettings();
        }),
    );

  new Setting(containerEl)
    .setName(t("settings.media.clear"))
    .setDesc(t("settings.media.clearDesc"))
    .addButton((button) => {
      button
        .setButtonText(t("settings.media.clearButton"))
        .setWarning()
        .onClick(async () => {
          const clearedCount = await plugin.clearPlaybackProgress();
          new Notice(
            clearedCount > 0
              ? t("settings.media.cleared", { count: clearedCount })
              : t("settings.media.nothingToClear"),
          );
        });
    });

  // ── Podcast player ────────────────────────────────────────────────────────
  new Setting(containerEl).setName(t("settings.media.podcast")).setHeading();

  new Setting(containerEl)
    .setName(t("settings.media.speed"))
    .setDesc(t("settings.media.speedDesc"))
    .addDropdown((dropdown) =>
      dropdown
        .addOption("0.75", "0.75x")
        .addOption("1", "1x")
        .addOption("1.25", "1.25x")
        .addOption("1.5", "1.5x")
        .addOption("1.75", "1.75x")
        .addOption("2", "2x")
        .addOption("2.5", "2.5x")
        .addOption("3", "3x")
        .setValue(String(plugin.settings.media.defaultPlaySpeed ?? 1))
        .onChange(async (value) => {
          plugin.settings.media.defaultPlaySpeed = parseFloat(value);
          await plugin.saveSettings();
        }),
    );

  new Setting(containerEl)
    .setName(t("settings.media.theme"))
    .setDesc(t("settings.media.themeDesc"))
    .addDropdown((dropdown) =>
      dropdown
        .addOption("obsidian", "Default")
        .addOption("minimal", "Minimal")
        .addOption("gradient", "Gradient")
        .addOption("spotify", "Spotify")
        .addOption("nord", "Nord")
        .addOption("dracula", "Dracula")
        .addOption("solarized", "Solarized dark")
        .addOption("catppuccin", "Catppuccin mocha")
        .addOption("gruvbox", "Gruvbox")
        .addOption("tokyonight", "Tokyo night")
        .setValue(plugin.settings.media.podcastTheme)
        .onChange(async (value) => {
          const theme = value as PodcastTheme;
          plugin.settings.media.podcastTheme = theme;
          await plugin.saveSettings();
          const readerView = await plugin.getActiveReaderView?.();
          if (readerView) {
            readerView.updatePodcastTheme(theme);
          }
        }),
    );

  new Setting(containerEl).setName(t("settings.media.services")).setHeading();

  const youtubeTosSetting = new Setting(containerEl).setName(
    t("settings.media.youtubeTos"),
  );

  youtubeTosSetting.descEl.createSpan({
    text: t("settings.media.youtubeTosDesc"),
  });

  youtubeTosSetting.descEl.createEl("a", {
    text: t("settings.media.youtubeTos"),
    href: "https://www.youtube.com/t/terms",
    attr: { target: "_blank", rel: "noopener noreferrer" },
  });
}
