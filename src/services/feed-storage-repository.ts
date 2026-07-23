import {
  App,
  Notice,
  TFile,
  TFolder,
  normalizePath,
  type TAbstractFile,
} from "obsidian";
import type {
  Feed,
  FeedItemsShard,
  PortableDataBundle,
  PersistedFeedConfig,
  PersistedRssDashboardSettings,
  RssDashboardSettings,
  ArticleUserState,
  UserStateFile,
} from "../types/types";
import { bindFeedItemsToSourceIdentity } from "../collection/item-identity";
import { createTranslator } from "../i18n";
import {
  assertControlledRelativePath,
  VaultPathIdentityProvider,
  type ControlledDirectoryCreation,
  type ControlledPathIdentity,
  type PathIdentityProvider,
} from "../security/path-identity-provider";
import { migrateSettings } from "../utils/settings-loader";

const SHARD_VERSION = 1;

export interface FeedStorageStatus {
  mode: RssDashboardSettings["storageMode"];
  folder: string;
  shardCount: number;
  feedCount: number;
  migrationReady: boolean;
  lastRepairResult: string;
}

export interface FeedLocalStorageAddress {
  mode: RssDashboardSettings["storageMode"];
  address: string;
}

export interface PersistSettingsOptions {
  forceMetadata?: boolean;
  forceAllShards?: boolean;
}

export interface SettingsMetadataWrite {
  readonly path: string;
  readonly contents: string;
}

export interface SettingsMetadataWritePlan {
  readonly writes: readonly SettingsMetadataWrite[];
}

export interface SettingsMetadataTargets {
  readonly pluginDataPath: string;
  readonly vaultDataPath?: string;
}

export class FeedStorageRollbackIncompleteError extends Error {
  constructor() {
    super("Feed storage rollback incomplete");
    this.name = "FeedStorageRollbackIncompleteError";
  }
}

export class FeedStorageCandidateVerificationError extends Error {
  constructor() {
    super("Feed storage candidate postimage verification failed");
    this.name = "FeedStorageCandidateVerificationError";
  }
}

interface SettingsPersistenceFileSnapshot {
  path: string;
  contents: string | null;
  identity: ControlledPathIdentity;
}

interface SettingsPersistenceDirectorySnapshot {
  path: string;
  existed: boolean;
  identity: ControlledPathIdentity;
}

interface SettingsPersistenceTransactionSnapshot {
  files: SettingsPersistenceFileSnapshot[];
  directories: SettingsPersistenceDirectorySnapshot[];
  lastPersistedMetadataJson: string | null;
  lastPersistedShardJsonByFeedId: Map<string, string>;
  lastStorageFolderPath: string | null;
}

interface SettingsPersistenceFileOperation {
  operation: "write" | "delete";
  intendedBytes: string | null;
  actualPostBytes?: string | null;
  creationIdentity?: ControlledPathIdentity;
  postIdentity?: ControlledPathIdentity;
  restoredIdentity?: ControlledPathIdentity;
}

interface ActiveSettingsPersistenceTransaction {
  snapshot: SettingsPersistenceTransactionSnapshot;
  fileOperations: Map<string, SettingsPersistenceFileOperation>;
  createdDirectories: Map<string, ControlledDirectoryCreation>;
  ownershipNonce: string;
}

const MAX_SETTINGS_TRANSACTION_PATHS = 40_000;
const MAX_SETTINGS_TRANSACTION_DEPTH = 32;
const MAX_SETTINGS_TRANSACTION_SNAPSHOT_BYTES = 100_000_000;
const MAX_SETTINGS_TRANSACTION_PATH_LENGTH = 1_024;

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

let syncNonceCounter = 0;

function withSyncNonce<T extends object>(
  data: T,
): T & { _syncNonce: string; _syncPad: string } {
  syncNonceCounter++;
  const paddingSize = 1024 + (syncNonceCounter % 1024);
  return {
    ...data,
    _syncNonce: `${Date.now()}-${syncNonceCounter}`,
    _syncPad: "sync-size-anchor "
      .repeat(Math.ceil(paddingSize / 18))
      .slice(0, paddingSize),
  };
}

function createFeedId(): string {
  const randomUuid = window.crypto?.randomUUID?.();
  if (randomUuid) {
    return randomUuid;
  }

  return `feed-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function createOwnershipNonce(): string {
  const randomUuid = window.crypto?.randomUUID?.();
  if (randomUuid) return randomUuid;
  syncNonceCounter += 1;
  return `${Date.now()}-${syncNonceCounter}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

function normalizeFolderPath(path: string): string {
  const trimmed = path.trim().replace(/\\/g, "/");
  if (!trimmed) {
    return ".rss-dashboard-data/feeds";
  }

  return normalizePath(trimmed.replace(/^\/+|\/+$/g, ""));
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint !== undefined &&
      (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159))
    );
  });
}

function getFeedShardPath(storageFolder: string, feedId: string): string {
  return normalizePath(`${normalizeFolderPath(storageFolder)}/${feedId}.json`);
}

function createFeedShard(feed: Feed, stripState = false): FeedItemsShard {
  return {
    version: SHARD_VERSION,
    feedId: feed.feedId ?? "",
    feedUrl: feed.url,
    updatedAt: Date.now(),
    items: cloneJson(feed.items ?? []).map(item => {
      if (stripState) {
        delete item.read;
        delete item.starred;
        delete item.tags;
        delete item.saved;
        delete item.savedFilePath;
        delete item.playbackProgress;
      }
      return item;
    }),
  };
}

function createComparableFeedShardJson(feed: Feed, stripState = false): string {
  const { updatedAt: _updatedAt, ...shardWithoutTimestamp } =
    createFeedShard(feed, stripState);
  void _updatedAt;
  return JSON.stringify(shardWithoutTimestamp, null, 2);
}

function storageLog(_message: string, _details?: unknown): void {}

function storageError(
  _message: string,
  _error: unknown,
  _details?: unknown,
): void {}

function parsePortableDataBundle(input: unknown): PortableDataBundle {
  if (!input || typeof input !== "object") {
    throw new Error("Portable bundle must be a JSON object");
  }

  const bundle = input as Partial<PortableDataBundle>;
  if (bundle.version !== SHARD_VERSION) {
    throw new Error(
      `Unsupported portable bundle version: ${String(bundle.version)} (expected ${SHARD_VERSION})`,
    );
  }

  if (typeof bundle.exportedAt !== "number") {
    throw new Error("Portable bundle is missing a valid exportedAt timestamp");
  }

  if (
    bundle.storageMode !== "legacy-json" &&
    bundle.storageMode !== "vault-shards"
  ) {
    throw new Error("Portable bundle has an invalid storageMode value");
  }

  if (!bundle.metadata || typeof bundle.metadata !== "object") {
    throw new Error("Portable bundle is missing metadata");
  }

  if (!Array.isArray(bundle.shards)) {
    throw new Error("Portable bundle is missing shards");
  }

  for (const shard of bundle.shards) {
    if (!shard || typeof shard !== "object") {
      throw new Error("Portable bundle has an invalid shard entry");
    }

    const shardLike = shard as Partial<FeedItemsShard>;
    if (typeof shardLike.feedId !== "string" || !shardLike.feedId.trim()) {
      throw new Error("Portable bundle shard is missing feedId");
    }

    if (!Array.isArray(shardLike.items)) {
      throw new Error(
        `Portable bundle shard ${shardLike.feedId} is missing items`,
      );
    }
  }

  return bundle as PortableDataBundle;
}

export class FeedStorageRepository {
  private lastPersistedMetadataJson: string | null = null;
  private lastPersistedShardJsonByFeedId = new Map<string, string>();
  private lastStorageFolderPath: string | null = null;
  private lastRepairResult = "Not yet run";
  private writeWrapper?: <T>(fn: () => Promise<T>) => Promise<T>;
  private readonly pathIdentityProvider: PathIdentityProvider;
  private app: App;
  private settingsPersistenceQueue: Promise<void> = Promise.resolve();
  private pendingMarkerCleanup: ControlledDirectoryCreation[] = [];
  private markerCleanupWarnings: string[] = [];
  private activeSettingsPersistenceTransaction:
    | ActiveSettingsPersistenceTransaction
    | undefined;

  constructor(app: App, options?: {
    writeWrapper?: <T>(fn: () => Promise<T>) => Promise<T>;
    pathIdentityProvider?: PathIdentityProvider;
  }) {
    this.app = app;
    this.writeWrapper = options?.writeWrapper;
    this.pathIdentityProvider =
      options?.pathIdentityProvider ?? new VaultPathIdentityProvider(app);
  }

  public buildSettingsMetadataWritePlan(
    settings: RssDashboardSettings,
    targets: SettingsMetadataTargets,
  ): SettingsMetadataWritePlan {
    this.ensureFeedIds(settings);
    const fullSettings = withSyncNonce(
      cloneJson(this.buildPersistedMetadataSnapshot(settings)),
    );
    const fullContents = JSON.stringify(fullSettings, null, 2);
    if (!targets.vaultDataPath) {
      return {
        writes: [{
          path: assertControlledRelativePath(targets.pluginDataPath),
          contents: fullContents,
        }],
      };
    }
    const pluginDataPath =
      assertControlledRelativePath(targets.pluginDataPath);
    const vaultDataPath =
      assertControlledRelativePath(targets.vaultDataPath);
    if (pluginDataPath === vaultDataPath) {
      throw new FeedStorageRollbackIncompleteError();
    }
    const bootstrap = {
      metadataStorageMode: "vault-location",
      metadataStorageFolder: settings.metadataStorageFolder,
      metadataStorageSchemaVersion: settings.metadataStorageSchemaVersion,
    };
    return {
      writes: [
        { path: vaultDataPath, contents: fullContents },
        {
          path: pluginDataPath,
          contents: JSON.stringify(bootstrap, null, 2),
        },
      ],
    };
  }

  public ensureFeedIds(settings: RssDashboardSettings): boolean {
    let didChange = false;
    let assignedCount = 0;
    for (const feed of settings.feeds) {
      if (!feed.feedId) {
        feed.feedId = createFeedId();
        didChange = true;
        assignedCount += 1;
      }

      feed.items = Array.isArray(feed.items) ? feed.items : [];
      didChange = bindFeedItemsToSourceIdentity(feed) || didChange;
    }

    if (didChange) {
      storageLog("Assigned missing feed IDs", { assignedCount });
    }

    return didChange;
  }

  public getFeedLocalStorageAddress(
    settings: RssDashboardSettings,
    feed: Feed,
  ): FeedLocalStorageAddress {
    const isShardBackedMode =
      settings.storageMode === "vault-shards" ||
      settings.storageMode === "vault-shards-v2";

    if (!isShardBackedMode) {
      return {
        mode: "legacy-json",
        address: "data.json",
      };
    }

    const feedId = (feed.feedId ?? "").trim();
    return {
      mode: settings.storageMode,
      address: feedId ? getFeedShardPath(settings.storageFolder, feedId) : "",
    };
  }

  public async hydrateSettings(
    settings: RssDashboardSettings,
  ): Promise<{ didChange: boolean; shardCount: number; userStateLoaded?: boolean }> {
    storageLog("Hydrating settings", {
      mode: settings.storageMode,
      folder: normalizeFolderPath(settings.storageFolder),
      feedCount: settings.feeds.length,
    });
    const didAssignFeedIds = this.ensureFeedIds(settings);
    let didChange = didAssignFeedIds;
    let shardCount = 0;

    if (settings.storageMode !== "vault-shards" && settings.storageMode !== "vault-shards-v2") {
      storageLog("Skipping shard hydration because legacy JSON mode is active");
      this.capturePersistedState(settings);
      return { didChange, shardCount };
    }

    const feedsById = new Map<string, Feed>();
    for (const feed of settings.feeds) {
      if (feed.feedId) {
        feedsById.set(feed.feedId, feed);
      }
    }

    for (const feed of settings.feeds) {
      const shardPath = getFeedShardPath(
        settings.storageFolder,
        feed.feedId ?? "",
      );
      const shardExists = await this.app.vault.adapter.exists(shardPath);
      if (!shardExists) {
        storageLog("Shard file not found during hydration", {
          feedId: feed.feedId,
          title: feed.title,
          shardPath,
        });
        continue;
      }

      try {
        const raw = await this.app.vault.adapter.read(shardPath);
        const parsed = JSON.parse(raw) as Partial<FeedItemsShard>;
        if (!parsed || !Array.isArray(parsed.items)) {
          throw new Error("Invalid shard data");
        }

        feed.items = parsed.items;
        shardCount += 1;
        storageLog("Hydrated feed from shard", {
          feedId: feed.feedId,
          title: feed.title,
          shardPath,
          itemCount: feed.items.length,
        });
      } catch (error) {
        storageError("Failed to hydrate feed shard", error, {
          feedId: feed.feedId,
          title: feed.title,
          shardPath,
        });
        feed.items = Array.isArray(feed.items) ? feed.items : [];
        new Notice(
          createTranslator(settings.locale)("service.storage.shardReadFailed", {
            feed: feed.title,
            error: error instanceof Error ? error.message : "Unknown error",
          }),
        );
      }
    }

    storageLog("Completed shard hydration", {
      didAssignFeedIds,
      shardCount,
    });
    
    let userStateLoaded = false;
    if (settings.storageMode === "vault-shards-v2") {
      const userState = await this.loadUserState(settings);
      if (userState) {
        userStateLoaded = true;
        for (const feed of settings.feeds) {
          for (const item of feed.items) {
            const state = userState.states[item.guid];
            if (state) {
              item.read = state.read ?? false;
              item.starred = state.starred ?? false;
              item.tags = state.tags ? cloneJson(state.tags) : [];
              item.saved = state.saved ?? false;
              if (state.savedFilePath) item.savedFilePath = state.savedFilePath;
              if (state.playbackProgress) item.playbackProgress = cloneJson(state.playbackProgress);
            } else {
              item.read = false;
              item.starred = false;
              item.tags = [];
              item.saved = false;
              delete item.savedFilePath;
              delete item.playbackProgress;
            }
          }
        }
      } else {
        // Fallback to default if missing
        for (const feed of settings.feeds) {
          for (const item of feed.items) {
            item.read = false;
            item.starred = false;
            item.tags = [];
            item.saved = false;
            delete item.savedFilePath;
            delete item.playbackProgress;
          }
        }
      }
    }

    for (const feed of settings.feeds) {
      didChange = bindFeedItemsToSourceIdentity(feed) || didChange;
    }

    if (!didChange) {
      this.capturePersistedState(settings);
    }
    return { didChange, shardCount, userStateLoaded };
  }

  public async persistSettings(
    settings: RssDashboardSettings,
    metadataPlan: SettingsMetadataWritePlan,
    options: PersistSettingsOptions = {},
  ): Promise<{
    metadataSaved: boolean;
    shardWriteCount: number;
    shardDeleteCount: number;
  }> {
    return this.enqueueSettingsPersistence(async () => {
      this.ensureFeedIds(settings);
      this.assertNoDuplicateFeedIds(settings);
      const snapshot = await this.captureSettingsPersistenceTransaction(
        settings,
        settings,
        metadataPlan,
      );
      return this.runWithSettingsPersistenceJournal(
        snapshot,
        async () => {
          const result = await this.persistSettingsUnlocked(
            settings,
            metadataPlan,
            options,
          );
          const active = this.requireActiveSettingsTransaction();
          await this.verifyCandidateSettingsPersistenceTransaction(
            snapshot,
            active,
          );
          return result;
        },
      );
    });
  }

  public async persistSettingsTransaction<T>(
    previousSettings: RssDashboardSettings,
    candidateSettings: RssDashboardSettings,
    metadataPlan: SettingsMetadataWritePlan,
    afterPersist: () => Promise<T>,
    options: PersistSettingsOptions = {},
  ): Promise<T> {
    return this.enqueueSettingsPersistence(async () => {
      this.assertNoDuplicateFeedIds(previousSettings);
      this.assertNoDuplicateFeedIds(candidateSettings);
      this.ensureFeedIds(candidateSettings);
      const snapshot = await this.captureSettingsPersistenceTransaction(
        previousSettings,
        candidateSettings,
        metadataPlan,
      );
      return this.runWithSettingsPersistenceJournal(snapshot, async () => {
        await this.persistSettingsUnlocked(
          candidateSettings,
          metadataPlan,
          options,
        );
        const active = this.requireActiveSettingsTransaction();
        await this.verifyCandidateSettingsPersistenceTransaction(
          snapshot,
          active,
        );
        return afterPersist();
      });
    });
  }

  private async runWithSettingsPersistenceJournal<T>(
    snapshot: SettingsPersistenceTransactionSnapshot,
    operation: () => Promise<T>,
  ): Promise<T> {
    const activeTransaction: ActiveSettingsPersistenceTransaction = {
      snapshot,
      fileOperations: new Map(),
      createdDirectories: new Map(),
      ownershipNonce: createOwnershipNonce(),
    };
    this.activeSettingsPersistenceTransaction = activeTransaction;
    let result: T;
    try {
      result = await operation();
    } catch (error) {
      try {
        await this.restoreSettingsPersistenceTransaction(
          snapshot,
          activeTransaction,
        );
        await this.verifySettingsPersistenceTransaction(
          snapshot,
          activeTransaction,
        );
      } catch {
        this.clearPersistedStateCache();
        throw new FeedStorageRollbackIncompleteError();
      }
      throw error;
    } finally {
      this.activeSettingsPersistenceTransaction = undefined;
    }
    await this.finalizeSettingsDirectoryOwnership(activeTransaction);
    return result;
  }

  private async finalizeSettingsDirectoryOwnership(
    activeTransaction: ActiveSettingsPersistenceTransaction,
  ): Promise<void> {
    const pending = [
      ...this.pendingMarkerCleanup,
      ...[...activeTransaction.createdDirectories.values()].reverse(),
    ];
    this.pendingMarkerCleanup = [];
    for (const created of pending) {
      try {
        await this.removeOwnedDirectoryMarker(created);
      } catch (error) {
        this.pendingMarkerCleanup.push(created);
        this.markerCleanupWarnings.push(
          error instanceof Error ? error.message : String(error),
        );
        storageError("Ownership marker cleanup deferred", error, {
          markerPath: created.markerPath,
        });
      }
    }
  }

  private async removeOwnedDirectoryMarker(
    created: ControlledDirectoryCreation,
  ): Promise<void> {
    if (!(await this.app.vault.adapter.exists(created.markerPath))) {
      return;
    }
    const directoryIdentity =
      await this.pathIdentityProvider.inspect(created.identity.path);
    const markerIdentity =
      await this.pathIdentityProvider.inspect(created.markerPath);
    if (
      !this.pathIdentityProvider.isSameIdentity(
        created.identity,
        directoryIdentity,
      ) ||
      !this.pathIdentityProvider.isSameIdentity(
        created.markerIdentity,
        markerIdentity,
      ) ||
      (await this.app.vault.adapter.read(created.markerPath)) !==
        created.markerContents
    ) {
      throw new FeedStorageRollbackIncompleteError();
    }
    const finalMarkerIdentity =
      await this.pathIdentityProvider.inspect(created.markerPath);
    if (
      !this.pathIdentityProvider.isSameIdentity(
        created.markerIdentity,
        finalMarkerIdentity,
      )
    ) {
      throw new FeedStorageRollbackIncompleteError();
    }
    await this.app.vault.adapter.remove(created.markerPath);
    if (await this.app.vault.adapter.exists(created.markerPath)) {
      throw new FeedStorageRollbackIncompleteError();
    }
  }

  private requireActiveSettingsTransaction():
    ActiveSettingsPersistenceTransaction {
    const active = this.activeSettingsPersistenceTransaction;
    if (!active) throw new FeedStorageRollbackIncompleteError();
    return active;
  }

  private async persistSettingsUnlocked(
    settings: RssDashboardSettings,
    metadataPlan: SettingsMetadataWritePlan,
    options: PersistSettingsOptions = {},
  ): Promise<{
    metadataSaved: boolean;
    shardWriteCount: number;
    shardDeleteCount: number;
  }> {
    this.ensureFeedIds(settings);
    storageLog("Persisting settings", {
      mode: settings.storageMode,
      folder: normalizeFolderPath(settings.storageFolder),
      feedCount: settings.feeds.length,
      forceMetadata: Boolean(options.forceMetadata),
      forceAllShards: Boolean(options.forceAllShards),
    });

    if (settings.storageMode !== "vault-shards" && settings.storageMode !== "vault-shards-v2") {
      await this.persistMetadataWritePlan(metadataPlan);
      storageLog("Saved full settings to legacy data.json");
      this.capturePersistedState(settings);
      return {
        metadataSaved: true,
        shardWriteCount: 0,
        shardDeleteCount: 0,
      };
    }

    const normalizedStorageFolder = normalizeFolderPath(settings.storageFolder);
    const storageFolderChanged =
      this.lastStorageFolderPath !== null &&
      this.lastStorageFolderPath !== normalizedStorageFolder;
    const forceAllShards = Boolean(
      options.forceAllShards || storageFolderChanged,
    );

    if (storageFolderChanged) {
      storageLog("Storage folder changed; forcing shard rewrite", {
        previousFolder: this.lastStorageFolderPath,
        nextFolder: normalizedStorageFolder,
      });
    }

    await this.ensureStorageFolderExists(normalizedStorageFolder);

    let shardWriteCount = 0;
    let shardDeleteCount = 0;

    const currentFeedIds = new Set<string>();
    for (const feed of settings.feeds) {
      if (!feed.feedId) {
        continue;
      }

      currentFeedIds.add(feed.feedId);
      const isV2 = settings.storageMode === "vault-shards-v2";
      const shard = createFeedShard(feed, isV2);
      const shardJson = JSON.stringify(shard, null, 2);
      const currentComparableJson = createComparableFeedShardJson(feed, isV2);
      const previousJson = this.lastPersistedShardJsonByFeedId.get(feed.feedId);

      if (forceAllShards || previousJson !== currentComparableJson) {
        const shardPath = getFeedShardPath(
          normalizedStorageFolder,
          feed.feedId,
        );
        await this.writeSettingsFile(shardPath, shardJson);
        this.lastPersistedShardJsonByFeedId.set(
          feed.feedId,
          currentComparableJson,
        );
        shardWriteCount += 1;
        storageLog("Wrote feed shard", {
          feedId: feed.feedId,
          title: feed.title,
          shardPath,
          itemCount: feed.items.length,
        });
      }

      if (storageFolderChanged && this.lastStorageFolderPath) {
        const previousShardPath = getFeedShardPath(
          this.lastStorageFolderPath,
          feed.feedId,
        );
        const previousShard =
          this.app.vault.getAbstractFileByPath(previousShardPath);
        if (
          previousShard ||
          await this.app.vault.adapter.exists(previousShardPath)
        ) {
          await this.deleteSettingsFile(
            previousShardPath,
            previousShard ?? undefined,
          );
          storageLog("Deleted shard from previous storage folder", {
            feedId: feed.feedId,
            previousShardPath,
          });
        }
      }
    }

    for (const previousFeedId of [
      ...this.lastPersistedShardJsonByFeedId.keys(),
    ]) {
      if (currentFeedIds.has(previousFeedId)) {
        continue;
      }

      const shardPath = getFeedShardPath(
        normalizedStorageFolder,
        previousFeedId,
      );
      const existing = this.app.vault.getAbstractFileByPath(shardPath);
      if (existing || await this.app.vault.adapter.exists(shardPath)) {
        await this.deleteSettingsFile(shardPath, existing ?? undefined);
        storageLog("Deleted shard for removed feed", {
          feedId: previousFeedId,
          shardPath,
        });
      }
      this.lastPersistedShardJsonByFeedId.delete(previousFeedId);
      shardDeleteCount += 1;
    }

    const persistedSettings = this.createPersistedSettings(settings);
    const metadataJson = JSON.stringify(persistedSettings, null, 2);
    const shouldSaveMetadata =
      options.forceMetadata || this.lastPersistedMetadataJson !== metadataJson;

    if (shouldSaveMetadata) {
      await this.persistMetadataWritePlan(metadataPlan);
      this.lastPersistedMetadataJson = metadataJson;
      storageLog("Saved shard metadata to data.json", {
        feedCount: persistedSettings.feeds.length,
      });
    }

    if (settings.storageMode === "vault-shards-v2") {
      await this.saveUserStateFromFeeds(settings);
    }

    this.lastStorageFolderPath = normalizedStorageFolder;
    storageLog("Finished persisting settings", {
      metadataSaved: shouldSaveMetadata,
      shardWriteCount,
      shardDeleteCount,
    });

    return {
      metadataSaved: shouldSaveMetadata,
      shardWriteCount,
      shardDeleteCount,
    };
  }

  private enqueueSettingsPersistence<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const result = this.settingsPersistenceQueue.then(operation);
    this.settingsPersistenceQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async persistMetadataWritePlan(
    metadataPlan: SettingsMetadataWritePlan,
  ): Promise<void> {
    for (const write of metadataPlan.writes) {
      const parent = this.getParentFolderPath(write.path);
      if (parent) await this.ensureSettingsDirectory(parent);
      await this.writeSettingsFile(write.path, write.contents);
    }
  }

  private async captureSettingsPersistenceTransaction(
    previousSettings: RssDashboardSettings,
    candidateSettings: RssDashboardSettings,
    metadataPlan: SettingsMetadataWritePlan,
  ): Promise<SettingsPersistenceTransactionSnapshot> {
    const storageFilePaths = this.getSettingsPersistenceWriteSet(
      previousSettings,
      candidateSettings,
    );
    const metadataTargetPaths =
      metadataPlan.writes.map((write) =>
        assertControlledRelativePath(write.path));
    const filePaths = [...new Set([
      ...storageFilePaths,
      ...metadataTargetPaths,
    ])].sort();
    if (
      metadataTargetPaths.some((path) =>
        storageFilePaths.includes(path),
      ) ||
      new Set(metadataTargetPaths).size !== metadataTargetPaths.length
    ) {
      throw new FeedStorageRollbackIncompleteError();
    }
    const directoryPaths =
      this.getSettingsPersistenceDirectorySet(
        previousSettings,
        candidateSettings,
      );
    if (
      filePaths.length + directoryPaths.length >
      MAX_SETTINGS_TRANSACTION_PATHS
    ) {
      throw new FeedStorageRollbackIncompleteError();
    }
    let identities: Map<string, ControlledPathIdentity>;
    try {
      identities = await this.pathIdentityProvider.assertSafePaths([
        ...filePaths,
        ...directoryPaths,
      ]);
    } catch {
      throw new FeedStorageRollbackIncompleteError();
    }

    const files: SettingsPersistenceFileSnapshot[] = [];
    let snapshotBytes = 0;
    for (const path of filePaths) {
      const assertedIdentity = identities.get(path);
      if (!assertedIdentity) {
        throw new FeedStorageRollbackIncompleteError();
      }
      const { contents, identity } =
        await this.captureStableSettingsFile(
          path,
          assertedIdentity,
        );
      if (contents !== null) {
        snapshotBytes += new TextEncoder().encode(contents).byteLength;
        if (
          snapshotBytes > MAX_SETTINGS_TRANSACTION_SNAPSHOT_BYTES
        ) {
          throw new FeedStorageRollbackIncompleteError();
        }
      }
      files.push({ path, contents, identity });
    }

    const directories: SettingsPersistenceDirectorySnapshot[] = [];
    for (const path of directoryPaths) {
      const assertedIdentity = identities.get(path);
      if (!assertedIdentity) {
        throw new FeedStorageRollbackIncompleteError();
      }
      const { existed, identity } =
        await this.captureStableSettingsDirectory(
          path,
          assertedIdentity,
        );
      directories.push({ path, existed, identity });
    }

    return {
      files,
      directories,
      lastPersistedMetadataJson: this.lastPersistedMetadataJson,
      lastPersistedShardJsonByFeedId: new Map(
        this.lastPersistedShardJsonByFeedId,
      ),
      lastStorageFolderPath: this.lastStorageFolderPath,
    };
  }

  private async captureStableSettingsFile(
    path: string,
    assertedIdentity: ControlledPathIdentity,
  ): Promise<{
    contents: string | null;
    identity: ControlledPathIdentity;
  }> {
    const before = await this.pathIdentityProvider.inspect(path);
    this.assertIdentityObservationStable(assertedIdentity, before);
    const existsBefore = await this.app.vault.adapter.exists(path);
    const contents = existsBefore
      ? await this.app.vault.adapter.read(path)
      : null;
    const after = await this.pathIdentityProvider.inspect(path);
    const existsAfter = await this.app.vault.adapter.exists(path);
    if (
      existsBefore !== existsAfter ||
      (existsAfter && after.kind !== "file") ||
      (!existsAfter && after.kind !== "missing")
    ) {
      throw new FeedStorageRollbackIncompleteError();
    }
    this.assertIdentityObservationStable(before, after);
    if (
      existsAfter &&
      (await this.app.vault.adapter.read(path)) !== contents
    ) {
      throw new FeedStorageRollbackIncompleteError();
    }
    return { contents, identity: after };
  }

  private async captureStableSettingsDirectory(
    path: string,
    assertedIdentity: ControlledPathIdentity,
  ): Promise<{
    existed: boolean;
    identity: ControlledPathIdentity;
  }> {
    const before = await this.pathIdentityProvider.inspect(path);
    this.assertIdentityObservationStable(assertedIdentity, before);
    const existed = await this.app.vault.adapter.exists(path);
    const after = await this.pathIdentityProvider.inspect(path);
    if (
      existed !== (await this.app.vault.adapter.exists(path)) ||
      (existed && after.kind !== "directory") ||
      (!existed && after.kind !== "missing")
    ) {
      throw new FeedStorageRollbackIncompleteError();
    }
    this.assertIdentityObservationStable(before, after);
    return { existed, identity: after };
  }

  private assertIdentityObservationStable(
    expected: ControlledPathIdentity,
    actual: ControlledPathIdentity,
  ): void {
    if (
      expected.path !== actual.path ||
      expected.kind !== actual.kind ||
      expected.namespaceKey !== actual.namespaceKey ||
      expected.destructiveSafe !== actual.destructiveSafe ||
      (
        expected.kind !== "missing" &&
        expected.destructiveSafe &&
        !this.pathIdentityProvider.isSameIdentity(expected, actual)
      )
    ) {
      throw new FeedStorageRollbackIncompleteError();
    }
  }

  private async restoreSettingsPersistenceTransaction(
    snapshot: SettingsPersistenceTransactionSnapshot,
    activeTransaction: ActiveSettingsPersistenceTransaction,
  ): Promise<void> {
    let rollbackConflict = false;
    for (const fileSnapshot of [...snapshot.files].reverse()) {
      if (rollbackConflict) break;
      const { path, contents, identity: beforeIdentity } = fileSnapshot;
      const operation = activeTransaction.fileOperations.get(path);
      try {
        const currentExists =
          await this.app.vault.adapter.exists(path);
        const currentBytes = currentExists
          ? await this.app.vault.adapter.read(path)
          : null;
        const currentIdentity =
          await this.pathIdentityProvider.inspect(path);
        if (
          currentBytes === contents &&
          (
            contents === null ||
            (
              !operation &&
              !beforeIdentity.destructiveSafe
            ) ||
            (
              beforeIdentity.destructiveSafe &&
              this.pathIdentityProvider.isSameIdentity(
                beforeIdentity,
                currentIdentity,
              )
            )
          )
        ) {
          continue;
        }
        if (!operation) {
          throw new Error("Unjournaled controlled path mutation");
        }

        if (contents !== null) {
          if (operation.operation === "delete") {
            if (currentIdentity.kind !== "missing") {
              throw new Error("Deleted settings file was externally recreated");
            }
            operation.restoredIdentity =
              await this.createSettingsFileExclusively(path, contents);
            continue;
          }
          if (
            operation.actualPostBytes === null ||
            operation.actualPostBytes === undefined ||
            currentIdentity.kind !== "file" ||
            !operation.postIdentity ||
            !this.pathIdentityProvider.isSameIdentity(
              operation.postIdentity,
              currentIdentity,
            ) ||
            (await this.app.vault.adapter.read(path)) !==
              operation.actualPostBytes
          ) {
            throw new Error("Settings file changed after transaction write");
          }
          await this.compareAndSwapSettingsFile(
            path,
            operation.actualPostBytes,
            contents,
            operation.postIdentity,
          );
          continue;
        }

        if (operation.operation !== "write") {
          throw new Error("Invalid journal operation");
        }
        if (currentIdentity.kind === "missing") continue;
        if (
          operation.actualPostBytes === null ||
          operation.actualPostBytes === undefined ||
          currentIdentity.kind !== "file" ||
          !currentIdentity.destructiveSafe ||
          !operation.creationIdentity ||
          !this.pathIdentityProvider.isSameIdentity(
            operation.creationIdentity,
            currentIdentity,
          ) ||
          (await this.app.vault.adapter.read(path)) !==
            operation.actualPostBytes
        ) {
          throw new Error("Candidate-created settings file changed identity");
        }
        const abstractFile =
          this.app.vault.getAbstractFileByPath(path);
        const finalIdentity =
          await this.pathIdentityProvider.inspect(path);
        const finalBytes = await this.app.vault.adapter.read(path);
        if (
          !this.pathIdentityProvider.isSameIdentity(
            operation.creationIdentity,
            finalIdentity,
          ) ||
          finalBytes !== operation.actualPostBytes
        ) {
          throw new Error("Candidate-created settings file changed before delete");
        }
        if (abstractFile instanceof TFile) {
          await this.app.fileManager.trashFile(abstractFile);
        } else {
          await this.app.vault.adapter.remove(path);
        }
        if ((await this.pathIdentityProvider.inspect(path)).kind !== "missing") {
          throw new Error("Candidate-created settings file still exists");
        }
      } catch (error) {
        void error;
        rollbackConflict = true;
      }
    }

    for (const { path, existed } of [...snapshot.directories].reverse()) {
      if (rollbackConflict) break;
      if (existed) continue;
      try {
        const createdDirectory =
          activeTransaction.createdDirectories.get(path);
        const currentIdentity =
          await this.pathIdentityProvider.inspect(path);
        if (currentIdentity.kind === "missing") continue;
        if (
          !createdDirectory ||
          currentIdentity.kind !== "directory" ||
          !currentIdentity.destructiveSafe ||
          !this.pathIdentityProvider.isSameIdentity(
            createdDirectory.identity,
            currentIdentity,
          )
        ) {
          throw new Error("Candidate-created directory changed identity");
        }
        const contents = await this.app.vault.adapter.list(path);
        const markerIdentity = await this.pathIdentityProvider.inspect(
          createdDirectory.markerPath,
        );
        if (
          contents.files.length !== 1 ||
          contents.files[0] !== createdDirectory.markerPath ||
          contents.folders.length > 0 ||
          !this.pathIdentityProvider.isSameIdentity(
            createdDirectory.markerIdentity,
            markerIdentity,
          ) ||
          (await this.app.vault.adapter.read(
            createdDirectory.markerPath,
          )) !== createdDirectory.markerContents
        ) {
          throw new Error("Candidate-created settings folder ownership changed");
        }
        const finalMarkerIdentity = await this.pathIdentityProvider.inspect(
          createdDirectory.markerPath,
        );
        if (
          !this.pathIdentityProvider.isSameIdentity(
            createdDirectory.markerIdentity,
            finalMarkerIdentity,
          )
        ) {
          throw new Error("Candidate-created marker changed before delete");
        }
        await this.app.vault.adapter.remove(createdDirectory.markerPath);
        if (
          await this.app.vault.adapter.exists(createdDirectory.markerPath)
        ) {
          throw new Error("Candidate-created marker still exists");
        }
        await this.app.vault.adapter.rmdir(path, false);
        if (await this.app.vault.adapter.exists(path)) {
          throw new Error("Candidate-created directory still exists");
        }
      } catch (error) {
        void error;
        rollbackConflict = true;
      }
    }

    this.lastPersistedMetadataJson =
      snapshot.lastPersistedMetadataJson;
    this.lastPersistedShardJsonByFeedId = new Map(
      snapshot.lastPersistedShardJsonByFeedId,
    );
    this.lastStorageFolderPath = snapshot.lastStorageFolderPath;

    if (rollbackConflict) {
      throw new FeedStorageRollbackIncompleteError();
    }
  }

  private async compareAndSwapSettingsFile(
    path: string,
    expected: string,
    replacement: string,
    expectedIdentity: ControlledPathIdentity,
    onObservedPostimage?: (
      actualBytes: string,
      actualIdentity: ControlledPathIdentity,
    ) => void,
  ): Promise<void> {
    const adapter = this.app.vault.adapter as typeof this.app.vault.adapter & {
      process?: (
        target: string,
        update: (contents: string) => string,
      ) => Promise<string>;
    };
    if (typeof adapter.process !== "function") {
      throw new Error("Adapter cannot provide conditional replacement");
    }
    const beforeIdentity = await this.pathIdentityProvider.inspect(path);
    if (
      !expectedIdentity.destructiveSafe ||
      beforeIdentity.kind !== "file" ||
      !this.pathIdentityProvider.isSameIdentity(
        expectedIdentity,
        beforeIdentity,
      ) ||
      (await adapter.read(path)) !== expected
    ) {
      throw new Error("Conditional settings replacement lost its preimage");
    }
    let matched = false;
    await adapter.process(path, (contents) => {
      if (contents !== expected) return contents;
      matched = true;
      return replacement;
    });
    const afterIdentity = await this.pathIdentityProvider.inspect(path);
    const actualBytes = await adapter.read(path);
    if (
      matched &&
      this.pathIdentityProvider.isSameIdentity(
        expectedIdentity,
        afterIdentity,
      )
    ) {
      onObservedPostimage?.(actualBytes, afterIdentity);
    }
    if (
      !matched ||
      !this.pathIdentityProvider.isSameIdentity(
        expectedIdentity,
        afterIdentity,
      ) ||
      actualBytes !== replacement
    ) {
      throw new Error("Conditional settings restore lost its comparison");
    }
  }

  private async createSettingsFileExclusively(
    path: string,
    contents: string,
  ): Promise<ControlledPathIdentity> {
    if (await this.app.vault.adapter.exists(path)) {
      throw new Error("Settings rollback target was externally recreated");
    }
    const identity =
      await this.pathIdentityProvider.createExclusive(path, contents);
    if ((await this.app.vault.adapter.read(path)) !== contents) {
      throw new Error("Exclusive settings restore was not durable");
    }
    const currentIdentity = await this.pathIdentityProvider.inspect(path);
    if (
      !this.pathIdentityProvider.isSameIdentity(identity, currentIdentity)
    ) {
      throw new Error("Exclusive settings restore changed identity");
    }
    return identity;
  }

  private async verifySettingsPersistenceTransaction(
    snapshot: SettingsPersistenceTransactionSnapshot,
    activeTransaction: ActiveSettingsPersistenceTransaction,
  ): Promise<void> {
    for (const { path, contents, identity } of snapshot.files) {
      const exists = await this.app.vault.adapter.exists(path);
      if (contents === null) {
        if (exists) throw new FeedStorageRollbackIncompleteError();
        continue;
      }
      if (
        !exists ||
        (await this.app.vault.adapter.read(path)) !== contents
      ) {
        throw new FeedStorageRollbackIncompleteError();
      }
      if (identity.destructiveSafe) {
        const operation = activeTransaction.fileOperations.get(path);
        const expectedIdentity =
          operation?.operation === "delete"
            ? operation.restoredIdentity
            : identity;
        const currentIdentity =
          await this.pathIdentityProvider.inspect(path);
        if (
          !expectedIdentity ||
          !this.pathIdentityProvider.isSameIdentity(
            expectedIdentity,
            currentIdentity,
          )
        ) {
          throw new FeedStorageRollbackIncompleteError();
        }
      }
    }
    for (const { path, existed, identity } of snapshot.directories) {
      const exists = await this.app.vault.adapter.exists(path);
      if (exists !== existed) {
        throw new FeedStorageRollbackIncompleteError();
      }
      if (exists) {
        const currentIdentity = await this.pathIdentityProvider.inspect(path);
        if (
          identity.destructiveSafe &&
          !this.pathIdentityProvider.isSameIdentity(identity, currentIdentity)
        ) {
          throw new FeedStorageRollbackIncompleteError();
        }
      }
    }
  }

  private async verifyCandidateSettingsPersistenceTransaction(
    snapshot: SettingsPersistenceTransactionSnapshot,
    activeTransaction: ActiveSettingsPersistenceTransaction,
  ): Promise<void> {
    for (const fileSnapshot of snapshot.files) {
      const operation =
        activeTransaction.fileOperations.get(fileSnapshot.path);
      const currentIdentity =
        await this.pathIdentityProvider.inspect(fileSnapshot.path);
      const exists =
        await this.app.vault.adapter.exists(fileSnapshot.path);
      const currentBytes = exists
        ? await this.app.vault.adapter.read(fileSnapshot.path)
        : null;

      if (!operation) {
        if (currentBytes !== fileSnapshot.contents) {
          throw new FeedStorageRollbackIncompleteError();
        }
        if (
          fileSnapshot.contents !== null &&
          (
            !fileSnapshot.identity.destructiveSafe ||
            !this.pathIdentityProvider.isSameIdentity(
              fileSnapshot.identity,
              currentIdentity,
            )
          )
        ) {
          throw new FeedStorageRollbackIncompleteError();
        }
        if (
          fileSnapshot.contents === null &&
          currentIdentity.kind !== "missing"
        ) {
          throw new FeedStorageRollbackIncompleteError();
        }
        continue;
      }

      if (operation.operation === "delete") {
        if (currentBytes !== null || currentIdentity.kind !== "missing") {
          throw new FeedStorageRollbackIncompleteError();
        }
        continue;
      }

      if (
        operation.actualPostBytes === null ||
        operation.actualPostBytes === undefined ||
        currentBytes !== operation.actualPostBytes ||
        !operation.postIdentity ||
        !this.pathIdentityProvider.isSameIdentity(
          operation.postIdentity,
          currentIdentity,
        )
      ) {
        throw new FeedStorageRollbackIncompleteError();
      }
    }

    for (const directorySnapshot of snapshot.directories) {
      const currentIdentity =
        await this.pathIdentityProvider.inspect(directorySnapshot.path);
      const created =
        activeTransaction.createdDirectories.get(directorySnapshot.path);
      if (directorySnapshot.existed) {
        if (
          currentIdentity.kind !== "directory" ||
          (
            directorySnapshot.identity.destructiveSafe &&
            !this.pathIdentityProvider.isSameIdentity(
              directorySnapshot.identity,
              currentIdentity,
            )
          )
        ) {
          throw new FeedStorageRollbackIncompleteError();
        }
        continue;
      }
      if (!created) {
        if (currentIdentity.kind !== "missing") {
          throw new FeedStorageRollbackIncompleteError();
        }
        continue;
      }
      const markerIdentity =
        await this.pathIdentityProvider.inspect(created.markerPath);
      if (
        !this.pathIdentityProvider.isSameIdentity(
          created.identity,
          currentIdentity,
        ) ||
        !this.pathIdentityProvider.isSameIdentity(
          created.markerIdentity,
          markerIdentity,
        ) ||
        !(await this.app.vault.adapter.exists(created.markerPath)) ||
        (await this.app.vault.adapter.read(created.markerPath)) !==
          created.markerContents
      ) {
        throw new FeedStorageRollbackIncompleteError();
      }
    }
  }

  private getSettingsPersistenceWriteSet(
    previousSettings: RssDashboardSettings,
    candidateSettings: RssDashboardSettings,
  ): string[] {
    const paths = new Map<string, "shard" | "user-state">();
    const addPath = (
      path: string,
      kind: "shard" | "user-state",
    ): void => {
      const previousKind = paths.get(path);
      if (previousKind !== undefined && previousKind !== kind) {
        throw new FeedStorageRollbackIncompleteError();
      }
      paths.set(path, kind);
    };
    const roots = new Set<string>();
    for (const settings of [previousSettings, candidateSettings]) {
      if (
        settings.storageMode === "vault-shards" ||
        settings.storageMode === "vault-shards-v2"
      ) {
        roots.add(
          this.getControlledFolderPath(
            settings.storageFolder,
            ".rss-dashboard-data/feeds",
          ),
        );
      }
    }
    if (this.lastStorageFolderPath !== null) {
      roots.add(
        this.getControlledFolderPath(
          this.lastStorageFolderPath,
          ".rss-dashboard-data/feeds",
        ),
      );
    }

    const feedIds = new Set<string>();
    for (const settings of [previousSettings, candidateSettings]) {
      for (const feed of settings.feeds) {
        if (!feed.feedId?.trim()) continue;
        feedIds.add(this.getControlledFeedId(feed.feedId));
      }
    }
    for (const feedId of this.lastPersistedShardJsonByFeedId.keys()) {
      feedIds.add(this.getControlledFeedId(feedId));
    }
    for (const root of roots) {
      for (const feedId of feedIds) {
        addPath(
          this.getControlledChildPath(root, `${feedId}.json`),
          "shard",
        );
      }
    }

    for (const settings of [previousSettings, candidateSettings]) {
      if (settings.storageMode === "vault-shards-v2") {
        const metadataFolder = this.getControlledFolderPath(
          settings.metadataStorageFolder,
          ".rss-dashboard-data",
        );
        addPath(
          this.getControlledChildPath(metadataFolder, "user-state.json"),
          "user-state",
        );
      }
    }
    if (paths.size > MAX_SETTINGS_TRANSACTION_PATHS) {
      throw new FeedStorageRollbackIncompleteError();
    }
    return [...paths.keys()].sort();
  }

  private getSettingsPersistenceDirectorySet(
    previousSettings: RssDashboardSettings,
    candidateSettings: RssDashboardSettings,
  ): string[] {
    const directories = new Set<string>();
    const addAncestors = (folder: string): void => {
      const segments = folder.split("/");
      if (segments.length > MAX_SETTINGS_TRANSACTION_DEPTH) {
        throw new FeedStorageRollbackIncompleteError();
      }
      for (let index = 1; index <= segments.length; index += 1) {
        directories.add(segments.slice(0, index).join("/"));
      }
    };

    for (const settings of [previousSettings, candidateSettings]) {
      if (
        settings.storageMode === "vault-shards" ||
        settings.storageMode === "vault-shards-v2"
      ) {
        addAncestors(
          this.getControlledFolderPath(
            settings.storageFolder,
            ".rss-dashboard-data/feeds",
          ),
        );
      }
      if (
        settings.metadataStorageMode === "vault-location" ||
        settings.storageMode === "vault-shards-v2"
      ) {
        addAncestors(
          this.getControlledFolderPath(
            settings.metadataStorageFolder,
            ".rss-dashboard-data",
          ),
        );
      }
    }
    return [...directories].sort(
      (left, right) =>
        left.split("/").length - right.split("/").length,
    );
  }

  private getControlledFolderPath(
    input: string,
    fallback: string,
  ): string {
    const controlledPath = input || fallback;
    const segments = controlledPath.split("/");
    if (
      controlledPath.length === 0 ||
      controlledPath.length >
        MAX_SETTINGS_TRANSACTION_PATH_LENGTH ||
      segments.length > MAX_SETTINGS_TRANSACTION_DEPTH ||
      hasControlCharacters(controlledPath)
    ) {
      throw new FeedStorageRollbackIncompleteError();
    }
    try {
      assertControlledRelativePath(controlledPath);
    } catch {
      throw new FeedStorageRollbackIncompleteError();
    }
    return controlledPath;
  }

  private getControlledFeedId(feedId: string | undefined): string {
    const value = feedId ?? "";
    if (
      value.length === 0 ||
      value !== value.trim() ||
      value !== value.normalize("NFC") ||
      value.length > 256 ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value) ||
      value === "." ||
      value === ".."
    ) {
      throw new FeedStorageRollbackIncompleteError();
    }
    return value;
  }

  private assertNoDuplicateFeedIds(
    settings: RssDashboardSettings,
  ): void {
    const seen = new Set<string>();
    for (const feed of settings.feeds) {
      const raw = feed.feedId;
      if (!raw) continue;
      const feedId = this.getControlledFeedId(raw);
      if (seen.has(feedId)) {
        throw new FeedStorageRollbackIncompleteError();
      }
      seen.add(feedId);
    }
  }

  private getControlledChildPath(root: string, name: string): string {
    const path = normalizePath(`${root}/${name}`);
    if (
      path.length > MAX_SETTINGS_TRANSACTION_PATH_LENGTH ||
      !path.startsWith(`${root}/`)
    ) {
      throw new FeedStorageRollbackIncompleteError();
    }
    return path;
  }

  private assertKnownVaultFolder(path: string): void {
    const abstractFile = this.app.vault.getAbstractFileByPath(path);
    if (!(abstractFile instanceof TFolder)) {
      throw new FeedStorageRollbackIncompleteError();
    }
  }

  private clearPersistedStateCache(): void {
    this.lastPersistedShardJsonByFeedId.clear();
    this.lastPersistedMetadataJson = null;
    this.lastStorageFolderPath = null;
  }

  public buildVaultShardsCandidate(
    settings: RssDashboardSettings,
  ): RssDashboardSettings {
    const candidate = cloneJson(settings);
    candidate.storageMode = "vault-shards";
    candidate.storageFolder = this.getControlledFolderPath(
      normalizeFolderPath(candidate.storageFolder),
      ".rss-dashboard-data/feeds",
    );
    return candidate;
  }

  public buildVaultShardsV2Candidate(
    settings: RssDashboardSettings,
    options: { dismissMigration?: boolean } = {},
  ): RssDashboardSettings {
    const candidate = cloneJson(settings);
    candidate.storageMode = "vault-shards-v2";
    candidate.storageFolder = this.getControlledFolderPath(
      normalizeFolderPath(candidate.storageFolder),
      ".rss-dashboard-data/feeds",
    );
    candidate.metadataStorageMode = "vault-location";
    const parentFolder =
      this.getParentFolderPath(candidate.storageFolder) ||
      ".rss-dashboard-data";
    candidate.metadataStorageFolder = this.getControlledFolderPath(
      normalizeFolderPath(parentFolder),
      ".rss-dashboard-data",
    );
    candidate.metadataStorageSchemaVersion = 2;
    if (options.dismissMigration) {
      candidate.storageMigrationDismissedPermanently = true;
    }
    return candidate;
  }

  public buildLegacyJsonCandidate(
    settings: RssDashboardSettings,
  ): RssDashboardSettings {
    const candidate = cloneJson(settings);
    this.getControlledFolderPath(
      candidate.storageFolder,
      ".rss-dashboard-data/feeds",
    );
    candidate.storageMode = "legacy-json";
    return candidate;
  }

  public buildRepairCandidate(
    settings: RssDashboardSettings,
  ): RssDashboardSettings {
    const candidate = cloneJson(settings);
    candidate.storageFolder = this.getControlledFolderPath(
      normalizeFolderPath(candidate.storageFolder),
      ".rss-dashboard-data/feeds",
    );
    return candidate;
  }

  public markStorageOperationCompleted(
    operation: "migration" | "migration-v2" | "repair" | "revert",
  ): void {
    if (operation === "migration") {
      this.lastRepairResult = "Migration completed";
    } else if (operation === "migration-v2") {
      this.lastRepairResult = "Migration completed (v2)";
    } else if (operation === "revert") {
      this.lastRepairResult = "Reverted to legacy JSON";
    } else {
      this.lastRepairResult =
        `Last repair succeeded at ${new Date().toLocaleString()}`;
    }
  }

  public buildPortableDataBundle(
    settings: RssDashboardSettings,
  ): PortableDataBundle {
    this.ensureFeedIds(settings);

    return {
      version: SHARD_VERSION,
      exportedAt: Date.now(),
      storageMode: settings.storageMode,
      storageFolder: settings.storageFolder,
      metadataStorageMode: settings.metadataStorageMode,
      metadataStorageFolder: settings.metadataStorageFolder,
      metadata: this.createPersistedSettings(settings),
      shards: settings.feeds
        .filter((feed): feed is Feed & { feedId: string } =>
          Boolean(feed.feedId),
        )
        .map((feed) => createFeedShard(feed)),
      markdownMirrorFallbackPlanned: true,
    };
  }

  public buildPersistedMetadataSnapshot(
    settings: RssDashboardSettings,
  ): RssDashboardSettings | PersistedRssDashboardSettings {
    if (
      settings.storageMode !== "vault-shards" &&
      settings.storageMode !== "vault-shards-v2"
    ) {
      return cloneJson(settings);
    }
    return this.createPersistedSettings(settings);
  }

  public validatePortableDataBundle(input: unknown): PortableDataBundle {
    return parsePortableDataBundle(input);
  }

  public buildPortableDataBundleCandidate(
    input: unknown,
    settings: RssDashboardSettings,
  ): RssDashboardSettings {
    const bundle = this.validatePortableDataBundle(input);

    storageLog("Starting portable bundle import", {
      sourceMode: bundle.storageMode,
      sourceFeedCount: bundle.metadata.feeds.length,
      sourceShardCount: bundle.shards.length,
    });

    const shardItemsByFeedId = new Map(
      bundle.shards.map((shard) => [shard.feedId, cloneJson(shard.items)]),
    );
    const importedMetadata = cloneJson(bundle.metadata);
    const importedFeeds = importedMetadata.feeds.map((feed) => {
      const feedItems = feed.feedId
        ? shardItemsByFeedId.get(feed.feedId)
        : undefined;
      return {
        ...feed,
        items: Array.isArray(feedItems) ? feedItems : [],
      };
    });
    const candidate = {
      ...settings,
      ...importedMetadata,
      storageMode: bundle.storageMode,
      storageFolder: importedMetadata.storageFolder,
      metadataStorageMode:
        bundle.metadataStorageMode ?? settings.metadataStorageMode,
      metadataStorageFolder:
        bundle.metadataStorageFolder ?? settings.metadataStorageFolder,
      feeds: importedFeeds,
    } as RssDashboardSettings;
    migrateSettings(candidate);
    return candidate;
  }

  public getStatus(settings: RssDashboardSettings): FeedStorageStatus {
    const shardCount = settings.feeds.filter((feed) => feed.feedId).length;
    return {
      mode: settings.storageMode,
      folder: normalizeFolderPath(settings.storageFolder),
      shardCount,
      feedCount: settings.feeds.length,
      migrationReady:
        settings.storageMode === "legacy-json" &&
        settings.feeds.some((feed) => (feed.items?.length ?? 0) > 0),
      lastRepairResult: this.lastRepairResult,
    };
  }

  private createPersistedSettings(
    settings: RssDashboardSettings,
  ): PersistedRssDashboardSettings {
    const cloned = cloneJson(settings);
    const feeds: PersistedFeedConfig[] = cloned.feeds.map((feed) => {
      const { items: _items, feedId, ...config } = feed;
      void _items;
      return {
        ...config,
        feedId: feedId ?? createFeedId(),
      };
    });

    return {
      ...cloned,
      storageFolder: normalizeFolderPath(cloned.storageFolder),
      feeds,
    };
  }

  private capturePersistedState(settings: RssDashboardSettings): void {
    if (settings.storageMode === "vault-shards" || settings.storageMode === "vault-shards-v2") {
      this.lastPersistedMetadataJson = JSON.stringify(
        this.createPersistedSettings(settings),
        null,
        2,
      );
      const isV2 = settings.storageMode === "vault-shards-v2";
      this.lastPersistedShardJsonByFeedId = new Map(
        settings.feeds
          .filter((feed): feed is Feed & { feedId: string } =>
            Boolean(feed.feedId),
          )
          .map((feed) => [feed.feedId, createComparableFeedShardJson(feed, isV2)]),
      );
      this.lastStorageFolderPath = normalizeFolderPath(settings.storageFolder);
      return;
    }

    this.lastPersistedMetadataJson = JSON.stringify(
      cloneJson(settings),
      null,
      2,
    );
    this.lastPersistedShardJsonByFeedId.clear();
    this.lastStorageFolderPath = null;
  }

  private async ensureStorageFolderExists(
    storageFolder: string,
  ): Promise<void> {
    const normalizedFolder = normalizeFolderPath(storageFolder);
    if (!normalizedFolder) {
      return;
    }
    await this.ensureSettingsDirectory(normalizedFolder);
    storageLog("Created storage folder", { folder: normalizedFolder });
  }

  private async ensureSettingsDirectory(path: string): Promise<void> {
    const active = this.activeSettingsPersistenceTransaction;
    const segments = assertControlledRelativePath(path).split("/");
    for (let index = 1; index <= segments.length; index += 1) {
      const currentPath = segments.slice(0, index).join("/");
      const currentIdentity =
        await this.pathIdentityProvider.inspect(currentPath);
      if (currentIdentity.kind === "directory") continue;
      if (currentIdentity.kind !== "missing") {
        throw new Error("Settings directory path is not a directory");
      }
      const snapshot = active?.snapshot.directories.find(
        (entry) => entry.path === currentPath,
      );
      if (active && (!snapshot || snapshot.existed)) {
        throw new FeedStorageRollbackIncompleteError();
      }
      if (!active) {
        await this.app.vault.createFolder(currentPath);
        continue;
      }
      const markerName =
        `.rss-dashboard-owner-${active.ownershipNonce}.json`;
      const markerContents = JSON.stringify({
        nonce: active.ownershipNonce,
        path: currentPath,
      });
      const created =
        await this.pathIdentityProvider.createOwnedDirectory(
          currentPath,
          markerName,
          markerContents,
        );
      active.createdDirectories.set(currentPath, created);
    }
  }

  private getParentFolderPath(folderPath: string): string | null {
    const lastSlashIndex = folderPath.lastIndexOf("/");
    if (lastSlashIndex <= 0) {
      return null;
    }

    return folderPath.slice(0, lastSlashIndex);
  }

  private getUserStatePath(settings: RssDashboardSettings): string {
    let folder = settings.metadataStorageFolder.trim();
    if (!folder) {
      folder = ".rss-dashboard-data";
    }
    return normalizePath(`${folder.replace(/^\/+|\/+$/g, "")}/user-state.json`);
  }

  public async loadUserState(settings: RssDashboardSettings): Promise<UserStateFile | null> {
    const path = this.getUserStatePath(settings);
    if (!(await this.app.vault.adapter.exists(path))) {
      return null;
    }
    try {
      const raw = await this.app.vault.adapter.read(path);
      const parsed = JSON.parse(raw) as UserStateFile;
      if (parsed && typeof parsed.states === "object") {
        return parsed;
      }
    } catch (e) {
      storageError("Failed to parse user-state.json", e);
    }
    return null;
  }

  public async saveUserStateFromFeeds(settings: RssDashboardSettings): Promise<void> {
    const activeGuids = new Set<string>();
    const states: Record<string, ArticleUserState> = {};

    for (const feed of settings.feeds) {
      for (const item of feed.items) {
        activeGuids.add(item.guid);
        const hasState = item.read || item.starred || (item.tags && item.tags.length > 0) || item.saved || item.playbackProgress;
        if (hasState) {
          const state: ArticleUserState = {};
          if (item.read) state.read = true;
          if (item.starred) state.starred = true;
          if (item.tags && item.tags.length > 0) state.tags = cloneJson(item.tags);
          if (item.saved) {
            state.saved = true;
            if (item.savedFilePath) state.savedFilePath = item.savedFilePath;
          }
          if (item.playbackProgress) state.playbackProgress = cloneJson(item.playbackProgress);
          states[item.guid] = state;
        }
      }
    }

    // Attempt to load existing to preserve any items that are currently pruned from feed shards
    // wait, the GC logic says "cross-reference active GUIDs in all feeds... if GUID doesn't exist in any feed, delete it"
    // So we don't preserve items not in activeGuids. This implicitly handles GC!
    // But wait, are there items in user-state that are NOT in feeds but we WANT to keep? No, the plan says GC them.

    const userStateFile: UserStateFile = withSyncNonce({
      version: 1,
      states
    });

    const path = this.getUserStatePath(settings);
    
    // Ensure metadata folder exists
    let folder = settings.metadataStorageFolder.trim();
    if (!folder) {
      folder = ".rss-dashboard-data";
    }
    const normalizedFolder = normalizePath(folder.replace(/^\/+|\/+$/g, ""));
    const folderExists = await this.app.vault.adapter.exists(normalizedFolder);
    if (!folderExists) {
      await this.ensureSettingsDirectory(normalizedFolder);
    }

    const userStateJson = JSON.stringify(userStateFile, null, 2);
    const writeUserState = () =>
      this.writeSettingsFile(path, userStateJson);
    if (this.writeWrapper) {
      await this.writeWrapper(writeUserState);
    } else {
      await writeUserState();
    }
    storageLog("Saved user-state.json with " + Object.keys(states).length + " entries.");
  }

  private async writeSettingsFile(
    path: string,
    contents: string,
  ): Promise<void> {
    const active = this.activeSettingsPersistenceTransaction;
    if (!active) {
      await this.app.vault.adapter.write(path, contents);
      if (
        !(await this.app.vault.adapter.exists(path)) ||
        (await this.app.vault.adapter.read(path)) !== contents
      ) {
        throw new Error("Settings write did not persist exact bytes");
      }
      return;
    }
    const snapshot = active.snapshot.files.find((entry) => entry.path === path);
    if (!snapshot) {
      throw new FeedStorageRollbackIncompleteError();
    }
    const operation: SettingsPersistenceFileOperation = {
      operation: "write",
      intendedBytes: contents,
    };
    await this.assertSettingsFilePreimage(snapshot);
    active.fileOperations.set(path, operation);
    if (snapshot.contents === null) {
      operation.creationIdentity =
        await this.pathIdentityProvider.createExclusive(path, contents);
    } else {
      await this.compareAndSwapSettingsFile(
        path,
        snapshot.contents,
        contents,
        snapshot.identity,
        (actualBytes, actualIdentity) => {
          operation.actualPostBytes = actualBytes;
          operation.postIdentity = actualIdentity;
        },
      );
    }
    await this.captureActualPostimage(
      path,
      (actualBytes) => actualBytes === contents,
    );
  }

  private async deleteSettingsFile(
    path: string,
    file?: TAbstractFile,
  ): Promise<void> {
    const active = this.activeSettingsPersistenceTransaction;
    if (!active) {
      if (file) {
        await this.app.fileManager.trashFile(file);
      } else {
        await this.app.vault.adapter.remove(path);
      }
      return;
    }
    const snapshot = active.snapshot.files.find(
      (entry) => entry.path === path,
    );
    if (!snapshot || !snapshot.identity.destructiveSafe) {
      throw new FeedStorageRollbackIncompleteError();
    }
    await this.assertSettingsFilePreimage(snapshot);
    const currentFile = this.app.vault.getAbstractFileByPath(path);
    await this.assertSettingsFilePreimage(snapshot);
    active.fileOperations.set(path, {
      operation: "delete",
      intendedBytes: null,
      actualPostBytes: null,
    });
    if (currentFile instanceof TFile) {
      await this.app.fileManager.trashFile(currentFile);
    } else if (file instanceof TFile) {
      const fileIdentity = await this.pathIdentityProvider.inspect(path);
      const expectedFileIdentity =
        snapshot.identity.destructiveSafe &&
        this.pathIdentityProvider.isSameIdentity(
          snapshot.identity,
          fileIdentity,
        );
      if (!expectedFileIdentity) {
        throw new FeedStorageRollbackIncompleteError();
      }
      await this.app.fileManager.trashFile(file);
    } else {
      await this.app.vault.adapter.remove(path);
    }
    if ((await this.pathIdentityProvider.inspect(path)).kind !== "missing") {
      throw new FeedStorageRollbackIncompleteError();
    }
  }

  private async assertSettingsFilePreimage(
    snapshot: SettingsPersistenceFileSnapshot,
  ): Promise<void> {
    const currentIdentity =
      await this.pathIdentityProvider.inspect(snapshot.path);
    const exists = await this.app.vault.adapter.exists(snapshot.path);
    const currentBytes = exists
      ? await this.app.vault.adapter.read(snapshot.path)
      : null;
    if (snapshot.contents === null) {
      if (exists || currentIdentity.kind !== "missing") {
        throw new FeedStorageRollbackIncompleteError();
      }
      return;
    }
    if (
      !snapshot.identity.destructiveSafe ||
      !exists ||
      currentBytes !== snapshot.contents ||
      currentIdentity.kind !== "file" ||
      !this.pathIdentityProvider.isSameIdentity(
        snapshot.identity,
        currentIdentity,
      )
    ) {
      throw new FeedStorageRollbackIncompleteError();
    }
  }

  private async captureActualPostimage(
    path: string,
    isExpected: (actualBytes: string) => boolean,
  ): Promise<void> {
    const active = this.requireActiveSettingsTransaction();
    const operation = active.fileOperations.get(path);
    const snapshot = active.snapshot.files.find((entry) => entry.path === path);
    if (!operation || operation.operation !== "write" || !snapshot) {
      throw new FeedStorageRollbackIncompleteError();
    }
    const currentIdentity = await this.pathIdentityProvider.inspect(path);
    const exists = await this.app.vault.adapter.exists(path);
    const actualBytes = exists
      ? await this.app.vault.adapter.read(path)
      : null;
    operation.actualPostBytes = actualBytes;
    if (
      actualBytes === null ||
      currentIdentity.kind !== "file"
    ) {
      throw new FeedStorageRollbackIncompleteError();
    }
    const expectedIdentity =
      snapshot.contents === null
        ? operation.creationIdentity
        : snapshot.identity;
    if (
      !expectedIdentity ||
      !expectedIdentity.destructiveSafe ||
      !this.pathIdentityProvider.isSameIdentity(
        expectedIdentity,
        currentIdentity,
      )
    ) {
      throw new FeedStorageRollbackIncompleteError();
    }
    operation.postIdentity = currentIdentity;
    if (!isExpected(actualBytes)) {
      throw new FeedStorageCandidateVerificationError();
    }
  }
}
