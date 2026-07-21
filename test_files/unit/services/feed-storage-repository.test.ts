import { describe, it, expect, beforeEach, vi } from "vitest";
import { App } from "obsidian";
import {
  FeedStorageRepository,
  FeedStorageRollbackIncompleteError,
} from "../../../src/services/feed-storage-repository";
import { ArticleSaver } from "../../../src/services/article-saver";
import { normalizeFeedItem } from "../../../src/collection/feed-normalizer";
import {
  DEFAULT_SETTINGS,
  type Feed,
  type RssDashboardSettings,
} from "../../../src/types/types";

interface VaultAdapterStub {
  write(path: string, content: string): Promise<void>;
  read(path: string): Promise<string>;
}

function vaultAdapter(app: App): VaultAdapterStub {
  return app.vault.adapter as unknown as VaultAdapterStub;
}

function cloneSettings(): RssDashboardSettings {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as RssDashboardSettings;
}

function makeFeed(overrides?: Partial<Feed>): Feed {
  return {
    title: "Example Feed",
    url: "https://example.com/feed.xml",
    folder: "RSS",
    items: [
      {
        title: "Article 1",
        link: "https://example.com/articles/1",
        description: "One",
        pubDate: "2026-01-01T00:00:00Z",
        guid: "https://example.com/articles/1",
        read: false,
        starred: false,
        tags: [],
        feedTitle: "Example Feed",
        feedUrl: "https://example.com/feed.xml",
        coverImage: "",
      },
    ],
    lastUpdated: 0,
    ...overrides,
  };
}

describe("FeedStorageRepository", () => {
  let app: App;
  let repository: FeedStorageRepository;
  let saveData: import("vitest").Mock<(...args: unknown[]) => Promise<void>>;

  beforeEach(() => {
    app = App.createMock();
    repository = new FeedStorageRepository(app);
    saveData = vi.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
  });

  it("hydrates every item with its owning feedId source identity before persistence", async () => {
    const settings = cloneSettings();
    const feed = makeFeed({ feedId: "feed-source-id" });
    settings.feeds = [feed];

    await repository.persistSettings(settings, saveData, {
      forceMetadata: true,
    });

    expect(
      (
        feed.items[0] as (typeof feed.items)[number] & {
          rssDashboardSourceId?: string;
        }
      ).rssDashboardSourceId,
    ).toBe("feed-source-id");
  });

  it("returns data.json as the feed local address in legacy mode", () => {
    const settings = cloneSettings();
    settings.storageMode = "legacy-json";

    const address = repository.getFeedLocalStorageAddress(settings, makeFeed());

    expect(address).toEqual({
      mode: "legacy-json",
      address: "data.json",
    });
  });

  it("returns the normalized shard path as the feed local address in shard mode", () => {
    const settings = cloneSettings();
    settings.storageMode = "vault-shards";
    settings.storageFolder = "/RSS Data/Feeds/";

    const address = repository.getFeedLocalStorageAddress(
      settings,
      makeFeed({ feedId: "feed-1" }),
    );

    expect(address).toEqual({
      mode: "vault-shards",
      address: "RSS Data/Feeds/feed-1.json",
    });
  });

  it("treats vault-shards-v2 as shard-backed storage for feed addresses", () => {
    const settings = cloneSettings();
    settings.storageMode = "vault-shards-v2";
    settings.storageFolder = "/RSS Data/Feeds/";

    const address = repository.getFeedLocalStorageAddress(
      settings,
      makeFeed({ feedId: "feed-1" }),
    );

    expect(address).toEqual({
      mode: "vault-shards-v2",
      address: "RSS Data/Feeds/feed-1.json",
    });
  });

  it("returns an empty address in shard mode when a feed has no feed ID yet", () => {
    const settings = cloneSettings();
    settings.storageMode = "vault-shards";

    const address = repository.getFeedLocalStorageAddress(
      settings,
      makeFeed({ feedId: "" }),
    );

    expect(address).toEqual({
      mode: "vault-shards",
      address: "",
    });
  });

  it("hydrates feed items from vault shards when shard storage is enabled", async () => {
    const settings = cloneSettings();
    settings.storageMode = "vault-shards";
    settings.storageFolder = "RSS Data/Feeds";
    settings.feeds = [
      makeFeed({
        feedId: "feed-1",
        items: [],
      }),
    ];

    await vaultAdapter(app).write(
      "RSS Data/Feeds/feed-1.json",
      JSON.stringify({
        version: 1,
        feedId: "feed-1",
        feedUrl: settings.feeds[0].url,
        updatedAt: Date.now(),
        items: [makeFeed().items[0]],
      }),
    );

    const result = await repository.hydrateSettings(settings);

    expect(result.shardCount).toBe(1);
    expect(settings.feeds[0].items).toHaveLength(1);
    expect(settings.feeds[0].items[0].guid).toBe(
      "https://example.com/articles/1",
    );
  });

  it.each(["vault-shards", "vault-shards-v2"] as const)(
    "binds final %s shard items to feedId before startup saved-note repair",
    async (storageMode) => {
      const settings = cloneSettings();
      settings.storageMode = storageMode;
      settings.storageFolder = "RSS Data/Feeds";
      settings.metadataStorageFolder = "RSS Metadata";
      settings.collection.savedNoteFolder = "Information/Saved";
      const feed = makeFeed({ feedId: "durable-feed-id", items: [] });
      settings.feeds = [feed];
      const shardItem = {
        ...makeFeed().items[0],
        link: "not-a-valid-url",
        guid: "offline-guid",
        saved: storageMode === "vault-shards",
        savedFilePath:
          storageMode === "vault-shards"
            ? "Information/Saved/Offline.md"
            : undefined,
      };
      delete shardItem.rssDashboardSourceId;
      await vaultAdapter(app).write(
        "RSS Data/Feeds/durable-feed-id.json",
        JSON.stringify({
          version: 1,
          feedId: "durable-feed-id",
          feedUrl: feed.url,
          updatedAt: Date.now(),
          items: [shardItem],
        }),
      );
      if (storageMode === "vault-shards-v2") {
        await vaultAdapter(app).write(
          "RSS Metadata/user-state.json",
          JSON.stringify({
            version: 1,
            states: {
              "offline-guid": {
                saved: true,
                savedFilePath: "Information/Saved/Offline.md",
              },
            },
          }),
        );
      }

      const result = await repository.hydrateSettings(settings);
      const hydrated = feed.items[0];
      expect(result.didChange).toBe(true);
      expect(hydrated.rssDashboardSourceId).toBe("durable-feed-id");
      expect(hydrated.saved).toBe(true);
      const persisted = await repository.persistSettings(settings, saveData);
      expect(persisted.shardWriteCount).toBe(1);
      const rewrittenShard = JSON.parse(
        await vaultAdapter(app).read(
          "RSS Data/Feeds/durable-feed-id.json",
        ),
      ) as { items: Array<{ rssDashboardSourceId?: string }> };
      expect(rewrittenShard.items[0].rssDashboardSourceId).toBe(
        "durable-feed-id",
      );

      const normalizedClone = JSON.parse(JSON.stringify(hydrated));
      delete normalizedClone.rssDashboardId;
      const expectedId = normalizeFeedItem(
        feed,
        normalizedClone,
        new Date("2026-07-22T00:00:00.000Z"),
      ).id;
      await app.vault.createFolder("Information/Saved");
      await app.vault.create(
        "Information/Saved/Offline.md",
        `---\nrssDashboardId: ${JSON.stringify(expectedId)}\n---\n\nBODY`,
      );
      const saver = new ArticleSaver(
        app,
        settings.articleSaving,
        undefined,
        settings.collection,
      );

      await saver.fixSavedFilePaths([hydrated]);

      expect(hydrated.rssDashboardId).toBe(expectedId);
      expect(hydrated.saved).toBe(true);
      expect(hydrated.savedFilePath).toBe("Information/Saved/Offline.md");
    },
  );

  it("writes only the changed feed shard for item-state updates", async () => {
    const settings = cloneSettings();
    settings.storageMode = "vault-shards";
    settings.storageFolder = "RSS Data/Feeds";
    settings.feeds = [
      makeFeed({ feedId: "feed-1", title: "Feed One" }),
      makeFeed({
        feedId: "feed-2",
        title: "Feed Two",
        url: "https://example.com/feed-two.xml",
        items: [
          {
            ...makeFeed().items[0],
            guid: "https://example.com/articles/2",
            link: "https://example.com/articles/2",
            feedUrl: "https://example.com/feed-two.xml",
            feedTitle: "Feed Two",
          },
        ],
      }),
    ];

    const writeSpy = vi.spyOn(app.vault.adapter, "write");

    await repository.persistSettings(settings, saveData, {
      forceAllShards: true,
      forceMetadata: true,
    });

    writeSpy.mockClear();
    saveData.mockClear();

    settings.feeds[0].items[0].read = true;

    const result = await repository.persistSettings(settings, saveData);

    expect(result.shardWriteCount).toBe(1);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy).toHaveBeenCalledWith(
      "RSS Data/Feeds/feed-1.json",
      expect.any(String),
    );
    expect(saveData).not.toHaveBeenCalled();
  });

  it("restores the prior shard generation when metadata persistence fails", async () => {
    const settings = cloneSettings();
    settings.storageMode = "vault-shards";
    settings.storageFolder = "RSS Data/Feeds";
    settings.feeds = [makeFeed({ feedId: "feed-rollback" })];

    await repository.persistSettings(settings, saveData, {
      forceAllShards: true,
      forceMetadata: true,
    });
    const oldShard = await vaultAdapter(app).read(
      "RSS Data/Feeds/feed-rollback.json",
    );

    settings.feeds[0].items[0].read = true;
    saveData.mockRejectedValueOnce(new Error("metadata unavailable"));

    await expect(
      repository.persistSettings(settings, saveData, {
        forceAllShards: true,
        forceMetadata: true,
      }),
    ).rejects.toThrow("metadata unavailable");

    expect(
      await vaultAdapter(app).read("RSS Data/Feeds/feed-rollback.json"),
    ).toBe(oldShard);
  });

  it("restores metadata, shards, and v2 user state when a later write fails", async () => {
    const settings = cloneSettings();
    settings.storageMode = "vault-shards-v2";
    settings.storageFolder = "RSS Data/Feeds";
    settings.metadataStorageFolder = "RSS Metadata";
    settings.feeds = [makeFeed({ feedId: "feed-rollback-all" })];
    let metadataBytes = "metadata-not-written";
    const transactionalSave = vi.fn(async (data: unknown) => {
      metadataBytes = JSON.stringify(data);
    });
    const metadataTransaction = {
      capture: vi.fn(async () => metadataBytes),
      restore: vi.fn(async (snapshot: unknown) => {
        metadataBytes = String(snapshot);
      }),
    };
    repository = new FeedStorageRepository(app, { metadataTransaction });

    await repository.persistSettings(settings, transactionalSave, {
      forceAllShards: true,
      forceMetadata: true,
    });
    const oldMetadata = metadataBytes;
    const oldShard = await vaultAdapter(app).read(
      "RSS Data/Feeds/feed-rollback-all.json",
    );
    const oldUserState = await vaultAdapter(app).read(
      "RSS Metadata/user-state.json",
    );

    settings.feeds[0].title = "Changed title";
    settings.feeds[0].items[0].read = true;
    const adapter = vaultAdapter(app);
    const originalWrite = adapter.write.bind(adapter);
    vi.spyOn(adapter, "write").mockImplementation(async (path, contents) => {
      if (
        path === "RSS Metadata/user-state.json" &&
        !contents.includes('"states": {}')
      ) {
        throw new Error("user state unavailable");
      }
      await originalWrite(path, contents);
    });

    await expect(
      repository.persistSettings(settings, transactionalSave, {
        forceAllShards: true,
        forceMetadata: true,
      }),
    ).rejects.toThrow("user state unavailable");

    expect(metadataBytes).toBe(oldMetadata);
    expect(
      await vaultAdapter(app).read("RSS Data/Feeds/feed-rollback-all.json"),
    ).toBe(oldShard);
    expect(
      await vaultAdapter(app).read("RSS Metadata/user-state.json"),
    ).toBe(oldUserState);
    expect(metadataTransaction.restore).toHaveBeenCalledTimes(1);

    const restarted = JSON.parse(metadataBytes) as RssDashboardSettings;
    const restartRepository = new FeedStorageRepository(app);
    await restartRepository.hydrateSettings(restarted);
    expect(restarted.feeds[0].title).toBe("Example Feed");
    expect(restarted.feeds[0].items[0].read).toBe(false);
  });

  it("attempts every rollback target and dirties caches when one restore fails", async () => {
    const settings = cloneSettings();
    settings.storageMode = "vault-shards";
    settings.storageFolder = "RSS Data/Feeds";
    settings.feeds = [
      makeFeed({ feedId: "feed-restore-one", title: "One" }),
      makeFeed({ feedId: "feed-restore-two", title: "Two" }),
    ];
    await repository.persistSettings(settings, saveData, {
      forceAllShards: true,
      forceMetadata: true,
    });
    const firstPath = "RSS Data/Feeds/feed-restore-one.json";
    const secondPath = "RSS Data/Feeds/feed-restore-two.json";
    const firstOld = await vaultAdapter(app).read(firstPath);
    const secondOld = await vaultAdapter(app).read(secondPath);
    settings.feeds[0].items[0].read = true;
    settings.feeds[1].items[0].read = true;

    const adapter = vaultAdapter(app);
    const originalWrite = adapter.write.bind(adapter);
    let failSecondRestore = true;
    const attemptedRestores: string[] = [];
    vi.spyOn(adapter, "write").mockImplementation(async (path, contents) => {
      if (contents === firstOld || contents === secondOld) {
        attemptedRestores.push(path);
      }
      if (path === secondPath && contents === secondOld && failSecondRestore) {
        throw new Error("restore unavailable");
      }
      await originalWrite(path, contents);
    });
    saveData.mockRejectedValueOnce(new Error("metadata unavailable"));

    await expect(
      repository.persistSettings(settings, saveData, {
        forceAllShards: true,
        forceMetadata: true,
      }),
    ).rejects.toBeInstanceOf(FeedStorageRollbackIncompleteError);
    expect(attemptedRestores).toEqual([secondPath, firstPath]);
    expect(await vaultAdapter(app).read(firstPath)).toBe(firstOld);
    expect(await vaultAdapter(app).read(secondPath)).not.toBe(secondOld);

    failSecondRestore = false;
    attemptedRestores.length = 0;
    const writeCountBeforeRetry = vi.mocked(adapter.write).mock.calls.length;
    await repository.persistSettings(settings, saveData);
    const retryWrites = vi.mocked(adapter.write).mock.calls
      .slice(writeCountBeforeRetry)
      .map(([path]) => path);
    expect(retryWrites).toEqual(expect.arrayContaining([firstPath, secondPath]));
  });

  it("removes a newly created shard when a later target fails", async () => {
    const settings = cloneSettings();
    settings.storageMode = "vault-shards";
    settings.storageFolder = "RSS Data/Feeds";
    settings.feeds = [makeFeed({ feedId: "feed-existing" })];
    await repository.persistSettings(settings, saveData, {
      forceAllShards: true,
      forceMetadata: true,
    });
    settings.feeds.push(makeFeed({
      feedId: "feed-new",
      title: "New",
      url: "https://example.com/new.xml",
    }));
    saveData.mockRejectedValueOnce(new Error("metadata unavailable"));

    await expect(
      repository.persistSettings(settings, saveData, { forceMetadata: true }),
    ).rejects.toThrow("metadata unavailable");

    expect(
      await app.vault.adapter.exists("RSS Data/Feeds/feed-new.json"),
    ).toBe(false);
  });

  it("restores exact legacy metadata targets when the second callback write fails", async () => {
    const settings = cloneSettings();
    settings.storageMode = "legacy-json";
    settings.feeds = [makeFeed({ feedId: "legacy-feed" })];
    let vaultData = "vault-old-bytes";
    let pluginPointer = "pointer-old-bytes";
    repository = new FeedStorageRepository(app, {
      metadataTransaction: {
        capture: async () => ({ vaultData, pluginPointer }),
        restore: async (snapshot) => {
          const old = snapshot as { vaultData: string; pluginPointer: string };
          vaultData = old.vaultData;
          pluginPointer = old.pluginPointer;
        },
      },
    });
    const failingSave = vi.fn(async () => {
      vaultData = "vault-new-bytes";
      throw new Error("pointer unavailable");
    });

    await expect(repository.persistSettings(settings, failingSave)).rejects.toThrow(
      "pointer unavailable",
    );

    expect(vaultData).toBe("vault-old-bytes");
    expect(pluginPointer).toBe("pointer-old-bytes");
  });

  it("raises typed incomplete rollback when legacy metadata cannot be restored", async () => {
    const settings = cloneSettings();
    settings.storageMode = "legacy-json";
    settings.feeds = [makeFeed({ feedId: "legacy-feed" })];
    repository = new FeedStorageRepository(app, {
      metadataTransaction: {
        capture: async () => "old-bytes",
        restore: async () => {
          throw new Error("restore unavailable");
        },
      },
    });

    await expect(
      repository.persistSettings(settings, async () => {
        throw new Error("metadata unavailable");
      }),
    ).rejects.toBeInstanceOf(FeedStorageRollbackIncompleteError);
  });

  it("migrates legacy settings to shard storage and strips items from persisted metadata", async () => {
    const settings = cloneSettings();
    settings.storageMode = "legacy-json";
    settings.storageFolder = "RSS Data/Feeds";
    settings.feeds = [makeFeed()];

    await repository.migrateToVaultShards(settings, saveData);

    expect(settings.storageMode).toBe("vault-shards");
    expect(settings.feeds[0].feedId).toBeTruthy();
    expect(saveData).toHaveBeenCalledTimes(1);
    expect(saveData.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        storageMode: "vault-shards",
        feeds: [
          expect.not.objectContaining({
            items: expect.anything() as unknown,
          }),
        ],
      }),
    );
  });

  it("migrates successfully when the storage folder already exists", async () => {
    const settings = cloneSettings();
    settings.storageMode = "legacy-json";
    settings.storageFolder = "RSS Data/Feeds";
    settings.feeds = [makeFeed({ feedId: "feed-1" })];

    await app.vault.createFolder("RSS Data/Feeds");

    await repository.migrateToVaultShards(settings, saveData);

    expect(settings.storageMode).toBe("vault-shards");
    expect(app.vault.getAbstractFileByPath("RSS Data/Feeds")).toBeTruthy();
    expect(await vaultAdapter(app).read("RSS Data/Feeds/feed-1.json")).toContain(
      "\"feedId\": \"feed-1\"",
    );
  });

  it("continues migration when createFolder throws but the folder exists afterward", async () => {
    const settings = cloneSettings();
    settings.storageMode = "legacy-json";
    settings.storageFolder = "RSS Data/Feeds";
    settings.feeds = [makeFeed({ feedId: "feed-1" })];

    const originalCreateFolder = app.vault.createFolder.bind(app.vault);
    const createFolderSpy = vi
      .spyOn(app.vault, "createFolder")
      .mockImplementationOnce(async (folderPath: string) => {
        await originalCreateFolder(folderPath);
        throw new Error("Folder already exists");
      });

    await repository.migrateToVaultShards(settings, saveData);

    expect(createFolderSpy).toHaveBeenCalledWith("RSS Data/Feeds");
    expect(settings.storageMode).toBe("vault-shards");
    expect(await vaultAdapter(app).read("RSS Data/Feeds/feed-1.json")).toContain(
      "\"feedId\": \"feed-1\"",
    );
  });

  it("continues migration when the adapter sees the folder but the vault cache does not", async () => {
    const settings = cloneSettings();
    settings.storageMode = "legacy-json";
    settings.storageFolder = "RSS Data/Feeds";
    settings.feeds = [makeFeed({ feedId: "feed-1" })];

    vi.spyOn(app.vault, "getAbstractFileByPath").mockReturnValue(null);
    vi.spyOn(app.vault, "createFolder").mockRejectedValueOnce(
      new Error("Folder already exists"),
    );
    const adapterWithExists = app.vault.adapter as unknown as { exists: (p: string) => Promise<boolean> };
    vi.spyOn(adapterWithExists, "exists").mockImplementation((path: string) => {
      if (path === "RSS Data/Feeds") {
        return Promise.resolve(true);
      }

      return Promise.resolve(false);
    });

    await repository.migrateToVaultShards(settings, saveData);

    expect(settings.storageMode).toBe("vault-shards");
    expect(saveData).toHaveBeenCalledTimes(1);
  });

  it("fails migration with a clear error when the storage path points to a file", async () => {
    const settings = cloneSettings();
    settings.storageMode = "legacy-json";
    settings.storageFolder = "RSS Data/Feeds";
    settings.feeds = [makeFeed({ feedId: "feed-1" })];

    await app.vault.create("RSS Data/Feeds", "not a folder");

    await expect(repository.migrateToVaultShards(settings, saveData)).rejects.toThrow(
      "Storage path points to a file, not a folder: RSS Data/Feeds",
    );
    expect(settings.storageMode).toBe("legacy-json");
  });

  it("keeps legacy mode when migration fails before persisting", async () => {
    const settings = cloneSettings();
    settings.storageMode = "legacy-json";
    settings.storageFolder = "RSS Data/Feeds";
    settings.feeds = [makeFeed({ feedId: "feed-1" })];

    vi.spyOn(app.vault, "createFolder").mockRejectedValueOnce(new Error("Disk full"));

    await expect(repository.migrateToVaultShards(settings, saveData)).rejects.toThrow(
      "Disk full",
    );

    expect(settings.storageMode).toBe("legacy-json");
    expect(saveData).not.toHaveBeenCalled();
  });

  it("repairs shards idempotently when the storage folder already exists", async () => {
    const settings = cloneSettings();
    settings.storageMode = "vault-shards";
    settings.storageFolder = "RSS Data/Feeds";
    settings.feeds = [makeFeed({ feedId: "feed-1" })];

    await app.vault.createFolder("RSS Data/Feeds");

    await repository.repairVaultShards(settings, saveData);
    saveData.mockClear();

    await expect(repository.repairVaultShards(settings, saveData)).resolves.toBeUndefined();
    expect(saveData).toHaveBeenCalledTimes(1);
  });

  it("reverts to legacy JSON without deleting shard files unless requested", async () => {
    const settings = cloneSettings();
    settings.storageMode = "vault-shards";
    settings.storageFolder = "RSS Data/Feeds";
    settings.feeds = [makeFeed({ feedId: "feed-1" })];

    await app.vault.createFolder("RSS Data/Feeds");
    await app.vault.create("RSS Data/Feeds/feed-1.json", "{\"items\":[]}");

    await repository.revertToLegacyJson(settings, saveData);

    expect(settings.storageMode).toBe("legacy-json");
    expect(app.vault.getAbstractFileByPath("RSS Data/Feeds")).toBeTruthy();
    expect(await vaultAdapter(app).read("RSS Data/Feeds/feed-1.json")).toContain(
      "\"items\":[]",
    );
  });

  it("deletes the shard folder when revert is requested with cleanup enabled", async () => {
    const settings = cloneSettings();
    settings.storageMode = "vault-shards";
    settings.storageFolder = "RSS Data/Feeds";
    settings.feeds = [makeFeed({ feedId: "feed-1" })];

    await app.vault.createFolder("RSS Data/Feeds/Nested");
    await app.vault.create("RSS Data/Feeds/feed-1.json", "{\"items\":[]}");
    await app.vault.create("RSS Data/Feeds/Nested/feed-2.json", "{\"items\":[]}");

    const rootFolder = app.vault.getAbstractFileByPath("RSS Data/Feeds");
    expect(rootFolder).toBeTruthy();

    await repository.revertToLegacyJson(settings, saveData, {
      deleteShardFolder: true,
    });

    expect(settings.storageMode).toBe("legacy-json");
    expect(app.vault.getAbstractFileByPath("RSS Data/Feeds")).toBeNull();
  });

  it("halts revert when the shard folder still exists after delete attempt", async () => {
    const settings = cloneSettings();
    settings.storageMode = "vault-shards";
    settings.storageFolder = "RSS Data/Feeds";
    settings.feeds = [makeFeed({ feedId: "feed-1" })];

    await app.vault.createFolder("RSS Data/Feeds");
    vi.spyOn(app.vault.adapter, "rmdir").mockResolvedValueOnce(undefined);
    const adapterWithExists2 = app.vault.adapter as unknown as { exists: (p: string) => Promise<boolean> };
    vi.spyOn(adapterWithExists2, "exists").mockImplementation((path: string) => {
      if (path === "RSS Data/Feeds") {
        return Promise.resolve(true);
      }

      return Promise.resolve(false);
    });

    await expect(
      repository.revertToLegacyJson(settings, saveData, {
        deleteShardFolder: true,
      }),
    ).rejects.toThrow("Shard folder still exists after delete attempt: RSS Data/Feeds");

    expect(settings.storageMode).toBe("vault-shards");
    expect(saveData).not.toHaveBeenCalled();
  });

  it("builds a portable bundle with metadata and shards", () => {
    const settings = cloneSettings();
    settings.storageMode = "vault-shards";
    settings.storageFolder = "RSS Data/Feeds";
    settings.feeds = [makeFeed({ feedId: "feed-1" })];

    const bundle = repository.buildPortableDataBundle(settings);

    expect(bundle.metadata.storageMode).toBe("vault-shards");
    expect(bundle.metadata.feeds[0]).not.toHaveProperty("items");
    expect(bundle.shards).toHaveLength(1);
    expect(bundle.markdownMirrorFallbackPlanned).toBe(true);
  });

  it("imports a portable bundle and restores metadata plus shard items", async () => {
    const settings = cloneSettings();
    settings.storageMode = "legacy-json";
    settings.storageFolder = "Legacy Data";
    settings.feeds = [makeFeed({ feedId: "old-feed", items: [] })];

    const bundle = {
      version: 1,
      exportedAt: Date.now(),
      storageMode: "vault-shards",
      metadata: {
        ...cloneSettings(),
        storageMode: "vault-shards",
        storageFolder: "Imported Data/Feeds",
        feeds: [
          {
            ...makeFeed({
              feedId: "feed-1",
              title: "Imported Feed",
              url: "https://example.com/imported.xml",
              items: [],
            }),
          },
        ].map((feed) => {
          const { items: _items, ...persisted } = feed;
          void _items;
          return persisted;
        }),
      },
      shards: [
        {
          version: 1,
          feedId: "feed-1",
          feedUrl: "https://example.com/imported.xml",
          updatedAt: Date.now(),
          items: [makeFeed().items[0]],
        },
      ],
      markdownMirrorFallbackPlanned: true,
    };

    await repository.importPortableDataBundle(bundle, settings, saveData);

    expect(settings.storageMode).toBe("vault-shards");
    expect(settings.storageFolder).toBe("Imported Data/Feeds");
    expect(settings.feeds).toHaveLength(1);
    expect(settings.feeds[0].feedId).toBe("feed-1");
    expect(settings.feeds[0].items).toHaveLength(1);
    expect(
      await vaultAdapter(app).read("Imported Data/Feeds/feed-1.json"),
    ).toContain('"feedId": "feed-1"');
  });

  it("rejects portable bundle imports with unsupported schema versions", async () => {
    const settings = cloneSettings();
    settings.storageMode = "legacy-json";
    settings.feeds = [makeFeed({ feedId: "feed-1" })];

    await expect(
      repository.importPortableDataBundle(
        {
          version: 999,
          exportedAt: Date.now(),
          storageMode: "vault-shards",
          metadata: {
            ...cloneSettings(),
            feeds: [],
          },
          shards: [],
          markdownMirrorFallbackPlanned: true,
        },
        settings,
        saveData,
      ),
    ).rejects.toThrow("Unsupported portable bundle version");
  });

  it("restores previous settings when import persistence fails", async () => {
    const settings = cloneSettings();
    settings.storageMode = "legacy-json";
    settings.storageFolder = "Legacy Data";
    settings.feeds = [makeFeed({ feedId: "legacy-feed" })];

    const bundle = {
      version: 1,
      exportedAt: Date.now(),
      storageMode: "vault-shards",
      metadata: {
        ...cloneSettings(),
        storageMode: "vault-shards",
        storageFolder: "Imported Data/Feeds",
        feeds: [
          {
            ...makeFeed({
              feedId: "feed-1",
              title: "Imported Feed",
              items: [],
            }),
          },
        ].map((feed) => {
          const { items: _items, ...persisted } = feed;
          void _items;
          return persisted;
        }),
      },
      shards: [
        {
          version: 1,
          feedId: "feed-1",
          feedUrl: "https://example.com/feed.xml",
          updatedAt: Date.now(),
          items: [makeFeed().items[0]],
        },
      ],
      markdownMirrorFallbackPlanned: true,
    };

    saveData
      .mockRejectedValueOnce(new Error("save failed"))
      .mockResolvedValue(undefined);

    await expect(
      repository.importPortableDataBundle(bundle, settings, saveData),
    ).rejects.toThrow("save failed");

    expect(settings.storageMode).toBe("legacy-json");
    expect(settings.storageFolder).toBe("Legacy Data");
    expect(settings.feeds[0].feedId).toBe("legacy-feed");
    expect(settings.feeds[0].items).toHaveLength(1);
  });
});
