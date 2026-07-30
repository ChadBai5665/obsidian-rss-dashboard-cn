import { beforeEach, describe, expect, it, vi } from "vitest";
import { App, type PluginManifest } from "obsidian";
import RssDashboardPlugin from "../../../main";
import { DEFAULT_SETTINGS, type Feed } from "../../../src/types/types";
import { OperationJournalService } from "../../../src/operation-journal/operation-journal-service";
import type {
  OperationBeginInput,
  OperationJournalPort,
  OperationJournalScope,
} from "../../../src/operation-journal/operation-journal-service";
import type { SubscriptionService } from "../../../src/services/subscription-service";

function manifest(): PluginManifest {
  return {
    id: "rss-dashboard",
    name: "RSS Dashboard",
    version: "1.0.0",
    author: "Test",
    description: "Test plugin",
    dir: ".",
  };
}

function persistedFeed(): Feed {
  return {
    feedId: "feed-1",
    sourceKind: "feed",
    sourceConfig: { kind: "feed" },
    title: "Persisted source",
    url: "https://example.com/feed.xml",
    folder: "",
    items: [],
    lastUpdated: 1,
    subscriptionStatus: "active",
  };
}

interface SubscriptionWiringApi {
  settings: typeof DEFAULT_SETTINGS;
  getOperationJournalPort(): OperationJournalPort | undefined;
  getSubscriptionService(): SubscriptionService;
  getCollectionService(): {
    collectFeedRefresh(): Promise<unknown>;
    removeSource(): Promise<never>;
  };
  persistSubscriptionSettingsCandidate(
    candidate: { feeds: Feed[] },
    publish: () => void,
  ): Promise<void>;
  feedStorageRepository: {
    persistSettings(): Promise<unknown>;
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function persistedResult() {
  return {
    metadataSaved: true,
    shardWriteCount: 0,
    shardDeleteCount: 0,
  };
}

function prepareMutationPlugin() {
  const plugin = new RssDashboardPlugin(App.createMock(), manifest());
  plugin.settings = structuredClone(DEFAULT_SETTINGS);
  plugin.settings.feeds = [persistedFeed()];
  const api = plugin as unknown as SubscriptionWiringApi;
  api.getCollectionService = vi.fn(() => ({
    collectFeedRefresh: async () => [],
    removeSource: async () => { throw new Error("unused"); },
  }));
  api.persistSubscriptionSettingsCandidate = vi.fn(
    async (_candidate, publish) => publish(),
  );
  return { plugin, api };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("subscription operation journal composition", () => {
  it("passes the current optional journal port into each SubscriptionService without composing a runtime", async () => {
    const plugin = new RssDashboardPlugin(App.createMock(), manifest());
    plugin.settings = structuredClone(DEFAULT_SETTINGS);
    plugin.settings.feeds = [persistedFeed()];
    const api = plugin as unknown as SubscriptionWiringApi;
    const started: OperationBeginInput[] = [];
    const scope: OperationJournalScope = {
      operationId: "subscription-operation-1",
      progress: async () => undefined,
      succeed: async () => undefined,
      fail: async () => undefined,
      abort: async () => undefined,
    };
    const port: OperationJournalPort = {
      begin: (input) => {
        started.push(input);
        return scope;
      },
      attach: () => scope,
    };
    const getPort = vi.fn(() => port);
    api.getOperationJournalPort = getPort;
    api.getCollectionService = vi.fn(() => ({
      collectFeedRefresh: async () => [],
      removeSource: async () => { throw new Error("unused"); },
    }));
    api.persistSubscriptionSettingsCandidate = vi.fn(async (_candidate, publish) => {
      publish();
    });

    const service = api.getSubscriptionService();
    await service.setPaused("feed-1", true);

    expect(getPort).toHaveBeenCalledOnce();
    expect(started).toEqual([
      expect.objectContaining({
        category: "subscription",
        action: "pause",
        subject: { sourceId: "feed-1", label: "Persisted source" },
      }),
    ]);
  });

  it("resolves journal B only when a service queued during save B starts mutating", async () => {
    const test = prepareMutationPlugin();
    const journalA = test.api.getOperationJournalPort();
    const pending = deferred<ReturnType<typeof persistedResult>>();
    const persist = vi.spyOn(test.api.feedStorageRepository, "persistSettings")
      .mockReturnValue(pending.promise);
    const begin = vi.spyOn(OperationJournalService.prototype, "begin");
    test.plugin.settings.collection.dataFolder = ".queued-subscription-b";
    const saving = test.plugin.saveSettings();
    await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce());
    const service = test.api.getSubscriptionService();
    const mutation = service.setPaused("feed-1", true);
    await Promise.resolve();
    expect(begin).not.toHaveBeenCalled();

    pending.resolve(persistedResult());
    await saving;
    await mutation;

    const journalB = test.api.getOperationJournalPort();
    expect(journalB).not.toBe(journalA);
    expect(begin.mock.instances).toEqual([journalB]);
  });

  it("resolves journal A after a queued save B rejects", async () => {
    const test = prepareMutationPlugin();
    const journalA = test.api.getOperationJournalPort();
    const realGetPort = test.api.getOperationJournalPort.bind(test.api);
    const getPort = vi.spyOn(test.api, "getOperationJournalPort")
      .mockImplementation(() => realGetPort());
    const pending = deferred<ReturnType<typeof persistedResult>>();
    const persist = vi.spyOn(test.api.feedStorageRepository, "persistSettings")
      .mockReturnValue(pending.promise);
    const begin = vi.spyOn(OperationJournalService.prototype, "begin");
    test.plugin.settings.collection.dataFolder = ".rejected-subscription-b";
    const saving = test.plugin.saveSettings();
    await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce());
    const service = test.api.getSubscriptionService();
    const mutation = service.setPaused("feed-1", true);
    const callsBeforeRelease = getPort.mock.calls.length;

    pending.reject(new Error("save-b-rejected"));
    await expect(saving).rejects.toThrow("save-b-rejected");
    await mutation;

    expect(callsBeforeRelease).toBe(0);
    expect(getPort.mock.calls.length).toBeGreaterThan(callsBeforeRelease);
    expect(begin.mock.instances).toEqual([journalA]);
    expect(test.plugin.settings.collection.dataFolder)
      .toBe(".rss-dashboard-data");
  });
});
