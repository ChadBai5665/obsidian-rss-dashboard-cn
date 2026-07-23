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
import { AiOperationError, AiOperationService } from "../../../src/ai/ai-operation-service";
import { AiContentSelector } from "../../../src/ai/content/ai-content-selector";
import { AnalysisRepository } from "../../../src/ai/analysis-repository";
import { AnalysisNoteInserter } from "../../../src/ai/analysis-note-inserter";
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

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === label,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`Missing button: ${label}`);
  }
  return match;
}

function enableConnection(test: ReturnType<typeof harness>): void {
  test.settings.ai.connections = [createAiConnection({
    id: CONNECTION_ID,
    name: "Kimi work",
    providerKind: "kimi",
    model: "account-model",
  })];
  test.settings.ai.defaultConnectionId = CONNECTION_ID;
}

function installAtomicAdapter(test: ReturnType<typeof harness>): void {
  const adapter = test.app.vault.adapter;
  adapter.copy = async (from: string, to: string) => {
    if (await adapter.exists(to)) throw new Error(`Destination exists: ${to}`);
    await adapter.write(to, await adapter.read(from));
  };
  adapter.process = async (
    path: string,
    update: (current: string) => string,
  ) => {
    const current = await adapter.read(path);
    const next = update(current);
    await adapter.write(path, next);
    return next;
  };
}

function mockPreparedSuccess(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(AiOperationService.prototype, "runPrepared")
    .mockImplementation(async (input) => ({
      operation: input.operation,
      itemId: input.itemId,
      connectionId: CONNECTION_ID,
      connectionName: "Kimi work",
      providerKind: "kimi",
      model: "account-model",
      contentBasis: input.selectedContent.basis,
      inputCharacterCount: input.selectedContent.content.length,
      inputTruncated: input.selectedContent.truncated,
      text: "Production wiring analysis",
    }));
}

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
    enableConnection(test);
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
    expect(test.selected.rssDashboardId).toBeUndefined();
    expect(exists.mock.calls.flat().join("\n")).toContain(selectedId);
    expect(exists.mock.calls.flat().join("\n")).not.toContain(unrelatedId);
    expect(read).not.toHaveBeenCalled();
    modal?.close();
  });

  it("submits the production preview snapshot without selecting a cache file that appears later", async () => {
    const test = harness();
    enableConnection(test);
    const select = vi.spyOn(AiContentSelector.prototype, "select");
    const legacyRun = vi.spyOn(AiOperationService.prototype, "run")
      .mockRejectedValue(new Error("legacy selection path must not run"));
    const runPrepared = vi.spyOn(AiOperationService.prototype, "runPrepared")
      .mockImplementation(async (input) => await new Promise((_, reject) => {
        input.signal?.addEventListener("abort", () => {
          reject(new AiOperationError("aborted"));
        }, { once: true });
      }));
    const modal = test.plugin.openAiOperationForItem(test.selected, "summary");
    await vi.waitFor(() => expect(select).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(
      button(modal!.contentEl, "确认发送").disabled,
    ).toBe(false));
    const itemId = createCollectedItemId({
      sourceId: "feed-id",
      guid: test.selected.guid,
      url: test.selected.link,
      title: test.selected.title,
      publishedAt: test.selected.pubDate,
    });
    const cachePath = `${test.settings.collection.dataFolder}/content/${itemId}.md`;
    await test.app.vault.adapter.write(cachePath, [
      "---",
      "schemaVersion: 1",
      `itemId: ${JSON.stringify(itemId)}`,
      `sourceUrl: ${JSON.stringify(test.selected.link)}`,
      `fetchedAt: ${JSON.stringify("2026-07-23T02:00:00.000Z")}`,
      `contentBasis: ${JSON.stringify("full-text")}`,
      "---",
      "",
      "Later cached full text that was never previewed",
    ].join("\n"));

    button(modal!.contentEl, "确认发送").click();
    await vi.waitFor(() => expect(runPrepared).toHaveBeenCalledTimes(1));

    expect(legacyRun).not.toHaveBeenCalled();
    expect(select).toHaveBeenCalledTimes(1);
    expect(runPrepared).toHaveBeenCalledWith(expect.objectContaining({
      itemId,
      selectedContent: expect.objectContaining({
        content: "Selected item feed excerpt",
        basis: "feed",
      }),
    }));
    modal?.close();
  });

  it.each(["valid", "deleted", "replaced"] as const)(
    "binds note insertion to the current saved artifact in production wiring: %s",
    async (scenario) => {
      const test = harness();
      enableConnection(test);
      installAtomicAdapter(test);
      await test.app.vault.createFolder("Notes");
      const sourceNote = await test.app.vault.create(
        "Notes/source.md",
        "User-authored source bytes",
      );
      test.selected.saved = true;
      test.selected.savedFilePath = sourceNote.path;
      mockPreparedSuccess();
      const save = vi.spyOn(AnalysisRepository.prototype, "save");
      const insert = vi.spyOn(AnalysisNoteInserter.prototype, "insert");
      const modal = test.plugin.openAiOperationForItem(test.selected, "summary");
      await vi.waitFor(() => expect(modal?.contentEl.textContent).toContain(
        "Selected item",
      ));

      button(modal!.contentEl, "确认发送").click();
      await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
      const artifactPath = await save.mock.results[0].value;
      await vi.waitFor(() => expect(modal?.contentEl.textContent).toContain(
        artifactPath,
      ));
      if (scenario === "deleted") {
        await test.app.vault.adapter.remove(artifactPath);
      } else if (scenario === "replaced") {
        await test.app.vault.adapter.write(
          artifactPath,
          "---\nresultId: \"forged\"\nsourceItemId: \"other\"\n---\n",
        );
      }

      button(modal!.contentEl, "插入已保存原文").click();

      if (scenario === "valid") {
        await vi.waitFor(() => expect(insert).toHaveBeenCalledTimes(1));
        expect(await test.app.vault.read(sourceNote)).toContain(
          "RSS-DASHBOARD-CN:AI:",
        );
      } else {
        await vi.waitFor(() => expect(modal?.contentEl.textContent).toContain(
          "分析文档已缺失或发生变化",
        ));
        expect(insert).not.toHaveBeenCalled();
        expect(await test.app.vault.read(sourceNote)).toBe(
          "User-authored source bytes",
        );
      }
      modal?.close();
    },
  );
});
