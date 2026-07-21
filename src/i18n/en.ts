/**
 * The English catalog is deliberately flat. It is both the fallback catalog and
 * the source of truth for the typed translation-key union.
 */
export const en = {
  "common.refresh": "Refresh",
  "common.save": "Save",
  "common.cancel": "Cancel",
  "common.delete": "Delete",
  "common.edit": "Edit",
  "common.close": "Close",
  "common.search": "Search",
  "common.loading": "Loading…",
  "common.retry": "Retry",
  "common.confirm": "Confirm",
  "common.settings": "Settings",
  "common.today": "Today",
  "common.yesterday": "Yesterday",
  "common.all": "All",
  "common.unread": "Unread",
  "common.read": "Read",
  "common.starred": "Starred",
  "common.saved": "Saved",
  "common.noItems": "No items",
  "common.error": "Something went wrong. Please try again.",

  "command.refreshAll": "Refresh all subscriptions",
  "command.refreshCurrent": "Refresh current subscription",
  "command.openDashboard": "Open RSS dashboard",

  "notice.refreshStarted": "Refreshing subscriptions…",
  "notice.refreshedCount": "Refreshed {count} items from {source}",
  "notice.refreshFailed": "Could not refresh {source}",
  "notice.noApiKey": "No valid API key is configured.",
  "notice.savedToVault": "Saved to your vault",

  "navigation.dashboard": "Dashboard",
  "navigation.todayCollection": "Today's collection",
  "navigation.subscriptions": "My subscriptions",
  "navigation.topicDiscovery": "Topic discovery",
  "navigation.starred": "Starred",
  "navigation.saved": "Saved",
  "navigation.settings": "Settings",

  "settings.language": "Language",
  "settings.languageChinese": "Simplified Chinese",
  "settings.languageEnglish": "English",
} as const;
