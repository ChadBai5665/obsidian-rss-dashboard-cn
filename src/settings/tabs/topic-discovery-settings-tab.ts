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
  const modalTriggers = new Set<HTMLButtonElement>();
  let saveInFlight = false;
  let disposed = false;
  let lifecycleEpoch = 0;
  let modalSequence = 0;
  let activeModalToken: number | undefined;
  let activeModal: XTopicSourceModal | undefined;
  const setModalGate = (open: boolean): void => {
    for (const button of modalTriggers) {
      button.disabled = open;
      button.setAttribute("aria-disabled", String(open));
    }
  };
  const registerModalTrigger = (button: HTMLButtonElement): void => {
    modalTriggers.add(button);
    button.disabled = disposed || activeModalToken !== undefined;
    button.setAttribute("aria-disabled", String(button.disabled));
  };
  const isLifecycleCurrent = (epoch: number): boolean =>
    !disposed && lifecycleEpoch === epoch && containerEl.isConnected;
  const releaseModal = (token: number): void => {
    if (activeModalToken !== token) return;
    activeModalToken = undefined;
    activeModal = undefined;
    if (!disposed && containerEl.isConnected) setModalGate(false);
  };
  const openEditor = (existing?: XTopicSourceConfig): void => {
    if (disposed || !containerEl.isConnected || activeModalToken !== undefined) return;
    const modalToken = ++modalSequence;
    activeModalToken = modalToken;
    setModalGate(true);
    const modal = new XTopicSourceModal(plugin.app, {
      locale: plugin.settings.locale,
      existing,
      existingTopics: topics,
      maxRequestsPerRun: plugin.settings.tikhub.maxRequestsPerRun,
      maxRequestsPerDay: plugin.settings.tikhub.maxRequestsPerDay,
      onClose: () => releaseModal(modalToken),
      onSave: async (config) => {
        if (saveInFlight) throw new Error("X topic save already in progress");
        saveInFlight = true;
        const saveEpoch = lifecycleEpoch;
        const originalFeeds = plugin.settings.feeds;
        let candidateAssigned = false;
        try {
          assertNoTopicConflict(originalFeeds, config);
          const candidateFeeds = structuredClone(originalFeeds);
          upsertTopicFeed(candidateFeeds, config);
          plugin.settings.feeds = candidateFeeds;
          candidateAssigned = true;
          await plugin.saveSettings();
          if (isLifecycleCurrent(saveEpoch)) {
            containerEl.dispatchEvent(new CustomEvent("rss-settings-refresh"));
          }
        } catch (error) {
          if (candidateAssigned) {
            plugin.settings.feeds = originalFeeds;
            if (isLifecycleCurrent(saveEpoch)) {
              containerEl.dispatchEvent(new CustomEvent("rss-settings-refresh"));
            }
          }
          throw error;
        } finally {
          saveInFlight = false;
        }
      },
    });
    activeModal = modal;
    try {
      modal.open();
    } catch (error) {
      try {
        modal.close();
      } finally {
        releaseModal(modalToken);
      }
      throw error;
    }
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    lifecycleEpoch += 1;
    containerEl.removeEventListener("rss-settings-dispose", dispose);
    setModalGate(true);
    const modal = activeModal;
    activeModal = undefined;
    activeModalToken = undefined;
    modal?.close();
  };
  containerEl.addEventListener("rss-settings-dispose", dispose);

  new Setting(containerEl)
    .setName(t("settings.topicDiscovery.topics"))
    .addButton((button) => {
      registerModalTrigger(button.buttonEl);
      button
        .setButtonText(t("settings.topicDiscovery.addTopic"))
        .setCta()
        .onClick(() => openEditor());
    });
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
      .addButton((button) => {
        registerModalTrigger(button.buttonEl);
        button
          .setButtonText(t("common.edit"))
          .onClick(() => openEditor(topic));
      });
  }
}

function assertNoTopicConflict(
  feeds: readonly Feed[],
  config: XTopicSourceConfig,
): void {
  const canonicalName = config.name.normalize("NFC").trim().toLowerCase();
  for (const feed of feeds) {
    if (feed.sourceKind !== "x-topic") continue;
    const current = normalizeXTopicSourceConfig(feed.sourceConfig);
    if (
      current &&
      current.id !== config.id &&
      current.name.normalize("NFC").trim().toLowerCase() === canonicalName
    ) {
      throw new Error("X topic name is already owned by another source");
    }
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
