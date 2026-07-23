import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { App, TFile } from "obsidian";
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
import type {
  ControlledPathIdentity,
  PathIdentityProvider,
} from "../../../src/security/path-identity-provider";
import { VaultPathIdentityProvider } from "../../../src/security/path-identity-provider";

interface VaultAdapterStub {
  exists(path: string): Promise<boolean>;
  write(path: string, content: string): Promise<void>;
  read(path: string): Promise<string>;
  remove(path: string): Promise<void>;
  rmdir(path: string, recursive: boolean): Promise<void>;
  process(
    path: string,
    update: (contents: string) => string,
  ): Promise<string>;
}

function vaultAdapter(app: App): VaultAdapterStub {
  return app.vault.adapter as unknown as VaultAdapterStub;
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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
  const temporaryRoots: string[] = [];

  beforeEach(() => {
    app = App.createMock();
    repository = new FeedStorageRepository(app);
    saveData = vi.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
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
      await app.vault.createFolder("RSS Data/Feeds");
      await app.vault.create(
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
        await app.vault.createFolder("RSS Metadata");
        await app.vault.create(
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

    const processSpy = vi.spyOn(vaultAdapter(app), "process");

    await repository.persistSettings(settings, saveData, {
      forceAllShards: true,
      forceMetadata: true,
    });

    processSpy.mockClear();
    saveData.mockClear();

    settings.feeds[0].items[0].read = true;

    const result = await repository.persistSettings(settings, saveData);

    expect(result.shardWriteCount).toBe(1);
    expect(processSpy).toHaveBeenCalledTimes(1);
    expect(processSpy).toHaveBeenCalledWith(
      "RSS Data/Feeds/feed-1.json",
      expect.any(Function),
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
    const metadataPath = "plugin-data.json";
    const metadataTransaction = {
      getTargetPaths: () => [metadataPath],
    };
    repository = new FeedStorageRepository(app, { metadataTransaction });
    const transactionalSave = vi.fn(async (data: unknown) => {
      const bytes = JSON.stringify(data);
      await repository.writeMetadataCandidate(
        metadataPath,
        bytes,
        async () => {
          if (await app.vault.adapter.exists(metadataPath)) {
            await app.vault.adapter.write(metadataPath, bytes);
          } else {
            await app.vault.create(metadataPath, bytes);
          }
        },
        (actual) => actual === bytes,
      );
    });

    await repository.persistSettings(settings, transactionalSave, {
      forceAllShards: true,
      forceMetadata: true,
    });
    const oldMetadata = await app.vault.adapter.read(metadataPath);
    const oldShard = await vaultAdapter(app).read(
      "RSS Data/Feeds/feed-rollback-all.json",
    );
    const oldUserState = await vaultAdapter(app).read(
      "RSS Metadata/user-state.json",
    );

    settings.feeds[0].title = "Changed title";
    settings.feeds[0].items[0].read = true;
    const adapter = vaultAdapter(app);
    const originalProcess = adapter.process.bind(adapter);
    vi.spyOn(adapter, "process").mockImplementation(
      async (path, update) => {
        if (path !== "RSS Metadata/user-state.json") {
          return originalProcess(path, update);
        }
        return originalProcess(path, (contents) => {
          const next = update(contents);
          if (!next.includes('"states": {}')) {
            throw new Error("user state unavailable");
          }
          return next;
        });
      },
    );

    await expect(
      repository.persistSettings(settings, transactionalSave, {
        forceAllShards: true,
        forceMetadata: true,
      }),
    ).rejects.toThrow("user state unavailable");

    expect(await app.vault.adapter.read(metadataPath)).toBe(oldMetadata);
    expect(
      await vaultAdapter(app).read("RSS Data/Feeds/feed-rollback-all.json"),
    ).toBe(oldShard);
    expect(
      await vaultAdapter(app).read("RSS Metadata/user-state.json"),
    ).toBe(oldUserState);
    const restarted = JSON.parse(
      await app.vault.adapter.read(metadataPath),
    ) as RssDashboardSettings;
    const restartRepository = new FeedStorageRepository(app);
    await restartRepository.hydrateSettings(restarted);
    expect(restarted.feeds[0].title).toBe("Example Feed");
    expect(restarted.feeds[0].items[0].read).toBe(false);
  });

  it("stops destructive rollback after the first CAS failure and dirties caches", async () => {
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
    const originalProcess = adapter.process.bind(adapter);
    let failSecondRestore = true;
    const attemptedRestores: string[] = [];
    vi.spyOn(adapter, "process").mockImplementation(async (path, update) => {
      const current = await adapter.read(path);
      const next = update(current);
      const isRestore =
        (path === firstPath && next === firstOld) ||
        (path === secondPath && next === secondOld);
      if (isRestore) attemptedRestores.push(path);
      if (isRestore && path === secondPath && failSecondRestore) {
        throw new Error("restore unavailable");
      }
      return originalProcess(path, () => next);
    });
    saveData.mockRejectedValueOnce(new Error("metadata unavailable"));

    await expect(
      repository.persistSettings(settings, saveData, {
        forceAllShards: true,
        forceMetadata: true,
      }),
    ).rejects.toBeInstanceOf(FeedStorageRollbackIncompleteError);
    expect(attemptedRestores).toEqual([secondPath]);
    expect(await vaultAdapter(app).read(firstPath)).not.toBe(firstOld);
    expect(await vaultAdapter(app).read(secondPath)).not.toBe(secondOld);

    failSecondRestore = false;
    attemptedRestores.length = 0;
    const processCountBeforeRetry =
      vi.mocked(adapter.process).mock.calls.length;
    await repository.persistSettings(settings, saveData);
    const retryWrites = vi.mocked(adapter.process).mock.calls
      .slice(processCountBeforeRetry)
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

  it("restores exact topology when a legacy-to-shards transaction fails after persistence", async () => {
    const previous = cloneSettings();
    previous.storageMode = "legacy-json";
    previous.storageFolder = "Candidate Storage/Feeds";
    previous.feeds = [];
    const candidate = cloneSettings();
    candidate.storageMode = "vault-shards";
    candidate.storageFolder = "Candidate Storage/Feeds";
    candidate.feeds = [makeFeed({ feedId: "candidate-feed" })];

    await expect(
      repository.persistSettingsTransaction(
        previous,
        candidate,
        saveData,
        async () => {
          throw new Error("after-persist-failed");
        },
        { forceAllShards: true, forceMetadata: true },
      ),
    ).rejects.toThrow("after-persist-failed");

    expect(
      await app.vault.adapter.exists(
        "Candidate Storage/Feeds/candidate-feed.json",
      ),
    ).toBe(false);
    expect(
      await app.vault.adapter.exists("Candidate Storage/Feeds"),
    ).toBe(false);
    expect(await app.vault.adapter.exists("Candidate Storage")).toBe(false);
  });

  it("restores exact shard bytes for add/remove rollback and preserves foreign files", async () => {
    const previous = cloneSettings();
    previous.storageMode = "vault-shards";
    previous.storageFolder = "RSS Data/Feeds";
    previous.feeds = [makeFeed({ feedId: "feed-old" })];
    await repository.persistSettings(previous, saveData, {
      forceAllShards: true,
      forceMetadata: true,
    });
    const oldPath = "RSS Data/Feeds/feed-old.json";
    const oldBytes = await vaultAdapter(app).read(oldPath);
    await app.vault.adapter.remove(oldPath);
    await app.vault.create(oldPath, oldBytes);
    await app.vault.create(
      "RSS Data/Feeds/foreign.json",
      "FOREIGN-BYTES",
    );

    const candidate = cloneSettings();
    candidate.storageMode = "vault-shards";
    candidate.storageFolder = previous.storageFolder;
    candidate.feeds = [
      makeFeed({
        feedId: "feed-new",
        title: "Candidate",
        url: "https://example.com/candidate.xml",
      }),
    ];

    await expect(
      repository.persistSettingsTransaction(
        previous,
        candidate,
        saveData,
        async () => {
          throw new Error("refresh-failed");
        },
        { forceAllShards: true, forceMetadata: true },
      ),
    ).rejects.toThrow("refresh-failed");

    expect(await vaultAdapter(app).read(oldPath)).toBe(oldBytes);
    expect(
      await app.vault.adapter.exists("RSS Data/Feeds/feed-new.json"),
    ).toBe(false);
    expect(
      await vaultAdapter(app).read("RSS Data/Feeds/foreign.json"),
    ).toBe("FOREIGN-BYTES");
  });

  it("removes v2 user-state and its candidate-created empty folder chain on rollback", async () => {
    const previous = cloneSettings();
    previous.storageMode = "vault-shards";
    previous.storageFolder = "RSS Data/Feeds";
    previous.feeds = [makeFeed({ feedId: "feed-v1" })];
    await repository.persistSettings(previous, saveData, {
      forceAllShards: true,
      forceMetadata: true,
    });
    const oldShard = await vaultAdapter(app).read(
      "RSS Data/Feeds/feed-v1.json",
    );

    const candidate = cloneSettings();
    Object.assign(candidate, previous, {
      storageMode: "vault-shards-v2",
      metadataStorageFolder: "Candidate Metadata/Nested",
    });
    candidate.feeds = cloneSettings().feeds;
    candidate.feeds = [
      makeFeed({
        feedId: "feed-v1",
        items: [
          {
            ...makeFeed().items[0],
            read: true,
          },
        ],
      }),
    ];

    await expect(
      repository.persistSettingsTransaction(
        previous,
        candidate,
        saveData,
        async () => {
          throw new Error("rebuild-failed");
        },
        { forceAllShards: true, forceMetadata: true },
      ),
    ).rejects.toThrow("rebuild-failed");

    expect(
      await vaultAdapter(app).read("RSS Data/Feeds/feed-v1.json"),
    ).toBe(oldShard);
    expect(
      await app.vault.adapter.exists(
        "Candidate Metadata/Nested/user-state.json",
      ),
    ).toBe(false);
    expect(
      await app.vault.adapter.exists("Candidate Metadata/Nested"),
    ).toBe(false);
    expect(
      await app.vault.adapter.exists("Candidate Metadata"),
    ).toBe(false);
  });

  it("does not delete an unknown file added under a candidate-created folder", async () => {
    const previous = cloneSettings();
    previous.storageMode = "legacy-json";
    previous.storageFolder = "Candidate Storage/Feeds";
    previous.feeds = [];
    const candidate = cloneSettings();
    candidate.storageMode = "vault-shards";
    candidate.storageFolder = previous.storageFolder;
    candidate.feeds = [makeFeed({ feedId: "candidate-feed" })];

    await expect(
      repository.persistSettingsTransaction(
        previous,
        candidate,
        saveData,
        async () => {
          await app.vault.adapter.write(
            "Candidate Storage/Feeds/foreign.txt",
            "FOREIGN-BYTES",
          );
          throw new Error("refresh-failed");
        },
        { forceAllShards: true, forceMetadata: true },
      ),
    ).rejects.toBeInstanceOf(FeedStorageRollbackIncompleteError);

    expect(
      await vaultAdapter(app).read(
        "Candidate Storage/Feeds/foreign.txt",
      ),
    ).toBe("FOREIGN-BYTES");
    expect(
      await app.vault.adapter.exists(
        "Candidate Storage/Feeds/candidate-feed.json",
      ),
    ).toBe(false);
  });

  it("raises typed rollback-incomplete when a candidate-created file cannot be removed", async () => {
    const previous = cloneSettings();
    previous.storageMode = "legacy-json";
    previous.storageFolder = "Candidate Storage/Feeds";
    previous.feeds = [];
    const candidate = cloneSettings();
    candidate.storageMode = "vault-shards";
    candidate.storageFolder = previous.storageFolder;
    candidate.feeds = [makeFeed({ feedId: "candidate-feed" })];
    const originalDelete = app.fileManager.trashFile.bind(app.fileManager);
    vi.spyOn(app.fileManager, "trashFile").mockImplementation(async (file) => {
      if (file.path === "Candidate Storage/Feeds/candidate-feed.json") {
        throw new Error("remove-failed");
      }
      await originalDelete(file);
    });

    await expect(
      repository.persistSettingsTransaction(
        previous,
        candidate,
        saveData,
        async () => {
          throw new Error("refresh-failed");
        },
        { forceAllShards: true, forceMetadata: true },
      ),
    ).rejects.toBeInstanceOf(FeedStorageRollbackIncompleteError);
  });

  it("serializes normal saves behind an active settings transaction", async () => {
    const previous = cloneSettings();
    previous.storageMode = "legacy-json";
    previous.feeds = [];
    const candidate = cloneSettings();
    candidate.storageMode = "legacy-json";
    candidate.locale = "en";
    candidate.feeds = [];
    const afterPersistStarted = createDeferred<void>();
    const releaseAfterPersist = createDeferred<void>();
    const events: string[] = [];

    const transaction = repository.persistSettingsTransaction(
      previous,
      candidate,
      async () => {
        events.push("transaction-write");
      },
      async () => {
        events.push("transaction-after");
        afterPersistStarted.resolve();
        await releaseAfterPersist.promise;
      },
      { forceMetadata: true },
    );
    await afterPersistStarted.promise;
    const normalSave = repository.persistSettings(
      previous,
      async () => {
        events.push("normal-write");
      },
      { forceMetadata: true },
    );
    await Promise.resolve();
    expect(events).toEqual([
      "transaction-write",
      "transaction-after",
    ]);

    releaseAfterPersist.resolve();
    await Promise.all([transaction, normalSave]);
    expect(events).toEqual([
      "transaction-write",
      "transaction-after",
      "normal-write",
    ]);
  });

  it("captures previous and candidate shard roots even when the repository cache is cold", async () => {
    const previous = cloneSettings();
    previous.storageMode = "vault-shards";
    previous.storageFolder = "Previous Storage/Feeds";
    previous.feeds = [makeFeed({ feedId: "previous-feed" })];
    await app.vault.createFolder(previous.storageFolder);
    await app.vault.create(
      "Previous Storage/Feeds/previous-feed.json",
      "PREVIOUS-BYTES",
    );
    const candidate = cloneSettings();
    candidate.storageMode = "vault-shards";
    candidate.storageFolder = "Candidate Storage/Feeds";
    candidate.feeds = [
      makeFeed({
        feedId: "candidate-feed",
        url: "https://example.com/candidate.xml",
      }),
    ];
    const exists = vi.spyOn(app.vault.adapter, "exists");

    await repository.persistSettingsTransaction(
      previous,
      candidate,
      saveData,
      async () => undefined,
      { forceAllShards: true, forceMetadata: true },
    );

    expect(exists).toHaveBeenCalledWith(
      "Previous Storage/Feeds/previous-feed.json",
    );
    expect(exists).toHaveBeenCalledWith(
      "Candidate Storage/Feeds/candidate-feed.json",
    );
  });

  it("fails closed before writing when two feeds alias the same shard path", async () => {
    const previous = cloneSettings();
    previous.storageMode = "legacy-json";
    previous.feeds = [];
    const candidate = cloneSettings();
    candidate.storageMode = "vault-shards";
    candidate.storageFolder = "RSS Data/Feeds";
    candidate.feeds = [
      makeFeed({ feedId: "duplicate-feed" }),
      makeFeed({
        feedId: "duplicate-feed",
        title: "Duplicate",
        url: "https://example.com/duplicate.xml",
      }),
    ];
    const write = vi.spyOn(app.vault.adapter, "write");

    await expect(
      repository.persistSettingsTransaction(
        previous,
        candidate,
        saveData,
        async () => undefined,
        { forceAllShards: true, forceMetadata: true },
      ),
    ).rejects.toBeInstanceOf(FeedStorageRollbackIncompleteError);

    expect(write).not.toHaveBeenCalled();
    expect(saveData).not.toHaveBeenCalled();
  });

  it("fails closed when a shard aliases the v2 user-state target", async () => {
    const previous = cloneSettings();
    previous.storageMode = "legacy-json";
    previous.feeds = [];
    const candidate = cloneSettings();
    candidate.storageMode = "vault-shards-v2";
    candidate.storageFolder = "RSS Data";
    candidate.metadataStorageFolder = "RSS Data";
    candidate.feeds = [
      makeFeed({ feedId: "user-state" }),
    ];
    const write = vi.spyOn(app.vault.adapter, "write");

    await expect(
      repository.persistSettingsTransaction(
        previous,
        candidate,
        saveData,
        async () => undefined,
        { forceAllShards: true, forceMetadata: true },
      ),
    ).rejects.toBeInstanceOf(FeedStorageRollbackIncompleteError);

    expect(write).not.toHaveBeenCalled();
    expect(saveData).not.toHaveBeenCalled();
  });

  it("fails closed when a shard aliases a metadata transaction target", async () => {
    repository = new FeedStorageRepository(app, {
      metadataTransaction: {
        getTargetPaths: () => ["RSS Data/data.json"],
        capture: async () => null,
        restore: async () => undefined,
      },
    });
    const previous = cloneSettings();
    previous.storageMode = "legacy-json";
    previous.feeds = [];
    const candidate = cloneSettings();
    candidate.storageMode = "vault-shards";
    candidate.storageFolder = "RSS Data";
    candidate.feeds = [makeFeed({ feedId: "data" })];
    const write = vi.spyOn(app.vault.adapter, "write");

    await expect(
      repository.persistSettingsTransaction(
        previous,
        candidate,
        saveData,
        async () => undefined,
        { forceAllShards: true, forceMetadata: true },
      ),
    ).rejects.toBeInstanceOf(FeedStorageRollbackIncompleteError);

    expect(write).not.toHaveBeenCalled();
    expect(saveData).not.toHaveBeenCalled();
  });

  it("fails closed without deletion when an existing folder identity is unknown", async () => {
    const previous = cloneSettings();
    previous.storageMode = "legacy-json";
    previous.feeds = [];
    const candidate = cloneSettings();
    candidate.storageMode = "vault-shards";
    candidate.storageFolder = "Alias/Feeds";
    candidate.feeds = [makeFeed({ feedId: "candidate-feed" })];
    const adapter = vaultAdapter(app);
    const originalExists = adapter.exists.bind(adapter);
    vi.spyOn(adapter, "exists").mockImplementation(async (path: string) => {
      if (path === "Alias" || path === "Alias/Feeds") return true;
      return originalExists(path);
    });
    const write = vi.spyOn(adapter, "write");
    const rmdir = vi.spyOn(adapter, "rmdir");

    await expect(
      repository.persistSettingsTransaction(
        previous,
        candidate,
        saveData,
        async () => undefined,
        { forceAllShards: true, forceMetadata: true },
      ),
    ).rejects.toBeInstanceOf(FeedStorageRollbackIncompleteError);

    expect(write).not.toHaveBeenCalled();
    expect(rmdir).not.toHaveBeenCalled();
  });

  it("restores exact legacy metadata targets when the second callback write fails", async () => {
    const settings = cloneSettings();
    settings.storageMode = "legacy-json";
    settings.feeds = [makeFeed({ feedId: "legacy-feed" })];
    const metadataPath = "data.json";
    await app.vault.create(metadataPath, "old-bytes");
    repository = new FeedStorageRepository(app, {
      metadataTransaction: {
        getTargetPaths: () => [metadataPath],
      },
    });
    const failingSave = vi.fn(async (data: unknown) => {
      const bytes = JSON.stringify(data);
      await repository.writeMetadataCandidate(
        metadataPath,
        bytes,
        () => app.vault.adapter.write(metadataPath, bytes),
        (actual) => actual === bytes,
      );
      throw new Error("pointer unavailable");
    });

    await expect(repository.persistSettings(settings, failingSave)).rejects.toThrow(
      "pointer unavailable",
    );

    expect(await app.vault.adapter.read(metadataPath)).toBe("old-bytes");
  });

  it("raises typed incomplete rollback and preserves external legacy metadata", async () => {
    const settings = cloneSettings();
    settings.storageMode = "legacy-json";
    settings.feeds = [makeFeed({ feedId: "legacy-feed" })];
    const metadataPath = "data.json";
    await app.vault.create(metadataPath, "old-bytes");
    repository = new FeedStorageRepository(app, {
      metadataTransaction: {
        getTargetPaths: () => [metadataPath],
      },
    });

    await expect(
      repository.persistSettings(settings, async (data: unknown) => {
        const bytes = JSON.stringify(data);
        await repository.writeMetadataCandidate(
          metadataPath,
          bytes,
          () => app.vault.adapter.write(metadataPath, bytes),
          (actual) => actual === bytes,
        );
        await app.vault.adapter.write(metadataPath, "EXTERNAL-METADATA");
        throw new Error("metadata unavailable");
      }),
    ).rejects.toBeInstanceOf(FeedStorageRollbackIncompleteError);
    expect(await app.vault.adapter.read(metadataPath)).toBe(
      "EXTERNAL-METADATA",
    );
  });

  it("does not invoke a metadata candidate writer after the captured preimage was externally changed", async () => {
    const metadataPath = "data.json";
    await app.vault.create(metadataPath, "PREVIOUS");
    repository = new FeedStorageRepository(app, {
      metadataTransaction: {
        getTargetPaths: () => [metadataPath],
      },
    });
    const settings = cloneSettings();
    settings.storageMode = "legacy-json";
    const candidateWrite = vi.fn(async () => {
      await app.vault.adapter.write(metadataPath, "CANDIDATE");
    });

    await expect(
      repository.persistSettings(settings, async () => {
        await app.vault.adapter.write(metadataPath, "EXTERNAL");
        await repository.writeMetadataCandidate(
          metadataPath,
          "CANDIDATE",
          candidateWrite,
          (actual) => actual === "CANDIDATE",
        );
      }),
    ).rejects.toBeInstanceOf(FeedStorageRollbackIncompleteError);

    expect(candidateWrite).not.toHaveBeenCalled();
    expect(await app.vault.adapter.read(metadataPath)).toBe("EXTERNAL");
  });

  it("rejects a file snapshot whose bytes drift between inspect-read-inspect", async () => {
    const metadataPath = "data.json";
    await app.vault.create(metadataPath, "PREVIOUS");
    const baseProvider = new VaultPathIdentityProvider(app);
    let targetInspections = 0;
    const provider: PathIdentityProvider = {
      inspect: async (path) => {
        if (path === metadataPath) {
          targetInspections += 1;
          if (targetInspections === 2) {
            await app.vault.adapter.write(path, "EXTERNAL");
          }
        }
        return baseProvider.inspect(path);
      },
      assertSafePaths: (paths) => baseProvider.assertSafePaths(paths),
      isSameIdentity: (expected, actual) =>
        baseProvider.isSameIdentity(expected, actual),
      createExclusive: (path, contents) =>
        baseProvider.createExclusive(path, contents),
      createOwnedDirectory: (path, markerName, markerContents) =>
        baseProvider.createOwnedDirectory(
          path,
          markerName,
          markerContents,
        ),
    };
    repository = new FeedStorageRepository(app, {
      metadataTransaction: {
        getTargetPaths: () => [metadataPath],
      },
      pathIdentityProvider: provider,
    });
    const settings = cloneSettings();
    settings.storageMode = "legacy-json";
    const candidateWrite = vi.fn(async () => {
      await app.vault.adapter.write(metadataPath, "CANDIDATE");
    });

    await expect(
      repository.persistSettings(settings, async () => {
        await repository.writeMetadataCandidate(
          metadataPath,
          "CANDIDATE",
          candidateWrite,
          (actual) => actual === "CANDIDATE",
        );
      }),
    ).rejects.toBeInstanceOf(FeedStorageRollbackIncompleteError);

    expect(candidateWrite).not.toHaveBeenCalled();
    expect(await app.vault.adapter.read(metadataPath)).toBe("EXTERNAL");
  });

  it("does not invoke a metadata candidate writer after a same-byte pre-write ABA", async () => {
    const metadataPath = "data.json";
    const previousFile = await app.vault.create(metadataPath, "PREVIOUS");
    repository = new FeedStorageRepository(app, {
      metadataTransaction: {
        getTargetPaths: () => [metadataPath],
      },
    });
    const settings = cloneSettings();
    settings.storageMode = "legacy-json";
    let replacement: TFile | undefined;
    const candidateWrite = vi.fn(async () => {
      await app.vault.adapter.write(metadataPath, "CANDIDATE");
    });

    await expect(
      repository.persistSettings(settings, async () => {
        await app.vault.delete(previousFile);
        replacement = await app.vault.create(metadataPath, "PREVIOUS");
        await repository.writeMetadataCandidate(
          metadataPath,
          "CANDIDATE",
          candidateWrite,
          (actual) => actual === "CANDIDATE",
        );
      }),
    ).rejects.toBeInstanceOf(FeedStorageRollbackIncompleteError);

    expect(candidateWrite).not.toHaveBeenCalled();
    expect(app.vault.getAbstractFileByPath(metadataPath)).toBe(replacement);
    expect(await app.vault.adapter.read(metadataPath)).toBe("PREVIOUS");
  });

  it("preserves an external shard rewrite instead of restoring over it", async () => {
    const previous = cloneSettings();
    previous.storageMode = "vault-shards";
    previous.storageFolder = "RSS Data/Feeds";
    previous.feeds = [makeFeed({ feedId: "shared-feed" })];
    await repository.persistSettings(previous, saveData, {
      forceAllShards: true,
      forceMetadata: true,
    });
    const candidate = cloneSettings();
    Object.assign(candidate, previous);
    candidate.feeds = [
      makeFeed({
        feedId: "shared-feed",
        title: "Candidate",
        items: [{ ...makeFeed().items[0], read: true }],
      }),
    ];
    const shardPath = "RSS Data/Feeds/shared-feed.json";

    await expect(
      repository.persistSettingsTransaction(
        previous,
        candidate,
        saveData,
        async () => {
          await app.vault.adapter.write(shardPath, "EXTERNAL-SHARD");
          throw new Error("publish failed");
        },
        { forceAllShards: true, forceMetadata: true },
      ),
    ).rejects.toBeInstanceOf(FeedStorageRollbackIncompleteError);
    expect(await app.vault.adapter.read(shardPath)).toBe("EXTERNAL-SHARD");
  });

  it.each(["bytes", "same-byte-aba"] as const)(
    "does not delete a removed shard after a pre-delete %s replacement",
    async (mode) => {
      const previous = cloneSettings();
      previous.storageMode = "vault-shards";
      previous.storageFolder = "RSS Data/Feeds";
      previous.feeds = [makeFeed({ feedId: "removed-before-delete" })];
      await repository.persistSettings(previous, saveData, {
        forceAllShards: true,
        forceMetadata: true,
      });
      const shardPath =
        "RSS Data/Feeds/removed-before-delete.json";
      const previousBytes = await app.vault.adapter.read(shardPath);
      const previousFile =
        app.vault.getAbstractFileByPath(shardPath);
      if (!(previousFile instanceof TFile)) {
        throw new Error("missing previous shard");
      }
      const originalGetAbstract =
        app.vault.getAbstractFileByPath.bind(app.vault);
      let targetLookups = 0;
      let replacement: TFile | undefined;
      vi.spyOn(app.vault, "getAbstractFileByPath").mockImplementation(
        (path: string) => {
          if (path === shardPath) {
            targetLookups += 1;
            if (targetLookups === 6) {
              if (mode === "bytes") {
                void app.vault.adapter.write(path, "EXTERNAL");
              } else {
                void app.vault.delete(previousFile);
                void app.vault.create(path, previousBytes).then((file) => {
                  replacement = file;
                });
              }
            }
          }
          return originalGetAbstract(path);
        },
      );
      const trashFile = vi.spyOn(app.fileManager, "trashFile");
      const candidate = cloneSettings();
      Object.assign(candidate, previous);
      candidate.feeds = [];

      await expect(
        repository.persistSettingsTransaction(
          previous,
          candidate,
          saveData,
          async () => undefined,
          { forceAllShards: true, forceMetadata: true },
        ),
      ).rejects.toBeInstanceOf(FeedStorageRollbackIncompleteError);

      expect(trashFile).not.toHaveBeenCalled();
      expect(await app.vault.adapter.read(shardPath)).toBe(
        mode === "bytes" ? "EXTERNAL" : previousBytes,
      );
      if (mode === "same-byte-aba") {
        expect(app.vault.getAbstractFileByPath(shardPath)).toBe(replacement);
      }
    },
  );

  it("does not claim a candidate-created file replaced before post-create verification", async () => {
    const baseProvider = new VaultPathIdentityProvider(app);
    let replacement: TFile | undefined;
    const provider: PathIdentityProvider = {
      inspect: (path) => baseProvider.inspect(path),
      assertSafePaths: (paths) => baseProvider.assertSafePaths(paths),
      isSameIdentity: (expected, actual) =>
        baseProvider.isSameIdentity(expected, actual),
      createExclusive: async (path, contents) => {
        const createdIdentity =
          await baseProvider.createExclusive(path, contents);
        if (path.endsWith("/candidate-feed.json")) {
          const created = app.vault.getAbstractFileByPath(path);
          if (!(created instanceof TFile)) {
            throw new Error("missing candidate file");
          }
          await app.vault.delete(created);
          replacement = await app.vault.create(path, contents);
        }
        return createdIdentity;
      },
      createOwnedDirectory: (path, markerName, markerContents) =>
        baseProvider.createOwnedDirectory(
          path,
          markerName,
          markerContents,
        ),
    };
    repository = new FeedStorageRepository(app, {
      pathIdentityProvider: provider,
    });
    const previous = cloneSettings();
    previous.storageMode = "legacy-json";
    previous.feeds = [];
    const candidate = cloneSettings();
    candidate.storageMode = "vault-shards";
    candidate.storageFolder = "Candidate/Feeds";
    candidate.feeds = [makeFeed({ feedId: "candidate-feed" })];
    const shardPath = "Candidate/Feeds/candidate-feed.json";

    await expect(
      repository.persistSettingsTransaction(
        previous,
        candidate,
        saveData,
        async () => {
          throw new Error("publish failed");
        },
        { forceAllShards: true, forceMetadata: true },
      ),
    ).rejects.toBeInstanceOf(FeedStorageRollbackIncompleteError);

    expect(app.vault.getAbstractFileByPath(shardPath)).toBe(replacement);
    expect(await app.vault.adapter.exists(shardPath)).toBe(true);
  });

  it("does not claim a candidate-created directory replaced before ownership verification", async () => {
    const originalCreateFolder =
      app.vault.createFolder.bind(app.vault);
    let replacement: unknown;
    vi.spyOn(app.vault, "createFolder").mockImplementation(
      async (path: string) => {
        const created = await originalCreateFolder(path);
        if (path === "Candidate/Feeds") {
          await app.vault.adapter.rmdir(path, false);
          replacement = await originalCreateFolder(path);
        }
        return created;
      },
    );
    const previous = cloneSettings();
    previous.storageMode = "legacy-json";
    previous.feeds = [];
    const candidate = cloneSettings();
    candidate.storageMode = "vault-shards";
    candidate.storageFolder = "Candidate/Feeds";
    candidate.feeds = [];

    await expect(
      repository.persistSettingsTransaction(
        previous,
        candidate,
        saveData,
        async () => {
          throw new Error("publish failed");
        },
        { forceAllShards: true, forceMetadata: true },
      ),
    ).rejects.toBeInstanceOf(FeedStorageRollbackIncompleteError);

    expect(app.vault.getAbstractFileByPath("Candidate/Feeds")).toBe(
      replacement,
    );
    expect(await app.vault.adapter.exists("Candidate/Feeds")).toBe(true);
  });

  it("does not delete a same-byte ABA replacement of a candidate-created shard", async () => {
    const previous = cloneSettings();
    previous.storageMode = "legacy-json";
    previous.feeds = [];
    const candidate = cloneSettings();
    candidate.storageMode = "vault-shards";
    candidate.storageFolder = "Candidate/Feeds";
    candidate.feeds = [makeFeed({ feedId: "candidate-feed" })];
    const shardPath = "Candidate/Feeds/candidate-feed.json";

    await expect(
      repository.persistSettingsTransaction(
        previous,
        candidate,
        saveData,
        async () => {
          const bytes = await app.vault.adapter.read(shardPath);
          await app.vault.adapter.remove(shardPath);
          await app.vault.create(shardPath, bytes);
          throw new Error("publish failed");
        },
        { forceAllShards: true, forceMetadata: true },
      ),
    ).rejects.toBeInstanceOf(FeedStorageRollbackIncompleteError);
    expect(await app.vault.adapter.exists(shardPath)).toBe(true);
  });

  it("does not remove a same-path ABA replacement of a candidate-created directory", async () => {
    const previous = cloneSettings();
    previous.storageMode = "legacy-json";
    previous.feeds = [];
    const candidate = cloneSettings();
    candidate.storageMode = "vault-shards";
    candidate.storageFolder = "Candidate/Feeds";
    candidate.feeds = [];

    await expect(
      repository.persistSettingsTransaction(
        previous,
        candidate,
        saveData,
        async () => {
          const contents =
            await app.vault.adapter.list("Candidate/Feeds");
          for (const markerPath of contents.files) {
            await app.vault.adapter.remove(markerPath);
          }
          await app.vault.adapter.rmdir("Candidate/Feeds", false);
          await app.vault.createFolder("Candidate/Feeds");
          throw new Error("publish failed");
        },
        { forceAllShards: true, forceMetadata: true },
      ),
    ).rejects.toBeInstanceOf(FeedStorageRollbackIncompleteError);
    expect(await app.vault.adapter.exists("Candidate/Feeds")).toBe(true);
  });

  it("rejects and rolls back a silently corrupted existing shard write", async () => {
    const settings = cloneSettings();
    settings.storageMode = "vault-shards";
    settings.storageFolder = "RSS Data/Feeds";
    settings.feeds = [makeFeed({ feedId: "corrupt-shard" })];
    await repository.persistSettings(settings, saveData, {
      forceAllShards: true,
      forceMetadata: true,
    });
    const shardPath = "RSS Data/Feeds/corrupt-shard.json";
    const previousBytes = await app.vault.adapter.read(shardPath);
    settings.feeds[0].title = "Candidate title";
    const adapter = vaultAdapter(app);
    const originalWrite = adapter.write.bind(adapter);
    const originalProcess = adapter.process.bind(adapter);
    let corruptedShardWrite = false;
    vi.spyOn(adapter, "write").mockImplementation(
      async (path, contents) =>
        originalWrite(
          path,
          path === shardPath && contents !== previousBytes
            ? contents.slice(0, 40)
            : contents,
        ),
    );
    vi.spyOn(adapter, "process").mockImplementation(
      async (path, update) =>
        originalProcess(
          path,
          (contents) => {
            const next = update(contents);
            if (path === shardPath && !corruptedShardWrite) {
              corruptedShardWrite = true;
              return next.slice(0, 40);
            }
            return next;
          },
        ),
    );

    await expect(
      repository.persistSettings(settings, saveData, {
        forceAllShards: true,
        forceMetadata: true,
      }),
    ).rejects.toThrow();
    expect(await app.vault.adapter.read(shardPath)).toBe(previousBytes);
  });

  it("rejects and rolls back a silently corrupted user-state write", async () => {
    const settings = cloneSettings();
    settings.storageMode = "vault-shards-v2";
    settings.storageFolder = "RSS Data/Feeds";
    settings.metadataStorageFolder = "RSS Metadata";
    settings.feeds = [makeFeed({ feedId: "corrupt-state" })];
    await repository.persistSettings(settings, saveData, {
      forceAllShards: true,
      forceMetadata: true,
    });
    const statePath = "RSS Metadata/user-state.json";
    const previousBytes = await app.vault.adapter.read(statePath);
    settings.feeds[0].items[0].read = true;
    const adapter = vaultAdapter(app);
    const originalWrite = adapter.write.bind(adapter);
    const originalProcess = adapter.process.bind(adapter);
    vi.spyOn(adapter, "write").mockImplementation(
      async (path, contents) =>
        originalWrite(
          path,
          path === statePath && contents !== previousBytes
            ? `${contents}CORRUPT`
            : contents,
        ),
    );
    vi.spyOn(adapter, "process").mockImplementation(
      async (path, update) =>
        originalProcess(
          path,
          (contents) => {
            const next = update(contents);
            return path === statePath && next !== previousBytes
              ? `${next}CORRUPT`
              : next;
          },
        ),
    );

    await expect(
      repository.persistSettings(settings, saveData, {
        forceAllShards: true,
        forceMetadata: true,
      }),
    ).rejects.toThrow();
    expect(await app.vault.adapter.read(statePath)).toBe(previousBytes);
  });

  it("rejects and rolls back metadata when the callback silently writes a non-candidate postimage", async () => {
    const metadataPath = "data.json";
    await app.vault.create(metadataPath, "PREVIOUS");
    repository = new FeedStorageRepository(app, {
      metadataTransaction: {
        getTargetPaths: () => [metadataPath],
      },
    });
    const settings = cloneSettings();
    settings.storageMode = "legacy-json";

    await expect(
      repository.persistSettings(settings, async () => {
        await repository.writeMetadataCandidate(
          metadataPath,
          "CANDIDATE",
          () => app.vault.adapter.write(metadataPath, "TRUNCATED"),
          (actual) => actual === "CANDIDATE",
        );
      }),
    ).rejects.toThrow();
    expect(await app.vault.adapter.read(metadataPath)).toBe("PREVIOUS");
  });

  it("verifies the complete candidate write-set before running the publish callback", async () => {
    const previous = cloneSettings();
    previous.storageMode = "vault-shards";
    previous.storageFolder = "RSS Data/Feeds";
    previous.feeds = [makeFeed({ feedId: "verify-before-publish" })];
    await repository.persistSettings(previous, saveData, {
      forceAllShards: true,
      forceMetadata: true,
    });
    const candidate = cloneSettings();
    Object.assign(candidate, previous);
    candidate.feeds = [
      makeFeed({
        feedId: "verify-before-publish",
        title: "Candidate",
      }),
    ];
    const shardPath =
      "RSS Data/Feeds/verify-before-publish.json";
    const publish = vi.fn(async () => undefined);

    await expect(
      repository.persistSettingsTransaction(
        previous,
        candidate,
        async () => {
          await app.vault.adapter.write(shardPath, "EXTERNAL-AFTER-WRITE");
        },
        publish,
        { forceAllShards: true, forceMetadata: true },
      ),
    ).rejects.toBeInstanceOf(FeedStorageRollbackIncompleteError);

    expect(publish).not.toHaveBeenCalled();
    expect(await app.vault.adapter.read(shardPath)).toBe(
      "EXTERNAL-AFTER-WRITE",
    );
  });

  it("does not overwrite an externally recreated deleted shard", async () => {
    const previous = cloneSettings();
    previous.storageMode = "vault-shards";
    previous.storageFolder = "RSS Data/Feeds";
    previous.feeds = [makeFeed({ feedId: "removed-feed" })];
    await repository.persistSettings(previous, saveData, {
      forceAllShards: true,
      forceMetadata: true,
    });
    const shardPath = "RSS Data/Feeds/removed-feed.json";
    const candidate = cloneSettings();
    Object.assign(candidate, previous);
    candidate.feeds = [];

    await expect(
      repository.persistSettingsTransaction(
        previous,
        candidate,
        saveData,
        async () => {
          await app.vault.create(shardPath, "EXTERNAL-RECREATION");
          throw new Error("publish failed");
        },
        { forceAllShards: true, forceMetadata: true },
      ),
    ).rejects.toBeInstanceOf(FeedStorageRollbackIncompleteError);
    expect(await app.vault.adapter.read(shardPath)).toBe(
      "EXTERNAL-RECREATION",
    );
  });

  it("fails closed without destructive cleanup when a virtual adapter has no file identity", async () => {
    const previous = cloneSettings();
    previous.storageMode = "legacy-json";
    previous.feeds = [];
    const candidate = cloneSettings();
    candidate.storageMode = "vault-shards";
    candidate.storageFolder = "Virtual/Feeds";
    candidate.feeds = [makeFeed({ feedId: "candidate-feed" })];
    const shardPath = "Virtual/Feeds/candidate-feed.json";
    const adapter = app.vault.adapter as unknown as {
      getBasePath?: () => string;
      getFullPath?: (path: string) => string;
    };
    delete adapter.getBasePath;
    delete adapter.getFullPath;
    const originalCreate = app.vault.create.bind(app.vault);
    vi.spyOn(app.vault, "create").mockImplementation(
      async (path: string, contents: string) => {
        if (path !== shardPath) {
          return originalCreate(path, contents);
        }
        await app.vault.adapter.write(path, contents);
        return new TFile(path);
      },
    );

    await expect(
      repository.persistSettingsTransaction(
        previous,
        candidate,
        saveData,
        async () => {
          throw new Error("publish failed");
        },
        { forceAllShards: true, forceMetadata: true },
      ),
    ).rejects.toBeInstanceOf(FeedStorageRollbackIncompleteError);
    expect(await app.vault.adapter.exists(shardPath)).toBe(true);
  });

  it("does not overwrite a symlink-like generic virtual target without trusted object-generation semantics", async () => {
    const metadataPath = "Alias/data.json";
    await app.vault.createFolder("Alias");
    await app.vault.create(metadataPath, "PREVIOUS");
    const adapter = app.vault.adapter as unknown as {
      getBasePath?: () => string;
      getFullPath?: (path: string) => string;
    };
    delete adapter.getBasePath;
    delete adapter.getFullPath;
    vi.spyOn(app.vault, "getAbstractFileByPath").mockImplementation(
      () => null,
    );
    repository = new FeedStorageRepository(app, {
      metadataTransaction: {
        getTargetPaths: () => [metadataPath],
      },
    });
    const settings = cloneSettings();
    settings.storageMode = "legacy-json";
    const candidateWrite = vi.fn(async () => {
      await app.vault.adapter.write(metadataPath, "CANDIDATE");
    });

    await expect(
      repository.persistSettings(settings, async () => {
        await repository.writeMetadataCandidate(
          metadataPath,
          "CANDIDATE",
          candidateWrite,
          (actual) => actual === "CANDIDATE",
        );
      }),
    ).rejects.toBeInstanceOf(FeedStorageRollbackIncompleteError);

    expect(candidateWrite).not.toHaveBeenCalled();
    expect(await app.vault.adapter.read(metadataPath)).toBe("PREVIOUS");
  });

  it("fails closed when an identity-less existing path was journaled even if its bytes match the preimage", async () => {
    const metadataPath = "data.json";
    await app.vault.adapter.write(metadataPath, "unchanged-bytes");
    repository = new FeedStorageRepository(app, {
      metadataTransaction: {
        getTargetPaths: () => [metadataPath],
      },
    });
    const settings = cloneSettings();
    settings.storageMode = "legacy-json";

    await expect(
      repository.persistSettings(settings, async () => {
        await repository.writeMetadataCandidate(
          metadataPath,
          "unchanged-bytes",
          () =>
            app.vault.adapter.write(metadataPath, "unchanged-bytes"),
          (actual) => actual === "unchanged-bytes",
        );
        throw new Error("publish failed");
      }),
    ).rejects.toBeInstanceOf(FeedStorageRollbackIncompleteError);
    expect(await app.vault.adapter.read(metadataPath)).toBe(
      "unchanged-bytes",
    );
  });

  it("deletes an adapter-visible cacheless shard only when its injected desktop identity is safe", async () => {
    const identityTokenByPath = new Map<string, object>();
    const identityProvider: PathIdentityProvider = {
      inspect: async (path: string): Promise<ControlledPathIdentity> => {
        const exists = await app.vault.adapter.exists(path);
        if (!exists) {
          return {
            path,
            namespaceKey: path.toLocaleLowerCase("en-US"),
            kind: "missing",
            destructiveSafe: true,
          };
        }
        let token = identityTokenByPath.get(path);
        if (!token) {
          token = {};
          identityTokenByPath.set(path, token);
        }
        return {
          path,
          namespaceKey: path.toLocaleLowerCase("en-US"),
          kind: path.endsWith(".json") ? "file" : "directory",
          token,
          destructiveSafe: true,
        };
      },
      assertSafePaths: async (paths) => {
        const identities = new Map<string, ControlledPathIdentity>();
        for (const path of paths) {
          identities.set(path, await identityProvider.inspect(path));
        }
        return identities;
      },
      isSameIdentity: (expected, actual) =>
        expected.path === actual.path &&
        expected.kind === actual.kind &&
        expected.token === actual.token,
      createExclusive: async (path, contents) => {
        if (await app.vault.adapter.exists(path)) {
          throw new Error("Path already exists");
        }
        await app.vault.create(path, contents);
        return identityProvider.inspect(path);
      },
      createOwnedDirectory: async (
        path,
        markerName,
        markerContents,
      ) => {
        if (await app.vault.adapter.exists(path)) {
          throw new Error("Path already exists");
        }
        await app.vault.createFolder(path);
        const identity = await identityProvider.inspect(path);
        const markerPath = `${path}/${markerName}`;
        const markerIdentity =
          await identityProvider.createExclusive(
            markerPath,
            markerContents,
          );
        return {
          identity,
          markerPath,
          markerContents,
          markerIdentity,
        };
      },
    };
    repository = new FeedStorageRepository(app, {
      pathIdentityProvider: identityProvider,
    });
    const previous = cloneSettings();
    previous.storageMode = "vault-shards";
    previous.storageFolder = "RSS Data/Feeds";
    previous.feeds = [makeFeed({ feedId: "cacheless-feed" })];
    await repository.persistSettings(previous, saveData, {
      forceAllShards: true,
      forceMetadata: true,
    });
    const shardPath = "RSS Data/Feeds/cacheless-feed.json";
    const getAbstractFileByPath =
      app.vault.getAbstractFileByPath.bind(app.vault);
    vi.spyOn(app.vault, "getAbstractFileByPath").mockImplementation(
      (path: string) =>
        path === shardPath ? null : getAbstractFileByPath(path),
    );
    const remove = vi.spyOn(vaultAdapter(app), "remove");
    const candidate = cloneSettings();
    candidate.storageMode = "vault-shards";
    candidate.storageFolder = "RSS Data/Feeds";
    candidate.feeds = [];

    await repository.persistSettingsTransaction(
      previous,
      candidate,
      saveData,
      async () => undefined,
      { forceAllShards: true, forceMetadata: true },
    );

    expect(remove).toHaveBeenCalledWith(shardPath);
    expect(await app.vault.adapter.exists(shardPath)).toBe(false);
  });

  it("uses real desktop identities for a cacheless create-write-delete cycle and removes ownership markers", async () => {
    const root = await mkdtemp(
      nodePath.join(tmpdir(), "rss-storage-desktop-"),
    );
    temporaryRoots.push(root);
    const fullPath = (controlledPath: string): string =>
      nodePath.join(root, controlledPath);
    const exists = async (controlledPath: string): Promise<boolean> => {
      try {
        await stat(fullPath(controlledPath));
        return true;
      } catch {
        return false;
      }
    };
    const adapter = {
      getBasePath: () => root,
      getFullPath: fullPath,
      exists,
      read: (controlledPath: string) =>
        readFile(fullPath(controlledPath), "utf8"),
      write: (controlledPath: string, contents: string) =>
        writeFile(fullPath(controlledPath), contents, "utf8"),
      process: async (
        controlledPath: string,
        update: (contents: string) => string,
      ) => {
        const current = await readFile(
          fullPath(controlledPath),
          "utf8",
        );
        const next = update(current);
        await writeFile(fullPath(controlledPath), next, "utf8");
        return next;
      },
      remove: (controlledPath: string) =>
        unlink(fullPath(controlledPath)),
      mkdir: (controlledPath: string) =>
        mkdir(fullPath(controlledPath)),
      list: async (controlledPath: string) => {
        const entries = await readdir(fullPath(controlledPath), {
          withFileTypes: true,
        });
        return {
          files: entries
            .filter((entry) => entry.isFile())
            .map((entry) => `${controlledPath}/${entry.name}`),
          folders: entries
            .filter((entry) => entry.isDirectory())
            .map((entry) => `${controlledPath}/${entry.name}`),
        };
      },
      rmdir: async (controlledPath: string, recursive: boolean) => {
        if (recursive) {
          await rm(fullPath(controlledPath), {
            recursive: true,
            force: false,
          });
          return;
        }
        await rmdir(fullPath(controlledPath));
      },
    };
    const desktopApp = {
      vault: {
        adapter,
        getAbstractFileByPath: () => null,
        create: async () => {
          throw new Error("Vault cache create must not be used");
        },
        createFolder: async () => {
          throw new Error("Vault cache folder create must not be used");
        },
      },
      fileManager: {
        trashFile: async () => {
          throw new Error("Cacheless delete must use the adapter");
        },
      },
    } as unknown as App;
    const desktopRepository =
      new FeedStorageRepository(desktopApp);
    const previous = cloneSettings();
    previous.storageMode = "legacy-json";
    previous.feeds = [];
    const candidate = cloneSettings();
    candidate.storageMode = "vault-shards";
    candidate.storageFolder = "Desktop/Feeds";
    candidate.feeds = [
      makeFeed({ feedId: "desktop-cacheless" }),
    ];
    const shardPath = "Desktop/Feeds/desktop-cacheless.json";

    await desktopRepository.persistSettingsTransaction(
      previous,
      candidate,
      async () => undefined,
      async () => undefined,
      { forceAllShards: true, forceMetadata: true },
    );

    expect(await exists(shardPath)).toBe(true);
    const createdEntries = await readdir(fullPath("Desktop/Feeds"));
    expect(
      createdEntries.some((entry) =>
        entry.startsWith(".rss-dashboard-owner-"),
      ),
    ).toBe(false);

    const removed = cloneSettings();
    Object.assign(removed, candidate);
    removed.feeds = [];
    await desktopRepository.persistSettingsTransaction(
      candidate,
      removed,
      async () => undefined,
      async () => undefined,
      { forceAllShards: true, forceMetadata: true },
    );

    expect(await exists(shardPath)).toBe(false);
  });

  it.each([
    "/RSS/Feeds",
    "C:/RSS/Feeds",
    "\\\\server\\share\\Feeds",
    "RSS/Feeds ",
    "RSS/e\u0301",
  ])("rejects unsafe storage path %s before any write", async (storageFolder) => {
    const previous = cloneSettings();
    previous.storageMode = "legacy-json";
    previous.feeds = [];
    const candidate = cloneSettings();
    candidate.storageMode = "vault-shards";
    candidate.storageFolder = storageFolder;
    candidate.feeds = [makeFeed({ feedId: "candidate-feed" })];
    const write = vi.spyOn(app.vault.adapter, "write");

    await expect(
      repository.persistSettingsTransaction(
        previous,
        candidate,
        saveData,
        async () => undefined,
      ),
    ).rejects.toBeInstanceOf(FeedStorageRollbackIncompleteError);
    expect(write).not.toHaveBeenCalled();
    expect(saveData).not.toHaveBeenCalled();
  });

  it("rejects case-fold aliases between shard and metadata roots", async () => {
    const previous = cloneSettings();
    previous.storageMode = "legacy-json";
    previous.feeds = [];
    const candidate = cloneSettings();
    candidate.storageMode = "vault-shards-v2";
    candidate.storageFolder = "RSS/Feeds";
    candidate.metadataStorageFolder = "rss";
    candidate.feeds = [makeFeed({ feedId: "candidate-feed" })];

    await expect(
      repository.persistSettingsTransaction(
        previous,
        candidate,
        saveData,
        async () => undefined,
      ),
    ).rejects.toBeInstanceOf(FeedStorageRollbackIncompleteError);
    expect(saveData).not.toHaveBeenCalled();
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

  it("fails closed when createFolder throws after creating an unowned folder", async () => {
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

    await expect(
      repository.migrateToVaultShards(settings, saveData),
    ).rejects.toBeInstanceOf(FeedStorageRollbackIncompleteError);

    expect(createFolderSpy).toHaveBeenCalledWith("RSS Data");
    expect(settings.storageMode).toBe("legacy-json");
    expect(await app.vault.adapter.exists("RSS Data")).toBe(true);
    expect(saveData).not.toHaveBeenCalled();
  });

  it("fails closed when a virtual adapter sees a folder without object identity", async () => {
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

    await expect(
      repository.migrateToVaultShards(settings, saveData),
    ).rejects.toBeInstanceOf(FeedStorageRollbackIncompleteError);
    expect(settings.storageMode).toBe("legacy-json");
    expect(saveData).not.toHaveBeenCalled();
  });

  it("fails migration closed before writing when the storage path points to a file", async () => {
    const settings = cloneSettings();
    settings.storageMode = "legacy-json";
    settings.storageFolder = "RSS Data/Feeds";
    settings.feeds = [makeFeed({ feedId: "feed-1" })];

    await app.vault.create("RSS Data/Feeds", "not a folder");

    await expect(
      repository.migrateToVaultShards(settings, saveData),
    ).rejects.toBeInstanceOf(FeedStorageRollbackIncompleteError);
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

  it("canonicalizes legacy portable settings exactly once before persistence", () => {
    const current = cloneSettings();
    const legacyMetadata = {
      ...cloneSettings(),
      feeds: [],
      savePath: "Legacy Saved",
      template: "# Legacy template",
      addSavedTag: false,
      filters: {
        includeLogic: "OR",
        bypassAll: true,
        rules: [{ type: "include", text: "AI" }],
      },
      media: {
        ...cloneSettings().media,
        autoTagVideos: false,
        defaultVideoTag: undefined,
      },
      display: {
        ...cloneSettings().display,
        useDomainFavicons: true,
      },
    };
    const bundle = {
      version: 1,
      exportedAt: Date.now(),
      storageMode: "legacy-json",
      metadata: legacyMetadata,
      shards: [],
      markdownMirrorFallbackPlanned: true,
    };

    const candidate = repository.buildPortableDataBundleCandidate(
      bundle,
      current,
    );
    const candidateRecord =
      candidate as unknown as Record<string, unknown>;

    expect(candidateRecord).not.toHaveProperty("savePath");
    expect(candidateRecord).not.toHaveProperty("template");
    expect(candidateRecord).not.toHaveProperty("addSavedTag");
    expect(candidateRecord).not.toHaveProperty("filters");
    expect(candidate.articleSaving.defaultFolder).toBe("Legacy Saved");
    expect(candidate.articleSaving.defaultTemplate).toBe(
      "# Legacy template",
    );
    expect(candidate.articleSaving.addSavedTag).toBe(false);
    expect(candidate.keywordRules.includeLogic).toBe("OR");
    expect(candidate.keywordRules.bypassAll).toBe(true);
    expect(candidate.media.defaultVideoTag).toBe("");
    expect(candidate.display.useDomainIconsRss).toBe(true);
    expect(
      candidate.display as unknown as Record<string, unknown>,
    ).not.toHaveProperty("useDomainFavicons");
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
