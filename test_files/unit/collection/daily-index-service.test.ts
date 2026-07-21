import type { Vault } from "obsidian";
import { describe, expect, it } from "vitest";
import { DailyIndexService } from "../../../src/collection/daily-index-service";
import type { CollectedItem } from "../../../src/collection/collected-item";

class InMemoryAdapter {
  readonly files = new Map<string, string>();
  readonly directories = new Set<string>();

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.directories.has(path);
  }

  async read(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`Missing file: ${path}`);
    return content;
  }

  async write(path: string, content: string): Promise<void> {
    const separator = path.lastIndexOf("/");
    const parent = separator === -1 ? "" : path.slice(0, separator);
    if (parent && !this.directories.has(parent)) {
      throw new Error(`Missing parent directory: ${parent}`);
    }
    this.files.set(path, content);
  }

  async mkdir(path: string): Promise<void> {
    const separator = path.lastIndexOf("/");
    const parent = separator === -1 ? "" : path.slice(0, separator);
    if (parent && !this.directories.has(parent)) {
      throw new Error(`Missing parent directory: ${parent}`);
    }
    this.directories.add(path);
  }
}

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

function createHarness(): { adapter: InMemoryAdapter; service: DailyIndexService } {
  const adapter = new InMemoryAdapter();
  const vault = { adapter } as unknown as Vault;
  return {
    adapter,
    service: new DailyIndexService(vault, "信息收集/每日采集"),
  };
}

describe("DailyIndexService", () => {
  it("creates parent folders and writes the configured daily filename", async () => {
    const { adapter, service } = createHarness();

    const path = await service.writeDailyIndex({
      localDate: "2026-07-21",
      items: [createItem({ url: "https://example.com/article" })],
    });

    expect(path).toBe("信息收集/每日采集/2026-07-21.md");
    expect(adapter.directories).toEqual(
      new Set(["信息收集", "信息收集/每日采集"]),
    );
    expect(adapter.files.get(path)).toContain("Example item");
  });

  it("appends a generated block without overwriting a file that has no markers", async () => {
    const { adapter, service } = createHarness();
    adapter.directories.add("信息收集");
    adapter.directories.add("信息收集/每日采集");
    adapter.files.set("信息收集/每日采集/2026-07-21.md", "# 用户标题\n\n用户正文\n");

    await service.writeDailyIndex({
      localDate: "2026-07-21",
      items: [createItem({ url: "https://example.com/article" })],
    });

    expect(adapter.files.get("信息收集/每日采集/2026-07-21.md")).toBe(
      "# 用户标题\n\n用户正文\n\n<!-- RSS-DASHBOARD-CN:AUTO:START -->\n## 我的订阅\n- 来源：Example feed ｜ 时间：2026-07-21T12:00:00.000Z ｜ 类型：new\n  - [Example item](https://example.com/article)\n  - 原始链接：https://example.com/article\n<!-- RSS-DASHBOARD-CN:AUTO:END -->\n",
    );
  });
});
