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
import { AiOperationService } from "../../../src/ai/ai-operation-service";
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
import type { AiAnalysisResult } from "../../../src/ai/analysis-result";

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
  settings.ai.connections = [createAiConnection({
    id: CONNECTION_ID,
    name: "Kimi work",
    providerKind: "kimi",
    model: "account-model",
  })];
  settings.ai.defaultConnectionId = CONNECTION_ID;
  plugin.settings = settings;
  return { app, plugin, settings, selected, unrelated };
}

function installAtomicAdapter(app: App): void {
  const adapter = app.vault.adapter;
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

function mockGeneration(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(AiOperationService.prototype, "run")
    .mockImplementation(async (input) => ({
      operation: input.operation,
      itemId: input.item.id,
      connectionId: CONNECTION_ID,
      connectionName: "Kimi work",
      providerKind: "kimi",
      model: "account-model",
      contentBasis: "feed",
      inputCharacterCount: 32,
      inputTruncated: false,
      text: "Production inline analysis",
    }));
}

function analysisResult(itemId: string, index: number): AiAnalysisResult {
  return {
    schemaVersion: 1,
    id: `123e4567-e89b-42d3-a456-${index.toString(16).padStart(12, "0")}`,
    itemId,
    sourceUrl: "https://example.com/item",
    operation: "summary",
    createdAt: `2026-07-23T03:${String(index % 60).padStart(2, "0")}:00.000Z`,
    connectionId: CONNECTION_ID,
    connectionName: "Kimi work",
    providerKind: "kimi",
    model: "account-model",
    contentBasis: "feed",
    inputCharacterCount: 10,
    inputTruncated: false,
    text: `Generated result ${index}`,
  };
}

beforeEach(() => {
  installObsidianDomPolyfills();
  secretState.constructed = 0;
  secretState.reads = 0;
  vi.restoreAllMocks();
});

describe("production inline AI composition", () => {
  it("reuses one runtime per data root and reads no secret before a provider run", () => {
    const test = harness();

    const first = test.plugin.createAiPanelOptionsForItem(test.selected);
    const second = test.plugin.createAiPanelOptionsForItem(test.selected);

    expect(first).not.toBeNull();
    expect(second?.coordinator).toBe(first?.coordinator);
    expect(first?.createStartInput("summary", CONNECTION_ID)).toMatchObject({
      operation: "summary",
      connectionId: CONNECTION_ID,
      fetchFullText: false,
      item: { id: expect.stringMatching(/^[a-f0-9]{64}$/u) },
    });
    expect(secretState.constructed).toBe(1);
    expect(secretState.reads).toBe(0);
  });

  it("replaces and shuts down the runtime only after a real data-root change", () => {
    const test = harness();
    const first = test.plugin.createAiPanelOptionsForItem(test.selected)!;
    const shutdown = vi.spyOn(
      first.coordinator as { shutdown(): Promise<void> },
      "shutdown",
    );

    test.settings.ai.defaultConnectionId = CONNECTION_ID;
    expect(test.plugin.createAiPanelOptionsForItem(test.selected)?.coordinator)
      .toBe(first.coordinator);
    test.settings.collection.dataFolder = ".rss-dashboard-data-next";
    const next = test.plugin.createAiPanelOptionsForItem(test.selected)!;

    expect(next.coordinator).not.toBe(first.coordinator);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("keeps the old runtime alive when the candidate data root is invalid", () => {
    const test = harness();
    const first = test.plugin.createAiPanelOptionsForItem(test.selected)!;
    const shutdown = vi.spyOn(
      first.coordinator as { shutdown(): Promise<void> },
      "shutdown",
    );
    test.settings.collection.dataFolder = "../invalid-root";

    expect(test.plugin.createAiPanelOptionsForItem(test.selected)).toBeNull();
    expect(shutdown).not.toHaveBeenCalled();
    test.settings.collection.dataFolder = DEFAULT_SETTINGS.collection.dataFolder;
    expect(test.plugin.createAiPanelOptionsForItem(test.selected)?.coordinator)
      .toBe(first.coordinator);
  });

  it("rejects an untrusted detached item before constructing the runtime", () => {
    const test = harness();
    const detached = structuredClone(test.selected);
    detached.feedUrl = "https://unowned.example/feed.xml";

    expect(test.plugin.createAiPanelOptionsForItem(detached)).toBeNull();
    expect(secretState.constructed).toBe(0);
    expect(secretState.reads).toBe(0);
  });

  it("inserts only a newly generated exact result after source-save and repository verification", async () => {
    const test = harness();
    installAtomicAdapter(test.app);
    mockGeneration();
    await test.app.vault.createFolder("Notes");
    const note = await test.app.vault.create("Notes/source.md", "Source bytes");
    const saveSource = vi.spyOn(
      test.plugin as unknown as { saveArticleForAiInsertion(): Promise<string> },
      "saveArticleForAiInsertion",
    ).mockResolvedValue(note.path);
    const verify = vi.spyOn(AnalysisRepository.prototype, "withVerifiedArtifact");
    const insert = vi.spyOn(AnalysisNoteInserter.prototype, "insert");
    const open = vi.spyOn(
      test.plugin as unknown as { openAiVaultFile(): Promise<void> },
      "openAiVaultFile",
    ).mockResolvedValue(undefined);
    const options = test.plugin.createAiPanelOptionsForItem(test.selected)!;

    const terminal = await options.coordinator.start(
      options.createStartInput("summary", CONNECTION_ID),
    );
    expect(terminal.status).toBe("complete");
    expect(options.canInsertArtifact(terminal.artifactPath!)).toBe(true);
    const unrelatedOptions = test.plugin.createAiPanelOptionsForItem(
      test.unrelated,
    )!;
    expect(unrelatedOptions.canInsertArtifact(terminal.artifactPath!)).toBe(false);
    await expect(
      unrelatedOptions.insertArtifact(terminal.artifactPath!),
    ).rejects.toThrow();

    await options.insertArtifact(terminal.artifactPath!);

    expect(saveSource).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledWith(
      terminal.artifactPath,
      expect.objectContaining({ itemId: terminal.itemId }),
      expect.any(Function),
    );
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      notePath: note.path,
      result: expect.objectContaining({ itemId: terminal.itemId }),
    }));
    expect(saveSource.mock.invocationCallOrder[0]).toBeLessThan(
      insert.mock.invocationCallOrder[0],
    );
    expect(open).toHaveBeenLastCalledWith(
      note.path,
      expect.stringMatching(/^RSS-DASHBOARD-CN:AI:/u),
    );
  });

  it("does not grant insertion authority to repository history", async () => {
    const test = harness();
    installAtomicAdapter(test.app);
    const options = test.plugin.createAiPanelOptionsForItem(test.selected)!;
    const itemId = createCollectedItemId({
      sourceId: "feed-id",
      guid: test.selected.guid,
      url: test.selected.link,
      title: test.selected.title,
      publishedAt: test.selected.pubDate,
    });
    const historyPath = await new AnalysisRepository(
      test.app.vault,
      test.settings.collection.dataFolder,
      { randomSuffix: () => "historysuffix0001" },
    ).save({
      schemaVersion: 1,
      id: "123e4567-e89b-42d3-a456-426614174000",
      itemId,
      sourceUrl: test.selected.link,
      operation: "summary",
      createdAt: "2026-07-23T03:00:00.000Z",
      connectionId: CONNECTION_ID,
      connectionName: "Kimi work",
      providerKind: "kimi",
      model: "account-model",
      contentBasis: "feed",
      inputCharacterCount: 10,
      inputTruncated: false,
      text: "Historical result",
    });

    expect(options.canInsertArtifact(historyPath)).toBe(false);
    await expect(options.insertArtifact(historyPath)).rejects.toThrow();
  });

  it("bounds current insertion authority to the newest 256 exact paths", async () => {
    const test = harness();
    const options = test.plugin.createAiPanelOptionsForItem(test.selected)!;
    const runtime = (test.plugin as unknown as {
      aiRuntime: {
        generatedResults: Map<string, Readonly<AiAnalysisResult>>;
        coordinator: { saveAnalysis(result: AiAnalysisResult): Promise<string> };
      };
    }).aiRuntime;
    vi.spyOn(AnalysisRepository.prototype, "save")
      .mockImplementation(async (value) => {
        const result = value as AiAnalysisResult;
        return `.rss-dashboard-data/analysis/${result.itemId}/${result.id}.md`;
      });

    const paths: string[] = [];
    for (let index = 0; index < 257; index += 1) {
      paths.push(await runtime.coordinator.saveAnalysis(
        analysisResult(options.itemId, index),
      ));
    }

    expect(runtime.generatedResults.size).toBe(256);
    expect(options.canInsertArtifact(paths[0])).toBe(false);
    expect(options.canInsertArtifact(paths[1])).toBe(true);
    expect(options.canInsertArtifact(paths[256])).toBe(true);
  });

  it("does not remember a result when the real repository save fails", async () => {
    const test = harness();
    const options = test.plugin.createAiPanelOptionsForItem(test.selected)!;
    const runtime = (test.plugin as unknown as {
      aiRuntime: {
        generatedResults: Map<string, Readonly<AiAnalysisResult>>;
        coordinator: { saveAnalysis(result: AiAnalysisResult): Promise<string> };
      };
    }).aiRuntime;
    vi.spyOn(AnalysisRepository.prototype, "save")
      .mockRejectedValue(new Error("atomic save failed"));

    await expect(runtime.coordinator.saveAnalysis(
      analysisResult(options.itemId, 1),
    )).rejects.toThrow("atomic save failed");
    expect(runtime.generatedResults.size).toBe(0);
  });

  it("shuts the active coordinator down on plugin unload", () => {
    const test = harness();
    const options = test.plugin.createAiPanelOptionsForItem(test.selected)!;
    const shutdown = vi.spyOn(
      options.coordinator as { shutdown(): Promise<void> },
      "shutdown",
    ).mockResolvedValue(undefined);

    test.plugin.onunload();

    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});
