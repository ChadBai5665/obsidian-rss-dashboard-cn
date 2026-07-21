import { setIcon } from "obsidian";
import { RssDashboardSettings } from "../types/types";
import { FilterChangeEvent } from "./article-filter-menu";
import { createTranslator } from "../i18n";

type MenuOptionEntries = Array<[label: string, value: string]>;

export interface ArticleHeaderMenuCallbacks {
  onSearch: (query: string) => void;
  onSortChange: (value: "newest" | "oldest") => void;
  onGroupChange: (value: "none" | "feed" | "date" | "folder") => void;
  onFilterChange: (event: FilterChangeEvent) => void;
  onToggleViewStyle: (style: "list" | "card" | "feed") => void;
  onPersistSettings: () => Promise<void> | void;
  onRefreshFeeds: () => Promise<void>;
  onMarkAllAsRead: () => void;
  onMarkAllAsUnread: () => void;
}

export class ArticleHeaderMenu {
  private settings: RssDashboardSettings;
  private searchQuery: string;
  private callbacks: ArticleHeaderMenuCallbacks;
  private searchInput: HTMLInputElement | null = null;
  private hamburgerBtn: HTMLElement | null = null;
  private dropdownMenu: HTMLElement | null = null;
  private rootEl: HTMLElement | null = null;
  private activePortal: HTMLElement | null = null;
  private activePortalToggleBtn: HTMLElement | null = null;
  private activePortalCleanup: (() => void) | null = null;
  private documentListeners: Array<{
    target: Document | Window;
    type: string;
    listener: EventListenerOrEventListenerObject;
  }> = [];

  private t(
    key: Parameters<ReturnType<typeof createTranslator>>[0],
    params?: Record<string, string | number>,
  ): string {
    return createTranslator(this.settings.locale ?? "zh-CN")(key, params);
  }

  constructor(
    settings: RssDashboardSettings,
    searchQuery: string,
    callbacks: ArticleHeaderMenuCallbacks,
  ) {
    this.settings = settings;
    this.searchQuery = searchQuery;
    this.callbacks = callbacks;
  }

  public render(parent: HTMLElement): void {
    this.destroy();

    const hamburgerMenu = parent.createDiv({
      cls: "rss-dashboard-hamburger-menu",
    });
    this.rootEl = hamburgerMenu;

    const hamburgerBtn = hamburgerMenu.createDiv({
      cls: "rss-dashboard-hamburger-button clickable-icon",
      attr: {
        title: this.t("dashboard.menu"),
        "aria-label": this.t("dashboard.menu"),
        role: "button",
        tabindex: "0",
      },
    });
    setIcon(hamburgerBtn, "menu");

    const dropdownMenu = hamburgerMenu.createDiv({
      cls: "rss-dashboard-dropdown-menu",
    });
    const dropdownControls = dropdownMenu.createDiv({
      cls: "rss-dashboard-dropdown-controls",
    });
    this.createControls(dropdownControls);

    this.hamburgerBtn = hamburgerBtn;
    this.dropdownMenu = dropdownMenu;

    hamburgerBtn.addEventListener(
      "click",
      (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();

        if (dropdownMenu.classList.contains("is-menu-open")) {
          this.closeMenu();
          return;
        }

        this.closeActivePortal();
        dropdownMenu.classList.add("is-menu-open");
        hamburgerBtn.classList.add("is-menu-open");
      },
      { capture: true },
    );

    const targetDocument = parent.ownerDocument;
    this.addDocumentListener(targetDocument, "pointerdown", (e: Event) => {
      if (!dropdownMenu.classList.contains("is-menu-open")) return;

      const target = e.target as Node | null;
      if (!target) return;
      if (hamburgerBtn.contains(target)) return;
      if (dropdownMenu.contains(target)) return;
      if (this.activePortal?.contains(target)) return;

      this.closeMenu();
    });
  }

  public destroy(): void {
    this.closeMenu();
    this.closeActivePortal();
    this.documentListeners.forEach(({ target, type, listener }) => {
      target.removeEventListener(type, listener);
    });
    this.documentListeners = [];
  }

  public setSearchQuery(query: string): void {
    this.searchQuery = query;
    if (this.searchInput) {
      this.searchInput.value = query;
    }
  }

  private closeMenu(): void {
    this.dropdownMenu?.classList.remove("is-menu-open");
    this.hamburgerBtn?.classList.remove("is-menu-open");
  }

  private clampCardColumnsPerRow(value: number): number {
    if (!Number.isFinite(value)) {
      return 0;
    }
    return Math.max(0, Math.min(6, Math.round(value)));
  }

  private clampCardSpacing(value: number): number {
    if (!Number.isFinite(value)) {
      return 15;
    }
    return Math.max(0, Math.min(40, Math.round(value)));
  }

  private closeActivePortal(): void {
    if (this.activePortalCleanup) {
      this.activePortalCleanup();
      this.activePortalCleanup = null;
    }
    if (this.activePortal) {
      this.activePortal.remove();
      this.activePortal = null;
    }
    if (this.activePortalToggleBtn) {
      this.activePortalToggleBtn.removeClass("active");
      this.activePortalToggleBtn = null;
    }
  }

  private createControls(container: HTMLElement): void {
    const controls = container.createDiv({
      cls: "rss-dashboard-article-controls",
    });

    const searchContainer = controls.createDiv({
      cls: "rss-dashboard-article-search-container",
    });
    setIcon(
      searchContainer.createDiv({ cls: "rss-dashboard-article-search-icon" }),
      "search",
    );
    const searchInput = searchContainer.createEl("input", {
      cls: "rss-dashboard-article-search-input",
      attr: {
        type: "text",
        placeholder: this.t("dashboard.searchArticles"),
        "aria-label": this.t("dashboard.searchArticles"),
        autocomplete: "off",
        spellcheck: "false",
      },
    });
    searchInput.value = this.searchQuery;
    this.searchInput = searchInput;
    searchInput.addEventListener("input", (e) => {
      const val = (e.target as HTMLInputElement).value;
      this.searchQuery = val;
      this.callbacks.onSearch(val);
    });

    this.createThemedSelector(
      controls,
      "history",
      this.t("dashboard.age"),
      this.getAgeOptions(),
      () => this.getCurrentAgeFilterValue(),
      (val) =>
        this.callbacks.onFilterChange({
          type: Number(val) === 0 ? "none" : "age",
          value: Number(val),
        }),
      "rss-dashboard-filter",
    );

    this.createThemedSelector(
      controls,
      "arrow-up-down",
      this.t("dashboard.sort"),
      {
        [this.t("settings.display.newest")]: "newest",
        [this.t("settings.display.oldest")]: "oldest",
      },
      () => this.settings.articleSort,
      (val) => this.callbacks.onSortChange(val as "newest" | "oldest"),
      "rss-dashboard-sort",
    );

    this.createThemedSelector(
      controls,
      "folders",
      this.t("dashboard.grouping"),
      {
        [this.t("settings.display.none")]: "none",
        [this.t("settings.display.feed")]: "feed",
        [this.t("settings.display.date")]: "date",
        [this.t("settings.display.folder")]: "folder",
      },
      () => this.settings.articleGroupBy,
      (val) =>
        this.callbacks.onGroupChange(
          val as "none" | "feed" | "date" | "folder",
        ),
      "rss-dashboard-group",
    );

    const viewStyleRow = controls.createDiv({
      cls: "rss-dashboard-view-style-row",
    });
    this.createViewStyleSelector(viewStyleRow);
    this.createRefreshButton(viewStyleRow, "rss-dashboard-view-refresh-button");

    if (this.settings.viewStyle === "card") {
      this.createDropdownCardLayoutControls(controls);
    }

    const markAllRow = controls.createDiv({
      cls: "rss-dashboard-mark-all-row",
    });
    markAllRow.createSpan({
      text: this.t("dashboard.markAll"),
      cls: "rss-dashboard-mark-all-label",
    });
    const markAllBtns = markAllRow.createDiv({
      cls: "rss-dashboard-mark-all-buttons-row",
    });

    const readBtn = markAllBtns.createEl("button", {
      cls: "rss-dashboard-mark-all-button rss-dashboard-mark-read",
    });
    setIcon(readBtn.createDiv(), "check-circle");
    readBtn.createSpan({
      text: this.t("common.read"),
      cls: "rss-dashboard-mark-all-text",
    });
    readBtn.onclick = () => this.callbacks.onMarkAllAsRead();

    const unreadBtn = markAllBtns.createEl("button", {
      cls: "rss-dashboard-mark-all-button",
    });
    setIcon(unreadBtn.createDiv(), "circle");
    unreadBtn.createSpan({
      text: this.t("common.unread"),
      cls: "rss-dashboard-mark-all-text",
    });
    unreadBtn.onclick = () => this.callbacks.onMarkAllAsUnread();
  }

  private createDropdownCardLayoutControls(parent: HTMLElement): void {
    const cardLayoutControls = parent.createDiv({
      cls: "rss-dashboard-dropdown-card-layout-controls",
    });

    const cardsPerRowRow = cardLayoutControls.createDiv({
      cls: "rss-dashboard-dropdown-card-layout-row",
    });
    cardsPerRowRow.createSpan({
      cls: "rss-dashboard-dropdown-card-layout-label",
      text: this.t("dashboard.cardsPerRow"),
    });

    const cardsPerRowTrigger = cardsPerRowRow.createDiv({
      cls: "rss-dashboard-dropdown-card-layout-trigger rss-dashboard-themed-select-trigger rss-dashboard-dropdown-cards-per-row-trigger",
      attr: { role: "button", tabindex: "0" },
    });
    const getCardsPerRowLabel = () => {
      const currentValue = this.clampCardColumnsPerRow(
        this.settings.display.cardColumnsPerRow ?? 0,
      );
      return currentValue === 0
        ? this.t("dashboard.auto")
        : String(currentValue);
    };
    cardsPerRowTrigger.createSpan({ text: getCardsPerRowLabel() });
    setIcon(
      cardsPerRowTrigger.createDiv({ cls: "rss-dashboard-selector-arrow" }),
      "chevron-down",
    );
    cardsPerRowTrigger.onclick = (e) => {
      e.stopPropagation();
      if (cardsPerRowTrigger.hasClass("active")) {
        this.closeActivePortal();
        return;
      }
      this.showThemedMenu(
        cardsPerRowTrigger,
        [
          [this.t("dashboard.auto"), "0"],
          ["1", "1"],
          ["2", "2"],
          ["3", "3"],
          ["4", "4"],
          ["5", "5"],
          ["6", "6"],
        ],
        String(
          this.clampCardColumnsPerRow(
            this.settings.display.cardColumnsPerRow ?? 0,
          ),
        ),
        (val) => {
          this.callbacks.onFilterChange({
            type: "batch",
            value: null,
            batch: {
              cardColumnsPerRow: this.clampCardColumnsPerRow(Number(val)),
            },
          });
        },
      );
    };

    const cardSpacingGroup = cardLayoutControls.createDiv({
      cls: "rss-dashboard-dropdown-card-spacing-group",
    });
    const cardSpacingLabel = cardSpacingGroup.createDiv({
      cls: "rss-dashboard-dropdown-card-layout-label",
      text: this.t("dashboard.cardSpacing", {
        count: this.clampCardSpacing(this.settings.display.cardSpacing ?? 15),
      }),
    });
    const cardSpacingInput = cardSpacingGroup.createEl("input", {
      cls: "rss-dashboard-dropdown-card-spacing-input",
      attr: {
        type: "range",
        min: "0",
        max: "40",
        step: "1",
      },
    });
    cardSpacingInput.value = String(
      this.clampCardSpacing(this.settings.display.cardSpacing ?? 15),
    );
    cardSpacingInput.addEventListener("click", (e) => e.stopPropagation());
    cardSpacingInput.addEventListener("input", () => {
      const nextValue = this.clampCardSpacing(Number(cardSpacingInput.value));
      cardSpacingInput.value = String(nextValue);
      cardSpacingLabel.setText(
        this.t("dashboard.cardSpacing", { count: nextValue }),
      );
      this.callbacks.onFilterChange({
        type: "card-spacing-live",
        value: nextValue,
      });
    });
    cardSpacingInput.addEventListener("change", () => {
      const nextValue = this.clampCardSpacing(Number(cardSpacingInput.value));
      cardSpacingInput.value = String(nextValue);
      cardSpacingLabel.setText(
        this.t("dashboard.cardSpacing", { count: nextValue }),
      );
      this.callbacks.onFilterChange({
        type: "card-spacing-commit",
        value: nextValue,
      });
    });
  }

  private createThemedSelector(
    parent: HTMLElement,
    icon: string,
    label: string,
    options: Record<string, string>,
    getValue: () => string,
    onChange: (val: string) => void,
    triggerClass: string,
  ): void {
    const wrapper = parent.createDiv({
      cls: "rss-dashboard-select-with-icon rss-dashboard-select-with-label",
    });
    wrapper.createSpan({ cls: "rss-dashboard-select-label", text: label });

    const inner = wrapper.createDiv({ cls: "rss-dashboard-select-inner" });
    setIcon(inner.createDiv({ cls: "rss-dashboard-select-icon" }), icon);

    const trigger = inner.createDiv({
      cls: `rss-dashboard-themed-select-trigger ${triggerClass}`,
      attr: { role: "button", tabindex: "0" },
    });
    const currentVal = getValue();
    const currentLabel =
      Object.keys(options).find((key) => options[key] === currentVal) ??
      currentVal;
    trigger.createSpan({ text: currentLabel });
    setIcon(
      trigger.createDiv({ cls: "rss-dashboard-selector-arrow" }),
      "chevron-down",
    );

    trigger.onclick = (e) => {
      e.stopPropagation();
      if (trigger.hasClass("active")) {
        this.closeActivePortal();
        return;
      }
      this.showThemedMenu(trigger, options, getValue(), onChange);
    };
  }

  private showThemedMenu(
    trigger: HTMLElement,
    options: Record<string, string> | MenuOptionEntries,
    currentVal: string,
    onChange: (val: string) => void,
    icons?: Record<string, string>,
  ): void {
    this.closeActivePortal();
    const targetDocument = trigger.ownerDocument;
    const portal = targetDocument.body.createDiv({
      cls: "rss-dashboard-filter-menu rss-dashboard-themed-menu-portal",
    });
    this.activePortal = portal;
    this.activePortalToggleBtn = trigger;
    trigger.addClass("active");

    const entries: MenuOptionEntries = Array.isArray(options)
      ? options
      : Object.keys(options).map((label): [string, string] => [
          label,
          options[label],
        ]);

    entries.forEach(([label, value]) => {
      const item = portal.createDiv({ cls: "rss-dashboard-filter-menu-item" });
      const check = item.createDiv({ cls: "rss-dashboard-filter-menu-check" });
      if (value === currentVal) {
        setIcon(check, "check");
        item.addClass("is-active");
      }
      if (icons && icons[value]) {
        const iconDiv = item.createDiv({
          cls: "rss-dashboard-filter-menu-icon",
        });
        setIcon(iconDiv, icons[value]);
      }
      item.createDiv({ text: label, cls: "rss-dashboard-filter-menu-text" });
      item.onclick = () => {
        onChange(value);
        this.closeActivePortal();
        void this.callbacks.onPersistSettings();
      };
    });

    this.positionPortal(trigger, portal);
    const targetWindow = targetDocument.defaultView || activeWindow;
    targetWindow.setTimeout(() => {
      this.activePortalCleanup = this.addDocumentListener(
        targetDocument,
        "mousedown",
        (e: Event) => {
          if (
            !portal.contains(e.target as Node) &&
            !trigger.contains(e.target as Node)
          ) {
            this.closeActivePortal();
          }
        },
      );
    }, 0);
  }

  private createViewStyleSelector(parent: HTMLElement): void {
    const selector = parent.createDiv({
      cls: "rss-dashboard-view-style-selector",
      attr: { role: "button", tabindex: "0" },
    });
    const style = this.settings.viewStyle;
    const icons: Record<string, string> = {
      feed: "newspaper",
      card: "layout-grid",
      list: "list",
    };
    setIcon(
      selector.createDiv({ cls: "rss-dashboard-selector-icon" }),
      icons[style] || "list",
    );
    selector.createSpan({
      cls: "rss-dashboard-selector-text",
      text:
        style === "list"
          ? this.t("dashboard.listView")
          : style === "card"
            ? this.t("dashboard.cardView")
            : this.t("dashboard.feedView"),
    });
    setIcon(
      selector.createDiv({ cls: "rss-dashboard-selector-arrow" }),
      "chevron-down",
    );

    selector.onclick = (e) => {
      e.stopPropagation();
      if (selector.hasClass("active")) {
        this.closeActivePortal();
        return;
      }
      this.showThemedMenu(
        selector,
        {
          [this.t("dashboard.listView")]: "list",
          [this.t("dashboard.cardView")]: "card",
          [this.t("dashboard.feedView")]: "feed",
        },
        this.settings.viewStyle,
        (val) =>
          this.callbacks.onToggleViewStyle(val as "list" | "card" | "feed"),
        icons,
      );
    };
  }

  private positionPortal(trigger: HTMLElement, portal: HTMLElement): void {
    const rect = trigger.getBoundingClientRect();
    portal.style.top = `${rect.bottom + 5}px`;
    portal.style.left = `${rect.left}px`;
    const targetWindow = trigger.ownerDocument.defaultView || activeWindow;
    targetWindow.requestAnimationFrame(() => {
      const pRect = portal.getBoundingClientRect();
      const margin = 8;
      const maxLeft = targetWindow.innerWidth - pRect.width - margin;
      portal.style.left = `${Math.max(margin, Math.min(rect.left, maxLeft))}px`;
    });
  }

  private createRefreshButton(parent: HTMLElement, cls: string): void {
    const btn = parent.createEl("button", {
      cls: "rss-dashboard-refresh-button " + cls,
      attr: {
        title: this.t("dashboard.refreshAll"),
        "aria-label": this.t("dashboard.refreshAll"),
      },
    });
    setIcon(btn.createDiv({ cls: "rss-dashboard-refresh-icon" }), "refresh-cw");
    btn.onclick = () => this.callbacks.onRefreshFeeds();
  }

  private getAgeOptions(): Record<string, string> {
    return {
      [this.t("dashboard.timeAll")]: "0",
      [this.t("dashboard.timeHours", { count: 1 })]: "3600000",
      [this.t("dashboard.timeHours", { count: 2 })]: "7200000",
      [this.t("dashboard.timeHours", { count: 4 })]: "14400000",
      [this.t("dashboard.timeHours", { count: 8 })]: "28800000",
      [this.t("dashboard.timeHours", { count: 24 })]: "86400000",
      [this.t("dashboard.timeHours", { count: 48 })]: "172800000",
      [this.t("settings.general.days", { count: 3 })]: "259200000",
      [this.t("settings.general.weeks", { count: 1 })]: "604800000",
      [this.t("settings.general.weeks", { count: 2 })]: "1209600000",
      [this.t("settings.general.months", { count: 1 })]: "2592000000",
      [this.t("settings.general.months", { count: 6 })]: "15552000000",
      [this.t("settings.general.year")]: "31536000000",
    };
  }

  private getCurrentAgeFilterValue(): string {
    if (this.settings.articleFilter.type !== "age") {
      return "0";
    }

    const currentValue = this.settings.articleFilter.value;
    if (typeof currentValue !== "number" || currentValue <= 0) {
      return "0";
    }

    return String(currentValue);
  }

  private addDocumentListener(
    target: Document | Window,
    type: string,
    listener: EventListenerOrEventListenerObject,
  ): () => void {
    target.addEventListener(type, listener);
    const entry = { target, type, listener };
    this.documentListeners.push(entry);
    return () => {
      target.removeEventListener(type, listener);
      this.documentListeners = this.documentListeners.filter(
        (existingEntry) => existingEntry !== entry,
      );
    };
  }
}
