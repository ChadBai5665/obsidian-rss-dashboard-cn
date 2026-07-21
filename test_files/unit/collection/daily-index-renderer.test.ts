import { describe, expect, it } from "vitest";
import { renderDailyIndex } from "../../../src/collection/daily-index-renderer";
import type { CollectedItem } from "../../../src/collection/collected-item";

function createItem(overrides: Partial<CollectedItem> = {}): CollectedItem {
  return {
    schemaVersion: 1,
    id: "item-1",
    sourceType: "rss",
    sourceId: "feed-1",
    sourceName: "Example feed",
    sourceBucket: "我的订阅",
    title: "Example item",
    fetchedAt: "2026-07-21T12:00:00.000Z",
    firstSeenAt: "2026-07-21T12:00:00.000Z",
    lastSeenAt: "2026-07-21T12:00:00.000Z",
    observationType: "new",
    topics: [],
    contentBasis: "feed",
    read: false,
    starred: false,
    saved: false,
    collectionStatus: "collected",
    ...overrides,
  };
}

describe("renderDailyIndex", () => {
  it("renders a neutral daily index grouped by bucket and deterministically ordered", () => {
    const markdown = renderDailyIndex({
      localDate: "2026-07-21",
      items: [
        createItem({
          id: "later-b",
          sourceBucket: "主题候选",
          title: "Beta",
          sourceName: "Topic source",
          publishedAt: "2026-07-21T11:00:00.000Z",
          url: "https://example.com/beta",
          observationType: "updated",
        }),
        createItem({
          id: "earlier",
          sourceBucket: "主题候选",
          title: "Earlier",
          publishedAt: "2026-07-21T08:00:00.000Z",
          url: "https://example.com/earlier",
          observationType: "rediscovered",
        }),
        createItem({
          id: "later-a",
          sourceBucket: "主题候选",
          title: "Alpha",
          publishedAt: "2026-07-21T11:00:00.000Z",
          url: "https://example.com/alpha",
        }),
        createItem({
          id: "subscription",
          sourceBucket: "我的订阅",
          title: "Subscription item",
          sourceName: "McKinsey",
          publishedAt: "2026-07-21T09:00:00.000Z",
          url: "https://example.com/subscription",
        }),
      ],
    });

    expect(markdown).toContain("---\ndate: 2026-07-21\ntype: rss-collection\ngeneratedBy: rss-dashboard-cn\n---");
    expect(markdown).toContain("<!-- RSS-DASHBOARD-CN:AUTO:START -->");
    expect(markdown).toContain("<!-- RSS-DASHBOARD-CN:AUTO:END -->");
    expect(markdown.indexOf("## 我的订阅")).toBeLessThan(
      markdown.indexOf("## 主题候选"),
    );
    expect(markdown.indexOf("Alpha")).toBeLessThan(markdown.indexOf("Beta"));
    expect(markdown.indexOf("Beta")).toBeLessThan(markdown.indexOf("Earlier"));
    expect(markdown).toContain("来源：McKinsey");
    expect(markdown).toContain("时间：2026-07-21T09:00:00.000Z");
    expect(markdown).toContain("类型：new");
    expect(markdown).toContain("[Subscription item](https://example.com/subscription)");
    expect(markdown).toContain("原始链接：https://example.com/subscription");
    expect(markdown).not.toMatch(/Top 10|score|recommendation|价值判断/i);
  });

  it("escapes external titles and preserves user-authored content outside the generated markers", () => {
    const existingMarkdown = "# 我的笔记\n\n保留这一段。\n<!-- RSS-DASHBOARD-CN:AUTO:START -->\n旧内容\n<!-- RSS-DASHBOARD-CN:AUTO:END -->\n\n尾注\n";

    const markdown = renderDailyIndex({
      localDate: "2026-07-21",
      existingMarkdown,
      items: [
        createItem({
          title: "[外部]\n标题",
          url: "https://example.com/article",
        }),
      ],
    });

    expect(markdown).toBe(
      "# 我的笔记\n\n保留这一段。\n<!-- RSS-DASHBOARD-CN:AUTO:START -->\n## 我的订阅\n- 来源：Example feed ｜ 时间：2026-07-21T12:00:00.000Z ｜ 类型：new\n  - [\\[外部\\] 标题](https://example.com/article)\n  - 原始链接：https://example.com/article\n<!-- RSS-DASHBOARD-CN:AUTO:END -->\n\n尾注\n",
    );
  });

  it("is byte-for-byte idempotent when rendered again with identical data", () => {
    const input = {
      localDate: "2026-07-21",
      items: [
        createItem({
          title: "A title",
          publishedAt: "2026-07-21T09:00:00.000Z",
          url: "https://example.com/a",
        }),
      ],
    };

    const first = renderDailyIndex(input);

    expect(renderDailyIndex({ ...input, existingMarkdown: first })).toBe(first);
  });
});
