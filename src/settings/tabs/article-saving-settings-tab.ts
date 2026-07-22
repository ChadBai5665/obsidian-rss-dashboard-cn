/**
 * Article Saving Settings Tab renderer.
 *
 * Extracted from the monolithic settings-tab.ts.
 * Exports:
 *   - renderArticleSavingSettingsTab(containerEl, plugin, onRefresh)
 */
import { Notice, Setting, normalizePath } from "obsidian";
import type { App } from "obsidian";
import { DEFAULT_SETTINGS, type SavedTemplate } from "../../types/types";
import { createTranslator, type Locale } from "../../i18n";
import { VaultFolderSuggest } from "../../components/folder-suggest";
import { TemplateNameModal } from "../modals/settings-modals";

export interface ArticleSavingPluginLike {
  app: App;
  settings: {
    locale: Locale;
    articleSaving: {
      defaultFolder: string;
      addSavedTag: boolean;
      saveFullContent: boolean;
      fetchTimeout: number | undefined;
      defaultTemplate: string;
      savedTemplates?: SavedTemplate[] | undefined;
    };
  };
  saveSettings: () => Promise<void>;
}

export function renderArticleSavingSettingsTab(
  containerEl: HTMLElement,
  plugin: ArticleSavingPluginLike,
  onRefresh: () => void,
): void {
  const t = createTranslator(plugin.settings.locale ?? "en");
  new Setting(containerEl)
    .setName(t("settings.article.savePath"))
    .setDesc(t("settings.article.savePathDesc"))
    .addText((text) => {
      text
        .setValue(plugin.settings.articleSaving.defaultFolder)
        .onChange(async (value) => {
          plugin.settings.articleSaving.defaultFolder = normalizePath(value);
          await plugin.saveSettings();
        });
      new VaultFolderSuggest(plugin.app, text.inputEl);
    });

  new Setting(containerEl)
    .setName(t("settings.article.savedTag"))
    .setDesc(t("settings.article.savedTagDesc"))
    .addToggle((toggle) =>
      toggle
        .setValue(plugin.settings.articleSaving.addSavedTag)
        .onChange(async (value) => {
          plugin.settings.articleSaving.addSavedTag = value;
          await plugin.saveSettings();
        }),
    );

  new Setting(containerEl)
    .setName(t("settings.article.fullContent"))
    .setDesc(t("settings.article.fullContentDesc"))
    .addToggle((toggle) =>
      toggle
        .setValue(plugin.settings.articleSaving.saveFullContent)
        .onChange(async (value) => {
          plugin.settings.articleSaving.saveFullContent = value;
          await plugin.saveSettings();
        }),
    );

  new Setting(containerEl)
    .setName(t("settings.article.timeout"))
    .setDesc(t("settings.article.timeoutDesc"))
    .addSlider((slider) => {
      slider
        .setLimits(5, 30, 1)
        .setValue(plugin.settings.articleSaving.fetchTimeout || 10)
        .setDynamicTooltip()
        .onChange(async (value) => {
          plugin.settings.articleSaving.fetchTimeout = value;
          await plugin.saveSettings();
        });
    });

  // ── Default template ──────────────────────────────────────────────────────
  new Setting(containerEl).setName(t("settings.article.defaultTemplate")).setHeading();

  const templateContainer = containerEl.createDiv();

  new Setting(templateContainer)
    .setName(t("settings.article.defaultTemplate"))
    .setDesc(t("settings.article.defaultTemplateDesc"));

  const templateInput = templateContainer.createEl("textarea", {
    attr: { rows: "10" },
    cls: "rss-dashboard-template-input",
  });
  templateInput.value = plugin.settings.articleSaving.defaultTemplate;
  templateInput.addEventListener("change", () => {
    void (async () => {
      plugin.settings.articleSaving.defaultTemplate = templateInput.value;
      await plugin.saveSettings();
    })();
  });

  templateContainer.appendChild(templateInput);

  const helpText = containerEl.createEl("div", {
    cls: "setting-item-description rss-dashboard-template-help",
  });

  helpText.createEl("p", { text: t("settings.article.variables") });
  const list = helpText.createEl("ul", { cls: "rss-dashboard-variable-list" });
  [
    "{{title}}",
    "{{date}} (Long format)",
    "{{dateShort}} (YYYY-MM-DD)",
    "{{date:FORMAT}} (Moment.js format, e.g. {{date:YYYY/MM/DD}})",
    "{{isoDate}}",
    "[{{tags}}] (array of tags e.g. [tag1, tag2, ...])",
    "{{author}}",
    "{{feedTitle}}",
    "{{summary}}",
    "{{guid}}",
    "{{content}}",
    "{{source}}",
    "{{link}}",
    "{{image}}",
  ].forEach((variable) => {
    list.createEl("li", { text: variable });
  });

  const templateBtnRow = containerEl.createDiv({
    cls: "rss-dashboard-template-btn-row",
  });

  const resetBtn = templateBtnRow.createEl("button", {
    text: t("settings.article.reset"),
    cls: "rss-dashboard-template-btn",
  });
  resetBtn.onclick = async () => {
    templateInput.value = DEFAULT_SETTINGS.articleSaving.defaultTemplate;
    plugin.settings.articleSaving.defaultTemplate =
      DEFAULT_SETTINGS.articleSaving.defaultTemplate;
    await plugin.saveSettings();
    new Notice(t("settings.article.resetDone"));
  };

  const saveAsTemplateBtn = templateBtnRow.createEl("button", {
    text: t("settings.article.saveAs"),
    cls: "rss-dashboard-template-btn",
  });
  saveAsTemplateBtn.onclick = async () => {
    const modal = new TemplateNameModal(plugin.app, plugin.settings.locale);
    modal.open();
    const name = await modal.waitForClose();
    if (name) {
      const newTemplate: SavedTemplate = {
        id: `template-${Date.now()}`,
        name,
        template: plugin.settings.articleSaving.defaultTemplate,
      };
      if (!plugin.settings.articleSaving.savedTemplates) {
        plugin.settings.articleSaving.savedTemplates = [];
      }
      plugin.settings.articleSaving.savedTemplates.push(newTemplate);
      await plugin.saveSettings();
      new Notice(t("settings.article.saved", { name }));
      onRefresh();
    }
  };

  // ── Saved templates ───────────────────────────────────────────────────────
  new Setting(containerEl).setName(t("settings.article.savedTemplates")).setHeading();

  const savedTemplates = plugin.settings.articleSaving.savedTemplates || [];

  if (savedTemplates.length === 0) {
    containerEl.createEl("p", {
      text: t("settings.article.emptyTemplates"),
      cls: "rss-dashboard-settings-note",
    });
  } else {
    const templatesContainer = containerEl.createDiv({
      cls: "rss-dashboard-saved-templates",
    });

    savedTemplates.forEach((template, index) => {
      new Setting(templatesContainer)
        .setName(template.name)
        .addButton((button) =>
          button
            .setButtonText(t("settings.article.load"))
            .setTooltip("Load this template into the editor")
            .onClick(async () => {
              templateInput.value = template.template;
              plugin.settings.articleSaving.defaultTemplate = template.template;
              await plugin.saveSettings();
              new Notice(t("settings.article.loaded", { name: template.name }));
            }),
        )
        .addButton((button) =>
          button
            .setButtonText(t("settings.article.update"))
            .setTooltip("Update this template with current editor content")
            .onClick(async () => {
              plugin.settings.articleSaving.savedTemplates![index].template =
                plugin.settings.articleSaving.defaultTemplate;
              await plugin.saveSettings();
              new Notice(t("settings.article.updated", { name: template.name }));
            }),
        )
        .addButton((button) =>
          button
            .setIcon("trash")
            .setTooltip("Delete this template")
            .onClick(async () => {
              plugin.settings.articleSaving.savedTemplates!.splice(index, 1);
              await plugin.saveSettings();
              new Notice(t("settings.article.deleted", { name: template.name }));
              onRefresh();
            }),
        );
    });
  }
}
