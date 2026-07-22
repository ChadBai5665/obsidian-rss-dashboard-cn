import { App, Setting } from "obsidian";
import { createTranslator } from "../../i18n";
import { XTopicSourceModal } from "../../modals/x-topic-source-modal";
import {
  normalizeXTopicSourceConfig,
  sourceConfigUrl,
  type XTopicSourceConfig,
} from "../../sources/source-config";
import type { Feed, RssDashboardSettings } from "../../types/types";

export interface TopicDiscoverySettingsPlugin {
  app: App;
  settings: RssDashboardSettings;
  saveSettings(): Promise<void>;
}

export function renderTopicDiscoverySettingsTab(
  containerEl: HTMLElement,
  plugin: TopicDiscoverySettingsPlugin,
): void {
  const t = createTranslator(plugin.settings.locale ?? "zh-CN");
  new Setting(containerEl)
    .setName(t("settings.topicDiscovery.heading"))
    .setDesc(t("settings.topicDiscovery.boundary"))
    .setHeading();

  const topics = getXTopicConfigs(plugin.settings.feeds);
  const openEditor = (existing?: XTopicSourceConfig): void => {
    new XTopicSourceModal(plugin.app, {
      locale: plugin.settings.locale,
      existing,
      existingTopics: topics,
      maxRequestsPerRun: plugin.settings.tikhub.maxRequestsPerRun,
      maxRequestsPerDay: plugin.settings.tikhub.maxRequestsPerDay,
      onSave: async (config) => {
        upsertTopicFeed(plugin.settings.feeds, config);
        await plugin.saveSettings();
        containerEl.dispatchEvent(new CustomEvent("rss-settings-refresh"));
      },
    }).open();
  };

  new Setting(containerEl)
    .setName(t("settings.topicDiscovery.topics"))
    .addButton((button) => button
      .setButtonText(t("settings.topicDiscovery.addTopic"))
      .setCta()
      .onClick(() => openEditor()));
  if (topics.length === 0) {
    containerEl.createEl("p", { text: t("settings.topicDiscovery.empty") });
  }
  for (const topic of topics) {
    const estimate = topic.priorityAccounts.length > 0 ? 3 : 2;
    new Setting(containerEl)
      .setName(topic.name)
      .setDesc([
        t("settings.topicDiscovery.window", { count: topic.windowDays }),
        t("settings.tikhub.estimatedRefreshRequests", { count: estimate }),
        t("settings.tikhub.requestCaps", {
          run: plugin.settings.tikhub.maxRequestsPerRun,
          day: plugin.settings.tikhub.maxRequestsPerDay,
        }),
      ].join(" · "))
      .addButton((button) => button
        .setButtonText(t("common.edit"))
        .onClick(() => openEditor(topic)));
  }
}

function getXTopicConfigs(feeds: readonly Feed[]): XTopicSourceConfig[] {
  const result: XTopicSourceConfig[] = [];
  const seen = new Set<string>();
  for (const feed of feeds) {
    if (feed.sourceKind !== "x-topic") continue;
    const config = normalizeXTopicSourceConfig(feed.sourceConfig);
    if (!config || seen.has(config.id)) continue;
    seen.add(config.id);
    result.push(config);
  }
  return result;
}

function upsertTopicFeed(feeds: Feed[], config: XTopicSourceConfig): void {
  const url = sourceConfigUrl(config);
  if (!url) throw new Error("Invalid X topic source configuration");
  const index = feeds.findIndex((feed) =>
    feed.sourceKind === "x-topic" && feed.sourceConfig?.kind === "x-topic" &&
    feed.sourceConfig.id === config.id,
  );
  const previous = index >= 0 ? feeds[index] : undefined;
  const feed: Feed = {
    ...previous,
    feedId: config.id,
    sourceKind: "x-topic",
    sourceConfig: {
      ...config,
      includeKeywords: [...config.includeKeywords],
      excludeKeywords: [...config.excludeKeywords],
      priorityAccounts: [...config.priorityAccounts],
    },
    title: config.name,
    url,
    folder: config.folder,
    items: previous?.items ?? [],
    lastUpdated: previous?.lastUpdated ?? 0,
    author: config.name,
    mediaType: "article",
  };
  if (index >= 0) feeds[index] = feed;
  else feeds.push(feed);
}
