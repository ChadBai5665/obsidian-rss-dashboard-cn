import { Menu, MenuItem, Notice, App, Modal, setIcon, Setting } from "obsidian";
import {
  Feed,
  Folder,
  Tag,
  RssDashboardSettings,
  FeedKeywordRulesSettings,
} from "../types/types";
import {
  SIDEBAR_ICON_IDS,
  getIconById,
  createToolbarButton,
} from "../utils/sidebar-icon-registry";
import { collectFolderPaths } from "../utils/folder-paths";
import { FeedManagerModal } from "../modals/feed-manager-modal";
import { FolderAutoTagModal } from "../modals/feed-manager/folder-auto-tag-modal";
import {
  buildFolderTagConfirmMessage,
  removeAllTagsFromFeeds,
  syncFolderAutoTagsOnFeeds,
} from "../utils/folder-tag-sync";
import { showEditTagModal } from "../utils/tag-utils";
import {
  attachInputClearButton,
  windowInstanceOf,
} from "../utils/platform-utils";
import { SidebarSearchService } from "../services/sidebar-search-service";
import { isValidFolderName } from "../utils/validation";
import type RssDashboardPlugin from "../../main";
import { applyFeedSortOrder } from "../utils/sidebar-sort-utils";
import { applyFolderSortOrder } from "../utils/sidebar-folder-sort-utils";
import { MediaService } from "../services/media-service";
import { MastodonService } from "../services/mastodon-service";
import type {
  FeedSubscriptionOptionsUpdateRequest,
  SidebarOrderingMutationRequest,
  SidebarOrderingMutationResult,
  XSubscriptionOptionsUpdateRequest,
} from "../services/subscription-service";
import { createTranslator, type Locale } from "../i18n";
import {
  createSafeIconImage,
  failedFeedIconUrls,
  extractDomain,
  getFaviconUrl,
} from "../utils/favicon-utils";
import {
  setFolderFeedSortCustom,
  setFolderSortCustom,
  type OrderingFailureReason,
} from "../services/sidebar-ordering-controller";

export interface SidebarOptions {
  currentFolder: string | null;
  currentFeed: Feed | null;
  selectedTags: string[];
  tagsCollapsed: boolean;
  collapsedFolders: string[];
  selectedFolders: string[];
  selectedFeeds?: string[];
}

export interface SidebarCallbacks {
  onFolderClick: (folder: string | null) => void;
  onFeedClick: (feed: Feed, e?: MouseEvent) => void;
  onTagToggle: (tag: string) => void;
  onClearTags: () => void;
  onTagFilterModeChange: (mode: "and" | "or" | "not") => void;
  onToggleTagsCollapse: () => void;
  onToggleFolderCollapse: (folder: string, shouldRerender?: boolean) => void;
  onBatchToggleFolders?: (
    foldersToCollapse: string[],
    foldersToExpand: string[],
  ) => void;
  onAddFolder: (name: string) => void;
  onAddSubfolder: (parent: string, name: string) => void;
  onAddFeed: (
    title: string,
    url: string,
    folder: string,
    autoDeleteDuration?: number,
    maxItemsLimit?: number,
    scanInterval?: number,
    feedKeywordRules?: FeedKeywordRulesSettings,
    customTemplate?: string,
    excludeFromRefresh?: boolean,
    customTags?: string[],
  ) => Promise<void>;
  onEditFeed: (feed: Feed, title: string, url: string, folder: string) => void;
  onDeleteFeed: (feed: Feed) => void;
  onDeleteFolder: (folder: string) => void;
  onRefreshFeeds: () => Promise<void> | void;
  onUpdateFeed: (feed: Feed) => Promise<void>;
  onImportOpml: () => void;
  onExportOpml: () => void;
  onToggleSidebar: () => void;
  onOpenSettings?: () => void;
  onManageFeeds?: () => void;
  onActivateDashboard?: () => void;
  onActivateDiscover?: () => void;
  onCloseMobileSidebar?: () => void;
  onFolderMultiSelect?: (folders: string[]) => void;
  onRangeSelect?: (clickedKey: string, visibleKeys: string[]) => void;
}

type AppWithInternalSettings = App & {
  setting?: {
    open?: () => void;
    openTabById?: (id: string) => void;
  };
};

type SidebarFocusTarget =
  | { type: "all-feeds" }
  | { type: "folder"; path: string }
  | { type: "feed"; url: string };

type SidebarRowDescriptor = {
  key: string;
  target: SidebarFocusTarget;
  element: HTMLElement;
  feed?: Feed;
  folderPath?: string;
  folderName?: string;
  expandable?: boolean;
};

function remapFolderPath(path: string, fromBase: string, toBase: string): string {
  if (path === fromBase) return toBase;
  return path.startsWith(`${fromBase}/`)
    ? `${toBase}${path.substring(fromBase.length)}`
    : path;
}

// FolderNameModal — Uses Obsidian's Modal class to prevent mobile focus bugs.
// ⚠️ DO NOT move the input to a raw document.body div or add event.stopPropagation()
// guards. Previous attempts created race conditions with Obsidian's workspace handler,
// causing text deletion, lag, and dropped keystrokes. See bug docs for history.
class FolderNameModal extends Modal {
  private readonly opts: {
    title: string;
    defaultValue?: string;
    existingNames?: string[];
    locale?: Locale;
    onSubmit: (name: string) => void;
  };

  constructor(
    app: App,
    opts: {
      title: string;
      defaultValue?: string;
      existingNames?: string[];
      locale?: Locale;
      onSubmit: (name: string) => void;
    },
  ) {
    super(app);
    this.opts = opts;
  }

  onOpen() {
    const t = createTranslator(this.opts.locale ?? "zh-CN");
    const { contentEl } = this;
    contentEl.empty();

    // Scope CSS to this modal element (used for input iOS sizing rules).
    this.modalEl.addClass("rss-folder-name-modal");

    new Setting(contentEl).setName(this.opts.title).setHeading();

    const inputWrapper = contentEl.createDiv({
      cls: "rss-folder-name-modal-input-wrapper rss-input-margin-bottom",
    });

    const nameInput = inputWrapper.createEl("input", {
      attr: {
        type: "text",
        value: this.opts.defaultValue ?? "",
        placeholder: t("sidebar.folderName"),
        autocomplete: "off",
        autocorrect: "off",
        autocapitalize: "off",
        spellcheck: "false",
      },
      cls: "rss-full-width-input rss-folder-name-modal-input",
    });
    nameInput.spellcheck = false;

    const clearInputButton = inputWrapper.createEl("button", {
      cls: "rss-folder-name-modal-input-clear",
      attr: {
        type: "button",
        "aria-label": t("sidebar.clearFolderName"),
        title: t("common.close"),
      },
    });
    setIcon(clearInputButton, "x");

    const updateClearButtonState = () => {
      clearInputButton.classList.toggle(
        "is-hidden",
        nameInput.value.length === 0,
      );
    };

    const errorMsg = contentEl.createDiv({
      cls: "rss-folder-name-modal-error rss-folder-name-modal-error-hidden",
    });

    const showError = (msg: string) => {
      errorMsg.textContent = msg;
      errorMsg.removeClass("rss-folder-name-modal-error-hidden");
      nameInput.classList.add("rss-folder-name-modal-input-error");
    };
    const clearError = () => {
      errorMsg.addClass("rss-folder-name-modal-error-hidden");
      nameInput.classList.remove("rss-folder-name-modal-input-error");
    };

    const submit = () => {
      const name = nameInput.value.trim();
      const validation = isValidFolderName(name);
      if (!validation.valid) {
        showError(validation.error || t("sidebar.folderRequired"));
        nameInput.focus();
        return;
      }
      if (
        this.opts.existingNames?.includes(name) &&
        name !== this.opts.defaultValue
      ) {
        showError(t("sidebar.folderExists"));
        nameInput.focus();
        return;
      }
      this.close();
      this.opts.onSubmit(name);
    };

    nameInput.addEventListener("input", () => {
      clearError();
      updateClearButtonState();
    });
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });

    clearInputButton.addEventListener("click", () => {
      nameInput.value = "";
      clearError();
      updateClearButtonState();
      nameInput.focus();
    });

    updateClearButtonState();

    const buttonContainer = contentEl.createDiv({
      cls: "rss-dashboard-modal-buttons rss-folder-name-modal-buttons",
    });

    const okButton = buttonContainer.createEl("button");
    okButton.className = "rss-dashboard-primary-button";
    okButton.addClass("rss-folder-name-modal-ok");
    const okIcon = okButton.createSpan();
    setIcon(okIcon, "check");
    okButton.createSpan({ text: t("common.confirm") });
    okButton.addEventListener("click", submit);

    const cancelButton = buttonContainer.createEl("button");
    cancelButton.addClass("rss-folder-name-modal-cancel");
    const cancelIcon = cancelButton.createSpan();
    setIcon(cancelIcon, "x");
    cancelButton.createSpan({ text: t("common.cancel") });
    cancelButton.addEventListener("click", () => this.close());

    // Single focus+select; Obsidian's Modal handles focus isolation.
    // ⚠️ Do NOT add rAF re-focus, blur recovery, or stopPropagation.
    window.setTimeout(() => {
      if (this.contentEl.isConnected) {
        nameInput.focus();
        nameInput.select();
      }
    }, 50);
  }

  onClose() {
    this.contentEl.empty();
  }
}

export class Sidebar {
  private container: HTMLElement;
  private settings: RssDashboardSettings;
  private options: SidebarOptions;
  private callbacks: SidebarCallbacks;
  private app: App;
  private plugin: RssDashboardPlugin;
  private cachedFolderPaths: string[] | null = null;
  private isSearchExpanded = false;
  private searchQuery = "";
  private isTagsExpanded = false;
  private isAddTagExpanded = false;
  private longPressTimer: number | null = null;
  private pendingImportFeedUrls = new Set<string>();
  private processingImportFeedUrls = new Set<string>();
  private iconBtnEls = new Map<string, HTMLElement>();
  private iconActions = new Map<string, (e?: MouseEvent) => void>();
  private resizeObserver: ResizeObserver | null = null;
  private sidebarRows: SidebarRowDescriptor[] = [];
  private focusedSidebarTarget: SidebarFocusTarget | null = null;
  private isSidebarKeyboardFocused = false;

  private t = (
    key: Parameters<ReturnType<typeof createTranslator>>[0],
    params?: Record<string, string | number>,
  ): string => createTranslator(this.settings.locale ?? "zh-CN")(key, params);

  private showOrderingFailure(
    kind: "folder" | "feed",
    reason: OrderingFailureReason,
    names: { dragged: string; target?: string },
  ): void {
    const key = (() => {
      switch (reason) {
        case "dragged-folder-not-found":
          return "sidebar.draggedFolderNotFound" as const;
        case "target-folder-not-found":
          return "sidebar.targetFolderNotFound" as const;
        case "invalid-descendant-move":
          return "sidebar.invalidDescendantMove" as const;
        case "duplicate-folder-target":
          return "sidebar.duplicateFolderTarget" as const;
        case "dragged-feed-not-found":
          return "sidebar.draggedFeedNotFound" as const;
        case "target-feed-not-found":
          return "sidebar.targetFeedNotFound" as const;
        default:
          return kind === "folder"
            ? ("sidebar.unableMoveFolder" as const)
            : ("sidebar.unableMoveFeed" as const);
      }
    })();
    const name = reason.startsWith("target-")
      ? names.target ?? names.dragged
      : names.dragged;
    new Notice(this.t(key, { name }));
  }

  private async applySidebarOrdering(
    request: SidebarOrderingMutationRequest,
    kind: "folder" | "feed",
    names: { dragged: string; target?: string },
    onSuccess?: (result: SidebarOrderingMutationResult) => void,
  ): Promise<boolean> {
    let result: SidebarOrderingMutationResult;
    try {
      result = await this.plugin.applySidebarOrdering(request);
    } catch {
      result = { ok: false, reason: "unknown" };
    }
    if (!result.ok) {
      this.showOrderingFailure(kind, result.reason, names);
      return false;
    }
    this.clearFolderPathCache();
    onSuccess?.(result);
    this.render();
    return true;
  }

  private renderFallbackFeedIcon(feedIcon: HTMLElement): void {
    feedIcon.empty();
    if (this.settings.display.hideDefaultRssIcon) {
      feedIcon.addClass("rss-icon-hidden");
      return;
    }

    feedIcon.removeClass("rss-icon-hidden");
    setIcon(feedIcon, "rss");
  }

  private renderDomainFavicon(feedIcon: HTMLElement, domain: string): void {
    const faviconUrl = getFaviconUrl(domain);
    if (!faviconUrl) {
      this.renderFallbackFeedIcon(feedIcon);
      return;
    }

    if (failedFeedIconUrls.has(faviconUrl)) {
      this.renderFallbackFeedIcon(feedIcon);
      return;
    }

    feedIcon.empty();
    feedIcon.removeClass("rss-icon-hidden");
    createSafeIconImage(
      feedIcon,
      faviconUrl,
      domain,
      () => {
        this.renderFallbackFeedIcon(feedIcon);
      },
      "rss-dashboard-feed-favicon",
    );
  }

  private getCachedFolderPaths(): string[] {
    if (!this.cachedFolderPaths) {
      this.cachedFolderPaths = collectFolderPaths(this.settings.folders ?? [], {
        sort: false,
      });
    }
    return this.cachedFolderPaths;
  }

  public clearFolderPathCache(): void {
    this.cachedFolderPaths = null;
  }

  constructor(
    app: App,
    container: HTMLElement,
    plugin: RssDashboardPlugin,
    settings: RssDashboardSettings,
    options: SidebarOptions,
    callbacks: SidebarCallbacks,
  ) {
    this.app = app;
    this.container = container;
    this.plugin = plugin;
    this.settings = settings;
    this.options = options;
    this.callbacks = callbacks;
  }

  public destroy(): void {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
  }

  public render(): void {
    const scrollPosition = this.container.scrollTop;

    // Also preserve folders section scroll if it exists
    let foldersScroll = 0;
    const oldFoldersSection = this.container.querySelector(
      ".rss-dashboard-feed-folders-section",
    );
    if (oldFoldersSection) {
      foldersScroll = oldFoldersSection.scrollTop;
    }

    this.container.empty();
    this.container.addClass("rss-dashboard-sidebar");
    this.container.tabIndex = -1;
    this.sidebarRows = [];

    const spacing = this.settings.display.sidebarRowSpacing ?? 10;
    this.container.style.setProperty("--sidebar-row-spacing", `${spacing}px`);

    const indentation = this.settings.display.sidebarRowIndentation ?? 20;
    this.container.style.setProperty(
      "--sidebar-row-indentation",
      `${indentation}px`,
    );
    const itemPaddingLeft = this.settings.display.sidebarItemPaddingLeft ?? 2;
    this.container.style.setProperty(
      "--sidebar-item-padding-left",
      `${itemPaddingLeft}px`,
    );
    const itemPaddingRight = this.settings.display.sidebarItemPaddingRight ?? 2;
    this.container.style.setProperty(
      "--sidebar-item-padding-right",
      `${itemPaddingRight}px`,
    );
    this.container.style.setProperty(
      "--rss-unread-badge-all-feeds-color",
      this.settings.display.allFeedsUnreadBadgeColor || "#8e44ad",
    );
    this.container.style.setProperty(
      "--rss-unread-badge-folder-color",
      this.settings.display.folderUnreadBadgeColor || "#d85b9f",
    );
    this.container.style.setProperty(
      "--rss-unread-badge-feed-color",
      this.settings.display.feedUnreadBadgeColor || "#8e44ad",
    );
    this.refreshImportStatusLookups();

    const controlsSurface = this.container.createDiv({
      cls: "rss-dashboard-sidebar-controls-surface",
    });

    this.renderHeader(controlsSurface);
    // Legacy toggle-row flow (disabled):
    // this.renderToolbarToggle(controlsSurface);
    // if (!this.isSidebarToolbarCollapsed) {
    //   this.renderSearchDock(controlsSurface);
    // }
    this.renderSearchDock(controlsSurface);
    this.renderFeedFolders();
    this.applySearchFilterFromState();
    this.syncFocusedSidebarTargetAfterRender();
    this.applySidebarFocusState();

    // Attach ResizeObserver once; keep it across re-renders
    if (!this.resizeObserver) {
      this.resizeObserver = new ResizeObserver(() => {
        this.updateIconRowFades();
      });
      this.resizeObserver.observe(this.container);
    }
    // Update scroll fade indicators after layout settles
    window.requestAnimationFrame(() => {
      this.updateIconRowFades();
    });

    window.requestAnimationFrame(() => {
      this.container.scrollTop = scrollPosition;
      const newFoldersSection = this.container.querySelector(
        ".rss-dashboard-feed-folders-section",
      );
      if (newFoldersSection) {
        newFoldersSection.scrollTop = foldersScroll;
      }
    });
  }

  private refreshImportStatusLookups(): void {
    this.pendingImportFeedUrls.clear();
    this.processingImportFeedUrls.clear();

    const queue = this.plugin.backgroundImportQueue;
    if (!queue || queue.length === 0) {
      return;
    }

    for (const queuedFeed of queue) {
      this.pendingImportFeedUrls.add(queuedFeed.url);
      if (queuedFeed.importStatus === "processing") {
        this.processingImportFeedUrls.add(queuedFeed.url);
      }
    }
  }

  private renderFeedFolders(): void {
    const showSidebarScrollbar =
      this.settings.display.showSidebarScrollbar ?? true;
    const feedFoldersSection = this.container.createDiv({
      cls:
        "rss-dashboard-feed-folders-section" +
        (showSidebarScrollbar
          ? ""
          : " rss-dashboard-feed-folders-section--scrollbar-hidden"),
    });
    const folderUnreadCountMap = this.buildFolderUnreadCountMap();

    // Render "All Feeds" button at the top
    this.renderAllFeedsButton(feedFoldersSection);
    this.renderTagsSection(feedFoldersSection);

    if (this.settings.feeds.length === 0) {
      feedFoldersSection.createDiv({
        cls: "rss-dashboard-empty-state",
        text: createTranslator(this.settings.locale ?? "zh-CN")(
          "sidebar.empty",
        ),
      });
    }

    if (this.settings.folders && this.settings.folders.length > 0) {
      const sortOrder = this.settings.folderSortOrder || {
        by: "name",
        ascending: true,
      };
      const sortedFolders = this.applySortOrder(
        [...this.settings.folders],
        sortOrder,
      );

      sortedFolders.forEach((folderObj: Folder) =>
        this.renderFolder(
          folderObj,
          "",
          0,
          feedFoldersSection,
          folderUnreadCountMap,
        ),
      );
    }

    const allFolderPaths = new Set(this.getCachedFolderPaths());
    const rootFeeds = this.settings.feeds.filter(
      (feed) => !feed.folder || !allFolderPaths.has(feed.folder),
    );

    if (rootFeeds.length > 0) {
      // Wrap root feeds in indentation container
      const rootFeedsContainer = feedFoldersSection.createDiv({
        cls: "rss-dashboard-folder-feeds",
      });

      let filteredRootFeeds = this.settings.display.hideEmptyFeeds
        ? rootFeeds.filter(
            (feed) =>
              feed.items.length > 0 && feed.items.some((item) => !item.read),
          )
        : rootFeeds;

      const rootSortOrder = this.settings.folderFeedSortOrders?.[""];
      if (rootSortOrder) {
        filteredRootFeeds = this.applyFeedSortOrder(
          [...filteredRootFeeds],
          rootSortOrder,
        );
      }

      filteredRootFeeds.forEach((feed) => {
        this.renderFeed(feed, rootFeedsContainer);
      });
    }

    // Add drop handler for root area - only when dropping on the actual root section, not on folders
    feedFoldersSection.addEventListener("dragover", (e) => {
      // Only show drag-over if we're not over a folder header
      // Only show drag-over if we're not over a folder header or folder feed area
      const target = e.target as HTMLElement;
      if (
        !target.closest(".rss-dashboard-feed-folder-header") &&
        !target.closest(".rss-dashboard-folder-feeds")
      ) {
        e.preventDefault();
        feedFoldersSection.classList.add("drag-over");
      }
    });

    feedFoldersSection.addEventListener("dragleave", (e) => {
      // Only remove drag-over if we're actually leaving the root section
      // Only remove drag-over if we're actually leaving the root section
      const target = e.target as HTMLElement;
      if (
        !target.closest(".rss-dashboard-feed-folder-header") &&
        !target.closest(".rss-dashboard-folder-feeds")
      ) {
        feedFoldersSection.classList.remove("drag-over");
      }
    });

    feedFoldersSection.addEventListener("drop", (e) => {
      const target = e.target as HTMLElement;

      // Only process drops on the root section, not on folder headers or folder feed areas
      if (
        target.closest(".rss-dashboard-feed-folder-header") ||
        target.closest(".rss-dashboard-folder-feeds")
      ) {
        return; // Let the folder handle this drop
      }

      e.preventDefault();
      feedFoldersSection.classList.remove("drag-over");
      if (e.dataTransfer) {
        const draggedFolderPath = e.dataTransfer.getData("folder-path");
        if (draggedFolderPath) {
          void this.applySidebarOrdering({
            kind: "folder-move",
            draggedPath: draggedFolderPath,
            targetPath: "",
            placement: "rootAppend",
          }, "folder", {
            dragged: draggedFolderPath.split("/").pop() ?? draggedFolderPath,
          }, (result) => {
            if (!("newPath" in result)) return;
            const currentFolder = this.options.currentFolder;
            if (
              currentFolder &&
              (currentFolder === draggedFolderPath ||
                currentFolder.startsWith(`${draggedFolderPath}/`))
            ) {
              this.callbacks.onFolderClick(remapFolderPath(
                currentFolder,
                draggedFolderPath,
                result.newPath,
              ));
            }
          });
          return;
        }

        const feedUrl = e.dataTransfer.getData("feed-url");
        if (feedUrl) {
          const feed = this.settings.feeds.find((f) => f.url === feedUrl);
          if (!feed || !feed.folder) return;

          void this.applySidebarOrdering({
            kind: "feed-folder-append",
            draggedUrl: feedUrl,
            destinationFolderPath: "",
          }, "feed", { dragged: feed.title || feedUrl });
        }
      }
    });

    feedFoldersSection.addEventListener("contextmenu", (e) => {
      const target = e.target as HTMLElement;
      const isItem =
        target.closest(".rss-dashboard-feed") ||
        target.closest(".rss-dashboard-feed-folder-header") ||
        target.closest(".rss-dashboard-all-feeds-button");

      if (!isItem) {
        e.preventDefault();
        const menu = new Menu();
        menu.addItem((item: MenuItem) => {
          item
            .setTitle(this.t("sidebar.addFolder"))
            .setIcon("folder-plus")
            .onClick(() => {
              this.showFolderNameModal({
                title: this.t("sidebar.addFolder"),
                existingNames: this.settings.folders.map((f) => f.name),
                onSubmit: (folderName) => {
                  void this.addTopLevelFolder(folderName).then(() =>
                    this.render(),
                  );
                },
              });
            });
        });
        menu.addItem((item: MenuItem) => {
          item
            .setTitle(this.t("sidebar.addFeed"))
            .setIcon("rss")
            .onClick(() => {
              this.showAddFeedModal();
            });
        });
        menu.showAtMouseEvent(e);
      }
    });
  }

  private renderTagsSection(container: HTMLElement): void {
    if (!this.isTagsExpanded) return;

    const tagsSection = container.createDiv({
      cls: "rss-dashboard-sidebar-tags-section",
    });

    // Filter Mode Segmented Control
    const modeGroup = tagsSection.createDiv({
      cls: "rss-dashboard-tag-filter-mode-group",
    });

    const modes: ("and" | "or" | "not")[] = ["and", "or", "not"];
    modes.forEach((m) => {
      const active = this.settings.sidebarTagFilterMode === m;
      const btn = modeGroup.createEl("button", {
        cls: "rss-dashboard-tag-filter-mode-btn" + (active ? " is-active" : ""),
        text: m.toUpperCase(),
      });
      btn.addEventListener("click", () => {
        this.callbacks.onTagFilterModeChange(m);
        this.render();
      });
    });

    // Tag list
    const tagsList = tagsSection.createDiv({
      cls: "rss-dashboard-sidebar-tags-list",
    });

    const tagCountMap = new Map<string, number>();
    this.settings.feeds.forEach((feed) => {
      feed.items.forEach((item) => {
        if (item.tags) {
          item.tags.forEach((t) => {
            tagCountMap.set(t.name, (tagCountMap.get(t.name) || 0) + 1);
          });
        }
      });
    });

    this.settings.availableTags.forEach((tag) => {
      const selected = this.options.selectedTags.includes(tag.name);
      const row = tagsList.createDiv({
        cls: "rss-dashboard-sidebar-tag-row" + (selected ? " is-selected" : ""),
      });

      const tagCheckbox = row.createEl("input", {
        attr: { type: "checkbox" },
        cls: "rss-dashboard-tag-checkbox",
      });
      tagCheckbox.checked = selected;

      const dot = row.createDiv({ cls: "rss-dashboard-tag-color-dot" });
      dot.style.backgroundColor = tag.color;

      row.createSpan({
        text: tag.name,
        cls: "rss-dashboard-sidebar-tag-label",
      });

      const count = tagCountMap.get(tag.name) || 0;
      row.createSpan({
        text: count.toString(),
        cls: "rss-dashboard-sidebar-tag-count",
      });

      row.addEventListener("click", (e) => {
        e.preventDefault();
        this.callbacks.onTagToggle(tag.name);
        this.render();
      });
    });
    // Inline add-tag row
    if (this.isAddTagExpanded) {
      const addRow = tagsSection.createDiv({
        cls: "rss-dashboard-sidebar-add-tag-row",
      });
      const cp = addRow.createEl("input", {
        attr: { type: "color", value: "#3498db" },
        cls: "rss-dashboard-tag-color-picker",
      });
      const input = addRow.createEl("input", {
        attr: { type: "text", placeholder: this.t("sidebar.newTag") },
        cls: "rss-dashboard-sidebar-add-tag-input",
      });
      const addBtn = addRow.createEl("button", {
        cls: "rss-dashboard-sidebar-add-tag-btn",
        text: this.t("common.confirm"),
      });
      const cancelBtn = addRow.createDiv({
        cls: "rss-dashboard-sidebar-add-tag-cancel-btn",
      });
      setIcon(cancelBtn, "x");

      cancelBtn.addEventListener("click", () => {
        this.isAddTagExpanded = false;
        this.render();
      });

      const submit = () => {
        const val = input.value.trim();
        if (!val) {
          this.isAddTagExpanded = false;
          this.render();
          return;
        }
        if (
          this.settings.availableTags.some(
            (t) => t.name.toLowerCase() === val.toLowerCase(),
          )
        ) {
          new Notice(this.t("sidebar.tagExists"));
          return;
        }
        this.settings.availableTags.push({ name: val, color: cp.value });
        void this.plugin.saveSettings();
        this.app.workspace.trigger("rss-dashboard:tags-mutated");
        input.value = "";
        this.isAddTagExpanded = false;
        this.render();
      };

      addBtn.addEventListener("click", submit);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") submit();
        if (e.key === "Escape") {
          this.isAddTagExpanded = false;
          this.render();
        }
      });

      // Auto-focus the input
      window.requestAnimationFrame(() => {
        input.focus();
      });
    } else {
      const addToggle = tagsSection.createDiv({
        cls: "rss-dashboard-sidebar-add-tag-toggle",
      });
      setIcon(addToggle, "plus");
      addToggle.createSpan({
        text: this.t("sidebar.addTag"),
        cls: "rss-dashboard-sidebar-add-tag-toggle-label",
      });
      addToggle.addEventListener("click", () => {
        this.isAddTagExpanded = true;
        this.render();
      });
    }
  }

  private renderAllFeedsButton(container: HTMLElement): void {
    const totalFeeds = this.settings.display.hideEmptyFeeds
      ? this.settings.feeds.filter(
          (f) => f.items.length > 0 && f.items.some((i) => !i.read),
        ).length
      : this.settings.feeds.length;

    const totalUnread = this.settings.feeds.reduce(
      (sum, feed) => sum + feed.items.filter((item) => !item.read).length,
      0,
    );

    const isAllActive =
      this.options.currentFolder === null &&
      this.options.currentFeed === null &&
      this.options.selectedTags.length === 0;

    const allFeedsButton = container.createDiv({
      cls: "rss-dashboard-all-feeds-button" + (isAllActive ? " active" : ""),
    });
    allFeedsButton.setAttr("tabindex", "-1");
    this.registerSidebarRow({ type: "all-feeds" }, allFeedsButton);
    const isRefreshActive =
      this.plugin.isMultiFeedRefreshActive ||
      (this.plugin.activeRefreshState?.size ?? 0) > 0;

    // Feed icon (refresh button) - clickable
    const feedIcon = allFeedsButton.createDiv({
      cls:
        "rss-dashboard-all-feeds-icon" + (isRefreshActive ? " refreshing" : ""),
      attr: {
        title: createTranslator(this.settings.locale ?? "zh-CN")(
          "sidebar.refreshAll",
        ),
        "aria-label": createTranslator(this.settings.locale ?? "zh-CN")(
          "sidebar.refreshAll",
        ),
      },
    });
    setIcon(feedIcon, "refresh-cw");
    feedIcon.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.plugin.isMultiFeedRefreshActive) return;
      void this.handleRefresh();
    });

    // Label with count
    const labelContainer = allFeedsButton.createDiv({
      cls: "rss-dashboard-all-feeds-label-container",
    });

    labelContainer.createDiv({
      cls: "rss-dashboard-all-feeds-label",
      text: createTranslator(this.settings.locale ?? "zh-CN")(
        "sidebar.allFeeds",
        { count: totalFeeds },
      ),
    });

    const rightContainer = allFeedsButton.createDiv({
      cls: "rss-dashboard-all-feeds-right",
    });

    // Unread count badge (purple)
    if (this.settings.display.showAllFeedsUnreadBadges && totalUnread > 0) {
      rightContainer.createDiv({
        cls: "rss-dashboard-all-feeds-unread",
        text: totalUnread.toString(),
      });
    }

    // Click handler
    allFeedsButton.addEventListener("click", () => {
      this.callbacks.onFolderClick(null);
    });

    // Context menu for mark all as read
    allFeedsButton.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.showAllFeedsContextMenu(e);
    });
  }

  private showAllFeedsContextMenu(event: MouseEvent): void {
    const menu = new Menu();

    menu.addItem((item: MenuItem) => {
      item
        .setTitle(this.t("sidebar.markAllRead"))
        .setIcon("check-circle")
        .onClick(() => {
          void this.markAllUnreadAsRead();
        });
    });

    menu.addItem((item: MenuItem) => {
      item
        .setTitle(this.t("sidebar.refreshAll"))
        .setIcon("refresh-cw")
        .onClick(() => {
          void this.callbacks.onRefreshFeeds();
        });
    });

    if (typeof menu.showAtMouseEvent === "function") {
      menu.showAtMouseEvent(event);
    } else {
      menu.showAtPosition({ x: event.clientX, y: event.clientY });
    }
  }

  private applySortOrder(
    folders: Folder[],
    sortOrder: {
      by: "name" | "created" | "modified" | "custom";
      ascending: boolean;
    },
  ): Folder[] {
    return applyFolderSortOrder(folders, sortOrder);
  }

  private renderFolder(
    folderObj: Folder,
    parentPath = "",
    depth = 0,
    container: HTMLElement,
    folderUnreadCountMap: Map<string, number>,
  ): void {
    const folderName = folderObj.name;
    const fullPath = parentPath ? `${parentPath}/${folderName}` : folderName;
    const isCollapsed = (this.settings.collapsedFolders || []).includes(
      fullPath,
    );
    const hasSubfolders = (folderObj.subfolders?.length || 0) > 0;
    const isActive = this.options.currentFolder === fullPath;

    const folderFeeds = this.settings.feeds.filter(
      (feed) => feed.folder === fullPath,
    );
    const isExpandable = hasSubfolders || folderFeeds.length > 0;
    const hasActiveFeed = folderFeeds.some(
      (feed) => feed === this.options.currentFeed,
    );
    const shouldHighlight = isActive || hasActiveFeed;

    const folderEl = container.createDiv({
      cls: "rss-dashboard-feed-folder",
    });

    const folderHeader = folderEl.createDiv({
      cls:
        "rss-dashboard-feed-folder-header" +
        (isCollapsed ? " collapsed" : "") +
        (shouldHighlight ? " active" : "") +
        ((this.options.selectedFolders || []).includes(fullPath)
          ? " multi-selected"
          : ""),
      attr: {
        draggable: "true",
        "data-folder-name": folderName,
        "data-folder-path": fullPath,
      },
    });
    folderHeader.setAttr("tabindex", "-1");
    this.registerSidebarRow({ type: "folder", path: fullPath }, folderHeader, {
      folderPath: fullPath,
      folderName,
      expandable: isExpandable,
    });

    const toggleButton = folderHeader.createDiv({
      cls: "rss-dashboard-feed-folder-toggle",
    });
    toggleButton.setAttr(
      "aria-label",
      this.t(
        isCollapsed ? "sidebar.expandFolder" : "sidebar.collapseFolder",
      ),
    );
    setIcon(toggleButton, isCollapsed ? "chevron-right" : "chevron-down");

    if (folderObj.pinned) {
      const pinIcon = folderHeader.createDiv({
        cls: "rss-dashboard-folder-pin-icon",
      });
      setIcon(pinIcon, "lock");
    }

    folderHeader.createDiv({
      cls: "rss-dashboard-feed-folder-name",
      text: folderName,
    });

    const folderUnreadCount = folderUnreadCountMap.get(fullPath) ?? 0;
    if (this.settings.display.showFolderUnreadBadges && folderUnreadCount > 0) {
      folderHeader.createDiv({
        cls: "rss-dashboard-folder-unread-count",
        text: folderUnreadCount.toString(),
      });
    }

    folderHeader.addEventListener("click", (e) => {
      // Only handle primary (left) clicks here
      if (e.button !== 0) return;

      // If the click was on the toggleButton, handle collapse/expand first
      if (
        e.target === toggleButton ||
        toggleButton.contains(e.target as Node)
      ) {
        if (!isExpandable) {
          this.callbacks.onFolderClick(fullPath);
          return;
        }

        // Local DOM toggle to avoid scroll-bounce
        const isNowCollapsed = !folderHeader.classList.contains("collapsed");
        folderHeader.classList.toggle("collapsed", isNowCollapsed);
        folderFeedsList.classList.toggle("collapsed", isNowCollapsed);

        setIcon(
          toggleButton,
          isNowCollapsed ? "chevron-right" : "chevron-down",
        );

        toggleButton.setAttr(
          "aria-label",
          this.t(
            isNowCollapsed
              ? "sidebar.expandFolder"
              : "sidebar.collapseFolder",
          ),
        );

        this.callbacks.onToggleFolderCollapse(fullPath, false);
        return;
      }

      // Shift+click: range selection (delegate computation to caller)
      if (e.shiftKey) {
        const clickedKey = this.getSidebarTargetKey({
          type: "folder",
          path: fullPath,
        });
        const visibleKeys = this.sidebarRows.map((r) => r.key);
        this.callbacks.onRangeSelect?.(clickedKey, visibleKeys);
        return;
      }

      // Ctrl+click (or Meta+click on macOS): toggle this folder in multi-selection
      if (e.ctrlKey || e.metaKey) {
        if (this.callbacks.onFolderMultiSelect) {
          // Build a baseline from selectedFolders, but if empty and a single
          // currentFolder is active, include it so Ctrl+click augments an
          // existing single-folder selection.
          const baseline =
            this.options.selectedFolders &&
            this.options.selectedFolders.length > 0
              ? this.options.selectedFolders
              : this.options.currentFolder
                ? [this.options.currentFolder]
                : [];
          // Use a Set to toggle membership to avoid order-sensitive array bugs
          const currentSet = new Set<string>(baseline);
          if (currentSet.has(fullPath)) {
            currentSet.delete(fullPath);
          } else {
            currentSet.add(fullPath);
          }
          // Pass an array snapshot to the callback. Array.from preserves insertion order.
          this.callbacks.onFolderMultiSelect(Array.from(currentSet));
        }
        return;
      }

      // Plain click: activate folder
      this.callbacks.onFolderClick(fullPath);
    });

    folderHeader.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.showFolderContextMenu(e, folderObj, fullPath, folderName);
    });

    this.attachLongPressContextMenu(folderHeader, (event) => {
      this.showFolderContextMenu(event, folderObj, fullPath, folderName);
    });

    folderHeader.addEventListener("dragstart", (e) => {
      if (!e.dataTransfer) return;
      e.dataTransfer.setData("folder-path", fullPath);
      e.dataTransfer.effectAllowed = "move";
    });

    const clearFolderHeaderDropClasses = () => {
      folderHeader.classList.remove("drag-over");
      folderHeader.classList.remove("drag-over-before");
      folderHeader.classList.remove("drag-over-after");
      folderHeader.classList.remove("drag-over-nest");
    };

    const getFolderDropPlacement = (clientY: number) => {
      const rect = folderHeader.getBoundingClientRect();
      const ratio = rect.height > 0 ? (clientY - rect.top) / rect.height : 0.5;
      if (ratio < 0.25) return "before" as const;
      if (ratio > 0.75) return "after" as const;
      return "nest" as const;
    };

    folderHeader.addEventListener("dragover", (e) => {
      if (!e.dataTransfer) return;

      e.preventDefault();
      e.stopPropagation(); // Prevent event from bubbling up to root section

      const isFolderDrag = e.dataTransfer.types.includes("folder-path");
      const isFeedDrag = e.dataTransfer.types.includes("feed-url");
      if (!isFolderDrag && !isFeedDrag) return;

      clearFolderHeaderDropClasses();

      if (isFolderDrag) {
        const placement = getFolderDropPlacement(e.clientY);
        folderHeader.classList.add(
          placement === "before"
            ? "drag-over-before"
            : placement === "after"
              ? "drag-over-after"
              : "drag-over-nest",
        );
        return;
      }

      folderHeader.classList.add("drag-over");
    });

    folderHeader.addEventListener("dragleave", (e) => {
      e.stopPropagation(); // Prevent event from bubbling up to root section
      clearFolderHeaderDropClasses();
    });

    folderHeader.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation(); // Prevent event from bubbling up to root section
      clearFolderHeaderDropClasses();

      if (!e.dataTransfer) return;

      const draggedFolderPath = e.dataTransfer.getData("folder-path");
      if (draggedFolderPath) {
        const placement = getFolderDropPlacement(e.clientY);
        void this.applySidebarOrdering({
          kind: "folder-move",
          draggedPath: draggedFolderPath,
          targetPath: fullPath,
          placement,
        }, "folder", {
            dragged: draggedFolderPath.split("/").pop() ?? draggedFolderPath,
            target: fullPath.split("/").pop() ?? fullPath,
        }, (result) => {
          if (!("newPath" in result)) return;
          const currentFolder = this.options.currentFolder;
          if (
            currentFolder &&
            (currentFolder === draggedFolderPath ||
              currentFolder.startsWith(`${draggedFolderPath}/`))
          ) {
            this.callbacks.onFolderClick(remapFolderPath(
              currentFolder,
              draggedFolderPath,
              result.newPath,
            ));
          }
        });
        return;
      }

      const feedUrl = e.dataTransfer.getData("feed-url");
      if (!feedUrl) return;

      const feed = this.settings.feeds.find((f) => f.url === feedUrl);
      if (!feed || (feed.folder || "") === fullPath) return;

      void this.applySidebarOrdering({
        kind: "feed-folder-append",
        draggedUrl: feedUrl,
        destinationFolderPath: fullPath,
      }, "feed", {
          dragged: feed.title || feedUrl,
          target: fullPath.split("/").pop() ?? fullPath,
      });
    });

    // Create the container for both subfolders and feeds
    const folderFeedsList = folderEl.createDiv({
      cls: "rss-dashboard-folder-feeds" + (isCollapsed ? " collapsed" : ""),
    });

    // Add drag and drop support for the folder's feed list
    folderFeedsList.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.stopPropagation();
      folderFeedsList.classList.add("drag-over");
    });

    folderFeedsList.addEventListener("dragleave", (e) => {
      e.stopPropagation();
      folderFeedsList.classList.remove("drag-over");
    });

    folderFeedsList.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      folderFeedsList.classList.remove("drag-over");
      if (e.dataTransfer) {
        const feedUrl = e.dataTransfer.getData("feed-url");
        if (feedUrl) {
          const feed = this.settings.feeds.find((f) => f.url === feedUrl);
          if (!feed || (feed.folder || "") === fullPath) return;

          void this.applySidebarOrdering({
            kind: "feed-folder-append",
            draggedUrl: feedUrl,
            destinationFolderPath: fullPath,
          }, "feed", {
              dragged: feed.title || feedUrl,
              target: fullPath.split("/").pop() ?? fullPath,
          });
        }
      }
    });

    // First, render subfolders inside folderFeedsList
    if (folderObj.subfolders && folderObj.subfolders.length > 0) {
      const sortOrder = this.settings.folderSortOrder || {
        by: "name",
        ascending: true,
      };
      const sortedSubfolders = this.applySortOrder(
        [...folderObj.subfolders],
        sortOrder,
      );

      sortedSubfolders.forEach((subfolder: Folder) => {
        this.renderFolder(
          subfolder,
          fullPath,
          depth + 1,
          folderFeedsList,
          folderUnreadCountMap,
        );
      });
    }

    const folderSortOrder = this.settings.folderFeedSortOrders?.[fullPath];
    let sortedFeedsInFolder = folderSortOrder
      ? this.applyFeedSortOrder([...folderFeeds], folderSortOrder)
      : folderFeeds;

    if (this.settings.display.hideEmptyFeeds) {
      sortedFeedsInFolder = sortedFeedsInFolder.filter(
        (feed) =>
          feed.items.length > 0 && feed.items.some((item) => !item.read),
      );
    }

    sortedFeedsInFolder.forEach((feed) => {
      this.renderFeed(feed, folderFeedsList);
    });
  }

  private buildFolderUnreadCountMap(): Map<string, number> {
    const unreadCountByFolderPath = new Map<string, number>();

    for (const feed of this.settings.feeds) {
      if (!feed.folder) continue;

      const unreadCount = feed.items.reduce(
        (count, item) => count + (item.read ? 0 : 1),
        0,
      );
      if (unreadCount === 0) continue;

      const parts = feed.folder.split("/").filter((part) => part.length > 0);
      let path = "";

      for (const part of parts) {
        path = path ? `${path}/${part}` : part;
        unreadCountByFolderPath.set(
          path,
          (unreadCountByFolderPath.get(path) ?? 0) + unreadCount,
        );
      }
    }

    return unreadCountByFolderPath;
  }

  private renderFeed(feed: Feed, container: HTMLElement): void {
    let isSelectedFolder = false;
    if (feed.folder) {
      const parts = feed.folder.split("/");
      let currentPath = "";
      for (const part of parts) {
        currentPath = currentPath ? `${currentPath}/${part}` : part;
        if ((this.options.selectedFolders || []).includes(currentPath)) {
          isSelectedFolder = true;
          break;
        }
      }
    }
    const isSelected =
      (this.options.selectedFeeds || []).includes(feed.url) || isSelectedFolder;

    const feedEl = container.createDiv({
      cls:
        "rss-dashboard-feed" +
        (feed === this.options.currentFeed || isSelected ? " active" : "") +
        (isSelected ? " multi-selected" : ""),
      attr: {
        draggable: "true",
        "data-feed-url": feed.url,
        "data-feed-title": feed.title,
        "data-feed-folder": feed.folder || "",
      },
    });
    feedEl.setAttr("tabindex", "-1");
    this.registerSidebarRow({ type: "feed", url: feed.url }, feedEl, { feed });

    const unreadCount = feed.items.filter((item) => !item.read).length;
    const feedNameContainer = feedEl.createDiv({
      cls: "rss-dashboard-feed-name-container",
    });

    const feedIcon = feedNameContainer.createDiv({
      cls: "rss-dashboard-feed-icon",
    });

    const isProcessing =
      feed.items.length === 0 && this.processingImportFeedUrls.has(feed.url);
    const isQueuedForImport =
      feed.items.length === 0 && this.pendingImportFeedUrls.has(feed.url);
    const refreshState = this.plugin.activeRefreshState?.get(feed.url);
    const isRefreshProcessing = refreshState?.status === "processing";
    const isQueuedForRefresh = refreshState?.status === "pending";

    if (isProcessing) {
      // Show loading spinner for processing feeds
      setIcon(feedIcon, "loader-2");
      feedIcon.addClass("processing");
      feedEl.classList.add("processing-feed");
    } else if (isRefreshProcessing) {
      setIcon(feedIcon, "loader-2");
      feedIcon.addClass("processing");
      feedEl.classList.add("processing-feed");
    } else if (
      feed.mediaType === "video" &&
      MediaService.isYouTubeFeed(feed.url)
    ) {
      // Show play icon only for YouTube feeds.
      feedEl.classList.add("video-feed");
      setIcon(feedIcon, "play");
      feedIcon.addClass("video");
    } else if (feed.mediaType === "podcast") {
      // Show mic icon for podcast feeds
      feedEl.classList.add("podcast-feed");
      setIcon(feedIcon, "mic");
      feedIcon.addClass("podcast");
    } else if (MediaService.shouldShowFeedIcon(feed, this.settings.display)) {
      if (feed.iconUrl && !failedFeedIconUrls.has(feed.iconUrl)) {
        createSafeIconImage(feedIcon, feed.iconUrl, feed.title, () => {
          this.renderFallbackFeedIcon(feedIcon);
        });
      } else {
        this.renderFallbackFeedIcon(feedIcon);
      }
    } else if (MediaService.isTwitterOrNitterFeed(feed.url)) {
      this.renderFallbackFeedIcon(feedIcon);
      this.renderDomainFavicon(feedIcon, "twitter.com");
    } else if (MastodonService.isResolvedFeedUrl(feed.url)) {
      const domain = extractDomain(feed.url);
      if (domain) {
        this.renderFallbackFeedIcon(feedIcon);
        this.renderDomainFavicon(feedIcon, domain);
      } else {
        this.renderFallbackFeedIcon(feedIcon);
      }
    } else if (this.settings.display.useDomainIconsRss) {
      // Show domain favicon for regular feeds when setting is enabled
      const domain = extractDomain(feed.url);
      if (domain) {
        this.renderFallbackFeedIcon(feedIcon);
        this.renderDomainFavicon(feedIcon, domain);
      } else {
        this.renderFallbackFeedIcon(feedIcon);
      }
    } else if (!this.settings.display.hideDefaultRssIcon) {
      // Show generic RSS icon when favicon setting is disabled
      setIcon(feedIcon, "rss");
    } else {
      feedIcon.addClass("rss-icon-hidden");
    }

    feedNameContainer.createDiv({
      cls: "rss-dashboard-feed-name",
      text: feed.title,
    });

    if (this.settings.display.showFeedUnreadBadges && unreadCount > 0) {
      feedNameContainer.createDiv({
        cls: "rss-dashboard-feed-unread-count",
        text: unreadCount.toString(),
      });
    }

    if (
      !this.settings.display.hideFeedFetchErrorBadges &&
      feed.lastFetchError
    ) {
      const errorBadge = feedNameContainer.createDiv({
        cls: "rss-dashboard-feed-error-badge",
        attr: {
          title: feed.lastFetchError,
          "aria-label": this.t("sidebar.feedError", {
            error: feed.lastFetchError,
          }),
        },
      });
      setIcon(errorBadge, "alert-circle");
    }

    if (isQueuedForImport && !isProcessing) {
      const processingIndicator = feedNameContainer.createDiv({
        cls: "rss-dashboard-feed-processing-indicator",
        text: "⏳",
      });
      processingIndicator.setAttribute(
        "title",
        this.t("sidebar.backgroundFetch"),
      );
    } else if (
      isQueuedForRefresh &&
      !isRefreshProcessing &&
      !isProcessing &&
      !isQueuedForImport
    ) {
      const processingIndicator = feedNameContainer.createDiv({
        cls: "rss-dashboard-feed-processing-indicator",
        text: "⏳",
      });
      processingIndicator.setAttribute(
        "title",
        this.t("sidebar.queuedForRefresh"),
      );
    }

    feedEl.addEventListener("click", (e) => {
      e.stopPropagation();
      // Shift+click: range selection (delegate to caller)
      if (e.shiftKey) {
        const clickedKey = this.getSidebarTargetKey({
          type: "feed",
          url: feed.url,
        });
        const visibleKeys = this.sidebarRows.map((r) => r.key);
        this.callbacks.onRangeSelect?.(clickedKey, visibleKeys);
        return;
      }

      this.callbacks.onFeedClick(feed, e);
    });

    feedEl.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.showFeedContextMenu(e, feed);
    });

    this.attachLongPressContextMenu(feedEl, (event) => {
      this.showFeedContextMenu(event, feed);
    });

    feedEl.addEventListener("dragstart", (e) => {
      if (!e.dataTransfer) return;
      e.dataTransfer.setData("feed-url", feed.url);
      e.dataTransfer.effectAllowed = "move";
    });

    const clearFeedDropClasses = () => {
      feedEl.classList.remove("drag-over-before");
      feedEl.classList.remove("drag-over-after");
    };

    feedEl.addEventListener("dragover", (e) => {
      if (!e.dataTransfer) return;
      // Ignore folder drags; those are handled on folder headers/root.
      if (e.dataTransfer.types.includes("folder-path")) return;

      const draggedUrl = e.dataTransfer.getData("feed-url");
      if (!draggedUrl) return;

      e.preventDefault();
      e.stopPropagation();

      const rect = feedEl.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      feedEl.classList.toggle("drag-over-before", before);
      feedEl.classList.toggle("drag-over-after", !before);
    });

    feedEl.addEventListener("dragleave", (e) => {
      e.stopPropagation();
      clearFeedDropClasses();
    });

    feedEl.addEventListener("drop", (e) => {
      if (!e.dataTransfer) return;
      if (e.dataTransfer.types.includes("folder-path")) return;

      const draggedUrl = e.dataTransfer.getData("feed-url");
      if (!draggedUrl || draggedUrl === feed.url) return;

      e.preventDefault();
      e.stopPropagation();
      clearFeedDropClasses();

      const dragged = this.settings.feeds.find((f) => f.url === draggedUrl);

      const rect = feedEl.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      const placement = before ? "before" : "after";

      void this.applySidebarOrdering({
        kind: "feed-insert",
        draggedUrl,
        targetUrl: feed.url,
        placement,
      }, "feed", {
          dragged: dragged?.title || draggedUrl,
          target: feed.title || feed.url,
      });
    });
  }

  private attachLongPressContextMenu(
    targetEl: HTMLElement,
    onLongPress: (event: MouseEvent) => void,
  ): void {
    let longPressTriggered = false;

    const clearTimer = () => {
      if (this.longPressTimer !== null) {
        window.clearTimeout(this.longPressTimer);
        this.longPressTimer = null;
      }
    };

    targetEl.addEventListener("pointerdown", (event: PointerEvent) => {
      if (event.pointerType === "mouse") return;

      longPressTriggered = false;
      clearTimer();
      this.longPressTimer = window.setTimeout(() => {
        longPressTriggered = true;
        const syntheticEvent = new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: event.clientX,
          clientY: event.clientY,
        });
        onLongPress(syntheticEvent);
      }, 500);
    });

    targetEl.addEventListener("pointerup", clearTimer);
    targetEl.addEventListener("pointercancel", clearTimer);
    targetEl.addEventListener("pointermove", clearTimer);

    targetEl.addEventListener("click", (event) => {
      if (longPressTriggered) {
        event.preventDefault();
        event.stopPropagation();
        longPressTriggered = false;
      }
    });
  }

  private isMultiSelectionTarget(
    targetType: "folder" | "feed",
    targetKey: string,
  ): boolean {
    const { selectedFolders, selectedFeeds } = this.options;
    const folderCount = selectedFolders?.length || 0;
    const feedCount = selectedFeeds?.length || 0;
    // Multi-selection exists if more than 1 feed is selected, or if any folder is selected.
    const hasMultiSelection = folderCount > 0 || feedCount > 1;

    if (!hasMultiSelection) return false;

    if (targetType === "folder") {
      return selectedFolders?.includes(targetKey) || false;
    } else {
      return selectedFeeds?.includes(targetKey) || false;
    }
  }

  private appendSelectionContextMenu(menu: Menu): void {
    menu.addItem((item: MenuItem) => {
      item
        .setTitle(this.t("sidebar.markSelectionRead"))
        .setIcon("check-circle")
        .onClick(() => {
          void this.markSelectionReadStatus(true);
        });
    });
    menu.addItem((item: MenuItem) => {
      item
        .setTitle(this.t("sidebar.markSelectionUnread"))
        .setIcon("circle")
        .onClick(() => {
          void this.markSelectionReadStatus(false);
        });
    });
    menu.addSeparator();
    menu.addItem((item: MenuItem) => {
      item
        .setTitle(this.t("sidebar.deleteSelection"))
        .setIcon("trash")
        .onClick(() => {
          this.deleteSelection();
        });
    });
  }

  private async markSelectionReadStatus(read: boolean): Promise<void> {
    const { selectedFolders, selectedFeeds } = this.options;

    const feedsToUpdate = new Set<Feed>();
    for (const feed of this.settings.feeds) {
      if (selectedFeeds && selectedFeeds.includes(feed.url)) {
        feedsToUpdate.add(feed);
      } else if (feed.folder && selectedFolders && selectedFolders.length > 0) {
        let current = feed.folder;
        while (current) {
          if (selectedFolders.includes(current)) {
            feedsToUpdate.add(feed);
            break;
          }
          if (current.includes("/")) {
            current = current.substring(0, current.lastIndexOf("/"));
          } else {
            break;
          }
        }
      }
    }

    const count = await this.markFeedsReadStatus([...feedsToUpdate], read);
    if (count === null) return;
    if (count > 0) {
      new Notice(this.t(read ? "dashboard.markedRead" : "dashboard.markedUnread", { count }));
      this.render();
    } else {
      new Notice(this.t("sidebar.noItemsToMark", { state: this.t(read ? "common.read" : "common.unread") }));
    }
  }

  private deleteSelection(): void {
    const { selectedFolders, selectedFeeds } = this.options;
    const folderCount = selectedFolders?.length || 0;
    const feedCount = selectedFeeds?.length || 0;

    if (folderCount === 0 && feedCount === 0) return;

    let msg = this.t("sidebar.deleteSelectionDefault");
    if (folderCount > 0 && feedCount === 0) {
      msg = this.t("sidebar.deleteSelectedFolders", { folders: folderCount });
    } else if (feedCount > 0 && folderCount === 0) {
      msg = this.t("sidebar.deleteSelectedFeeds", { feeds: feedCount });
    } else {
      msg = this.t("sidebar.deleteSelectedMixed", {
        folders: folderCount,
        feeds: feedCount,
      });
    }

    this.showConfirmModal(msg, () => {
      if (selectedFolders) {
        for (const folder of selectedFolders) {
          this.callbacks.onDeleteFolder(folder);
        }
      }
      if (selectedFeeds) {
        for (const feedUrl of selectedFeeds) {
          const feed = this.settings.feeds.find((f) => f.url === feedUrl);
          if (feed) {
            this.callbacks.onDeleteFeed(feed);
          }
        }
      }
      this.options.selectedFolders = [];
      this.options.selectedFeeds = [];
      this.render();
    });
  }

  private showFolderContextMenu(
    event: MouseEvent,
    folderObj: Folder,
    fullPath: string,
    folderName: string,
  ): void {
    const menu = new Menu();

    if (this.isMultiSelectionTarget("folder", fullPath)) {
      this.appendSelectionContextMenu(menu);
      menu.showAtMouseEvent(event);
      return;
    }
    menu.addItem((item: MenuItem) => {
      item
        .setTitle(this.t("sidebar.addFeed"))
        .setIcon("rss")
        .onClick(() => {
          this.showAddFeedModal(fullPath);
        });
    });
    menu.addItem((item: MenuItem) => {
      item
        .setTitle(this.t("sidebar.addSubfolder"))
        .setIcon("folder-plus")
        .onClick(() => {
          this.showFolderNameModal({
            title: this.t("sidebar.addSubfolder"),
            existingNames:
              this.findFolderByPath(fullPath)?.subfolders.map((f) => f.name) ??
              [],
            onSubmit: (subfolderName) => {
              void this.addSubfolderByPath(fullPath, subfolderName).then(() =>
                this.render(),
              );
            },
          });
        });
    });
    menu.addItem((item: MenuItem) => {
      item
        .setTitle(this.t("sidebar.renameFolder"))
        .setIcon("edit")
        .onClick(() => {
          this.showFolderNameModal({
            title: this.t("sidebar.renameFolder"),
            defaultValue: folderName,
            existingNames: (() => {
              const parentPath = fullPath.includes("/")
                ? fullPath.split("/").slice(0, -1).join("/")
                : "";
              return parentPath
                ? (this.findFolderByPath(parentPath)?.subfolders.map(
                    (f) => f.name,
                  ) ?? [])
                : this.settings.folders.map((f) => f.name);
            })(),
            onSubmit: (newName) => {
              if (newName !== folderName) {
                void this.renameFolderByPath(fullPath, newName).then(() =>
                  this.render(),
                );
              }
            },
          });
        });
    });
    menu.addItem((item: MenuItem) => {
      item
        .setTitle(this.t("sidebar.sortFeedsAsc"))
        .setIcon("sort-asc")
        .onClick(() => {
          void this.sortFeedsInFolder(fullPath, "name", true);
        });
    });
    menu.addItem((item: MenuItem) => {
      item
        .setTitle(this.t("sidebar.sortFeedsDesc"))
        .setIcon("sort-desc")
        .onClick(() => {
          void this.sortFeedsInFolder(fullPath, "name", false);
        });
    });
    menu.addItem((item: MenuItem) => {
      item
        .setTitle(this.t("sidebar.markAllRead"))
        .setIcon("check-circle")
        .onClick(() => {
          const allPaths = this.getAllDescendantFolderPaths(fullPath);
          const feeds = this.settings.feeds.filter((feed) => {
            return feed.folder && allPaths.includes(feed.folder);
          });
          void this.markFeedsReadStatus(feeds, true).then((count) => {
            if (count !== null && count > 0) this.render();
          });
        });
    });
    menu.addItem((item: MenuItem) => {
      item
        .setTitle(this.t("sidebar.refreshFolder"))
        .setIcon("refresh-cw")
        .onClick(() => {
          void this.plugin.refreshFeedsInFolder(fullPath);
        });
    });
    menu.addItem((item: MenuItem) => {
      item
        .setTitle(this.t("sidebar.autoTagFolder"))
        .setIcon("tags")
        .onClick(() => {
          this.showFolderAutoTagModal(fullPath);
        });
    });
    menu.addItem((item: MenuItem) => {
      item
        .setTitle(this.t("sidebar.refreshAll"))
        .setIcon("refresh-cw")
        .onClick(() => {
          this.plugin.cancelPendingStartupRefresh();
          void this.plugin.refreshFeeds();
        });
    });
    menu.addItem((item: MenuItem) => {
      const isPinned = folderObj.pinned;
      item
        .setTitle(
          this.t(isPinned ? "sidebar.unpinFolder" : "sidebar.pinFolder"),
        )
        .setIcon(isPinned ? "unlock" : "lock")
        .onClick(() => {
          folderObj.pinned = !isPinned;
          folderObj.modifiedAt = Date.now();
          void this.plugin.saveSettings().then(() => this.render());
        });
    });
    menu.addItem((item: MenuItem) => {
      item
        .setTitle(this.t("sidebar.deleteFolder"))
        .setIcon("trash")
        .onClick(() => {
          this.showConfirmModal(
            this.t("sidebar.deleteFolderConfirm", { folder: folderName }),
            () => {
              void this.deleteFolderAndSubscriptions(fullPath);
            },
          );
        });
    });
    if (typeof menu.showAtMouseEvent === "function") {
      menu.showAtMouseEvent(event);
    } else {
      menu.showAtPosition({ x: event.clientX, y: event.clientY });
    }
  }

  private findFolderByPath(path: string): Folder | null {
    const parts = path.split("/");
    let current: Folder | undefined = this.settings.folders.find(
      (f) => f.name === parts[0],
    );
    for (let i = 1; i < parts.length && current; i++) {
      current = current.subfolders.find((f) => f.name === parts[i]);
    }
    return current || null;
  }

  private async renameFolderByPath(
    oldPath: string,
    newName: string,
  ): Promise<boolean> {
    if (!this.findFolderByPath(oldPath)) return false;
    try {
      const result = await this.plugin.applyFolderMutation({
        kind: "rename",
        folderPath: oldPath,
        newName,
      });
      if (!result.ok) {
        new Notice(this.t("modal.feedManager.actionFailed"));
        this.render();
        return false;
      }
    } catch {
      this.clearFolderPathCache();
      this.render();
      new Notice(this.t("modal.feedManager.actionFailed"));
      return false;
    }
    this.clearFolderPathCache();
    this.render();
    return true;
  }

  public focusSidebar(): void {
    this.isSidebarKeyboardFocused = true;

    const target =
      this.getFocusedSidebarRow() ??
      this.findDefaultSidebarFocusRow() ??
      this.sidebarRows[0];
    if (!target) {
      return;
    }

    this.focusedSidebarTarget = target.target;
    this.applySidebarFocusState();
  }

  public blurSidebarFocus(): void {
    this.isSidebarKeyboardFocused = false;
    this.applySidebarFocusState();
  }

  public hasKeyboardFocus(): boolean {
    return this.isSidebarKeyboardFocused;
  }

  public moveFocusToNextItem(): void {
    this.moveSidebarFocusByOffset(1);
  }

  public moveFocusToPreviousItem(): void {
    this.moveSidebarFocusByOffset(-1);
  }

  public jumpToNextFolder(): void {
    this.jumpToFolder(1);
  }

  public jumpToPreviousFolder(): void {
    this.jumpToFolder(-1);
  }

  public openFocusedItem(): void {
    const row = this.getFocusedSidebarRow();
    if (!row) {
      return;
    }

    switch (row.target.type) {
      case "all-feeds":
        this.callbacks.onFolderClick(null);
        break;
      case "folder":
        if (row.folderPath) {
          this.callbacks.onFolderClick(row.folderPath);
        }
        break;
      case "feed":
        if (row.feed) {
          this.callbacks.onFeedClick(row.feed);
        }
        break;
    }
  }

  public toggleFocusedFolderCollapse(): void {
    const row = this.getFocusedSidebarRow();
    if (
      !row ||
      row.target.type !== "folder" ||
      !row.folderPath ||
      !row.expandable
    ) {
      return;
    }

    this.callbacks.onToggleFolderCollapse(row.folderPath);
  }

  public deleteFocusedItem(): void {
    const row = this.getFocusedSidebarRow();
    if (!row) {
      return;
    }

    if (row.target.type === "feed" && row.feed) {
      this.showConfirmModal(
        this.t("sidebar.deleteFeedConfirm", { feed: row.feed.title }),
        () => {
          this.callbacks.onDeleteFeed(row.feed!);
        },
      );
      return;
    }

    if (row.target.type === "folder" && row.folderPath && row.folderName) {
      this.showConfirmModal(
        this.t("sidebar.deleteFolderConfirm", { folder: row.folderName }),
        () => {
          void this.deleteFolderAndSubscriptions(row.folderPath!);
        },
      );
    }
  }

  public renameFocusedItem(): void {
    const row = this.getFocusedSidebarRow();
    if (!row) {
      return;
    }

    if (row.target.type === "feed" && row.feed) {
      this.showEditFeedModal(row.feed);
      return;
    }

    if (row.target.type === "folder" && row.folderPath && row.folderName) {
      const { folderPath, folderName } = row;
      this.showFolderNameModal({
        title: this.t("sidebar.renameFolder"),
        defaultValue: folderName,
        existingNames: (() => {
          const parentPath = folderPath.includes("/")
            ? folderPath.split("/").slice(0, -1).join("/")
            : "";
          return parentPath
            ? (this.findFolderByPath(parentPath)?.subfolders.map(
                (folder) => folder.name,
              ) ?? [])
            : this.settings.folders.map((folder) => folder.name);
        })(),
        onSubmit: (newName) => {
          if (newName !== row.folderName) {
            void this.renameFolderByPath(row.folderPath!, newName).then(() =>
              this.render(),
            );
          }
        },
      });
    }
  }

  private registerSidebarRow(
    target: SidebarFocusTarget,
    element: HTMLElement,
    extras?: Omit<SidebarRowDescriptor, "key" | "target" | "element">,
  ): void {
    this.sidebarRows.push({
      key: this.getSidebarTargetKey(target),
      target,
      element,
      ...extras,
    });
  }

  private getSidebarTargetKey(target: SidebarFocusTarget): string {
    switch (target.type) {
      case "all-feeds":
        return "all-feeds";
      case "folder":
        return `folder:${target.path}`;
      case "feed":
        return `feed:${target.url}`;
    }
  }

  private getFocusedSidebarRow(): SidebarRowDescriptor | null {
    if (!this.focusedSidebarTarget) {
      return null;
    }

    const key = this.getSidebarTargetKey(this.focusedSidebarTarget);
    return this.sidebarRows.find((row) => row.key === key) ?? null;
  }

  private findDefaultSidebarFocusRow(): SidebarRowDescriptor | null {
    if (this.options.currentFeed) {
      const targetKey = this.getSidebarTargetKey({
        type: "feed",
        url: this.options.currentFeed.url,
      });
      const feedRow = this.sidebarRows.find((row) => row.key === targetKey);
      if (feedRow) {
        return feedRow;
      }
    }

    if (this.options.currentFolder) {
      const targetKey = this.getSidebarTargetKey({
        type: "folder",
        path: this.options.currentFolder,
      });
      const folderRow = this.sidebarRows.find((row) => row.key === targetKey);
      if (folderRow) {
        return folderRow;
      }
    }

    return (
      this.sidebarRows.find((row) => row.target.type === "all-feeds") ?? null
    );
  }

  private syncFocusedSidebarTargetAfterRender(): void {
    if (!this.focusedSidebarTarget) {
      return;
    }

    if (!this.getFocusedSidebarRow()) {
      const fallback = this.findDefaultSidebarFocusRow() ?? this.sidebarRows[0];
      this.focusedSidebarTarget = fallback?.target ?? null;
    }
  }

  private applySidebarFocusState(): void {
    this.container.toggleClass(
      "rss-dashboard-sidebar-keyboard-focused",
      this.isSidebarKeyboardFocused,
    );

    const focusedRow = this.getFocusedSidebarRow();
    this.sidebarRows.forEach((row) => {
      row.element.toggleClass(
        "rss-dashboard-sidebar-row-focused",
        this.isSidebarKeyboardFocused && row.key === focusedRow?.key,
      );
    });

    if (!this.isSidebarKeyboardFocused || !focusedRow) {
      return;
    }

    this.container.focus({ preventScroll: true });
    focusedRow.element.focus({ preventScroll: true });
    focusedRow.element.scrollIntoView({ block: "nearest", behavior: "auto" });
  }

  private moveSidebarFocusByOffset(offset: 1 | -1): void {
    if (this.sidebarRows.length === 0) {
      return;
    }

    if (!this.isSidebarKeyboardFocused) {
      this.focusSidebar();
      return;
    }

    const currentIndex = this.getFocusedSidebarRow()
      ? this.sidebarRows.findIndex(
          (row) => row.key === this.getFocusedSidebarRow()?.key,
        )
      : -1;
    const startIndex = currentIndex >= 0 ? currentIndex : 0;
    const nextIndex = Math.min(
      this.sidebarRows.length - 1,
      Math.max(0, startIndex + offset),
    );

    this.focusedSidebarTarget = this.sidebarRows[nextIndex].target;
    this.applySidebarFocusState();
  }

  private jumpToFolder(direction: 1 | -1): void {
    if (this.sidebarRows.length === 0) {
      return;
    }

    if (!this.isSidebarKeyboardFocused) {
      this.focusSidebar();
      return;
    }

    const currentRow = this.getFocusedSidebarRow();
    const startIndex = currentRow
      ? this.sidebarRows.findIndex((row) => row.key === currentRow.key)
      : -1;

    for (
      let idx = startIndex + direction;
      idx >= 0 && idx < this.sidebarRows.length;
      idx += direction
    ) {
      const row = this.sidebarRows[idx];
      if (row.target.type !== "feed") {
        this.focusedSidebarTarget = row.target;
        this.applySidebarFocusState();
        return;
      }
    }
  }

  private async addSubfolderByPath(parentPath: string, subfolderName: string) {
    const parent = this.findFolderByPath(parentPath);
    if (parent && !parent.subfolders.some((f) => f.name === subfolderName)) {
      parent.subfolders.push({
        name: subfolderName,
        subfolders: [],
        createdAt: Date.now(),
        modifiedAt: Date.now(),
      });
      parent.modifiedAt = Date.now();

      this.settings.folders = [...this.settings.folders];
      await this.plugin.saveSettings();

      if (
        this.options.currentFolder &&
        !this.findFolderByPath(this.options.currentFolder)
      ) {
        this.options.currentFolder = null;
      }
      if (
        this.options.currentFeed &&
        !this.settings.feeds.includes(this.options.currentFeed)
      ) {
        this.options.currentFeed = null;
      }
      this.clearFolderPathCache();
      this.render();
    }
  }

  public async addTopLevelFolder(folderName: string) {
    if (!this.settings.folders.some((f) => f.name === folderName)) {
      this.settings.folders.push({
        name: folderName,
        subfolders: [],
        createdAt: Date.now(),
        modifiedAt: Date.now(),
      });

      this.settings.folders = [...this.settings.folders];
      await this.plugin.saveSettings();

      if (
        this.options.currentFolder &&
        !this.findFolderByPath(this.options.currentFolder)
      ) {
        this.options.currentFolder = null;
      }
      if (
        this.options.currentFeed &&
        !this.settings.feeds.includes(this.options.currentFeed)
      ) {
        this.options.currentFeed = null;
      }
      this.clearFolderPathCache();
      this.render();
    }
  }

  public showFolderNameModal(options: {
    title: string;
    defaultValue?: string;
    existingNames?: string[];
    onSubmit: (name: string) => void;
  }) {
    // Delegate to FolderNameModal (extends Obsidian Modal) for focus stability.
    // See FolderNameModal class comments for context on why Modal is required.
    new FolderNameModal(this.app, {
      ...options,
      locale: this.settings.locale ?? "zh-CN",
    }).open();
  }

  private async deleteFolderAndSubscriptions(
    folderPath: string,
  ): Promise<boolean> {
    try {
      const result = await this.plugin.applyFolderMutation({
        kind: "delete",
        folderPath,
      });
      if (!result.ok) {
        new Notice(this.t("modal.feedManager.actionFailed"));
        this.render();
        return false;
      }
    } catch {
      this.clearFolderPathCache();
      this.render();
      new Notice(this.t("modal.feedManager.actionFailed"));
      return false;
    }
    this.clearFolderPathCache();
    this.render();
    return true;
  }

  private getAllDescendantFolderPaths(path: string): string[] {
    const result: string[] = [path];
    const folder = this.findFolderByPath(path);
    function collect(f: Folder, base: string) {
      for (const sub of f.subfolders) {
        const subPath = base + "/" + sub.name;
        result.push(subPath);
        collect(sub, subPath);
      }
    }
    if (folder) collect(folder, path);
    return result;
  }

  private showConfirmModal(message: string, onConfirm: () => void): void {
    const confirmModal = new Modal(this.app);
    confirmModal.modalEl.addClass("rss-sidebar-confirm-modal");

    const { contentEl } = confirmModal;
    contentEl.empty();

    new Setting(contentEl).setName(this.t("sidebar.confirmTitle")).setHeading();
    contentEl.createDiv({ cls: "rss-sidebar-confirm-message", text: message });

    const buttonContainer = contentEl.createDiv({
      cls: "rss-dashboard-modal-buttons rss-folder-name-modal-buttons",
    });

    const okButton = buttonContainer.createEl("button");
    okButton.addClass("rss-folder-name-modal-ok");
    const okIcon = okButton.createSpan();
    setIcon(okIcon, "check");
    okButton.createSpan({ text: this.t("sidebar.ok") });
    okButton.onclick = () => {
      confirmModal.close();
      onConfirm();
    };

    const cancelButton = buttonContainer.createEl("button");
    cancelButton.addClass("rss-folder-name-modal-cancel");
    const cancelIcon = cancelButton.createSpan();
    setIcon(cancelIcon, "x");
    cancelButton.createSpan({ text: this.t("sidebar.cancel") });
    cancelButton.onclick = () => confirmModal.close();

    confirmModal.open();
    window.setTimeout(() => okButton.focus(), 50);
  }

  private showErrorDetailModal(error: string, feedTitle: string): void {
    const modal = new Modal(this.app);
    modal.modalEl.addClass("rss-feed-error-detail-modal");

    const { contentEl } = modal;
    contentEl.empty();

    new Setting(contentEl)
      .setName(this.t("sidebar.feedErrorTitle", { feed: feedTitle }))
      .setHeading();

    contentEl.createDiv({
      text: error,
      cls: "rss-feed-error-message",
    });

    const buttonContainer = contentEl.createDiv({
      cls: "rss-dashboard-modal-buttons rss-folder-name-modal-buttons",
    });

    const okButton = buttonContainer.createEl("button");
    okButton.addClass("rss-folder-name-modal-ok");
    const okIcon = okButton.createSpan();
    setIcon(okIcon, "check");
    okButton.createSpan({ text: this.t("sidebar.ok") });
    okButton.onclick = () => modal.close();

    modal.open();
    window.setTimeout(() => okButton.focus(), 50);
  }

  public showAddTagModal(): void {
    const modal = activeDocument.body.createDiv({
      cls: "rss-dashboard-modal rss-dashboard-modal-container",
    });

    const modalContent = modal.createDiv({
      cls: "rss-dashboard-modal-content",
    });

    new Setting(modalContent).setName(this.t("sidebar.addTagTitle")).setHeading();

    const formContainer = modalContent.createDiv({
      cls: "rss-dashboard-tag-modal-form",
    });

    const colorInput = formContainer.createEl("input", {
      attr: {
        type: "color",
        value: "#3498db",
      },
      cls: "rss-dashboard-tag-modal-color-picker",
    });

    const nameInput = formContainer.createEl("input", {
      attr: {
        type: "text",
        placeholder: this.t("sidebar.tagNamePlaceholder"),
        autocomplete: "off",
      },
      cls: "rss-dashboard-tag-modal-name-input",
    });
    nameInput.spellcheck = false;

    const buttonContainer = modalContent.createDiv({
      cls: "rss-dashboard-modal-buttons",
    });

    const cancelButton = buttonContainer.createEl("button", {
      text: this.t("sidebar.cancel"),
    });
    cancelButton.addEventListener("click", () => {
      modal.remove();
    });

    const addButton = buttonContainer.createEl("button", {
      text: this.t("sidebar.addTagButton"),
      cls: "rss-dashboard-primary-button",
    });
    addButton.addEventListener("click", () => {
      const tagName = nameInput.value.trim();
      const tagColor = colorInput.value;

      if (tagName) {
        if (
          this.settings.availableTags.some(
            (tag) => tag.name.toLowerCase() === tagName.toLowerCase(),
          )
        ) {
          new Notice(this.t("sidebar.tagExists"));
          return;
        }

        const newTag: Tag = {
          name: tagName,
          color: tagColor,
        };
        this.settings.availableTags.push(newTag);

        void this.plugin.saveSettings();

        this.render();

        modal.remove();

        new Notice(this.t("sidebar.tagAdded", { tag: tagName }));
      } else {
        new Notice(this.t("sidebar.tagRequired"));
      }
    });
    buttonContainer.appendChild(addButton);
    formContainer.appendChild(buttonContainer);

    modal.appendChild(modalContent);
    activeDocument.body.appendChild(modal);

    window.requestAnimationFrame(() => {
      nameInput.focus();
    });
  }

  public showTagContextMenu(event: MouseEvent, tag: Tag): void {
    const menu = new Menu();

    menu.addItem((item: MenuItem) => {
      item
        .setTitle(this.t("sidebar.editTag"))
        .setIcon("pencil")
        .onClick(() => {
          this.showEditTagModal(tag);
        });
    });

    menu.addItem((item: MenuItem) => {
      item
        .setTitle(this.t("sidebar.deleteTag"))
        .setIcon("trash")
        .onClick(() => {
          this.showConfirmModal(
            this.t("sidebar.deleteTagConfirm", { tag: tag.name }),
            () => {
              this.deleteTag(tag);
            },
          );
        });
    });

    menu.showAtMouseEvent(event);
  }

  private showEditTagModal(tag: Tag): void {
    showEditTagModal({
      settings: this.settings,
      tag,
      onSave: async () => {
        await this.plugin.saveSettings();
        await this.plugin.refreshOpenTagColorViews();
        this.app.workspace.trigger("rss-dashboard:tags-mutated");
        this.render();
      },
    });
  }

  private deleteTag(tag: Tag): void {
    const tagIndex = this.settings.availableTags.findIndex(
      (t) => t.name === tag.name,
    );
    if (tagIndex !== -1) {
      this.settings.availableTags.splice(tagIndex, 1);
    }

    this.settings.feeds.forEach((feed) => {
      feed.items.forEach((item) => {
        if (item.tags) {
          item.tags = item.tags.filter((t) => t.name !== tag.name);
        }
      });
    });

    void this.plugin.saveSettings();
    this.app.workspace.trigger("rss-dashboard:tags-mutated");

    this.render();

    new Notice(this.t("sidebar.tagDeleted", { tag: tag.name }));
  }

  private showUnreadItemsContextMenu(event: MouseEvent): void {
    const menu = new Menu();

    menu.addItem((item: MenuItem) => {
      item
        .setTitle(this.t("sidebar.markAllUnreadRead"))
        .setIcon("check-circle")
        .onClick(() => {
          void this.markAllUnreadAsRead();
        });
    });

    menu.showAtMouseEvent(event);
  }

  private showReadItemsContextMenu(event: MouseEvent): void {
    const menu = new Menu();

    menu.addItem((item: MenuItem) => {
      item
        .setTitle(this.t("sidebar.markAllReadUnread"))
        .setIcon("circle")
        .onClick(() => {
          void this.markAllReadAsUnread();
        });
    });

    menu.showAtMouseEvent(event);
  }

  private async markAllUnreadAsRead(): Promise<void> {
    const count = await this.markFeedsReadStatus(this.settings.feeds, true);
    if (count === null) return;
    if (count > 0) {
      this.render();
      new Notice(this.t("dashboard.markedRead", { count }));
    } else {
      new Notice(this.t("sidebar.noUnread"));
    }
  }

  private async markAllReadAsUnread(): Promise<void> {
    const count = await this.markFeedsReadStatus(this.settings.feeds, false);
    if (count === null) return;
    if (count > 0) {
      this.render();
      new Notice(this.t("dashboard.markedUnread", { count }));
    } else {
      new Notice(this.t("sidebar.noRead"));
    }
  }

  private async markFeedsReadStatus(
    feeds: Feed[],
    read: boolean,
  ): Promise<number | null> {
    const targets = feeds.flatMap((feed) =>
      feed.items
        .filter((item) => item.read !== read)
        .map((item) => ({ articleGuid: item.guid, feedUrl: feed.url })),
    );
    if (targets.length === 0) return 0;
    return (await this.plugin.updateArticlesReadBatch(targets, read))
      ? targets.length
      : null;
  }

  public renderHeader(parentEl: HTMLElement = this.container): void {
    const header = parentEl.createDiv({ cls: "rss-dashboard-header" });
    this.iconBtnEls.clear();
    this.iconActions.clear();

    if (this.settings.display.hideToolbarEntirely) return;

    const iconRowWrapper = header.createDiv({ cls: "rss-icon-row-wrapper" });
    const iconRow = iconRowWrapper.createDiv({
      cls: "rss-dashboard-header-icon-row",
    });
    const display = this.settings.display;
    const toolbarT = createTranslator(this.settings.locale ?? "zh-CN");
    const iconOrder: string[] = display.iconOrder?.length
      ? display.iconOrder
      : [...SIDEBAR_ICON_IDS];

    // collapseAll needs a ref to its own button to update the icon dynamically
    let collapseAllBtnRef: HTMLElement | null = null;
    let cachedCollapseAllPaths: string[] | null = null;
    const updateCollapseAllIcon = () => {
      if (!collapseAllBtnRef) return;
      if (!cachedCollapseAllPaths) {
        cachedCollapseAllPaths = this.getCachedFolderPaths();
      }
      const collapsedFolders = this.settings.collapsedFolders || [];
      const allCollapsed =
        cachedCollapseAllPaths.length > 0 &&
        cachedCollapseAllPaths.every((path) => collapsedFolders.includes(path));
      setIcon(
        collapseAllBtnRef,
        allCollapsed ? "chevrons-down-up" : "chevrons-up-down",
      );
    };

    for (const id of iconOrder) {
      const iconConfig = getIconById(id);
      if (!iconConfig) continue;

      const hideKey = iconConfig.settingKey;
      if (display[hideKey]) continue;

      let btn: HTMLElement;

      switch (id) {
        case "divider": {
          // Render the divider as a separate element based on iconOrder position
          const divider = iconRow.createDiv({ cls: "rss-nav-divider" });
          iconRow.appendChild(divider);
          this.iconBtnEls.set(id, divider);
          continue;
        }

        case "discover": {
          const action = () => {
            if (this.callbacks.onActivateDiscover) {
              this.callbacks.onActivateDiscover();
            } else {
              void this.plugin.activateDiscoverView();
            }
          };
          this.iconActions.set("discover", action);
          btn = createToolbarButton(iconConfig, action, toolbarT);
          btn.addClass("clickable-icon");
          break;
        }

        case "addFeed": {
          const action = () => {
            this.showAddFeedModal();
            if (
              !this.app.loadLocalStorage("rss-first-launch-coachmark-shown")
            ) {
              this.app.saveLocalStorage(
                "rss-first-launch-coachmark-shown",
                "true",
              );
              const coachmark = this.iconBtnEls
                .get("addFeed")
                ?.querySelector(".rss-dashboard-coachmark");
              if (coachmark) coachmark.remove();
            }
          };
          this.iconActions.set("addFeed", action);
          btn = createToolbarButton(iconConfig, action, toolbarT);
          break;
        }

        case "manageFeeds": {
          const action = () => {
            if (this.callbacks.onManageFeeds) {
              this.callbacks.onManageFeeds();
            }
          };
          this.iconActions.set("manageFeeds", action);
          btn = createToolbarButton(iconConfig, action, toolbarT);
          break;
        }

        case "search": {
          const action = () => {
            this.isSearchExpanded = !this.isSearchExpanded;
            this.render();
            if (this.isSearchExpanded) {
              window.requestAnimationFrame(() => {
                const searchInput =
                  this.container.querySelector<HTMLInputElement>(
                    ".rss-dashboard-search-input",
                  );
                if (!searchInput) return;
                searchInput.focus();
                searchInput.select();
                searchInput.scrollIntoView({ block: "nearest" });
              });
            }
          };
          this.iconActions.set("search", action);
          btn = createToolbarButton(iconConfig, action, toolbarT);
          btn.toggleClass("is-active", this.isSearchExpanded);
          btn.setAttr("aria-pressed", this.isSearchExpanded ? "true" : "false");
          break;
        }

        case "tags": {
          const action = () => {
            this.isTagsExpanded = !this.isTagsExpanded;
            this.render();
          };
          this.iconActions.set("tags", action);
          btn = createToolbarButton(iconConfig, action, toolbarT);
          btn.toggleClass("is-active", this.isTagsExpanded);
          btn.setAttr("aria-pressed", this.isTagsExpanded ? "true" : "false");
          break;
        }

        case "addFolder": {
          const action = () => {
            this.showFolderNameModal({
              title: this.t("sidebar.addFolder"),
              existingNames: this.settings.folders.map((f) => f.name),
              onSubmit: (folderName) => {
                void this.addTopLevelFolder(folderName).then(() =>
                  this.render(),
                );
              },
            });
          };
          this.iconActions.set("addFolder", action);
          btn = createToolbarButton(iconConfig, action, toolbarT);
          break;
        }

        case "sort":
          // sort requires the MouseEvent for menu positioning; action stored in fireIconAction
          btn = createToolbarButton(
            iconConfig,
            () => {
              /* keyboard: no-op */
            },
            toolbarT,
          );
          btn.addEventListener("click", (e: MouseEvent) =>
            this.fireIconAction("sort", e),
          );
          break;

        case "collapseAll": {
          const action = () => {
            cachedCollapseAllPaths = null;
            this.toggleAllFolders();
            window.setTimeout(updateCollapseAllIcon, 0);
          };
          this.iconActions.set("collapseAll", action);
          btn = createToolbarButton(iconConfig, action, toolbarT);
          collapseAllBtnRef = btn;
          updateCollapseAllIcon();
          break;
        }

        case "settings": {
          const action = () => {
            const appWithSettings = this.app as AppWithInternalSettings;
            appWithSettings.setting?.open?.();
            appWithSettings.setting?.openTabById?.(this.plugin.manifest.id);
          };
          this.iconActions.set("settings", action);
          btn = createToolbarButton(iconConfig, action, toolbarT);
          break;
        }

        default:
          continue;
      }

      iconRow.appendChild(btn);
      this.iconBtnEls.set(id, btn);
    }

    // Hamburger button — always last; hidden until responsive collapse needs it
    // Set up scroll-fade indicators on the icon row wrapper
    iconRow.addEventListener("scroll", () => this.updateIconRowFades());

    // First-launch coachmark for the Add Feed button
    const addFeedBtn = this.iconBtnEls.get("addFeed");
    if (
      addFeedBtn &&
      !this.app.loadLocalStorage("rss-first-launch-coachmark-shown")
    ) {
      const coachmark = addFeedBtn.createDiv({
        cls: "rss-dashboard-coachmark",
        text: createTranslator(this.settings.locale ?? "zh-CN")(
          "sidebar.addFeed",
        ),
      });
      window.setTimeout(() => {
        if (!this.app.loadLocalStorage("rss-first-launch-coachmark-shown")) {
          this.app.saveLocalStorage("rss-first-launch-coachmark-shown", "true");
          if (coachmark.parentNode) coachmark.remove();
        }
      }, 5000);
    }

    this.addHorizontalScrollBehavior(iconRow);

    if (this.callbacks.onCloseMobileSidebar) {
      const rightActions = header.createDiv({
        cls: "rss-dashboard-sidebar-header-right",
      });
      const closeBtn = rightActions.createDiv({
        cls: "rss-dashboard-header-close-button clickable-icon",
        attr: {
          title: createTranslator(this.settings.locale ?? "zh-CN")(
            "sidebar.close",
          ),
          "aria-label": createTranslator(this.settings.locale ?? "zh-CN")(
            "sidebar.close",
          ),
          role: "button",
          tabindex: "0",
        },
      });
      setIcon(closeBtn, "panel-left-close");
      closeBtn.addEventListener("click", () => {
        this.callbacks.onCloseMobileSidebar?.();
      });
      closeBtn.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          this.callbacks.onCloseMobileSidebar?.();
        }
      });
    }
  }

  private addHorizontalScrollBehavior(iconRow: HTMLElement): void {
    // 1. Mouse wheel horizontal scrolling
    iconRow.addEventListener(
      "wheel",
      (e: WheelEvent) => {
        if (e.deltaY !== 0) {
          e.preventDefault();
          iconRow.scrollLeft += e.deltaY;
        }
      },
      { passive: false },
    );

    // 2. Touch/Mouse drag scrolling
    let isDown = false;
    let startX: number;
    let scrollLeft: number;
    let isDragging = false;

    const startDrag = (e: MouseEvent | TouchEvent) => {
      isDown = true;
      isDragging = false;
      const clientX =
        e instanceof MouseEvent ? e.clientX : e.touches[0].clientX;
      startX = clientX - iconRow.offsetLeft;
      scrollLeft = iconRow.scrollLeft;
    };

    const stopDrag = () => {
      isDown = false;
      iconRow.classList.remove("dragging");
    };

    const drag = (e: MouseEvent | TouchEvent) => {
      if (!isDown) return;
      e.preventDefault();
      const clientX =
        e instanceof MouseEvent ? e.clientX : e.touches[0].clientX;
      const x = clientX - iconRow.offsetLeft;
      const walk = (x - startX) * 2; // Scroll speed multiplier
      if (Math.abs(walk) > 5) {
        isDragging = true;
        iconRow.classList.add("dragging");
      }
      iconRow.scrollLeft = scrollLeft - walk;
    };

    iconRow.addEventListener("mousedown", startDrag);
    iconRow.addEventListener("mouseleave", stopDrag);
    iconRow.addEventListener("mouseup", stopDrag);
    iconRow.addEventListener("mousemove", drag);

    iconRow.addEventListener("touchstart", startDrag, { passive: true });
    iconRow.addEventListener("touchend", stopDrag);
    iconRow.addEventListener("touchcancel", stopDrag);
    iconRow.addEventListener("touchmove", drag, { passive: false });

    // Prevent clicks if we were dragging
    iconRow.addEventListener(
      "click",
      (e) => {
        if (isDragging) {
          e.preventDefault();
          e.stopPropagation();
          isDragging = false;
        }
      },
      { capture: true },
    );
  }

  private updateIconRowFades(): void {
    const iconRow = this.container.querySelector<HTMLElement>(
      ".rss-dashboard-header-icon-row",
    );
    const wrapper = this.container.querySelector<HTMLElement>(
      ".rss-icon-row-wrapper",
    );
    if (!iconRow || !wrapper) return;
    wrapper.toggleClass("has-overflow-left", iconRow.scrollLeft > 0);
    wrapper.toggleClass(
      "has-overflow-right",
      iconRow.scrollLeft + iconRow.clientWidth < iconRow.scrollWidth - 1,
    );
  }

  private fireIconAction(id: string, e?: MouseEvent): void {
    if (id === "sort") {
      const menu = new Menu();

      menu.addItem((item) =>
        item.setTitle(this.t("sidebar.customSort")).onClick(() => {
          void this.setAllSidebarSortModesCustom();
        }),
      );
      menu.addSeparator();

      menu.addItem((item) =>
        item
          .setTitle(this.t("sidebar.sortNameAsc"))
          .onClick(() => void this.sortAllFeeds("name", true)),
      );
      menu.addItem((item) =>
        item
          .setTitle(this.t("sidebar.sortNameDesc"))
          .onClick(() => void this.sortAllFeeds("name", false)),
      );
      menu.addItem((item) =>
        item
          .setTitle(this.t("sidebar.sortUnreadDesc"))
          .onClick(() => void this.sortAllFeeds("unreadCount", false)),
      );
      menu.addItem((item) =>
        item
          .setTitle(this.t("sidebar.sortUnreadAsc"))
          .onClick(() => void this.sortAllFeeds("unreadCount", true)),
      );
      menu.addItem((item) =>
        item
          .setTitle(this.t("sidebar.sortFolderNameAsc"))
          .onClick(() => void this.sortFolders("name", true)),
      );
      menu.addItem((item) =>
        item
          .setTitle(this.t("sidebar.sortFolderNameDesc"))
          .onClick(() => void this.sortFolders("name", false)),
      );
      menu.addItem((item) =>
        item
          .setTitle(this.t("sidebar.sortModifiedDesc"))
          .onClick(() => void this.sortFolders("modified", false)),
      );
      menu.addItem((item) =>
        item
          .setTitle(this.t("sidebar.sortModifiedAsc"))
          .onClick(() => void this.sortFolders("modified", true)),
      );
      menu.addItem((item) =>
        item
          .setTitle(this.t("sidebar.sortCreatedDesc"))
          .onClick(() => void this.sortFolders("created", false)),
      );
      menu.addItem((item) =>
        item
          .setTitle(this.t("sidebar.sortCreatedAsc"))
          .onClick(() => void this.sortFolders("created", true)),
      );
      if (e) {
        menu.showAtMouseEvent(e);
      } else {
        const sortBtn = this.iconBtnEls.get("sort");
        if (sortBtn) {
          const rect = sortBtn.getBoundingClientRect();
          menu.showAtPosition({ x: rect.left, y: rect.bottom });
        }
      }
      return;
    }
    const action = this.iconActions.get(id);
    if (action) action(e);
  }

  private renderSearchDock(parentEl: HTMLElement): void {
    if (!this.isSearchExpanded) return;

    const searchDock = parentEl.createDiv({
      cls: "rss-dashboard-search-dock",
    });
    const searchContainer = searchDock.createDiv({
      cls: "rss-dashboard-search-container",
    });
    const searchInput = searchContainer.createEl("input", {
      cls: "rss-dashboard-search-input",
      attr: {
        type: "text",
        placeholder: createTranslator(this.settings.locale ?? "zh-CN")(
          "sidebar.search",
        ),
        "aria-label": createTranslator(this.settings.locale ?? "zh-CN")(
          "sidebar.searchFeeds",
        ),
        autocomplete: "off",
        spellcheck: "false",
        value: this.searchQuery,
      },
    });

    let searchTimeout: number;

    attachInputClearButton(
      searchContainer,
      searchInput,
      () => {
        this.searchQuery = "";
        if (searchTimeout) {
          window.clearTimeout(searchTimeout);
        }
        this.filterFeedsAndFolders("");
        searchInput.focus();
      },
      {
        buttonClass: "rss-dashboard-search-clear",
        hiddenClass: "is-hidden",
        useButtonElement: true,
      },
    );

    searchInput.addEventListener("focus", () => {
      searchInput.select();

      // On mobile, ensure the input is visible above the keyboard
      if (activeWindow.innerWidth <= 768) {
        window.setTimeout(() => {
          searchInput.scrollIntoView({ behavior: "smooth", block: "center" });
        }, 100);
      }
    });

    searchInput.addEventListener("input", (e) => {
      const rawQuery = (e.target as HTMLInputElement)?.value || "";
      this.searchQuery = rawQuery;
      const query = rawQuery.toLowerCase().trim();
      if (searchTimeout) {
        window.clearTimeout(searchTimeout);
      }
      searchTimeout = window.setTimeout(() => {
        this.filterFeedsAndFolders(query);
      }, 150);
    });

    window.requestAnimationFrame(() => {
      searchInput.focus();
      if (activeWindow.innerWidth <= 768) {
        window.setTimeout(() => {
          searchInput.scrollIntoView({ behavior: "smooth", block: "center" });
        }, 100);
      }
    });
  }

  public renderToolbar(parentEl: HTMLElement, inline = false): void {
    const sidebarToolbar = parentEl.createDiv({
      cls:
        "rss-dashboard-sidebar-toolbar" +
        (inline ? " rss-dashboard-sidebar-toolbar--inline" : ""),
    });

    const addFolderButton = sidebarToolbar.createDiv({
      cls: "rss-dashboard-toolbar-button",
      attr: {
        title: this.t("sidebar.addFolder"),
        "aria-label": this.t("sidebar.addFolder"),
      },
    });
    setIcon(addFolderButton, "folder-plus");
    addFolderButton.addEventListener("click", () => {
      this.showFolderNameModal({
        title: this.t("sidebar.addFolder"),
        existingNames: this.settings.folders.map((f) => f.name),
        onSubmit: (folderName) => {
          void this.addTopLevelFolder(folderName).then(() => this.render());
        },
      });
    });

    const sortButton = sidebarToolbar.createDiv({
      cls: "rss-dashboard-toolbar-button",
      attr: {
        title: this.t("sidebar.sortFolders"),
        "aria-label": this.t("sidebar.sortFolders"),
      },
    });
    setIcon(sortButton, "sort-asc");
    sortButton.addEventListener("click", (e) => {
      const menu = new Menu();

      menu.addItem((item) =>
        item.setTitle(this.t("sidebar.sortNameAsc")).onClick(() => {
          void this.sortAllFeeds("name", true);
        }),
      );
      menu.addItem((item) =>
        item.setTitle(this.t("sidebar.sortNameDesc")).onClick(() => {
          void this.sortAllFeeds("name", false);
        }),
      );
      menu.addItem((item) =>
        item.setTitle(this.t("sidebar.sortUnreadDesc")).onClick(() => {
          void this.sortAllFeeds("unreadCount", false);
        }),
      );
      menu.addItem((item) =>
        item.setTitle(this.t("sidebar.sortUnreadAsc")).onClick(() => {
          void this.sortAllFeeds("unreadCount", true);
        }),
      );
      menu.addItem((item) =>
        item.setTitle(this.t("sidebar.sortFolderNameAsc")).onClick(() => {
          void this.sortFolders("name", true);
        }),
      );
      menu.addItem((item) =>
        item.setTitle(this.t("sidebar.sortFolderNameDesc")).onClick(() => {
          void this.sortFolders("name", false);
        }),
      );
      menu.addItem((item) =>
        item.setTitle(this.t("sidebar.sortModifiedDesc")).onClick(() => {
          void this.sortFolders("modified", false);
        }),
      );
      menu.addItem((item) =>
        item.setTitle(this.t("sidebar.sortModifiedAsc")).onClick(() => {
          void this.sortFolders("modified", true);
        }),
      );
      menu.addItem((item) =>
        item.setTitle(this.t("sidebar.sortCreatedDesc")).onClick(() => {
          void this.sortFolders("created", false);
        }),
      );
      menu.addItem((item) =>
        item.setTitle(this.t("sidebar.sortCreatedAsc")).onClick(() => {
          void this.sortFolders("created", true);
        }),
      );

      menu.showAtMouseEvent(e);
    });

    const collapseAllButton = sidebarToolbar.createDiv({
      cls: "rss-dashboard-toolbar-button",
      attr: {
        title: this.t("sidebar.toggleAllFolders"),
        "aria-label": this.t("sidebar.toggleAllFolders"),
      },
    });

    let cachedFolderPaths: string[] | null = null;

    const updateCollapseIcon = () => {
      if (!cachedFolderPaths) {
        cachedFolderPaths = this.getCachedFolderPaths();
      }

      const collapsedFolders = this.settings.collapsedFolders || [];
      const allCollapsed =
        cachedFolderPaths.length > 0 &&
        cachedFolderPaths.every((path) => collapsedFolders.includes(path));
      setIcon(
        collapseAllButton,
        allCollapsed ? "chevrons-down-up" : "chevrons-up-down",
      );
    };

    updateCollapseIcon();

    collapseAllButton.addEventListener("click", () => {
      cachedFolderPaths = null;
      this.toggleAllFolders();

      window.setTimeout(() => updateCollapseIcon(), 0);
    });

    const searchButton = sidebarToolbar.createDiv({
      cls: "rss-dashboard-toolbar-button",
      attr: {
        title: this.t("sidebar.searchFeeds"),
        "aria-label": this.t("sidebar.searchFeeds"),
        role: "button",
        tabindex: "0",
      },
    });
    searchButton.toggleClass("is-active", this.isSearchExpanded);
    searchButton.setAttr(
      "aria-pressed",
      this.isSearchExpanded ? "true" : "false",
    );
    setIcon(searchButton, "search");
    const toggleSearch = () => {
      this.isSearchExpanded = !this.isSearchExpanded;
      this.render();

      if (this.isSearchExpanded) {
        window.requestAnimationFrame(() => {
          const searchInput = this.container.querySelector<HTMLInputElement>(
            ".rss-dashboard-search-input",
          );
          if (!searchInput) return;
          searchInput.focus();
          searchInput.select();
          searchInput.scrollIntoView({ block: "nearest" });
        });
      }
    };
    searchButton.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleSearch();
    });
    searchButton.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleSearch();
      }
    });
  }

  private showAddFeedModal(defaultFolder = "Uncategorized"): void {
    this.plugin.openAddSourceModal({ initialFolder: defaultFolder });
  }

  public showEditFeedModal(
    _feed: Feed,
    _options?: {
      expandSection?: "per-feed" | "rules";
      highlightSection?: "per-feed" | "rules";
    },
  ): void {
    new FeedManagerModal(this.app, this.plugin).open();
  }

  private showFolderAutoTagModal(folderPath: string): void {
    const folder = this.findFolderByPath(folderPath);
    if (!folder) {
      new Notice(this.t("sidebar.folderNotFound"));
      return;
    }

    new FolderAutoTagModal(
      this.app,
      this.plugin,
      folderPath,
      (folder.autoTags ?? []).map((tag) => tag.name),
      async (selectedTags, includeSubfolders, existingArticlesAction) => {
        const previousTags = [...(folder.autoTags ?? [])];

        const applyFolderRule = async (): Promise<void> => {
          folder.autoTags = selectedTags;
          folder.modifiedAt = Date.now();
          await this.plugin.saveSettings();
          this.render();
        };

        if (existingArticlesAction === "none") {
          await applyFolderRule();
          return;
        }

        const confirmMessage = buildFolderTagConfirmMessage(
          folderPath,
          includeSubfolders,
          existingArticlesAction,
          previousTags,
          selectedTags,
        );

        this.showConfirmModal(confirmMessage, () => {
          void (async () => {
            const pathsToUpdate = includeSubfolders
              ? this.getAllDescendantFolderPaths(folderPath)
              : [folderPath];

            let articlesUpdated = 0;
            if (existingArticlesAction === "remove_all") {
              articlesUpdated = removeAllTagsFromFeeds(
                this.settings.feeds,
                pathsToUpdate,
              );
            } else {
              articlesUpdated = syncFolderAutoTagsOnFeeds(
                this.settings.feeds,
                pathsToUpdate,
                previousTags,
                selectedTags,
              );
            }

            await applyFolderRule();

            if (existingArticlesAction === "remove_all") {
              new Notice(
                this.t("sidebar.removedTags", { count: articlesUpdated }),
              );
            } else {
              new Notice(
                this.t("sidebar.updatedAutoTags", { count: articlesUpdated }),
              );
            }
          })();
        });
      },
    ).open();
  }

  private showFeedContextMenu(event: MouseEvent, feed: Feed): void {
    const menu = new Menu();

    if (this.isMultiSelectionTarget("feed", feed.url)) {
      this.appendSelectionContextMenu(menu);
      menu.showAtMouseEvent(event);
      return;
    }

    if (feed.lastFetchError) {
      menu.addItem((item: MenuItem) => {
        item
          .setTitle(this.t("sidebar.viewFetchError"))
          .setIcon("alert-circle")
          .onClick(() => {
            this.showErrorDetailModal(feed.lastFetchError!, feed.title);
          });
      });
      menu.addSeparator();
    }

    menu.addItem((item: MenuItem) => {
      item
        .setTitle(this.t("sidebar.updateFeed"))
        .setIcon("refresh-cw")
        .onClick(() => {
          void this.callbacks.onUpdateFeed(feed);
        });
    });

    menu.addItem((item: MenuItem) => {
      item
        .setTitle(this.t("sidebar.editFeed"))
        .setIcon("edit")
        .onClick(() => {
          this.showEditFeedModal(feed);
        });
    });

    menu.addItem((item: MenuItem) => {
      item
        .setTitle(this.t("sidebar.markAllRead"))
        .setIcon("check-circle")
        .onClick(() => {
          void this.markFeedsReadStatus([feed], true).then((count) => {
            if (count !== null && count > 0) this.render();
          });
        });
    });

    if (feed.sourceKind !== "x-account" && feed.sourceKind !== "x-topic") {
      menu.addItem((item: MenuItem) => {
        item
          .setTitle(this.t("sidebar.changeMediaType"))
          .setIcon("circle-gauge")
          .onClick((evt) => {
            const typeMenu = new Menu();
            typeMenu.addItem((subItem: MenuItem) => {
              subItem
                .setTitle(this.t("sidebar.mediaArticle"))
                .setIcon("file-text")
                .onClick(() => {
                  void this.updateSubscriptionOptions(feed, {
                    mediaType: "article",
                  });
                });
            });
            typeMenu.addItem((subItem: MenuItem) => {
              subItem
                .setTitle(this.t("sidebar.mediaPodcast"))
                .setIcon("headphones")
                .onClick(() => {
                  void this.updateSubscriptionOptions(feed, {
                    mediaType: "podcast",
                  });
                });
            });
            typeMenu.addItem((subItem: MenuItem) => {
              subItem
                .setTitle(this.t("sidebar.mediaVideo"))
                .setIcon("play-circle")
                .onClick(() => {
                  void this.updateSubscriptionOptions(feed, {
                    mediaType: "video",
                  });
                });
            });
            if (evt instanceof MouseEvent) {
              typeMenu.showAtMouseEvent(evt);
            }
          });
      });
    }

    menu.addItem((item: MenuItem) => {
      item
        .setTitle(this.t("sidebar.moveToFolder"))
        .setIcon("folder-open")
        .onClick((evt) => {
          if (evt instanceof MouseEvent) {
            this.showMoveToFolderMenu(evt, feed);
          }
        });
    });

    menu.addItem((item: MenuItem) => {
      item
        .setTitle(this.t("sidebar.deleteFeed"))
        .setIcon("trash")
        .onClick(() => {
          this.showConfirmModal(
            this.t("sidebar.deleteFeedConfirm", { feed: feed.title }),
            () => {
              this.callbacks.onDeleteFeed(feed);
            },
          );
        });
    });

    menu.showAtMouseEvent(event);
  }

  private showMoveToFolderMenu(event: MouseEvent, feed: Feed): void {
    const menu = new Menu();

    // Add option to move to root (no folder)
    menu.addItem((item: MenuItem) => {
      const isInRoot = !feed.folder;
      item
        .setTitle(this.t("sidebar.rootFolder"))
        .setIcon(isInRoot ? "check" : "folder")
        .onClick(() => {
          void this.updateSubscriptionOptions(feed, { folder: "" }).then(
            (saved) => {
              if (saved) {
                new Notice(this.t("sidebar.movedToRoot", { feed: feed.title }));
              }
            },
          );
        });
    });

    // Add separator
    menu.addSeparator();

    // Add all available folders
    const allFolders = this.getCachedFolderPaths();
    if (allFolders.length > 0) {
      allFolders.sort((a, b) => a.localeCompare(b));

      allFolders.forEach((folderPath) => {
        const isCurrentFolder = feed.folder === folderPath;
        menu.addItem((item: MenuItem) => {
          item
            .setTitle(folderPath)
            .setIcon(isCurrentFolder ? "check" : "folder")
            .onClick(() => {
              if (feed.folder !== folderPath) {
                void this.updateSubscriptionOptions(feed, {
                  folder: folderPath,
                }).then((saved) => {
                  if (saved) {
                    new Notice(
                      this.t("sidebar.movedToFolder", {
                        feed: feed.title,
                        folder: folderPath,
                      }),
                    );
                  }
                });
              }
            });
        });
      });
    }

    // Add option to create new folder
    menu.addSeparator();
    menu.addItem((item: MenuItem) => {
      item
        .setTitle(this.t("sidebar.createFolder"))
        .setIcon("folder-plus")
        .onClick(() => {
          this.showFolderNameModal({
            title: this.t("sidebar.createFolder"),
            existingNames: this.settings.folders.map((f) => f.name),
            onSubmit: (folderName) => {
              void (async () => {
                await this.addTopLevelFolder(folderName);
                const saved = await this.updateSubscriptionOptions(feed, {
                  folder: folderName,
                });
                if (saved) {
                  new Notice(
                    this.t("sidebar.createdAndMoved", {
                      folder: folderName,
                      feed: feed.title,
                    }),
                  );
                }
              })();
            },
          });
        });
    });

    menu.showAtMouseEvent(event);
  }

  private async updateSubscriptionOptions(
    feed: Feed,
    patch: {
      folder?: string;
      mediaType?: "article" | "video" | "podcast";
    },
    renderOnSuccess = true,
  ): Promise<boolean> {
    const sourceId = feed.feedId ?? feed.url;
    let request:
      | FeedSubscriptionOptionsUpdateRequest
      | XSubscriptionOptionsUpdateRequest;
    if (feed.sourceKind === "x-account") {
      if (patch.mediaType !== undefined) return false;
      request = { kind: "x-account-options", ...patch };
    } else if (feed.sourceKind === "x-topic") {
      return false;
    } else {
      request = { kind: "feed-options", ...patch };
    }
    let saved = false;
    try {
      saved = await this.plugin.updateSubscription(sourceId, request);
    } catch {
      saved = false;
    }
    if (saved && renderOnSuccess) this.render();
    return saved;
  }

  private _sortFolders(
    by: "name" | "created" | "modified",
    ascending: boolean,
  ) {
    const sorter = (a: Folder, b: Folder): number => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;

      let valA: string | number, valB: string | number;

      switch (by) {
        case "name":
          valA = a.name;
          valB = b.name;
          return (
            valA.localeCompare(valB, undefined, { numeric: true }) *
            (ascending ? 1 : -1)
          );
        case "created":
          valA = a.createdAt || 0;
          valB = b.createdAt || 0;
          break;
        case "modified":
          valA = a.modifiedAt || 0;
          valB = b.modifiedAt || 0;
          break;
        default:
          return 0;
      }

      if (valA < valB) return ascending ? -1 : 1;
      if (valA > valB) return ascending ? 1 : -1;
      return 0;
    };

    const recursiveSort = (folders: Folder[]): Folder[] => {
      const sortedFolders = [...folders].sort(sorter);

      sortedFolders.forEach((f) => {
        if (f.subfolders && f.subfolders.length > 0) {
          f.subfolders = recursiveSort(f.subfolders);
        }
      });

      return sortedFolders;
    };

    this.settings.folders = recursiveSort(this.settings.folders);
  }

  private async sortFolders(
    by: "name" | "created" | "modified",
    ascending: boolean,
  ) {
    this._sortFolders(by, ascending);

    this.settings.folderSortOrder = { by, ascending };
    await this.plugin.saveSettings();
    this.render();
  }

  private showFeedSortMenu(event: MouseEvent, folderPath: string): void {
    const menu = new Menu();

    menu.addItem((item) =>
      item.setTitle(this.t("sidebar.customSort")).onClick(() => {
        void this.setFolderFeedSortModeCustom(folderPath);
      }),
    );
    menu.addSeparator();

    menu.addItem((item) =>
      item.setTitle(this.t("sidebar.sortNameAsc")).onClick(() => {
        void this.sortFeedsInFolder(folderPath, "name", true);
      }),
    );
    menu.addItem((item) =>
      item.setTitle(this.t("sidebar.sortNameDesc")).onClick(() => {
        void this.sortFeedsInFolder(folderPath, "name", false);
      }),
    );
    menu.addItem((item) =>
      item.setTitle(this.t("sidebar.sortCreatedDesc")).onClick(() => {
        void this.sortFeedsInFolder(folderPath, "created", false);
      }),
    );
    menu.addItem((item) =>
      item.setTitle(this.t("sidebar.sortCreatedAsc")).onClick(() => {
        void this.sortFeedsInFolder(folderPath, "created", true);
      }),
    );
    menu.addItem((item) =>
      item.setTitle(this.t("sidebar.sortItemCountDesc")).onClick(() => {
        void this.sortFeedsInFolder(folderPath, "itemCount", false);
      }),
    );
    menu.addItem((item) =>
      item.setTitle(this.t("sidebar.sortItemCountAsc")).onClick(() => {
        void this.sortFeedsInFolder(folderPath, "itemCount", true);
      }),
    );

    menu.showAtMouseEvent(event);
  }

  private async setAllSidebarSortModesCustom(): Promise<void> {
    setFolderSortCustom(this.settings);

    // Ensure root key exists so root feeds stop re-sorting once custom ordering is used.
    setFolderFeedSortCustom(this.settings, "");

    if (this.settings.folderFeedSortOrders) {
      for (const key of Object.keys(this.settings.folderFeedSortOrders)) {
        setFolderFeedSortCustom(this.settings, key);
      }
    }

    await this.plugin.saveSettings();
    this.render();
  }

  private async setFolderFeedSortModeCustom(folderPath: string): Promise<void> {
    setFolderFeedSortCustom(this.settings, folderPath);
    await this.plugin.saveSettings();
    this.render();
  }

  private async sortFeedsInFolder(
    folderPath: string,
    by: "name" | "created" | "itemCount" | "unreadCount",
    ascending: boolean,
  ) {
    let feedsInFolder: Feed[];

    if (folderPath) {
      feedsInFolder = this.settings.feeds.filter(
        (feed) => feed.folder === folderPath,
      );
    } else {
      const allFolderPaths = new Set(this.getCachedFolderPaths());
      feedsInFolder = this.settings.feeds.filter(
        (feed) => !feed.folder || !allFolderPaths.has(feed.folder),
      );
    }

    if (feedsInFolder.length === 0) {
      new Notice(this.t("sidebar.noFeedsInFolder"));
      return;
    }

    const sortedFeeds = this.applyFeedSortOrder([...feedsInFolder], {
      by,
      ascending,
    });

    if (folderPath) {
      this.settings.feeds = this.settings.feeds.filter(
        (feed) => feed.folder !== folderPath,
      );
    } else {
      const allFolderPaths = new Set(this.getCachedFolderPaths());
      this.settings.feeds = this.settings.feeds.filter(
        (feed) => feed.folder && allFolderPaths.has(feed.folder),
      );
    }

    this.settings.feeds.push(...sortedFeeds);

    if (!this.settings.folderFeedSortOrders) {
      this.settings.folderFeedSortOrders = {};
    }
    this.settings.folderFeedSortOrders[folderPath] = { by, ascending };

    await this.plugin.saveSettings();

    const fieldKey =
      by === "name"
        ? "sidebar.sortFieldName"
        : by === "created"
          ? "sidebar.sortFieldCreated"
          : "sidebar.sortFieldItemCount";
    new Notice(
      this.t("sidebar.sortedFeeds", {
        folder: folderPath || this.t("sidebar.root"),
        field: this.t(fieldKey),
        direction: this.t(
          ascending ? "sidebar.ascending" : "sidebar.descending",
        ),
      }),
    );
    this.render();
  }

  private applyFeedSortOrder(
    feeds: Feed[],
    sortOrder: {
      by: "name" | "created" | "itemCount" | "unreadCount" | "custom";
      ascending: boolean;
    },
  ): Feed[] {
    return applyFeedSortOrder(feeds, sortOrder);
  }

  private async sortAllFeeds(
    by: "name" | "created" | "itemCount" | "unreadCount",
    ascending: boolean,
  ) {
    if (!this.settings.folderFeedSortOrders) {
      this.settings.folderFeedSortOrders = {};
    }

    const allFolderPaths = this.getCachedFolderPaths();
    const pathsToSort = ["", ...allFolderPaths];

    for (const folderPath of pathsToSort) {
      let feedsInFolder: Feed[];
      if (folderPath) {
        feedsInFolder = this.settings.feeds.filter(
          (feed) => feed.folder === folderPath,
        );
      } else {
        const pathsSet = new Set(allFolderPaths);
        feedsInFolder = this.settings.feeds.filter(
          (feed) => !feed.folder || !pathsSet.has(feed.folder),
        );
      }

      if (feedsInFolder.length > 0) {
        const sortedFeeds = this.applyFeedSortOrder([...feedsInFolder], {
          by,
          ascending,
        });

        if (folderPath) {
          this.settings.feeds = this.settings.feeds.filter(
            (feed) => feed.folder !== folderPath,
          );
        } else {
          const pathsSet = new Set(allFolderPaths);
          this.settings.feeds = this.settings.feeds.filter(
            (feed) => feed.folder && pathsSet.has(feed.folder),
          );
        }
        this.settings.feeds.push(...sortedFeeds);
      }
      this.settings.folderFeedSortOrders[folderPath] = { by, ascending };
    }

    await this.plugin.saveSettings();
    this.render();
  }

  private toggleAllFolders(): void {
    const allFolderPaths = this.getCachedFolderPaths();

    if (allFolderPaths.length === 0) {
      return;
    }

    // Use settings.collapsedFolders directly to ensure we have the latest state
    // especially in modal views where options might have stale references
    const collapsedFolders = this.settings.collapsedFolders || [];
    const collapsedSet = new Set(collapsedFolders);
    const allCollapsed = allFolderPaths.every((path) => collapsedSet.has(path));

    if (allCollapsed) {
      const foldersToExpand = allFolderPaths;
      const foldersToCollapse: string[] = [];
      this.callbacks.onBatchToggleFolders?.(foldersToCollapse, foldersToExpand);
      new Notice(this.t("sidebar.allFoldersExpanded"));
    } else {
      const foldersToExpand: string[] = [];
      const foldersToCollapse = allFolderPaths;
      this.callbacks.onBatchToggleFolders?.(foldersToCollapse, foldersToExpand);
      new Notice(this.t("sidebar.allFoldersCollapsed"));
    }

    // Trigger immediate re-render for UI update
    this.render();
  }

  private async handleRefresh(): Promise<void> {
    if (this.plugin.isMultiFeedRefreshActive) return;
    this.plugin.cancelPendingStartupRefresh();
    await this.plugin.refreshFeeds();
  }

  private collectAncestorFolders(element: HTMLElement): HTMLElement[] {
    const ancestors: HTMLElement[] = [];
    let current = element.parentElement;
    while (current) {
      if (current.classList.contains("rss-dashboard-feed-folder")) {
        ancestors.push(current);
      }
      current = current.parentElement;
    }
    return ancestors;
  }

  private forceExpandFolderForSearch(folderEl: HTMLElement): void {
    const folderHeader = folderEl.querySelector<HTMLElement>(
      ".rss-dashboard-feed-folder-header",
    );
    const folderFeeds = folderEl.querySelector<HTMLElement>(
      ".rss-dashboard-folder-feeds",
    );
    if (!folderHeader || !folderFeeds) return;
    if (folderFeeds.getAttribute("data-search-expanded") === "true") return;

    const wasHeaderCollapsed = folderHeader.classList.contains("collapsed");
    const wasListCollapsed = folderFeeds.classList.contains("collapsed");

    folderHeader.setAttribute("data-search-expanded", "true");
    folderFeeds.setAttribute("data-search-expanded", "true");
    folderHeader.setAttribute(
      "data-search-was-collapsed",
      wasHeaderCollapsed ? "true" : "false",
    );
    folderFeeds.setAttribute(
      "data-search-was-collapsed",
      wasListCollapsed ? "true" : "false",
    );

    folderHeader.removeClass("collapsed");
    folderFeeds.removeClass("collapsed");

    const toggleButton = folderHeader.querySelector<HTMLElement>(
      ".rss-dashboard-feed-folder-toggle",
    );
    if (toggleButton) {
      setIcon(toggleButton, "chevron-down");
    }
  }

  private resetSidebarSearchPresentation(): void {
    this.container
      .querySelectorAll<HTMLElement>(".rss-dashboard-search-hidden")
      .forEach((el) => el.removeClass("rss-dashboard-search-hidden"));

    this.container
      .querySelectorAll<HTMLElement>(
        '.rss-dashboard-feed-folder-header[data-search-expanded="true"]',
      )
      .forEach((header) => {
        const wasCollapsed =
          header.getAttribute("data-search-was-collapsed") === "true";
        if (wasCollapsed) {
          header.addClass("collapsed");
        }
        const toggleButton = header.querySelector<HTMLElement>(
          ".rss-dashboard-feed-folder-toggle",
        );
        if (toggleButton) {
          setIcon(
            toggleButton,
            wasCollapsed ? "chevron-right" : "chevron-down",
          );
        }
        header.removeAttribute("data-search-expanded");
        header.removeAttribute("data-search-was-collapsed");
      });

    this.container
      .querySelectorAll<HTMLElement>(
        '.rss-dashboard-folder-feeds[data-search-expanded="true"]',
      )
      .forEach((feedList) => {
        const wasCollapsed =
          feedList.getAttribute("data-search-was-collapsed") === "true";
        if (wasCollapsed) {
          feedList.addClass("collapsed");
        }
        feedList.removeAttribute("data-search-expanded");
        feedList.removeAttribute("data-search-was-collapsed");
      });
  }

  /**
   * Filter sidebar entities by search query.
   * Supports scoped queries: feed:, folder:/path:, tag:
   */
  private filterFeedsAndFolders(query: string): void {
    this.resetSidebarSearchPresentation();

    const parsedQuery = SidebarSearchService.parseQuery(query);

    const feedElements = Array.from(
      this.container.querySelectorAll<HTMLElement>(".rss-dashboard-feed"),
    );
    const folderElements = Array.from(
      this.container.querySelectorAll<HTMLElement>(
        ".rss-dashboard-feed-folder",
      ),
    );
    const allFeedsButton = this.container.querySelector<HTMLElement>(
      ".rss-dashboard-all-feeds-button",
    );

    if (!parsedQuery.term) {
      allFeedsButton?.removeClass("rss-dashboard-search-hidden");
      return;
    }

    const folderDirectMatches = new Map<HTMLElement, boolean>();
    folderElements.forEach((folderEl) => {
      const header = folderEl.querySelector<HTMLElement>(
        ".rss-dashboard-feed-folder-header",
      );
      const folderPath =
        folderEl.dataset.folderPath || header?.dataset.folderPath || "";
      const folderName =
        header?.dataset.folderName ||
        header
          ?.querySelector(".rss-dashboard-feed-folder-name")
          ?.textContent?.trim() ||
        "";

      folderDirectMatches.set(
        folderEl,
        SidebarSearchService.matchesFolder(parsedQuery, folderName, folderPath),
      );
    });

    feedElements.forEach((feedEl) => {
      const feedTitle =
        feedEl.dataset.feedTitle ||
        feedEl.querySelector(".rss-dashboard-feed-name")?.textContent?.trim() ||
        "";
      const feedFolderPath = feedEl.dataset.feedFolder || "";

      const feedMatch = SidebarSearchService.matchesFeed(
        parsedQuery,
        feedTitle,
        feedFolderPath,
      );

      const hasMatchedFolderAncestor = this.collectAncestorFolders(feedEl).some(
        (folderEl) => folderDirectMatches.get(folderEl) === true,
      );

      if (feedMatch || hasMatchedFolderAncestor) {
        feedEl.removeClass("rss-dashboard-search-hidden");
      } else {
        feedEl.addClass("rss-dashboard-search-hidden");
      }
    });

    const folderVisible = new Map<HTMLElement, boolean>();
    [...folderElements].reverse().forEach((folderEl) => {
      const directMatch = folderDirectMatches.get(folderEl) === true;
      const hasVisibleFeeds =
        folderEl.querySelectorAll(
          ".rss-dashboard-feed:not(.rss-dashboard-search-hidden)",
        ).length > 0;

      const folderFeedContainer = folderEl.querySelector<HTMLElement>(
        ".rss-dashboard-folder-feeds",
      );
      const hasVisibleSubfolder = Array.from(
        folderFeedContainer?.children ?? [],
      ).some(
        (child) =>
          windowInstanceOf(child, HTMLElement) &&
          child.classList.contains("rss-dashboard-feed-folder") &&
          folderVisible.get(child) === true,
      );

      const shouldShow = directMatch || hasVisibleFeeds || hasVisibleSubfolder;
      folderVisible.set(folderEl, shouldShow);

      const header = folderEl.querySelector<HTMLElement>(
        ".rss-dashboard-feed-folder-header",
      );
      if (shouldShow) {
        folderEl.removeClass("rss-dashboard-search-hidden");
        header?.removeClass("rss-dashboard-search-hidden");
        this.forceExpandFolderForSearch(folderEl);
      } else {
        folderEl.addClass("rss-dashboard-search-hidden");
        header?.addClass("rss-dashboard-search-hidden");
      }
    });

    const visibleFeeds = this.container.querySelectorAll(
      ".rss-dashboard-feed:not(.rss-dashboard-search-hidden)",
    ).length;
    if (visibleFeeds === 0) {
      allFeedsButton?.addClass("rss-dashboard-search-hidden");
    } else {
      allFeedsButton?.removeClass("rss-dashboard-search-hidden");
    }
  }

  private applySearchFilterFromState(): void {
    const query = this.isSearchExpanded
      ? this.searchQuery.toLowerCase().trim()
      : "";
    this.filterFeedsAndFolders(query);
  }

  /**
   * Clear the search and show all feeds/folders
   */
  public clearFeedSearch(): void {
    this.isSearchExpanded = false;
    this.render();
  }
}
