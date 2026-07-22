import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "obsidian";

const secretState = vi.hoisted(() => ({ constructed: 0, reads: 0 }));

vi.mock("../../../src/security/desktop-secret-store", () => ({
  DesktopSecretStore: class DesktopSecretStoreMock {
    constructor() { secretState.constructed += 1; }
    async get(): Promise<string | undefined> {
      secretState.reads += 1;
      return undefined;
    }
  },
}));

import RssDashboardPlugin from "../../../main";
import { createAiConnection } from "../../../src/ai/provider-presets";
import { createCollectedItemId } from "../../../src/collection/item-identity";
import {
  DEFAULT_SETTINGS,
  type Feed,
  type FeedItem,
  type RssDashboardSettings,
} from "../../../src/types/types";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";

const CONNECTION_ID = "9a76f539-c9ec-4c45-a8e5-156cc6740a8d";

function feedItem(guid: string, title: string): FeedItem {
  return {
    title,
    link: `https://example.com/${guid}`,
    description: `${title} feed excerpt`,
    pubDate: "2026-07-23T00:00:00.000Z",
    guid,
    read: false,
    starred: false,
    saved: false,
    tags: [],
    feedTitle: "Selected source",
    feedUrl: "https://example.com/feed.xml",
    coverImage: "",
  };
}

function harness() {
  const app = App.createMock();
  const plugin = new RssDashboardPlugin(app, {
    id: "rss-dashboard",
    name: "RSS Dashboard",
    version: "2.5.0",
  });
  const settings: RssDashboardSettings = structuredClone(DEFAULT_SETTINGS);
  const selected = feedItem("selected-guid", "Selected item");
  const unrelated = feedItem("unrelated-guid", "Unrelated item");
  const feed: Feed = {
    feedId: "feed-id",
    sourceKind: "feed",
    sourceConfig: { kind: "feed" },
    title: "Selected source",
    url: selected.feedUrl,
    folder: "Research",
    items: [selected, unrelated],
    lastUpdated: Date.now(),
  };
  settings.feeds = [feed];
  plugin.settings = settings;
  const openSettingsToTab = vi
    .spyOn(plugin, "openSettingsToTab")
    .mockResolvedValue(undefined);
  return { app, plugin, settings, selected, unrelated, openSettingsToTab };
}

beforeEach(() => {
  installObsidianDomPolyfills();
  document.body.empty();
  secretState.constructed = 0;
  secretState.reads = 0;
  vi.restoreAllMocks();
});

describe("production AI operation wiring", () => {
  it("opens AI settings before constructing secrets or touching vault content when no connection is enabled", () => {
    const test = harness();
    const exists = vi.spyOn(test.app.vault.adapter, "exists");
    const read = vi.spyOn(test.app.vault.adapter, "read");

    const modal = test.plugin.openAiOperationForItem(
      test.selected,
      "summary",
    );

    expect(modal).toBeNull();
    expect(test.openSettingsToTab).toHaveBeenCalledWith("ai");
    expect(secretState.constructed).toBe(0);
    expect(secretState.reads).toBe(0);
    expect(exists).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it("previews only the selected FeedItem and does not read a key or unrelated item before confirmation", async () => {
    const test = harness();
    test.settings.ai.connections = [createAiConnection({
      id: CONNECTION_ID,
      name: "Kimi work",
      providerKind: "kimi",
      model: "account-model",
    })];
    test.settings.ai.defaultConnectionId = CONNECTION_ID;
    const exists = vi.spyOn(test.app.vault.adapter, "exists");
    const read = vi.spyOn(test.app.vault.adapter, "read");
    const selectedId = createCollectedItemId({
      sourceId: "feed-id",
      guid: test.selected.guid,
      url: test.selected.link,
      title: test.selected.title,
      publishedAt: test.selected.pubDate,
    });
    const unrelatedId = createCollectedItemId({
      sourceId: "feed-id",
      guid: test.unrelated.guid,
      url: test.unrelated.link,
      title: test.unrelated.title,
      publishedAt: test.unrelated.pubDate,
    });

    const modal = test.plugin.openAiOperationForItem(
      test.selected,
      "summary",
    );
    expect(modal).not.toBeNull();
    await vi.waitFor(() => {
      expect(modal?.contentEl.textContent).toContain("Selected item");
    });

    expect(secretState.constructed).toBe(1);
    expect(secretState.reads).toBe(0);
    expect(test.openSettingsToTab).not.toHaveBeenCalled();
    expect(test.selected.rssDashboardId).toBe(selectedId);
    expect(exists.mock.calls.flat().join("\n")).toContain(selectedId);
    expect(exists.mock.calls.flat().join("\n")).not.toContain(unrelatedId);
    expect(read).not.toHaveBeenCalled();
    modal?.close();
  });
});
