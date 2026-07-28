import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "obsidian";
import { ArticleRenderer } from "../../../src/components/article-renderer";
import { AiOperationTaskCoordinator } from "../../../src/ai/ai-operation-task-coordinator";
import { normalizeFeedItem } from "../../../src/collection/feed-normalizer";
import {
  DEFAULT_SETTINGS,
  type Feed,
  type FeedItem,
} from "../../../src/types/types";
import { createAiConnection } from "../../../src/ai/provider-presets";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";

const CONNECTION_ID = "9a76f539-c9ec-4c45-a8e5-156cc6740a8d";

function item(guid: string): FeedItem {
  return {
    title: `Article ${guid}`,
    link: `https://${guid}.substack.com/p/article`,
    description: "Feed description",
    content: "<p>Publisher body</p>",
    pubDate: "2026-07-23T00:00:00.000Z",
    guid,
    read: false,
    starred: false,
    saved: false,
    tags: [],
    feedTitle: "Publisher",
    feedUrl: "https://publisher.example/feed.xml",
    coverImage: "",
  };
}

function feed(article: FeedItem): Feed {
  return {
    feedId: "feed-id",
    sourceKind: "feed",
    sourceConfig: { kind: "feed" },
    title: "Publisher",
    url: article.feedUrl,
    folder: "Research",
    items: [article],
    lastUpdated: Date.now(),
  };
}

function setup() {
  const app = App.createMock();
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.useWebViewer = false;
  settings.ai.connections = [createAiConnection({
    id: CONNECTION_ID,
    name: "Kimi",
    providerKind: "kimi",
    model: "model",
  })];
  settings.ai.defaultConnectionId = CONNECTION_ID;
  const first = item("first");
  const second = item("second");
  const firstCollected = normalizeFeedItem(feed(first), first, new Date());
  const secondCollected = normalizeFeedItem(feed(second), second, new Date());
  const run = vi.fn(async () => await new Promise<never>(() => undefined));
  const latest = vi.fn(async () => null);
  const save = vi.fn(async () => {
    throw new Error("unreachable");
  });
  const coordinator = new AiOperationTaskCoordinator({
    service: { run },
    repository: { latest, save },
  });
  const abort = vi.spyOn(coordinator, "abort");
  const createAiPanelOptions = vi.fn((candidate: FeedItem) => {
    const collected = candidate.guid === first.guid
      ? firstCollected
      : secondCollected;
    return {
      itemId: collected.id,
      connections: settings.ai.connections,
      defaultConnectionId: CONNECTION_ID,
      coordinator,
      createStartInput: (operation: "summary" | "translate-zh-cn" | "core-points" | "deep-analysis", connectionId: string) => ({
        operation,
        item: collected,
        connectionId,
        fetchFullText: false,
      }),
      listHistory: vi.fn(async () => []),
      openArtifact: vi.fn(),
      openSettings: vi.fn(),
      canInsertArtifact: vi.fn(() => false),
      insertArtifact: vi.fn(),
    };
  });
  const renderer = new ArticleRenderer({
    app,
    settings,
    onArticleSave: vi.fn(),
    onArticleUpdate: vi.fn(async () => true),
    createAiPanelOptions,
  });
  return {
    renderer,
    first,
    second,
    firstCollected,
    createAiPanelOptions,
    run,
    latest,
    abort,
  };
}

beforeEach(() => {
  installObsidianDomPolyfills();
  document.body.empty();
  vi.restoreAllMocks();
});

describe("ArticleRenderer inline AI lifecycle", () => {
  it("stays manual-only, mounts before publisher DOM, and reattaches the same item without another provider run", async () => {
    const test = setup();
    const container = document.body.createDiv();

    const firstRender = test.renderer.render(container, test.first);
    const initialMount = container.querySelector<HTMLElement>(".rss-reader-ai-mount");
    expect(initialMount).toBe(container.firstElementChild);
    expect(initialMount?.childElementCount).toBe(0);
    expect(test.createAiPanelOptions).not.toHaveBeenCalled();
    expect(test.latest).not.toHaveBeenCalled();
    expect(test.run).not.toHaveBeenCalled();
    await firstRender;

    await test.renderer.showAiOperation("summary");
    await vi.waitFor(() => expect(test.run).toHaveBeenCalledTimes(1));
    expect(container.querySelector(".rss-reader-ai-mount"))
      .toBe(container.firstElementChild);
    expect(container.querySelector(".rss-reader-article-header")).toBeTruthy();

    await test.renderer.render(container, test.first);
    await vi.waitFor(() => expect(test.createAiPanelOptions).toHaveBeenCalledTimes(2));
    expect(test.run).toHaveBeenCalledTimes(1);

    await test.renderer.render(container, test.second);
    expect(test.createAiPanelOptions).toHaveBeenCalledTimes(2);
    expect(container.querySelector<HTMLElement>(".rss-reader-ai-mount")?.childElementCount)
      .toBe(0);

    test.renderer.dispose();
    expect(test.abort).not.toHaveBeenCalled();
  });

  it("shows static guidance only after an untrusted item explicitly requests AI", async () => {
    const test = setup();
    const container = document.body.createDiv();
    const renderer = new ArticleRenderer({
      app: App.createMock(),
      settings: structuredClone(DEFAULT_SETTINGS),
      onArticleSave: vi.fn(),
      onArticleUpdate: vi.fn(async () => true),
      createAiPanelOptions: vi.fn(() => null),
    });

    await renderer.render(container, test.first);
    expect(container.textContent).not.toContain("当前信息无法安全识别");
    await renderer.showAiOperation("summary");

    expect(container.textContent).toContain("当前信息无法安全识别");
    expect(test.run).not.toHaveBeenCalled();
  });
});
