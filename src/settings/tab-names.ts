/**
 * Stable settings-tab identities. Labels are intentionally resolved only by
 * the renderer, so changing the interface language never changes control flow.
 */
import type { TranslationKey, Translator } from "../i18n";

export type SettingsTabId =
  | "general"
  | "sources"
  | "topic-discovery"
  | "tikhub"
  | "ai"
  | "storage"
  | "display"
  | "sidebar"
  | "media"
  | "article-saving"
  | "rules"
  | "highlights"
  | "import-export"
  | "tags"
  | "about";

/** Tabs that exist in this version of the settings UI, in display order. */
export const SETTINGS_TAB_IDS = [
  "general",
  "storage",
  "display",
  "sidebar",
  "media",
  "article-saving",
  "rules",
  "highlights",
  "import-export",
  "tags",
  "about",
] as const satisfies readonly SettingsTabId[];

/** @deprecated Use SETTINGS_TAB_IDS. Kept for third-party settings integrations. */
export const SETTINGS_TAB_NAMES = SETTINGS_TAB_IDS;
/** @deprecated Use SettingsTabId. */
export type SettingsTabName = SettingsTabId;

const TAB_LABEL_KEYS: Record<SettingsTabId, TranslationKey> = {
  general: "settings.tab.general",
  sources: "navigation.subscriptions",
  "topic-discovery": "navigation.topicDiscovery",
  tikhub: "settings.tab.tikhub",
  ai: "settings.tab.ai",
  storage: "settings.tab.storage",
  display: "settings.tab.display",
  sidebar: "settings.tab.sidebar",
  media: "settings.tab.media",
  "article-saving": "settings.tab.article-saving",
  rules: "settings.tab.rules",
  highlights: "settings.tab.highlights",
  "import-export": "settings.tab.import-export",
  tags: "settings.tab.tags",
  about: "settings.tab.about",
};

export function getSettingsTabLabel(tab: SettingsTabId, t: Translator): string {
  return t(TAB_LABEL_KEYS[tab]);
}

const LEGACY_TAB_NAMES: Readonly<Record<string, SettingsTabId>> = Object.freeze({
  General: "general",
  Storage: "storage",
  Display: "display",
  Sidebar: "sidebar",
  Media: "media",
  "Article saving": "article-saving",
  Rules: "rules",
  Highlights: "highlights",
  "Import/Export": "import-export",
  Tags: "tags",
  About: "about",
});

/** Accepts stable IDs and pre-localization names at the public navigation seam. */
export function normalizeSettingsTabId(name: string): SettingsTabId | null {
  if (isValidSettingsTab(name)) {
    return name;
  }

  return Object.prototype.hasOwnProperty.call(LEGACY_TAB_NAMES, name)
    ? LEGACY_TAB_NAMES[name] ?? null
    : null;
}

/** Returns true only for tabs rendered by the current settings UI. */
export function isValidSettingsTab(name: string): name is SettingsTabId {
  return (SETTINGS_TAB_IDS as readonly string[]).includes(name);
}

/** Returns the default tab shown when the settings panel is first opened. */
export function getInitialTab(): SettingsTabId {
  return SETTINGS_TAB_IDS[0];
}
