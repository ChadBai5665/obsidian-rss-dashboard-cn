import { setIcon } from "obsidian";
import type { SidebarIconConfig } from "../types/types";
import type { Translator } from "../i18n";

export const SIDEBAR_ICONS: SidebarIconConfig[] = [
  {
    id: "discover",
    label: "Discover",
    labelKey: "settings.sidebar.icon.discover",
    lucideIcon: "compass",
    settingKey: "hideIconDiscover",
    neverCollapses: true,
    isNav: true,
  },
  {
    id: "divider",
    label: "Divider",
    labelKey: "settings.sidebar.icon.divider",
    lucideIcon: "minus-vertical",
    settingKey: "hideIconDivider",
    isDivider: true,
  },
  {
    id: "addFeed",
    label: "Add Feed",
    labelKey: "settings.sidebar.icon.addFeed",
    lucideIcon: "plus-circle",
    settingKey: "hideIconAddFeed",
  },
  {
    id: "manageFeeds",
    label: "Manage Feeds",
    labelKey: "settings.sidebar.icon.manageFeeds",
    lucideIcon: "pencil",
    settingKey: "hideIconManageFeeds",
  },
  {
    id: "search",
    label: "Search",
    labelKey: "settings.sidebar.icon.search",
    lucideIcon: "search",
    settingKey: "hideIconSearch",
  },
  {
    id: "tags",
    label: "Tags",
    labelKey: "settings.sidebar.icon.tags",
    lucideIcon: "tags",
    settingKey: "hideIconTags",
  },
  {
    id: "addFolder",
    label: "Add Folder",
    labelKey: "settings.sidebar.icon.addFolder",
    lucideIcon: "folder-plus",
    settingKey: "hideIconAddFolder",
  },
  {
    id: "sort",
    label: "Sort",
    labelKey: "settings.sidebar.icon.sort",
    lucideIcon: "arrow-up-down",
    settingKey: "hideIconSort",
  },
  {
    id: "collapseAll",
    label: "Collapse All",
    labelKey: "settings.sidebar.icon.collapseAll",
    lucideIcon: "chevrons-up-down",
    settingKey: "hideIconCollapseAll",
  },
  {
    id: "settings",
    label: "Settings",
    labelKey: "settings.sidebar.icon.settings",
    lucideIcon: "settings",
    settingKey: "hideIconSettings",
  },
];

export const SIDEBAR_ICON_IDS: string[] = SIDEBAR_ICONS.map((icon) => icon.id);

const _iconById = new Map<string, SidebarIconConfig>(
  SIDEBAR_ICONS.map((icon) => [icon.id, icon]),
);

export function getIconById(id: string): SidebarIconConfig | undefined {
  return _iconById.get(id);
}

export function getSidebarIconLabel(icon: SidebarIconConfig, t?: Translator): string {
  return t ? t(icon.labelKey as Parameters<Translator>[0]) : icon.label;
}

/**
 * Creates a toolbar button element following the Obsidian clickable-icon pattern.
 * Attaches click and keyboard (Enter/Space) handlers.
 */
export function createToolbarButton(
  icon: SidebarIconConfig,
  onClick: () => void,
  t?: Translator,
): HTMLElement {
  const btn = activeDocument.createElement("div");
  btn.className = "clickable-icon";
  btn.setAttribute("role", "button");
  btn.setAttribute("tabindex", "0");
  btn.setAttribute("aria-label", getSidebarIconLabel(icon, t));

  setIcon(btn, icon.lucideIcon);

  btn.addEventListener("click", onClick);
  btn.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick();
    }
  });

  return btn;
}
