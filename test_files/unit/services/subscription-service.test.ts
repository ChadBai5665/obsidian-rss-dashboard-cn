import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SubscriptionService,
  SubscriptionServiceError,
  createConfirmedCollectionPurge,
  type VerifiedFeedSubscriptionRequest,
  type VerifiedXSubscriptionRequest,
  type XSubscriptionOptionsUpdateRequest,
} from "../../../src/services/subscription-service";
import {
  XProfileResolver,
  type VerifiedXProfile,
} from "../../../src/sources/tikhub/x-profile-resolver";
import type { Feed, FeedItem } from "../../../src/types/types";

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

function harness(initialFeeds: Feed[] = []) {
  const settings = { feeds: initialFeeds };
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
  const saveSettings = vi.fn(async () => {
    snapshots.push(structuredClone(settings.feeds));
  });
  const ensureFolder = vi.fn(async () => undefined);
  const service = new SubscriptionService({
    settings,
    defaults: { autoDeleteDuration: 30, maxItems: 1 },
    parseFeed,
    collectionService,
    ensureFolder,
    saveSettings,
    now: () => NOW,
    createFeedId: () => "new-feed-id",
  });
  return {
    service,
    settings,
    snapshots,
    selectedItems,
    parseFeed,
    collectionService,
    saveSettings,
    ensureFolder,
  };
}

beforeEach(async () => {
  vi.restoreAllMocks();
  currentXVerification = await mintXVerification();
});

describe("SubscriptionService", () => {
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

  it("uses stable service error codes", () => {
    expect(new SubscriptionServiceError("subscription-not-found")).toMatchObject({
      code: "subscription-not-found",
      name: "SubscriptionServiceError",
    });
  });
});
