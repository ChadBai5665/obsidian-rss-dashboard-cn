import { App, Setting } from "obsidian";
import { createTranslator } from "../../i18n";
import { XAccountSourceModal } from "../../modals/x-account-source-modal";
import {
  normalizeXAccountSourceConfig,
  sourceConfigUrl,
  type XAccountSourceConfig,
} from "../../sources/source-config";
import type { Feed, RssDashboardSettings } from "../../types/types";

export interface SourcesSettingsPlugin {
  app: App;
  settings: RssDashboardSettings;
  saveSettings(): Promise<void>;
}

export function renderSourcesSettingsTab(
  containerEl: HTMLElement,
  plugin: SourcesSettingsPlugin,
): void {
  const t = createTranslator(plugin.settings.locale ?? "zh-CN");
  new Setting(containerEl).setName(t("settings.sources.heading")).setHeading();

  const accounts = getXAccountConfigs(plugin.settings.feeds);
  const openEditor = (existing?: XAccountSourceConfig): void => {
    new XAccountSourceModal(plugin.app, {
      locale: plugin.settings.locale,
      existing,
      existingAccounts: accounts,
      maxRequestsPerRun: plugin.settings.tikhub.maxRequestsPerRun,
      maxRequestsPerDay: plugin.settings.tikhub.maxRequestsPerDay,
      onSave: async (config) => {
        upsertAccountFeed(plugin.settings.feeds, config);
        await plugin.saveSettings();
        containerEl.dispatchEvent(new CustomEvent("rss-settings-refresh"));
      },
    }).open();
  };

  new Setting(containerEl)
    .setName(t("settings.sources.accountSubscriptions"))
    .setDesc(t("settings.sources.accountSubscriptionsDesc"))
    .addButton((button) => button
      .setButtonText(t("settings.sources.addAccount"))
      .setCta()
      .onClick(() => openEditor()));

  if (accounts.length === 0) {
    containerEl.createEl("p", { text: t("settings.sources.empty") });
  }
  for (const account of accounts) {
    new Setting(containerEl)
      .setName(account.displayName ?? `@${account.handle}`)
      .setDesc([
        `@${account.handle}`,
        t("settings.tikhub.estimatedRefreshRequests", {
          count: account.includeReplies ? 2 : 1,
        }),
        t("settings.tikhub.requestCaps", {
          run: plugin.settings.tikhub.maxRequestsPerRun,
          day: plugin.settings.tikhub.maxRequestsPerDay,
        }),
      ].join(" · "))
      .addButton((button) => button
        .setButtonText(t("common.edit"))
        .onClick(() => openEditor(account)));
  }
}

function getXAccountConfigs(feeds: readonly Feed[]): XAccountSourceConfig[] {
  const result: XAccountSourceConfig[] = [];
  const seen = new Set<string>();
  for (const feed of feeds) {
    if (feed.sourceKind !== "x-account") continue;
    const config = normalizeXAccountSourceConfig(feed.sourceConfig);
    if (!config || seen.has(config.handle)) continue;
    seen.add(config.handle);
    result.push(config);
  }
  return result;
}

function upsertAccountFeed(feeds: Feed[], config: XAccountSourceConfig): void {
  const url = sourceConfigUrl(config);
  if (!url) throw new Error("Invalid X account source configuration");
  const index = feeds.findIndex((feed) =>
    feed.sourceKind === "x-account" && feed.sourceConfig?.kind === "x-account" &&
    feed.sourceConfig.id === config.id,
  );
  const previous = index >= 0 ? feeds[index] : undefined;
  const feed: Feed = {
    ...previous,
    feedId: config.id,
    sourceKind: "x-account",
    sourceConfig: { ...config, topics: [...config.topics] },
    title: config.displayName ?? `@${config.handle}`,
    url,
    folder: config.folder,
    items: previous?.items ?? [],
    lastUpdated: previous?.lastUpdated ?? 0,
    author: config.displayName ?? `@${config.handle}`,
    mediaType: "article",
  };
  if (index >= 0) feeds[index] = feed;
  else feeds.push(feed);
}
