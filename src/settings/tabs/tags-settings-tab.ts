/**
 * Tags Settings Tab renderer.
 *
 * Extracted from the monolithic settings-tab.ts.
 * Exports:
 *   - renderTagsSettingsTab(containerEl, plugin, onRefresh)
 */
import { Notice, Setting } from "obsidian";
import RssDashboardPlugin from "../../../main";
import { addTagMultiSelectControl } from "../../components/tag-multi-select-control";
import { DEFAULT_SETTINGS } from "../../types/types";
import { updateTagInSettings } from "../../utils/tag-utils";
import { createTranslator } from "../../i18n";

interface AutoTagSettingConfig {
  name: string;
  description: string;
  menuTitle: string;
  getSelectedTagNames: () => string[];
  setSelectedTagNames: (selected: string[]) => void;
}

export function renderTagsSettingsTab(
  containerEl: HTMLElement,
  plugin: RssDashboardPlugin,
  onRefresh: () => void,
): void {
  const t = createTranslator(plugin.settings.locale ?? "zh-CN");
  // Auto Tagging settings
  new Setting(containerEl).setName(t("settings.tags.auto")).setHeading();

  const autoTagSettings: AutoTagSettingConfig[] = [
    {
      name: t("settings.tags.video.name"),
      description: t("settings.tags.video.desc"),
      menuTitle: t("settings.tags.video.menu"),
      getSelectedTagNames: () => plugin.settings.media.defaultVideoTags ?? [],
      setSelectedTagNames: (selected) => {
        plugin.settings.media.defaultVideoTags = selected;
      },
    },
    {
      name: t("settings.tags.twitter.name"),
      description: t("settings.tags.twitter.desc"),
      menuTitle: t("settings.tags.twitter.menu"),
      getSelectedTagNames: () => plugin.settings.media.defaultTwitterTags ?? [],
      setSelectedTagNames: (selected) => {
        plugin.settings.media.defaultTwitterTags = selected;
      },
    },
    {
      name: t("settings.tags.mastodon.name"),
      description: t("settings.tags.mastodon.desc"),
      menuTitle: t("settings.tags.mastodon.menu"),
      getSelectedTagNames: () =>
        plugin.settings.media.defaultMastodonTags ?? [],
      setSelectedTagNames: (selected) => {
        plugin.settings.media.defaultMastodonTags = selected;
      },
    },
    {
      name: t("settings.tags.youtube.name"),
      description: t("settings.tags.youtube.desc"),
      menuTitle: t("settings.tags.youtube.menu"),
      getSelectedTagNames: () => plugin.settings.media.defaultYouTubeTags ?? [],
      setSelectedTagNames: (selected) => {
        plugin.settings.media.defaultYouTubeTags = selected;
      },
    },
    {
      name: t("settings.tags.podcast.name"),
      description: t("settings.tags.podcast.desc"),
      menuTitle: t("settings.tags.podcast.menu"),
      getSelectedTagNames: () => plugin.settings.media.defaultPodcastTags ?? [],
      setSelectedTagNames: (selected) => {
        plugin.settings.media.defaultPodcastTags = selected;
      },
    },
    {
      name: t("settings.tags.rss.name"),
      description: t("settings.tags.rss.desc"),
      menuTitle: t("settings.tags.rss.menu"),
      getSelectedTagNames: () => plugin.settings.media.defaultRssTags ?? [],
      setSelectedTagNames: (selected) => {
        plugin.settings.media.defaultRssTags = selected;
      },
    },
    {
      name: t("settings.tags.smallweb.name"),
      description: t("settings.tags.smallweb.desc"),
      menuTitle: t("settings.tags.smallweb.menu"),
      getSelectedTagNames: () =>
        plugin.settings.media.defaultSmallwebTags ?? [],
      setSelectedTagNames: (selected) => {
        plugin.settings.media.defaultSmallwebTags = selected;
      },
    },
  ];

  for (const autoTagSetting of autoTagSettings) {
    const setting = new Setting(containerEl)
      .setName(autoTagSetting.name)
      .setDesc(autoTagSetting.description);

    addTagMultiSelectControl({
      setting,
      availableTags: plugin.settings.availableTags ?? [],
      selectedTagNames: autoTagSetting.getSelectedTagNames(),
      triggerEmptyLabel: t("settings.tags.none"),
      menuTitle: autoTagSetting.menuTitle,
      locale: plugin.settings.locale ?? "zh-CN",
      onChange: async (selected: string[]) => {
        autoTagSetting.setSelectedTagNames(selected);
        await plugin.saveSettings();
      },
    });
  }

  new Setting(containerEl)
    .setName(t("settings.tags.reset"))
    .setDesc(t("settings.tags.resetDesc"))
    .addButton((button) => {
      button.setButtonText(t("settings.tags.default")).onClick(async () => {
        const d = DEFAULT_SETTINGS.media;
        plugin.settings.media.defaultVideoTag = d.defaultVideoTag;
        plugin.settings.media.defaultVideoTags = d.defaultVideoTags;
        plugin.settings.media.defaultYouTubeTag = d.defaultYouTubeTag;
        plugin.settings.media.defaultYouTubeTags = d.defaultYouTubeTags;
        plugin.settings.media.defaultPodcastTags = d.defaultPodcastTags;
        plugin.settings.media.defaultRssTag = d.defaultRssTag;
        plugin.settings.media.defaultRssTags = d.defaultRssTags;
        plugin.settings.media.defaultSmallwebTag = d.defaultSmallwebTag;
        plugin.settings.media.defaultSmallwebTags = d.defaultSmallwebTags;
        plugin.settings.media.defaultTwitterTag = d.defaultTwitterTag;
        plugin.settings.media.defaultTwitterTags = d.defaultTwitterTags;
        plugin.settings.media.defaultMastodonTag = d.defaultMastodonTag;
        plugin.settings.media.defaultMastodonTags = d.defaultMastodonTags;
        await plugin.saveSettings();
        new Notice(t("settings.tags.resetDone"));
        onRefresh();
      });
    });

  // Tags settings
  new Setting(containerEl).setName(t("settings.tags.heading")).setHeading();

  const tagsContainer = containerEl.createDiv({
    cls: "rss-dashboard-tags-container",
  });

  for (let i = 0; i < plugin.settings.availableTags.length; i++) {
    const tag = plugin.settings.availableTags[i];

    new Setting(tagsContainer)
      .setName(tag.name)
      .addColorPicker((colorPicker) =>
        colorPicker.setValue(tag.color).onChange(async (value) => {
          updateTagInSettings(plugin.settings, tag, { color: value });
          await plugin.saveSettings();
          await plugin.refreshOpenTagColorViews();
          plugin.app.workspace.trigger("rss-dashboard:tags-mutated");
        }),
      )
      .addButton((button) =>
        button
          .setIcon("trash")
          .setTooltip(t("settings.tags.delete"))
          .onClick(async () => {
            plugin.settings.availableTags.splice(i, 1);
            await plugin.saveSettings();
            onRefresh();
          }),
      );
  }

  new Setting(containerEl).setName(t("settings.tags.add")).setHeading();

  const newTagContainer = containerEl.createDiv();

  const tagNameSetting = new Setting(newTagContainer)
    .setName(t("settings.tags.name"))
    .addText((text) => text.setPlaceholder(t("settings.tags.namePlaceholder")));

  const tagColorSetting = new Setting(newTagContainer)
    .setName(t("settings.tags.color"))
    .addColorPicker((colorPicker) => colorPicker.setValue("#3498db"));

  new Setting(newTagContainer).addButton((button) =>
    button.setButtonText(t("settings.tags.addButton")).onClick(async () => {
      const nameInput = tagNameSetting.components[0] as unknown as {
        inputEl: HTMLInputElement;
      };
      const name = nameInput.inputEl.value;
      const colorPicker = tagColorSetting.components[0] as unknown as {
        getValue: () => string;
      };
      const color = colorPicker.getValue();

      if (!name) return;

      plugin.settings.availableTags.push({ name, color });
      await plugin.saveSettings();
      onRefresh();
    }),
  );
}
