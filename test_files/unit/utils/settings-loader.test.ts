/**
 * Phase 2 (Red) — settings-loader unit tests
 *
 * FAILING OUTPUT (before settings-loader is implemented):
 * Cannot find module '../../../src/utils/settings-loader'
 *
 * These tests are RED until the three pure functions are extracted in Phase 3.
 * Each test covers one targeted scenario without any settings-loader code existing yet.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  DEFAULT_SETTINGS,
  type Feed,
  type FeedItem,
  type RssDashboardSettings,
} from "../../../src/types/types";

vi.mock("../../../src/utils/settings-loader", { spy: true });

vi.mock("../../../src/utils/settings-migration", () => ({
  migrateDisplaySettings: vi.fn(),
  migrateDefaultFilterToDashboardMultiFilters: vi.fn(),
  migrateKeywordRulesSettings: vi.fn().mockReturnValue(false),
  migrateMediaVideoTagSettings: vi.fn().mockReturnValue(false),
  migrateMediaDefaultTagArrays: vi.fn().mockReturnValue(false),
}));

vi.mock("../../../src/utils/url-utils", () => ({
  canonicalizeItemIdentityUrl: vi.fn((url: string) => url),
}));

vi.mock("../../../src/utils/validation", () => ({
  normalizeRefreshIntervalMinutes: vi.fn((v: number) => v),
}));

function createFeedItem(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    title: "Item",
    link: "https://example.com/item",
    description: "",
    pubDate: "Mon, 01 Jan 2024 00:00:00 GMT",
    guid: "item-guid",
    read: false,
    starred: false,
    tags: [],
    feedTitle: "Feed",
    feedUrl: "https://example.com/feed.xml",
    coverImage: "",
    content: "",
    ...overrides,
  };
}

function createFeed(overrides: Partial<Feed> = {}): Feed {
  return {
    title: "Feed",
    url: "https://example.com/feed.xml",
    folder: "Inbox",
    items: [],
    lastUpdated: 0,
    mediaType: "article",
    ...overrides,
  };
}

describe("settings-loader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── loadAndNormalizeSettings ─────────────────────────────────────────────────

  describe("loadAndNormalizeSettings", () => {
    it("merges DEFAULT_SETTINGS with raw data", async () => {
      const { loadAndNormalizeSettings } =
        await import("../../../src/utils/settings-loader");

      const raw = { maxItems: 42 };
      const result = loadAndNormalizeSettings(raw);

      expect(result.maxItems).toBe(42);
      expect(result.refreshInterval).toBe(DEFAULT_SETTINGS.refreshInterval);
    });

    it("defaults the locale to Chinese for settings saved before localization", async () => {
      const { loadAndNormalizeSettings } =
        await import("../../../src/utils/settings-loader");

      expect(loadAndNormalizeSettings({}).locale).toBe("zh-CN");
    });

    it("preserves a stored English locale", async () => {
      const { loadAndNormalizeSettings } =
        await import("../../../src/utils/settings-loader");

      expect(loadAndNormalizeSettings({ locale: "en" }).locale).toBe("en");
    });

    it("falls back to Chinese for an invalid stored locale", async () => {
      const { loadAndNormalizeSettings } =
        await import("../../../src/utils/settings-loader");

      expect(
        loadAndNormalizeSettings({
          locale: "fr",
        } as unknown as Partial<RssDashboardSettings>).locale,
      ).toBe("zh-CN");
    });

    it("adds RSS Dashboard CN defaults to upstream settings without replacing feeds", async () => {
      const { loadAndNormalizeSettings } =
        await import("../../../src/utils/settings-loader");
      const existingFeeds = [createFeed({ title: "Existing upstream feed" })];

      const result = loadAndNormalizeSettings({ feeds: existingFeeds });

      expect(result).toMatchObject({
        feeds: existingFeeds,
        refreshMode: "daily-on-open",
        collection: {
          enabled: true,
          dataFolder: ".rss-dashboard-data",
          dailyIndexFolder: "信息收集/每日采集",
          savedNoteFolder: "信息收集/已保存",
        },
        ai: { connections: [] },
      });
    });

    it("defaults the YouTube caption fallback opt-in to false and preserves only an explicit true", async () => {
      const { loadAndNormalizeSettings } =
        await import("../../../src/utils/settings-loader");

      expect(loadAndNormalizeSettings({
        tikhub: { ...DEFAULT_SETTINGS.tikhub },
      }).tikhub.youtubeTranscriptFallbackEnabled).toBe(false);

      expect(loadAndNormalizeSettings({
        tikhub: {
          ...DEFAULT_SETTINGS.tikhub,
          youtubeTranscriptFallbackEnabled: true,
        },
      } as unknown as Partial<RssDashboardSettings>).tikhub.youtubeTranscriptFallbackEnabled).toBe(true);
    });

    it("ignores inherited and getter-backed YouTube caption fallback opt-ins", async () => {
      const { loadAndNormalizeSettings } =
        await import("../../../src/utils/settings-loader");
      const getter = vi.fn(() => true);
      const tikhub = Object.create({ youtubeTranscriptFallbackEnabled: true });
      Object.assign(tikhub, DEFAULT_SETTINGS.tikhub);
      Object.defineProperty(tikhub, "youtubeTranscriptFallbackEnabled", {
        enumerable: true,
        get: getter,
      });

      const result = loadAndNormalizeSettings({
        tikhub,
      } as unknown as Partial<RssDashboardSettings>);

      expect(result.tikhub.youtubeTranscriptFallbackEnabled).toBe(false);
      expect(getter).not.toHaveBeenCalled();
    });

    it("migrates AI metadata additively without inventing a connection or key", async () => {
      const { loadAndNormalizeSettings } =
        await import("../../../src/utils/settings-loader");
      const feed = createFeed({ title: "Existing" });
      const raw = {
        locale: "en",
        feeds: [feed],
        collection: { ...DEFAULT_SETTINGS.collection },
        tikhub: { ...DEFAULT_SETTINGS.tikhub, connectionId: "" },
        ai: {
          API_Key: "legacy-ai-secret",
          token: "legacy-ai-token",
          connections: [],
        },
        aiApiKey: "legacy-top-level-ai-secret",
        unrelatedToken: "keep-unrelated-context",
      } as unknown as Partial<RssDashboardSettings>;

      const first = loadAndNormalizeSettings(raw);
      const second = loadAndNormalizeSettings(first);
      const firstRecord = first as unknown as Record<string, unknown>;

      expect(first.ai).toEqual({ connections: [] });
      expect(second).toEqual(first);
      expect(first.locale).toBe("en");
      expect(first.feeds).toHaveLength(1);
      expect(first.collection).toEqual(DEFAULT_SETTINGS.collection);
      expect(first.tikhub).toEqual(DEFAULT_SETTINGS.tikhub);
      expect(firstRecord.aiApiKey).toBeUndefined();
      expect(firstRecord.unrelatedToken).toBe("keep-unrelated-context");
      expect(JSON.stringify(first.ai)).not.toMatch(/api.?key|token|secret/iu);
    });

    it("removes explicit AI and provider-prefixed top-level key aliases only", async () => {
      const { loadAndNormalizeSettings } =
        await import("../../../src/utils/settings-loader");
      const sentinel = ["runtime", "ai", "credential"].join("-");
      const aliases = [
        "aiKey",
        "AI_Access_Token",
        "Claude_Key",
        "KimiKey",
        "MoonshotBearerToken",
        "DeepSeekKey",
        "QwenKey",
        "DashscopeApiKey",
        "GlmKey",
        "BigModelToken",
        "ZhipuAccessToken",
        "OpenAIKey",
        "OpenAI_ApiKey",
        "AnthropicBearerToken",
      ];
      const raw: Record<string, unknown> = {
        apiKey: "generic-top-level-kept",
        token: "generic-top-level-token-kept",
        TikHubApiKey: sentinel,
        OtherAppApiKey: "other-app-kept",
        ai: { connections: [] },
      };
      for (const alias of aliases) raw[alias] = sentinel;

      const normalized = loadAndNormalizeSettings(
        raw as unknown as Partial<RssDashboardSettings>,
      ) as unknown as Record<string, unknown>;

      for (const alias of aliases) expect(normalized[alias]).toBeUndefined();
      expect(normalized.apiKey).toBe("generic-top-level-kept");
      expect(normalized.token).toBe("generic-top-level-token-kept");
      expect(normalized.OtherAppApiKey).toBe("other-app-kept");
      expect(normalized.TikHubApiKey).toBeUndefined();
      expect(JSON.stringify(normalized)).not.toContain(sentinel);
    });

    it("does not read inherited or getter-backed AI key aliases", async () => {
      const { loadAndNormalizeSettings } =
        await import("../../../src/utils/settings-loader");
      const sentinel = ["runtime", "ai", "credential"].join("-");
      let getterCalls = 0;
      const ai = { connections: [] } as Record<string, unknown>;
      Object.defineProperty(ai, "OpenAI_ApiKey", {
        enumerable: true,
        get() {
          getterCalls += 1;
          return sentinel;
        },
      });
      const inheritedAi = Object.create({ KimiKey: sentinel }) as Record<
        string,
        unknown
      >;
      Object.defineProperty(inheritedAi, "connections", {
        enumerable: true,
        value: [],
      });

      expect(
        loadAndNormalizeSettings({
          ai,
        } as unknown as Partial<RssDashboardSettings>).ai,
      ).toEqual({ connections: [] });
      expect(
        loadAndNormalizeSettings({
          ai: inheritedAi,
        } as unknown as Partial<RssDashboardSettings>).ai,
      ).toEqual({ connections: [] });
      expect(getterCalls).toBe(0);
    });

    it("removes key aliases only from AI connection context", async () => {
      const { loadAndNormalizeSettings } =
        await import("../../../src/utils/settings-loader");
      const feedWithUnrelatedField = createFeed() as Feed & {
        apiKey: string;
      };
      feedWithUnrelatedField.apiKey = "unrelated-feed-field";

      const result = loadAndNormalizeSettings({
        feeds: [feedWithUnrelatedField],
        ai: {
          connections: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              name: "Relay",
              providerKind: "openai-compatible",
              protocol: "openai-chat",
              baseUrl: "https://relay.example.com/v1",
              model: "relay-model",
              timeoutMs: 60_000,
              maxInputCharacters: 80_000,
              enabled: true,
              Api_Key: "legacy-secret",
            },
          ],
        },
      } as unknown as Partial<RssDashboardSettings>);

      expect((result.feeds[0] as Feed & { apiKey?: string }).apiKey).toBe(
        "unrelated-feed-field",
      );
      expect(result.ai).toEqual({
        connections: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            name: "Relay",
            providerKind: "openai-compatible",
            protocol: "openai-chat",
            baseUrl: "https://relay.example.com/v1",
            model: "relay-model",
            timeoutMs: 60_000,
            maxInputCharacters: 80_000,
            enabled: true,
          },
        ],
      });
    });

    it("does not sanitize unknown AI structure into an apparently valid connection", async () => {
      const { loadAndNormalizeSettings } =
        await import("../../../src/utils/settings-loader");
      const unknownField = Symbol("unknown-field");
      const candidate = {
        id: "11111111-1111-4111-8111-111111111111",
        name: "Relay",
        providerKind: "openai-compatible",
        protocol: "openai-chat",
        baseUrl: "https://relay.example.com/v1",
        model: "relay-model",
        timeoutMs: 60_000,
        maxInputCharacters: 80_000,
        enabled: true,
        [unknownField]: "must-reject",
      };
      const connections = [candidate];
      Object.defineProperty(connections, "extra", {
        enumerable: true,
        value: "must-reject",
      });

      expect(
        loadAndNormalizeSettings({
          ai: { connections },
        } as unknown as Partial<RssDashboardSettings>).ai,
      ).toEqual({ connections: [] });
    });

    it("fails closed when hostile AI array reflection throws", async () => {
      const { loadAndNormalizeSettings } =
        await import("../../../src/utils/settings-loader");
      const connections = new Proxy([], {
        getPrototypeOf() {
          throw new Error("hostile AI array");
        },
      });

      expect(() =>
        loadAndNormalizeSettings({
          ai: { connections },
        } as unknown as Partial<RssDashboardSettings>),
      ).not.toThrow();
      expect(
        loadAndNormalizeSettings({
          ai: { connections },
        } as unknown as Partial<RssDashboardSettings>).ai,
      ).toEqual({ connections: [] });
    });

    it("migrates legacy feeds to the typed RSS source without changing their persisted data", async () => {
      const { loadAndNormalizeSettings } =
        await import("../../../src/utils/settings-loader");
      const legacy = createFeed({
        title: "Existing upstream feed",
        url: "https://example.com/feed.xml",
        items: [createFeedItem()],
      });

      const result = loadAndNormalizeSettings({ feeds: [legacy] });

      expect(result.feeds[0]).toMatchObject({
        title: "Existing upstream feed",
        url: "https://example.com/feed.xml",
        sourceKind: "feed",
        sourceConfig: { kind: "feed" },
        items: [legacy.items[0]],
      });
    });

    it("normalizes persisted X account and topic source configs idempotently", async () => {
      const { loadAndNormalizeSettings } =
        await import("../../../src/utils/settings-loader");
      const raw = {
        feeds: [
          createFeed({
            title: "OpenAI",
            url: "tikhub://x-account/openai",
            sourceKind: "x-account",
            sourceConfig: {
              kind: "x-account",
              id: "account-1",
              handle: " OpenAI ",
              includeReplies: false,
              includeReposts: false,
              folder: " X ",
              topics: ["AI", "ai"],
            },
          } as unknown as Feed),
          createFeed({
            title: "AI",
            url: "tikhub://x-topic/topic-1",
            sourceKind: "x-topic",
            sourceConfig: {
              kind: "x-topic",
              id: "topic-1",
              name: " AI ",
              includeKeywords: ["AI", "ai"],
              excludeKeywords: [],
              priorityAccounts: ["OpenAI", "openai"],
              windowDays: 7,
              folder: " 主题 ",
            },
          } as unknown as Feed),
        ],
      } as unknown as Partial<RssDashboardSettings>;

      const first = loadAndNormalizeSettings(raw);
      const second = loadAndNormalizeSettings(first);

      expect(
        first.feeds.map((feed) => [feed.sourceKind, feed.sourceConfig]),
      ).toEqual([
        [
          "x-account",
          expect.objectContaining({ handle: "openai", topics: ["AI"] }),
        ],
        [
          "x-topic",
          expect.objectContaining({
            includeKeywords: ["AI"],
            priorityAccounts: ["openai"],
            windowDays: 7,
          }),
        ],
      ]);
      expect(second.feeds).toEqual(first.feeds);
    });

    it("quarantines invalid declared X sources instead of routing them through RSS", async () => {
      const { loadAndNormalizeSettings } =
        await import("../../../src/utils/settings-loader");
      const result = loadAndNormalizeSettings({
        feeds: [
          createFeed({
            sourceKind: "x-account",
            sourceConfig: { kind: "x-account", handle: "@unsafe" },
          } as unknown as Feed),
        ],
      });

      expect(result.feeds[0]).toMatchObject({
        sourceKind: "x-account",
        url: "tikhub://x-account/unconfigured-1",
        excludeFromRefresh: true,
        lastFetchError: "Invalid X source configuration",
      });
      expect(result.feeds[0].sourceConfig).toBeUndefined();
    });

    it("quarantines an X source inferred from a synthetic URL even when its config is absent", async () => {
      const { loadAndNormalizeSettings } =
        await import("../../../src/utils/settings-loader");
      const result = loadAndNormalizeSettings({
        feeds: [
          createFeed({
            url: "tikhub://x-topic/topic-1",
            sourceConfig: undefined,
          } as unknown as Feed),
        ],
      });

      expect(result.feeds[0]).toMatchObject({
        sourceKind: "x-topic",
        url: "tikhub://x-topic/topic-1",
        excludeFromRefresh: true,
      });
    });

    it("quarantines an X source inferred from an invalid raw X config", async () => {
      const { loadAndNormalizeSettings } =
        await import("../../../src/utils/settings-loader");
      const result = loadAndNormalizeSettings({
        feeds: [
          createFeed({
            sourceConfig: { kind: "x-topic", id: "invalid/identifier" },
          } as unknown as Feed),
        ],
      });

      expect(result.feeds[0]).toMatchObject({
        sourceKind: "x-topic",
        url: "tikhub://x-topic/unconfigured-1",
        excludeFromRefresh: true,
      });
    });

    it.each([
      "tikhub://x-account/openai?cursor=paid",
      "tikhub://x-topic/topic-1/extra-path",
      "tikhub://x-topic/invalid/id",
    ])("quarantines any malformed X synthetic prefix: %s", async (url) => {
      const { loadAndNormalizeSettings } =
        await import("../../../src/utils/settings-loader");
      const result = loadAndNormalizeSettings({
        feeds: [createFeed({ url } as unknown as Feed)],
      });

      expect(result.feeds[0]).toMatchObject({
        sourceKind: url.includes("x-account") ? "x-account" : "x-topic",
        excludeFromRefresh: true,
        lastFetchError: "Invalid X source configuration",
      });
      expect(result.feeds[0].url).toMatch(
        /^tikhub:\/\/x-(account|topic)\/unconfigured-1$/,
      );
    });

    it.each([
      ["tikhub://x-account%2Fopenai", "x-account"],
      ["tikhub://x-account\\openai", "x-account"],
      ["tikhub://x-account-openai", "x-account"],
      ["tikhub://x-topic.evil/rss", "x-topic"],
      ["TikHub://X-ACCOUNT/openai", "x-account"],
      ["TIKHUB://X-TOPIC/topic-1", "x-topic"],
    ])(
      "quarantines a malformed or case-variant X prefix: %s",
      async (url, sourceKind) => {
        const { loadAndNormalizeSettings } =
          await import("../../../src/utils/settings-loader");
        const result = loadAndNormalizeSettings({
          feeds: [createFeed({ url } as unknown as Feed)],
        });

        expect(result.feeds[0]).toMatchObject({
          sourceKind,
          excludeFromRefresh: true,
          lastFetchError: "Invalid X source configuration",
          url: `tikhub://${sourceKind}/unconfigured-1`,
        });
      },
    );

    it("does not misclassify unrelated tikhub schemes as X sources", async () => {
      const { loadAndNormalizeSettings } =
        await import("../../../src/utils/settings-loader");
      const result = loadAndNormalizeSettings({
        feeds: [createFeed({ url: "tikhub://unrelated-x-account/openai" })],
      });

      expect(result.feeds[0]).toMatchObject({
        sourceKind: "feed",
        sourceConfig: { kind: "feed" },
      });
    });

    it("deduplicates loaded X sources by canonical account handle or topic id", async () => {
      const { loadAndNormalizeSettings } =
        await import("../../../src/utils/settings-loader");
      const account = (handle: string) =>
        createFeed({
          sourceKind: "x-account",
          sourceConfig: {
            kind: "x-account",
            id: `account-${handle}`,
            handle,
            includeReplies: false,
            includeReposts: false,
            folder: "X",
            topics: [],
          },
        } as unknown as Feed);
      const topic = (id: string) =>
        createFeed({
          sourceKind: "x-topic",
          sourceConfig: {
            kind: "x-topic",
            id,
            name: id,
            includeKeywords: [],
            excludeKeywords: [],
            priorityAccounts: [],
            windowDays: 7,
            folder: "X",
          },
        } as unknown as Feed);

      const first = loadAndNormalizeSettings({
        feeds: [
          account("OpenAI"),
          account("openai"),
          topic("topic-1"),
          topic("topic-1"),
          topic("topic-2"),
        ],
      });
      const second = loadAndNormalizeSettings(first);

      expect(first.feeds).toHaveLength(3);
      expect(first.feeds.map((feed) => feed.url)).toEqual([
        "tikhub://x-account/openai",
        "tikhub://x-topic/topic-1",
        "tikhub://x-topic/topic-2",
      ]);
      expect(second.feeds).toEqual(first.feeds);
    });

    it("merges partial collection settings with their defaults", async () => {
      const { loadAndNormalizeSettings } =
        await import("../../../src/utils/settings-loader");

      const result = loadAndNormalizeSettings({
        collection: { dataFolder: "RSS data" },
      } as unknown as Partial<RssDashboardSettings>);

      expect(result.collection).toEqual({
        enabled: true,
        dataFolder: "RSS data",
        dailyIndexFolder: "信息收集/每日采集",
        savedNoteFolder: "信息收集/已保存",
      });
    });

    it("normalizes refreshInterval via normalizeRefreshIntervalMinutes", async () => {
      const { normalizeRefreshIntervalMinutes } =
        await import("../../../src/utils/validation");
      const { loadAndNormalizeSettings } =
        await import("../../../src/utils/settings-loader");
      (
        normalizeRefreshIntervalMinutes as ReturnType<typeof vi.fn>
      ).mockReturnValue(15);

      const raw = { refreshInterval: 7 };
      const result = loadAndNormalizeSettings(raw);

      expect(normalizeRefreshIntervalMinutes).toHaveBeenCalledWith(7);
      expect(result.refreshInterval).toBe(15);
    });

    it("applies defaultAutoDeleteDuration to feeds missing autoDeleteDuration", async () => {
      const { loadAndNormalizeSettings } =
        await import("../../../src/utils/settings-loader");

      const raw: Partial<RssDashboardSettings> = {
        defaultAutoDeleteDuration: 14,
        feeds: [createFeed({ title: "No Duration" })],
      };
      const result = loadAndNormalizeSettings(raw);

      expect(result.feeds[0].autoDeleteDuration).toBe(14);
    });

    it("applies maxItems to feeds missing maxItemsLimit", async () => {
      const { loadAndNormalizeSettings } =
        await import("../../../src/utils/settings-loader");

      const raw: Partial<RssDashboardSettings> = {
        maxItems: 75,
        feeds: [createFeed({ title: "No Limit" })],
      };
      const result = loadAndNormalizeSettings(raw);

      expect(result.feeds[0].maxItemsLimit).toBe(75);
    });

    it("normalizes all five page-size fields to allArticlesPageSize", async () => {
      const { loadAndNormalizeSettings } =
        await import("../../../src/utils/settings-loader");

      const raw = {
        allArticlesPageSize: 20,
        unreadArticlesPageSize: 99,
        readArticlesPageSize: 50,
        savedArticlesPageSize: 10,
        starredArticlesPageSize: 30,
      };
      const result = loadAndNormalizeSettings(raw);

      expect(result.unreadArticlesPageSize).toBe(20);
      expect(result.readArticlesPageSize).toBe(20);
      expect(result.savedArticlesPageSize).toBe(20);
      expect(result.starredArticlesPageSize).toBe(20);
    });

    it("normalizes invalid availableTags to defaults", async () => {
      const { loadAndNormalizeSettings } =
        await import("../../../src/utils/settings-loader");

      const raw = {
        availableTags: null as unknown as RssDashboardSettings["availableTags"],
      };
      const result = loadAndNormalizeSettings(raw);

      expect(Array.isArray(result.availableTags)).toBe(true);
      expect(result.availableTags.length).toBeGreaterThan(0);
      expect(
        result.availableTags.map((tag) => tag.name.toLowerCase()),
      ).toContain("video");
    });

    it("inherits savedArticleOpenLocation from readerViewLocation when missing", async () => {
      const { loadAndNormalizeSettings } =
        await import("../../../src/utils/settings-loader");

      const raw: Partial<RssDashboardSettings> = {
        readerViewLocation: "left-sidebar",
      };
      const result = loadAndNormalizeSettings(raw);

      expect(result.savedArticleOpenLocation).toBe("left-sidebar");
    });

    it("migrates external-browser savedArticleOpenLocation to main", async () => {
      const { loadAndNormalizeSettings } =
        await import("../../../src/utils/settings-loader");

      const raw: Partial<RssDashboardSettings> = {
        readerViewLocation: "right-sidebar",
        savedArticleOpenLocation: "external-browser",
      };
      const result = loadAndNormalizeSettings(raw);

      expect(result.savedArticleOpenLocation).toBe("main");
    });

    it("sets startupRefreshDelaySeconds to 5 when missing", async () => {
      const { loadAndNormalizeSettings } =
        await import("../../../src/utils/settings-loader");

      const raw = {};
      const result = loadAndNormalizeSettings(raw);

      expect(result.startupRefreshDelaySeconds).toBe(5);
    });

    it("falls back to default for invalid startupRefreshDelaySeconds", async () => {
      const { loadAndNormalizeSettings } =
        await import("../../../src/utils/settings-loader");

      const raw = { startupRefreshDelaySeconds: -3 };
      const result = loadAndNormalizeSettings(raw);

      expect(result.startupRefreshDelaySeconds).toBe(
        DEFAULT_SETTINGS.startupRefreshDelaySeconds,
      );
    });

    it("infers legacy-json for existing installations missing storageMode (has feeds)", async () => {
      const { loadAndNormalizeSettings } =
        await import("../../../src/utils/settings-loader");

      const raw = { feeds: [createFeed()] };
      const result = loadAndNormalizeSettings(raw);

      expect(result.storageMode).toBe("legacy-json");
    });

    it("infers legacy-json for existing installations missing storageMode (has refresh history)", async () => {
      const { loadAndNormalizeSettings } =
        await import("../../../src/utils/settings-loader");

      const raw = { lastRefreshTimestamp: 123456789 };
      const result = loadAndNormalizeSettings(raw);

      expect(result.storageMode).toBe("legacy-json");
    });

    it("defaults to vault-shards-v2 for fresh installations missing storageMode", async () => {
      const { loadAndNormalizeSettings } =
        await import("../../../src/utils/settings-loader");

      const raw = {}; // Fresh install
      const result = loadAndNormalizeSettings(raw);

      expect(result.storageMode).toBe("vault-shards-v2");
    });
  });

  // ── migrateSettings ──────────────────────────────────────────────────────────

  describe("migrateSettings", () => {
    it("leaves legacy feeds without import fields completed instead of pending", async () => {
      const { migrateSettings } =
        await import("../../../src/utils/settings-loader");
      const feed = createFeed();
      const settings = {
        ...DEFAULT_SETTINGS,
        feeds: [feed],
      } as RssDashboardSettings;

      migrateSettings(settings);

      expect(settings.feeds[0]).not.toHaveProperty("initialImportPolicy");
      expect(settings.feeds[0]).not.toHaveProperty("initialImportProgress");
      expect(settings.feeds[0].subscriptionStatus).toBeUndefined();
    });

    it("normalizes only supplied import fields and discards invalid progress", async () => {
      const { migrateSettings } =
        await import("../../../src/utils/settings-loader");
      const feed = createFeed() as Feed & Record<string, unknown>;
      feed.initialImportPolicy = { mode: "lookback-days", days: 14 };
      feed.initialImportProgress = {
        status: "running",
        pagesFetched: -1,
        itemsImported: 2,
      };
      feed.subscriptionStatus = "paused";
      const settings = {
        ...DEFAULT_SETTINGS,
        feeds: [feed],
      } as RssDashboardSettings;

      migrateSettings(settings);

      expect(settings.feeds[0].initialImportPolicy).toEqual({
        mode: "lookback-days",
        days: 14,
      });
      expect(settings.feeds[0]).not.toHaveProperty("initialImportProgress");
      expect(settings.feeds[0].subscriptionStatus).toBe("paused");
    });

    it("migrates savePath to articleSaving.defaultFolder", async () => {
      const { migrateSettings } =
        await import("../../../src/utils/settings-loader");

      const settings = {
        ...DEFAULT_SETTINGS,
        savePath: "/vault/Articles",
      } as unknown as RssDashboardSettings & Record<string, unknown>;
      migrateSettings(settings as unknown as RssDashboardSettings);

      expect(settings.articleSaving.defaultFolder).toBe("/vault/Articles");
      expect(settings.savePath).toBeUndefined();
    });

    it("migrates legacy template to articleSaving.defaultTemplate", async () => {
      const { migrateSettings } =
        await import("../../../src/utils/settings-loader");

      const settings = {
        ...DEFAULT_SETTINGS,
        template: "# {{title}}",
      } as unknown as RssDashboardSettings & Record<string, unknown>;
      migrateSettings(settings as unknown as RssDashboardSettings);

      expect(settings.articleSaving.defaultTemplate).toBe("# {{title}}");
      expect(settings.template).toBeUndefined();
    });

    it("migrates addSavedTag to articleSaving.addSavedTag", async () => {
      const { migrateSettings } =
        await import("../../../src/utils/settings-loader");

      const settings = {
        ...DEFAULT_SETTINGS,
        addSavedTag: true,
        articleSaving: {
          ...DEFAULT_SETTINGS.articleSaving,
          addSavedTag: undefined,
        },
      } as unknown as RssDashboardSettings & Record<string, unknown>;
      migrateSettings(settings as unknown as RssDashboardSettings);

      expect(settings.articleSaving.addSavedTag).toBe(true);
      expect(settings.addSavedTag).toBeUndefined();
    });

    it("initializes missing dashboardMultiFilters from defaults", async () => {
      const { migrateSettings } =
        await import("../../../src/utils/settings-loader");

      const settings = {
        ...DEFAULT_SETTINGS,
        dashboardMultiFilters: undefined,
      } as unknown as RssDashboardSettings;
      migrateSettings(settings);

      expect(settings.dashboardMultiFilters).toEqual(
        DEFAULT_SETTINGS.dashboardMultiFilters,
      );
    });

    it("normalizes dashboardMultiFilters.logic to 'OR' when invalid", async () => {
      const { migrateSettings } =
        await import("../../../src/utils/settings-loader");

      const settings = {
        ...DEFAULT_SETTINGS,
        dashboardMultiFilters: {
          statusFilters: [],
          tagFilters: [],
          logic: "INVALID",
        },
      } as unknown as RssDashboardSettings;
      migrateSettings(settings);

      expect(settings.dashboardMultiFilters.logic).toBe("OR");
    });

    it("migrates useDomainFavicons in display to useDomainIconsRss in display", async () => {
      const { migrateSettings } =
        await import("../../../src/utils/settings-loader");

      const settings = {
        ...DEFAULT_SETTINGS,
        display: {
          ...DEFAULT_SETTINGS.display,
          useDomainFavicons: true,
        },
        media: {
          ...DEFAULT_SETTINGS.media,
          useDomainIconsRss: false,
        },
      } as unknown as RssDashboardSettings & Record<string, unknown>;

      const changed = migrateSettings(
        settings as unknown as RssDashboardSettings,
      );

      expect(changed).toBe(true);
      expect(settings.display.useDomainIconsRss).toBe(true);
      expect(
        (settings.display as unknown as Record<string, unknown>)
          .useDomainFavicons,
      ).toBeUndefined();
    });
  });

  // ── dedupeAndNormalizeFeedItems ──────────────────────────────────────────────

  describe("dedupeAndNormalizeFeedItems", () => {
    it("merges duplicate GUIDs, preferring longer content", async () => {
      const { dedupeAndNormalizeFeedItems } =
        await import("../../../src/utils/settings-loader");

      const feeds: Feed[] = [
        createFeed({
          items: [
            createFeedItem({
              guid: "item-1",
              title: "Short",
              content: "Short body",
              link: "https://example.com/1",
            }),
            createFeedItem({
              guid: "item-1",
              title: "Short",
              content: "Much longer body content",
              link: "https://example.com/1",
            }),
          ],
        }),
      ];

      const changed = dedupeAndNormalizeFeedItems(feeds);

      expect(changed).toBe(true);
      expect(feeds[0].items).toHaveLength(1);
      expect(feeds[0].items[0].content).toBe("Much longer body content");
    });

    it("merges tags without duplicates", async () => {
      const { dedupeAndNormalizeFeedItems } =
        await import("../../../src/utils/settings-loader");

      const feeds: Feed[] = [
        createFeed({
          items: [
            createFeedItem({
              guid: "item-2",
              title: "A",
              link: "https://example.com/2",
              tags: [{ name: "tech", color: "#000000" }],
            }),
            createFeedItem({
              guid: "item-2",
              title: "A",
              link: "https://example.com/2",
              tags: [
                { name: "tech", color: "#000000" },
                { name: "news", color: "#111111" },
              ],
            }),
          ],
        }),
      ];

      dedupeAndNormalizeFeedItems(feeds);

      const tags = feeds[0].items[0].tags ?? [];
      const tagNames = tags.map((t: { name: string }) => t.name);
      expect(tagNames).toContain("tech");
      expect(tagNames).toContain("news");
      expect(tagNames.filter((n: string) => n === "tech")).toHaveLength(1);
    });

    it("sorts items newest-first", async () => {
      const { dedupeAndNormalizeFeedItems } =
        await import("../../../src/utils/settings-loader");

      const feeds: Feed[] = [
        createFeed({
          items: [
            createFeedItem({
              guid: "old",
              title: "Old",
              link: "https://example.com/old",
              pubDate: "Mon, 01 Jan 2024 00:00:00 GMT",
            }),
            createFeedItem({
              guid: "new",
              title: "New",
              link: "https://example.com/new",
              pubDate: "Mon, 01 Apr 2024 00:00:00 GMT",
            }),
          ],
        }),
      ];

      dedupeAndNormalizeFeedItems(feeds);

      expect(feeds[0].items[0].guid).toBe("new");
      expect(feeds[0].items[1].guid).toBe("old");
    });

    it("canonicalizes item GUIDs via canonicalizeItemIdentityUrl", async () => {
      const { canonicalizeItemIdentityUrl } =
        await import("../../../src/utils/url-utils");
      (
        canonicalizeItemIdentityUrl as ReturnType<typeof vi.fn>
      ).mockImplementation((url: string) => url.replace(/^https?:/, "https:"));
      const { dedupeAndNormalizeFeedItems } =
        await import("../../../src/utils/settings-loader");

      const feeds: Feed[] = [
        createFeed({
          items: [
            createFeedItem({
              guid: "http://example.com/item",
              title: "Item",
              link: "http://example.com/item",
            }),
          ],
        }),
      ];

      dedupeAndNormalizeFeedItems(feeds);

      expect(feeds[0].items[0].guid).toBe("https://example.com/item");
    });

    it("merges YouTube duplicate entries (yt:video: vs watch URL vs shorts URL) on startup", async () => {
      // Regression test: shards can contain paired duplicates for the same
      // YouTube video stored under different GUID forms. dedupeAndNormalizeFeedItems
      // must collapse them to a single item using the canonical yt:video: key,
      // merging read/starred state from both entries.
      const { canonicalizeItemIdentityUrl } =
        await import("../../../src/utils/url-utils");

      // Mock canonicalizeItemIdentityUrl to perform YouTube normalisation so this
      // test exercises the deduplication logic without depending on the full
      // url-utils implementation (unit isolation).
      const YT_VIDEO_ID_RE = /^[-_A-Za-z0-9]{11}$/;
      (
        canonicalizeItemIdentityUrl as ReturnType<typeof vi.fn>
      ).mockImplementation((id: string): string => {
        if (id.startsWith("yt:video:")) {
          const videoId = id.slice("yt:video:".length);
          return YT_VIDEO_ID_RE.test(videoId) ? `yt:video:${videoId}` : id;
        }
        try {
          const u = new URL(id);
          const host = u.hostname.toLowerCase();
          if (
            host === "www.youtube.com" ||
            host === "youtube.com" ||
            host === "m.youtube.com"
          ) {
            const v = u.searchParams.get("v");
            if (v && YT_VIDEO_ID_RE.test(v)) return `yt:video:${v}`;
            const m = u.pathname.match(
              /^\/shorts\/([-_A-Za-z0-9]{11})(?:[/?#]|$)/,
            );
            if (m) return `yt:video:${m[1]}`;
          }
        } catch {
          // not a URL
        }
        return id;
      });

      const { dedupeAndNormalizeFeedItems } =
        await import("../../../src/utils/settings-loader");

      const feeds: Feed[] = [
        createFeed({
          items: [
            // Older entry – URL form guid, user has read this one
            createFeedItem({
              guid: "https://www.youtube.com/shorts/4slngTaicg8",
              title: "60% of people have a drinking problem",
              link: "https://www.youtube.com/shorts/4slngTaicg8",
              read: true,
              starred: false,
              pubDate: "2026-05-12 18:11:59",
            }),
            // Duplicate entry – yt:video form from a different parsing path
            createFeedItem({
              guid: "yt:video:4slngTaicg8",
              title: "60% of people have a drinking problem",
              link: "https://www.youtube.com/shorts/4slngTaicg8",
              read: false,
              starred: false,
              pubDate: "2026-05-12T18:11:59+00:00",
            }),
          ],
        }),
      ];

      const changed = dedupeAndNormalizeFeedItems(feeds);

      expect(changed).toBe(true);
      expect(feeds[0].items).toHaveLength(1);
      // Canonical guid must be the yt:video: form
      expect(feeds[0].items[0].guid).toBe("yt:video:4slngTaicg8");
      // read state must be merged (true | false = true)
      expect(feeds[0].items[0].read).toBe(true);
    });

    it("merges three YouTube entries for the same video (watch, shorts, yt:video) to one", async () => {
      // Edge case: a feed might accumulate all three GUID forms for one video.
      const { canonicalizeItemIdentityUrl } =
        await import("../../../src/utils/url-utils");

      const YT_VIDEO_ID_RE = /^[-_A-Za-z0-9]{11}$/;
      (
        canonicalizeItemIdentityUrl as ReturnType<typeof vi.fn>
      ).mockImplementation((id: string): string => {
        if (id.startsWith("yt:video:")) {
          const videoId = id.slice("yt:video:".length);
          return YT_VIDEO_ID_RE.test(videoId) ? `yt:video:${videoId}` : id;
        }
        try {
          const u = new URL(id);
          const host = u.hostname.toLowerCase();
          if (
            host === "www.youtube.com" ||
            host === "youtube.com" ||
            host === "m.youtube.com"
          ) {
            const v = u.searchParams.get("v");
            if (v && YT_VIDEO_ID_RE.test(v)) return `yt:video:${v}`;
            const m = u.pathname.match(
              /^\/shorts\/([-_A-Za-z0-9]{11})(?:[/?#]|$)/,
            );
            if (m) return `yt:video:${m[1]}`;
          }
        } catch {
          // not a URL
        }
        return id;
      });

      const { dedupeAndNormalizeFeedItems } =
        await import("../../../src/utils/settings-loader");

      const feeds: Feed[] = [
        createFeed({
          items: [
            createFeedItem({
              guid: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
              starred: true,
            }),
            createFeedItem({
              guid: "https://www.youtube.com/shorts/dQw4w9WgXcQ",
              read: true,
            }),
            createFeedItem({ guid: "yt:video:dQw4w9WgXcQ" }),
          ],
        }),
      ];

      dedupeAndNormalizeFeedItems(feeds);

      expect(feeds[0].items).toHaveLength(1);
      expect(feeds[0].items[0].guid).toBe("yt:video:dQw4w9WgXcQ");
      expect(feeds[0].items[0].read).toBe(true);
      expect(feeds[0].items[0].starred).toBe(true);
    });
  });
});
