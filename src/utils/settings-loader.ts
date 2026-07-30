import type {
  Feed,
  FeedItem,
  Folder,
  RssDashboardSettings,
} from "../types/types";
import { DEFAULT_SETTINGS } from "../types/types";
import {
  migrateDisplaySettings,
  migrateDefaultFilterToDashboardMultiFilters,
  migrateKeywordRulesSettings,
  migrateMediaVideoTagSettings,
  migrateMediaDefaultTagArrays,
} from "./settings-migration";
import { canonicalizeItemIdentityUrl } from "./url-utils";
import { normalizeRefreshIntervalMinutes } from "./validation";
import {
  inferXSourceKind,
  isSyntheticUrlForKind,
  normalizeSourceConfig,
  sourceConfigUrl,
} from "../sources/source-config";
import { normalizeTikHubBaseUrl } from "../sources/tikhub/tikhub-types";
import { normalizeAiSettings } from "../ai/connection-validation";
import {
  normalizeInitialImportPolicy,
  normalizeInitialImportProgress,
} from "../sources/initial-import-policy";

const DEFAULT_FEED_KEYWORD_RULES = {
  overrideGlobalRules: false,
  includeLogic: "AND" as const,
  rules: [],
};

const TOP_LEVEL_TIKHUB_SECRET_ALIAS_KEYS = new Set([
  "tikhubapikey",
  "tikhubtoken",
  "tikhubaccesstoken",
  "tikhubbearertoken",
]);

const TIKHUB_SCOPED_SECRET_ALIAS_KEYS = new Set([
  ...TOP_LEVEL_TIKHUB_SECRET_ALIAS_KEYS,
  "apikey",
  "token",
  "accesstoken",
  "bearertoken",
]);

const AI_SECRET_PREFIXES = [
  "ai",
  "openai",
  "anthropic",
  "claude",
  "kimi",
  "moonshot",
  "moonshotai",
  "deepseek",
  "qwen",
  "dashscope",
  "aliyun",
  "alibaba",
  "glm",
  "bigmodel",
  "zhipu",
  "zhipuai",
] as const;

const AI_SECRET_SUFFIXES = [
  "key",
  "apikey",
  "token",
  "accesstoken",
  "bearertoken",
] as const;

const TOP_LEVEL_AI_SECRET_ALIAS_KEYS = new Set(
  AI_SECRET_PREFIXES.flatMap((prefix) =>
    AI_SECRET_SUFFIXES.map((suffix) => `${prefix}${suffix}`),
  ),
);

const AI_SCOPED_SECRET_ALIAS_KEYS = new Set([
  "apikey",
  "key",
  "token",
  "accesstoken",
  "bearertoken",
  "secret",
  "clientsecret",
  ...TOP_LEVEL_AI_SECRET_ALIAS_KEYS,
]);

const PAGE_SIZE_FIELDS: Array<
  | "allArticlesPageSize"
  | "unreadArticlesPageSize"
  | "readArticlesPageSize"
  | "savedArticlesPageSize"
  | "starredArticlesPageSize"
> = [
  "allArticlesPageSize",
  "unreadArticlesPageSize",
  "readArticlesPageSize",
  "savedArticlesPageSize",
  "starredArticlesPageSize",
];

export const FACTORY_RESET_LOCAL_STORAGE_KEYS = [
  "rss-discover-filters",
  "rss-podcast-progress",
  "rss-first-launch-coachmark-shown",
] as const;

function cloneFoldersWithFreshTimestamps(
  folders: Folder[],
  timestamp: number,
): Folder[] {
  return folders.map((folder) => ({
    ...folder,
    subfolders: cloneFoldersWithFreshTimestamps(
      folder.subfolders ?? [],
      timestamp,
    ),
    createdAt: timestamp,
    modifiedAt: timestamp,
  }));
}

export function buildFactoryResetSettings(): RssDashboardSettings {
  const settings = JSON.parse(
    JSON.stringify(DEFAULT_SETTINGS),
  ) as RssDashboardSettings;
  const timestamp = Date.now();

  settings.folders = cloneFoldersWithFreshTimestamps(
    DEFAULT_SETTINGS.folders,
    timestamp,
  );

  return settings;
}

export function loadAndNormalizeSettings(
  rawData?: Partial<RssDashboardSettings> | null,
): RssDashboardSettings {
  const settings = copyOwnTopLevelSettings(rawData);
  removeTopLevelTikHubSecretAliases(
    settings as unknown as Record<string, unknown>,
  );
  removeTopLevelAiSecretAliases(settings as unknown as Record<string, unknown>);

  if (settings.locale !== "zh-CN" && settings.locale !== "en") {
    settings.locale = DEFAULT_SETTINGS.locale;
  }

  if (!rawData?.storageMode) {
    const hasFeeds = Array.isArray(rawData?.feeds) && rawData.feeds.length > 0;
    const hasRefreshHistory =
      typeof rawData?.lastRefreshTimestamp === "number" &&
      rawData.lastRefreshTimestamp > 0;
    if (hasFeeds || hasRefreshHistory) {
      settings.storageMode = "legacy-json";
    }
  }

  const normalizedRefreshInterval = Number(settings.refreshInterval);
  settings.refreshInterval = Number.isFinite(normalizedRefreshInterval)
    ? normalizeRefreshIntervalMinutes(normalizedRefreshInterval)
    : DEFAULT_SETTINGS.refreshInterval;

  if (
    typeof settings.startupRefreshDelaySeconds !== "number" ||
    settings.startupRefreshDelaySeconds < 0
  ) {
    settings.startupRefreshDelaySeconds =
      DEFAULT_SETTINGS.startupRefreshDelaySeconds;
  }

  if (typeof settings.defaultAutoDeleteDuration !== "number") {
    settings.defaultAutoDeleteDuration =
      DEFAULT_SETTINGS.defaultAutoDeleteDuration;
  }

  if (!settings.readerViewLocation) {
    settings.readerViewLocation = "right-sidebar";
  }

  // Remove external-browser from readerViewLocation (not supported for regular articles)
  if (settings.readerViewLocation === "external-browser") {
    settings.readerViewLocation = "main";
  }

  // Check if savedArticleOpenLocation was provided in raw data (not inherited from defaults)
  const savedArticleLocationProvided =
    rawData?.savedArticleOpenLocation !== undefined;
  if (!savedArticleLocationProvided) {
    // Inherit from readerViewLocation, but also convert external-browser to main
    settings.savedArticleOpenLocation = settings.readerViewLocation;
  }

  // Migrate: convert external-browser to main for saved articles (external browser no longer supported)
  if (
    savedArticleLocationProvided &&
    rawData?.savedArticleOpenLocation === "external-browser"
  ) {
    settings.savedArticleOpenLocation = "main";
  }

  if (settings.useWebViewer === undefined) {
    settings.useWebViewer = true;
  }

  settings.articleSaving = Object.assign(
    {},
    DEFAULT_SETTINGS.articleSaving,
    settings.articleSaving ?? {},
  );

  settings.collection = Object.assign(
    {},
    DEFAULT_SETTINGS.collection,
    settings.collection ?? {},
  );

  settings.tikhub = normalizeTikHubSettings(settings.tikhub);
  settings.ai = normalizeAiSettings(copyAiSettingsWithoutSecrets(settings.ai));

  settings.media = Object.assign(
    {},
    DEFAULT_SETTINGS.media,
    settings.media ?? {},
  );
  settings.availableTags = Array.isArray(settings.availableTags)
    ? settings.availableTags
    : [...DEFAULT_SETTINGS.availableTags];
  settings.display = Object.assign(
    {},
    DEFAULT_SETTINGS.display,
    settings.display ?? {},
  );
  settings.readerFormat = Object.assign(
    {},
    DEFAULT_SETTINGS.readerFormat,
    settings.readerFormat ?? {},
  );
  settings.keywordRules = Object.assign(
    {},
    DEFAULT_SETTINGS.keywordRules,
    settings.keywordRules ?? {},
  );
  settings.autoBackup = Object.assign(
    {},
    DEFAULT_SETTINGS.autoBackup,
    settings.autoBackup ?? {},
  );

  settings.feeds = Array.isArray(settings.feeds) ? settings.feeds : [];

  for (const [index, feed] of settings.feeds.entries()) {
    feed.items = Array.isArray(feed.items) ? feed.items : [];

    feed.keywordRules = Object.assign(
      {},
      DEFAULT_FEED_KEYWORD_RULES,
      feed.keywordRules ?? {},
    );

    if (typeof feed.autoDeleteDuration !== "number") {
      feed.autoDeleteDuration = settings.defaultAutoDeleteDuration;
    }

    if (typeof feed.maxItemsLimit !== "number") {
      feed.maxItemsLimit = settings.maxItems;
    }

    const normalizedConfig = normalizeSourceConfig(feed.sourceConfig);
    const declaredXKind =
      inferXSourceKind(feed.sourceKind) ??
      inferXSourceKind(feed.sourceConfig) ??
      inferXSourceKind(feed.url);
    if (declaredXKind && normalizedConfig?.kind === declaredXKind) {
      feed.sourceKind = declaredXKind;
      feed.sourceConfig = normalizedConfig;
      feed.url = sourceConfigUrl(normalizedConfig) ?? feed.url;
    } else if (declaredXKind) {
      feed.sourceKind = declaredXKind;
      delete feed.sourceConfig;
      feed.url = isSyntheticUrlForKind(feed.url, declaredXKind)
        ? feed.url
        : `tikhub://${declaredXKind}/unconfigured-${index + 1}`;
      feed.excludeFromRefresh = true;
      feed.lastFetchError = "Invalid X source configuration";
    } else {
      feed.sourceKind = "feed";
      feed.sourceConfig = { kind: "feed" };
    }
  }

  const seenXSourceKeys = new Set<string>();
  settings.feeds = settings.feeds.filter((feed) => {
    if (
      (feed.sourceKind !== "x-account" && feed.sourceKind !== "x-topic") ||
      !feed.sourceConfig ||
      feed.sourceConfig.kind !== feed.sourceKind
    ) {
      return true;
    }
    const key = sourceConfigUrl(feed.sourceConfig);
    if (!key || seenXSourceKeys.has(key)) {
      return false;
    }
    seenXSourceKeys.add(key);
    return true;
  });

  const canonicalPageSizeRaw = settings.allArticlesPageSize;
  const canonicalPageSize =
    Number.isFinite(canonicalPageSizeRaw) && canonicalPageSizeRaw >= 0
      ? canonicalPageSizeRaw
      : DEFAULT_SETTINGS.allArticlesPageSize;

  for (const field of PAGE_SIZE_FIELDS) {
    settings[field] = canonicalPageSize;
  }

  return settings;
}

function copyOwnTopLevelSettings(
  rawData: Partial<RssDashboardSettings> | null | undefined,
): RssDashboardSettings {
  const settings = { ...DEFAULT_SETTINGS } as unknown as Record<
    string,
    unknown
  >;
  if (!isRecord(rawData)) return settings as unknown as RssDashboardSettings;

  let keys: string[];
  try {
    keys = Object.getOwnPropertyNames(rawData);
  } catch {
    return settings as unknown as RssDashboardSettings;
  }
  for (const key of keys) {
    if (
      key === "__proto__" ||
      key === "prototype" ||
      key === "constructor" ||
      isTopLevelTikHubSecretAlias(key) ||
      isTopLevelAiSecretAlias(key)
    ) {
      continue;
    }
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(rawData, key);
    } catch {
      continue;
    }
    if (!descriptor || !("value" in descriptor)) continue;
    Object.defineProperty(settings, key, {
      configurable: true,
      enumerable: true,
      value: descriptor.value,
      writable: true,
    });
  }
  return settings as unknown as RssDashboardSettings;
}

function removeTopLevelAiSecretAliases(
  settings: Record<string, unknown>,
): void {
  for (const key of Object.getOwnPropertyNames(settings)) {
    if (isTopLevelAiSecretAlias(key)) delete settings[key];
  }
}

function copyAiSettingsWithoutSecrets(value: unknown): unknown {
  try {
    return copyAiSettingsWithoutSecretsUnsafe(value);
  } catch {
    return Object.create(null) as Record<string, unknown>;
  }
}

function copyAiSettingsWithoutSecretsUnsafe(value: unknown): unknown {
  const record = safeRecord(value);
  if (!record) return value;
  const sanitized = copyOwnRecordWithoutSecrets(record);
  const connections = ownDataDescriptorValue(sanitized, "connections");
  if (!Array.isArray(connections)) return sanitized;

  const safeConnections: unknown[] = [];
  if (Reflect.getPrototypeOf(connections) !== Array.prototype) return sanitized;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(
    connections,
    "length",
  );
  const length: unknown =
    lengthDescriptor && "value" in lengthDescriptor
      ? lengthDescriptor.value
      : undefined;
  if (
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > 1_000
  ) {
    return sanitized;
  }
  const connectionKeys = Reflect.ownKeys(connections);
  if (
    connectionKeys.length !== length + 1 ||
    !connectionKeys.includes("length")
  ) {
    return sanitized;
  }
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(
      connections,
      String(index),
    );
    if (!descriptor || !("value" in descriptor)) return sanitized;
    const connection = safeRecord(descriptor.value);
    safeConnections.push(
      connection ? copyOwnRecordWithoutSecrets(connection) : descriptor.value,
    );
  }
  Object.defineProperty(sanitized, "connections", {
    configurable: true,
    enumerable: true,
    value: safeConnections,
    writable: true,
  });
  return sanitized;
}

function copyOwnRecordWithoutSecrets(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized = Object.create(null) as Record<string, unknown>;
  try {
    for (const key of Reflect.ownKeys(record)) {
      if (typeof key === "string" && isAiScopedSecretAlias(key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (!descriptor || !("value" in descriptor)) continue;
      Object.defineProperty(sanitized, key, {
        configurable: true,
        enumerable: true,
        value: descriptor.value,
        writable: true,
      });
    }
  } catch {
    return Object.create(null) as Record<string, unknown>;
  }
  return sanitized;
}

function safeRecord(value: unknown): Record<string, unknown> | undefined {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    const prototype = Reflect.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function ownDataDescriptorValue(
  record: Record<string, unknown>,
  key: string,
): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function isTopLevelAiSecretAlias(key: string): boolean {
  return TOP_LEVEL_AI_SECRET_ALIAS_KEYS.has(normalizeSecretAliasKey(key));
}

function isAiScopedSecretAlias(key: string): boolean {
  return AI_SCOPED_SECRET_ALIAS_KEYS.has(normalizeSecretAliasKey(key));
}

function normalizeTikHubSettings(
  value: unknown,
): RssDashboardSettings["tikhub"] {
  const sanitized = copyOwnTikHubSettingsWithoutSecrets(value);
  if (!sanitized) return { ...DEFAULT_SETTINGS.tikhub };
  const baseUrl = normalizeTikHubBaseUrl(sanitized.baseUrl);
  if (!baseUrl) return { ...DEFAULT_SETTINGS.tikhub };

  const connectionId =
    typeof sanitized.connectionId === "string"
      ? sanitized.connectionId.trim()
      : "";
  if (connectionId && !UUID_PATTERN.test(connectionId)) {
    return { ...DEFAULT_SETTINGS.tikhub };
  }

  return {
    enabled: sanitized.enabled === true,
    youtubeTranscriptFallbackEnabled:
      sanitized.youtubeTranscriptFallbackEnabled === true,
    connectionId,
    baseUrl,
    timeoutMs: positiveIntegerOrDefault(
      sanitized.timeoutMs,
      DEFAULT_SETTINGS.tikhub.timeoutMs,
    ),
    maxRequestsPerRun: positiveIntegerOrDefault(
      sanitized.maxRequestsPerRun,
      DEFAULT_SETTINGS.tikhub.maxRequestsPerRun,
    ),
    maxRequestsPerDay: positiveIntegerOrDefault(
      sanitized.maxRequestsPerDay,
      DEFAULT_SETTINGS.tikhub.maxRequestsPerDay,
    ),
  };
}

function removeTopLevelTikHubSecretAliases(
  settings: Record<string, unknown>,
): void {
  for (const key of Object.getOwnPropertyNames(settings)) {
    if (isTopLevelTikHubSecretAlias(key)) delete settings[key];
  }
}

function copyOwnTikHubSettingsWithoutSecrets(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const sanitized = Object.create(null) as Record<string, unknown>;
  try {
    for (const key of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor &&
        "value" in descriptor &&
        !isTikHubScopedSecretAlias(key)
      ) {
        sanitized[key] = descriptor.value;
      }
    }
  } catch {
    return undefined;
  }
  return sanitized;
}

function isTopLevelTikHubSecretAlias(key: string): boolean {
  return TOP_LEVEL_TIKHUB_SECRET_ALIAS_KEYS.has(normalizeSecretAliasKey(key));
}

function isTikHubScopedSecretAlias(key: string): boolean {
  return TIKHUB_SCOPED_SECRET_ALIAS_KEYS.has(normalizeSecretAliasKey(key));
}

function normalizeSecretAliasKey(key: string): string {
  return key
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, "");
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function positiveIntegerOrDefault(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  try {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

export function migrateSettings(settings: RssDashboardSettings): boolean {
  let didChange = false;
  const settingsUnknown = settings as unknown as Record<string, unknown>;

  if (migrateKeywordRulesSettings(settingsUnknown)) {
    didChange = true;
  }

  if (migrateMediaVideoTagSettings(settingsUnknown)) {
    didChange = true;
  }

  if (migrateMediaDefaultTagArrays(settingsUnknown)) {
    didChange = true;
  }

  if (settingsUnknown.savePath !== undefined) {
    settings.articleSaving = Object.assign(
      {},
      DEFAULT_SETTINGS.articleSaving,
      settings.articleSaving ?? {},
    );
    settings.articleSaving.defaultFolder =
      typeof settingsUnknown.savePath === "string"
        ? settingsUnknown.savePath
        : DEFAULT_SETTINGS.articleSaving.defaultFolder;
    delete settingsUnknown.savePath;
    didChange = true;
  }

  if (settingsUnknown.template !== undefined) {
    settings.articleSaving = Object.assign(
      {},
      DEFAULT_SETTINGS.articleSaving,
      settings.articleSaving ?? {},
    );
    settings.articleSaving.defaultTemplate =
      typeof settingsUnknown.template === "string"
        ? settingsUnknown.template
        : DEFAULT_SETTINGS.articleSaving.defaultTemplate;
    delete settingsUnknown.template;
    didChange = true;
  }

  if (settingsUnknown.addSavedTag !== undefined) {
    settings.articleSaving = Object.assign(
      {},
      DEFAULT_SETTINGS.articleSaving,
      settings.articleSaving ?? {},
    );
    settings.articleSaving.addSavedTag = Boolean(settingsUnknown.addSavedTag);
    delete settingsUnknown.addSavedTag;
    didChange = true;
  }

  const articleSavingUnknown = settings.articleSaving as unknown as Record<
    string,
    unknown
  >;
  if (
    articleSavingUnknown.template !== undefined &&
    !settings.articleSaving.defaultTemplate
  ) {
    settings.articleSaving.defaultTemplate =
      typeof articleSavingUnknown.template === "string"
        ? articleSavingUnknown.template
        : DEFAULT_SETTINGS.articleSaving.defaultTemplate;
    delete articleSavingUnknown.template;
    didChange = true;
  }

  settings.display = Object.assign(
    {},
    DEFAULT_SETTINGS.display,
    settings.display ?? {},
  );
  const displayUnknown = settings.display as unknown as Record<string, unknown>;
  if (displayUnknown && displayUnknown.useDomainFavicons !== undefined) {
    (settings.display as unknown as Record<string, unknown>).useDomainIconsRss =
      Boolean(displayUnknown.useDomainFavicons);
    delete displayUnknown.useDomainFavicons;
    didChange = true;
  }
  migrateDisplaySettings(
    settings.display as unknown as Record<string, unknown>,
  );

  settings.keywordRules = Object.assign(
    {},
    DEFAULT_SETTINGS.keywordRules,
    settings.keywordRules ?? {},
  );

  settings.dashboardMultiFilters = settings.dashboardMultiFilters
    ? {
        statusFilters: Array.isArray(
          settings.dashboardMultiFilters.statusFilters,
        )
          ? settings.dashboardMultiFilters.statusFilters.filter(
              (value): value is string => typeof value === "string",
            )
          : [],
        tagFilters: Array.isArray(settings.dashboardMultiFilters.tagFilters)
          ? settings.dashboardMultiFilters.tagFilters.filter(
              (value): value is string => typeof value === "string",
            )
          : [],
        logic:
          settings.dashboardMultiFilters.logic === "AND" ||
          settings.dashboardMultiFilters.logic === "OR"
            ? settings.dashboardMultiFilters.logic
            : "OR",
      }
    : { ...DEFAULT_SETTINGS.dashboardMultiFilters };

  migrateDefaultFilterToDashboardMultiFilters(
    settings.display as unknown as Record<string, unknown>,
    settings.dashboardMultiFilters as unknown as Record<string, unknown>,
  );

  settings.feeds = Array.isArray(settings.feeds) ? settings.feeds : [];
  settings.feeds.forEach((feed) => {
    feed.keywordRules = Object.assign(
      {},
      DEFAULT_FEED_KEYWORD_RULES,
      feed.keywordRules ?? {},
    );
    if (normalizeExistingInitialImportFields(feed)) didChange = true;
  });

  settings.autoBackup = Object.assign(
    {},
    DEFAULT_SETTINGS.autoBackup,
    settings.autoBackup ?? {},
  );

  return didChange;
}

function normalizeExistingInitialImportFields(feed: Feed): boolean {
  const record = feed as unknown as Record<string, unknown>;
  let didChange = false;

  const policy = ownDataProperty(record, "initialImportPolicy");
  if (policy.present) {
    const normalized = normalizeInitialImportPolicy(policy.value);
    if (!normalized) {
      delete record.initialImportPolicy;
      didChange = true;
    } else if (!sameInitialImportPolicy(policy.value, normalized)) {
      record.initialImportPolicy = normalized;
      didChange = true;
    }
  } else if (policy.accessor) {
    delete record.initialImportPolicy;
    didChange = true;
  }

  const progress = ownDataProperty(record, "initialImportProgress");
  if (progress.present) {
    const normalized = normalizeInitialImportProgress(progress.value);
    if (!normalized) {
      delete record.initialImportProgress;
      didChange = true;
    } else if (!sameInitialImportProgress(progress.value, normalized)) {
      record.initialImportProgress = normalized;
      didChange = true;
    }
  } else if (progress.accessor) {
    delete record.initialImportProgress;
    didChange = true;
  }

  const subscriptionStatus = ownDataProperty(record, "subscriptionStatus");
  if (subscriptionStatus.present) {
    if (
      subscriptionStatus.value !== "active" &&
      subscriptionStatus.value !== "paused"
    ) {
      delete record.subscriptionStatus;
      didChange = true;
    }
  } else if (subscriptionStatus.accessor) {
    delete record.subscriptionStatus;
    didChange = true;
  }

  return didChange;
}

function ownDataProperty(
  record: Record<string, unknown>,
  key: string,
):
  | { present: true; value: unknown; accessor: false }
  | { present: false; accessor: boolean } {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor) return { present: false, accessor: false };
    if (!("value" in descriptor)) return { present: false, accessor: true };
    return { present: true, value: descriptor.value, accessor: false };
  } catch {
    return { present: false, accessor: false };
  }
}

function sameInitialImportPolicy(
  value: unknown,
  normalized: Feed["initialImportPolicy"],
): boolean {
  if (!normalized || !isRecord(value)) return false;
  const keys = Object.keys(value);
  if (normalized.mode === "lookback-days") {
    return keys.length === 2 && value.mode === normalized.mode && value.days === normalized.days;
  }
  if (normalized.mode === "since-date") {
    return keys.length === 2 && value.mode === normalized.mode && value.since === normalized.since;
  }
  return keys.length === 1 && value.mode === normalized.mode;
}

function sameInitialImportProgress(
  value: unknown,
  normalized: Feed["initialImportProgress"],
): boolean {
  if (!normalized || !isRecord(value)) return false;
  const keys = Object.keys(value);
  const expectedKeys = Object.keys(normalized);
  return (
    keys.length === expectedKeys.length &&
    expectedKeys.every((key) => value[key] === normalized[key as keyof typeof normalized])
  );
}

export function dedupeAndNormalizeFeedItems(feeds: Feed[]): boolean {
  let didChange = false;

  const getPubDateMs = (pubDate: string | undefined | null): number => {
    if (!pubDate) return 0;
    const ms = Date.parse(pubDate);
    return Number.isFinite(ms) ? ms : 0;
  };

  const byNewest = (a: FeedItem, b: FeedItem): number => {
    const aMs = getPubDateMs(a.pubDate);
    const bMs = getPubDateMs(b.pubDate);
    if (aMs !== bMs) return bMs - aMs;
    return (a.guid || "").localeCompare(b.guid || "");
  };

  const pickLonger = (a: string, b: string): string => {
    const aTrim = (a ?? "").trim();
    const bTrim = (b ?? "").trim();
    if (!aTrim) return bTrim ? b : a;
    if (!bTrim) return a;
    return bTrim.length > aTrim.length ? b : a;
  };

  const pickLongerOptional = (a?: string, b?: string): string | undefined => {
    const aTrim = (a ?? "").trim();
    const bTrim = (b ?? "").trim();
    if (!aTrim && !bTrim) return a ?? b;
    if (!aTrim) return b;
    if (!bTrim) return a;
    return bTrim.length > aTrim.length ? b : a;
  };

  const mergeTags = (
    a: FeedItem["tags"],
    b: FeedItem["tags"],
  ): FeedItem["tags"] => {
    const out: FeedItem["tags"] = [];
    const seen = new Set<string>();
    for (const tag of [...(a || []), ...(b || [])]) {
      const key = (tag?.name || "").trim().toLowerCase();
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push(tag);
    }
    return out;
  };

  for (const feed of feeds || []) {
    const items = Array.isArray(feed.items) ? feed.items : [];
    if (items.length === 0) {
      continue;
    }

    const mergedByKey = new Map<string, FeedItem>();

    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx];
      const canonicalKey = canonicalizeItemIdentityUrl(
        item.guid || item.link || "",
      );
      const key = canonicalKey || item.guid || item.link || `__item_${idx}`;

      const existing = mergedByKey.get(key);
      if (!existing) {
        if (canonicalKey && canonicalKey !== item.guid) {
          didChange = true;
        }
        mergedByKey.set(key, {
          ...item,
          guid: canonicalKey || item.guid,
        });
        continue;
      }

      didChange = true;
      mergedByKey.set(key, {
        ...existing,
        guid: canonicalKey || existing.guid,
        read: existing.read || item.read,
        starred: existing.starred || item.starred,
        saved: !!existing.saved || !!item.saved,
        tags: mergeTags(existing.tags, item.tags),
        savedFilePath: existing.savedFilePath || item.savedFilePath,
        title: pickLonger(existing.title, item.title),
        link: existing.link || item.link,
        description: pickLonger(existing.description, item.description),
        content: pickLongerOptional(existing.content, item.content),
        summary: pickLongerOptional(existing.summary, item.summary),
        coverImage: existing.coverImage || item.coverImage,
        image: existing.image || item.image,
      });
    }

    const deduped = Array.from(mergedByKey.values());
    if (deduped.length !== items.length) {
      didChange = true;
    }

    deduped.sort(byNewest);
    feed.items = deduped;
  }

  return didChange;
}
