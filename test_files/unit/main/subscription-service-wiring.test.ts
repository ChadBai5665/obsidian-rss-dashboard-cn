import { describe, expect, it, vi } from "vitest";
import { App, type PluginManifest } from "obsidian";
import RssDashboardPlugin from "../../../main";
import { DEFAULT_SETTINGS, type Feed } from "../../../src/types/types";
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
}

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
});
