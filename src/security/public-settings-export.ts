import { normalizeAiConnection } from "../ai/connection-validation";
import type { AiConnection } from "../ai/ai-types";
import { normalizeConnectionId } from "./connection-id";
import {
  normalizeSourceConfig,
  type SourceConfig,
  type SourceKind,
} from "../sources/source-config";
import { normalizeTikHubBaseUrl } from "../sources/tikhub/tikhub-types";

const MAX_COLLECTION_ENTRIES = 5_000;
const MAX_FOLDER_DEPTH = 16;
const MAX_TEXT_LENGTH = 4_096;
const MAX_URL_LENGTH = 2_048;
const MAX_SAFE_NUMBER = 1_000_000_000;
export const MAX_PUBLIC_SETTINGS_JSON_CHARACTERS = 5_000_000;

const SOURCE_KINDS = new Set<SourceKind>(["feed", "x-account", "x-topic"]);
const REFRESH_MODES = new Set(["daily-on-open", "interval", "off"]);
const VIEW_STYLES = new Set(["list", "card", "feed"]);
const VIEW_LOCATIONS = new Set([
  "main",
  "right-sidebar",
  "left-sidebar",
  "inline",
  "external-browser",
]);
const STORAGE_MODES = new Set([
  "legacy-json",
  "vault-shards",
  "vault-shards-v2",
]);
const SECRET_QUERY_KEYS = new Set([
  "apikey",
  "key",
  "token",
  "accesstoken",
  "bearertoken",
  "authorization",
  "auth",
  "password",
  "passwd",
  "secret",
  "clientsecret",
  "credential",
  "credentials",
  "signature",
  "sig",
]);

export interface PublicSettingsExport extends Readonly<Record<string, unknown>> {
  readonly feeds?: readonly Readonly<Record<string, unknown>>[];
  readonly folders?: readonly Readonly<Record<string, unknown>>[];
  readonly availableTags?: readonly Readonly<Record<string, unknown>>[];
}

export class PublicSettingsExportError extends Error {
  constructor(readonly code: "invalid-settings" | "invalid-bundle") {
    super(code === "invalid-bundle" ? "Invalid public export bundle." : "Invalid public settings export.");
    this.name = "PublicSettingsExportError";
  }
}

export function buildPublicSettingsExport(
  input: unknown,
  options: { includeSources: boolean },
): PublicSettingsExport {
  try {
    const settings = objectRecord(input);
    const output = createRecord();

    copyEnum(settings, output, "locale", new Set(["zh-CN", "en"]));
    copyEnum(settings, output, "refreshMode", REFRESH_MODES);
    copyInteger(settings, output, "refreshInterval", 1, MAX_SAFE_NUMBER);
    copyInteger(settings, output, "startupRefreshDelaySeconds", 0, MAX_SAFE_NUMBER);
    copyInteger(settings, output, "maxItems", 1, MAX_SAFE_NUMBER);
    copyInteger(settings, output, "defaultAutoDeleteDuration", 0, MAX_SAFE_NUMBER);
    copyEnum(settings, output, "viewStyle", VIEW_STYLES);
    copyBoolean(settings, output, "showFeedArt");
    copyBoolean(settings, output, "showThumbnails");
    copyInteger(settings, output, "sidebarWidth", 100, 10_000);
    copyBoolean(settings, output, "tagsCollapsed");
    copyEnum(settings, output, "articleSort", new Set(["newest", "oldest"]));
    copyEnum(
      settings,
      output,
      "articleGroupBy",
      new Set(["none", "feed", "date", "folder"]),
    );
    for (const field of [
      "allArticlesPageSize",
      "unreadArticlesPageSize",
      "readArticlesPageSize",
      "savedArticlesPageSize",
      "starredArticlesPageSize",
    ]) {
      copyInteger(settings, output, field, 1, 10_000);
    }
    copyEnum(settings, output, "viewLocation", VIEW_LOCATIONS);
    copyEnum(settings, output, "readerViewLocation", VIEW_LOCATIONS);
    copyEnum(settings, output, "savedArticleOpenLocation", VIEW_LOCATIONS);
    copyBoolean(settings, output, "useWebViewer");
    copyBoolean(settings, output, "corsProxyEnabled");
    copyEnum(settings, output, "corsProxyUrl", new Set(["auto"]));
    copyEnum(settings, output, "sidebarTagFilterMode", new Set(["or", "and", "not"]));
    copyEnum(settings, output, "storageMode", STORAGE_MODES);
    copyInteger(settings, output, "storageSchemaVersion", 1, 1_000);
    copyEnum(
      settings,
      output,
      "metadataStorageMode",
      new Set(["plugin-default", "vault-location"]),
    );
    copyInteger(settings, output, "metadataStorageSchemaVersion", 1, 1_000);

    copyNested(settings, output, "collection", copyCollectionSettings);
    copyNested(settings, output, "tikhub", copyTikHubSettings);
    copyNested(settings, output, "ai", copyAiSettings);
    copyNested(settings, output, "readerFormat", copyReaderFormat);
    copyNested(settings, output, "display", copyDisplaySettings);
    copyNested(settings, output, "media", copyMediaSettings);
    copyNested(settings, output, "articleSaving", copyArticleSavingSettings);
    copyNested(settings, output, "autoBackup", copyAutoBackupSettings);
    copyNested(settings, output, "folderSortOrder", copySortOrder);
    copyNested(settings, output, "feedSortOrder", copySortOrder);

    if (options.includeSources) {
      output.feeds = copyFeeds(requiredData(settings, "feeds"));
      output.folders = copyFolders(requiredData(settings, "folders"), 0, new Set());
      output.availableTags = copyTags(requiredData(settings, "availableTags"));
    }

    return deepFreeze(output) as PublicSettingsExport;
  } catch (error) {
    if (error instanceof PublicSettingsExportError) throw error;
    throw new PublicSettingsExportError("invalid-settings");
  }
}

export function buildPublicPortableBundleExport(input: unknown): Readonly<Record<string, unknown>> {
  try {
    const bundle = objectRecord(input);
    const version = requiredData(bundle, "version");
    const exportedAt = requiredData(bundle, "exportedAt");
    const storageMode = requiredData(bundle, "storageMode");
    if (
      version !== 1 ||
      !safeInteger(exportedAt, 0, Number.MAX_SAFE_INTEGER) ||
      typeof storageMode !== "string" ||
      !STORAGE_MODES.has(storageMode)
    ) {
      throw new PublicSettingsExportError("invalid-bundle");
    }
    const metadata = buildPublicSettingsExport(requiredData(bundle, "metadata"), {
      includeSources: true,
    });
    return deepFreeze(
      Object.assign(createRecord(), {
        version: 1,
        exportedAt,
        storageMode,
        metadata,
        shards: [],
        markdownMirrorFallbackPlanned: false,
      }),
    );
  } catch (error) {
    if (error instanceof PublicSettingsExportError) throw error;
    throw new PublicSettingsExportError("invalid-bundle");
  }
}

/**
 * Revalidates an imported public snapshot and deliberately disconnects all
 * external-secret identifiers so a local key can never be mistaken for an
 * imported key.
 */
export function preparePublicSettingsImport(
  input: unknown,
  options: {
    includeSources: boolean;
    createConnectionId?: () => string;
  },
): PublicSettingsExport {
  const exported = buildPublicSettingsExport(input, {
    includeSources: options.includeSources,
  });
  const output = cloneDataTree(exported) as Record<string, unknown>;
  const tikhub = output.tikhub as Record<string, unknown> | undefined;
  if (tikhub) {
    tikhub.enabled = false;
    tikhub.connectionId = "";
  }
  const ai = output.ai as Record<string, unknown> | undefined;
  if (ai) {
    const connections = ai.connections as Array<Record<string, unknown>>;
    const oldDefault = ai.defaultConnectionId;
    let nextDefault: string | undefined;
    for (const connection of connections) {
      const previousId = connection.id;
      const nextId = normalizeConnectionId(
        options.createConnectionId?.() ?? activeWindow.crypto.randomUUID(),
      );
      if (!nextId) throw new PublicSettingsExportError("invalid-settings");
      connection.id = nextId;
      connection.enabled = false;
      if (previousId === oldDefault) nextDefault = nextId;
    }
    if (nextDefault) ai.defaultConnectionId = nextDefault;
    else delete ai.defaultConnectionId;
  }
  return deepFreeze(output) as PublicSettingsExport;
}

export function parsePublicSettingsImportJson(
  text: string,
  options: {
    includeSources: boolean;
    createConnectionId?: () => string;
  },
): PublicSettingsExport {
  if (
    typeof text !== "string" ||
    text.length === 0 ||
    text.length > MAX_PUBLIC_SETTINGS_JSON_CHARACTERS
  ) {
    throw new PublicSettingsExportError("invalid-settings");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new PublicSettingsExportError("invalid-settings");
  }
  return preparePublicSettingsImport(parsed, options);
}

function copyFeeds(value: unknown): Record<string, unknown>[] {
  const feeds = denseArray(value, MAX_COLLECTION_ENTRIES);
  return feeds.map((entry) => {
    const feed = objectRecord(entry);
    const output = createRecord();
    output.title = safeText(requiredData(feed, "title"));
    output.url = safeSourceUrl(requiredData(feed, "url"));
    output.folder = safeFolder(requiredData(feed, "folder"));
    copyOptionalUrl(feed, output, "siteUrl");
    copyEnum(feed, output, "sourceKind", SOURCE_KINDS);
    copyNested(feed, output, "sourceConfig", copySourceConfig);
    copyEnum(feed, output, "mediaType", new Set(["article", "video", "podcast"]));
    copyBoolean(feed, output, "autoDetect");
    copyFolderField(feed, output, "customFolder");
    copyStringArray(feed, output, "customTags", 256);
    copyInteger(feed, output, "autoDeleteDuration", 0, MAX_SAFE_NUMBER);
    copyInteger(feed, output, "maxItemsLimit", 1, MAX_SAFE_NUMBER);
    copyInteger(feed, output, "scanInterval", 1, MAX_SAFE_NUMBER);
    copyBoolean(feed, output, "excludeFromRefresh");
    copyNested(feed, output, "keywordRules", copyFeedKeywordRules);
    return output;
  });
}

function copySourceConfig(value: unknown): Record<string, unknown> {
  const source = objectRecord(value);
  const kind = requiredData(source, "kind");
  const snapshot = createRecord();
  if (kind === "feed") {
    snapshot.kind = "feed";
  } else if (kind === "x-account") {
    for (const key of ["kind", "id", "handle", "displayName", "includeReplies", "includeReposts", "folder", "topics"] as const) {
      copyOwnDataIfPresent(source, snapshot, key);
    }
  } else if (kind === "x-topic") {
    for (const key of ["kind", "id", "name", "includeKeywords", "excludeKeywords", "priorityAccounts", "windowDays", "folder"] as const) {
      copyOwnDataIfPresent(source, snapshot, key);
    }
  } else {
    throw new PublicSettingsExportError("invalid-settings");
  }
  const normalized = normalizeSourceConfig(snapshot);
  if (!normalized) throw new PublicSettingsExportError("invalid-settings");
  return copyJsonSafeSourceConfig(normalized);
}

function copyJsonSafeSourceConfig(source: SourceConfig): Record<string, unknown> {
  const output = createRecord();
  output.kind = source.kind;
  if (source.kind === "x-account") {
    output.id = safeText(source.id);
    output.handle = safeText(source.handle);
    if (source.displayName) output.displayName = safeText(source.displayName);
    output.includeReplies = source.includeReplies;
    output.includeReposts = source.includeReposts;
    output.folder = safeFolder(source.folder);
    output.topics = source.topics.map((entry) => safeText(entry));
  } else if (source.kind === "x-topic") {
    output.id = safeText(source.id);
    output.name = safeText(source.name);
    output.includeKeywords = source.includeKeywords.map((entry) => safeText(entry));
    output.excludeKeywords = source.excludeKeywords.map((entry) => safeText(entry));
    output.priorityAccounts = source.priorityAccounts.map((entry) => safeText(entry));
    output.windowDays = source.windowDays;
    output.folder = safeFolder(source.folder);
  }
  return output;
}

function copyFolders(value: unknown, depth: number, stack: Set<object>): Record<string, unknown>[] {
  if (depth > MAX_FOLDER_DEPTH) throw new PublicSettingsExportError("invalid-settings");
  return denseArray(value, MAX_COLLECTION_ENTRIES).map((entry) => {
    const folder = objectRecord(entry);
    if (stack.has(folder)) throw new PublicSettingsExportError("invalid-settings");
    stack.add(folder);
    try {
      const output = createRecord();
      output.name = safeText(requiredData(folder, "name"));
      output.subfolders = copyFolders(requiredData(folder, "subfolders"), depth + 1, stack);
      copyBoolean(folder, output, "pinned");
      copyNestedArray(folder, output, "autoTags", copyTag, 256);
      return output;
    } finally {
      stack.delete(folder);
    }
  });
}

function copyTags(value: unknown): Record<string, unknown>[] {
  return denseArray(value, MAX_COLLECTION_ENTRIES).map(copyTag);
}

function copyTag(value: unknown): Record<string, unknown> {
  const tag = objectRecord(value);
  const output = createRecord();
  output.name = safeText(requiredData(tag, "name"));
  const color = safeText(requiredData(tag, "color"), 64);
  if (!/^#[0-9a-f]{3,8}$/iu.test(color)) throw new PublicSettingsExportError("invalid-settings");
  output.color = color;
  return output;
}

function copyTikHubSettings(value: unknown): Record<string, unknown> {
  const settings = objectRecord(value);
  const output = createRecord();
  copyBoolean(settings, output, "enabled");
  if (hasOwnData(settings, "connectionId")) {
    const raw = requiredData(settings, "connectionId");
    if (raw === "") output.connectionId = "";
    else {
      const id = normalizeConnectionId(raw);
      if (!id) throw new PublicSettingsExportError("invalid-settings");
      output.connectionId = id;
    }
  }
  if (hasOwnData(settings, "baseUrl")) {
    const baseUrl = normalizeTikHubBaseUrl(requiredData(settings, "baseUrl"));
    if (!baseUrl) throw new PublicSettingsExportError("invalid-settings");
    output.baseUrl = baseUrl;
  }
  copyInteger(settings, output, "timeoutMs", 1, MAX_SAFE_NUMBER);
  copyInteger(settings, output, "maxRequestsPerRun", 1, MAX_SAFE_NUMBER);
  copyInteger(settings, output, "maxRequestsPerDay", 1, MAX_SAFE_NUMBER);
  return output;
}

function copyAiSettings(value: unknown): Record<string, unknown> {
  const settings = objectRecord(value);
  const entries = denseArray(requiredData(settings, "connections"), 1_000);
  const connections: AiConnection[] = entries.map((entry) => {
    const source = objectRecord(entry);
    const snapshot = createRecord();
    for (const key of ["id", "name", "providerKind", "protocol", "baseUrl", "model", "timeoutMs", "maxInputCharacters", "enabled"] as const) {
      copyOwnDataIfPresent(source, snapshot, key);
    }
    const normalized = normalizeAiConnection(snapshot);
    if (!normalized) throw new PublicSettingsExportError("invalid-settings");
    return normalized;
  });
  const output = createRecord();
  output.connections = connections.map((connection) => Object.assign(createRecord(), connection));
  if (hasOwnData(settings, "defaultConnectionId")) {
    const id = normalizeConnectionId(requiredData(settings, "defaultConnectionId"));
    if (!id || !connections.some((connection) => connection.id === id)) {
      throw new PublicSettingsExportError("invalid-settings");
    }
    output.defaultConnectionId = id;
  }
  return output;
}

function copyCollectionSettings(value: unknown): Record<string, unknown> {
  const input = objectRecord(value);
  const output = createRecord();
  copyBoolean(input, output, "enabled");
  return output;
}

function copyReaderFormat(value: unknown): Record<string, unknown> {
  const input = objectRecord(value);
  const output = createRecord();
  copyEnum(input, output, "textAlign", new Set(["justify", "left"]));
  copyInteger(input, output, "paragraphWidth", 1, 1_000);
  copyInteger(input, output, "fontScalePct", 1, 1_000);
  copyInteger(input, output, "lineHeightPct", 1, 1_000);
  copyEnum(input, output, "fontFamily", new Set(["default", "serif", "sans", "mono"]));
  copyEnum(input, output, "paragraphSpacing", new Set(["default", "tight", "normal", "loose"]));
  return output;
}

const DISPLAY_BOOLEAN_FIELDS = [
  "showCoverImage", "showSummary", "showFilterStatusBar", "showSidebarScrollbar",
  "showAllFeedsUnreadBadges", "showFolderUnreadBadges", "showFeedUnreadBadges",
  "mobileShowCardToolbar", "mobileShowListToolbar", "useDomainFavicons",
  "useDomainIconsPodcast", "useDomainIconsMastodon", "useDomainIconsTwitter",
  "useDomainIconsRss", "useDomainIconsYouTube", "hideDefaultRssIcon",
  "autoMarkReadOnOpen", "hideEmptyFeeds", "hideFeedFetchErrorBadges",
  "hideIconDashboard", "hideIconDiscover", "hideIconAddFeed", "hideIconManageFeeds",
  "hideIconSearch", "hideIconTags", "hideIconAddFolder", "hideIconSort",
  "hideIconCollapseAll", "hideIconSettings", "hideIconDivider", "hideToolbarEntirely",
] as const;

function copyDisplaySettings(value: unknown): Record<string, unknown> {
  const input = objectRecord(value);
  const output = createRecord();
  for (const field of DISPLAY_BOOLEAN_FIELDS) copyBoolean(input, output, field);
  for (const field of ["sidebarRowSpacing", "sidebarRowIndentation", "sidebarItemPaddingLeft", "sidebarItemPaddingRight", "cardColumnsPerRow", "cardSpacing"] as const) {
    copyInteger(input, output, field, 0, 10_000);
  }
  for (const field of ["allFeedsUnreadBadgeColor", "folderUnreadBadgeColor", "feedUnreadBadgeColor", "allFeedsUnreadBadgeDefaultColor", "folderUnreadBadgeDefaultColor", "feedUnreadBadgeDefaultColor"] as const) {
    copyColor(input, output, field);
  }
  copyEnum(input, output, "filterDisplayStyle", new Set(["vertical", "inline"]));
  copyEnum(input, output, "mobileListToolbarStyle", new Set(["left-grid", "bottom-row", "minimal"]));
  copyEnum(input, output, "defaultFilter", new Set(["all", "starred", "unread", "read", "saved", "videos", "podcasts"]));
  copyStringArray(input, output, "hiddenFilters", 64);
  copyStringArray(input, output, "iconOrder", 64);
  copyEnum(input, output, "articleDateStyle", new Set(["relative", "absolute"]));
  return output;
}

function copyMediaSettings(value: unknown): Record<string, unknown> {
  const input = objectRecord(value);
  const output = createRecord();
  for (const field of ["autoTagVideos", "rememberPlaybackProgress", "openInSplitView", "enableApplePodcastsOpen"] as const) {
    copyBoolean(input, output, field);
  }
  for (const field of ["defaultTwitterFolder", "defaultMastodonFolder", "defaultYouTubeFolder", "defaultPodcastFolder", "defaultRssFolder", "defaultSmallwebFolder"] as const) {
    copyFolderField(input, output, field);
  }
  for (const field of ["defaultVideoTag", "defaultYouTubeTag", "defaultRssTag", "defaultSmallwebTag", "defaultTwitterTag", "defaultMastodonTag"] as const) {
    copyTextField(input, output, field);
  }
  for (const field of ["defaultVideoTags", "defaultYouTubeTags", "defaultPodcastTags", "defaultRssTags", "defaultSmallwebTags", "defaultTwitterTags", "defaultMastodonTags"] as const) {
    copyStringArray(input, output, field, 256);
  }
  copyEnum(input, output, "podcastTheme", new Set(["obsidian", "minimal", "gradient", "spotify", "nord", "dracula", "solarized", "catppuccin", "gruvbox", "tokyonight"]));
  copyInteger(input, output, "defaultPlaySpeed", 1, 10);
  return output;
}

function copyArticleSavingSettings(value: unknown): Record<string, unknown> {
  const input = objectRecord(value);
  const output = createRecord();
  for (const field of ["addSavedTag", "includeFrontmatter", "saveFullContent"] as const) {
    copyBoolean(input, output, field);
  }
  copyInteger(input, output, "fetchTimeout", 1, MAX_SAFE_NUMBER);
  return output;
}

function copyAutoBackupSettings(value: unknown): Record<string, unknown> {
  const input = objectRecord(value);
  const output = createRecord();
  for (const field of ["backupDataJson", "backupOpml", "backupUserdata"] as const) {
    copyBoolean(input, output, field);
  }
  return output;
}

function copySortOrder(value: unknown): Record<string, unknown> {
  const input = objectRecord(value);
  const output = createRecord();
  copyTextField(input, output, "by");
  copyBoolean(input, output, "ascending");
  return output;
}

function copyFeedKeywordRules(value: unknown): Record<string, unknown> {
  const input = objectRecord(value);
  const output = createRecord();
  copyBoolean(input, output, "overrideGlobalRules");
  copyEnum(input, output, "includeLogic", new Set(["AND", "OR"]));
  const rules = denseArray(requiredData(input, "rules"), 1_000).map((entry) => {
    const rule = objectRecord(entry);
    const copy = createRecord();
    copy.id = safeText(requiredData(rule, "id"), 256);
    const type = requiredData(rule, "type");
    const matchMode = requiredData(rule, "matchMode");
    if (type !== "include" && type !== "exclude") {
      throw new PublicSettingsExportError("invalid-settings");
    }
    if (matchMode !== "exact" && matchMode !== "partial") {
      throw new PublicSettingsExportError("invalid-settings");
    }
    copy.type = type;
    copy.keyword = safeText(requiredData(rule, "keyword"));
    copy.matchMode = matchMode;
    for (const key of ["applyToTitle", "applyToSummary", "applyToContent", "applyToURL", "enabled"] as const) {
      copyBoolean(rule, copy, key);
    }
    copyInteger(rule, copy, "createdAt", 0, Number.MAX_SAFE_INTEGER);
    return copy;
  });
  output.rules = rules;
  return output;
}

function copyNested(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
  copier: (value: unknown) => Record<string, unknown>,
): void {
  const value = optionalData(source, key);
  if (value.present) target[key] = copier(value.value);
}

function copyNestedArray(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
  copier: (value: unknown) => Record<string, unknown>,
  max: number,
): void {
  const value = optionalData(source, key);
  if (value.present) target[key] = denseArray(value.value, max).map(copier);
}

function copyBoolean(source: Record<string, unknown>, target: Record<string, unknown>, key: string): void {
  const value = optionalData(source, key);
  if (!value.present) return;
  if (typeof value.value !== "boolean") throw new PublicSettingsExportError("invalid-settings");
  target[key] = value.value;
}

function copyInteger(source: Record<string, unknown>, target: Record<string, unknown>, key: string, min: number, max: number): void {
  const value = optionalData(source, key);
  if (!value.present) return;
  if (!safeInteger(value.value, min, max)) throw new PublicSettingsExportError("invalid-settings");
  target[key] = value.value;
}

function copyEnum(source: Record<string, unknown>, target: Record<string, unknown>, key: string, allowed: ReadonlySet<string>): void {
  const value = optionalData(source, key);
  if (!value.present) return;
  if (typeof value.value !== "string" || !allowed.has(value.value)) {
    throw new PublicSettingsExportError("invalid-settings");
  }
  target[key] = value.value;
}

function copyTextField(source: Record<string, unknown>, target: Record<string, unknown>, key: string): void {
  const value = optionalData(source, key);
  if (!value.present) return;
  if (value.value === "") {
    target[key] = "";
    return;
  }
  target[key] = safeText(value.value);
}

function copyFolderField(source: Record<string, unknown>, target: Record<string, unknown>, key: string): void {
  const value = optionalData(source, key);
  if (value.present) target[key] = safeFolder(value.value);
}

function copyColor(source: Record<string, unknown>, target: Record<string, unknown>, key: string): void {
  const value = optionalData(source, key);
  if (!value.present) return;
  const color = safeText(value.value, 64);
  if (!/^#[0-9a-f]{3,8}$/iu.test(color)) throw new PublicSettingsExportError("invalid-settings");
  target[key] = color;
}

function copyStringArray(source: Record<string, unknown>, target: Record<string, unknown>, key: string, max: number): void {
  const value = optionalData(source, key);
  if (value.present) target[key] = denseArray(value.value, max).map((entry) => safeText(entry));
}

function copyOptionalUrl(source: Record<string, unknown>, target: Record<string, unknown>, key: string): void {
  const value = optionalData(source, key);
  if (value.present) target[key] = safeHttpUrl(value.value);
}

function safeText(value: unknown, max = MAX_TEXT_LENGTH): string {
  if (typeof value !== "string" || value.length > max || hasControl(value)) {
    throw new PublicSettingsExportError("invalid-settings");
  }
  const normalized = value.normalize("NFC").trim();
  if (!normalized) throw new PublicSettingsExportError("invalid-settings");
  return normalized;
}

function safeFolder(value: unknown): string {
  if (value === "") return "";
  const folder = safeText(value, MAX_TEXT_LENGTH).replace(/\\/gu, "/");
  if (/^(?:\/|~|[A-Za-z]:|\.\.?\/)/u.test(folder) || folder.split("/").some((part) => part === "..")) {
    throw new PublicSettingsExportError("invalid-settings");
  }
  return folder;
}

function safeSourceUrl(value: unknown): string {
  if (typeof value === "string" && /^tikhub:\/\/(?:x-account|x-topic)\/[A-Za-z0-9_-]{1,128}$/u.test(value)) {
    return value;
  }
  return safeHttpUrl(value);
}

function safeHttpUrl(value: unknown): string {
  const candidate = safeText(value, MAX_URL_LENGTH);
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new PublicSettingsExportError("invalid-settings");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.hash) {
    throw new PublicSettingsExportError("invalid-settings");
  }
  for (const key of url.searchParams.keys()) {
    const normalizedKey = key
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^a-z0-9]/gu, "");
    if (SECRET_QUERY_KEYS.has(normalizedKey)) {
      throw new PublicSettingsExportError("invalid-settings");
    }
  }
  return url.toString();
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PublicSettingsExportError("invalid-settings");
  }
  return value as Record<string, unknown>;
}

function optionalData(record: Record<string, unknown>, key: string): { present: false } | { present: true; value: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor) return { present: false };
  if (!("value" in descriptor)) throw new PublicSettingsExportError("invalid-settings");
  return { present: true, value: descriptor.value };
}

function requiredData(record: Record<string, unknown>, key: string): unknown {
  const value = optionalData(record, key);
  if (!value.present) throw new PublicSettingsExportError("invalid-settings");
  return value.value;
}

function hasOwnData(record: Record<string, unknown>, key: string): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor) return false;
  if (!("value" in descriptor)) throw new PublicSettingsExportError("invalid-settings");
  return true;
}

function copyOwnDataIfPresent(source: Record<string, unknown>, target: Record<string, unknown>, key: string): void {
  const value = optionalData(source, key);
  if (value.present) target[key] = value.value;
}

function denseArray(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new PublicSettingsExportError("invalid-settings");
  }
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value as unknown;
  if (!safeInteger(length, 0, max)) throw new PublicSettingsExportError("invalid-settings");
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1 || !keys.includes("length")) {
    throw new PublicSettingsExportError("invalid-settings");
  }
  const output: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) throw new PublicSettingsExportError("invalid-settings");
    output.push(descriptor.value);
  }
  return output;
}

function safeInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function hasControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159))
    ) {
      return true;
    }
  }
  return false;
}

function createRecord(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function cloneDataTree(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneDataTree);
  if (typeof value !== "object" || value === null) return value;
  const output = createRecord();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new PublicSettingsExportError("invalid-settings");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) throw new PublicSettingsExportError("invalid-settings");
    output[key] = cloneDataTree(descriptor.value);
  }
  return output;
}
