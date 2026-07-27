import { Modal, App, Setting, setIcon, Notice } from "obsidian";
import type RssDashboardPlugin from "../../../main";
import { ImportOpmlModal } from "../import-opml-modal";
import { XAccountSourceModal } from "../x-account-source-modal";
import { shouldUseMobileSidebarLayout } from "../../utils/platform-utils";
import { createTranslator, type Translator } from "../../i18n";
import { MediaService } from "../../services/media-service";
import { MastodonService } from "../../services/mastodon-service";
import {
  createConfirmedCollectionPurge,
  type FeedSubscriptionOptionsUpdateRequest,
  type XSubscriptionOptionsUpdateRequest,
} from "../../services/subscription-service";
import { normalizeXAccountSourceConfig } from "../../sources/source-config";
import type { Feed } from "../../types/types";

type SubscriptionType =
  | "rss-website"
  | "youtube"
  | "podcast"
  | "mastodon"
  | "x-account";

type LifecycleStatus =
  | "normal"
  | "failed"
  | "paused"
  | "initial-import-paused";

export class FeedManagerModal extends Modal {
  plugin: RssDashboardPlugin;
  private filter: "all" | SubscriptionType = "all";
  private busy = false;
  private active = false;

  constructor(app: App, plugin: RssDashboardPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen(): void {
    this.active = true;
    this.modalEl.addClass(
      "rss-dashboard-modal",
      "rss-dashboard-modal-container",
      "rss-subscription-manager-modal",
    );
    if (shouldUseMobileSidebarLayout()) {
      this.modalEl.addClass("rss-mobile-feed-manager-modal");
    }
    this.render();
  }

  private render(): void {
    const t = createTranslator(this.plugin.settings.locale ?? "zh-CN");
    this.contentEl.empty();
    new Setting(this.contentEl).setName(t("modal.feedManager.title")).setHeading();
    this.renderToolbar(t);
    this.renderFilter(t);
    this.renderSubscriptions(t);
  }

  private visibleSubscriptions(): Feed[] {
    return this.plugin.settings.feeds.filter((feed) => feed.sourceKind !== "x-topic");
  }

  private renderToolbar(t: Translator): void {
    const buttonRow = this.contentEl.createDiv({ cls: "feed-manager-button-row" });

    const addFeedBtn = buttonRow.createEl("button", {
      cls: "feed-manager-add-button",
    });
    addFeedBtn.createSpan({ text: t("modal.feedManager.add") });
    addFeedBtn.onclick = () => this.plugin.openAddSourceModal();

    const importOpmlBtn = buttonRow.createEl("button", {
      cls: "feed-manager-import-button",
    });
    setIcon(importOpmlBtn, "upload");
    importOpmlBtn.createSpan({ text: ` ${t("modal.feedManager.import")}` });
    importOpmlBtn.onclick = () => {
      new ImportOpmlModal(this.app, this.plugin, () => this.close()).open();
    };

    const exportOpmlBtn = buttonRow.createEl("button", {
      cls: "feed-manager-export-button",
    });
    setIcon(exportOpmlBtn, "download");
    exportOpmlBtn.createSpan({ text: ` ${t("modal.feedManager.export")}` });
    exportOpmlBtn.onclick = () => this.plugin.exportOpml();

    const deleteAllBtn = buttonRow.createEl("button", {
      cls: "feed-manager-delete-all-button",
    });
    setIcon(deleteAllBtn, "trash-2");
    deleteAllBtn.createSpan({ text: ` ${t("modal.feedManager.deleteAll")}` });
    deleteAllBtn.onclick = () => {
      const subscriptions = this.visibleSubscriptions();
      if (subscriptions.length === 0) {
        new Notice(t("modal.feedManager.noneToDelete"));
        return;
      }
      this.openDeleteConfirmation(subscriptions, t);
    };
  }

  private renderFilter(t: Translator): void {
    const filter = new Setting(this.contentEl)
      .setName(t("modal.feedManager.filterLabel"))
      .addDropdown((dropdown) => dropdown
        .addOption("all", t("modal.feedManager.filterAll"))
        .addOption("rss-website", t("modal.feedManager.type.rss"))
        .addOption("youtube", t("modal.feedManager.type.youtube"))
        .addOption("podcast", t("modal.feedManager.type.podcast"))
        .addOption("mastodon", t("modal.feedManager.type.mastodon"))
        .addOption("x-account", t("modal.feedManager.type.x"))
        .setValue(this.filter)
        .onChange((value) => {
          this.filter = value as typeof this.filter;
          this.applyFilter();
        }));
    filter.settingEl.addClass("rss-subscription-filter");
    filter.controlEl.querySelector("select")?.addClass(
      "rss-subscription-type-filter",
    );
  }

  private renderSubscriptions(t: Translator): void {
    const subscriptions = this.visibleSubscriptions();
    const list = this.contentEl.createDiv({ cls: "rss-subscription-list" });
    if (subscriptions.length === 0) {
      list.createDiv({ cls: "rss-subscription-empty", text: t("modal.feedManager.empty") });
      return;
    }
    for (const feed of subscriptions) {
      this.renderSubscriptionRow(list, feed, t);
    }
    this.applyFilter();
  }

  private renderSubscriptionRow(
    list: HTMLElement,
    feed: Feed,
    t: Translator,
  ): void {
    const sourceId = feed.feedId ?? feed.url;
    const sourceType = classifySubscription(feed);
    const status = lifecycleStatus(feed);
    const row = list.createDiv({ cls: "rss-subscription-row" });
    row.dataset.sourceId = sourceId;
    row.dataset.sourceKind = feed.sourceKind === "x-account" ? "x-account" : "feed";
    row.dataset.sourceType = sourceType;
    row.dataset.status = status;

    const summary = row.createDiv({ cls: "rss-subscription-summary" });
    const heading = summary.createDiv({ cls: "rss-subscription-heading" });
    heading.createEl("strong", { text: feed.title });
    heading.createSpan({
      cls: "rss-subscription-type",
      text: typeLabel(sourceType, t),
    });
    heading.createSpan({
      cls: `rss-subscription-status is-${status}`,
      text: statusLabel(status, t),
    });

    summary.createDiv({
      cls: "rss-subscription-last-success",
      text: feed.lastUpdated > 0
        ? t("modal.feedManager.lastSuccess", {
            time: new Date(feed.lastUpdated).toLocaleString(
              this.plugin.settings.locale === "en" ? "en" : "zh-CN",
            ),
          })
        : t("modal.feedManager.neverRefreshed"),
    });
    if (feed.lastFetchError) {
      summary.createDiv({
        cls: "rss-subscription-safe-error",
        text: t("modal.feedManager.safeError"),
      });
    }
    if (feed.initialImportProgress) {
      summary.createDiv({
        cls: "rss-subscription-import-progress",
        text: t("modal.feedManager.importProgress", {
          pages: feed.initialImportProgress.pagesFetched,
          items: feed.initialImportProgress.itemsImported,
        }),
      });
    }

    const actions = row.createDiv({ cls: "rss-subscription-actions" });
    this.actionButton(actions, t("modal.feedManager.refresh"), async () => {
      await this.plugin.manualRefreshSourceById(sourceId);
    }, feed.subscriptionStatus === "paused");
    const paused = feed.subscriptionStatus === "paused";
    this.actionButton(
      actions,
      paused ? t("modal.feedManager.resume") : t("modal.feedManager.pause"),
      async () => await this.plugin.setSubscriptionPaused(sourceId, !paused),
    );

    const importStatus = feed.initialImportProgress?.status;
    if (importStatus === "pending" || importStatus === "running") {
      this.actionButton(actions, t("modal.feedManager.stopImport"), async () =>
        await this.plugin.stopSubscriptionInitialImport(sourceId));
    } else if (importStatus === "stopped" || importStatus === "paused-limit") {
      this.actionButton(actions, t("modal.feedManager.resumeImport"), async () =>
        await this.plugin.resumeSubscriptionInitialImport(sourceId));
    }

    this.actionButton(actions, t("modal.feedManager.editOptions"), () => {
      this.openOptionsEditor(feed, sourceId, t);
    }, false, undefined, false);
    this.actionButton(actions, t("modal.feedManager.editIdentity"), () => {
      this.openIdentityEditor(feed, sourceId);
    }, false, undefined, false);
    this.actionButton(
      actions,
      t("modal.feedManager.delete"),
      () => this.openDeleteConfirmation([feed], t),
      false,
      "mod-warning",
      false,
    );
  }

  private actionButton(
    container: HTMLElement,
    label: string,
    action: () => Promise<boolean | void> | boolean | void,
    disabled = false,
    className?: string,
    singleFlight = true,
  ): void {
    const button = container.createEl("button", {
      text: label,
      cls: className,
      attr: { type: "button" },
    });
    button.disabled = disabled;
    button.addEventListener("click", () => {
      if (button.disabled || this.busy || !this.active) return;
      if (singleFlight) {
        void this.runAction(action);
        return;
      }
      try {
        void action();
      } catch {
        const t = createTranslator(this.plugin.settings.locale ?? "zh-CN");
        new Notice(t("modal.feedManager.actionFailed"));
      }
    });
  }

  private async runAction(
    action: () => Promise<boolean | void> | boolean | void,
  ): Promise<void> {
    if (this.busy || !this.active) return;
    this.busy = true;
    this.setButtonsBusy(true);
    try {
      const result = await action();
      if (!this.active) return;
      if (result === false) {
        const t = createTranslator(this.plugin.settings.locale ?? "zh-CN");
        new Notice(t("modal.feedManager.actionFailed"));
      }
    } catch {
      if (this.active) {
        const t = createTranslator(this.plugin.settings.locale ?? "zh-CN");
        new Notice(t("modal.feedManager.actionFailed"));
      }
    } finally {
      this.busy = false;
      if (this.active) this.render();
    }
  }

  private setButtonsBusy(busy: boolean): void {
    for (const button of Array.from(
      this.contentEl.querySelectorAll<HTMLButtonElement>("button"),
    )) {
      button.disabled = busy;
      button.setAttribute("aria-disabled", String(busy));
    }
  }

  private renderIfOpen(): void {
    if (this.active) this.render();
  }

  private openIdentityEditor(feed: Feed, sourceId: string): void {
    const account = normalizeXAccountSourceConfig(feed.sourceConfig);
    const initialKind = feed.sourceKind === "x-account"
      ? "x-account"
      : MediaService.isYouTubeFeed(feed.url)
        ? "youtube"
        : "rss-website";
    this.plugin.openAddSourceModal({
      initialKind,
      initialInput: account?.handle ?? feed.url,
      initialFolder: feed.folder,
    }, sourceId, () => this.renderIfOpen());
  }

  private openOptionsEditor(feed: Feed, sourceId: string, t: Translator): void {
    const account = normalizeXAccountSourceConfig(feed.sourceConfig);
    if (feed.sourceKind === "x-account" && account) {
      new XAccountSourceModal(this.app, {
        locale: this.plugin.settings.locale ?? "zh-CN",
        existing: account,
        existingAccounts: this.visibleSubscriptions()
          .map((candidate) => normalizeXAccountSourceConfig(candidate.sourceConfig))
          .filter((candidate): candidate is NonNullable<typeof candidate> => !!candidate),
        existingRetention: {
          autoDeleteDuration: feed.autoDeleteDuration ?? 0,
          maxItemsLimit: feed.maxItemsLimit ?? this.plugin.settings.maxItems,
        },
        maxRequestsPerRun: this.plugin.settings.tikhub.maxRequestsPerRun,
        maxRequestsPerDay: this.plugin.settings.tikhub.maxRequestsPerDay,
        onIdentityChange: (handle) => {
          this.plugin.openAddSourceModal({
            initialKind: "x-account",
            initialInput: handle,
            initialFolder: feed.folder,
          }, sourceId, () => this.renderIfOpen());
        },
        onSave: async (config, retention) => {
          const request: XSubscriptionOptionsUpdateRequest = {
            kind: "x-account-options",
            folder: config.folder,
            tags: [...config.topics],
            includeReplies: config.includeReplies,
            includeReposts: config.includeReposts,
            autoDeleteDuration: retention.autoDeleteDuration,
            maxItemsLimit: retention.maxItemsLimit,
          };
          const saved = await this.plugin.updateSubscription(sourceId, request);
          if (!saved) throw new Error("subscription-update-failed");
          this.renderIfOpen();
        },
      }).open();
      return;
    }
    this.openFeedOptionsEditor(feed, sourceId, t);
  }

  private openFeedOptionsEditor(feed: Feed, sourceId: string, t: Translator): void {
    const modal = new Modal(this.app);
    modal.modalEl.addClass(
      "rss-dashboard-modal",
      "rss-dashboard-form-modal",
      "rss-subscription-options-modal",
    );
    modal.contentEl.createEl("h2", { text: t("modal.feedManager.editOptions") });
    let displayName = feed.title;
    let folder = feed.folder;
    let tags = (feed.customTags ?? []).join(", ");
    let autoDeleteDuration = feed.autoDeleteDuration ?? 0;
    let maxItemsLimit = feed.maxItemsLimit ?? this.plugin.settings.maxItems;
    const field = (name: string, value: string, change: (value: string) => void) => {
      const setting = new Setting(modal.contentEl).setName(name);
      setting.settingEl.addClass("rss-dashboard-form-field");
      setting.addText((text) => text.setValue(value).onChange(change));
      return setting;
    };
    field(t("modal.feed.title"), displayName, (value) => { displayName = value; });
    field(t("modal.feed.folder"), folder, (value) => { folder = value; });
    field(t("modal.feed.customTags"), tags, (value) => { tags = value; });
    const retention = field(
      t("modal.feed.autoDelete"),
      String(autoDeleteDuration),
      (value) => { autoDeleteDuration = nonNegativeInteger(value); },
    );
    retention.controlEl.querySelector("input")?.setAttribute("type", "number");
    const maxItems = field(
      t("modal.feed.maxItems"),
      String(maxItemsLimit),
      (value) => { maxItemsLimit = nonNegativeInteger(value); },
    );
    maxItems.controlEl.querySelector("input")?.setAttribute("type", "number");

    const actions = new Setting(modal.contentEl);
    actions.settingEl.addClass("rss-dashboard-form-actions");
    let inFlight = false;
    let cancelButton: HTMLButtonElement | undefined;
    let saveButton: HTMLButtonElement | undefined;
    const setEditorBusy = (busy: boolean): void => {
      for (const button of [cancelButton, saveButton]) {
        if (!button) continue;
        button.disabled = busy;
        button.setAttribute("aria-disabled", String(busy));
      }
    };
    actions.addButton((button) => {
      cancelButton = button.buttonEl;
      button
        .setButtonText(t("common.cancel"))
        .onClick(() => {
          if (!inFlight) modal.close();
        });
    });
    actions.addButton((button) => {
      saveButton = button.buttonEl;
      button
        .setButtonText(t("common.save"))
        .setCta()
        .onClick(() => {
          if (inFlight || !modal.containerEl.isConnected) return;
          inFlight = true;
          setEditorBusy(true);
          void (async () => {
            try {
              const request: FeedSubscriptionOptionsUpdateRequest = {
                kind: "feed-options",
                displayName,
                folder,
                tags: splitList(tags),
                autoDeleteDuration,
                maxItemsLimit,
              };
              const saved = await this.plugin.updateSubscription(sourceId, request);
              if (!saved) {
                if (modal.containerEl.isConnected) {
                  new Notice(t("modal.feedManager.actionFailed"));
                }
                return;
              }
              if (modal.containerEl.isConnected) modal.close();
              this.renderIfOpen();
            } catch {
              if (modal.containerEl.isConnected) {
                new Notice(t("modal.feedManager.actionFailed"));
              }
            } finally {
              if (modal.containerEl.isConnected) {
                inFlight = false;
                setEditorBusy(false);
              }
            }
          })();
        });
    });
    modal.open();
  }

  private openDeleteConfirmation(feeds: readonly Feed[], t: Translator): void {
    const confirmation = new Modal(this.app);
    confirmation.modalEl.addClass("rss-subscription-delete-confirm");
    confirmation.contentEl.createEl("h2", {
      text: feeds.length === 1
        ? t("modal.feedManager.deleteTitle")
        : t("modal.feedManager.deleteAllTitle"),
    });
    confirmation.contentEl.createEl("p", {
      text: feeds.length === 1
        ? t("modal.feedManager.deleteDesc")
        : t("modal.feedManager.deleteAllSafeDesc", { count: feeds.length }),
    });
    const purgeLabel = confirmation.contentEl.createEl("label", {
      cls: "rss-subscription-purge-option",
    });
    const purge = purgeLabel.createEl("input", { type: "checkbox" });
    purgeLabel.createSpan({ text: t("modal.feedManager.purgeLabel") });

    const actions = new Setting(confirmation.contentEl);
    actions.controlEl.addClass("rss-dashboard-modal-buttons");
    actions.addButton((button) => button
      .setButtonText(t("common.cancel"))
      .onClick(() => confirmation.close()));
    actions.addButton((button) => button
      .setButtonText(t("modal.feedManager.confirmDelete"))
      .setWarning()
      .onClick(() => {
        confirmation.close();
        if (purge.checked) {
          this.openPurgeConfirmation(feeds, t);
        } else {
          void this.runAction(
            async () => await this.removeSubscriptions(feeds, false),
          );
        }
      }));
    confirmation.open();
  }

  private openPurgeConfirmation(feeds: readonly Feed[], t: Translator): void {
    const confirmation = new Modal(this.app);
    confirmation.modalEl.addClass("rss-subscription-purge-confirm");
    confirmation.contentEl.createEl("h2", { text: t("modal.feedManager.purgeTitle") });
    confirmation.contentEl.createEl("p", { text: t("modal.feedManager.purgeDesc") });
    const actions = new Setting(confirmation.contentEl);
    actions.controlEl.addClass("rss-dashboard-modal-buttons");
    actions.addButton((button) => button
      .setButtonText(t("common.cancel"))
      .onClick(() => confirmation.close()));
    actions.addButton((button) => button
      .setButtonText(t("modal.feedManager.confirmPurge"))
      .setWarning()
      .onClick(() => {
        confirmation.close();
        void this.runAction(
          async () => await this.removeSubscriptions(feeds, true),
        );
      }));
    confirmation.open();
  }

  private async removeSubscriptions(
    feeds: readonly Feed[],
    purge: boolean,
  ): Promise<boolean> {
    for (const feed of feeds) {
      const sourceId = feed.feedId ?? feed.url;
      const result = purge
        ? await this.plugin.removeSubscription(sourceId, {
            purgeCollection: true,
            confirmation: createConfirmedCollectionPurge(sourceId),
          })
        : await this.plugin.removeSubscription(sourceId, {
            purgeCollection: false,
          });
      if (!result) {
        return false;
      }
    }
    return true;
  }

  private applyFilter(): void {
    for (const row of Array.from(this.contentEl.querySelectorAll<HTMLElement>(
      ".rss-subscription-row",
    ))) {
      row.hidden = this.filter !== "all" && row.dataset.sourceType !== this.filter;
    }
  }

  onClose(): void {
    this.active = false;
    this.contentEl.empty();
  }
}

function classifySubscription(feed: Feed): SubscriptionType {
  if (feed.sourceKind === "x-account") return "x-account";
  if (MediaService.isYouTubeFeed(feed.url)) return "youtube";
  if (feed.mediaType === "podcast") return "podcast";
  if (MastodonService.isResolvedFeedUrl(feed.url)) return "mastodon";
  return "rss-website";
}

function lifecycleStatus(feed: Feed): LifecycleStatus {
  if (feed.subscriptionStatus === "paused") return "paused";
  if (feed.lastFetchError || feed.initialImportProgress?.status === "failed") {
    return "failed";
  }
  if (
    feed.initialImportProgress?.status === "paused-limit" ||
    feed.initialImportProgress?.status === "stopped"
  ) {
    return "initial-import-paused";
  }
  return "normal";
}

function typeLabel(type: SubscriptionType, t: Translator): string {
  if (type === "youtube") return t("modal.feedManager.type.youtube");
  if (type === "podcast") return t("modal.feedManager.type.podcast");
  if (type === "mastodon") return t("modal.feedManager.type.mastodon");
  if (type === "x-account") return t("modal.feedManager.type.x");
  return t("modal.feedManager.type.rss");
}

function statusLabel(status: LifecycleStatus, t: Translator): string {
  if (status === "failed") return t("modal.feedManager.status.failed");
  if (status === "paused") return t("modal.feedManager.status.paused");
  if (status === "initial-import-paused") {
    return t("modal.feedManager.status.importPaused");
  }
  return t("modal.feedManager.status.normal");
}

function splitList(value: string): string[] {
  return value.split(/[\n,]/u).map((entry) => entry.trim()).filter(Boolean);
}

function nonNegativeInteger(value: string): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}
