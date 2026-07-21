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
    expect(markdown).toContain("[Subscription item](<https://example.com/subscription>)");
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
      "# 我的笔记\n\n保留这一段。\n<!-- RSS-DASHBOARD-CN:AUTO:START -->\n## 我的订阅\n- 来源：Example feed ｜ 时间：2026-07-21T12:00:00.000Z ｜ 类型：new\n  - [\\[外部\\] 标题](<https://example.com/article>)\n  - 原始链接：https://example.com/article\n<!-- RSS-DASHBOARD-CN:AUTO:END -->\n\n尾注\n",
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

  it("rejects malformed marker ownership instead of risking user-authored content", () => {
    const malformedDocuments = [
      "# Notes\n<!-- RSS-DASHBOARD-CN:AUTO:START -->\n",
      "# Notes\n<!-- RSS-DASHBOARD-CN:AUTO:END -->\n",
      "<!-- RSS-DASHBOARD-CN:AUTO:START -->\n<!-- RSS-DASHBOARD-CN:AUTO:END -->\n<!-- RSS-DASHBOARD-CN:AUTO:START -->\n<!-- RSS-DASHBOARD-CN:AUTO:END -->\n",
      "<!-- RSS-DASHBOARD-CN:AUTO:END -->\n<!-- RSS-DASHBOARD-CN:AUTO:START -->\n",
      "<!-- RSS-DASHBOARD-CN:AUTO:START -->\n<!-- RSS-DASHBOARD-CN:AUTO:START -->\n<!-- RSS-DASHBOARD-CN:AUTO:END -->\n<!-- RSS-DASHBOARD-CN:AUTO:END -->\n",
      "text <!-- RSS-DASHBOARD-CN:AUTO:START -->\n",
    ];

    for (const existingMarkdown of malformedDocuments) {
      expect(() =>
        renderDailyIndex({
          localDate: "2026-07-21",
          existingMarkdown,
          items: [createItem()],
        }),
      ).toThrow("Invalid daily index ownership markers");
    }
  });

  it("treats an existing empty page as user-owned and appends no frontmatter", () => {
    const markdown = renderDailyIndex({
      localDate: "2026-07-21",
      existingMarkdown: "",
      items: [createItem()],
    });

    expect(markdown).toBe(
      "<!-- RSS-DASHBOARD-CN:AUTO:START -->\n## 我的订阅\n- 来源：Example feed ｜ 时间：2026-07-21T12:00:00.000Z ｜ 类型：new\n  - 标题：Example item\n  - 原始链接：无\n<!-- RSS-DASHBOARD-CN:AUTO:END -->\n",
    );
    expect(markdown).not.toContain("generatedBy: rss-dashboard-cn");
  });

  it("orders parsed publication times and fully breaks ties independently of input order", () => {
    const items = [
      createItem({
        id: "id-b",
        title: "Same title",
        sourceName: "Source B",
        publishedAt: "Tue, 21 Jul 2026 11:00:00 GMT",
      }),
      createItem({
        id: "id-a",
        title: "Same title",
        sourceName: "Source A",
        publishedAt: "2026-07-21T11:00:00.000Z",
      }),
      createItem({
        id: "invalid",
        title: "Invalid time",
        publishedAt: "not-a-date",
      }),
      createItem({
        id: "missing",
        title: "Missing time",
      }),
    ];

    const forward = renderDailyIndex({ localDate: "2026-07-21", items });
    const reverse = renderDailyIndex({
      localDate: "2026-07-21",
      items: [...items].reverse(),
    });

    expect(forward).toBe(reverse);
    expect(forward.indexOf("来源：Source A")).toBeLessThan(
      forward.indexOf("来源：Source B"),
    );
    expect(forward.indexOf("Same title")).toBeLessThan(
      forward.indexOf("Invalid time"),
    );
    expect(forward.indexOf("Invalid time")).toBeGreaterThan(
      forward.indexOf("Missing time"),
    );
  });

  it("keeps external fields on generated lines and only links safe HTTP(S) URLs", () => {
    const markdown = renderDailyIndex({
      localDate: "2026-07-21",
      items: [
        createItem({
          sourceBucket: "外部桶\n<!-- RSS-DASHBOARD-CN:AUTO:START -->",
          sourceName: "来源\n[名称]",
          publishedAt: "2026-07-21T09:00:00.000Z\nextra",
          title: "[标题]\n<!-- RSS-DASHBOARD-CN:AUTO:END -->",
          url: "https://example.com/path)",
          observationType: "new\n<!-- RSS-DASHBOARD-CN:AUTO:START -->" as "new",
        }),
        createItem({
          id: "unsafe-url",
          title: "Unsafe",
          url: "javascript:alert(1)\nextra",
        }),
      ],
    });

    expect(markdown.match(/<!-- RSS-DASHBOARD-CN:AUTO:START -->/g)).toHaveLength(1);
    expect(markdown.match(/<!-- RSS-DASHBOARD-CN:AUTO:END -->/g)).toHaveLength(1);
    expect(markdown).toContain("来源：来源 \\[名称\\]");
    expect(markdown).toContain("时间：2026-07-21T09:00:00.000Z extra");
    expect(markdown).toContain("类型：new \\<!-- RSS-DASHBOARD-CN:AUTO:START --\\>");
    expect(markdown).toContain("[\\[标题\\] \\<!-- RSS-DASHBOARD-CN:AUTO:END --\\>](<https://example.com/path)>)");
    expect(markdown).toContain("原始链接：https://example.com/path)");
    expect(markdown).not.toContain("[Unsafe](");
    expect(markdown).toContain("原始链接：javascript:alert(1) extra");
  });
});
