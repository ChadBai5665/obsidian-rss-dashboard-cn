import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type RssDashboardSettings } from "../../../src/types/types";
import {
  buildPublicSettingsExport,
  MAX_PUBLIC_SETTINGS_JSON_CHARACTERS,
  parsePublicSettingsImportJson,
  preparePublicSettingsImport,
  PublicSettingsExportError,
} from "../../../src/security/public-settings-export";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";

function settingsFixture(): RssDashboardSettings {
  const settings = JSON.parse(
    JSON.stringify(DEFAULT_SETTINGS),
  ) as RssDashboardSettings;
  settings.folders = [
    {
      name: "研究",
      subfolders: [],
      createdAt: 1,
      modifiedAt: 2,
      pinned: true,
    },
  ];
  settings.feeds = [
    {
      title: "Example feed",
      url: "https://example.com/feed.xml",
      siteUrl: "https://example.com",
      folder: "研究",
      items: [
        {
          title: "PRIVATE_ITEM_TITLE_CANARY",
          link: "https://example.com/private",
          description: "PRIVATE_ITEM_BODY_CANARY",
          content: "PRIVATE_FULL_CONTENT_CANARY",
          pubDate: "2026-07-22T00:00:00.000Z",
          guid: "private-guid",
          feedTitle: "Example feed",
          feedUrl: "https://example.com/feed.xml",
          coverImage: "",
          savedFilePath: "/Users/private/Vault/PRIVATE_NOTE_PATH_CANARY.md",
        },
      ],
      lastUpdated: 123,
      lastFetchError:
        "https://user:PRIVATE_ERROR_PASSWORD_CANARY@example.com/failure",
      sourceKind: "feed",
      sourceConfig: { kind: "feed" },
      maxItemsLimit: 50,
      scanInterval: 60,
      excludeFromRefresh: false,
    },
  ];
  settings.ai = {
    connections: [
      {
        id: CONNECTION_ID,
        name: "OpenAI",
        providerKind: "openai",
        protocol: "openai-chat",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4.1-mini",
        timeoutMs: 30_000,
        maxInputCharacters: 20_000,
        enabled: true,
      },
    ],
    defaultConnectionId: CONNECTION_ID,
  };
  settings.tikhub = {
    enabled: true,
    youtubeTranscriptFallbackEnabled: true,
    connectionId: CONNECTION_ID,
    baseUrl: "https://api.tikhub.dev",
    timeoutMs: 20_000,
    maxRequestsPerRun: 5,
    maxRequestsPerDay: 25,
  };
  return settings;
}

describe("buildPublicSettingsExport", () => {
  it("rebuilds source definitions and provider metadata without private state", () => {
    const settings = settingsFixture() as unknown as Record<string, unknown>;
    settings.apiKey = "PRIVATE_API_KEY_CANARY";
    settings.Authorization = "Bearer PRIVATE_AUTH_CANARY";
    settings.requestHistory = ["PRIVATE_REQUEST_HISTORY_CANARY"];
    settings.aiResult = "PRIVATE_AI_RESULT_CANARY";
    settings.futureUnknown = {
      token: "PRIVATE_FUTURE_TOKEN_CANARY",
      prompt: "PRIVATE_PROMPT_CANARY",
    };
    (settings.ai as Record<string, unknown>).secretFilePath =
      "C:\\Users\\private\\PRIVATE_SECRET_PATH_CANARY.json";
    (settings.ai as { connections: Array<Record<string, unknown>> })
      .connections[0].apiKey = "PRIVATE_NESTED_KEY_CANARY";
    (settings.tikhub as Record<string, unknown>).ToKeN =
      "PRIVATE_MIXED_CASE_TOKEN_CANARY";

    const exported = buildPublicSettingsExport(settings, {
      includeSources: true,
    });
    const text = JSON.stringify(exported);

    expect(exported.feeds).toEqual([
      expect.objectContaining({
        title: "Example feed",
        url: "https://example.com/feed.xml",
        folder: "研究",
        sourceKind: "feed",
        sourceConfig: { kind: "feed" },
      }),
    ]);
    expect((exported.feeds as Array<Record<string, unknown>>)[0]).not.toHaveProperty(
      "items",
    );
    expect(exported.folders).toEqual([
      expect.objectContaining({ name: "研究", subfolders: [], pinned: true }),
    ]);
    expect(exported.ai).toEqual({
      connections: [
        expect.objectContaining({
          id: CONNECTION_ID,
          providerKind: "openai",
          model: "gpt-4.1-mini",
        }),
      ],
      defaultConnectionId: CONNECTION_ID,
    });
    expect(exported.tikhub).toEqual({
      enabled: true,
      youtubeTranscriptFallbackEnabled: true,
      connectionId: CONNECTION_ID,
      baseUrl: "https://api.tikhub.dev",
      timeoutMs: 20_000,
      maxRequestsPerRun: 5,
      maxRequestsPerDay: 25,
    });
    for (const canary of [
      "PRIVATE_API_KEY_CANARY",
      "PRIVATE_AUTH_CANARY",
      "PRIVATE_REQUEST_HISTORY_CANARY",
      "PRIVATE_AI_RESULT_CANARY",
      "PRIVATE_FUTURE_TOKEN_CANARY",
      "PRIVATE_PROMPT_CANARY",
      "PRIVATE_SECRET_PATH_CANARY",
      "PRIVATE_NESTED_KEY_CANARY",
      "PRIVATE_MIXED_CASE_TOKEN_CANARY",
      "PRIVATE_ITEM_TITLE_CANARY",
      "PRIVATE_ITEM_BODY_CANARY",
      "PRIVATE_FULL_CONTENT_CANARY",
      "PRIVATE_NOTE_PATH_CANARY",
      "PRIVATE_ERROR_PASSWORD_CANARY",
    ]) {
      expect(text).not.toContain(canary);
    }
  });

  it("exports import policy and subscription state but never provider cursors", () => {
    const settings = settingsFixture();
    settings.feeds[0].initialImportPolicy = {
      mode: "since-date",
      since: "2026-07-01",
    };
    settings.feeds[0].initialImportProgress = {
      status: "running",
      pagesFetched: 1,
      itemsImported: 2,
      nextCursor: "PRIVATE_PROVIDER_CURSOR",
      replyCursor: "PRIVATE_REPLY_CURSOR",
    };
    settings.feeds[0].subscriptionStatus = "paused";

    const exported = buildPublicSettingsExport(settings, { includeSources: true });
    const feed = (exported.feeds as Array<Record<string, unknown>>)[0];

    expect(feed.initialImportPolicy).toEqual({
      mode: "since-date",
      since: "2026-07-01",
    });
    expect(feed.subscriptionStatus).toBe("paused");
    expect(feed).not.toHaveProperty("initialImportProgress");
    expect(JSON.stringify(exported)).not.toContain("PRIVATE_PROVIDER_CURSOR");
    expect(JSON.stringify(exported)).not.toContain("PRIVATE_REPLY_CURSOR");
  });

  it("omits source collections for a preferences-only export", () => {
    const exported = buildPublicSettingsExport(settingsFixture(), {
      includeSources: false,
    });
    expect(exported).not.toHaveProperty("feeds");
    expect(exported).not.toHaveProperty("folders");
    expect(exported).not.toHaveProperty("availableTags");
    expect(exported.refreshInterval).toBe(60);
    expect(exported.tikhub).toMatchObject({
      youtubeTranscriptFallbackEnabled: true,
    });
  });

  it("does not invoke unknown getters, accessors, inherited fields, or toJSON", () => {
    const getter = vi.fn(() => "PRIVATE_GETTER_CANARY");
    const toJSON = vi.fn(() => ({ token: "PRIVATE_TOJSON_CANARY" }));
    const inherited = { token: "PRIVATE_INHERITED_CANARY", refreshInterval: 999 };
    const settings = Object.assign(Object.create(inherited), settingsFixture()) as Record<
      string,
      unknown
    >;
    Object.defineProperty(settings, "futureSecret", { enumerable: true, get: getter });
    Object.defineProperty(settings, "toJSON", { enumerable: true, value: toJSON });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    settings.futureCycle = cyclic;

    const text = JSON.stringify(
      buildPublicSettingsExport(settings, { includeSources: false }),
    );

    expect(getter).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
    expect(text).not.toContain("PRIVATE_");
    expect(text).not.toContain("999");
  });

  it("fails closed without invoking an accessor on an allowed field", () => {
    const getter = vi.fn(() => []);
    const settings = settingsFixture() as unknown as Record<string, unknown>;
    Object.defineProperty(settings, "feeds", { enumerable: true, get: getter });

    expect(() =>
      buildPublicSettingsExport(settings, { includeSources: true }),
    ).toThrow(PublicSettingsExportError);
    expect(getter).not.toHaveBeenCalled();
  });

  it.each(["sparse", "cyclic", "oversized"])(
    "fails closed for %s allowed structures",
    (variant) => {
      const settings = settingsFixture();
      if (variant === "sparse") {
        const sparse = new Array(2);
        sparse[1] = settings.feeds[0];
        settings.feeds = sparse;
      } else if (variant === "cyclic") {
        const folder = settings.folders[0];
        folder.subfolders = [folder];
      } else {
        settings.feeds = Array.from({ length: 5_001 }, () => settings.feeds[0]);
      }
      expect(() =>
        buildPublicSettingsExport(settings, { includeSources: true }),
      ).toThrow(PublicSettingsExportError);
    },
  );

  it("returns deep immutable fresh snapshots that cannot poison later exports", () => {
    const settings = settingsFixture();
    const first = buildPublicSettingsExport(settings, { includeSources: true });
    const firstFeed = (first.feeds as Array<Record<string, unknown>>)[0];
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.feeds)).toBe(true);
    expect(Object.isFrozen(firstFeed)).toBe(true);
    expect(() => {
      firstFeed.title = "POISONED";
    }).toThrow();
    settings.feeds[0].title = "Updated source";
    const second = buildPublicSettingsExport(settings, { includeSources: true });
    expect((second.feeds as Array<Record<string, unknown>>)[0].title).toBe(
      "Updated source",
    );
    expect(JSON.stringify(second)).not.toContain("POISONED");
  });

  it("imports safe metadata while forcing every external connection back to unconfigured", () => {
    const nextId = "22222222-2222-4222-8222-222222222222";
    const imported = preparePublicSettingsImport(settingsFixture(), {
      includeSources: true,
      createConnectionId: () => nextId,
    });
    expect(imported.tikhub).toEqual(
      expect.objectContaining({
        enabled: false,
        connectionId: "",
        youtubeTranscriptFallbackEnabled: true,
      }),
    );
    expect(imported.ai).toEqual({
      connections: [
        expect.objectContaining({
          id: nextId,
          enabled: false,
          name: "OpenAI",
          model: "gpt-4.1-mini",
        }),
      ],
      defaultConnectionId: nextId,
    });
  });

  it.each([
    "https://example.com/feed.xml?token=PRIVATE_QUERY_TOKEN_CANARY",
    "https://example.com/feed.xml?api_key=PRIVATE_QUERY_KEY_CANARY",
    "https://user:PRIVATE_URL_PASSWORD_CANARY@example.com/feed.xml",
  ])("fails closed for credential-bearing source URLs: %s", (url) => {
    const settings = settingsFixture();
    settings.feeds[0].url = url;
    expect(() =>
      buildPublicSettingsExport(settings, { includeSources: true }),
    ).toThrow(PublicSettingsExportError);
  });

  it.each([
    "x-api-key",
    "X_API_KEY",
    "x%2Dapi%2Dkey",
    "auth_token",
    "AUTH-TOKEN",
    "api-key",
    "access_token",
    "Access.Token",
    "X-Amz-Credential",
    "X-Amz-Signature",
    "X-Amz-Security-Token",
    "accesskey",
    "signature",
    "sig",
    "password",
    "session",
    "session_id",
    "token",
  ])("rejects separator, casing, and encoded credential query key %s", (key) => {
    const settings = settingsFixture();
    settings.feeds[0].url =
      `https://example.com/feed.xml?${key}=PRIVATE_CREDENTIAL_VALUE`;
    expect(() =>
      buildPublicSettingsExport(settings, { includeSources: true }),
    ).toThrow(PublicSettingsExportError);
  });

  it.each([
    "https://example.com/feed.xml?value=AIzaSyDUMMYDUMMYDUMMYDUMMYDUMMYDUMMY",
    "https://example.com/feed.xml?value=AKIAIOSFODNN7EXAMPLE",
    "https://example.com/feed.xml?value=sk-privatecredentialmaterial",
    "https://example.com/feed.xml#token=PRIVATE_FRAGMENT_TOKEN",
  ])("rejects credential-like query or fragment material without echoing it: %s", (url) => {
    const settings = settingsFixture();
    settings.feeds[0].url = url;
    let thrown: unknown;
    try {
      buildPublicSettingsExport(settings, { includeSources: true });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PublicSettingsExportError);
    expect(String(thrown)).not.toContain("PRIVATE_");
    expect(String(thrown)).not.toContain("AIza");
    expect(String(thrown)).not.toContain("AKIA");
    expect(String(thrown)).not.toContain("sk-private");
  });

  it("keeps ordinary topic, page, and utm parameters unchanged", () => {
    const settings = settingsFixture();
    settings.feeds[0].url =
      "https://example.com/feed.xml?topic=ai&page=2&utm_source=reader";
    const exported = buildPublicSettingsExport(settings, {
      includeSources: true,
    });
    expect((exported.feeds as Array<Record<string, unknown>>)[0].url).toBe(
      "https://example.com/feed.xml?topic=ai&page=2&utm_source=reader",
    );
  });

  it.each(["feed", "site", "tikhub", "ai"])(
    "fails the whole export when the %s URL contains credentials",
    (field) => {
      const settings = settingsFixture();
      const credentialUrl =
        "https://example.com/resource?x-api-key=PRIVATE_BASE_URL_KEY";
      if (field === "feed") settings.feeds[0].url = credentialUrl;
      if (field === "site") settings.feeds[0].siteUrl = credentialUrl;
      if (field === "tikhub") settings.tikhub.baseUrl = credentialUrl;
      if (field === "ai") settings.ai.connections[0].baseUrl = credentialUrl;
      expect(() =>
        buildPublicSettingsExport(settings, { includeSources: true }),
      ).toThrow(PublicSettingsExportError);
    },
  );

  it("rejects a serialized public export just over the shared character budget", () => {
    const settings = settingsFixture();
    const longTitle = "x".repeat(4_096);
    settings.feeds = Array.from({ length: 1_300 }, (_, index) => ({
      ...settings.feeds[0],
      title: `${longTitle.slice(0, -String(index).length)}${index}`,
      items: [],
    }));

    expect(() =>
      buildPublicSettingsExport(settings, { includeSources: true }),
    ).toThrow(PublicSettingsExportError);
  });

  it("rejects a serialized public export just over the shared UTF-8 byte budget", () => {
    const settings = settingsFixture();
    settings.feeds = Array.from({ length: 410 }, (_, index) => ({
      ...settings.feeds[0],
      title: `${"中".repeat(4_092)}${String(index).padStart(4, "0")}`,
      items: [],
    }));

    expect(() =>
      buildPublicSettingsExport(settings, { includeSources: true }),
    ).toThrow(PublicSettingsExportError);
  });

  it("shares one collection-entry budget across feeds, folders, tags, and connections", () => {
    const settings = settingsFixture();
    settings.feeds = Array.from({ length: 1_700 }, () => ({
      ...settings.feeds[0],
      items: [],
    }));
    settings.folders = Array.from({ length: 1_601 }, () => ({
      name: "Folder",
      subfolders: [],
      createdAt: 0,
      modifiedAt: 0,
    }));
    settings.availableTags = Array.from({ length: 1_700 }, () => ({
      name: "tag",
      color: "#fff",
    }));

    expect(() =>
      buildPublicSettingsExport(settings, { includeSources: true }),
    ).toThrow(PublicSettingsExportError);
  });

  it("counts repeated shared input nodes per output occurrence and invokes zero accessors", () => {
    const settings = settingsFixture();
    const sharedFeed = settings.feeds[0];
    const getter = vi.fn(() => "PRIVATE_SHARED_DAG_GETTER");
    Object.defineProperty(sharedFeed, "futureSecret", {
      enumerable: true,
      get: getter,
    });
    settings.feeds = Array.from({ length: 2_600 }, () => sharedFeed);
    settings.availableTags = Array.from({ length: 2_401 }, () => ({
      name: "tag",
      color: "#fff",
    }));

    expect(() =>
      buildPublicSettingsExport(settings, { includeSources: true }),
    ).toThrow(PublicSettingsExportError);
    expect(getter).not.toHaveBeenCalled();
  });

  it("emits a near-boundary snapshot that remains acceptable to its own JSON importer", () => {
    const settings = settingsFixture();
    settings.feeds = Array.from({ length: 1_100 }, (_, index) => ({
      ...settings.feeds[0],
      title: `${"x".repeat(3_990)}${String(index).padStart(4, "0")}`,
      items: [],
    }));
    const exported = buildPublicSettingsExport(settings, {
      includeSources: true,
    });
    const text = JSON.stringify(exported);

    expect(text.length).toBeLessThanOrEqual(
      MAX_PUBLIC_SETTINGS_JSON_CHARACTERS,
    );
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(
      MAX_PUBLIC_SETTINGS_JSON_CHARACTERS,
    );
    expect(() =>
      parsePublicSettingsImportJson(text, { includeSources: true }),
    ).not.toThrow();
  });

  it("preserves a blank MiniMax default marker without exporting an adjacent key", () => {
    const settings = settingsFixture();
    settings.ai = {
      connections: [{
        ...settings.ai.connections[0],
        name: "MiniMax 默认模型",
        providerKind: "minimax-global",
        baseUrl: "https://api.minimax.io/v1",
        model: "",
      }],
      defaultConnectionId: CONNECTION_ID,
    };
    (settings as unknown as Record<string, unknown>).apiKey =
      "PRIVATE_API_KEY_CANARY";

    const exported = buildPublicSettingsExport(settings, {
      includeSources: false,
    });
    const exportedAi = exported.ai as {
      connections: Array<Record<string, unknown>>;
    };

    expect(exportedAi.connections[0]).toMatchObject({
      providerKind: "minimax-global",
      model: "",
    });
    expect(JSON.stringify(exported)).not.toContain("PRIVATE_API_KEY_CANARY");
  });

  it("keeps an old non-empty model byte-for-byte pinned through load, export, and import normalization", async () => {
    const pinnedModel = "MiniMax-M2.1-account-enabled";
    const settings = settingsFixture();
    settings.ai = {
      connections: [{
        ...settings.ai.connections[0],
        name: "MiniMax 旧连接",
        providerKind: "minimax-cn",
        baseUrl: "https://api.minimaxi.com/v1",
        model: pinnedModel,
      }],
      defaultConnectionId: CONNECTION_ID,
    };
    const { loadAndNormalizeSettings } = await import(
      "../../../src/utils/settings-loader"
    );
    const loaded = loadAndNormalizeSettings(settings);

    const exported = buildPublicSettingsExport(loaded, {
      includeSources: false,
    });
    const imported = preparePublicSettingsImport(exported, {
      includeSources: false,
      createConnectionId: () =>
        "22222222-2222-4222-8222-222222222222",
    });

    expect(loaded.ai.connections[0].model).toBe(pinnedModel);
    expect((exported.ai as {
      connections: Array<Record<string, unknown>>;
    }).connections[0].model).toBe(pinnedModel);
    expect((imported.ai as {
      connections: Array<Record<string, unknown>>;
    }).connections[0].model).toBe(pinnedModel);
  });
});
