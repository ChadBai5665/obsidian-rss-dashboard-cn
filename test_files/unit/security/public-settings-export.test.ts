import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type RssDashboardSettings } from "../../../src/types/types";
import {
  buildPublicSettingsExport,
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

  it("omits source collections for a preferences-only export", () => {
    const exported = buildPublicSettingsExport(settingsFixture(), {
      includeSources: false,
    });
    expect(exported).not.toHaveProperty("feeds");
    expect(exported).not.toHaveProperty("folders");
    expect(exported).not.toHaveProperty("availableTags");
    expect(exported.refreshInterval).toBe(60);
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
      expect.objectContaining({ enabled: false, connectionId: "" }),
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
});
