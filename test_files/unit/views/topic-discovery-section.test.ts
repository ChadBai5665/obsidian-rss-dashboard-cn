import { beforeEach, describe, expect, it } from "vitest";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";
import type { CollectedItem } from "../../../src/collection/collected-item";
import {
  createTopicDiscoveryModel,
  renderTopicDiscoverySection,
} from "../../../src/views/topic-discovery-section";

function post(overrides: Partial<CollectedItem>): CollectedItem {
  return {
    schemaVersion: 1,
    id: "x-post:200",
    sourceType: "x-topic",
    sourceId: "ai-apps",
    sourceName: "AI applications",
    sourceBucket: "Topics",
    title: "A useful observation",
    author: "OpenAI",
    fetchedAt: "2026-07-22T08:00:00.000Z",
    firstSeenAt: "2026-07-22T08:00:00.000Z",
    lastSeenAt: "2026-07-22T08:00:00.000Z",
    url: "https://x.com/openai/status/200",
    guid: "200",
    observationType: "new",
    topics: ["AI applications", "x:latest"],
    contentBasis: "x-post",
    metrics: { likes: 12, views: 100 },
    sourceMetadata: {
      kind: "x-post",
      externalUrls: ["https://example.com/article"],
      observationTags: ["latest"],
    },
    read: false,
    starred: false,
    saved: false,
    collectionStatus: "collected",
    ...overrides,
  };
}

describe("topic discovery section", () => {
  beforeEach(() => {
    installObsidianDomPolyfills();
    document.body.empty();
  });

  it("separates provider categories and renders objective metrics, timestamps, and factual linked-page groups", () => {
    const latest = post({ id: "x-post:200" });
    const top = post({
      id: "x-post:201",
      guid: "201",
      metrics: { replies: 0 },
      sourceMetadata: {
        kind: "x-post",
        externalUrls: ["https://example.com/article"],
        observationTags: ["platform-top", "priority-account"],
      },
      topics: ["AI applications", "x:platform-top", "x:priority-account"],
    });
    const model = createTopicDiscoveryModel([latest, top], "en");

    expect(model.sections.map((section) => section.id)).toEqual([
      "latest",
      "platform-top",
      "priority-account",
    ]);
    expect(model.sections[0].items[0].metrics).toMatchObject({
      likes: "12",
      reposts: "Unavailable",
    });
    expect(model.linkedPages).toEqual([
      expect.objectContaining({
        url: "https://example.com/article",
        postCount: 2,
        sources: ["AI applications"],
      }),
    ]);
    expect(JSON.stringify(model)).not.toMatch(/quality|recommend|score/i);

    const root = document.body.createDiv();
    renderTopicDiscoverySection(root, [latest, top], "zh-CN");
    expect(root.textContent).toContain("最新");
    expect(root.textContent).toContain("平台 Top");
    expect(root.textContent).toContain("重点账号命中");
    expect(root.textContent).toContain("未提供");
    expect(root.textContent).toContain("2026-07-22");
    expect(root.querySelector("[data-quality-score]")).toBeNull();
  });

  it("rejects sparse and accessor-backed collection boundaries without invoking getters", () => {
    let getterCalls = 0;
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, "sourceType", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "x-topic";
      },
    });
    const sparse = new Array<CollectedItem>(1);

    expect(createTopicDiscoveryModel(sparse, "en").sections.every((section) => section.items.length === 0)).toBe(true);
    expect(createTopicDiscoveryModel([accessor as unknown as CollectedItem], "en").sections.every((section) => section.items.length === 0)).toBe(true);
    expect(getterCalls).toBe(0);
  });
});
