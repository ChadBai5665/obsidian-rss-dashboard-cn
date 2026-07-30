import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SubscriptionService,
  SubscriptionServiceError,
  createConfirmedCollectionPurge,
  isSubscriptionRemovalPending,
  type VerifiedFeedSubscriptionRequest,
  type VerifiedXSubscriptionRequest,
  type SubscriptionUpdateRequest,
  type XSubscriptionOptionsUpdateRequest,
} from "../../../src/services/subscription-service";
import {
  XProfileResolver,
  type VerifiedXProfile,
} from "../../../src/sources/tikhub/x-profile-resolver";
import {
  createXAccountSourceConfig,
  createXTopicSourceConfig,
} from "../../../src/sources/source-config";
import type { Feed, FeedItem } from "../../../src/types/types";
import type {
  OperationBeginInput,
  OperationJournalPort,
  OperationJournalScope,
} from "../../../src/operation-journal/operation-journal-service";
import { OperationJournalService } from "../../../src/operation-journal/operation-journal-service";
import type {
  OperationDetails,
  OperationErrorCode,
  OperationEvent,
  OperationStage,
} from "../../../src/operation-journal/operation-event";

const NOW = new Date("2026-07-28T12:00:00.000Z");
const CHANNEL_ID = "UCabcdefghijklmnopqrstuv";

function item(guid: string, pubDate: string): FeedItem {
  return {
    title: guid,
    link: `https://example.com/${guid}`,
    description: guid,
    pubDate,
    guid,
    read: false,
    starred: false,
    tags: [],
    feedTitle: "Example",
    feedUrl: "https://example.com/feed.xml",
    coverImage: "",
  };
}

function rssRequest(
  overrides: Partial<VerifiedFeedSubscriptionRequest> = {},
): VerifiedFeedSubscriptionRequest {
  return {
    kind: "rss-website",
    verification: {
      inputUrl: "https://example.com/",
      siteUrl: "https://example.com/",
      candidates: [
        {
          url: "https://example.com/feed.xml",
          title: "Example",
          format: "rss",
        },
      ],
      selected: {
        url: "https://example.com/feed.xml",
        title: "Example",
        format: "rss",
      },
      latestTitle: "new",
      latestPubDate: "2026-07-28T10:00:00.000Z",
      hasEntries: true,
    },
    selectedCandidateUrl: "https://example.com/feed.xml",
    displayName: "Example custom",
    folder: "Reading/RSS",
    tags: ["research"],
    initialImportPolicy: { mode: "lookback-days", days: 7 },
    ...overrides,
  } as VerifiedFeedSubscriptionRequest;
}

function youtubeRequest(): VerifiedFeedSubscriptionRequest {
  return {
    kind: "youtube",
    verification: {
      channelId: CHANNEL_ID,
      channelName: "Example channel",
      channelUrl: `https://www.youtube.com/channel/${CHANNEL_ID}`,
      feedUrl: `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`,
      latestTitle: "Video",
      latestPubDate: "2026-07-28T10:00:00.000Z",
      hasEntries: true,
    },
    folder: "Videos",
    tags: ["youtube"],
    initialImportPolicy: { mode: "lookback-days", days: 7 },
  };
}

let currentXVerification: VerifiedXProfile;

async function mintXVerification(
  handle = "openai",
  restId = "44196397",
  now: Date = NOW,
): Promise<VerifiedXProfile> {
  const resolver = new XProfileResolver({
    settings: {
      enabled: true,
      connectionId: "11111111-1111-4111-8111-111111111111",
      baseUrl: "https://example.invalid",
      timeoutMs: 20_000,
      maxRequestsPerRun: 40,
      maxRequestsPerDay: 100,
    },
    secretStore: { get: async () => "unit-test-key" },
    client: {
      fetchUserProfile: async () => ({
        data: {
          result: {
            rest_id: restId,
            legacy: { screen_name: handle, name: handle },
          },
        },
      }),
    },
    now: () => now,
  });
  return await resolver.resolve(handle);
}

function xRequest(handle = "OpenAI"): VerifiedXSubscriptionRequest {
  return {
    kind: "x-account",
    profile: { ...currentXVerification.profile, handle },
    verificationProof: currentXVerification.proof,
    includeReplies: true,
    includeReposts: false,
    folder: "X",
    tags: ["ai"],
    initialImportPolicy: { mode: "all-available" },
    confirmedAllAvailable: true,
  };
}

function existingFeed(overrides: Partial<Feed> = {}): Feed {
  return {
    feedId: "legacy-feed",
    sourceKind: "feed",
    sourceConfig: { kind: "feed" },
    title: "Legacy",
    url: "https://legacy.example/feed.xml",
    folder: "Legacy",
    items: [],
    lastUpdated: 1,
    subscriptionStatus: "active",
    ...overrides,
  };
}

type RecordedSubscriptionJournalEvent =
  | { status: "started"; input: OperationBeginInput }
  | {
      status: "progress" | "succeeded";
      stage: OperationStage;
      details: OperationDetails;
    }
  | {
      status: "failed";
      stage: OperationStage;
      errorCode: OperationErrorCode;
      details?: OperationDetails;
    }
  | { status: "aborted"; stage: OperationStage };

function recordingJournal(): {
  port: OperationJournalPort;
  events: RecordedSubscriptionJournalEvent[];
} {
  const events: RecordedSubscriptionJournalEvent[] = [];
  let nextId = 0;
  const begin = (input: OperationBeginInput): OperationJournalScope => {
    events.push({ status: "started", input });
    nextId += 1;
    return {
      operationId: `subscription-operation-${nextId}`,
      progress: async (stage, details) => {
        events.push({ status: "progress", stage, details });
      },
      succeed: async (stage, details) => {
        events.push({ status: "succeeded", stage, details });
      },
      fail: async (stage, errorCode, details) => {
        events.push({ status: "failed", stage, errorCode, details });
      },
      abort: async (stage) => {
        events.push({ status: "aborted", stage });
      },
    };
  };
  return {
    events,
    port: {
      begin,
      attach: () => {
        throw new Error("subscription mutations never attach journal scopes");
      },
    },
  };
}

function persistedOperationJournal(events: OperationEvent[]): OperationJournalService {
  let nextId = 1;
  return new OperationJournalService({
    append: async (event) => {
      events.push(event);
      return { maintenanceIncomplete: false };
    },
    readRange: async () => ({
      events: [...events],
      incompleteDates: [],
      corruptDates: [],
      truncated: false,
    }),
    stats: async () => ({ bytes: 0, days: 1, eventCount: events.length }),
    prune: async () => undefined,
    clear: async () => undefined,
  }, {
    createId: () =>
      `10000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`,
    clock: () => new Date(NOW),
  });
}

function harness(
  initialFeeds: Feed[] = [],
  options: {
    abortInitialImport?: (feedId: string) => void;
    operationJournal?: OperationJournalPort;
    getOperationJournal?: () => OperationJournalPort | undefined;
  } = {},
) {
  const settings = {
    feeds: initialFeeds,
    folders: [] as Array<{ name: string; subfolders: unknown[] }>,
    collapsedFolders: [] as string[],
    folderFeedSortOrders: {},
    folderSortOrder: { by: "name" as const, ascending: true },
  };
  const snapshots: Feed[][] = [];
  const selectedItems = [
    item("new", "2026-07-28T10:00:00.000Z"),
    item("within", "2026-07-24T10:00:00.000Z"),
    item("old", "2026-07-19T10:00:00.000Z"),
  ];
  const parseFeed = vi.fn(async (_url: string, seed: Feed) => ({
    ...seed,
    title: seed.title || "Parsed",
    siteUrl: "https://example.com/",
    items: selectedItems,
    lastUpdated: NOW.getTime(),
  }));
  const collectionService = {
    collectFeedRefresh: vi.fn(async () => []),
    removeSource: vi.fn(async () => ({
      days: [],
      commit: vi.fn(async () => undefined),
      rollback: vi.fn(async () => undefined),
    })),
  };
  const saveSettings = vi.fn(async () => undefined);
  const saveSettingsCandidate = vi.fn(async (
    candidate: typeof settings,
    publish: () => void,
  ) => {
    await saveSettings();
    snapshots.push(structuredClone(candidate.feeds));
    publish();
  });
  const ensureFolder = vi.fn(async () => undefined);
  const service = new SubscriptionService({
    settings,
    defaults: { autoDeleteDuration: 30, maxItems: 1 },
    parseFeed,
    collectionService,
    ensureFolder,
    saveSettings,
    saveSettingsCandidate,
    now: () => NOW,
    createFeedId: () => "new-feed-id",
    abortInitialImport: options.abortInitialImport,
    operationJournal: options.operationJournal,
    getOperationJournal: options.getOperationJournal,
  });
  return {
    service,
    settings,
    snapshots,
    selectedItems,
    parseFeed,
    collectionService,
    saveSettings,
    saveSettingsCandidate,
    ensureFolder,
  };
}

beforeEach(async () => {
  vi.restoreAllMocks();
  currentXVerification = await mintXVerification();
});

describe("SubscriptionService", () => {
  it("rejects an empty YouTube verification even when a caller forges warning acceptance", async () => {
    const test = harness();
    const request = youtubeRequest();

    await expect(test.service.add({
      ...request,
      verification: {
        ...request.verification,
        latestTitle: undefined,
        latestPubDate: undefined,
        hasEntries: false,
      },
      acceptedEmptyFeedWarning: true,
    })).rejects.toMatchObject({ code: "invalid-subscription-request" });

    expect(test.settings.feeds).toEqual([]);
    expect(test.snapshots).toEqual([]);
    expect(test.parseFeed).not.toHaveBeenCalled();
    expect(test.ensureFolder).not.toHaveBeenCalled();
    expect(test.saveSettings).not.toHaveBeenCalled();
    expect(test.collectionService.collectFeedRefresh).not.toHaveBeenCalled();
  });

  it("keeps explicit warning acceptance valid for a structurally valid empty RSS feed", async () => {
    const test = harness();
    const request = rssRequest();

    await expect(test.service.add({
      ...request,
      verification: {
        ...request.verification,
        latestTitle: undefined,
        latestPubDate: undefined,
        hasEntries: false,
      },
      acceptedEmptyFeedWarning: true,
    })).resolves.toMatchObject({ url: "https://example.com/feed.xml" });

    expect(test.settings.feeds).toHaveLength(1);
    expect(test.collectionService.collectFeedRefresh).toHaveBeenCalledOnce();
  });

  it("publishes a recoverable pending RSS source, collects the complete selected history, then retains the cache", async () => {
    const test = harness();

    const added = await test.service.add(rssRequest());

    expect(added).toMatchObject({
      feedId: "new-feed-id",
      url: "https://example.com/feed.xml",
      siteUrl: "https://example.com/",
      title: "Example custom",
      folder: "Reading/RSS",
      customTags: ["research"],
      subscriptionStatus: "active",
      initialImportPolicy: { mode: "lookback-days", days: 7 },
      initialImportProgress: {
        status: "completed",
        pagesFetched: 1,
        itemsImported: 2,
        earliestImportedAt: "2026-07-24T10:00:00.000Z",
      },
    });
    expect(added.items.map((entry) => entry.guid)).toEqual(["new"]);
    expect(test.parseFeed).toHaveBeenCalledWith(
      "https://example.com/feed.xml",
      expect.objectContaining({ autoDeleteDuration: 0, maxItemsLimit: 0 }),
    );
    expect(test.ensureFolder).toHaveBeenCalledWith("Reading/RSS");
    expect(test.collectionService.collectFeedRefresh).toHaveBeenCalledWith({
      feed: expect.objectContaining({
        feedId: "new-feed-id",
        initialImportProgress: expect.objectContaining({ status: "pending" }),
      }),
      previousItems: [],
      refreshedItems: test.selectedItems.slice(0, 2),
      fetchedAt: NOW,
    });
    expect(test.snapshots).toHaveLength(2);
    expect(test.snapshots[0][0].items).toHaveLength(2);
    expect(test.snapshots[0][0].initialImportProgress?.status).toBe("pending");
    expect(test.snapshots[1][0].items).toHaveLength(1);
    expect(test.snapshots[1][0].initialImportProgress?.status).toBe("completed");
  });

  it("retains an untrimmed failed checkpoint when initial collection persistence fails", async () => {
    const test = harness();
    test.collectionService.collectFeedRefresh.mockRejectedValueOnce(
      new Error("disk full"),
    );

    await expect(test.service.add(rssRequest())).rejects.toThrow("disk full");

    expect(test.settings.feeds[0].items).toHaveLength(2);
    expect(test.settings.feeds[0].initialImportProgress).toMatchObject({
      status: "failed",
      itemsImported: 0,
    });
    expect(test.snapshots.at(-1)?.[0].initialImportProgress?.status).toBe(
      "failed",
    );
  });

  it("does not add pending import state to pre-existing feeds", async () => {
    const legacy = existingFeed();
    const test = harness([legacy]);

    await test.service.add(xRequest());

    expect(test.settings.feeds[0]).toStrictEqual(legacy);
    expect(test.settings.feeds[0]).not.toHaveProperty("initialImportPolicy");
    expect(test.settings.feeds[0]).not.toHaveProperty("initialImportProgress");
  });

  it("keeps unrelated typed sources from blocking a new feed subscription", async () => {
    const topic = existingFeed({
      feedId: "topic-ai",
      sourceKind: "x-topic",
      sourceConfig: {
        kind: "x-topic",
        id: "topic-ai",
        name: "AI",
        includeKeywords: ["AI"],
        excludeKeywords: [],
        priorityAccounts: [],
        windowDays: 7,
        folder: "Topics",
      },
      url: "tikhub://x-topic/topic-ai",
    });
    const test = harness([topic]);

    await expect(test.service.add(rssRequest())).resolves.toMatchObject({
      feedId: "new-feed-id",
    });

    expect(test.settings.feeds[0]).toStrictEqual(topic);
  });

  it.each([
    [
      "canonical feed URL",
      existingFeed({ url: "https://EXAMPLE.com/feed.xml#fragment" }),
      () => rssRequest(),
    ],
    [
      "YouTube channel ID",
      existingFeed({
        url: `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`,
      }),
      () => youtubeRequest(),
    ],
    [
      "lowercase X handle",
      existingFeed({
        sourceKind: "x-account",
        sourceConfig: {
          kind: "x-account",
          id: "existing-x",
          handle: "openai",
          includeReplies: false,
          includeReposts: false,
          folder: "X",
          topics: [],
        },
        url: "tikhub://x-account/openai",
      }),
      () => xRequest("OPENAI"),
    ],
  ])("rejects a duplicate by %s", async (_label, stored, createRequest) => {
    const test = harness([stored]);

    await expect(test.service.add(createRequest())).rejects.toMatchObject({
      code: "duplicate-subscription",
    });

    expect(test.saveSettings).not.toHaveBeenCalled();
  });

  it("rechecks canonical ownership after concurrent verification work", async () => {
    const test = harness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    test.parseFeed.mockImplementation(async (_url: string, seed: Feed) => {
      await gate;
      return { ...seed, items: test.selectedItems, lastUpdated: NOW.getTime() };
    });

    const first = test.service.add(rssRequest());
    const second = test.service.add(rssRequest());
    await Promise.resolve();
    release();
    const results = await Promise.allSettled([first, second]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ code: "duplicate-subscription" }),
      }),
    ]);
    expect(test.settings.feeds).toHaveLength(1);
  });

  it("constructs an X feed with a production-reachable pending import checkpoint", async () => {
    const test = harness();

    const added = await test.service.add(xRequest());

    expect(added).toMatchObject({
      feedId: "new-feed-id",
      sourceKind: "x-account",
      sourceConfig: {
        kind: "x-account",
        id: "new-feed-id",
        handle: "openai",
        includeReplies: true,
        includeReposts: false,
        folder: "X",
        topics: ["ai"],
      },
      url: "tikhub://x-account/openai",
      subscriptionStatus: "active",
      initialImportPolicy: { mode: "all-available" },
      initialImportProgress: {
        status: "pending",
        pagesFetched: 0,
        itemsImported: 0,
      },
    });
    expect(test.parseFeed).not.toHaveBeenCalled();
  });

  it("pauses refresh and stops or resumes import without discarding cursors", async () => {
    const source = existingFeed({
      sourceKind: "x-account",
      sourceConfig: {
        kind: "x-account",
        id: "legacy-feed",
        handle: "openai",
        includeReplies: true,
        includeReposts: false,
        folder: "X",
        topics: [],
      },
      url: "tikhub://x-account/openai",
      initialImportPolicy: { mode: "all-available" },
      initialImportProgress: {
        status: "running",
        pagesFetched: 3,
        itemsImported: 40,
        nextCursor: "posts-secret",
        replyCursor: "replies-secret",
      },
    });
    const test = harness([source]);

    await test.service.setPaused("legacy-feed", true);
    await test.service.stopInitialImport("legacy-feed");
    await test.service.resumeInitialImport("legacy-feed");

    expect(test.settings.feeds[0]).toMatchObject({
      subscriptionStatus: "paused",
      initialImportProgress: {
        status: "pending",
        pagesFetched: 3,
        itemsImported: 40,
        nextCursor: "posts-secret",
        replyCursor: "replies-secret",
      },
    });
  });

  it.each(["pending", "running", "completed", "failed"] as const)(
    "rejects an X history resume from %s so callers cannot restart collection",
    async (status) => {
      const source = existingFeed({
        sourceKind: "x-account",
        sourceConfig: {
          kind: "x-account",
          id: "legacy-feed",
          handle: "openai",
          includeReplies: false,
          includeReposts: false,
          folder: "X",
          topics: [],
        },
        url: "tikhub://x-account/openai",
        initialImportPolicy: { mode: "all-available" },
        initialImportProgress: {
          status,
          pagesFetched: 2,
          itemsImported: 20,
          nextCursor: "keep-cursor",
        },
      });
      const test = harness([source]);

      await expect(test.service.resumeInitialImport("legacy-feed"))
        .rejects.toMatchObject({ code: "invalid-subscription-request" });

      expect(test.settings.feeds[0]).toBe(source);
      expect(test.saveSettings).not.toHaveBeenCalled();
    },
  );

  it("aborts the active historical run before persisting stopped progress", async () => {
    const source = existingFeed({
      sourceKind: "x-account",
      sourceConfig: {
        kind: "x-account",
        id: "legacy-feed",
        handle: "openai",
        includeReplies: false,
        includeReposts: false,
        folder: "X",
        topics: [],
      },
      url: "tikhub://x-account/openai",
      initialImportPolicy: { mode: "all-available" },
      initialImportProgress: {
        status: "running",
        pagesFetched: 1,
        itemsImported: 3,
        phase: "posts",
        nextCursor: "next-page",
      },
    });
    const test = harness([source]);
    const abortInitialImport = vi.fn();
    const service = new SubscriptionService({
      settings: test.settings,
      defaults: { autoDeleteDuration: 30, maxItems: 1 },
      parseFeed: test.parseFeed,
      collectionService: test.collectionService,
      ensureFolder: test.ensureFolder,
      saveSettings: test.saveSettings,
      now: () => NOW,
      createFeedId: () => "unused-id",
      abortInitialImport,
    });

    await service.stopInitialImport("legacy-feed");

    expect(abortInitialImport).toHaveBeenCalledWith("legacy-feed");
    expect(test.settings.feeds[0].initialImportProgress).toMatchObject({
      status: "stopped",
      phase: "posts",
      nextCursor: "next-page",
    });
  });

  it("retries a failed RSS collection checkpoint from its untrimmed saved items", async () => {
    const recoverable = existingFeed({
      autoDeleteDuration: 30,
      maxItemsLimit: 1,
      items: [
        item("new", "2026-07-28T10:00:00.000Z"),
        item("within", "2026-07-24T10:00:00.000Z"),
      ],
      initialImportPolicy: { mode: "lookback-days", days: 7 },
      initialImportProgress: {
        status: "failed",
        pagesFetched: 0,
        itemsImported: 0,
      },
    });
    const test = harness([recoverable]);

    const resumed = await test.service.resumeInitialImport("legacy-feed");

    expect(test.collectionService.collectFeedRefresh).toHaveBeenCalledWith({
      feed: expect.objectContaining({ feedId: "legacy-feed" }),
      previousItems: [],
      refreshedItems: recoverable.items,
      fetchedAt: NOW,
    });
    expect(resumed.items.map((entry) => entry.guid)).toEqual(["new"]);
    expect(resumed.initialImportProgress).toMatchObject({
      status: "completed",
      pagesFetched: 1,
      itemsImported: 2,
      earliestImportedAt: "2026-07-24T10:00:00.000Z",
    });
  });

  it("restores the exact feed graph when settings persistence fails", async () => {
    const source = existingFeed();
    const original = [source];
    const test = harness(original);
    test.saveSettings.mockRejectedValueOnce(new Error("save failed"));

    await expect(test.service.setPaused("legacy-feed", true)).rejects.toThrow(
      "save failed",
    );

    expect(test.settings.feeds).toBe(original);
    expect(test.settings.feeds[0].subscriptionStatus).toBe("active");
  });

  it("serializes different-source candidates so a failed save cannot cross-roll back a later mutation", async () => {
    const sourceA = existingFeed({ feedId: "source-a" });
    const sourceB = existingFeed({
      feedId: "source-b",
      url: "https://second.example/feed.xml",
    });
    const test = harness([sourceA, sourceB]);
    let rejectFirst!: (error: Error) => void;
    const firstSave = new Promise<void>((_resolve, reject) => {
      rejectFirst = reject;
    });
    test.saveSettings
      .mockImplementationOnce(() => firstSave)
      .mockResolvedValueOnce(undefined);
    const secondService = new SubscriptionService({
      settings: test.settings,
      defaults: { autoDeleteDuration: 30, maxItems: 1 },
      parseFeed: test.parseFeed,
      collectionService: test.collectionService,
      ensureFolder: test.ensureFolder,
      saveSettings: test.saveSettings,
      now: () => NOW,
      createFeedId: () => "unused-id",
    });

    const first = test.service.setPaused("source-a", true);
    await Promise.resolve();
    const second = secondService.setPaused("source-b", true);
    await Promise.resolve();
    expect(test.saveSettings).toHaveBeenCalledTimes(1);

    rejectFirst(new Error("first save failed"));
    await expect(first).rejects.toThrow("first save failed");
    await expect(second).resolves.toMatchObject({ subscriptionStatus: "paused" });

    expect(test.settings.feeds).toMatchObject([
      { feedId: "source-a", subscriptionStatus: "active" },
      { feedId: "source-b", subscriptionStatus: "paused" },
    ]);
  });

  it("applies every editable option while preserving identity, cache, progress, and status", async () => {
    const source = existingFeed({
      items: [item("kept", "2026-07-20T00:00:00.000Z")],
      autoDeleteDuration: 30,
      maxItemsLimit: 10,
      scanInterval: 1,
      initialImportPolicy: { mode: "all-available" },
      initialImportProgress: { status: "completed", pagesFetched: 1, itemsImported: 1 },
      subscriptionStatus: "paused",
    });
    const test = harness([source]);

    const updated = await test.service.update("legacy-feed", rssRequest({
      verification: {
        inputUrl: source.url,
        siteUrl: "https://legacy.example/",
        candidates: [{ url: source.url, title: "Legacy", format: "rss" }],
        selected: { url: source.url, title: "Legacy", format: "rss" },
        hasEntries: true,
      },
      selectedCandidateUrl: source.url,
      displayName: "Edited",
      folder: "Edited Folder",
      tags: ["edited"],
      initialImportPolicy: { mode: "lookback-days", days: 30 },
      autoDeleteDuration: 90,
      maxItemsLimit: 25,
      scanInterval: 12,
      keywordRules: {
        overrideGlobalRules: true,
        includeLogic: "OR",
        rules: [{
          id: "rule-1",
          type: "include",
          keyword: "AI",
          matchMode: "partial",
          applyToTitle: true,
          applyToSummary: false,
          applyToContent: false,
          enabled: true,
          createdAt: 1,
        }],
      },
      customTemplate: "Custom",
      excludeFromRefresh: true,
      mediaType: "podcast",
    }));

    expect(updated).toMatchObject({
      title: "Edited",
      folder: "Edited Folder",
      customTags: ["edited"],
      autoDeleteDuration: 90,
      maxItemsLimit: 25,
      scanInterval: 12,
      customTemplate: "Custom",
      excludeFromRefresh: true,
      mediaType: "podcast",
      subscriptionStatus: "paused",
      initialImportProgress: source.initialImportProgress,
    });
    expect(updated.items).toEqual(source.items);
    expect(updated.keywordRules).toEqual({
      overrideGlobalRules: true,
      includeLogic: "OR",
      rules: [{
        id: "rule-1",
        type: "include",
        keyword: "AI",
        matchMode: "partial",
        applyToTitle: true,
        applyToSummary: false,
        applyToContent: false,
        enabled: true,
        createdAt: 1,
      }],
    });
  });

  it("updates feed options without parsing or re-verifying its identity", async () => {
    const previousItem = item("kept", "2026-07-20T00:00:00.000Z");
    const progress = {
      status: "completed" as const,
      pagesFetched: 2,
      itemsImported: 1,
    };
    const source = existingFeed({
      items: [previousItem],
      initialImportPolicy: { mode: "lookback-days", days: 7 },
      initialImportProgress: progress,
      customTags: ["old"],
      autoDeleteDuration: 30,
      maxItemsLimit: 10,
      subscriptionStatus: "active",
    });
    const test = harness([source]);
    const request = {
      kind: "feed-options",
      folder: "Research",
      tags: ["edited"],
      autoDeleteDuration: 90,
      maxItemsLimit: 25,
      paused: true,
    } as unknown as SubscriptionUpdateRequest;

    const updated = await test.service.update("legacy-feed", request);

    expect(updated).toMatchObject({
      feedId: "legacy-feed",
      url: "https://legacy.example/feed.xml",
      folder: "Research",
      customTags: ["edited"],
      autoDeleteDuration: 90,
      maxItemsLimit: 25,
      subscriptionStatus: "paused",
      initialImportProgress: progress,
    });
    expect(updated.items).toEqual([previousItem]);
    expect(test.parseFeed).not.toHaveBeenCalled();
    expect(test.ensureFolder).toHaveBeenCalledWith("Research");
  });

  it("accepts a reverified canonical feed change and rejects a duplicate target", async () => {
    const duplicate = existingFeed({
      feedId: "duplicate",
      url: "https://duplicate.example/feed.xml",
    });
    const test = harness([
      existingFeed({ subscriptionStatus: "paused" }),
      duplicate,
    ]);
    test.parseFeed.mockImplementation(async (_url, seed) => ({
      ...seed,
      title: "Parser title",
      siteUrl: "https://changed.example/",
      items: test.selectedItems,
      mediaType: "article",
      customTemplate: "parser-template",
      lastUpdated: NOW.getTime(),
    }));
    const changed = rssRequest({
      verification: {
        inputUrl: "https://changed.example/",
        siteUrl: "https://changed.example/",
        candidates: [{ url: "https://changed.example/feed.xml", title: "Changed", format: "rss" }],
        selected: { url: "https://changed.example/feed.xml", title: "Changed", format: "rss" },
        hasEntries: true,
      },
      selectedCandidateUrl: "https://changed.example/feed.xml",
      mediaType: "podcast",
      customTemplate: "",
    });

    await expect(test.service.update("legacy-feed", changed)).resolves.toMatchObject({
      feedId: "legacy-feed",
      url: "https://changed.example/feed.xml",
      mediaType: "podcast",
      customTemplate: undefined,
      subscriptionStatus: "paused",
      initialImportProgress: expect.objectContaining({ status: "completed" }),
    });

    const duplicateRequest = rssRequest({
      verification: {
        inputUrl: duplicate.url,
        siteUrl: "https://duplicate.example/",
        candidates: [{ url: duplicate.url, title: "Duplicate", format: "rss" }],
        selected: { url: duplicate.url, title: "Duplicate", format: "rss" },
        hasEntries: true,
      },
      selectedCandidateUrl: duplicate.url,
    });
    await expect(test.service.update("legacy-feed", duplicateRequest)).rejects
      .toMatchObject({ code: "duplicate-subscription" });
  });

  it("uses a fresh X proof for an account identity change and applies all X options", async () => {
    const previousItem = item("old-account-item", "2026-07-20T00:00:00.000Z");
    const source = existingFeed({
      sourceKind: "x-account",
      sourceConfig: {
        kind: "x-account",
        id: "legacy-feed",
        handle: "openai",
        restId: "44196397",
        includeReplies: false,
        includeReposts: false,
        folder: "X",
        topics: [],
      },
      url: "tikhub://x-account/openai",
      items: [previousItem],
      initialImportPolicy: { mode: "all-available" },
      initialImportProgress: { status: "completed", pagesFetched: 2, itemsImported: 1 },
      subscriptionStatus: "paused",
    });
    const verification = await mintXVerification("anthropic", "999999");
    const test = harness([source]);
    const request: VerifiedXSubscriptionRequest = {
      kind: "x-account",
      profile: { ...verification.profile, displayName: "Anthropic" },
      verificationProof: verification.proof,
      includeReplies: true,
      includeReposts: true,
      folder: "X/New",
      tags: ["models"],
      initialImportPolicy: { mode: "lookback-days", days: 30 },
      autoDeleteDuration: 45,
      maxItemsLimit: 12,
      scanInterval: 6,
      keywordRules: {
        overrideGlobalRules: false,
        includeLogic: "AND",
        rules: [],
      },
      customTemplate: "X Template",
      excludeFromRefresh: true,
      mediaType: "podcast",
    };

    const updated = await test.service.update("legacy-feed", request);

    expect(updated).toMatchObject({
      feedId: "legacy-feed",
      url: "tikhub://x-account/anthropic",
      folder: "X/New",
      customTags: ["models"],
      autoDeleteDuration: 45,
      maxItemsLimit: 12,
      scanInterval: 6,
      keywordRules: request.keywordRules,
      customTemplate: "X Template",
      excludeFromRefresh: true,
      mediaType: "podcast",
      subscriptionStatus: "paused",
      sourceConfig: {
        handle: "anthropic",
        restId: "999999",
        includeReplies: true,
        includeReposts: true,
      },
      initialImportProgress: {
        status: "pending",
        pagesFetched: 0,
        itemsImported: 0,
      },
    });
    expect(updated.items).toEqual([]);
    expect(test.collectionService.collectFeedRefresh).not.toHaveBeenCalled();
  });

  it("updates options on a legacy X account without proof or identity reset", async () => {
    const previousItem = item("legacy-x-item", "2026-07-20T00:00:00.000Z");
    const progress = {
      status: "paused-limit" as const,
      pagesFetched: 3,
      itemsImported: 8,
      phase: "replies" as const,
      replyCursor: "reply-next",
    };
    const source = existingFeed({
      sourceKind: "x-account",
      sourceConfig: {
        kind: "x-account",
        id: "legacy-feed",
        handle: "openai",
        displayName: "OpenAI identity",
        includeReplies: false,
        includeReposts: false,
        folder: "X/Old",
        topics: ["old"],
      },
      title: "OpenAI identity",
      author: "OpenAI identity",
      url: "tikhub://x-account/openai",
      folder: "X/Old",
      items: [previousItem],
      lastUpdated: 123,
      customTags: ["old"],
      initialImportPolicy: { mode: "all-available" },
      initialImportProgress: progress,
      subscriptionStatus: "active",
    });
    const test = harness([source]);
    const request: XSubscriptionOptionsUpdateRequest = {
      kind: "x-account-options",
      folder: "X/New",
      tags: ["models"],
      initialImportPolicy: { mode: "lookback-days", days: 30 },
      includeReplies: true,
      includeReposts: true,
      autoDeleteDuration: 45,
      maxItemsLimit: 12,
      scanInterval: 6,
      keywordRules: {
        overrideGlobalRules: false,
        includeLogic: "AND",
        rules: [],
      },
      customTemplate: "X Template",
      excludeFromRefresh: true,
      paused: true,
    };

    const updated = await test.service.update("legacy-feed", request);

    expect(updated).toMatchObject({
      title: "OpenAI identity",
      author: "OpenAI identity",
      url: "tikhub://x-account/openai",
      folder: "X/New",
      customTags: ["models"],
      initialImportPolicy: { mode: "lookback-days", days: 30 },
      initialImportProgress: progress,
      lastUpdated: 123,
      autoDeleteDuration: 45,
      maxItemsLimit: 12,
      scanInterval: 6,
      keywordRules: request.keywordRules,
      customTemplate: "X Template",
      excludeFromRefresh: true,
      subscriptionStatus: "paused",
      sourceConfig: {
        kind: "x-account",
        id: "legacy-feed",
        handle: "openai",
        displayName: "OpenAI identity",
        includeReplies: true,
        includeReposts: true,
        folder: "X/New",
        topics: ["models"],
      },
    });
    expect(updated.sourceConfig).not.toHaveProperty("restId");
    expect(updated.items).toEqual([previousItem]);
    expect(test.collectionService.collectFeedRefresh).not.toHaveBeenCalled();
  });

  it("keeps X identity fields immutable on option-only updates", async () => {
    const source = existingFeed({
      sourceKind: "x-account",
      sourceConfig: {
        kind: "x-account",
        id: "legacy-feed",
        handle: "openai",
        restId: "44196397",
        displayName: "OpenAI",
        includeReplies: false,
        includeReposts: false,
        folder: "X",
        topics: [],
      },
      title: "OpenAI",
      author: "OpenAI",
      url: "tikhub://x-account/openai",
    });
    const test = harness([source]);
    const hostileOptions = {
      kind: "x-account-options",
      handle: "different",
      restId: "999999",
      displayName: "Different",
      profile: { handle: "different", restId: "999999" },
      includeReplies: true,
    } as unknown as XSubscriptionOptionsUpdateRequest;

    const updated = await test.service.update("legacy-feed", hostileOptions);

    expect(updated).toMatchObject({
      title: "OpenAI",
      author: "OpenAI",
      url: "tikhub://x-account/openai",
      sourceConfig: {
        handle: "openai",
        restId: "44196397",
        displayName: "OpenAI",
        includeReplies: true,
      },
    });
    expect(updated).not.toHaveProperty("autoDeleteDuration");
    expect(updated).not.toHaveProperty("maxItemsLimit");
    expect(updated).not.toHaveProperty("scanInterval");
    expect(updated).not.toHaveProperty("excludeFromRefresh");
    expect(updated).not.toHaveProperty("customTags");
  });

  it("requires a fresh exact X proof, consumes it once, and rejects expiry or profile tampering", async () => {
    const first = harness();
    const request = xRequest();
    await first.service.add(request);

    const reused = harness();
    await expect(reused.service.add(request)).rejects.toMatchObject({
      code: "invalid-subscription-request",
    });

    const exact = await mintXVerification("openai", "44196397");
    const tampered = harness();
    await expect(tampered.service.add({
      ...xRequest(),
      profile: { ...exact.profile, restId: "different" },
      verificationProof: exact.proof,
    })).rejects.toMatchObject({ code: "invalid-subscription-request" });

    const expiredVerification = await mintXVerification(
      "expired",
      "999",
      new Date(NOW.getTime() - 10 * 60 * 1000),
    );
    const expired = harness();
    await expect(expired.service.add({
      ...xRequest(),
      profile: expiredVerification.profile,
      verificationProof: expiredVerification.proof,
    })).rejects.toMatchObject({ code: "invalid-subscription-request" });

    const plain = harness();
    const plainRequest = { ...xRequest() } as Record<string, unknown>;
    delete plainRequest.verificationProof;
    await expect(plain.service.add(plainRequest as unknown as VerifiedXSubscriptionRequest))
      .rejects.toMatchObject({ code: "invalid-subscription-request" });
  });

  it("releases a reserved X proof when durable settings persistence fails", async () => {
    const test = harness();
    const request = xRequest();
    test.saveSettings.mockRejectedValueOnce(new Error("settings unavailable"));

    await expect(test.service.add(request)).rejects.toThrow(
      "settings unavailable",
    );
    await expect(test.service.add(request)).resolves.toMatchObject({
      sourceKind: "x-account",
      sourceConfig: expect.objectContaining({
        handle: "openai",
        restId: "44196397",
      }),
    });

    expect(test.settings.feeds).toHaveLength(1);
  });

  it("rejects concurrent reuse while an X proof is reserved by another save", async () => {
    const request = xRequest();
    const first = harness();
    const concurrent = harness();
    let markSaving!: () => void;
    let releaseSave!: () => void;
    const saving = new Promise<void>((resolve) => {
      markSaving = resolve;
    });
    const blockedSave = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    first.saveSettings.mockImplementationOnce(async () => {
      markSaving();
      await blockedSave;
    });

    const firstAdd = first.service.add(request);
    await saving;
    await expect(concurrent.service.add(request)).rejects.toMatchObject({
      code: "invalid-subscription-request",
    });
    releaseSave();
    await expect(firstAdd).resolves.toMatchObject({ sourceKind: "x-account" });
  });

  it("defaults to history-preserving removal and requires a feed-bound purge capability", async () => {
    const source = existingFeed();
    const test = harness([source]);

    await test.service.remove("legacy-feed", { purgeCollection: false });

    expect(test.settings.feeds).toEqual([]);
    expect(test.collectionService.removeSource).not.toHaveBeenCalled();

    test.settings.feeds = [source];
    await expect(
      test.service.remove("legacy-feed", {
        purgeCollection: true,
      } as never),
    ).rejects.toMatchObject({ code: "purge-confirmation-required" });
    expect(test.settings.feeds).toEqual([source]);

    await expect(
      test.service.remove("legacy-feed", {
        purgeCollection: true,
        confirmation: createConfirmedCollectionPurge("different-feed"),
      }),
    ).rejects.toMatchObject({ code: "purge-confirmation-required" });

    const confirmation = createConfirmedCollectionPurge("legacy-feed");
    const commit = vi.fn(async () => undefined);
    test.collectionService.removeSource.mockResolvedValueOnce({
      days: [],
      commit,
      rollback: vi.fn(async () => undefined),
    });
    await test.service.remove("legacy-feed", {
      purgeCollection: true,
      confirmation,
    });
    expect(test.collectionService.removeSource).toHaveBeenCalledWith(
      "legacy-feed",
    );
    expect(commit).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: "default",
      options: { purgeCollection: false } as const,
    },
    {
      label: "purge",
      options: {
        purgeCollection: true,
        confirmation: createConfirmedCollectionPurge("legacy-feed"),
      } as const,
    },
  ])("aborts an active import synchronously before queued $label removal", async ({ options }) => {
    const abortInitialImport = vi.fn();
    const test = harness([
      existingFeed({
        sourceKind: "x-account",
        sourceConfig: {
          kind: "x-account",
          id: "legacy-feed",
          handle: "openai",
          includeReplies: false,
          includeReposts: false,
          folder: "X",
          topics: [],
        },
        initialImportPolicy: { mode: "all-available" },
        initialImportProgress: {
          status: "running",
          pagesFetched: 1,
          itemsImported: 1,
        },
      }),
    ], { abortInitialImport });
    let markSaveStarted!: () => void;
    let releaseSave!: () => void;
    const saveStarted = new Promise<void>((resolve) => {
      markSaveStarted = resolve;
    });
    const saveBlocked = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    test.saveSettings.mockImplementationOnce(async () => {
      markSaveStarted();
      await saveBlocked;
    });

    const priorMutation = test.service.setPaused("legacy-feed", true);
    await saveStarted;
    const removal = test.service.remove("legacy-feed", options);

    expect(abortInitialImport).toHaveBeenCalledWith("legacy-feed");
    expect(test.settings.feeds).toHaveLength(1);

    releaseSave();
    await priorMutation;
    await removal;
    expect(abortInitialImport).toHaveBeenCalledTimes(2);
    expect(test.settings.feeds).toEqual([]);
  });

  it("keeps a shared removal intent until failure cleanup completes", async () => {
    const test = harness([existingFeed()]);
    test.saveSettings.mockRejectedValueOnce(new Error("config save failed"));

    const removal = test.service.remove("legacy-feed", {
      purgeCollection: false,
    });

    expect(isSubscriptionRemovalPending(test.settings, "legacy-feed")).toBe(true);
    await expect(removal).rejects.toThrow("config save failed");
    expect(isSubscriptionRemovalPending(test.settings, "legacy-feed")).toBe(false);
    expect(test.settings.feeds).toHaveLength(1);
  });

  it("clears the removal intent when the synchronous abort hook fails", async () => {
    const test = harness([existingFeed()], {
      abortInitialImport: () => {
        throw new Error("abort hook failed");
      },
    });

    const removal = test.service.remove("legacy-feed", {
      purgeCollection: false,
    });

    await expect(removal).rejects.toThrow("abort hook failed");
    expect(isSubscriptionRemovalPending(test.settings, "legacy-feed")).toBe(false);
    expect(test.settings.feeds).toHaveLength(1);
  });

  it.each([
    {
      label: "invalid options",
      feedId: "legacy-feed",
      options: undefined as never,
      code: "invalid-subscription-request",
    },
    {
      label: "invalid purge confirmation",
      feedId: "legacy-feed",
      options: { purgeCollection: true } as never,
      code: "purge-confirmation-required",
    },
    {
      label: "nonexistent source",
      feedId: "missing-feed",
      options: { purgeCollection: false } as const,
      code: "subscription-not-found",
    },
  ])("does not leave a removal intent for $label", async ({ feedId, options, code }) => {
    const test = harness([existingFeed()]);

    const removal = test.service.remove(feedId, options);

    expect(isSubscriptionRemovalPending(test.settings, feedId)).toBe(false);
    await expect(removal).rejects.toMatchObject({ code });
    expect(isSubscriptionRemovalPending(test.settings, feedId)).toBe(false);
  });

  it("restores collection and source configuration when the final purge config save fails", async () => {
    const source = existingFeed();
    const test = harness([source]);
    const originalFeeds = test.settings.feeds;
    const rollback = vi.fn(async () => undefined);
    test.collectionService.removeSource.mockResolvedValueOnce({
      days: [],
      commit: vi.fn(async () => undefined),
      rollback,
    });
    test.saveSettings.mockRejectedValueOnce(new Error("config save failed"));

    await expect(test.service.remove("legacy-feed", {
      purgeCollection: true,
      confirmation: createConfirmedCollectionPurge("legacy-feed"),
    })).rejects.toThrow("config save failed");

    expect(rollback).toHaveBeenCalledOnce();
    expect(test.settings.feeds).toBe(originalFeeds);
    expect(test.settings.feeds).toEqual([source]);
  });

  it("keeps the source configuration when collection purge fails before config commit", async () => {
    const source = existingFeed();
    const test = harness([source]);
    const originalFeeds = test.settings.feeds;
    test.collectionService.removeSource.mockRejectedValueOnce(
      new Error("collection purge failed"),
    );

    await expect(test.service.remove("legacy-feed", {
      purgeCollection: true,
      confirmation: createConfirmedCollectionPurge("legacy-feed"),
    })).rejects.toThrow("collection purge failed");

    expect(test.settings.feeds).toBe(originalFeeds);
    expect(test.saveSettings).not.toHaveBeenCalled();
  });

  it("surfaces a safe combined error if config-save compensation also fails", async () => {
    const test = harness([existingFeed()]);
    const rollback = vi.fn(async () => { throw new Error("unsafe rollback detail"); });
    test.collectionService.removeSource.mockResolvedValueOnce({
      days: [],
      commit: vi.fn(async () => undefined),
      rollback,
    });
    test.saveSettings.mockRejectedValueOnce(new Error("unsafe save detail"));

    const error = await test.service.remove("legacy-feed", {
      purgeCollection: true,
      confirmation: createConfirmedCollectionPurge("legacy-feed"),
    }).catch((caught) => caught);

    expect(error).toMatchObject({
      message: "Subscription purge failed and rollback was incomplete",
    });
    expect(String(error)).not.toContain("unsafe save detail");
    expect(String(error)).not.toContain("unsafe rollback detail");
  });

  it("rolls back every live ordering reference when an ordered feed move cannot save", async () => {
    const first = existingFeed({
      feedId: "first",
      url: "https://example.com/first.xml",
      folder: "Old",
    });
    const target = existingFeed({
      feedId: "target",
      url: "https://example.com/target.xml",
      folder: "New",
    });
    const test = harness([first, target]);
    test.settings.folders = [
      { name: "Old", subfolders: [] },
      { name: "New", subfolders: [] },
    ];
    const originalFeeds = test.settings.feeds;
    const originalFolders = test.settings.folders;
    const originalSortOrders = test.settings.folderFeedSortOrders;
    test.saveSettings.mockRejectedValueOnce(new Error("disk full"));

    await expect((test.service as unknown as {
      applySidebarOrdering(request: {
        kind: "feed-insert";
        draggedUrl: string;
        targetUrl: string;
        placement: "before";
      }): Promise<unknown>;
    }).applySidebarOrdering({
      kind: "feed-insert",
      draggedUrl: first.url,
      targetUrl: target.url,
      placement: "before",
    })).rejects.toThrow("disk full");

    expect(test.settings.feeds).toBe(originalFeeds);
    expect(test.settings.folders).toBe(originalFolders);
    expect(test.settings.folderFeedSortOrders).toBe(originalSortOrders);
    expect(first.folder).toBe("Old");
  });

  it("does not publish ordered candidate references until their staged save succeeds", async () => {
    const first = existingFeed({
      feedId: "first",
      url: "https://example.com/first.xml",
      folder: "Old",
    });
    const target = existingFeed({
      feedId: "target",
      url: "https://example.com/target.xml",
      folder: "New",
    });
    const test = harness([first, target]);
    test.settings.folders = [
      { name: "Old", subfolders: [] },
      { name: "New", subfolders: [] },
    ];
    const originalFeeds = test.settings.feeds;
    const originalFolders = test.settings.folders;
    const originalSortOrders = test.settings.folderFeedSortOrders;
    let releaseSave!: () => void;
    test.saveSettings.mockImplementationOnce(async () => await new Promise<void>(
      (resolve) => { releaseSave = resolve; },
    ));

    const ordering = test.service.applySidebarOrdering({
      kind: "feed-insert",
      draggedUrl: first.url,
      targetUrl: target.url,
      placement: "before",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(test.saveSettingsCandidate).toHaveBeenCalledTimes(1);
    expect(test.settings.feeds).toBe(originalFeeds);
    expect(test.settings.folders).toBe(originalFolders);
    expect(test.settings.folderFeedSortOrders).toBe(originalSortOrders);
    expect(first.folder).toBe("Old");
    const staged = test.saveSettingsCandidate.mock.calls[0][0];
    expect(staged.feeds.find((feed: Feed) => feed.feedId === "first")?.folder)
      .toBe("New");

    releaseSave();
    await expect(ordering).resolves.toMatchObject({ ok: true });
    expect(test.settings.feeds).toBe(staged.feeds);
    expect(test.settings.feeds.find((feed) => feed.feedId === "first")?.folder)
      .toBe("New");
  });

  it("never publishes ordered candidate references when their staged save fails", async () => {
    const first = existingFeed({
      feedId: "first",
      url: "https://example.com/first.xml",
      folder: "Old",
    });
    const target = existingFeed({
      feedId: "target",
      url: "https://example.com/target.xml",
      folder: "New",
    });
    const test = harness([first, target]);
    test.settings.folders = [
      { name: "Old", subfolders: [] },
      { name: "New", subfolders: [] },
    ];
    const original = {
      feeds: test.settings.feeds,
      folders: test.settings.folders,
      collapsedFolders: test.settings.collapsedFolders,
      folderFeedSortOrders: test.settings.folderFeedSortOrders,
      folderSortOrder: test.settings.folderSortOrder,
    };
    test.saveSettings.mockRejectedValueOnce(new Error("disk full"));

    await expect(test.service.applySidebarOrdering({
      kind: "feed-insert",
      draggedUrl: first.url,
      targetUrl: target.url,
      placement: "before",
    })).rejects.toThrow("disk full");

    expect(test.settings).toMatchObject(original);
    expect(test.settings.feeds).toBe(original.feeds);
    expect(first.folder).toBe("Old");
  });

  it("renames a folder and all source kinds in one queued staged commit", async () => {
    const normal = existingFeed({
      feedId: "normal",
      folder: "Old/Child",
    });
    const account = existingFeed({
      feedId: "account",
      sourceKind: "x-account",
      sourceConfig: createXAccountSourceConfig({
        id: "account",
        handle: "openai",
        folder: "Old",
      }),
      url: "tikhub://x-account/openai",
      folder: "Old",
    });
    const topic = existingFeed({
      feedId: "topic",
      sourceKind: "x-topic",
      sourceConfig: createXTopicSourceConfig({
        id: "topic",
        name: "AI",
        folder: "Old/Child",
      }),
      url: "tikhub://x-topic/topic",
      folder: "Old/Child",
    });
    const test = harness([normal, account, topic]);
    test.settings.folders = [{
      name: "Old",
      subfolders: [{ name: "Child", subfolders: [] }],
    }];
    test.settings.collapsedFolders = ["Old", "Old/Child"];
    test.settings.folderFeedSortOrders = {
      Old: { by: "name", ascending: true },
      "Old/Child": { by: "custom", ascending: true },
    };
    const liveBefore = {
      feeds: test.settings.feeds,
      folders: test.settings.folders,
      collapsedFolders: test.settings.collapsedFolders,
      folderFeedSortOrders: test.settings.folderFeedSortOrders,
    };
    let releaseSave!: () => void;
    test.saveSettings.mockImplementationOnce(async () => await new Promise<void>(
      (resolve) => { releaseSave = resolve; },
    ));

    const rename = test.service.applyFolderMutation({
      kind: "rename",
      folderPath: "Old",
      newName: "New",
    });
    await Promise.resolve();
    await Promise.resolve();
    const queuedPause = test.service.setPaused("normal", true);

    expect(test.saveSettings).toHaveBeenCalledTimes(1);
    expect(test.settings.feeds).toBe(liveBefore.feeds);
    expect(test.settings.folders).toBe(liveBefore.folders);
    expect(test.settings.collapsedFolders).toBe(liveBefore.collapsedFolders);
    expect(test.settings.folderFeedSortOrders).toBe(
      liveBefore.folderFeedSortOrders,
    );
    const staged = test.saveSettingsCandidate.mock.calls[0][0];
    expect(staged.folders[0].name).toBe("New");
    expect(staged.collapsedFolders).toEqual(["New", "New/Child"]);
    expect(Object.keys(staged.folderFeedSortOrders)).toEqual([
      "New",
      "New/Child",
    ]);
    expect(staged.feeds.map((feed: Feed) => ({
      id: feed.feedId,
      folder: feed.folder,
      configFolder: "folder" in (feed.sourceConfig ?? {})
        ? (feed.sourceConfig as { folder: string }).folder
        : undefined,
    }))).toEqual([
      { id: "normal", folder: "New/Child", configFolder: undefined },
      { id: "account", folder: "New", configFolder: "New" },
      { id: "topic", folder: "New/Child", configFolder: "New/Child" },
    ]);

    releaseSave();
    await expect(rename).resolves.toEqual({ ok: true, newPath: "New" });
    await expect(queuedPause).resolves.toMatchObject({
      feedId: "normal",
      subscriptionStatus: "paused",
    });
    expect(test.saveSettings).toHaveBeenCalledTimes(2);
  });

  it("keeps live and durable folder state unchanged when an atomic rename save fails", async () => {
    const topic = existingFeed({
      feedId: "topic",
      sourceKind: "x-topic",
      sourceConfig: createXTopicSourceConfig({
        id: "topic",
        name: "AI",
        folder: "Old",
      }),
      url: "tikhub://x-topic/topic",
      folder: "Old",
    });
    const test = harness([topic]);
    test.settings.folders = [{ name: "Old", subfolders: [] }];
    test.settings.collapsedFolders = ["Old"];
    const before = structuredClone(test.settings);
    const refs = { feeds: test.settings.feeds, folders: test.settings.folders };
    test.saveSettings.mockRejectedValueOnce(new Error("disk full"));

    await expect(test.service.applyFolderMutation({
      kind: "rename",
      folderPath: "Old",
      newName: "New",
    })).rejects.toThrow("disk full");

    expect(test.settings).toEqual(before);
    expect(test.settings.feeds).toBe(refs.feeds);
    expect(test.settings.folders).toBe(refs.folders);
  });

  it("atomically deletes normal subscriptions and remaps topics to a surviving parent", async () => {
    const abortInitialImport = vi.fn();
    const normal = existingFeed({ feedId: "normal", folder: "Keep/Delete" });
    const account = existingFeed({
      feedId: "account",
      sourceKind: "x-account",
      sourceConfig: createXAccountSourceConfig({
        id: "account",
        handle: "openai",
        folder: "Keep/Delete/Child",
      }),
      url: "tikhub://x-account/openai",
      folder: "Keep/Delete/Child",
    });
    const topic = existingFeed({
      feedId: "topic",
      sourceKind: "x-topic",
      sourceConfig: createXTopicSourceConfig({
        id: "topic",
        name: "AI",
        folder: "Keep/Delete/Child",
      }),
      url: "tikhub://x-topic/topic",
      folder: "Keep/Delete/Child",
    });
    const outside = existingFeed({ feedId: "outside", folder: "Keep" });
    const test = harness([normal, account, topic, outside], {
      abortInitialImport,
    });
    test.settings.folders = [{
      name: "Keep",
      subfolders: [{
        name: "Delete",
        subfolders: [{ name: "Child", subfolders: [] }],
      }],
    }];
    test.settings.collapsedFolders = ["Keep", "Keep/Delete", "Keep/Delete/Child"];
    test.settings.folderFeedSortOrders = {
      Keep: { by: "name", ascending: true },
      "Keep/Delete": { by: "custom", ascending: true },
      "Keep/Delete/Child": { by: "name", ascending: false },
    };
    const originalFeeds = test.settings.feeds;
    let releaseSave!: () => void;
    test.saveSettings.mockImplementationOnce(async () => await new Promise<void>(
      (resolve) => { releaseSave = resolve; },
    ));

    const deletion = test.service.applyFolderMutation({
      kind: "delete",
      folderPath: "Keep/Delete",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(test.settings.feeds).toBe(originalFeeds);
    expect(isSubscriptionRemovalPending(test.settings, "normal")).toBe(true);
    expect(isSubscriptionRemovalPending(test.settings, "account")).toBe(true);
    expect(isSubscriptionRemovalPending(test.settings, "topic")).toBe(false);
    expect(abortInitialImport).toHaveBeenCalledWith("normal");
    expect(abortInitialImport).toHaveBeenCalledWith("account");
    const staged = test.saveSettingsCandidate.mock.calls[0][0];
    expect(staged.feeds.map((feed: Feed) => feed.feedId)).toEqual([
      "topic",
      "outside",
    ]);
    expect(staged.feeds[0]).toMatchObject({
      feedId: "topic",
      folder: "Keep",
      sourceConfig: { kind: "x-topic", folder: "Keep" },
    });
    expect(staged.folders).toEqual([{ name: "Keep", subfolders: [] }]);
    expect(staged.collapsedFolders).toEqual(["Keep"]);
    expect(Object.keys(staged.folderFeedSortOrders)).toEqual(["Keep"]);
    expect(test.collectionService.removeSource).not.toHaveBeenCalled();

    releaseSave();
    await expect(deletion).resolves.toEqual({
      ok: true,
      removedSourceIds: ["normal", "account"],
      topicDestinationFolder: "Keep",
    });
    expect(isSubscriptionRemovalPending(test.settings, "normal")).toBe(false);
    expect(isSubscriptionRemovalPending(test.settings, "account")).toBe(false);
  });

  it("keeps a deleted folder batch unchanged and clears intents when saving fails", async () => {
    const abortInitialImport = vi.fn();
    const normal = existingFeed({ feedId: "normal", folder: "Delete" });
    const topic = existingFeed({
      feedId: "topic",
      sourceKind: "x-topic",
      sourceConfig: createXTopicSourceConfig({
        id: "topic",
        name: "AI",
        folder: "Delete",
      }),
      url: "tikhub://x-topic/topic",
      folder: "Delete",
    });
    const test = harness([normal, topic], { abortInitialImport });
    test.settings.folders = [{ name: "Delete", subfolders: [] }];
    test.settings.collapsedFolders = ["Delete"];
    const before = structuredClone(test.settings);
    const refs = { feeds: test.settings.feeds, folders: test.settings.folders };
    test.saveSettings.mockRejectedValueOnce(new Error("disk full"));

    await expect(test.service.applyFolderMutation({
      kind: "delete",
      folderPath: "Delete",
    })).rejects.toThrow("disk full");

    expect(test.settings).toEqual(before);
    expect(test.settings.feeds).toBe(refs.feeds);
    expect(test.settings.folders).toBe(refs.folders);
    expect(isSubscriptionRemovalPending(test.settings, "normal")).toBe(false);
    expect(test.collectionService.removeSource).not.toHaveBeenCalled();
  });

  it("clears every folder removal intent when a later initial-import abort throws", async () => {
    const abortInitialImport = vi.fn((feedId: string) => {
      if (feedId === "second") throw new Error("abort hook failed");
    });
    const first = existingFeed({ feedId: "first", folder: "Delete" });
    const second = existingFeed({
      feedId: "second",
      url: "https://second.example/feed.xml",
      folder: "Delete/Child",
    });
    const test = harness([first, second], { abortInitialImport });
    test.settings.folders = [{
      name: "Delete",
      subfolders: [{ name: "Child", subfolders: [] }],
    }];
    const before = structuredClone(test.settings);

    await expect(test.service.applyFolderMutation({
      kind: "delete",
      folderPath: "Delete",
    })).rejects.toThrow("abort hook failed");

    expect(abortInitialImport).toHaveBeenNthCalledWith(1, "first");
    expect(abortInitialImport).toHaveBeenNthCalledWith(2, "second");
    expect(isSubscriptionRemovalPending(test.settings, "first")).toBe(false);
    expect(isSubscriptionRemovalPending(test.settings, "second")).toBe(false);
    expect(test.settings).toEqual(before);
    expect(test.saveSettingsCandidate).not.toHaveBeenCalled();
  });

  it("moves a whole folder with account and topic source configuration kept in sync", async () => {
    const account = existingFeed({
      feedId: "account",
      sourceKind: "x-account",
      sourceConfig: createXAccountSourceConfig({
        id: "account",
        handle: "openai",
        folder: "Alpha/Child",
      }),
      url: "tikhub://x-account/openai",
      folder: "Alpha/Child",
    });
    const topic = existingFeed({
      feedId: "topic",
      sourceKind: "x-topic",
      sourceConfig: createXTopicSourceConfig({
        id: "topic",
        name: "AI",
        folder: "Alpha",
      }),
      url: "tikhub://x-topic/topic",
      folder: "Alpha",
    });
    const test = harness([account, topic]);
    test.settings.folders = [
      {
        name: "Alpha",
        subfolders: [{ name: "Child", subfolders: [] }],
      },
      { name: "Beta", subfolders: [] },
    ];

    await (test.service as unknown as {
      applySidebarOrdering(request: {
        kind: "folder-move";
        draggedPath: string;
        targetPath: string;
        placement: "nest";
      }): Promise<unknown>;
    }).applySidebarOrdering({
      kind: "folder-move",
      draggedPath: "Alpha",
      targetPath: "Beta",
      placement: "nest",
    });

    expect(test.settings.feeds.map((feed) => ({
      id: feed.feedId,
      folder: feed.folder,
      configFolder: "folder" in (feed.sourceConfig ?? {})
        ? (feed.sourceConfig as { folder: string }).folder
        : undefined,
    }))).toEqual([
      { id: "account", folder: "Beta/Alpha/Child", configFolder: "Beta/Alpha/Child" },
      { id: "topic", folder: "Beta/Alpha", configFolder: "Beta/Alpha" },
    ]);
  });

  it("serializes a queued update behind a failing ordering save without cross-rollback", async () => {
    const first = existingFeed({
      feedId: "first",
      url: "https://example.com/first.xml",
      folder: "Old",
    });
    const target = existingFeed({
      feedId: "target",
      url: "https://example.com/target.xml",
      folder: "New",
    });
    const test = harness([first, target]);
    test.settings.folders = [
      { name: "Old", subfolders: [] },
      { name: "New", subfolders: [] },
    ];
    let rejectOrdering!: (reason?: unknown) => void;
    test.saveSettings.mockImplementationOnce(async () => await new Promise(
      (_resolve, reject) => { rejectOrdering = reject; },
    ));

    const ordering = (test.service as unknown as {
      applySidebarOrdering(request: {
        kind: "feed-insert";
        draggedUrl: string;
        targetUrl: string;
        placement: "before";
      }): Promise<unknown>;
    }).applySidebarOrdering({
      kind: "feed-insert",
      draggedUrl: first.url,
      targetUrl: target.url,
      placement: "before",
    });
    await Promise.resolve();
    await Promise.resolve();
    const queuedUpdate = test.service.update("target", {
      kind: "feed-options",
      displayName: "Updated after rollback",
    });

    expect(test.saveSettings).toHaveBeenCalledTimes(1);
    rejectOrdering(new Error("ordering save failed"));
    await expect(ordering).rejects.toThrow("ordering save failed");
    await expect(queuedUpdate).resolves.toMatchObject({
      feedId: "target",
      title: "Updated after rollback",
    });

    expect(test.saveSettings).toHaveBeenCalledTimes(2);
    expect(test.settings.feeds.map((feed) => feed.feedId)).toEqual([
      "first",
      "target",
    ]);
    expect(test.settings.feeds[0].folder).toBe("Old");
  });

  describe("operation journal", () => {
    it("prefers the journal resolved when queued mutation work begins", async () => {
      const stale = recordingJournal();
      const current = recordingJournal();
      const getOperationJournal = vi.fn(() => current.port);
      const test = harness([existingFeed()], {
        operationJournal: stale.port,
        getOperationJournal,
      });

      await test.service.setPaused("legacy-feed", true);

      expect(stale.events).toEqual([]);
      expect(current.events[0]).toMatchObject({
        status: "started",
        input: { category: "subscription", action: "pause" },
      });
      expect(getOperationJournal).toHaveBeenCalledOnce();
    });

    it("contains a hostile live journal getter without changing the mutation", async () => {
      const stale = recordingJournal();
      const test = harness([existingFeed()], {
        operationJournal: stale.port,
        getOperationJournal: () => {
          throw new Error("private live journal getter failure");
        },
      });

      await expect(test.service.setPaused("legacy-feed", true)).resolves
        .toMatchObject({ subscriptionStatus: "paused" });

      expect(stale.events).toEqual([]);
      expect(test.settings.feeds[0].subscriptionStatus).toBe("paused");
      expect(test.saveSettings).toHaveBeenCalledOnce();
    });

    it("starts a successful add only after verified identity exists and closes after durable persistence", async () => {
      const journal = recordingJournal();
      const test = harness([], { operationJournal: journal.port });

      const added = await test.service.add(rssRequest());

      expect(added.feedId).toBe("new-feed-id");
      expect(journal.events).toEqual([
        {
          status: "started",
          input: {
            category: "subscription",
            action: "add",
            trigger: "manual",
            stage: "saving",
            subject: { sourceId: "new-feed-id", label: "Example custom" },
            details: { sourceKind: "rss" },
          },
        },
        {
          status: "succeeded",
          stage: "completed",
          details: { sourceKind: "rss" },
        },
      ]);
    });

    it("persists a safe add timeline through the real OperationJournalService", async () => {
      const persisted: OperationEvent[] = [];
      const operationJournal = persistedOperationJournal(persisted);
      const test = harness([], { operationJournal });
      const unsafeLabel = "https://user:secret@example.com/feed?token=raw";

      await test.service.add(rssRequest({ displayName: unsafeLabel }));
      await vi.waitFor(() => expect(persisted).toHaveLength(2));

      expect(persisted.map((event) => event.status)).toEqual([
        "started",
        "succeeded",
      ]);
      expect(persisted.map((event) => event.operationId)).toEqual([
        persisted[0]?.operationId,
        persisted[0]?.operationId,
      ]);
      expect(persisted[0]).toMatchObject({
        category: "subscription",
        action: "add",
        stage: "saving",
        subject: { sourceId: "new-feed-id" },
        details: { sourceKind: "rss" },
      });
      expect(persisted[0]?.subject).not.toHaveProperty("label");
      expect(persisted[1]).toMatchObject({
        stage: "completed",
        details: { sourceKind: "rss" },
      });
      expect(JSON.stringify(persisted)).not.toContain(unsafeLabel);
      expect(JSON.stringify(persisted)).not.toMatch(/https?:/u);
    });

    it("records one empty-subject validation failure without copying the rejected input URL", async () => {
      const journal = recordingJournal();
      const test = harness([], { operationJournal: journal.port });
      const unsafeUrl = "https://user:secret@example.com/private-feed.xml?token=raw";

      await expect(test.service.add(rssRequest({
        selectedCandidateUrl: unsafeUrl,
      }))).rejects.toMatchObject({ code: "invalid-subscription-request" });

      expect(journal.events).toEqual([
        {
          status: "started",
          input: {
            category: "subscription",
            action: "add",
            trigger: "manual",
            stage: "validating",
            subject: {},
            details: {},
          },
        },
        {
          status: "failed",
          stage: "validating",
          errorCode: "source-validation-failed",
          details: {},
        },
      ]);
      expect(JSON.stringify(journal.events)).not.toContain(unsafeUrl);
      expect(JSON.stringify(journal.events)).not.toContain("token=raw");
    });

    it("preserves a hostile parse rejection identity and fails the journal closed", async () => {
      const journal = recordingJournal();
      const test = harness([], { operationJournal: journal.port });
      const trapError = new Error("getPrototypeOf trap must not replace rejection");
      const hostileReason = new Proxy({}, {
        getPrototypeOf: () => { throw trapError; },
      });
      test.parseFeed.mockRejectedValueOnce(hostileReason);

      const rejected = await test.service.add(rssRequest()).catch(
        (reason: unknown) => reason,
      );

      expect(Object.is(rejected, hostileReason)).toBe(true);
      expect(Object.is(rejected, trapError)).toBe(false);
      expect(journal.events.at(-1)).toEqual({
        status: "failed",
        stage: "saving",
        errorCode: "subscription-operation-failed",
        details: { sourceKind: "rss" },
      });
    });

    it.each([
      {
        label: "Atom",
        request: rssRequest({
          verification: {
            ...rssRequest().verification,
            candidates: [{
              url: "https://example.com/feed.xml",
              title: "Example",
              format: "atom",
            }],
            selected: {
              url: "https://example.com/feed.xml",
              title: "Example",
              format: "atom",
            },
          },
        }),
        sourceKind: "atom",
      },
      {
        label: "JSON Feed",
        request: rssRequest({
          verification: {
            ...rssRequest().verification,
            candidates: [{
              url: "https://example.com/feed.xml",
              title: "Example",
              format: "json",
            }],
            selected: {
              url: "https://example.com/feed.xml",
              title: "Example",
              format: "json",
            },
          },
        }),
        sourceKind: "json",
      },
      {
        label: "podcast",
        request: rssRequest({ mediaType: "podcast" }),
        sourceKind: "podcast",
      },
      {
        label: "YouTube",
        request: youtubeRequest(),
        sourceKind: "youtube",
      },
    ])("projects only the verified $label source kind", async ({ request, sourceKind }) => {
      const journal = recordingJournal();
      const test = harness([], { operationJournal: journal.port });

      await test.service.add(request);

      expect(journal.events[0]).toMatchObject({
        status: "started",
        input: { details: { sourceKind } },
      });
      expect(JSON.stringify(journal.events)).not.toMatch(/https?:/u);
    });

    it("projects X account and topic kinds but does not guess a generic persisted feed format", async () => {
      const xJournal = recordingJournal();
      const xTest = harness([], { operationJournal: xJournal.port });
      await xTest.service.add(xRequest());
      expect(xJournal.events[0]).toMatchObject({
        status: "started",
        input: { details: { sourceKind: "x-account" } },
      });

      const topicJournal = recordingJournal();
      const topic = existingFeed({
        feedId: "topic-ai",
        sourceKind: "x-topic",
        sourceConfig: createXTopicSourceConfig({
          id: "topic-ai",
          name: "AI",
          folder: "Topics",
        }),
        title: "AI topic",
        url: "tikhub://x-topic/topic-ai",
      });
      const topicTest = harness([topic], { operationJournal: topicJournal.port });
      await topicTest.service.setPaused("topic-ai", true);
      expect(topicJournal.events[0]).toMatchObject({
        status: "started",
        input: {
          action: "pause",
          subject: { sourceId: "topic-ai", label: "AI topic" },
          details: { sourceKind: "x-topic" },
        },
      });

      const websiteJournal = recordingJournal();
      const websiteTest = harness([
        existingFeed({ autoDetect: true }),
      ], { operationJournal: websiteJournal.port });
      await websiteTest.service.setPaused("legacy-feed", true);
      expect(websiteJournal.events[0]).toMatchObject({
        status: "started",
        input: { details: { sourceKind: "website" } },
      });

      const feedJournal = recordingJournal();
      const feedTest = harness([existingFeed()], { operationJournal: feedJournal.port });
      await feedTest.service.setPaused("legacy-feed", true);
      expect(feedJournal.events[0]).toMatchObject({
        status: "started",
        input: { details: {} },
      });
    });

    it("starts update from persisted facts and closes with the actual returned source kind", async () => {
      const journal = recordingJournal();
      const source = existingFeed();
      const test = harness([source], { operationJournal: journal.port });

      await test.service.update("legacy-feed", youtubeRequest());

      expect(journal.events).toEqual([
        {
          status: "started",
          input: {
            category: "subscription",
            action: "update",
            trigger: "manual",
            stage: "saving",
            subject: { sourceId: "legacy-feed", label: "Legacy" },
            details: {},
          },
        },
        {
          status: "succeeded",
          stage: "completed",
          details: { sourceKind: "youtube" },
        },
      ]);
    });

    it("preserves duplicate precedence over a later invalid update policy", async () => {
      const duplicate = existingFeed({
        feedId: "duplicate",
        url: "https://duplicate.example/feed.xml",
      });
      const test = harness([existingFeed(), duplicate], {
        operationJournal: recordingJournal().port,
      });
      const request = rssRequest({
        verification: {
          inputUrl: duplicate.url,
          siteUrl: "https://duplicate.example/",
          candidates: [{ url: duplicate.url, title: "Duplicate", format: "rss" }],
          selected: { url: duplicate.url, title: "Duplicate", format: "rss" },
          hasEntries: true,
        },
        selectedCandidateUrl: duplicate.url,
        initialImportPolicy: { mode: "lookback-days", days: 0 } as never,
      });

      await expect(test.service.update("legacy-feed", request)).rejects
        .toMatchObject({ code: "duplicate-subscription" });
    });

    it("does not read update request getters an extra time for journal projection", async () => {
      const source = existingFeed();
      const test = harness([source], { operationJournal: recordingJournal().port });
      const request = rssRequest({
        verification: {
          inputUrl: source.url,
          siteUrl: "https://legacy.example/",
          candidates: [{ url: source.url, title: "Legacy", format: "rss" }],
          selected: { url: source.url, title: "Legacy", format: "rss" },
          hasEntries: true,
        },
        selectedCandidateUrl: source.url,
      });
      let policyReads = 0;
      Object.defineProperty(request, "initialImportPolicy", {
        enumerable: true,
        configurable: true,
        get: () => {
          policyReads += 1;
          return { mode: "lookback-days", days: 7 };
        },
      });

      await test.service.update("legacy-feed", request);

      expect(policyReads).toBe(1);
    });

    it("uses separate pause and resume actions and classifies settings save failure safely", async () => {
      const journal = recordingJournal();
      const test = harness([existingFeed()], { operationJournal: journal.port });

      await test.service.setPaused("legacy-feed", true);
      test.saveSettings.mockRejectedValueOnce(
        new Error("https://private.example/save?token=unsafe"),
      );
      await expect(test.service.setPaused("legacy-feed", false)).rejects.toThrow();

      expect(journal.events.filter((event) => event.status === "started").map(
        (event) => event.status === "started" ? event.input.action : undefined,
      )).toEqual(["pause", "resume"]);
      expect(journal.events.at(-1)).toEqual({
        status: "failed",
        stage: "saving",
        errorCode: "settings-save-failed",
        details: {},
      });
      expect(JSON.stringify(journal.events)).not.toContain("private.example");
      expect(test.settings.feeds[0].subscriptionStatus).toBe("paused");
    });

    it("closes remove only after retained or purged history commits and records preserveHistory", async () => {
      const retainedJournal = recordingJournal();
      const retained = harness([existingFeed()], {
        operationJournal: retainedJournal.port,
      });
      await retained.service.remove("legacy-feed", { purgeCollection: false });
      expect(retainedJournal.events).toEqual([
        expect.objectContaining({
          status: "started",
          input: expect.objectContaining({
            action: "remove",
            details: { preserveHistory: true },
          }),
        }),
        {
          status: "succeeded",
          stage: "completed",
          details: { preserveHistory: true },
        },
      ]);

      const purgedJournal = recordingJournal();
      const purged = harness([existingFeed()], {
        operationJournal: purgedJournal.port,
      });
      let releaseCommit!: () => void;
      const commit = vi.fn(async () => await new Promise<void>((resolve) => {
        releaseCommit = resolve;
      }));
      purged.collectionService.removeSource.mockResolvedValueOnce({
        days: [],
        commit,
        rollback: vi.fn(async () => undefined),
      });

      const removal = purged.service.remove("legacy-feed", {
        purgeCollection: true,
        confirmation: createConfirmedCollectionPurge("legacy-feed"),
      });
      await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce());
      expect(purgedJournal.events.some((event) => event.status === "succeeded"))
        .toBe(false);
      releaseCommit();
      await removal;

      expect(purgedJournal.events.at(-1)).toEqual({
        status: "succeeded",
        stage: "completed",
        details: { preserveHistory: false },
      });
    });

    it("classifies collection cleanup failure without exposing its raw error", async () => {
      const journal = recordingJournal();
      const test = harness([existingFeed()], { operationJournal: journal.port });
      test.collectionService.removeSource.mockRejectedValueOnce(
        new Error("https://private.example/collection?token=unsafe"),
      );

      await expect(test.service.remove("legacy-feed", {
        purgeCollection: true,
        confirmation: createConfirmedCollectionPurge("legacy-feed"),
      })).rejects.toThrow();

      expect(journal.events.at(-1)).toEqual({
        status: "failed",
        stage: "cleaning",
        errorCode: "collection-cleanup-failed",
        details: { preserveHistory: false },
      });
      expect(JSON.stringify(journal.events)).not.toContain("private.example");
      expect(test.settings.feeds).toHaveLength(1);
    });

    it("gives concurrent duplicate adds one closed operation for each actual outcome", async () => {
      const journal = recordingJournal();
      const test = harness([], { operationJournal: journal.port });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      test.parseFeed.mockImplementation(async (_url: string, seed: Feed) => {
        await gate;
        return { ...seed, items: test.selectedItems, lastUpdated: NOW.getTime() };
      });

      const first = test.service.add(rssRequest());
      const second = test.service.add(rssRequest());
      await Promise.resolve();
      release();
      const results = await Promise.allSettled([first, second]);

      expect(results.map((result) => result.status)).toEqual([
        "fulfilled",
        "rejected",
      ]);
      expect(journal.events.filter((event) => event.status === "started"))
        .toHaveLength(2);
      expect(journal.events.filter((event) =>
        event.status === "succeeded" || event.status === "failed"
      )).toEqual([
        expect.objectContaining({ status: "succeeded" }),
        expect.objectContaining({
          status: "failed",
          errorCode: "duplicate-subscription",
        }),
      ]);
    });

    it.each([
      {
        label: "begin throws synchronously",
        port: {
          begin: () => { throw new Error("journal begin failed"); },
          attach: () => { throw new Error("unused"); },
        } satisfies OperationJournalPort,
      },
      {
        label: "terminal throws synchronously",
        port: {
          begin: () => ({
            operationId: "hostile",
            progress: async () => undefined,
            succeed: () => { throw new Error("succeed threw"); },
            fail: async () => undefined,
            abort: async () => undefined,
          }),
          attach: () => { throw new Error("unused"); },
        } satisfies OperationJournalPort,
      },
      {
        label: "terminal rejects with a hostile reason",
        port: {
          begin: () => ({
            operationId: "hostile",
            progress: async () => undefined,
            succeed: async () => {
              throw new Proxy(new Error("hostile journal rejection"), {
                getPrototypeOf: () => {
                  throw new Error("hostile rejection reason inspected");
                },
              });
            },
            fail: async () => undefined,
            abort: async () => undefined,
          }),
          attach: () => { throw new Error("unused"); },
        } satisfies OperationJournalPort,
      },
    ])("does not alter the transaction when journal $label", async ({ port }) => {
      const test = harness([existingFeed()], { operationJournal: port });

      await expect(test.service.setPaused("legacy-feed", true)).resolves
        .toMatchObject({ subscriptionStatus: "paused" });

      expect(test.settings.feeds[0].subscriptionStatus).toBe("paused");
      expect(test.saveSettings).toHaveBeenCalledOnce();
    });
  });

  it("uses stable service error codes", () => {
    expect(new SubscriptionServiceError("subscription-not-found")).toMatchObject({
      code: "subscription-not-found",
      name: "SubscriptionServiceError",
    });
  });
});
