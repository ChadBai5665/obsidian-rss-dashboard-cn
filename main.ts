import {
  App,
  Plugin,
  Notice,
  WorkspaceLeaf,
  Platform,
  requireApiVersion,
  TFolder,
  type EventRef,
  type ObsidianProtocolData,
} from "obsidian";

import { getSettingManager } from "./src/utils/settings-manager";
import { normalizeSettingsTabId } from "./src/settings/tab-names";

import {
  RssDashboardSettings,
  DEFAULT_SETTINGS,
  Feed,
  FeedItem,
  FeedMetadata,
  FeedRefreshState,
  FeedKeywordRulesSettings,
  FeedIngestionCandidate,
  FeedIngestionOptions,
} from "./src/types/types";
import { RssDashboardSettingTab } from "./src/settings/settings-tab";
import {
  RssDashboardView,
  RSS_DASHBOARD_VIEW_TYPE,
} from "./src/views/dashboard-view";
import {
  DiscoverView,
  RSS_DISCOVER_VIEW_TYPE,
} from "./src/views/discover-view";
import {
  KagiSmallwebView,
  RSS_SMALLWEB_VIEW_TYPE,
} from "./src/views/kagi-smallweb-view";
import { ReaderView, RSS_READER_VIEW_TYPE } from "./src/views/reader-view";
import {
  FeedParser,
  applyFeedRetentionLimits,
} from "./src/services/feed-parser";
import { ArticleSaver } from "./src/services/article-saver";
import { BackupService } from "./src/services/backup-service";
import { FolderService } from "./src/services/folder-service";
import {
  FeedStorageRepository,
  type FeedLocalStorageAddress,
  type PersistSettingsOptions,
  type FeedStorageStatus,
  ShardFolderDeletionError,
} from "./src/services/feed-storage-repository";
import { ImportExportService } from "./src/services/import-export-service";
import { BackgroundImportService } from "./src/services/background-import-service";
import {
  FEED_REQUEST_TIMEOUT_MS,
  FEED_SOFT_TIMEOUT_MS,
  MAX_CONCURRENT_FETCHES,
} from "./src/services/feed-timeout";
import { globalFetchSemaphore } from "./src/services/feed-parser/fetch-semaphore";
import { OpmlManager } from "./src/services/opml-manager";
import { MediaService } from "./src/services/media-service";

import { ImportOpmlModal } from "./src/modals/import-opml-modal";
import { AddFeedModal } from "./src/modals/feed-manager/add-feed-modal";
import { StorageMigrationModal } from "./src/modals/storage-migration-modal";
import {
  normalizeRefreshIntervalMinutes,
  isValidUrl,
} from "./src/utils/validation";
import {
  dedupeAndNormalizeFeedItems,
  loadAndNormalizeSettings,
  migrateSettings,
} from "./src/utils/settings-loader";
import { applyAutomaticArticleTags } from "./src/utils/tag-utils";
import { SourceRefreshLedger } from "./src/refresh/source-refresh-ledger";
import { CollectionRepository } from "./src/collection/collection-repository";
import { DailyIndexService } from "./src/collection/daily-index-service";
import { CollectionService } from "./src/services/collection-service";
import { isTimeoutFeedError } from "./src/services/feed-parser/feed-errors";
import {
  bindFeedItemsToSourceIdentity,
  createSourceLocator,
  isStableItemId,
  resolveFeedItemStableId,
} from "./src/collection/item-identity";
import type { CollectedItem } from "./src/collection/collected-item";
import { createTranslator, type Translator } from "./src/i18n";
import { isLocalizedView } from "./src/views/localized-view";

export interface FeedRefreshResult {
  feed: Feed;
  previousItems: FeedItem[];
  refreshedItems: FeedItem[];
  fetchedAt: Date;
}

export interface FiltersUpdatedEventPayload {
  source: string;
  feedUrl?: string;
  timestamp: number;
}

function storageLog(_message: string, _details?: unknown): void {}

function storageError(
  _message: string,
  _error: unknown,
  _details?: unknown,
): void {}

type DesktopRequire = (moduleName: string) => unknown;
type DesktopShell = { openPath: (path: string) => Promise<string> };
type PathModuleLike = { join: (...paths: string[]) => string };
type VaultAdapterPathAccess = {
  getBasePath?: () => string;
  getFullPath?: (path: string) => string;
};
type LegacyLocalStorageApi = {
  loadLocalStorage?: (key: string) => unknown;
  removeLocalStorage?: (key: string) => void;
};
type LegacyPlaybackProgressEntry = {
  position: number;
  duration: number;
};

type FeedRefreshFailureCode =
  | "refresh-failed"
  | "timed-out"
  | "collection-failed"
  | "state-failed";

type CollectionFlagState = Pick<
  CollectedItem,
  "read" | "starred" | "saved" | "savedNotePath"
>;

function collectionFlagsFromItem(item: CollectedItem): CollectionFlagState {
  return {
    read: item.read,
    starred: item.starred,
    saved: item.saved,
    savedNotePath: item.savedNotePath,
  };
}

type ArticleMutationSnapshot = Map<keyof FeedItem, {
  exists: boolean;
  value: FeedItem[keyof FeedItem];
}>;

type ArticleUpdateOutcome = "failed" | "feed-only" | "collection";

const STATUS_REPAIR_JOURNAL_PATH =
  ".rss-dashboard-data/state/status-repair.json";

type StatusJournalPhase =
  | "prepared"
  | "collection-written"
  | "feed-write-uncertain"
  | "feed-written";

type StatusJournalItem = {
  // Locators deliberately use storage positions/IDs only; they never contain
  // source URLs, article content, titles, or API material.
  feedIndex: number;
  itemIndex: number;
  sourceLocator: string;
  stableId: string;
  previousFeed: Array<{
    key: string;
    exists: boolean;
    value?: unknown;
    valueType?: "undefined";
  }>;
  previousCollection?: CollectionFlagState;
  desired?: CollectionFlagState;
};

type StatusRepairJournal = {
  version: 1;
  txId: string;
  phase: StatusJournalPhase;
  items: StatusJournalItem[];
};

type MetadataPersistenceSnapshot = Array<{
  path: string;
  contents: string | null;
}>;

const STATUS_JOURNAL_PHASES = new Set<StatusJournalPhase>([
  "prepared",
  "collection-written",
  "feed-write-uncertain",
  "feed-written",
]);
const STATUS_JOURNAL_FEED_KEYS = new Set([
  "read",
  "starred",
  "saved",
  "savedFilePath",
  "tags",
  "playbackProgress",
  "restrictedReason",
]);

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function stableJsonStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJsonStringify(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort().map((key) =>
      `${JSON.stringify(key)}:${stableJsonStringify(value[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function getStatusJournalImmutablePayload(journal: StatusRepairJournal): string {
  return stableJsonStringify({ version: journal.version, items: journal.items });
}

function isJournalFlagState(value: unknown): value is CollectionFlagState {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, new Set(["read", "starred", "saved", "savedNotePath"]))) {
    return false;
  }
  return (
    typeof value.read === "boolean" &&
    typeof value.starred === "boolean" &&
    typeof value.saved === "boolean" &&
    (value.savedNotePath === undefined ||
      (typeof value.savedNotePath === "string" && value.savedNotePath.length <= 4096))
  );
}

function isJournalFeedValue(key: string, value: unknown): boolean {
  if (key === "read" || key === "starred" || key === "saved") {
    return typeof value === "boolean";
  }
  if (key === "savedFilePath" || key === "restrictedReason") {
    return typeof value === "string" && value.length <= 4096;
  }
  if (key === "tags") {
    return Array.isArray(value) && value.length <= 256 && value.every((tag) =>
      isRecord(tag) &&
      hasOnlyKeys(tag, new Set(["name", "color"])) &&
      typeof tag.name === "string" && tag.name.length <= 256 &&
      typeof tag.color === "string" && tag.color.length <= 128,
    );
  }
  if (key === "playbackProgress") {
    return (
      isRecord(value) &&
      hasOnlyKeys(value, new Set(["position", "duration", "lastUpdated"])) &&
      typeof value.position === "number" && Number.isFinite(value.position) &&
      typeof value.duration === "number" && Number.isFinite(value.duration) &&
      typeof value.lastUpdated === "number" && Number.isFinite(value.lastUpdated)
    );
  }
  return false;
}

function parseStatusRepairJournal(value: unknown): StatusRepairJournal | null {
  if (!isRecord(value)) return null;
  if (!hasOnlyKeys(value, new Set(["version", "txId", "phase", "items"]))) {
    return null;
  }
  if (
    value.version !== 1 ||
    typeof value.txId !== "string" ||
    !/^tx-\d{1,16}-[a-z0-9]{1,16}$/.test(value.txId) ||
    typeof value.phase !== "string" ||
    !STATUS_JOURNAL_PHASES.has(value.phase as StatusJournalPhase) ||
    !Array.isArray(value.items) ||
    value.items.length === 0 ||
    value.items.length > 10000
  ) {
    return null;
  }
  const items: StatusJournalItem[] = [];
  for (const rawItem of value.items) {
    if (!isRecord(rawItem)) return null;
    if (!hasOnlyKeys(rawItem, new Set([
      "feedIndex", "itemIndex", "sourceLocator", "stableId", "previousFeed",
      "previousCollection", "desired",
    ]))) return null;
    if (
      !Number.isInteger(rawItem.feedIndex) || Number(rawItem.feedIndex) < 0 ||
      !Number.isInteger(rawItem.itemIndex) || Number(rawItem.itemIndex) < 0 ||
      typeof rawItem.sourceLocator !== "string" ||
      !isStableItemId(rawItem.sourceLocator) ||
      typeof rawItem.stableId !== "string" ||
      !isStableItemId(rawItem.stableId) ||
      !Array.isArray(rawItem.previousFeed) ||
      rawItem.previousFeed.length === 0 ||
      rawItem.previousFeed.length > STATUS_JOURNAL_FEED_KEYS.size
    ) return null;
    const seenKeys = new Set<string>();
    for (const rawPrevious of rawItem.previousFeed) {
      if (!isRecord(rawPrevious)) return null;
      if (!hasOnlyKeys(rawPrevious, new Set([
        "key", "exists", "value", "valueType",
      ]))) return null;
      if (
        typeof rawPrevious.key !== "string" ||
        !STATUS_JOURNAL_FEED_KEYS.has(rawPrevious.key) ||
        seenKeys.has(rawPrevious.key) ||
        typeof rawPrevious.exists !== "boolean"
      ) return null;
      seenKeys.add(rawPrevious.key);
      const hasValue = Object.prototype.hasOwnProperty.call(rawPrevious, "value");
      if (rawPrevious.exists && rawPrevious.valueType === "undefined") {
        if (hasValue) return null;
      } else if (rawPrevious.exists) {
        if (rawPrevious.valueType !== undefined || !hasValue ||
          !isJournalFeedValue(rawPrevious.key, rawPrevious.value)) return null;
      } else if (hasValue || rawPrevious.valueType !== undefined) {
        return null;
      }
    }
    if (rawItem.previousCollection !== undefined &&
      !isJournalFlagState(rawItem.previousCollection)) return null;
    if (rawItem.desired !== undefined && !isJournalFlagState(rawItem.desired)) return null;
    items.push(rawItem as unknown as StatusJournalItem);
  }
  const locatorKeys = new Set<string>();
  for (const item of items) {
    const locatorKey = `${item.sourceLocator}:${item.stableId}`;
    if (locatorKeys.has(locatorKey)) return null;
    locatorKeys.add(locatorKey);
  }
  return {
    version: 1,
    txId: value.txId,
    phase: value.phase as StatusJournalPhase,
    items,
  };
}

function captureArticleMutationSnapshot(
  article: FeedItem,
  updates: Partial<FeedItem>,
): ArticleMutationSnapshot {
  const snapshot: ArticleMutationSnapshot = new Map();
  for (const key of Object.keys(updates) as Array<keyof FeedItem>) {
    const value = article[key];
    snapshot.set(key, {
      exists: Object.prototype.hasOwnProperty.call(article, key),
      value: Array.isArray(value) ? [...value] : value,
    });
  }
  return snapshot;
}

function restoreArticleMutationSnapshot(
  article: FeedItem,
  snapshot: ArticleMutationSnapshot,
): void {
  for (const [key, previous] of snapshot) {
    if (previous.exists) {
      (article as unknown as Record<string, unknown>)[key] = previous.value;
    } else {
      delete (article as unknown as Record<string, unknown>)[key];
    }
  }
}

function serializeArticleMutationSnapshot(
  snapshot: ArticleMutationSnapshot,
): StatusJournalItem["previousFeed"] {
  return [...snapshot].map(([key, value]) => {
    if (value.exists && value.value === undefined) {
      return { key, exists: true, valueType: "undefined" as const };
    }
    return value.exists
      ? { key, exists: true, value: value.value }
      : { key, exists: false };
  });
}

function restoreSerializedArticleSnapshot(
  article: FeedItem,
  snapshot: StatusJournalItem["previousFeed"],
): void {
  for (const previous of snapshot) {
    if (previous.exists) {
      (article as unknown as Record<string, unknown>)[previous.key] =
        previous.valueType === "undefined" ? undefined : previous.value;
    } else {
      delete (article as unknown as Record<string, unknown>)[previous.key];
    }
  }
}

class FeedRefreshPipelineError extends Error {
  constructor(
    readonly code: FeedRefreshFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "FeedRefreshPipelineError";
  }
}

class RefreshAttemptToken {
  private active = true;

  cancel(): void {
    this.active = false;
  }

  assertActive(): void {
    if (!this.active) {
      throw new FeedRefreshPipelineError(
        "timed-out",
        "Source refresh timed out.",
      );
    }
  }
}

function cloneRefreshData<T>(value: T, seen = new WeakMap<object, object>()): T {
  if (Array.isArray(value)) {
    const entries = value as unknown[];
    return entries.map((entry) => cloneRefreshData(entry, seen)) as T;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (value instanceof Date) {
    return new Date(value.getTime()) as T;
  }
  const existing = seen.get(value);
  if (existing) {
    return existing as T;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    return value;
  }

  const clone: Record<string, unknown> = {};
  seen.set(value, clone);
  for (const [key, entry] of Object.entries(value)) {
    clone[key] = cloneRefreshData(entry, seen);
  }
  return clone as T;
}

function toFeedRefreshPipelineError(error: unknown): FeedRefreshPipelineError {
  if (error instanceof FeedRefreshPipelineError) {
    return error;
  }
  return isTimeoutFeedError(error)
    ? new FeedRefreshPipelineError("timed-out", "Source refresh timed out.")
    : new FeedRefreshPipelineError("refresh-failed", "Source refresh failed.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isLegacyPlaybackProgressEntry(
  value: unknown,
): value is LegacyPlaybackProgressEntry {
  return (
    isRecord(value) &&
    typeof value.position === "number" &&
    typeof value.duration === "number"
  );
}

function isDesktopShell(value: unknown): value is DesktopShell {
  return isRecord(value) && typeof value.openPath === "function";
}

function isPathModuleLike(value: unknown): value is PathModuleLike {
  return isRecord(value) && typeof value.join === "function";
}

function getRequireFunction(): DesktopRequire | undefined {
  const desktopWindow = window as Window & { require?: DesktopRequire };
  return typeof desktopWindow.require === "function"
    ? desktopWindow.require
    : undefined;
}

function getShellFromModule(value: unknown): DesktopShell | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return isDesktopShell(value.shell) ? value.shell : undefined;
}

// Re-exported for backward compatibility with callers that import from main.ts
export type {
  FeedIngestionCandidate,
  FeedIngestionOptions,
} from "./src/types/types";

/**
 * Resolves the full vault path for metadata storage based on current mode.
 * - "plugin-default": returns undefined (uses Plugin.saveData())
 * - "vault-location": returns normalized vault folder path
 */
function getMetadataPath(settings: RssDashboardSettings): string | undefined {
  if (settings.metadataStorageMode === "plugin-default") {
    return undefined; // Use Plugin.saveData()
  }

  // Normalize path: remove leading/trailing slashes, default to .rss-dashboard-data if empty
  let folder = settings.metadataStorageFolder.trim();
  if (!folder) {
    folder = ".rss-dashboard-data";
  }
  folder = folder.replace(/^\/+|\/+$/g, ""); // Remove leading/trailing slashes
  return folder;
}

/**
 * Loads metadata from the appropriate location based on mode.
 */
async function loadMetadata(
  app: App,
  mode: "plugin-default" | "vault-location",
  folder: string,
): Promise<RssDashboardSettings | null> {
  if (mode === "plugin-default") {
    return null; // Will be loaded via Plugin.loadData() in the plugin class
  }

  // Try to load from vault location
  const metadataPath = getMetadataPath({
    ...DEFAULT_SETTINGS,
    metadataStorageMode: mode,
    metadataStorageFolder: folder,
  });
  if (!metadataPath) {
    return null;
  }

  try {
    const dataFilePath = `${metadataPath}/data.json`;
    const content = await app.vault.adapter.read(dataFilePath);
    return JSON.parse(content) as RssDashboardSettings;
  } catch (error) {
    storageLog(
      "Failed to load metadata from vault location, will fall back to plugin default",
      error,
    );
    return null; // Fall back to plugin-default
  }
}

/**
 * Ensures metadata folder exists (idempotent).
 * - If folder exists and is a folder: returns success
 * - If folder doesn't exist: creates it
 * - If path is a file: throws error
 * - If createFolder race condition occurs: checks again and continues if now a folder
 */
async function ensureMetadataFolderExists(
  app: App,
  settings: RssDashboardSettings,
): Promise<void> {
  const folderPath = getMetadataPath(settings);
  if (!folderPath) {
    return; // Plugin-default mode, no folder needed
  }

  const normalized = folderPath.replace(/^\/+|\/+$/g, "");

  try {
    // Check if path already exists in vault cache
    const existing = app.vault.getAbstractFileByPath(normalized);
    if (existing) {
      if (existing instanceof TFolder) {
        return; // Folder already exists, idempotent success
      } else {
        throw new Error(
          `Metadata storage path points to a file, not a folder: ${normalized}`,
        );
      }
    }

    // Also check via adapter (covers folders not yet indexed in vault cache)
    const existsOnDisk = await app.vault.adapter.exists(normalized);
    if (existsOnDisk) {
      return; // Folder exists on disk (cache lag), treat as success
    }

    // Folder doesn't exist, create it
    await app.vault.createFolder(normalized);
  } catch (error) {
    // Handle race condition: createFolder throws "Folder already exists" or similar
    if (
      error instanceof Error &&
      error.message.toLowerCase().includes("already exists")
    ) {
      return; // Folder exists (race condition or cache lag), treat as success
    }
    throw error;
  }
}

export default class RssDashboardPlugin extends Plugin {
  private static readonly FACTORY_RESET_LOCAL_STORAGE_KEYS = [
    "rss-discover-filters",
    "rss-podcast-progress",
    "rss-first-launch-coachmark-shown",
  ] as const;
  private static readonly URI_ACTION_ADD_FEED = "add-feed";

  settings!: RssDashboardSettings;
  feedParser!: FeedParser;
  articleSaver!: ArticleSaver;
  private backupService!: BackupService;
  protected folderService!: FolderService;
  private importExportService!: ImportExportService;
  private backgroundImportService!: BackgroundImportService;
  public activeRefreshState = new Map<string, FeedRefreshState>();
  public settingTab: RssDashboardSettingTab | null = null;
  private isMultiFeedRefreshRunning = false;
  public vaultAbsolutePath = "";
  private hasCompletedStartupSavedArticleValidation = false;
  private vaultMetadataReloadTimer: number | null = null;
  private startupRefreshTimeoutId: number | null = null;
  private automaticRefreshGeneration = 0;
  private sourceRefreshLedger:
    | { dataRoot: string; ledger: SourceRefreshLedger }
    | null = null;
  private collectionService:
    | { dataRoot: string; dailyIndexFolder: string; service: CollectionService }
    | null = null;
  private progressSaveDebounce: number | null = null;
  private suppressWatcherUntil = 0;
  // Status changes touch both the feed store and the collection store. A single
  // queue keeps their read/modify/write cycle serial, so read/star clicks cannot
  // overwrite one another while either backing store is slow.
  private statusTransactionQueue: Promise<void> = Promise.resolve();
  private static readonly FEED_REFRESH_RENDER_THROTTLE_MS = 250;
  private readonly feedStorageRepository: FeedStorageRepository;
  /** Commands are registered once by Obsidian, so this translator is frozen at load. */
  private commandTranslator: Translator = createTranslator("zh-CN");

  private t(key: Parameters<Translator>[0], params?: Parameters<Translator>[1]): string {
    return createTranslator(this.settings?.locale ?? "zh-CN")(key, params);
  }

  /** The only path for plugin-owned user notices. */
  private notify(
    key: Parameters<Translator>[0],
    params?: Parameters<Translator>[1],
    duration?: number,
  ): Notice {
    return new Notice(this.t(key, params), duration);
  }

  constructor(app: App, manifest: ConstructorParameters<typeof Plugin>[1]) {
    super(app, manifest);
    this.feedStorageRepository = new FeedStorageRepository(app, {
      writeWrapper: (fn) => this.writeWithWatcherSuppressed(fn),
      metadataTransaction: {
        capture: () => this.captureMetadataPersistenceSnapshot(),
        restore: (snapshot) =>
          this.restoreMetadataPersistenceSnapshot(
            snapshot as MetadataPersistenceSnapshot,
          ),
      },
    });
  }

  private getMetadataPersistenceFilePaths(): string[] {
    const paths = new Set<string>();
    const pluginDirectory = this.manifest.dir
      ?.trim()
      .replace(/^\/+|\/+$/g, "");
    if (pluginDirectory) {
      paths.add(
        pluginDirectory === "."
          ? "data.json"
          : `${pluginDirectory}/data.json`,
      );
    }
    const vaultMetadataFolder = getMetadataPath(this.settings);
    if (vaultMetadataFolder) {
      paths.add(`${vaultMetadataFolder}/data.json`);
    }
    return [...paths];
  }

  private async captureMetadataPersistenceSnapshot(): Promise<MetadataPersistenceSnapshot> {
    const snapshot: MetadataPersistenceSnapshot = [];
    for (const path of this.getMetadataPersistenceFilePaths()) {
      snapshot.push({
        path,
        contents: (await this.app.vault.adapter.exists(path))
          ? await this.app.vault.adapter.read(path)
          : null,
      });
    }
    return snapshot;
  }

  private async restoreMetadataPersistenceSnapshot(
    snapshot: MetadataPersistenceSnapshot,
  ): Promise<void> {
    const failures: unknown[] = [];
    for (const { path, contents } of [...snapshot].reverse()) {
      try {
        if (contents === null) {
          if (await this.app.vault.adapter.exists(path)) {
            await this.app.vault.adapter.remove(path);
          }
        } else {
          await this.app.vault.adapter.write(path, contents);
        }
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new Error("Metadata rollback incomplete");
    }
  }

  private initializeSettingsBackedServices(): void {
    this.feedParser = new FeedParser(
      this.settings.display,
      this.settings.availableTags,
      this.settings.media,
      () => this.settings.folders,
      () => this.settings.corsProxyEnabled,
    );
    this.articleSaver = new ArticleSaver(
      this.app,
      this.settings.articleSaving,
      undefined,
      this.settings.collection,
      undefined,
      this.settings.locale,
    );
    this.importExportService = new ImportExportService({
      settings: this.settings,
      isMobile: Platform.isMobileApp,
      getPortableDataBundle: () => this.getPortableDataBundle(),
      importPortableDataBundle: (bundle) =>
        this.applyPortableDataBundleImport(bundle),
      locale: this.settings.locale,
    });
    this.backupService = new BackupService({
      settings: this.settings,
      manifest: this.manifest,
      vaultAbsolutePath: this.vaultAbsolutePath,
      vault: this.app.vault,
      getUserSettingsJson: () => this.importExportService.getUserSettingsJson(),
      getPortableDataBundleJson: () =>
        JSON.stringify(this.getPortableDataBundle(), null, 2),
    });
    this.folderService = new FolderService(this.settings);
    this.backgroundImportService = new BackgroundImportService({
      feedParser: this.feedParser,
      getSettings: () => this.settings,
      getView: () => this.getActiveDashboardView(),
      saveSettings: () => this.saveSettings(),
      ensureFolderExists: (folder, opts) =>
        this.ensureFolderExists(folder, opts),
      addStatusBarItem: () => this.addStatusBarItem(),
      getLocale: () => this.settings.locale,
    });
  }

  private cloneFactoryResetFolders(
    folders: RssDashboardSettings["folders"],
    timestamp: number,
  ): RssDashboardSettings["folders"] {
    return folders.map((folder) => ({
      ...folder,
      subfolders: this.cloneFactoryResetFolders(
        folder.subfolders ?? [],
        timestamp,
      ),
      createdAt: timestamp,
      modifiedAt: timestamp,
    }));
  }

  private buildFactoryResetSettings(): RssDashboardSettings {
    const settings = JSON.parse(
      JSON.stringify(DEFAULT_SETTINGS),
    ) as RssDashboardSettings;
    const timestamp = Date.now();

    settings.folders = this.cloneFactoryResetFolders(
      DEFAULT_SETTINGS.folders,
      timestamp,
    );

    return settings;
  }

  private clearFactoryResetLocalStorage(): void {
    const appWithLocalStorage = this.app as unknown as {
      removeLocalStorage?: (key: string) => void;
      saveLocalStorage?: (key: string, value: unknown) => void;
    };

    for (const key of RssDashboardPlugin.FACTORY_RESET_LOCAL_STORAGE_KEYS as readonly string[]) {
      if (typeof appWithLocalStorage.removeLocalStorage === "function") {
        appWithLocalStorage.removeLocalStorage(key);
        continue;
      }

      if (typeof appWithLocalStorage.saveLocalStorage === "function") {
        appWithLocalStorage.saveLocalStorage(key, null);
      }
    }
  }

  /** Backward-compatible getter so sidebar and tests can read the import queue */
  public get backgroundImportQueue(): FeedMetadata[] {
    return this.backgroundImportService?.backgroundImportQueue ?? [];
  }

  /** Backward-compatible setter so tests can pre-populate the import queue */
  public set backgroundImportQueue(value: FeedMetadata[]) {
    if (this.backgroundImportService) {
      this.backgroundImportService.backgroundImportQueue = value;
    }
  }

  /** Backward-compatible accessor so test assertions can read import state */
  private get isBackgroundImporting(): boolean {
    return this.backgroundImportService?.isBackgroundImporting ?? false;
  }

  public async writeWithWatcherSuppressed<T>(
    writeFn: () => Promise<T>,
    windowMs = 3000,
  ): Promise<T> {
    this.suppressWatcherUntil = Date.now() + windowMs;
    try {
      return await writeFn();
    } finally {
      // leave suppression window to expire; don't clear explicitly
    }
  }

  private getAutoRefreshIntervalMs(): number | null {
    const normalizedMinutes = normalizeRefreshIntervalMinutes(
      this.settings.refreshInterval,
    );

    if (normalizedMinutes <= 0) {
      return null;
    }

    return normalizedMinutes * 60 * 1000;
  }

  private getSourceRefreshLedger(): SourceRefreshLedger {
    const dataRoot = this.settings.collection.dataFolder.trim();
    if (this.sourceRefreshLedger?.dataRoot === dataRoot) {
      return this.sourceRefreshLedger.ledger;
    }

    const ledger = new SourceRefreshLedger(this.app.vault, dataRoot);
    this.sourceRefreshLedger = { dataRoot, ledger };
    return ledger;
  }

  private getCollectionService(): CollectionService {
    const dataRoot = this.settings.collection.dataFolder.trim();
    const dailyIndexFolder = this.settings.collection.dailyIndexFolder.trim();
    if (
      this.collectionService?.dataRoot === dataRoot &&
      this.collectionService.dailyIndexFolder === dailyIndexFolder
    ) {
      return this.collectionService.service;
    }

    const service = new CollectionService({
      repository: new CollectionRepository(
        this.app.vault,
        dataRoot,
        () => new Date(),
      ),
      dailyIndex: new DailyIndexService(this.app.vault, dailyIndexFolder),
      ledger: this.getSourceRefreshLedger(),
    });
    this.collectionService = { dataRoot, dailyIndexFolder, service };
    return service;
  }

  /**
   * Reads a complete daily collection snapshot for neutral dashboard filters.
   * Filtering stays in the view/query service so repository reads cannot
   * accidentally hide records based on UI state.
   */
  public async getCollectedItemsForDate(
    localDate: string,
  ): Promise<CollectedItem[]> {
    const repository = new CollectionRepository(
      this.app.vault,
      this.settings.collection.dataFolder.trim(),
      () => new Date(),
    );
    return await repository.listByDate(localDate);
  }

  /** Resolves durable reader metadata without copying it onto legacy feed items. */
  public async getCollectedItemById(itemId: string): Promise<CollectedItem | null> {
    const repository = new CollectionRepository(
      this.app.vault,
      this.settings.collection.dataFolder.trim(),
      () => new Date(),
    );
    return await repository.findById(itemId);
  }

  private scheduleAutomaticRefresh(): void {
    if (this.settings.refreshMode === "off") {
      return;
    }

    if (this.settings.refreshMode === "interval") {
      const intervalMs = this.getAutoRefreshIntervalMs();
      if (intervalMs !== null) {
        this.registerInterval(
          window.setInterval(() => {
            void this.refreshFeeds();
          }, intervalMs),
        );
      }
      return;
    }

    const generation = this.automaticRefreshGeneration;
    this.app.workspace.onLayoutReady(() => {
      if (!this.isAutomaticRefreshActive(generation)) {
        return;
      }
      void this.refreshOnOpenIfNeeded().catch(() => {
        console.warn(
          "[RSS Dashboard] Automatic refresh scheduling skipped due to ledger access failure.",
        );
      });
    });
  }

  private async refreshOnOpenIfNeeded(): Promise<void> {
    const generation = this.automaticRefreshGeneration;
    if (!this.isAutomaticRefreshActive(generation)) {
      return;
    }

    const refreshableFeeds = this.getRefreshableFeeds(this.settings.feeds);
    if (refreshableFeeds.length === 0) {
      return;
    }

    const now = new Date();
    const dueSourceIds = await this.getSourceRefreshLedger().getDueSourceIds(
      refreshableFeeds.map((feed) => feed.feedId ?? feed.url),
      now,
    );
    if (!this.isAutomaticRefreshActive(generation)) {
      return;
    }
    const dueSourceIdSet = new Set(dueSourceIds);
    const dueFeeds = refreshableFeeds.filter((feed) =>
      dueSourceIdSet.has(feed.feedId ?? feed.url),
    );
    if (dueFeeds.length === 0) {
      return;
    }

    const delay = Number.isFinite(this.settings.startupRefreshDelaySeconds)
      ? this.settings.startupRefreshDelaySeconds
      : DEFAULT_SETTINGS.startupRefreshDelaySeconds;
    if (delay > 0) {
      const timeoutId = window.setTimeout(() => {
        if (this.startupRefreshTimeoutId === timeoutId) {
          this.startupRefreshTimeoutId = null;
        }
        if (!this.isAutomaticRefreshActive(generation)) {
          return;
        }
        void this.refreshFeeds(dueFeeds);
      }, delay * 1000);
      if (!this.isAutomaticRefreshActive(generation)) {
        window.clearTimeout(timeoutId);
        return;
      }
      this.startupRefreshTimeoutId = timeoutId;
      return;
    }

    if (!this.isAutomaticRefreshActive(generation)) {
      return;
    }
    void this.refreshFeeds(dueFeeds);
  }

  private isAutomaticRefreshActive(generation: number): boolean {
    return (
      this.automaticRefreshGeneration === generation &&
      this.settings.refreshMode === "daily-on-open"
    );
  }

  private async reconcileSavedArticlesOnStartup(): Promise<void> {
    if (this.hasCompletedStartupSavedArticleValidation) {
      return;
    }

    this.hasCompletedStartupSavedArticleValidation = true;

    const allArticles = this.getAllArticles();
    await this.articleSaver.fixSavedFilePaths(allArticles);
    await this.migrateMediaProgressOnStartup();

    await this.validateSavedArticles();
  }

  private scheduleStartupSavedArticleValidation(): void {
    const workspaceWithLayoutReady = this.app
      .workspace as typeof this.app.workspace & {
      onLayoutReady?: (callback: () => void) => void;
    };

    if (typeof workspaceWithLayoutReady.onLayoutReady === "function") {
      workspaceWithLayoutReady.onLayoutReady(() => {
        void this.reconcileSavedArticlesOnStartup();
      });
      return;
    }

    void this.reconcileSavedArticlesOnStartup();
  }

  /**
   * Rebuilds only the UI chrome of every currently open plugin view after a
   * locale switch. Each view keeps its own selected item, filters, pagination,
   * and playback state; command labels remain fixed until Obsidian reloads.
   */
  public refreshLocalizedViews(): void {
    const viewTypes = [
      RSS_DASHBOARD_VIEW_TYPE,
      RSS_DISCOVER_VIEW_TYPE,
      RSS_READER_VIEW_TYPE,
      RSS_SMALLWEB_VIEW_TYPE,
    ] as const;
    for (const viewType of viewTypes) {
      for (const leaf of this.app.workspace.getLeavesOfType(viewType)) {
        if (isLocalizedView(leaf.view)) {
          leaf.view.refreshLocalization();
        }
      }
    }
  }

  public async getActiveDashboardView(): Promise<RssDashboardView | null> {
    const leaves = this.app.workspace.getLeavesOfType(RSS_DASHBOARD_VIEW_TYPE);
    for (const leaf of leaves) {
      if (requireApiVersion("1.7.2")) {
        await leaf.loadIfDeferred();
      }
      const view = leaf.view;
      if (view instanceof RssDashboardView) {
        return view;
      }
    }
    return null;
  }

  public async refreshDashboardViews(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(RSS_DASHBOARD_VIEW_TYPE);
    for (const leaf of leaves) {
      if (requireApiVersion("1.7.2")) {
        await leaf.loadIfDeferred();
      }
      const view = leaf.view;
      if (view instanceof RssDashboardView) {
        view.refresh();
      }
    }
  }

  public get isMultiFeedRefreshActive(): boolean {
    return this.isMultiFeedRefreshRunning;
  }

  public notifyFiltersUpdated(payload: FiltersUpdatedEventPayload): void {
    this.app.workspace.trigger("rss-dashboard:filters-updated", payload);
  }

  public async getActiveDiscoverView(): Promise<DiscoverView | null> {
    const leaves = this.app.workspace.getLeavesOfType(RSS_DISCOVER_VIEW_TYPE);
    for (const leaf of leaves) {
      if (requireApiVersion("1.7.2")) {
        await leaf.loadIfDeferred();
      }
      const view = leaf.view;
      if (view instanceof DiscoverView) {
        return view;
      }
    }
    return null;
  }

  public async getActiveReaderView(): Promise<ReaderView | null> {
    const leaves = this.app.workspace.getLeavesOfType(RSS_READER_VIEW_TYPE);
    for (const leaf of leaves) {
      if (requireApiVersion("1.7.2")) {
        await leaf.loadIfDeferred();
      }
      const view = leaf.view;
      if (view instanceof ReaderView) {
        return view;
      }
    }
    return null;
  }

  public async refreshOpenTagColorViews(): Promise<void> {
    const dashboardLeaves = this.app.workspace.getLeavesOfType(
      RSS_DASHBOARD_VIEW_TYPE,
    );
    for (const leaf of dashboardLeaves) {
      if (requireApiVersion("1.7.2")) {
        await leaf.loadIfDeferred();
      }
      const view = leaf.view;
      if (view instanceof RssDashboardView) {
        view.refreshTagColors();
      }
    }

    const readerLeaves =
      this.app.workspace.getLeavesOfType(RSS_READER_VIEW_TYPE);
    for (const leaf of readerLeaves) {
      if (requireApiVersion("1.7.2")) {
        await leaf.loadIfDeferred();
      }
      const view = leaf.view;
      if (view instanceof ReaderView) {
        view.refreshTagColors();
      }
    }
  }

  public async performFactoryReset(): Promise<void> {
    const resetSettings = this.buildFactoryResetSettings();
    this.settings = resetSettings;
    this.activeRefreshState.clear();
    this.isMultiFeedRefreshRunning = false;
    this.initializeSettingsBackedServices();
    this.clearFactoryResetLocalStorage();

    await this.saveSettings();

    const dashboardView = await this.getActiveDashboardView();
    if (dashboardView) {
      dashboardView.refresh();
    }

    const discoverView = await this.getActiveDiscoverView();
    if (discoverView) {
      discoverView.render();
    }

    if (this.settingTab) {
      this.settingTab.display();
    }

    this.notify("plugin.factoryReset");
  }

  /**
   * Opens the plugin's settings tab to the "Tags" section.
   *
   * Uses an internal Obsidian API (app.setting) as there is no public API for this.
   * If Obsidian adds a public API, migrate this logic to use it.
   */
  public async openTagsSettings(): Promise<void> {
    const setting = getSettingManager(this.app);
    if (setting) {
      setting.open();
      setting.openTabById(this.manifest.id);
      if (this.settingTab) {
        this.settingTab.activateTab("tags");
      }
    }
  }

  /**
   * Opens the plugin's settings tab to a specific section.
   *
   * Uses an internal Obsidian API (app.setting) as there is no public API for this.
   * If Obsidian adds a public API, migrate this logic to use it.
   */
  public async openSettingsToTab(
    tabName: string,
    sectionName?: string,
  ): Promise<void> {
    const setting = getSettingManager(this.app);
    if (setting) {
      setting.open();
      setting.openTabById(this.manifest.id);
      if (this.settingTab) {
        const tabId = normalizeSettingsTabId(tabName);
        if (tabId) {
          this.settingTab.activateTab(tabId, sectionName);
        }
      }
    }
  }

  async onload() {
    const adapter = this.app.vault.adapter as unknown as VaultAdapterPathAccess;
    if (typeof adapter.getBasePath === "function") {
      this.vaultAbsolutePath = adapter.getBasePath();
    } else if (typeof adapter.getFullPath === "function") {
      this.vaultAbsolutePath = adapter.getFullPath(".");
    }

    await this.loadSettings();
    this.commandTranslator = createTranslator(this.settings?.locale ?? "zh-CN");
    this.registerVaultMetadataChangeListeners();

    const view = await this.getActiveDashboardView();
    if (view) {
      view.render();
    }


    try {
      this.initializeSettingsBackedServices();

      if (Platform.isMobile) {
        this.applyMobileOptimizations();
      }

      this.scheduleStartupSavedArticleValidation();

      this.app.workspace.onLayoutReady(() => {
        if (
          this.settings &&
          this.settings.storageMode !== "vault-shards-v2" &&
          !this.settings.storageMigrationDismissedPermanently
        ) {
          new StorageMigrationModal(this.app, this).open();
        }
      });

      this.registerObsidianProtocolHandler(
        this.manifest.id,
        (params: ObsidianProtocolData) => {
          void this.dispatchUriAction(params);
        },
      );

      this.registerView(
        RSS_DASHBOARD_VIEW_TYPE,
        (leaf) => new RssDashboardView(leaf, this),
      );

      this.registerView(
        RSS_DISCOVER_VIEW_TYPE,
        (leaf) => new DiscoverView(leaf, this),
      );

      this.registerView(
        RSS_READER_VIEW_TYPE,
        (leaf) =>
          new ReaderView(
            leaf,
            this.settings,
            this.articleSaver,
            (item: FeedItem) => {
              void this.onArticleSaved(item);
            },
            (
              item: FeedItem,
              updates: Partial<FeedItem>,
              shouldRerender?: boolean,
            ) => {
              return this.updateArticleFromReader(item, updates, shouldRerender);
            },
            {
              onPlaybackProgress: (item, position, duration, flush) => {
                this.updatePlaybackProgress(
                  item.feedUrl,
                  item.guid,
                  position,
                  duration,
                  flush,
                  item,
                );
              },
            },
          ),
      );

      this.registerView(
        RSS_SMALLWEB_VIEW_TYPE,
        (leaf) => new KagiSmallwebView(leaf, this),
      );

      this.addRibbonIcon("compass", this.commandTranslator("command.openDashboard"), () => {
        void this.activateView();
      });

      this.settingTab = new RssDashboardSettingTab(this.app, this);
      this.addSettingTab(this.settingTab);

      this.addCommand({
        id: "open-dashboard",
        name: this.commandTranslator("command.openDashboard"),
        callback: () => {
          void this.activateView();
        },
      });

      this.addCommand({
        id: "open-discover",
        name: this.commandTranslator("command.openDiscover"),
        callback: () => {
          void this.activateDiscoverView();
        },
      });

      this.addCommand({
        id: "refresh-feeds",
        name: this.commandTranslator("command.refreshAllSources"),
        callback: () => {
          void this.manualRefreshAllSources();
        },
      });

      this.addCommand({
        id: "refresh-failed-sources",
        name: this.commandTranslator("command.refreshFailedSources"),
        callback: () => {
          void this.manualRefreshFailedSources();
        },
      });

      this.addCommand({
        id: "import-opml",
        name: this.commandTranslator("command.importOpml"),
        callback: () => {
          new ImportOpmlModal(this.app, this).open();
        },
      });

      this.addCommand({
        id: "export-opml",
        name: this.commandTranslator("command.exportOpml"),
        callback: () => {
          void this.exportOpml();
        },
      });

      this.addCommand({
        id: "import-usersettings-json",
        name: this.commandTranslator("command.importUserSettings"),
        callback: () => {
          this.importUserSettingsJson();
        },
      });

      this.addCommand({
        id: "export-usersettings-json",
        name: this.commandTranslator("command.exportUserSettings"),
        callback: () => {
          void this.exportUserSettingsJson();
        },
      });

      this.addCommand({
        id: "apply-feed-limits",
        name: this.commandTranslator("command.applyFeedLimits"),
        callback: () => {
          void this.applyFeedLimitsToAllFeeds();
        },
      });

      this.addCommand({
        id: "toggle-sidebar",
        name: this.commandTranslator("command.toggleSidebar"),
        checkCallback: (checking: boolean) => {
          const leaves = this.app.workspace.getLeavesOfType(
            RSS_DASHBOARD_VIEW_TYPE,
          );
          if (leaves.length > 0) {
            if (!checking) {
              void (async () => {
                const view = await this.getActiveDashboardView();
                if (view) {
                  this.settings.sidebarCollapsed =
                    !this.settings.sidebarCollapsed;
                  await this.saveSettings();
                  view.render();
                }
              })();
            }
            return true;
          }
          return false;
        },
      });

      this.scheduleAutomaticRefresh();
    } catch (err: unknown) {
      if (err instanceof Error) {
        console.error("[RSS Dashboard] onload initialization failed:", err);
      } else {
        console.error(
          "[RSS Dashboard] onload initialization failed:",
          String(err),
        );
      }
      this.notify("plugin.initializationFailed");
    }
  }

  private async dispatchUriAction(params: ObsidianProtocolData): Promise<void> {
    const action = this.resolveRequestedUriAction(params);

    if (!action) {
      this.notify("plugin.uri.missingAction");
      return;
    }

    try {
      switch (action) {
        case RssDashboardPlugin.URI_ACTION_ADD_FEED:
          await this.handleAddFeedUriAction(params);
          return;
        default:
          this.notify("plugin.uri.unsupported", { action });
      }
    } catch (error) {
      console.error("[RSS Dashboard] URI action failed:", error);
      this.notify("plugin.uri.failed");
    }
  }

  private resolveRequestedUriAction(params: ObsidianProtocolData): string {
    const routeAction = (params.action ?? "").trim().toLowerCase();
    const queryAction =
      typeof params.uriAction === "string"
        ? params.uriAction.trim().toLowerCase()
        : "";

    if (queryAction) {
      return queryAction;
    }

    // Obsidian protocol reserves `action` for the route itself.
    // For links like `obsidian://rss-dashboard?...`, infer add-feed when a URL
    // parameter is present so browser-triggered links work reliably.
    if (
      routeAction === this.manifest.id.toLowerCase() &&
      typeof params.url === "string" &&
      params.url.trim().length > 0
    ) {
      return RssDashboardPlugin.URI_ACTION_ADD_FEED;
    }

    if (routeAction === this.manifest.id.toLowerCase()) {
      return "";
    }

    return routeAction;
  }

  private decodeUriFeedUrl(rawUrl: string): string {
    const candidate = rawUrl.trim();
    if (!candidate) {
      throw new Error("Missing required URL parameter for add-feed.");
    }

    if (!candidate.includes("%")) {
      return candidate;
    }

    try {
      return decodeURIComponent(candidate);
    } catch {
      throw new Error(
        "Feed URL is malformed. Ensure the url parameter is URL-encoded.",
      );
    }
  }

  private buildUriAddFeedTitle(feedUrl: string): string {
    try {
      const parsed = new URL(feedUrl);
      const hostname = parsed.hostname.replace(/^www\./i, "").trim();
      return hostname || feedUrl;
    } catch {
      return feedUrl;
    }
  }

  private async handleAddFeedUriAction(
    params: ObsidianProtocolData,
  ): Promise<void> {
    const rawUrl = typeof params.url === "string" ? params.url : "";
    if (!rawUrl.trim()) {
      this.notify("plugin.uri.missingUrl");
      return;
    }

    const decodedUrl = this.decodeUriFeedUrl(rawUrl);
    const urlValidation = isValidUrl(decodedUrl);
    if (!urlValidation.valid) {
      console.error("[RSS Dashboard] Invalid URI feed URL:", urlValidation.error);
      this.notify("plugin.uri.invalidUrl");
      return;
    }

    const defaultFolder = this.settings.media.defaultRssFolder?.trim() || "RSS";

    await this.activateView();

    new AddFeedModal(
      this.app,
      this.settings.folders,
      async (request) =>
        await this.addFeed(
          request.title,
          request.url,
          request.folder,
          request.autoDeleteDuration,
          request.maxItemsLimit,
          request.scanInterval,
          request.feedKeywordRules,
          request.customTemplate,
          request.excludeFromRefresh,
          request.customTags,
        ),
      () => {
        void this.refreshDashboardViews();
      },
      defaultFolder,
      this,
      decodedUrl,
      this.buildUriAddFeedTitle(decodedUrl),
    ).open();
  }

  private applyMobileOptimizations(): void {
    if (
      this.settings.refreshInterval > 0 &&
      this.settings.refreshInterval < 60
    ) {
      this.settings.refreshInterval = 60;
    }

    if (this.settings.maxItems > 50) {
      this.settings.maxItems = 50;
    }

    if (!this.settings.sidebarCollapsed) {
      this.settings.sidebarCollapsed = true;
    }
  }

  async activateView() {
    const { workspace } = this.app;

    try {
      let leaf: WorkspaceLeaf | null = null;
      const leaves = workspace.getLeavesOfType(RSS_DASHBOARD_VIEW_TYPE);

      if (leaves.length > 0) {
        leaf = leaves[0];
      } else {
        switch (this.settings.viewLocation) {
          case "left-sidebar":
            leaf = workspace.getLeftLeaf(false);
            break;
          case "right-sidebar":
            leaf = workspace.getRightLeaf(false);
            break;
          default:
            leaf = workspace.getLeaf("tab");
            break;
        }
      }

      if (leaf) {
        await leaf.setViewState({
          type: RSS_DASHBOARD_VIEW_TYPE,
          active: true,
        });
        void workspace.revealLeaf(leaf);
      }
    } catch {
      this.notify("plugin.openDashboardFailed");
    }
  }

  async activateDiscoverView() {
    const { workspace } = this.app;

    try {
      let leaf: WorkspaceLeaf | null = null;
      const leaves = workspace.getLeavesOfType(RSS_DISCOVER_VIEW_TYPE);

      if (leaves.length > 0) {
        leaf = leaves[0];
      } else {
        leaf = workspace.getLeaf("tab");
      }

      if (leaf) {
        await leaf.setViewState({
          type: RSS_DISCOVER_VIEW_TYPE,
          active: true,
        });
        void workspace.revealLeaf(leaf);
      }
    } catch {
      this.notify("plugin.openDiscoverFailed");
    }
  }

  async activateSmallwebView() {
    const { workspace } = this.app;

    try {
      let leaf: WorkspaceLeaf | null = null;
      const leaves = workspace.getLeavesOfType(RSS_SMALLWEB_VIEW_TYPE);

      if (leaves.length > 0) {
        leaf = leaves[0];
      } else {
        leaf = workspace.getLeaf("tab");
      }

      if (leaf) {
        await leaf.setViewState({
          type: RSS_SMALLWEB_VIEW_TYPE,
          active: true,
        });
        void workspace.revealLeaf(leaf);
      }
    } catch {
      this.notify("plugin.openSmallwebFailed");
    }
  }

  private async onArticleSaved(item: FeedItem): Promise<void> {
    if (item.feedUrl) {
      const feed = this.settings.feeds.find((f) => f.url === item.feedUrl);
      if (feed) {
        const originalItem = feed.items.find((i) => i.guid === item.guid);
        if (originalItem) {
          originalItem.saved = true;
          originalItem.savedFilePath = item.savedFilePath;

          if (this.settings.articleSaving.addSavedTag) {
            if (!originalItem.tags) {
              originalItem.tags = [];
            }

            if (
              !originalItem.tags.some((t) => t.name.toLowerCase() === "saved")
            ) {
              const savedTag = this.settings.availableTags.find(
                (t) => t.name.toLowerCase() === "saved",
              );
              if (savedTag) {
                originalItem.tags.push({ ...savedTag });
              } else {
                originalItem.tags.push({ name: "saved", color: "#3498db" });
              }
            }
          }

          await this.saveSettings();

          await this.syncDashboardArticleUpdate(
            item.guid,
            item.feedUrl,
            {
              saved: true,
              savedFilePath: originalItem.savedFilePath,
              tags: originalItem.tags ? [...originalItem.tags] : [],
            },
            false,
          );
          await this.syncReaderArticleUpdate(item.guid, {
            saved: true,
            savedFilePath: originalItem.savedFilePath,
            tags: originalItem.tags ? [...originalItem.tags] : [],
          });
        }
      }
    }
  }

  private async updateArticleFromReader(
    item: FeedItem,
    updates: Partial<FeedItem>,
    shouldRerender?: boolean,
  ): Promise<boolean> {
    const resolvedFeed =
      this.settings.feeds.find((f) => f.url === item.feedUrl) ||
      this.settings.feeds.find((f) =>
        f.items.some((candidate) => candidate.guid === item.guid),
      );
    if (!resolvedFeed) return false;

    const resolvedFeedUrl = resolvedFeed.url;
    item.feedUrl = resolvedFeedUrl;

    const normalizedUpdates = applyAutomaticArticleTags(
      item,
      updates,
      this.settings,
    );
    const originalItem = resolvedFeed.items.find((i) => i.guid === item.guid);
    if (!originalItem) return false;

    return await this.updateArticle(
      item.guid,
      resolvedFeedUrl,
      normalizedUpdates,
      shouldRerender,
    );
  }

  private async syncReaderArticleUpdate(
    articleGuid: string,
    updates: Partial<FeedItem>,
  ): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(RSS_READER_VIEW_TYPE);
    for (const leaf of leaves) {
      try {
        if (requireApiVersion("1.7.2")) {
          await leaf.loadIfDeferred();
        }
        const view = leaf.view;
        if (view instanceof ReaderView) {
          view.applyExternalUpdate(articleGuid, updates);
        }
      } catch {
        // Each reader leaf is an independent best-effort observer.
      }
    }
  }

  private async syncDashboardArticleUpdate(
    articleGuid: string,
    feedUrl: string,
    updates: Partial<FeedItem>,
    shouldRerender: boolean,
  ): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(RSS_DASHBOARD_VIEW_TYPE);
    for (const leaf of leaves) {
      try {
        if (requireApiVersion("1.7.2")) {
          await leaf.loadIfDeferred();
        }
        const view = leaf.view;
        if (view instanceof RssDashboardView) {
          view.applyExternalArticleUpdate(
            articleGuid,
            feedUrl,
            updates,
            shouldRerender,
          );
        }
      } catch {
        // Each dashboard leaf is an independent best-effort observer.
      }
    }
  }

  async refreshFeeds(selectedFeeds?: Feed[]) {
    try {
      const candidateFeeds = selectedFeeds || this.settings.feeds;
      if (candidateFeeds.length === 0) {
        return;
      }

      const feedsToRefresh = this.getRefreshableFeeds(candidateFeeds);
      if (feedsToRefresh.length === 0) {
        this.notify(
          selectedFeeds
            ? "plugin.refresh.allSelectedExcluded"
            : "plugin.refresh.allExcluded",
        );
        return;
      }

      if (!this.feedParser) {
        console.warn(
          "[RSS dashboard] Feed parser not initialized; skipping refresh.",
        );
        return;
      }

      let feedNoticeText = "";
      if (feedsToRefresh.length === 1) {
        feedNoticeText = feedsToRefresh[0].title;
      } else {
        feedNoticeText = this.t("plugin.feedCount", {
          count: feedsToRefresh.length,
        });
      }

      this.notify("plugin.refreshing", { source: feedNoticeText });
      if (feedsToRefresh.length === 1) {
        await this.refreshSingleFeed(feedsToRefresh[0], feedNoticeText);
        return;
      }

      await this.refreshFeedBatch(feedsToRefresh, feedNoticeText);
    } catch {
      console.error("[RSS dashboard] Refresh request failed.");
      this.notify("plugin.refreshFailed");
    }
  }

  async refreshFailedSources(): Promise<void> {
    try {
      const failedSourceIds = new Set(
        await this.getSourceRefreshLedger().getSourceIdsWithStatus("error"),
      );
      const failedFeeds = this.getRefreshableFeeds(this.settings.feeds).filter(
        (feed) => failedSourceIds.has(feed.feedId ?? feed.url),
      );
      if (failedFeeds.length > 0) {
        await this.refreshFeeds(failedFeeds);
      }
    } catch {
      console.error("[RSS dashboard] Failed-source refresh request failed.");
      this.notify("plugin.refresh.failedSourcesFailed");
    }
  }

  /** Public manual entry point used by commands and dashboard controls. */
  public async manualRefreshAllSources(): Promise<void> {
    this.cancelPendingStartupRefresh();
    await this.refreshFeeds();
  }

  /** Public manual entry point used by commands and dashboard controls. */
  public async manualRefreshFailedSources(): Promise<void> {
    this.cancelPendingStartupRefresh();
    await this.refreshFailedSources();
  }

  /** Public manual entry point used by collection source rows. */
  public async manualRefreshSourceById(sourceId: string): Promise<void> {
    this.cancelPendingStartupRefresh();
    await this.refreshSourceById(sourceId);
  }

  /**
   * Resolves a durable collection source identity only against current
   * subscriptions before entering the existing single-source refresh path.
   */
  async refreshSourceById(sourceId: string): Promise<void> {
    const feed = this.settings.feeds.find(
      (candidate) => (candidate.feedId ?? candidate.url) === sourceId,
    );
    if (!feed) {
      this.notify("plugin.refresh.sourceGone");
      return;
    }
    await this.refreshSelectedFeed(feed);
  }

  /**
   * Apply feed limits (maxItemsLimit and autoDeleteDuration) to all feeds
   * This is useful when users want to apply their current settings to existing feeds
   */
  async applyFeedLimitsToAllFeeds() {
    try {
      let updatedCount = 0;

      for (const feed of this.settings.feeds) {
        const originalCount = feed.items.length;
        const updated = applyFeedRetentionLimits(feed);
        feed.items = updated.items;

        if (feed.items.length !== originalCount) {
          updatedCount++;
        }
      }

      await this.saveSettings();
      await this.refreshDashboardViews();

      if (updatedCount > 0) {
        this.notify("plugin.limits.applied", { count: updatedCount });
      } else {
        this.notify("plugin.limits.noChanges");
      }
    } catch (error) {
      console.error("[RSS Dashboard] Applying feed limits failed:", error);
      this.notify("plugin.limits.failed");
    }
  }

  async refreshSelectedFeed(feed: Feed) {
    try {
      this.cancelPendingStartupRefresh();
      if (!this.feedParser) {
        console.warn(
          "[RSS dashboard] Feed parser not initialized; skipping refresh.",
        );
        return;
      }

      this.notify("plugin.refreshing", { source: feed.title });
      await this.refreshSingleFeed(feed, feed.title);
    } catch {
      console.error("[RSS dashboard] Refresh request failed.");
      this.notify("plugin.refreshFailed");
    }
  }

  async refreshFeedsInFolder(folderPath: string) {
    this.cancelPendingStartupRefresh();
    const feedsInFolder = this.settings.feeds.filter((feed) => {
      if (!feed.folder) return false;
      return (
        feed.folder === folderPath || feed.folder.startsWith(folderPath + "/")
      );
    });

    if (feedsInFolder.length > 0) {
      await this.refreshFeeds(feedsInFolder);
    } else {
      this.notify("plugin.refresh.folderEmpty");
    }
  }

  async updateArticle(
    articleGuid: string,
    feedUrl: string,
    updates: Partial<FeedItem>,
    shouldRefreshView = true,
    options?: {
      suppressCollectionBroadcast?: boolean;
      forceCollectionPathSync?: boolean;
    },
  ): Promise<boolean> {
    return (await this.updateArticleWithOutcome(
      articleGuid,
      feedUrl,
      updates,
      shouldRefreshView,
      options,
    )) !== "failed";
  }

  private async updateArticleWithOutcome(
    articleGuid: string,
    feedUrl: string,
    updates: Partial<FeedItem>,
    shouldRefreshView = true,
    options?: {
      suppressCollectionBroadcast?: boolean;
      forceCollectionPathSync?: boolean;
    },
  ): Promise<ArticleUpdateOutcome> {
    const isCollectionFlagMutation =
      updates.read !== undefined ||
      updates.starred !== undefined ||
      (updates.saved !== undefined && updates.saved !== true) ||
      options?.forceCollectionPathSync === true;
    const transactionResult = await this.enqueueStatusTransaction(async () => {
      const feed = this.settings.feeds.find((f) => f.url === feedUrl);
      if (!feed) return "failed" as const;
      const article = feed.items.find((item) => item.guid === articleGuid);
      if (!article) return "failed" as const;
      return isCollectionFlagMutation
        ? await this.commitCollectionFlagTransaction(article, updates)
        : (await this.commitFeedOnlyArticleUpdate(article, updates))
          ? "feed-only"
          : "failed";
    });
    if (transactionResult === "failed") {
      return "failed";
    }

    if (
      transactionResult === "collection" &&
      !options?.suppressCollectionBroadcast
    ) {
      this.emitCollectionFlagsUpdated();
    }
    // The collection event is the cross-dashboard invalidation signal. Avoid
    // a second full reload here; regular dashboard cards get a targeted sync.
    if (shouldRefreshView) {
      try {
        await this.syncDashboardArticleUpdate(
          articleGuid,
          feedUrl,
          updates,
          false,
        );
      } catch {
        // UI observers are best-effort after both durable stores commit.
      }
    }
    try {
      await this.syncReaderArticleUpdate(articleGuid, updates);
    } catch {
      // UI observers are best-effort after both durable stores commit.
    }
    return transactionResult;
  }

  private async enqueueStatusTransaction<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.statusTransactionQueue;
    let release!: () => void;
    this.statusTransactionQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      return await work();
    } finally {
      release();
    }
  }

  public async updateSavedNotePath(
    articleGuid: string,
    feedUrl: string,
    savedFilePath: string,
  ): Promise<boolean> {
    return await this.updateArticle(
      articleGuid,
      feedUrl,
      { saved: true, savedFilePath },
      false,
      { forceCollectionPathSync: true },
    );
  }

  public async updateArticlesReadBatch(
    targets: Array<{ articleGuid: string; feedUrl: string }>,
    read: boolean,
  ): Promise<boolean> {
    let collectionChanged = false;
    const success = await this.enqueueStatusTransaction(async () => {
      if (targets.length === 0) return false;
      const resolved: Array<{ feed: Feed; article: FeedItem }> = [];
      for (const target of targets) {
        const feed = this.settings.feeds.find(
          (candidate) => candidate.url === target.feedUrl,
        );
        const article = feed?.items.find(
          (candidate) => candidate.guid === target.articleGuid,
        );
        if (!feed || !article) return false;
        if (!resolved.some((entry) => entry.article === article)) {
          resolved.push({ feed, article });
        }
      }

      const repository = new CollectionRepository(
        this.app.vault,
        this.settings.collection.dataFolder.trim(),
        () => new Date(),
      );
      const entries: Array<{
        article: FeedItem;
        snapshot: ArticleMutationSnapshot;
        previousCollection?: CollectionFlagState;
        desired?: CollectionFlagState;
      }> = [];
      for (const { article } of resolved) {
        const snapshot = captureArticleMutationSnapshot(article, { read });
        let previousCollection: CollectionFlagState | undefined;
        let desired: CollectionFlagState | undefined;
        if (/^[a-f0-9]{64}$/.test(article.rssDashboardId ?? "")) {
          let item;
          try {
            item = await repository.findById(article.rssDashboardId!);
          } catch {
            this.notify("plugin.state.collectionSaveFailed");
            return false;
          }
          if (item) {
            previousCollection = collectionFlagsFromItem(item);
            desired = {
              read,
              starred: article.starred ?? false,
              saved: article.saved ?? false,
              savedNotePath: article.savedFilePath,
            };
          }
        }
        entries.push({ article, snapshot, previousCollection, desired });
      }
      const journal = await this.prepareStatusJournalEntries(entries);
      if (!journal) return false;
      const changedCollections = entries.filter(
        (entry) => entry.previousCollection && entry.desired,
      );
      try {
        for (const entry of changedCollections) {
          await repository.updateFlags(entry.article.rssDashboardId!, entry.desired!);
        }
        if (changedCollections.length > 0) {
          await this.updateStatusJournalPhase(journal, "collection-written");
        }
        for (const entry of entries) entry.article.read = read;
        await this.updateStatusJournalPhase(journal, "feed-write-uncertain");
        await this.saveSettings();
        await this.updateStatusJournalPhase(journal, "feed-written");
        await this.clearStatusJournal();
        collectionChanged = changedCollections.length > 0;
        return true;
      } catch {
        for (const entry of entries) {
          restoreArticleMutationSnapshot(entry.article, entry.snapshot);
        }
        for (const entry of changedCollections) {
          try {
            await repository.updateFlags(
              entry.article.rssDashboardId!,
              entry.previousCollection!,
            );
          } catch {
            // The durable journal remains available for startup replay.
          }
        }
        await this.replayStatusRepairJournalIfNeeded();
        this.notify("plugin.state.articleSaveFailed");
        return false;
      }
    });
    if (success && collectionChanged) this.emitCollectionFlagsUpdated();
    return success;
  }

  private async commitFeedOnlyArticleUpdate(
    article: FeedItem,
    updates: Partial<FeedItem>,
  ): Promise<boolean> {
    const snapshot = captureArticleMutationSnapshot(article, updates);
    const journal = await this.prepareStatusJournal(article, snapshot);
    if (!journal) return false;
    Object.assign(article, updates);
    try {
      await this.updateStatusJournalPhase(journal, "feed-write-uncertain");
      await this.saveSettings();
      await this.updateStatusJournalPhase(journal, "feed-written");
      await this.clearStatusJournal();
      return true;
    } catch {
      restoreArticleMutationSnapshot(article, snapshot);
      await this.replayStatusRepairJournalIfNeeded();
      this.notify("plugin.state.articleSaveFailed");
      return false;
    }
  }

  private async commitCollectionFlagTransaction(
    article: FeedItem,
    updates: Partial<FeedItem>,
  ): Promise<"failed" | "feed-only" | "collection"> {
    const itemId = article.rssDashboardId;
    if (!itemId || !/^[a-f0-9]{64}$/.test(itemId)) {
      // Older feed-only entries remain supported, but are not represented as a
      // collection update and therefore deliberately emit no collection event.
      return (await this.commitFeedOnlyArticleUpdate(article, updates))
        ? "feed-only"
        : "failed";
    }

    const repository = new CollectionRepository(
      this.app.vault,
      this.settings.collection.dataFolder.trim(),
      () => new Date(),
    );
    let previous;
    try {
      previous = await repository.findById(itemId);
    } catch {
      this.notify("plugin.state.collectionSaveFailed");
      return "failed";
    }
    if (!previous) {
      return (await this.commitFeedOnlyArticleUpdate(article, updates))
        ? "feed-only"
        : "failed";
    }

    const previousCollectionState = collectionFlagsFromItem(previous);
    const desired = {
      read: updates.read ?? article.read ?? false,
      starred: updates.starred ?? article.starred ?? false,
      saved: updates.saved ?? article.saved ?? false,
      savedNotePath:
        updates.saved === false
          ? undefined
          : updates.savedFilePath ?? article.savedFilePath ?? previous.savedNotePath,
    };
    const feedSnapshot = captureArticleMutationSnapshot(article, updates);
    const journal = await this.prepareStatusJournal(
      article,
      feedSnapshot,
      previousCollectionState,
      desired,
    );
    if (!journal) return "failed";
    try {
      await repository.updateFlags(itemId, desired);
      await this.updateStatusJournalPhase(journal, "collection-written");
    } catch {
      await this.replayStatusRepairJournalIfNeeded();
      this.notify("plugin.state.collectionSaveFailed");
      return "failed";
    }

    Object.assign(article, updates);
    try {
      await this.updateStatusJournalPhase(journal, "feed-write-uncertain");
      await this.saveSettings();
      await this.updateStatusJournalPhase(journal, "feed-written");
      await this.clearStatusJournal();
      return "collection";
    } catch {
      restoreArticleMutationSnapshot(article, feedSnapshot);
      try {
        await repository.updateFlags(itemId, previousCollectionState);
      } catch {
        this.notify("plugin.state.collectionRepairRequired");
        return "failed";
      }
      await this.replayStatusRepairJournalIfNeeded();
      this.notify("plugin.state.articleSaveFailed");
      return "failed";
    }
  }

  private getStatusJournalItemLocator(article: FeedItem): {
    feedIndex: number;
    itemIndex: number;
    sourceLocator: string;
    stableId: string;
  } | null {
    this.feedStorageRepository.ensureFeedIds(this.settings);
    for (let feedIndex = 0; feedIndex < this.settings.feeds.length; feedIndex++) {
      const feed = this.settings.feeds[feedIndex];
      const itemIndex = feed.items.indexOf(article);
      if (itemIndex >= 0 && feed.feedId) {
        try {
          const locator = {
            feedIndex,
            itemIndex,
            sourceLocator: createSourceLocator(feed.feedId),
            stableId: resolveFeedItemStableId(article),
          };
          let matchCount = 0;
          for (const candidateFeed of this.settings.feeds) {
            if (!candidateFeed.feedId ||
              createSourceLocator(candidateFeed.feedId) !== locator.sourceLocator) {
              continue;
            }
            for (const candidateItem of candidateFeed.items) {
              if (resolveFeedItemStableId(candidateItem) === locator.stableId) {
                matchCount += 1;
              }
            }
          }
          return matchCount === 1 ? locator : null;
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  private async prepareStatusJournal(
    article: FeedItem,
    snapshot: ArticleMutationSnapshot,
    previousCollection?: CollectionFlagState,
    desired?: CollectionFlagState,
  ): Promise<StatusRepairJournal | null> {
    return await this.prepareStatusJournalEntries([
      { article, snapshot, previousCollection, desired },
    ]);
  }

  private async prepareStatusJournalEntries(entries: Array<{
    article: FeedItem;
    snapshot: ArticleMutationSnapshot;
    previousCollection?: CollectionFlagState;
    desired?: CollectionFlagState;
  }>): Promise<StatusRepairJournal | null> {
    if (!(await this.reconcileExistingStatusJournalBeforeMutation())) {
      this.notify("plugin.state.articleRepairRequired");
      return null;
    }
    const items: StatusJournalItem[] = [];
    for (const entry of entries) {
      const locator = this.getStatusJournalItemLocator(entry.article);
      if (!locator) {
        this.notify("plugin.state.articleSaveFailed");
        return null;
      }
      items.push({
        ...locator,
        previousFeed: serializeArticleMutationSnapshot(entry.snapshot),
        previousCollection: entry.previousCollection,
        desired: entry.desired,
      });
    }
    const journal: StatusRepairJournal = {
      version: 1,
      txId: `tx-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      phase: "prepared",
      items,
    };
    try {
      await this.writeStatusJournal(journal);
      return journal;
    } catch {
      this.notify("plugin.state.articleSaveFailed");
      return null;
    }
  }

  private async updateStatusJournalPhase(
    journal: StatusRepairJournal,
    phase: StatusJournalPhase,
  ): Promise<void> {
    journal.phase = phase;
    await this.writeStatusJournal(journal);
  }

  private async writeStatusJournal(journal: StatusRepairJournal): Promise<void> {
    for (const folder of [".rss-dashboard-data", ".rss-dashboard-data/state"]) {
      if (!(await this.app.vault.adapter.exists(folder))) {
        await this.app.vault.createFolder(folder);
      }
    }
    const temporaryPath = `${STATUS_REPAIR_JOURNAL_PATH}.tmp`;
    const contents = JSON.stringify(journal);
    const adapter = this.app.vault.adapter as typeof this.app.vault.adapter & {
      rename?: (from: string, to: string) => Promise<void>;
    };
    await adapter.write(temporaryPath, contents);
    if (
      typeof adapter.rename === "function" &&
      !(await adapter.exists(STATUS_REPAIR_JOURNAL_PATH))
    ) {
      await adapter.rename(temporaryPath, STATUS_REPAIR_JOURNAL_PATH);
    } else {
      // The fully-written temp remains recovery evidence until canonical bytes
      // are installed and verified.
      await adapter.write(STATUS_REPAIR_JOURNAL_PATH, contents);
    }
    const verified = parseStatusRepairJournal(JSON.parse(
      await adapter.read(STATUS_REPAIR_JOURNAL_PATH),
    ));
    if (
      !verified ||
      verified.txId !== journal.txId ||
      verified.phase !== journal.phase ||
      getStatusJournalImmutablePayload(verified) !==
        getStatusJournalImmutablePayload(journal)
    ) {
      throw new Error("Status journal verification failed");
    }
  }

  private async clearStatusJournal(): Promise<void> {
    const adapter = this.app.vault.adapter as typeof this.app.vault.adapter & {
      remove?: (path: string) => Promise<void>;
    };
    const remove = async (path: string): Promise<void> => {
      if (!(await adapter.exists(path))) return;
      if (typeof adapter.remove === "function") {
        await adapter.remove(path);
      } else {
        await (this.app.vault as unknown as {
          delete: (target: string) => Promise<void>;
        }).delete(path);
      }
    };
    try {
      await remove(`${STATUS_REPAIR_JOURNAL_PATH}.tmp`);
      await remove(STATUS_REPAIR_JOURNAL_PATH);
    } catch {
      throw new Error("Status journal cleanup incomplete");
    }
  }

  private emitCollectionFlagsUpdated(): void {
    const workspace = this.app.workspace as typeof this.app.workspace & {
      trigger?: (name: string) => void;
    };
    try {
      workspace.trigger?.("rss-dashboard:collection-flags-updated");
    } catch {
      // Workspace observers are best-effort. Their failure must not turn a
      // fully durable status transaction into a failed user action.
    }
  }

  importOpml(): void {
    const handleImportOpmlFile = async (file: File) => {
      const fileName = file.name.toLowerCase() || "";
      if (fileName.endsWith(".opml") || fileName.endsWith(".xml")) {
        const content = await file.text();
        try {
          const { feeds: newFeedsMetadata, folders: newFolders } =
            OpmlManager.parseOpmlMetadata(content);
          const result = await this.ingestFeedsForBackgroundImport(
            newFeedsMetadata,
            {
              mode: "update",
              folders: newFolders,
            },
          );

          if (result.addedCount === 0) {
            this.notify("plugin.opml.noNewFeeds");
            return;
          }

          this.notify("plugin.opml.imported", { count: result.addedCount });
        } catch (error) {
          console.error("[RSS Dashboard] OPML import failed:", error);
          this.notify("plugin.opml.importFailed");
        }
      } else {
        this.notify("plugin.opml.invalidFile");
      }
    };

    const input = activeDocument.body.createEl("input", {
      attr: { type: "file", accept: ".opml,.xml,.backup" },
    });
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) {
        void handleImportOpmlFile(file);
      }
      input.remove();
    };
    input.click();
  }

  public startBackgroundImport(feeds: Feed[]): void {
    // ✅ BackgroundImportService extracted — all 882 currently green tests passing
    this.backgroundImportService.startBackgroundImport(feeds);
  }

  public async ingestFeedsForBackgroundImport(
    candidates: FeedIngestionCandidate[],
    options?: FeedIngestionOptions,
  ): Promise<{
    addedCount: number;
    skippedCount: number;
    queuedFeeds: Feed[];
  }> {
    return this.backgroundImportService.ingestFeedsForBackgroundImport(
      candidates,
      options,
    );
  }

  public importUserSettingsJson(): void {
    const input = activeDocument.body.createEl("input", {
      attr: {
        type: "file",
        accept: ".json,.backup,application/json",
      },
    });

    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      void this.importUserSettingsJsonFromFile(file);
    };

    input.click();
  }

  public async importUserSettingsJsonFromFile(file: File): Promise<void> {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as Partial<RssDashboardSettings>;
      if (!parsed || typeof parsed !== "object") {
        throw new Error("Invalid usersettings.json");
      }

      const parsedWithCollections = parsed as Partial<RssDashboardSettings> & {
        feeds?: unknown;
        folders?: unknown;
        availableTags?: unknown;
      };
      const hasFeedCollections =
        Array.isArray(parsedWithCollections.feeds) ||
        Array.isArray(parsedWithCollections.folders) ||
        Array.isArray(parsedWithCollections.availableTags);

      if (hasFeedCollections) {
        this.settings = Object.assign(
          {},
          DEFAULT_SETTINGS,
          this.settings,
          parsed,
        );
        this.settings.feeds = Array.isArray(parsedWithCollections.feeds)
          ? parsedWithCollections.feeds
          : [];
        this.settings.folders = Array.isArray(parsedWithCollections.folders)
          ? parsedWithCollections.folders
          : this.settings.folders;
        this.settings.availableTags = Array.isArray(
          parsedWithCollections.availableTags,
        )
          ? parsedWithCollections.availableTags
          : this.settings.availableTags;

        this.migrateLegacySettings();
        for (const feed of this.settings.feeds) {
          if (!feed.keywordRules) {
            feed.keywordRules = {
              overrideGlobalRules: false,
              includeLogic: "AND",
              rules: [],
            };
            continue;
          }
          feed.keywordRules = Object.assign(
            {},
            {
              overrideGlobalRules: false,
              includeLogic: "AND",
              rules: [],
            },
            feed.keywordRules,
          );

          // Migrate legacy feeds: apply default auto-delete and maxItems if not set
          // This ensures feeds imported before the fix will respect the global defaults
          if (typeof feed.autoDeleteDuration !== "number") {
            feed.autoDeleteDuration = this.settings.defaultAutoDeleteDuration;
          }
          if (typeof feed.maxItemsLimit !== "number") {
            feed.maxItemsLimit = this.settings.maxItems;
          }
        }

        this.initializeSettingsBackedServices();
        await this.saveSettings();
        await this.refreshDashboardViews();
        const discoverView = await this.getActiveDiscoverView();
        discoverView?.render();

        this.notify("plugin.settings.dataImported");
        return;
      }

      const {
        feeds: _feeds,
        folders: _folders,
        availableTags: _availableTags,
        ...settingsOnly
      } = parsed as Partial<RssDashboardSettings> & {
        feeds?: unknown;
        folders?: unknown;
        availableTags?: unknown;
      };
      void _feeds;
      void _folders;
      void _availableTags;

      this.settings = Object.assign(
        {},
        DEFAULT_SETTINGS,
        this.settings,
        settingsOnly,
      );

      // Keep legacy keys and nested defaults normalized after import.
      this.migrateLegacySettings();

      this.initializeSettingsBackedServices();
      await this.saveSettings();
      await this.refreshDashboardViews();
      const discoverView = await this.getActiveDiscoverView();
      discoverView?.render();

      this.notify("plugin.settings.preferencesImported");
    } catch (error) {
      console.error("[RSS Dashboard] usersettings.json import failed:", error);
      this.notify("plugin.settings.preferencesInvalid");
    }
  }

  // ✅ ImportExportService extracted — delegates to service
  public getUserSettingsJson(): string {
    return this.importExportService.getUserSettingsJson();
  }

  public getPortableDataBundle() {
    return this.feedStorageRepository.buildPortableDataBundle(this.settings);
  }

  private async applyPortableDataBundleImport(bundle: unknown): Promise<void> {
    storageLog("Plugin portable bundle import requested", {
      currentMode: this.settings.storageMode,
      folder: this.settings.storageFolder,
      feedCount: this.settings.feeds.length,
    });

    try {
      await this.feedStorageRepository.importPortableDataBundle(
        bundle,
        this.settings,
        (data) => this.saveData(data),
      );
      this.migrateLegacySettings();
      this.initializeSettingsBackedServices();

      if (this.settingTab) {
        this.settingTab.display();
      }

      await this.refreshDashboardViews();
      const discoverView = await this.getActiveDiscoverView();
      discoverView?.render();

      storageLog("Plugin portable bundle import completed", {
        currentMode: this.settings.storageMode,
        folder: this.settings.storageFolder,
        feedCount: this.settings.feeds.length,
      });
    } catch (error) {
      storageError("Plugin portable bundle import failed", error, {
        currentMode: this.settings.storageMode,
        folder: this.settings.storageFolder,
      });
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  public async exportUserSettingsJson(): Promise<void> {
    return this.importExportService.exportUserSettingsJson();
  }

  public async exportDataJson(): Promise<void> {
    return this.importExportService.exportDataJson();
  }

  public async exportPortableDataBundle(): Promise<void> {
    return this.importExportService.exportPortableDataBundle();
  }

  public async importPortableDataBundleFromFile(file: File): Promise<void> {
    return this.importExportService.importPortableDataBundleFromFile(file);
  }

  exportOpml(): void {
    void this.importExportService.exportOpml();
  }

  public async copyDataJsonToClipboard(): Promise<void> {
    return this.importExportService.copyDataJsonToClipboard();
  }

  public async copyUserSettingsJsonToClipboard(): Promise<void> {
    return this.importExportService.copyUserSettingsJsonToClipboard();
  }

  public async copyOpmlToClipboard(): Promise<void> {
    return this.importExportService.copyOpmlToClipboard();
  }

  public getStorageStatus(): FeedStorageStatus {
    return this.feedStorageRepository.getStatus(this.settings);
  }

  public getFeedLocalStorageAddress(feed: Feed): FeedLocalStorageAddress {
    const resolved = this.feedStorageRepository.getFeedLocalStorageAddress(
      this.settings,
      feed,
    );

    if (resolved.mode !== "legacy-json") {
      return resolved;
    }

    const metadataFolder =
      getMetadataPath(this.settings) ?? this.manifest.dir ?? "";
    const metadataFolderTrimmed = metadataFolder.replace(/[\\/]+$/g, "");
    const relativeDataPath = metadataFolderTrimmed
      ? `${metadataFolderTrimmed}/data.json`
      : "data.json";

    return {
      ...resolved,
      address:
        this.resolveVaultRelativePathToOsPath(relativeDataPath) ??
        relativeDataPath,
    };
  }

  private resolveVaultRelativePathToOsPath(
    vaultRelativePath: string,
  ): string | null {
    const targetPath = vaultRelativePath.trim();
    if (!targetPath) {
      return null;
    }

    const adapter = this.app.vault.adapter as VaultAdapterPathAccess;

    if (typeof adapter.getFullPath === "function") {
      const resolved = adapter.getFullPath(targetPath);
      if (typeof resolved === "string" && resolved.trim().length > 0) {
        return resolved;
      }
    }

    const requireFn = getRequireFunction();
    const pathModule = requireFn?.("path");
    const basePath =
      typeof adapter.getBasePath === "function" ? adapter.getBasePath() : "";

    if (
      !basePath ||
      typeof basePath !== "string" ||
      !isPathModuleLike(pathModule)
    ) {
      return null;
    }

    return pathModule.join(basePath, targetPath);
  }

  public async migrateToVaultStorage(): Promise<void> {
    storageLog("Plugin migration requested", {
      currentMode: this.settings.storageMode,
      folder: this.settings.storageFolder,
      feedCount: this.settings.feeds.length,
    });

    try {
      await this.feedStorageRepository.migrateToVaultShards(
        this.settings,
        (data) => this.saveData(data),
      );
      this.initializeSettingsBackedServices();
      await this.refreshDashboardViews();
      if (this.settingTab) {
        this.settingTab.display();
      }
      storageLog("Plugin migration completed", {
        currentMode: this.settings.storageMode,
      });
    } catch (error) {
      storageError("Plugin migration failed", error, {
        currentMode: this.settings.storageMode,
        folder: this.settings.storageFolder,
      });
      throw error;
    }
  }

  public async migrateToVaultShardsV2(): Promise<void> {
    storageLog("Plugin migration v2 requested", {
      currentMode: this.settings.storageMode,
      folder: this.settings.storageFolder,
      feedCount: this.settings.feeds.length,
    });

    try {
      await this.feedStorageRepository.migrateToVaultShardsV2(
        this.settings,
        this.getMetadataSaveCallback(),
      );
      this.initializeSettingsBackedServices();
      await this.refreshDashboardViews();
      if (this.settingTab) {
        this.settingTab.display();
      }
      storageLog("Plugin migration v2 completed", {
        currentMode: this.settings.storageMode,
      });
    } catch (error) {
      storageError("Plugin migration v2 failed", error, {
        currentMode: this.settings.storageMode,
        folder: this.settings.storageFolder,
      });
      throw error;
    }
  }

  public async backupAndMigrateStorageToV2(): Promise<void> {
    storageLog("Running backup before migrating to vault-shards-v2");
    try {
      await this.backupService.performAutoBackups();
    } catch (e) {
      storageError("Backup failed before migration", e);
      this.notify("plugin.storage.backupFailedProceeding");
    }

    this.settings.storageMigrationDismissedPermanently = true;
    await this.migrateToVaultShardsV2();
  }

  public async repairVaultShards(): Promise<void> {
    storageLog("Plugin repair requested", {
      currentMode: this.settings.storageMode,
      folder: this.settings.storageFolder,
      feedCount: this.settings.feeds.length,
    });

    try {
      await this.feedStorageRepository.repairVaultShards(
        this.settings,
        (data) => this.saveData(data),
      );
      if (this.settingTab) {
        this.settingTab.display();
      }
      storageLog("Plugin repair completed");
    } catch (error) {
      storageError("Plugin repair failed", error, {
        currentMode: this.settings.storageMode,
        folder: this.settings.storageFolder,
      });
      throw error;
    }
  }

  /** Alias required by StorageSettingsPlugin interface. Delegates to repairVaultShards(). */
  public async repairVaultStorage(): Promise<void> {
    return this.repairVaultShards();
  }

  public async revertToLegacyJsonStorage(): Promise<void> {
    return this.revertToLegacyJsonStorageWithOptions();
  }

  public async revertToLegacyJsonStorageWithOptions(options?: {
    deleteShardFolder?: boolean;
  }): Promise<void> {
    storageLog("Plugin revert requested", {
      currentMode: this.settings.storageMode,
      folder: this.settings.storageFolder,
      feedCount: this.settings.feeds.length,
      deleteShardFolder: Boolean(options?.deleteShardFolder),
    });

    try {
      await this.feedStorageRepository.revertToLegacyJson(
        this.settings,
        (data) => this.saveData(data),
        options,
      );
      this.initializeSettingsBackedServices();
      await this.refreshDashboardViews();
      if (this.settingTab) {
        this.settingTab.display();
      }
      storageLog("Plugin revert completed", {
        currentMode: this.settings.storageMode,
      });
    } catch (error) {
      storageError("Plugin revert failed", error, {
        currentMode: this.settings.storageMode,
        folder: this.settings.storageFolder,
      });
      throw error;
    }
  }

  // ✅ ImportExportService extracted — all 875 tests passing

  // ✅ FolderService extracted — delegates to service
  public isShardFolderDeletionError(
    error: unknown,
  ): error is ShardFolderDeletionError {
    return error instanceof ShardFolderDeletionError;
  }

  public async openStorageFolderInSystem(folderPath?: string): Promise<void> {
    const targetFolder = (folderPath ?? this.settings.storageFolder).trim();
    if (!targetFolder) {
      throw new Error("Storage folder path is empty.");
    }

    try {
      const requireFn = getRequireFunction();
      const shell =
        getShellFromModule(requireFn?.("@electron/remote")) ??
        getShellFromModule(requireFn?.("electron"));
      const pathModule = requireFn?.("path");
      const adapter = this.app.vault.adapter as VaultAdapterPathAccess;
      const basePath =
        typeof adapter.getBasePath === "function"
          ? adapter.getBasePath()
          : typeof adapter.getFullPath === "function"
            ? adapter.getFullPath(".")
            : "";

      if (!shell || !isPathModuleLike(pathModule) || !basePath) {
        throw new Error("Open folder is only available on desktop vaults.");
      }

      const fullPath = pathModule.join(basePath, targetFolder);
      const openResult = await shell.openPath(fullPath);
      if (typeof openResult === "string" && openResult.trim().length > 0) {
        throw new Error(openResult);
      }
    } catch (error) {
      throw error instanceof Error
        ? error
        : new Error("Failed to open shard folder.");
    }
  }

  private folderPathExists(folderPath: string): boolean {
    return this.folderService.folderPathExists(folderPath);
  }

  private async repairMissingFolderPathsForFeeds(): Promise<void> {
    if (!this.folderService) return; // guard: service not yet initialized during first loadSettings()
    // ✅ FolderService extracted — delegates to service
    await this.folderService.repairMissingFolderPathsForFeeds({
      onSaveSettings: () => this.saveSettings(),
    });
  }

  /**
   * Ensures a folder path exists in the settings hierarchy
   * Handles nested paths like "News/Tech"
   */
  async ensureFolderExists(
    folderPath: string,
    options?: { saveSettings?: boolean; refreshView?: boolean },
  ): Promise<boolean> {
    // ✅ FolderService extracted — delegates to service
    return this.folderService.ensureFolderExists(folderPath, {
      saveSettings: options?.saveSettings,
      refreshView: options?.refreshView,
      onSaveSettings: () => this.saveSettings(),
      onRefreshView: async () => {
        const view = await this.getActiveDashboardView();
        if (view) {
          void view.refresh();
        }
      },
    });
  }

  // ✅ FolderService extracted — all 865 tests passing

  async addFeed(
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
    options?: { showNotice?: boolean },
  ) {
    const showNotice = options?.showNotice !== false;
    try {
      if (this.settings.feeds.some((f) => f.url === url)) {
        if (showNotice) {
          this.notify("plugin.feedDuplicate");
        }
        return false;
      }

      let mediaType: "article" | "video" | "podcast" = "article";
      if (folder === this.settings.media.defaultYouTubeFolder) {
        mediaType = "video";
      } else if (folder === this.settings.media.defaultPodcastFolder) {
        mediaType = "podcast";
      }

      const newFeed: Feed = {
        title,
        url,
        folder,
        items: [],
        lastUpdated: Date.now(),
        autoDeleteDuration:
          typeof autoDeleteDuration === "number"
            ? autoDeleteDuration
            : this.settings.defaultAutoDeleteDuration,
        maxItemsLimit:
          typeof maxItemsLimit === "number"
            ? maxItemsLimit
            : this.settings.maxItems,
        scanInterval: typeof scanInterval === "number" ? scanInterval : 0,
        excludeFromRefresh: excludeFromRefresh === true,
        mediaType: mediaType,
        customTemplate: customTemplate || undefined,
        customTags:
          Array.isArray(customTags) && customTags.length > 0
            ? [...customTags]
            : undefined,
        keywordRules: feedKeywordRules || {
          overrideGlobalRules: false,
          includeLogic: "AND",
          rules: [],
        },
      };

      // Try to parse the feed BEFORE adding it to settings
      try {
        const parsedFeed = await this.feedParser.parseFeed(url, newFeed, {
          allowEmpty: true,
        });
        const feedToStore: Feed = {
          ...newFeed,
          ...parsedFeed,
          autoDeleteDuration:
            typeof parsedFeed.autoDeleteDuration === "number"
              ? parsedFeed.autoDeleteDuration
              : newFeed.autoDeleteDuration,
          maxItemsLimit:
            typeof parsedFeed.maxItemsLimit === "number"
              ? parsedFeed.maxItemsLimit
              : newFeed.maxItemsLimit,
          scanInterval:
            typeof parsedFeed.scanInterval === "number"
              ? parsedFeed.scanInterval
              : newFeed.scanInterval,
          excludeFromRefresh:
            parsedFeed.excludeFromRefresh ?? newFeed.excludeFromRefresh,
          customTemplate: parsedFeed.customTemplate ?? newFeed.customTemplate,
          customTags: parsedFeed.customTags ?? newFeed.customTags,
          keywordRules: parsedFeed.keywordRules ?? newFeed.keywordRules,
        };
        if (feedToStore.folder) {
          await this.ensureFolderExists(feedToStore.folder, {
            saveSettings: false,
            refreshView: false,
          });
        }

        // Re-apply tags after ensureFolderExists so folder auto-tags resolve
        // against the current folder tree (parseFeed also tags, but may run
        // before missing folder paths are created).
        const feedWithTags = MediaService.applyMediaTags(
          feedToStore,
          this.settings.availableTags,
          this.settings.media,
          this.settings.folders,
        );

        // Only add to settings if parsing succeeded
        this.settings.feeds.push(feedWithTags);
        await this.saveSettings();

        const view = await this.getActiveDashboardView();
        if (view) {
          void view.refresh();
        }
        if (showNotice) {
          this.notify("plugin.feedAdded", { feed: title });
        }
        return true;
      } catch (error) {
        if (showNotice) {
          console.error("[RSS Dashboard] Feed parse failed:", error);
          this.notify("plugin.feedAddFailed");
        }
        return false;
      }
    } catch (error) {
      if (showNotice) {
        console.error("[RSS Dashboard] Feed add failed:", error);
        this.notify("plugin.feedAddFailed");
      }
      return false;
    }
  }

  async addYouTubeFeed(input: string, customTitle?: string) {
    try {
      const feedUrl = await MediaService.getYouTubeRssFeed(
        input,
        this.settings.locale,
      );

      if (!feedUrl) {
        this.notify("plugin.youtube.unresolved");
        return;
      }

      if (this.settings.feeds.some((f) => f.url === feedUrl)) {
        this.notify("plugin.youtube.duplicate");
        return;
      }

      const title = customTitle || `YouTube: ${input}`;
      await this.addFeed(
        title,
        feedUrl,
        this.settings.media.defaultYouTubeFolder,
      );
    } catch {
      this.notify("plugin.youtube.addFailed");
    }
  }

  async addSubfolder(parentFolderName: string, subfolderName: string) {
    const parentFolder = this.settings.folders.find(
      (f) => f.name === parentFolderName,
    );

    if (parentFolder) {
      if (!parentFolder.subfolders.some((sf) => sf.name === subfolderName)) {
        parentFolder.subfolders.push({
          name: subfolderName,
          subfolders: [],
        });

        await this.saveSettings();

        const view = await this.getActiveDashboardView();
        if (view) {
          void view.refresh();
          this.notify("plugin.folder.created", {
            folder: subfolderName,
            parent: parentFolderName,
          });
        }
      } else {
        this.notify("plugin.folder.exists", {
          folder: subfolderName,
          parent: parentFolderName,
        });
      }
    }
  }

  async editFeed(
    feed: Feed,
    newTitle: string,
    newUrl: string,
    newFolder: string,
  ) {
    if (newFolder) {
      await this.ensureFolderExists(newFolder, {
        saveSettings: false,
        refreshView: false,
      });
    }

    const oldTitle = feed.title;
    feed.title = newTitle;
    feed.url = newUrl;
    feed.folder = newFolder;

    // Update feedTitle for all articles in this feed when the title changes
    if (oldTitle !== newTitle) {
      for (const item of feed.items) {
        item.feedTitle = newTitle;
      }
    }

    await this.saveSettings();

    const view = await this.getActiveDashboardView();
    if (view) {
      void view.refresh();
      this.notify("plugin.feedUpdated", { feed: newTitle });
    }
  }

  async loadSettings() {
    try {
      storageLog("Loading plugin settings");

      // Step 1: load bootstrap pointer from plugin-default location
      let data = (await this.loadData()) as RssDashboardSettings | null;

      // Step 2: if pointer indicates vault-location mode, load full
      // settings from the vault path stored in the pointer
      if (data?.metadataStorageMode === "vault-location") {
        const vaultData = await loadMetadata(
          this.app,
          "vault-location",
          data.metadataStorageFolder,
        );
        if (vaultData) {
          data = vaultData;
          storageLog("Metadata loaded from vault location", {
            folder: data.metadataStorageFolder,
          });
        }
      }

      // Track whether we bootstrapped from null (possible pending sync)
      const wasNullLoad = data === null;

      const mergedSettings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
      const originalSettingsJson = JSON.stringify(mergedSettings);

      this.settings = loadAndNormalizeSettings(data);
      const didMigrateKeywordRules = this.migrateLegacySettings();
      await this.repairMissingFolderPathsForFeeds();
      const hydrated = await this.feedStorageRepository.hydrateSettings(
        this.settings,
      );
      storageLog("Settings hydrated", {
        mode: this.settings.storageMode,
        folder: this.settings.storageFolder,
        feedCount: this.settings.feeds.length,
        hydratedShardCount: hydrated.shardCount,
      });

      const didNormalizeAndDedupeItems = dedupeAndNormalizeFeedItems(
        this.settings.feeds,
      );

      // Guard: skip the early write if we loaded from null defaults.
      // A null load on a synced vault likely means sync hasn't delivered
      // data.json yet — writing empty defaults here would clobber it.
      // The vault modify listener in onload() will trigger loadSettings()
      // again once sync delivers the real data.
      // Similarly, skip if we are in v2 mode and user-state.json is missing.
      const isV2 = this.settings.storageMode === "vault-shards-v2";
      const isMissingUserState = isV2 && hydrated.userStateLoaded === false;

      const shouldSave =
        !wasNullLoad &&
        !isMissingUserState &&
        (didMigrateKeywordRules ||
          hydrated.didChange ||
          didNormalizeAndDedupeItems ||
          JSON.stringify(this.settings) !== originalSettingsJson);

      await this.replayStatusRepairJournalIfNeeded();

      if (shouldSave) {
        await this.saveSettings();
      }
    } catch (error) {
      storageError("Error loading plugin settings", error);
      this.notify("plugin.settings.loadFailed");
      this.settings = DEFAULT_SETTINGS;
    }
  }

  private async reconcileExistingStatusJournalBeforeMutation(): Promise<boolean> {
    const adapter = this.app.vault.adapter;
    if (
      !(await adapter.exists(STATUS_REPAIR_JOURNAL_PATH)) &&
      !(await adapter.exists(`${STATUS_REPAIR_JOURNAL_PATH}.tmp`))
    ) return true;
    if (!(await this.replayStatusRepairJournalIfNeeded())) return false;
    return (
      !(await adapter.exists(STATUS_REPAIR_JOURNAL_PATH)) &&
      !(await adapter.exists(`${STATUS_REPAIR_JOURNAL_PATH}.tmp`))
    );
  }

  private async readRecoverableStatusJournal(): Promise<StatusRepairJournal | null> {
    const adapter = this.app.vault.adapter;
    const read = async (path: string): Promise<StatusRepairJournal | null> => {
      if (!(await adapter.exists(path))) return null;
      try {
        return parseStatusRepairJournal(JSON.parse(await adapter.read(path)));
      } catch {
        return null;
      }
    };
    const temporaryPath = `${STATUS_REPAIR_JOURNAL_PATH}.tmp`;
    const canonical = await read(STATUS_REPAIR_JOURNAL_PATH);
    const temporary = await read(temporaryPath);
    if (canonical && temporary) {
      if (
        canonical.txId !== temporary.txId ||
        getStatusJournalImmutablePayload(canonical) !==
          getStatusJournalImmutablePayload(temporary)
      ) {
        return null;
      }
      const phaseOrder: Record<StatusJournalPhase, number> = {
        prepared: 0,
        "collection-written": 1,
        "feed-write-uncertain": 2,
        "feed-written": 3,
      };
      return phaseOrder[temporary.phase] > phaseOrder[canonical.phase]
        ? temporary
        : canonical;
    }
    if (canonical) return canonical;
    if (!temporary) return null;
    const contents = await adapter.read(temporaryPath);
    await adapter.write(STATUS_REPAIR_JOURNAL_PATH, contents);
    const promoted = await read(STATUS_REPAIR_JOURNAL_PATH);
    return promoted?.txId === temporary.txId && promoted.phase === temporary.phase
      ? promoted
      : null;
  }

  private resolveStatusJournalItem(entry: StatusJournalItem): FeedItem | null {
    const matches: FeedItem[] = [];
    for (const feed of this.settings.feeds) {
      if (!feed.feedId ||
        createSourceLocator(feed.feedId) !== entry.sourceLocator) continue;
      for (const item of feed.items) {
        try {
          if (resolveFeedItemStableId(item) === entry.stableId) matches.push(item);
        } catch {
          // An unrelated malformed item cannot satisfy the stable locator.
        }
      }
    }
    return matches.length === 1 ? matches[0] : null;
  }

  private async replayStatusRepairJournalIfNeeded(): Promise<boolean> {
    try {
      const adapter = this.app.vault.adapter;
      if (
        !(await adapter.exists(STATUS_REPAIR_JOURNAL_PATH)) &&
        !(await adapter.exists(`${STATUS_REPAIR_JOURNAL_PATH}.tmp`))
      ) return true;
      const journal = await this.readRecoverableStatusJournal();
      if (!journal) throw new Error("invalid status repair journal");
      const repository = new CollectionRepository(
        this.app.vault,
        this.settings.collection.dataFolder.trim(),
        () => new Date(),
      );
      const resolved: Array<{ entry: StatusJournalItem; item: FeedItem }> = [];
      for (const entry of journal.items) {
        const item = this.resolveStatusJournalItem(entry);
        if (!item) {
          this.notify("plugin.state.articleRepairRequired");
          return false;
        }
        if (entry.previousCollection) {
          const existing = await repository.findById(entry.stableId);
          if (!existing) {
            this.notify("plugin.state.articleRepairRequired");
            return false;
          }
        }
        resolved.push({ entry, item });
      }
      for (const { entry, item } of resolved) {
        restoreSerializedArticleSnapshot(item, entry.previousFeed);
        if (entry.previousCollection) {
          await repository.updateFlags(entry.stableId, entry.previousCollection);
        }
      }
      await this.saveSettings({ forceAllShards: true, forceMetadata: true });
      // Verify after both stores have been restored before deleting the only
      // recovery record. A failed check deliberately leaves it for retry.
      for (const { entry, item } of resolved) {
        for (const previous of entry.previousFeed) {
          const hasValue = Object.prototype.hasOwnProperty.call(item, previous.key);
          if (hasValue !== previous.exists) throw new Error("unverified feed repair");
          if (previous.exists &&
            JSON.stringify((item as unknown as Record<string, unknown>)[previous.key]) !==
              JSON.stringify(previous.value)) {
            throw new Error("unverified feed repair");
          }
        }
        if (entry.previousCollection) {
          const verified = await repository.findById(entry.stableId);
          if (
            !verified ||
            verified.read !== entry.previousCollection.read ||
            verified.starred !== entry.previousCollection.starred ||
            verified.saved !== entry.previousCollection.saved ||
            verified.savedNotePath !== entry.previousCollection.savedNotePath
          ) {
            throw new Error("unverified collection repair");
          }
        }
      }
      await this.clearStatusJournal();
      return true;
    } catch {
      // Keep the journal for an idempotent later retry. Deliberately fixed,
      // content-free feedback prevents a broken record from leaking source data.
      this.notify("plugin.state.articleRepairRequired");
      return false;
    }
  }

  private getVaultFilePath(fileOrPath?: unknown): string {
    if (typeof fileOrPath === "string") return fileOrPath;
    if (isRecord(fileOrPath) && typeof fileOrPath.path === "string") {
      return fileOrPath.path;
    }
    return "";
  }

  private isWatchedMetadataPath(filePath: string): boolean {
    // When running in tests the settings.metadataStorageMode may be
    // "plugin-default" but tests expect the watcher to consider the
    // default vault folder (.rss-dashboard-data). Use the resolved
    // metadataFolder when available, otherwise fall back to the
    // conventional default folder name so tests behave deterministically.
    const metadataFolder = getMetadataPath(this.settings ?? DEFAULT_SETTINGS);
    const folderToCheck = metadataFolder ?? ".rss-dashboard-data";

    const normalizedBase = filePath.replace(/^\/+|\/+$/g, "");
    const normalizedFolder = folderToCheck.replace(/^\/+|\/+$/g, "");

    return (
      normalizedBase === `${normalizedFolder}/data.json` ||
      normalizedBase === `${normalizedFolder}/user-state.json`
    );
  }

  private registerVaultMetadataChangeListeners(): void {
    const vault = this.app.vault as unknown as {
      on?: (event: string, callback: (...args: unknown[]) => void) => EventRef;
    };
    if (typeof vault.on !== "function") return;

    const scheduleReload = (file?: unknown, oldPath?: unknown): void => {
      if (Date.now() < this.suppressWatcherUntil) return;

      const candidatePaths: string[] = [];
      const filePath = this.getVaultFilePath(file);
      if (filePath) {
        candidatePaths.push(filePath);
      }
      if (typeof oldPath === "string") {
        candidatePaths.push(oldPath);
      }

      const watched = candidatePaths.some((candidatePath) =>
        this.isWatchedMetadataPath(candidatePath),
      );

      if (!watched) return;

      if (this.vaultMetadataReloadTimer !== null) {
        window.clearTimeout(this.vaultMetadataReloadTimer);
      }

      this.vaultMetadataReloadTimer = window.setTimeout(() => {
        this.vaultMetadataReloadTimer = null;
        void (async () => {
          await this.loadSettings();
          await this.refreshDashboardViews();
        })();
      }, 1500);
    };

    this.registerEvent(vault.on("modify", (file) => scheduleReload(file)));
    this.registerEvent(vault.on("create", (file) => scheduleReload(file)));
    this.registerEvent(
      vault.on("rename", (file, oldPath) => scheduleReload(file, oldPath)),
    );
  }

  private migrateLegacySettings(): boolean {
    return migrateSettings(this.settings);
  }

  public updatePlaybackProgress(
    feedUrl: string,
    itemGuid: string,
    position: number,
    duration: number,
    flush = false,
    sourceItem?: FeedItem,
  ): void {
    if (!this.settings.media.rememberPlaybackProgress) {
      return;
    }

    let item: FeedItem | undefined;

    const resolveVideoMatch = (
      candidateFeed?: (typeof this.settings.feeds)[number],
    ) => {
      if (!sourceItem || sourceItem.mediaType !== "video") {
        return undefined;
      }

      const feedsToSearch = candidateFeed
        ? [candidateFeed]
        : this.settings.feeds;

      for (const feed of feedsToSearch) {
        const exactRef = feed.items.find((entry) => entry === sourceItem);
        if (exactRef) {
          return exactRef;
        }

        const byVideoId = sourceItem.videoId
          ? feed.items.find((entry) => entry.videoId === sourceItem.videoId)
          : undefined;
        if (byVideoId) {
          return byVideoId;
        }

        if (sourceItem.link) {
          const byLink = feed.items.find(
            (entry) => entry.link === sourceItem.link,
          );
          if (byLink) {
            return byLink;
          }
        }
      }

      return undefined;
    };

    if (feedUrl) {
      const feed = this.settings.feeds.find((f) => f.url === feedUrl);
      item = feed?.items.find((i) => i.guid === itemGuid);
      if (!item) {
        item = resolveVideoMatch(feed);
      }
    }

    if (!item) {
      for (const feed of this.settings.feeds) {
        const match = feed.items.find((i) => i.guid === itemGuid);
        if (match) {
          item = match;
          break;
        }
      }
    }

    if (!item) {
      item = resolveVideoMatch();
    }

    if (!item) return;

    if (!(duration > 0) || position < 0) return;

    item.playbackProgress = { position, duration, lastUpdated: Date.now() };

    if (flush) {
      if (this.progressSaveDebounce !== null) {
        window.clearTimeout(this.progressSaveDebounce);
        this.progressSaveDebounce = null;
      }
      void this.saveSettings();
      return;
    }

    // Throttle progress persistence: schedule one save at a time.
    // A reset-on-every-event debounce can starve saves during active playback.
    if (this.progressSaveDebounce === null) {
      this.progressSaveDebounce = window.setTimeout(() => {
        void this.saveSettings();
        this.progressSaveDebounce = null;
      }, 2000);
    }
  }

  public async clearPlaybackProgress(): Promise<number> {
    if (this.progressSaveDebounce !== null) {
      window.clearTimeout(this.progressSaveDebounce);
      this.progressSaveDebounce = null;
    }

    let clearedCount = 0;
    for (const feed of this.settings.feeds) {
      for (const item of feed.items) {
        if (!item.playbackProgress) {
          continue;
        }

        delete item.playbackProgress;
        clearedCount++;
      }
    }

    const appWithLocalStorage = this.app as unknown as {
      removeLocalStorage?: (key: string) => void;
      saveLocalStorage?: (key: string, value: unknown) => void;
    };
    if (typeof appWithLocalStorage.removeLocalStorage === "function") {
      appWithLocalStorage.removeLocalStorage("rss-podcast-progress");
    } else if (typeof appWithLocalStorage.saveLocalStorage === "function") {
      appWithLocalStorage.saveLocalStorage("rss-podcast-progress", null);
    }

    if (clearedCount > 0) {
      await this.saveSettings();
    }

    return clearedCount;
  }

  private async migrateMediaProgressOnStartup(): Promise<void> {
    if (!this.settings.media.rememberPlaybackProgress) {
      return;
    }

    const appWithLocalStorage = this.app as unknown as LegacyLocalStorageApi;
    if (typeof appWithLocalStorage.loadLocalStorage !== "function") return;

    const legacyProgress = appWithLocalStorage.loadLocalStorage(
      "rss-podcast-progress",
    );
    if (!isRecord(legacyProgress)) return;

    let migratedCount = 0;
    for (const guid in legacyProgress) {
      const data = legacyProgress[guid];
      if (!isLegacyPlaybackProgressEntry(data)) continue;

      for (const feed of this.settings.feeds) {
        const item = feed.items.find((i) => i.guid === guid);
        if (!item) continue;

        item.playbackProgress = {
          position: data.position,
          duration: data.duration,
          lastUpdated: Date.now(),
        };
        migratedCount++;
        break;
      }
    }

    if (migratedCount > 0) {
      storageLog(
        `[RSS Dashboard] Migrated ${migratedCount} media progress items.`,
      );
      await this.saveSettings();
    }

    if (typeof appWithLocalStorage.removeLocalStorage === "function") {
      appWithLocalStorage.removeLocalStorage("rss-podcast-progress");
    }
  }

  /**
   * Creates a save callback that persists metadata to the appropriate location
   * based on the current metadataStorageMode.
   */
  public getMetadataSaveCallback(): (data: unknown) => Promise<void> {
    return async (data: unknown): Promise<void> => {
      const settingsData = data as RssDashboardSettings;
      const metadataPath = getMetadataPath(this.settings);
      if (metadataPath) {
        try {
          await ensureMetadataFolderExists(this.app, this.settings);
          const dataFilePath = `${metadataPath}/data.json`;
          const jsonContent = JSON.stringify(settingsData, null, 2);
          await this.app.vault.adapter.write(dataFilePath, jsonContent);
          storageLog("Metadata saved to vault location", {
            path: dataFilePath,
          });
          // Bootstrap pointer only — just enough for loadSettings to
          // find the vault data.json on restart. Does NOT write full
          // settings to .obsidian, preventing the stale-read bug on mobile.
          await this.saveData({
            metadataStorageMode: this.settings.metadataStorageMode,
            metadataStorageFolder: this.settings.metadataStorageFolder,
            metadataStorageSchemaVersion:
              this.settings.metadataStorageSchemaVersion,
          });
        } catch (error) {
          storageError("Failed to save metadata to vault location", error);
          throw error;
        }
      } else {
        await this.saveData(settingsData);
        storageLog("Metadata saved to plugin default location");
      }
    };
  }

  async saveSettings(options: PersistSettingsOptions = {}) {
    storageLog("saveSettings invoked", {
      mode: this.settings.storageMode,
      folder: this.settings.storageFolder,
      metadataMode: this.settings.metadataStorageMode,
      feedCount: this.settings.feeds.length,
    });

    try {
      const result = await this.feedStorageRepository.persistSettings(
        this.settings,
        this.getMetadataSaveCallback(),
        options,
      );
      storageLog("saveSettings completed", result);
    } catch (error) {
      storageError("saveSettings failed", error, {
        mode: this.settings.storageMode,
        folder: this.settings.storageFolder,
        metadataMode: this.settings.metadataStorageMode,
      });
      throw error;
    }
  }

  /**
   * Migrate metadata from plugin-default location to user-configured vault folder.
   * Steps:
   * 1. Ensure metadata folder exists (idempotent)
   * 2. Write settings to new vault location
   * 3. Update metadataStorageMode to "vault-location"
   * 4. Persist updated settings
   */
  async migrateMetadataToVaultLocation(): Promise<void> {
    if (this.settings.metadataStorageMode === "vault-location") {
      this.notify("plugin.metadata.alreadyVault");
      return;
    }

    try {
      // Resolve the target path using vault-location mode (before updating mode in settings)
      const targetSettingsForPath: RssDashboardSettings = {
        ...this.settings,
        metadataStorageMode: "vault-location",
      };
      const metadataPath = getMetadataPath(targetSettingsForPath);
      if (!metadataPath) {
        throw new Error("Failed to resolve metadata storage path");
      }

      // Ensure the target folder exists
      await ensureMetadataFolderExists(this.app, targetSettingsForPath);

      // Write current settings to vault location as JSON
      const settingsJson = JSON.stringify(this.settings, null, 2);
      const dataFilePath = `${metadataPath}/data.json`;
      await this.app.vault.adapter.write(dataFilePath, settingsJson);

      // Update mode and persist using the dual-mode save callback
      this.settings.metadataStorageMode = "vault-location";
      await this.saveSettings();

      this.notify("plugin.metadata.migrated", { path: metadataPath });
    } catch (error) {
      storageError("Metadata migration failed", error);
      // Revert mode on error (no partial state)
      this.settings.metadataStorageMode = "plugin-default";
      this.notify("plugin.metadata.migrationFailed");
      throw error;
    }
  }

  /**
   * Revert metadata from vault-location back to plugin-default location.
   * Steps:
   * 1. Read settings from current vault location (already in memory)
   * 2. Write back to plugin-default location via Plugin.saveData()
   * 3. Update metadataStorageMode to "plugin-default"
   * 4. Optionally clean up vault-location data.json
   */
  async revertMetadataToPluginDefault(): Promise<void> {
    if (this.settings.metadataStorageMode === "plugin-default") {
      this.notify("plugin.metadata.alreadyDefault");
      return;
    }

    try {
      // Current settings are already in memory, just switch the mode
      this.settings.metadataStorageMode = "plugin-default";

      // Save using Plugin.saveData() (plugin-default location)
      await this.saveData(this.settings);

      // Optionally clean up the vault-location file
      const oldMetadataPath = this.settings.metadataStorageFolder;
      if (oldMetadataPath) {
        try {
          const dataFilePath = `${oldMetadataPath}/data.json`;
          const file = this.app.vault.getAbstractFileByPath(dataFilePath);
          if (file && !(file instanceof TFolder)) {
            await this.app.fileManager.trashFile(file);
            storageLog("Deleted old vault metadata file", {
              path: dataFilePath,
            });
          }
        } catch (cleanupError) {
          storageLog(
            "Cleanup of vault metadata file failed (non-fatal)",
            cleanupError,
          );
        }
      }

      await this.saveSettings();
      this.notify("plugin.metadata.reverted");
    } catch (error) {
      storageError("Metadata revert failed", error);
      // Restore mode on error (no partial state)
      this.settings.metadataStorageMode = "vault-location";
      this.notify("plugin.metadata.revertFailed");
      throw error;
    }
  }

  private isFeedExcludedFromRefresh(feed: Feed): boolean {
    return feed.excludeFromRefresh === true;
  }

  private getRefreshableFeeds(feeds: Feed[]): Feed[] {
    return feeds.filter((feed) => !this.isFeedExcludedFromRefresh(feed));
  }

  private mergeRefreshedFeed(updatedFeed: Feed): void {
    const index = this.settings.feeds.findIndex(
      (f) => f.url === updatedFeed.url,
    );
    if (index >= 0) {
      this.settings.feeds[index] = {
        ...updatedFeed,
        excludeFromRefresh:
          updatedFeed.excludeFromRefresh ??
          this.settings.feeds[index].excludeFromRefresh,
      };
    }
  }

  private async refreshSingleFeed(
    feed: Feed,
    feedNoticeText: string,
  ): Promise<void> {
    const result = await this.refreshFeedPipeline(feed);
    this.mergeRefreshedFeed(result.feed);

    await this.validateSavedArticles({ suppressCollectionBroadcast: true });
    this.settings.lastRefreshTimestamp = Date.now();
    await this.saveSettings();
    await this.refreshDashboardViews();
    this.notify("plugin.refreshed", { source: feedNoticeText });
  }

  private async refreshFeedBatch(
    feedsToRefresh: Feed[],
    feedNoticeText: string,
  ): Promise<void> {
    if (this.isMultiFeedRefreshRunning) {
      this.notify("plugin.multiRefresh");
      return;
    }

    this.isMultiFeedRefreshRunning = true;
    this.activeRefreshState.clear();
    const refreshSummary = {
      failed: 0,
      timedOut: 0,
    };

    for (const feed of feedsToRefresh) {
      this.activeRefreshState.set(feed.url, {
        status: "pending",
        startedAt: Date.now(),
      });
    }

    let nextFeedIndex = 0;
    let lastRenderAt = 0;

    const refreshView = async (force = false): Promise<void> => {
      const now = Date.now();
      if (
        !force &&
        now - lastRenderAt < RssDashboardPlugin.FEED_REFRESH_RENDER_THROTTLE_MS
      ) {
        return;
      }

      const view = await this.getActiveDashboardView();
      if (view) {
        if (typeof view.refreshSidebarOnly === "function") {
          view.refreshSidebarOnly();
        } else {
          view.refresh();
        }
      }
      lastRenderAt = now;
    };

    const backgroundPromises: Promise<void>[] = [];

    const worker = async (): Promise<void> => {
      while (true) {
        await globalFetchSemaphore.acquire();

        const currentFeed = feedsToRefresh[nextFeedIndex];
        nextFeedIndex += 1;
        if (!currentFeed) {
          globalFetchSemaphore.release();
          return;
        }

        const refreshPromise = this.processRefreshBatchFeed(
          currentFeed,
          refreshSummary,
          refreshView,
        ).finally(() => {
          globalFetchSemaphore.release();
        });

        const winner = await Promise.race([
          refreshPromise.then(() => "fetch"),
          this.waitForFeedSoftTimeout().then(() => "timeout"),
        ]);

        if (winner === "timeout") {
          backgroundPromises.push(refreshPromise);
        }
      }
    };

    const workerCount = Math.min(
      MAX_CONCURRENT_FETCHES,
      feedsToRefresh.length,
    );

    try {
      const workers = Array.from({ length: workerCount }, () => worker());
      await refreshView(true);
      await Promise.all(workers);
      await Promise.all(backgroundPromises);

      await this.validateSavedArticles({ suppressCollectionBroadcast: true });
      this.settings.lastRefreshTimestamp = Date.now();
      await this.saveSettings();
      this.activeRefreshState.clear();
      this.isMultiFeedRefreshRunning = false;
      await this.refreshDashboardViews();

      const failureSuffix = this.buildRefreshFailureSummary(refreshSummary);
      this.notify(
        failureSuffix
          ? "plugin.refreshedWithFailures"
          : "plugin.refreshed",
        failureSuffix
          ? { source: feedNoticeText, failures: failureSuffix }
          : { source: feedNoticeText },
      );
    } finally {
      this.activeRefreshState.clear();
      this.isMultiFeedRefreshRunning = false;
    }
  }

  private buildRefreshFailureSummary(summary: {
    failed: number;
    timedOut: number;
  }): string {
    const parts: string[] = [];
    if (summary.timedOut > 0) {
      parts.push(this.t("plugin.refresh.timedOut", { count: summary.timedOut }));
    }
    if (summary.failed > 0) {
      parts.push(this.t("plugin.refresh.failedCount", { count: summary.failed }));
    }

    if (parts.length === 0) {
      return "";
    }

    return parts.join(this.t("plugin.refresh.failureSeparator"));
  }

  private async processRefreshBatchFeed(
    currentFeed: Feed,
    refreshSummary: { failed: number; timedOut: number },
    refreshView: () => Promise<void>,
  ): Promise<void> {
    this.activeRefreshState.set(currentFeed.url, {
      status: "processing",
      startedAt: Date.now(),
    });

    try {
      const result = await this.refreshFeedPipeline(currentFeed);
      this.mergeRefreshedFeed(result.feed);
    } catch (error) {
      const isTimedOut =
        error instanceof FeedRefreshPipelineError && error.code === "timed-out";
      if (isTimedOut) {
        refreshSummary.timedOut += 1;
      } else {
        refreshSummary.failed += 1;
      }

      console.error("[RSS dashboard] A source refresh failed.");
    } finally {
      this.activeRefreshState.delete(currentFeed.url);

      if (this.activeRefreshState.size > 0) {
        await refreshView();
      }
    }
  }

  private async waitForFeedSoftTimeout(): Promise<void> {
    return new Promise((resolve) => {
      window.setTimeout(resolve, FEED_SOFT_TIMEOUT_MS);
    });
  }

  private async refreshFeedPipeline(feed: Feed): Promise<FeedRefreshResult> {
    this.feedStorageRepository.ensureFeedIds(this.settings);
    if (!feed.feedId) {
      feed.feedId = this.settings.feeds.find(
        (candidate) => candidate.url === feed.url,
      )?.feedId;
    }
    bindFeedItemsToSourceIdentity(feed);
    const sourceId = feed.feedId ?? feed.url;
    const attemptedAt = new Date();
    const ledger = this.getSourceRefreshLedger();
    try {
      await ledger.recordAttempt(sourceId, attemptedAt);
    } catch {
      throw new FeedRefreshPipelineError(
        "state-failed",
        "Refresh state is unavailable.",
      );
    }

    const attempt = new RefreshAttemptToken();
    let result: FeedRefreshResult;
    try {
      result = await this.refreshFeedWithTimeout(feed, attempt);
      attempt.assertActive();
    } catch (error) {
      const failure = toFeedRefreshPipelineError(error);
      await this.recordRefreshErrorSafely(
        ledger,
        sourceId,
        attemptedAt,
        failure,
      );
      throw failure;
    }

    if (!this.settings.collection.enabled) {
      try {
        await ledger.recordSuccess(sourceId, result.fetchedAt);
      } catch {
        const failure = new FeedRefreshPipelineError(
          "state-failed",
          "Refresh state is unavailable.",
        );
        await this.recordRefreshErrorSafely(
          ledger,
          sourceId,
          attemptedAt,
          failure,
        );
        throw failure;
      }
      return result;
    }

    try {
      attempt.assertActive();
      await this.getCollectionService().collectFeedRefresh(result);
      attempt.assertActive();
    } catch (error) {
      const failure =
        error instanceof FeedRefreshPipelineError &&
        error.code === "timed-out"
          ? error
          : new FeedRefreshPipelineError(
              "collection-failed",
              "Collection persistence failed.",
            );
      await this.recordRefreshErrorSafely(
        ledger,
        sourceId,
        attemptedAt,
        failure,
      );
      throw failure;
    }
    return result;
  }

  private async recordRefreshErrorSafely(
    ledger: SourceRefreshLedger,
    sourceId: string,
    attemptedAt: Date,
    failure: FeedRefreshPipelineError,
  ): Promise<void> {
    try {
      await ledger.recordError(sourceId, attemptedAt, {
        code: failure.code,
        message: failure.message,
      });
    } catch {
      console.error("[RSS dashboard] Refresh error state could not be saved.");
    }
  }

  private async refreshFeedWithTimeout(
    feed: Feed,
    attempt: RefreshAttemptToken,
  ): Promise<FeedRefreshResult> {
    let timeoutId: number | null = null;
    try {
      return await Promise.race([
        this.refreshFeedDirect(feed, attempt),
        new Promise<FeedRefreshResult>((_, reject) => {
          timeoutId = window.setTimeout(() => {
            attempt.cancel();
            reject(
              new FeedRefreshPipelineError(
                "timed-out",
                "Source refresh timed out.",
              ),
            );
          }, FEED_REQUEST_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    }
  }

  private async refreshFeedDirect(
    feed: Feed,
    attempt: RefreshAttemptToken,
  ): Promise<FeedRefreshResult> {
    const parserInput = cloneRefreshData(feed);
    parserInput.lastFetchError = undefined;
    const previousItems = cloneRefreshData(feed.items);
    bindFeedItemsToSourceIdentity(parserInput);
    bindFeedItemsToSourceIdentity({ ...parserInput, items: previousItems });
    let updatedFeed: Feed;
    if (typeof this.feedParser.refreshFeed === "function") {
      updatedFeed = await this.feedParser.refreshFeed(parserInput);
    } else {
      const updatedFeeds = await this.feedParser.refreshAllFeeds([parserInput]);
      updatedFeed = updatedFeeds[0] ?? parserInput;
    }
    updatedFeed.feedId ??= parserInput.feedId;
    bindFeedItemsToSourceIdentity(updatedFeed);
    attempt.assertActive();
    if (updatedFeed.lastFetchError) {
      throw isTimeoutFeedError(updatedFeed.lastFetchError)
        ? new FeedRefreshPipelineError(
            "timed-out",
            "Source refresh timed out.",
          )
        : new FeedRefreshPipelineError(
            "refresh-failed",
            "Source refresh failed.",
          );
    }
    return {
      feed: updatedFeed,
      previousItems,
      refreshedItems: updatedFeed.items,
      fetchedAt: new Date(),
    };
  }

  public async performAutoBackups(): Promise<void> {
    // ✅ BackupService extracted — delegates to service
    await this.backupService.performAutoBackups();
  }

  onunload() {
    if (this.progressSaveDebounce !== null) {
      window.clearTimeout(this.progressSaveDebounce);
      this.progressSaveDebounce = null;
      void this.saveSettings();
    }

    if (this.vaultMetadataReloadTimer !== null) {
      window.clearTimeout(this.vaultMetadataReloadTimer);
      this.vaultMetadataReloadTimer = null;
    }

    this.cancelPendingStartupRefresh();

    // Run backups asynchronously on plugin disable/unload (best effort)
    void this.backupService.performAutoBackups();
  }

  public cancelPendingStartupRefresh(): void {
    this.automaticRefreshGeneration += 1;
    if (this.startupRefreshTimeoutId !== null) {
      window.clearTimeout(this.startupRefreshTimeoutId);
      this.startupRefreshTimeoutId = null;
    }
  }

  private async validateSavedArticles(options?: {
    suppressCollectionBroadcast?: boolean;
  }): Promise<boolean> {
    let collectionChanged = false;

    for (const feed of this.settings.feeds) {
      for (const item of feed.items) {
        if (item.saved) {
          const fileExists = await this.articleSaver.checkSavedFileExists(item);
          if (!fileExists) {
            const outcome = await this.updateArticleWithOutcome(
              item.guid,
              feed.url,
              {
                saved: false,
                savedFilePath: undefined,
                tags: item.tags?.filter(
                  (tag) => tag.name.toLowerCase() !== "saved",
                ),
              },
              false,
              { suppressCollectionBroadcast: true },
            );
            if (outcome === "collection") collectionChanged = true;
          }
        }
      }
    }

    if (collectionChanged && !options?.suppressCollectionBroadcast) {
      this.emitCollectionFlagsUpdated();
    }
    return collectionChanged;
  }

  private getAllArticles(): FeedItem[] {
    let allArticles: FeedItem[] = [];
    for (const feed of this.settings.feeds) {
      allArticles = allArticles.concat(feed.items);
    }
    return allArticles;
  }
}
