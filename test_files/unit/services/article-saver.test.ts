import { beforeEach, describe, expect, it, vi } from "vitest";
import { App, TFile, moment } from "obsidian";
import { isMap, parseDocument } from "yaml";
import type {
  ArticleSavingSettings,
  CollectionSettings,
  Feed,
  FeedItem,
} from "../../../src/types/types";
import {
  ArticleSaver,
  sanitizeFilename,
} from "../../../src/services/article-saver";
import * as fetchHelpers from "../../../src/utils/fetch-helpers";
import { RESTRICTED_ARTICLE_REASON } from "../../../src/utils/full-article-fetch";
import { CollectionRepository } from "../../../src/collection/collection-repository";
import { normalizeFeedItem } from "../../../src/collection/feed-normalizer";

function createSettings(
  overrides: Partial<ArticleSavingSettings> = {},
): ArticleSavingSettings {
  return {
    addSavedTag: false,
    defaultFolder: "",
    defaultTemplate: "",
    includeFrontmatter: false,
    frontmatterTemplate: "",
    saveFullContent: false,
    fetchTimeout: 30_000,
    savedTemplates: [],
    ...overrides,
  };
}

function createItem(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    title: "Test Article",
    link: "https://example.com/article",
    description: "<p>Desc</p>",
    pubDate: "2024-01-01T00:00:00.000Z",
    guid: "guid-1",
    read: false,
    starred: false,
    tags: [],
    feedTitle: "Test Feed",
    feedUrl: "https://example.com/rss.xml",
    rssDashboardSourceId: "https://example.com/rss.xml",
    coverImage: "",
    ...overrides,
  };
}

const collectionSettings: CollectionSettings = {
  enabled: true,
  dataFolder: ".rss-dashboard-data",
  dailyIndexFolder: "Information/Daily",
  savedNoteFolder: "Information/Saved",
};

const FIRST_ITEM_ID = "a".repeat(64);
const SECOND_ITEM_ID = "b".repeat(64);
const THIRD_ITEM_ID = "c".repeat(64);
const FOURTH_ITEM_ID = "d".repeat(64);

function ownedNote(itemId: string, body = "existing body"): string {
  return `---\nrssDashboardId: ${JSON.stringify(itemId)}\n---\n\n${body}`;
}

function legacySavedNote(
  item: FeedItem,
  body = "LEGACY BODY",
  overrides: Record<string, string> = {},
): string {
  const fields: Record<string, string> = {
    title: item.title,
    source: item.feedTitle,
    link: item.link,
    author: item.author || "",
    feedTitle: item.feedTitle,
    guid: item.guid,
    customUserField: "preserve me",
    ...overrides,
  };
  return `---\n${Object.entries(fields)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join("\n")}\n---\n\n${body}`;
}

function parseSavedFrontmatter(raw: string): {
  document: ReturnType<typeof parseDocument>;
  value: Record<string, unknown>;
} {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error("expected frontmatter");
  const document = parseDocument(match[1], { uniqueKeys: true });
  expect(document.errors).toEqual([]);
  expect(isMap(document.contents)).toBe(true);
  return {
    document,
    value: document.toJS() as Record<string, unknown>,
  };
}

function ownedKeyCount(
  document: ReturnType<typeof parseDocument>,
  key: string,
): number {
  if (!isMap(document.contents)) return 0;
  return document.contents.items.filter((pair) => pair.key?.toString() === key)
    .length;
}

beforeEach(() => {
  vi.spyOn(console, "debug").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("sanitizeFilename", () => {
  it("preserves the full sanitized title without truncating words or length", () => {
    const title =
      'This is a deliberately long article title with / illegal : characters " removed" and extra words';

    expect(sanitizeFilename(title)).toBe(
      "This is a deliberately long article title with illegal characters removed and extra words",
    );
  });

  it("falls back to a safe filename when sanitization removes everything", () => {
    expect(sanitizeFilename(' / \\\\ : * ? " < > | ')).toBe("Untitled Article");
    expect(sanitizeFilename("   ")).toBe("Untitled Article");
  });
});

describe("ArticleSaver.saveArticle", () => {
  it("prefers item.content over description when raw content is not provided", async () => {
    const app = App.createMock();
    const settings = createSettings({
      defaultTemplate: "{{content}}",
      includeFrontmatter: false,
    });
    const saver = new ArticleSaver(app, settings);

    const item = createItem({
      title: "Prefer Content",
      description:
        '<body xmlns="http://www.w3.org/1999/xhtml">Short summary.</body>',
      content:
        "<p>Organizations are accumulating a type of debt that no one has been hired to pay down.</p><p>Second paragraph with more context.</p>",
    });

    const file = await saver.saveArticle(item);

    expect(file).toBeInstanceOf(TFile);
    if (!(file instanceof TFile)) throw new Error("expected TFile");
    const written = await app.vault.read(file);

    expect(written).toContain(
      "Organizations are accumulating a type of debt that no one has been hired to pay down.",
    );
    expect(written).toContain("Second paragraph with more context.");
    expect(written).not.toContain(
      '<body xmlns="http://www.w3.org/1999/xhtml">',
    );
  });

  it("writes to a normalized folder path and applies template/frontmatter substitutions", async () => {
    const app = App.createMock();
    const settings = createSettings({
      addSavedTag: true,
      includeFrontmatter: true,
      defaultFolder: "/My Articles/",
      defaultTemplate:
        "# {{title}}\niso={{isoDateTime}}\ntags={{tags}}\n\n{{content}}\n\n[Source]({{link}})",
    });
    const saver = new ArticleSaver(app, settings);

    const item = createItem({
      title: "Hello / World: An Article",
      tags: [{ name: "tech", color: "#000" }],
    });

    const createFolderSpy = vi.spyOn(app.vault, "createFolder");
    const createSpy = vi.spyOn(app.vault, "create");

    const file = await saver.saveArticle(item, undefined, undefined, "BODY");

    expect(file).toBeInstanceOf(TFile);
    expect(createFolderSpy).toHaveBeenCalledWith("My Articles");

    const expectedPath = "My Articles/Hello World An Article.md";
    expect(createSpy).toHaveBeenCalled();
    expect(createSpy.mock.calls[0][0]).toBe(expectedPath);

    const written = createSpy.mock.calls[0][1];
    const { value } = parseSavedFrontmatter(written);
    expect(value.title).toBe("Hello / World: An Article");
    expect(value.source).toBe("Test Feed");
    expect(value.link).toBe("https://example.com/article");
    expect(value.guid).toBe("guid-1");
    expect(value.tags).toEqual(["tech", "Saved"]);
    expect(written).toContain("iso=2024-01-01T00:00:00.000Z");
    expect(written).toContain("tags=tech, Saved");
    expect(written).toContain("BODY");

    expect(item.saved).toBe(true);
    expect(item.savedFilePath).toBe(expectedPath);
    expect(item.tags.map((t) => t.name)).toEqual(["tech", "Saved"]);
  });

  it("returns and opens the stable-ID note without rewriting it on a repeated save", async () => {
    const app = App.createMock();
    const settings = createSettings({
      defaultFolder: "Articles",
      defaultTemplate: "{{content}}",
    });
    const saver = new ArticleSaver(
      app,
      settings,
      undefined,
      collectionSettings,
    );

    const item = createItem({
      title: "Repeat Title",
      rssDashboardId: FIRST_ITEM_ID,
    });
    await saver.saveArticle(item, undefined, undefined, "FIRST");

    const trashSpy = vi.spyOn(app.fileManager, "trashFile");
    const createSpy = vi.spyOn(app.vault, "create");
    const openFile = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(app.workspace, "getLeaf").mockReturnValue({ openFile });
    const result = await saver.saveArticle(
      item,
      undefined,
      undefined,
      "SECOND",
    );

    expect(result?.path).toBe("Information/Saved/Repeat Title.md");
    expect(await app.vault.read(result!)).toContain("FIRST");
    expect(await app.vault.read(result!)).not.toContain("SECOND");
    expect(createSpy).not.toHaveBeenCalled();
    expect(trashSpy).not.toHaveBeenCalled();
    expect(openFile).toHaveBeenCalledWith(result);
  });

  it("does not scan the entire Vault when the legacy save folder is the root", async () => {
    const app = App.createMock();
    const saver = new ArticleSaver(
      app,
      createSettings({ defaultFolder: "", defaultTemplate: "{{content}}" }),
    );
    const unrelated = await app.vault.create(
      "Unrelated Legacy Name.md",
      ownedNote(FIRST_ITEM_ID, "UNRELATED ROOT NOTE"),
    );
    const readSpy = vi.spyOn(app.vault, "read");
    const filesSpy = vi.spyOn(app.vault, "getFiles");

    const saved = await saver.saveArticle(
      createItem({ title: "Current Title", rssDashboardId: FIRST_ITEM_ID }),
      undefined,
      undefined,
      "CURRENT BODY",
    );

    expect(saved?.path).toBe("Current Title.md");
    expect(readSpy).not.toHaveBeenCalledWith(unrelated);
    expect(filesSpy).not.toHaveBeenCalled();
  });

  it("uses a validated custom folder as the effective scope with collection enabled", async () => {
    const app = App.createMock();
    const saver = new ArticleSaver(
      app,
      createSettings({ defaultTemplate: "{{content}}" }),
      undefined,
      collectionSettings,
    );

    const saved = await saver.saveArticle(
      createItem({ rssDashboardId: FIRST_ITEM_ID }),
      "Custom/Cafe\u0301",
      undefined,
      "BODY",
    );

    expect(saved?.path).toBe("Custom/Café/Test Article.md");
  });

  it("reopens a custom-folder note by exact savedFilePath after reload without scanning the configured folder", async () => {
    const app = App.createMock();
    const firstSaver = new ArticleSaver(
      app,
      createSettings({ defaultTemplate: "{{content}}" }),
      undefined,
      collectionSettings,
    );
    const original = createItem({ rssDashboardId: FIRST_ITEM_ID });
    const first = await firstSaver.saveArticle(
      original,
      "Custom Saved",
      undefined,
      "FIRST",
    );
    const reloaded = createItem({
      rssDashboardId: FIRST_ITEM_ID,
      saved: true,
      savedFilePath: first?.path,
    });
    const secondSaver = new ArticleSaver(
      app,
      createSettings({ defaultTemplate: "{{content}}" }),
      undefined,
      collectionSettings,
    );
    const createSpy = vi.spyOn(app.vault, "create");

    const reopened = await secondSaver.saveArticle(
      reloaded,
      undefined,
      undefined,
      "SECOND",
    );

    expect(reopened).toBe(first);
    expect(createSpy).not.toHaveBeenCalled();
    expect(await app.vault.read(first!)).not.toContain("SECOND");
  });

  it("supports a root custom scope and exact-path reopen without a Vault-wide ID scan", async () => {
    const app = App.createMock();
    const saver = new ArticleSaver(
      app,
      createSettings({ defaultTemplate: "{{content}}" }),
      undefined,
      collectionSettings,
    );
    const item = createItem({ rssDashboardId: FIRST_ITEM_ID });
    const first = await saver.saveArticle(item, "", undefined, "FIRST");
    const filesSpy = vi.spyOn(app.vault, "getFiles");

    const reopened = await new ArticleSaver(
      app,
      createSettings({ defaultTemplate: "{{content}}" }),
      undefined,
      collectionSettings,
    ).findSavedArticleFile(
      createItem({
        rssDashboardId: FIRST_ITEM_ID,
        saved: true,
        savedFilePath: first?.path,
      }),
    );

    expect(first?.path).toBe("Test Article.md");
    expect(reopened).toBe(first);
    expect(filesSpy).not.toHaveBeenCalled();
  });

  it.each([
    "   ",
    "/Custom",
    "Custom/",
    "Custom//Saved",
    "Custom/../Saved",
    "Custom\\Saved",
    "C:/Custom",
    "Custom/Bad\u0000Name",
  ])("rejects unsafe custom scope %j", async (customFolder) => {
    const app = App.createMock();
    const createSpy = vi.spyOn(app.vault, "create");
    const saver = new ArticleSaver(
      app,
      createSettings({ defaultTemplate: "{{content}}" }),
      undefined,
      collectionSettings,
    );

    expect(
      await saver.saveArticle(
        createItem({ rssDashboardId: FIRST_ITEM_ID }),
        customFolder,
        undefined,
        "BODY",
      ),
    ).toBeNull();
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("uses the owning feed source identity so offline GUID saves match later collection normalization", async () => {
    const app = App.createMock();
    const feed: Feed = {
      feedId: "durable-feed-id",
      title: "Offline Feed",
      url: "https://example.com/feed.xml",
      folder: "RSS",
      items: [],
      lastUpdated: 0,
    };
    const offlineItem = createItem({
      link: "not-a-valid-url",
      guid: "offline-guid",
      feedUrl: feed.url,
      rssDashboardId: undefined,
    }) as FeedItem & { rssDashboardSourceId?: string };
    offlineItem.rssDashboardSourceId = feed.feedId;
    const normalizedClone = createItem({
      link: offlineItem.link,
      guid: offlineItem.guid,
      feedUrl: feed.url,
      rssDashboardId: undefined,
    });
    const expected = normalizeFeedItem(
      feed,
      normalizedClone,
      new Date("2026-07-22T00:00:00.000Z"),
    ).id;
    const saver = new ArticleSaver(
      app,
      createSettings({ defaultTemplate: "{{content}}" }),
      undefined,
      collectionSettings,
    );

    const file = await saver.saveArticle(
      offlineItem,
      undefined,
      undefined,
      "OFFLINE",
    );

    expect(offlineItem.rssDashboardId).toBe(expected);
    expect(parseSavedFrontmatter(await app.vault.read(file!)).value.rssDashboardId).toBe(
      expected,
    );
  });

  it("returns null and does not mark the item saved when writing fails", async () => {
    const app = App.createMock();
    const settings = createSettings({
      defaultTemplate: "{{content}}",
    });
    const saver = new ArticleSaver(
      app,
      settings,
      undefined,
      collectionSettings,
    );
    const flagsSpy = vi.spyOn(CollectionRepository.prototype, "updateFlags");

    vi.spyOn(app.vault, "create").mockRejectedValueOnce(new Error("disk full"));

    const item = createItem({ title: "Will Fail" });
    const result = await saver.saveArticle(item, undefined, undefined, "BODY");

    expect(result).toBeNull();
    expect(item.saved).not.toBe(true);
    expect(item.savedFilePath).toBeUndefined();
    expect(flagsSpy).not.toHaveBeenCalled();
  });

  it("clears a legacy migration-pending marker after a new owned save succeeds", async () => {
    const app = App.createMock();
    const saver = new ArticleSaver(
      app,
      createSettings({ defaultTemplate: "{{content}}" }),
      undefined,
      collectionSettings,
    );
    const item = createItem({
      rssDashboardId: FIRST_ITEM_ID,
      savedNoteMigrationPending: true,
    });

    const saved = await saver.saveArticle(
      item,
      undefined,
      undefined,
      "NEW OWNED BODY",
    );

    expect(saved).toBeInstanceOf(TFile);
    expect(item.savedNoteMigrationPending).toBeUndefined();
  });

  it("uses deterministic ID suffixes without overwriting unrelated same-title notes", async () => {
    const app = App.createMock();
    const settings = createSettings({
      defaultFolder: "Articles",
      defaultTemplate: "{{content}}",
    });
    const saver = new ArticleSaver(
      app,
      settings,
      undefined,
      collectionSettings,
    );
    await app.vault.create(
      "Information/Saved/Shared Title.md",
      "unrelated user-authored note",
    );
    const trashSpy = vi.spyOn(app.fileManager, "trashFile");

    const first = await saver.saveArticle(
      createItem({ title: "Shared Title", rssDashboardId: FIRST_ITEM_ID }),
      undefined,
      undefined,
      "FIRST",
    );
    const second = await saver.saveArticle(
      createItem({ title: "Shared Title", rssDashboardId: SECOND_ITEM_ID }),
      undefined,
      undefined,
      "SECOND",
    );

    expect(first?.path).toBe(
      `Information/Saved/Shared Title-${FIRST_ITEM_ID.slice(0, 8)}.md`,
    );
    expect(second?.path).toBe(
      `Information/Saved/Shared Title-${SECOND_ITEM_ID.slice(0, 8)}.md`,
    );
    expect(
      await app.vault.read("Information/Saved/Shared Title.md"),
    ).toBe("unrelated user-authored note");
    expect(trashSpy).not.toHaveBeenCalled();
  });

  it("uses the twelve-character suffix then fails clearly when all candidates conflict", async () => {
    const app = App.createMock();
    const settings = createSettings({ defaultTemplate: "{{content}}" });
    const saver = new ArticleSaver(
      app,
      settings,
      undefined,
      collectionSettings,
    );
    const targetId = "123456789abc" + "d".repeat(52);
    for (const path of [
      "Information/Saved/Collision.md",
      "Information/Saved/Collision-12345678.md",
      "Information/Saved/Collision-123456789abc.md",
    ]) {
      await app.vault.create(path, ownedNote(SECOND_ITEM_ID, path));
    }

    const result = await saver.saveArticle(
      createItem({ title: "Collision", rssDashboardId: targetId }),
      undefined,
      undefined,
      "new body",
    );

    expect(result).toBeNull();
    for (const path of [
      "Information/Saved/Collision.md",
      "Information/Saved/Collision-12345678.md",
      "Information/Saved/Collision-123456789abc.md",
    ]) {
      expect(await app.vault.read(path)).toContain(path);
    }
  });

  it("serializes owned frontmatter fields without allowing source URL injection", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-21T12:34:56.000Z"));
    const app = App.createMock();
    const saver = new ArticleSaver(
      app,
      createSettings({ defaultTemplate: "{{content}}" }),
      undefined,
      collectionSettings,
    );
    const item = createItem({
      rssDashboardId: FIRST_ITEM_ID,
      feedTitle: 'Source "quoted"\ninjected: true',
      link: "https://example.com/article\nmalicious: true",
      pubDate: "2026-07-20T08:00:00.000Z",
    });

    const file = await saver.saveArticle(item, undefined, undefined, "BODY");
    const written = await app.vault.read(file!);

    const { document, value } = parseSavedFrontmatter(written);
    expect(value.rssDashboardId).toBe(FIRST_ITEM_ID);
    expect(value.source).toBe('Source "quoted"\ninjected: true');
    expect(value.sourceUrl).toBe(
      "https://example.com/article\nmalicious: true",
    );
    expect(value.publishedAt).toBe("2026-07-20T08:00:00.000Z");
    expect(value.savedAt).toBe("2026-07-21T12:34:56.000Z");
    for (const key of [
      "rssDashboardId",
      "source",
      "sourceUrl",
      "publishedAt",
      "savedAt",
      "contentBasis",
    ]) {
      expect(typeof value[key]).toBe("string");
      expect(ownedKeyCount(document, key)).toBe(1);
    }
    expect(written).not.toMatch(/^malicious: true$/m);
    expect(written).not.toMatch(/^injected: true$/m);
    vi.useRealTimers();
  });

  it("escapes external values inside a custom frontmatter template", async () => {
    const app = App.createMock();
    const saver = new ArticleSaver(
      app,
      createSettings({
        defaultTemplate:
          "---\ntitle: {{title}}\nlink: '{{link}}'\nauthor: \"{{author}}\"\n---\n\n{{content}}",
        includeFrontmatter: false,
      }),
      undefined,
      collectionSettings,
    );
    const file = await saver.saveArticle(
      createItem({
        rssDashboardId: FIRST_ITEM_ID,
        title: "Malicious: true",
        link: "https://example.com/path\r\n---\r\ninjectedLink: true",
        author: 'Author "quoted"\ninjectedAuthor: true',
      }),
      undefined,
      undefined,
      "BODY",
    );
    const written = await app.vault.read(file!);

    const { document, value } = parseSavedFrontmatter(written);
    expect(value.title).toBe("Malicious: true");
    expect(value.link).toBe(
      "https://example.com/path\r\n---\r\ninjectedLink: true",
    );
    expect(value.author).toBe('Author "quoted"\ninjectedAuthor: true');
    expect(written).not.toMatch(/^injected(?:Title|Link|Author): true$/m);
    for (const key of [
      "rssDashboardId",
      "source",
      "sourceUrl",
      "publishedAt",
      "savedAt",
      "contentBasis",
    ]) {
      expect(typeof value[key]).toBe("string");
      expect(ownedKeyCount(document, key)).toBe(1);
    }
  });

  it("parses flow and block frontmatter before substituting string values", async () => {
    const app = App.createMock();
    const saver = new ArticleSaver(
      app,
      createSettings({
        defaultTemplate:
          "---\nmeta: { title: {{title}}, link: \"{{link}}\" }\nsummary: |\n  {{summary}}\n\"source\": template-owned-value\n---\n\n{{content}}",
      }),
      undefined,
      collectionSettings,
    );
    const item = createItem({
      rssDashboardId: FIRST_ITEM_ID,
      title: "Flow: remains one scalar",
      link: "https://example.com/a\r\n---\r\nextra: true",
      summary: "Line one\nLine two: still text",
      feedTitle: "Canonical source",
    });

    const file = await saver.saveArticle(item, undefined, undefined, "BODY");
    const { document, value } = parseSavedFrontmatter(
      await app.vault.read(file!),
    );

    expect(value.meta).toEqual({
      title: "Flow: remains one scalar",
      link: "https://example.com/a\r\n---\r\nextra: true",
    });
    expect(value.summary).toBe("Line one\nLine two: still text\n");
    expect(value.source).toBe("Canonical source");
    expect(ownedKeyCount(document, "source")).toBe(1);
  });

  it("expands a complete tags value or flow element into normalized scalar sequences", async () => {
    const templates = [
      "---\ntags: {{tags}}\n---\nBODY",
      "---\ntags: [{{tags}}]\n---\nBODY",
    ];
    for (const [index, template] of templates.entries()) {
      const app = App.createMock();
      const saver = new ArticleSaver(
        app,
        createSettings({ defaultTemplate: template, addSavedTag: true }),
        undefined,
        collectionSettings,
      );
      const file = await saver.saveArticle(
        createItem({
          title: `Tag sequence ${index}`,
          rssDashboardId: `${index + 1}`.repeat(64),
          tags: [
            { name: " tech ", color: "#000" },
            { name: "TECH", color: "#111" },
            { name: "", color: "#222" },
            { name: "safe\ninjected: true", color: "#333" },
          ],
        }),
      );

      const { value } = parseSavedFrontmatter(await app.vault.read(file!));
      expect(value.tags).toEqual([
        "tech",
        "safe\ninjected: true",
        "Saved",
      ]);
      expect(await app.vault.read(file!)).not.toMatch(/^injected: true$/m);
    }
  });

  it("keeps an embedded or block-scalar tags placeholder as one safe string", async () => {
    const app = App.createMock();
    const saver = new ArticleSaver(
      app,
      createSettings({
        defaultTemplate:
          "---\nlabel: 'Topics: {{tags}}'\ntagBlock: |-\n  {{tags}}\ntagList:\n  - |-\n    {{tags}}\n---\nBODY",
      }),
      undefined,
      collectionSettings,
    );
    const file = await saver.saveArticle(
      createItem({
        rssDashboardId: FIRST_ITEM_ID,
        tags: [
          { name: " alpha ", color: "#000" },
          { name: "beta: value", color: "#111" },
        ],
      }),
    );

    const { value } = parseSavedFrontmatter(await app.vault.read(file!));
    expect(value.label).toBe("Topics: alpha, beta: value");
    expect(value.tagBlock).toBe("alpha, beta: value");
    expect(value.tagList).toEqual(["alpha, beta: value"]);
  });

  it("renders an empty complete tags placeholder as an empty sequence", async () => {
    const app = App.createMock();
    const saver = new ArticleSaver(
      app,
      createSettings({ defaultTemplate: "---\ntags: [{{tags}}]\n---\nBODY" }),
      undefined,
      collectionSettings,
    );

    const file = await saver.saveArticle(
      createItem({ rssDashboardId: FIRST_ITEM_ID, tags: [] }),
    );

    expect(parseSavedFrontmatter(await app.vault.read(file!)).value.tags).toEqual(
      [],
    );
  });

  it("accepts a UTF-8 BOM frontmatter boundary once and rejects leading whitespace ambiguity", async () => {
    const bomApp = App.createMock();
    const bomSaver = new ArticleSaver(
      bomApp,
      createSettings({
        defaultTemplate: "\uFEFF---\ntitle: {{title}}\n---\nBODY",
      }),
      undefined,
      collectionSettings,
    );
    const bomFile = await bomSaver.saveArticle(
      createItem({ rssDashboardId: FIRST_ITEM_ID }),
    );
    const bomWritten = await bomApp.vault.read(bomFile!);
    expect(bomWritten.match(/^---$/gm)).toHaveLength(2);
    expect(bomWritten).not.toContain("{{title}}");

    const whitespaceApp = App.createMock();
    const createSpy = vi.spyOn(whitespaceApp.vault, "create");
    const whitespaceSaver = new ArticleSaver(
      whitespaceApp,
      createSettings({
        defaultTemplate: " \n---\ntitle: {{title}}\n---\nBODY",
      }),
      undefined,
      collectionSettings,
    );
    expect(
      await whitespaceSaver.saveArticle(
        createItem({ rssDashboardId: FIRST_ITEM_ID }),
      ),
    ).toBeNull();
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("rejects malformed, non-mapping, duplicate-key, and alias frontmatter templates", async () => {
    const templates = [
      "---\n- not\n- a mapping\n---\nBODY",
      "---\ntitle: [unterminated\n---\nBODY",
      "---\nsource: first\n\"source\": second\n---\nBODY",
      `---\nanchor: &id ${FIRST_ITEM_ID}\nrssDashboardId: *id\n---\nBODY`,
    ];

    for (const [index, template] of templates.entries()) {
      const app = App.createMock();
      const saver = new ArticleSaver(
        app,
        createSettings({ defaultTemplate: template }),
        undefined,
        collectionSettings,
      );
      const createSpy = vi.spyOn(app.vault, "create");

      const file = await saver.saveArticle(
        createItem({
          title: `Invalid template ${index}`,
          rssDashboardId: FIRST_ITEM_ID,
        }),
      );

      expect(file).toBeNull();
      expect(createSpy).not.toHaveBeenCalled();
    }
  });

  it("rejects traversal in the configured save folder and never scans outside it", async () => {
    const app = App.createMock();
    await app.vault.create("Outside/Do Not Read.md", ownedNote(FIRST_ITEM_ID));
    const readSpy = vi.spyOn(app.vault, "read");
    const saver = new ArticleSaver(
      app,
      createSettings({ defaultTemplate: "{{content}}" }),
      undefined,
      { ...collectionSettings, savedNoteFolder: "../Outside" },
    );

    const result = await saver.saveArticle(
      createItem({ rssDashboardId: FIRST_ITEM_ID }),
      undefined,
      undefined,
      "BODY",
    );

    expect(result).toBeNull();
    expect(readSpy).not.toHaveBeenCalled();
    expect(await app.vault.read("Outside/Do Not Read.md")).toContain(
      "existing body",
    );
  });

  it("rejects a configured folder that sanitizes to the vault root", async () => {
    const app = App.createMock();
    const createSpy = vi.spyOn(app.vault, "create");
    const saver = new ArticleSaver(
      app,
      createSettings({ defaultTemplate: "{{content}}" }),
      undefined,
      { ...collectionSettings, savedNoteFolder: ":::" },
    );

    const result = await saver.saveArticle(
      createItem({ rssDashboardId: FIRST_ITEM_ID }),
      undefined,
      undefined,
      "BODY",
    );

    expect(result).toBeNull();
    expect(createSpy).not.toHaveBeenCalled();
  });

  it.each([
    "",
    "   ",
    "/",
    "/Information/Saved",
    "Information/Saved/",
    "Information//Saved",
    "Information/./Saved",
    "Information/../Saved",
    "Information/   /Saved",
    "Information\\Saved",
    "C:/Information/Saved",
    "Information/Bad\u0000Name",
    "Information/Bad\u001fName",
    "Information/Bad\u007fName",
  ])("rejects unsafe collection saved folder %j", async (savedNoteFolder) => {
    const app = App.createMock();
    const saver = new ArticleSaver(
      app,
      createSettings({ defaultFolder: "Legacy Root" }),
      undefined,
      { ...collectionSettings, savedNoteFolder },
    );
    const createSpy = vi.spyOn(app.vault, "create");

    const result = await saver.saveArticle(
      createItem({ rssDashboardId: FIRST_ITEM_ID }),
      undefined,
      undefined,
      "BODY",
    );

    expect(result).toBeNull();
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("normalizes equivalent Unicode titles and folders before locking and collision selection", async () => {
    const app = App.createMock();
    const decomposed = new ArticleSaver(
      app,
      createSettings({ defaultTemplate: "{{content}}" }),
      undefined,
      { ...collectionSettings, savedNoteFolder: "Information/Cafe\u0301" },
    );
    const composed = new ArticleSaver(
      app,
      createSettings({ defaultTemplate: "{{content}}" }),
      undefined,
      { ...collectionSettings, savedNoteFolder: "Information/Café" },
    );

    const [first, second] = await Promise.all([
      decomposed.saveArticle(
        createItem({ title: "Cafe\u0301", rssDashboardId: FIRST_ITEM_ID }),
        undefined,
        undefined,
        "FIRST",
      ),
      composed.saveArticle(
        createItem({ title: "Café", rssDashboardId: SECOND_ITEM_ID }),
        undefined,
        undefined,
        "SECOND",
      ),
    ]);

    expect(first?.path).toBe("Information/Café/Café.md");
    expect(second?.path).toBe(
      `Information/Café/Café-${SECOND_ITEM_ID.slice(0, 8)}.md`,
    );
  });

  it("treats a pre-existing canonically equivalent Unicode path as occupied", async () => {
    const app = App.createMock();
    await app.vault.createFolder("Information/Cafe\u0301");
    await app.vault.create(
      "Information/Cafe\u0301/Cafe\u0301.md",
      ownedNote(SECOND_ITEM_ID, "DECOMPOSED OWNER"),
    );
    const saver = new ArticleSaver(
      app,
      createSettings({ defaultTemplate: "{{content}}" }),
      undefined,
      { ...collectionSettings, savedNoteFolder: "Information/Café" },
    );

    const saved = await saver.saveArticle(
      createItem({ title: "Café", rssDashboardId: FIRST_ITEM_ID }),
      undefined,
      undefined,
      "NEW BODY",
    );

    expect(saved?.path).toBe(
      `Information/Café/Café-${FIRST_ITEM_ID.slice(0, 8)}.md`,
    );
    expect(await app.vault.read("Information/Cafe\u0301/Cafe\u0301.md")).toContain(
      "DECOMPOSED OWNER",
    );
  });

  it("treats a canonically equivalent NFD folder at a Markdown candidate path as occupied", async () => {
    const app = App.createMock();
    await app.vault.createFolder("Information/Cafe\u0301/Cafe\u0301.md");
    const saver = new ArticleSaver(
      app,
      createSettings({ defaultTemplate: "{{content}}" }),
      undefined,
      { ...collectionSettings, savedNoteFolder: "Information/Café" },
    );

    const saved = await saver.saveArticle(
      createItem({ title: "Café", rssDashboardId: FIRST_ITEM_ID }),
      undefined,
      undefined,
      "BODY",
    );

    expect(saved?.path).toBe(
      `Information/Café/Café-${FIRST_ITEM_ID.slice(0, 8)}.md`,
    );
  });

  it("preserves validated folder segment spacing when creating folders", async () => {
    const app = App.createMock();
    const saver = new ArticleSaver(
      app,
      createSettings({ defaultTemplate: "{{content}}" }),
      undefined,
      { ...collectionSettings, savedNoteFolder: "Information/My  Saved" },
    );
    const createFolderSpy = vi.spyOn(app.vault, "createFolder");

    await saver.saveArticle(
      createItem({ rssDashboardId: FIRST_ITEM_ID }),
      undefined,
      undefined,
      "BODY",
    );

    expect(createFolderSpy).toHaveBeenCalledWith("Information/My  Saved");
  });

  it.each([".", "..", "   ", "Unsafe\u0000Title", "Unsafe\u007fTitle"])(
    "rejects unsafe sanitized filename %j",
    async (title) => {
      const app = App.createMock();
      const saver = new ArticleSaver(
        app,
        createSettings({ defaultTemplate: "{{content}}" }),
        undefined,
        collectionSettings,
      );

      expect(
        await saver.saveArticle(
          createItem({ title, rssDashboardId: FIRST_ITEM_ID }),
          undefined,
          undefined,
          "BODY",
        ),
      ).toBeNull();
    },
  );

  it("serializes concurrent saves across saver instances for same and colliding IDs", async () => {
    const app = App.createMock();
    const settings = createSettings({ defaultTemplate: "{{content}}" });
    const firstSaver = new ArticleSaver(
      app,
      settings,
      undefined,
      collectionSettings,
    );
    const secondSaver = new ArticleSaver(
      app,
      settings,
      undefined,
      collectionSettings,
    );
    const createSpy = vi.spyOn(app.vault, "create");
    const same = createItem({
      title: "Concurrent Same",
      rssDashboardId: FIRST_ITEM_ID,
    });

    const [sameFirst, sameSecond] = await Promise.all([
      firstSaver.saveArticle(same, undefined, undefined, "one"),
      secondSaver.saveArticle({ ...same }, undefined, undefined, "two"),
    ]);
    const [collisionFirst, collisionSecond] = await Promise.all([
      firstSaver.saveArticle(
        createItem({ title: "Concurrent Collision", rssDashboardId: THIRD_ITEM_ID }),
        undefined,
        undefined,
        "alpha",
      ),
      secondSaver.saveArticle(
        createItem({ title: "Concurrent Collision", rssDashboardId: FOURTH_ITEM_ID }),
        undefined,
        undefined,
        "beta",
      ),
    ]);

    expect(sameFirst?.path).toBe(sameSecond?.path);
    expect(collisionFirst?.path).toBe("Information/Saved/Concurrent Collision.md");
    expect(collisionSecond?.path).toBe(
      `Information/Saved/Concurrent Collision-${FOURTH_ITEM_ID.slice(0, 8)}.md`,
    );
    expect(
      createSpy.mock.calls.filter(([path]) =>
        String(path).includes("Concurrent Same"),
      ),
    ).toHaveLength(1);
  });

  it("updates collection flags only after the note is durable and keeps it on sync failure", async () => {
    const app = App.createMock();
    const events: string[] = [];
    const create = app.vault.create.bind(app.vault);
    vi.spyOn(app.vault, "create").mockImplementationOnce(async (path, body) => {
      events.push("write");
      return await create(path, body);
    });
    const flagsSpy = vi
      .spyOn(CollectionRepository.prototype, "updateFlags")
      .mockImplementationOnce(async () => {
        events.push("flags");
        throw new Error("metadata unavailable");
      });
    const saver = new ArticleSaver(
      app,
      createSettings({ defaultTemplate: "{{content}}" }),
      undefined,
      collectionSettings,
    );

    const file = await saver.saveArticle(
      createItem({ rssDashboardId: FIRST_ITEM_ID }),
      undefined,
      undefined,
      "BODY",
    );

    expect(events).toEqual(["write", "flags"]);
    expect(file).toBeInstanceOf(TFile);
    expect(await app.vault.read(file!)).toContain("BODY");
    expect(flagsSpy).toHaveBeenCalledWith(FIRST_ITEM_ID, {
      read: false,
      starred: false,
      saved: true,
      savedNotePath: "Information/Saved/Test Article.md",
    });
    expect(console.warn).toHaveBeenCalledWith(
      "[RSS Dashboard] Saved-note metadata sync failed; the note remains valid and will be repaired later.",
    );
  });

  it("keeps a successful save when workspace and callback observers throw", async () => {
    const app = App.createMock();
    (app.workspace as typeof app.workspace & { trigger: () => void }).trigger =
      vi.fn(() => {
        throw new Error("workspace observer failed");
      });
    vi.spyOn(CollectionRepository.prototype, "updateFlags").mockResolvedValue(
      undefined,
    );
    const saver = new ArticleSaver(
      app,
      createSettings({ defaultTemplate: "{{content}}" }),
      undefined,
      collectionSettings,
      {
        onMetadataSyncSucceeded: () => {
          throw new Error("callback observer failed");
        },
      },
    );

    const file = await saver.saveArticle(
      createItem({ rssDashboardId: FIRST_ITEM_ID }),
      undefined,
      undefined,
      "BODY",
    );

    expect(file).toBeInstanceOf(TFile);
    expect(await app.vault.read(file!)).toContain("BODY");
  });

  it("retries metadata repair when an owned note already exists", async () => {
    const app = App.createMock();
    const saver = new ArticleSaver(
      app,
      createSettings({ defaultTemplate: "{{content}}" }),
      undefined,
      collectionSettings,
    );
    const flagsSpy = vi
      .spyOn(CollectionRepository.prototype, "updateFlags")
      .mockReset()
      .mockRejectedValueOnce(new Error("temporary metadata failure"))
      .mockResolvedValueOnce(undefined);
    const item = createItem({ rssDashboardId: FIRST_ITEM_ID });

    const first = await saver.saveArticle(item, undefined, undefined, "FIRST");
    const second = await saver.saveArticle(item, undefined, undefined, "SECOND");

    expect(second).toBe(first);
    expect(flagsSpy).toHaveBeenCalledTimes(2);
    expect(await app.vault.read(first!)).not.toContain("SECOND");
  });

  it("ignores caller-supplied YouTube media or transcript content", async () => {
    const app = App.createMock();
    const saver = new ArticleSaver(
      app,
      createSettings({ defaultTemplate: "# {{title}}\n\n{{content}}" }),
      undefined,
      collectionSettings,
    );
    vi.spyOn(
      CollectionRepository.prototype,
      "updateFlags",
    ).mockResolvedValueOnce(undefined);
    const file = await saver.saveArticle(
      createItem({
        rssDashboardId: FIRST_ITEM_ID,
        title: "YouTube direct save",
        link: "https://youtu.be/video-id",
        description: "<p>Feed description only.</p>",
        mediaType: "video",
      }),
      undefined,
      undefined,
      "downloaded transcript must not be saved",
    );
    const written = await app.vault.read(file!);

    expect(written).toContain("Feed description only.");
    expect(written).not.toContain("downloaded transcript");
    expect(parseSavedFrontmatter(written).value.contentBasis).toBe(
      "title-description",
    );
  });

  it("creates nested folders one segment at a time", async () => {
    const app = App.createMock();
    const settings = createSettings({
      defaultFolder: "Parent/Child/Grandchild",
      defaultTemplate: "{{content}}",
    });
    const saver = new ArticleSaver(app, settings);
    const createFolderSpy = vi.spyOn(app.vault, "createFolder");

    const item = createItem({ title: "Nested Folder Save" });
    const result = await saver.saveArticle(item, undefined, undefined, "BODY");

    expect(result).toBeInstanceOf(TFile);
    expect(createFolderSpy).toHaveBeenCalledWith("Parent");
    expect(createFolderSpy).toHaveBeenCalledWith("Parent/Child");
    expect(createFolderSpy).toHaveBeenCalledWith("Parent/Child/Grandchild");
  });

  it("retries create after restoring missing folder path", async () => {
    const app = App.createMock();
    const settings = createSettings({
      defaultFolder: "Articles",
      defaultTemplate: "{{content}}",
    });
    const saver = new ArticleSaver(app, settings);

    const originalCreate = app.vault.create.bind(app.vault);
    const createSpy = vi.spyOn(app.vault, "create");
    createSpy
      .mockRejectedValueOnce(new Error("ENOENT: no such file or directory"))
      .mockImplementationOnce(async (path: string, content: string) => {
        return await originalCreate(path, content);
      });

    const item = createItem({ title: "Retry Missing Folder" });
    const result = await saver.saveArticle(item, undefined, undefined, "BODY");

    expect(result).toBeInstanceOf(TFile);
    expect(createSpy).toHaveBeenCalledTimes(2);
  });

  it("uses the full sanitized title in the saved file path", async () => {
    const app = App.createMock();
    const settings = createSettings({
      defaultFolder: "Articles",
      defaultTemplate: "{{content}}",
    });
    const saver = new ArticleSaver(app, settings);

    const item = createItem({
      title:
        'This is a deliberately long article title with / illegal : characters " removed" and extra words',
    });

    const createSpy = vi.spyOn(app.vault, "create");

    await saver.saveArticle(item, undefined, undefined, "BODY");

    const expectedPath =
      "Articles/This is a deliberately long article title with illegal characters removed and extra words.md";
    expect(createSpy).toHaveBeenCalled();
    expect(createSpy.mock.calls[0][0]).toBe(expectedPath);
    expect(item.savedFilePath).toBe(expectedPath);
  });

  it("does not save when the title sanitizes to an unsafe empty filename", async () => {
    const app = App.createMock();
    const settings = createSettings({
      defaultFolder: "Articles",
      defaultTemplate: "{{content}}",
    });
    const saver = new ArticleSaver(app, settings);

    const item = createItem({ title: ' / \\\\ : * ? " < > | ' });

    const createSpy = vi.spyOn(app.vault, "create");

    const result = await saver.saveArticle(item, undefined, undefined, "BODY");

    expect(result).toBeNull();
    expect(createSpy).not.toHaveBeenCalled();
    expect(item.savedFilePath).toBeUndefined();
  });
});

/** Typed accessor for private ArticleSaver methods tested in isolation. */
type PrivateSaverAPI = {
  replaceDatePlaceholders(template: string, date: Date): string;
};

describe("ArticleSaver.replaceDatePlaceholders", () => {
  it("replaces {{date}} with long format", () => {
    const app = App.createMock();
    const settings = createSettings();
    const saver = new ArticleSaver(app, settings);
    const date = new Date("2024-04-21T12:00:00Z");

    const input = "Date: {{date}}";
    const result = (
      saver as unknown as PrivateSaverAPI
    ).replaceDatePlaceholders(input, date);

    // toLocaleDateString depends on environment, but we expect the long format
    expect(result).toContain("April 21, 2024");
  });

  it("replaces {{dateShort}} with YYYY-MM-DD", () => {
    const app = App.createMock();
    const settings = createSettings();
    const saver = new ArticleSaver(app, settings);
    const date = new Date("2024-04-21T12:00:00Z");

    const input = "Short: {{dateShort}}";
    const result = (
      saver as unknown as PrivateSaverAPI
    ).replaceDatePlaceholders(input, date);

    expect(result).toBe("Short: 2024-04-21");
  });

  it("replaces {{isoDate}} with ISO string", () => {
    const app = App.createMock();
    const settings = createSettings();
    const saver = new ArticleSaver(app, settings);
    const date = new Date("2024-04-21T12:00:00Z");

    const input = "ISO: {{isoDate}}";
    const result = (
      saver as unknown as PrivateSaverAPI
    ).replaceDatePlaceholders(input, date);

    expect(result).toBe("ISO: 2024-04-21T12:00:00.000Z");
  });

  it("replaces parameterized {{date:FORMAT}} using moment", () => {
    const app = App.createMock();
    const settings = createSettings();
    const saver = new ArticleSaver(app, settings);
    const date = new Date("2024-04-21T12:00:00Z");

    const input = "Custom: {{date:YYYY/MM/DD}} Time: {{date:HH:mm}}";
    const result = (
      saver as unknown as PrivateSaverAPI
    ).replaceDatePlaceholders(input, date);

    const expectedDate = moment(date).format("YYYY/MM/DD");
    const expectedTime = moment(date).format("HH:mm");
    expect(result).toBe(`Custom: ${expectedDate} Time: ${expectedTime}`);
  });

  it("handles complex moment formats", () => {
    const app = App.createMock();
    const settings = createSettings();
    const saver = new ArticleSaver(app, settings);
    const date = new Date("2024-04-21T12:00:00Z");

    const input = "{{date:dddd, MMMM Do YYYY}}";
    const result = (
      saver as unknown as PrivateSaverAPI
    ).replaceDatePlaceholders(input, date);

    const expected = moment(date).format("dddd, MMMM Do YYYY");
    expect(result).toBe(expected);
  });
});

describe("ArticleSaver.fetchFullArticleContent", () => {
  it("retries sagepub full-text URLs via /doi/abs/ when the full-text fetch returns empty", async () => {
    const app = App.createMock();
    const settings = createSettings();
    const saver = new ArticleSaver(app, settings, "https://proxy/?url=");

    const fetchSpy = vi
      .spyOn(fetchHelpers, "fetchWithProxyFallbackDetailed")
      .mockResolvedValueOnce({ content: "", failureType: "network" })
      .mockResolvedValueOnce({
        content: "<p>abstract</p>",
        failureType: "none",
      });

    const url = "https://journals.sagepub.com/doi/full/10.1177/00000000";
    const result = await saver.fetchFullArticleContent(url);

    expect(result).toBe("<p>abstract</p>");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0]).toEqual([url, "https://proxy/?url="]);
    expect(fetchSpy.mock.calls[1]).toEqual([
      "https://journals.sagepub.com/doi/abs/10.1177/00000000",
      "https://proxy/?url=",
    ]);
  });
});

describe("ArticleSaver.saveArticleWithFullContent", () => {
  it("uses cached full text without another website request", async () => {
    const app = App.createMock();
    await app.vault.createFolder(".rss-dashboard-data");
    await app.vault.createFolder(".rss-dashboard-data/content");
    const cachedText = "<article><p>Short but valid cached article text.</p></article>";
    await app.vault.adapter.write(
      `.rss-dashboard-data/content/${FIRST_ITEM_ID}.md`,
      `---\nschemaVersion: 1\nitemId: ${JSON.stringify(FIRST_ITEM_ID)}\nsourceUrl: "https://example.com/article"\nfetchedAt: "2026-07-21T08:00:00.000Z"\ncontentBasis: "full-text"\n---\n\n${cachedText}`,
    );
    vi.spyOn(
      CollectionRepository.prototype,
      "updateFlags",
    ).mockResolvedValueOnce(undefined);
    const fetchSpy = vi.spyOn(
      fetchHelpers,
      "fetchWithProxyFallbackDetailed",
    );
    fetchSpy.mockClear();
    const saver = new ArticleSaver(
      app,
      createSettings({ defaultTemplate: "{{content}}" }),
      "https://proxy/?url=",
      collectionSettings,
    );

    const file = await saver.saveArticleWithFullContent(
      createItem({ rssDashboardId: FIRST_ITEM_ID }),
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(file).toBeInstanceOf(TFile);
    const written = await app.vault.read(file!);
    expect(written).toContain("Short but valid cached article text.");
    expect(parseSavedFrontmatter(written).value.contentBasis).toBe("full-text");
  });

  it("opens an existing stable-ID note before cache or network work", async () => {
    const app = App.createMock();
    await app.vault.createFolder("Information/Saved");
    const existing = await app.vault.create(
      "Information/Saved/Existing.md",
      ownedNote(FIRST_ITEM_ID, "do not rewrite"),
    );
    const fetchSpy = vi.spyOn(
      fetchHelpers,
      "fetchWithProxyFallbackDetailed",
    );
    fetchSpy.mockClear();
    const openFile = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(app.workspace, "getLeaf").mockReturnValue({ openFile });
    const createSpy = vi.spyOn(app.vault, "create");
    const saver = new ArticleSaver(
      app,
      createSettings(),
      "https://proxy/?url=",
      collectionSettings,
    );

    const file = await saver.saveArticleWithFullContent(
      createItem({ rssDashboardId: FIRST_ITEM_ID }),
    );

    expect(file).toBe(existing);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
    expect(openFile).toHaveBeenCalledWith(existing);
    expect(await app.vault.read(existing)).toContain("do not rewrite");
  });

  it("saves YouTube title and description without fetching media or full text", async () => {
    const app = App.createMock();
    vi.spyOn(
      CollectionRepository.prototype,
      "updateFlags",
    ).mockResolvedValueOnce(undefined);
    const fetchSpy = vi.spyOn(
      fetchHelpers,
      "fetchWithProxyFallbackDetailed",
    );
    fetchSpy.mockClear();
    const saver = new ArticleSaver(
      app,
      createSettings({ defaultTemplate: "# {{title}}\n\n{{content}}" }),
      "https://proxy/?url=",
      collectionSettings,
    );
    const item = createItem({
      rssDashboardId: FIRST_ITEM_ID,
      title: "Video title",
      link: "https://www.youtube.com/watch?v=abc123",
      feedUrl: "https://www.youtube.com/feeds/videos.xml?channel_id=channel",
      description: "<p>Channel-provided description.</p>",
      content: "<p>media/transcript payload must not be used</p>",
      mediaType: "video",
    });

    const file = await saver.saveArticleWithFullContent(item);
    const written = await app.vault.read(file!);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(written).toContain("# Video title");
    expect(written).toContain("Channel-provided description.");
    expect(written).not.toContain("media/transcript payload");
    expect(parseSavedFrontmatter(written).value.contentBasis).toBe(
      "title-description",
    );
  });

  it("prepends enclosure image when chosen feed HTML has no inline image", async () => {
    const app = App.createMock();
    const settings = createSettings({
      defaultTemplate: "{{content}}",
      includeFrontmatter: false,
    });
    const saver = new ArticleSaver(app, settings, "https://proxy/?url=");

    vi.spyOn(
      fetchHelpers,
      "fetchWithProxyFallbackDetailed",
    ).mockResolvedValueOnce({
      content:
        '<body xmlns="http://www.w3.org/1999/xhtml">Organizations are accumulating a type of debt that no one has been hired to pay down.</body>',
      failureType: "none",
    });

    const enclosureUrl =
      "https://substack-post-media.s3.amazonaws.com/public/images/b83cfdcd-1a21-49a0-943f-977022ed4b0a_2160x1131.png";
    const item = createItem({
      title: "Part-time owners, full-time debt",
      link: "https://behzodsirjani.substack.com/p/part-time-owners-full-time-debt",
      content: "",
      description:
        "<p>Organizations are accumulating a type of debt that no one has been hired to pay down.</p>",
      enclosure: {
        url: enclosureUrl,
        length: "0",
        type: "image/jpeg",
      },
      coverImage: "",
      image: "",
    });

    const file = await saver.saveArticleWithFullContent(item);

    expect(file).toBeInstanceOf(TFile);
    if (!(file instanceof TFile)) throw new Error("expected TFile");
    const written = await app.vault.read(file);

    expect(written).toContain(`![Hero image](${enclosureUrl})`);
    expect(written).toContain(
      "Organizations are accumulating a type of debt that no one has been hired to pay down.",
    );
  });

  it("unwraps image-only links without malformed markdown", async () => {
    const app = App.createMock();
    const settings = createSettings({
      defaultTemplate: "{{content}}",
      includeFrontmatter: false,
    });
    const saver = new ArticleSaver(app, settings, "https://proxy/?url=");

    vi.spyOn(
      fetchHelpers,
      "fetchWithProxyFallbackDetailed",
    ).mockResolvedValueOnce({
      content:
        '<body xmlns="http://www.w3.org/1999/xhtml">Organizations are accumulating a type of debt that no one has been hired to pay down.</body>',
      failureType: "none",
    });

    const rawSubstackLink =
      "https://substackcdn.com/image/fetch/$s_!GtED!,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F108fc67d-1f88-4d55-bb47-e44613e67b2a_1632x656.png";
    const decodedImageUrl =
      "https://substack-post-media.s3.amazonaws.com/public/images/108fc67d-1f88-4d55-bb47-e44613e67b2a_1632x656.png";
    const item = createItem({
      title: "Substack Linked Image",
      link: "https://behzodsirjani.substack.com/p/another-post",
      content: `<figure><a href="${rawSubstackLink}"><img src="${decodedImageUrl}" alt="" /></a></figure><p>Body text.</p>`,
      description: "<p>Summary</p>",
    });

    const file = await saver.saveArticleWithFullContent(item);

    expect(file).toBeInstanceOf(TFile);
    if (!(file instanceof TFile)) throw new Error("expected TFile");
    const written = await app.vault.read(file);

    expect(written).toContain(`![](${decodedImageUrl})`);
    expect(written).not.toContain("Link to image");
    expect(written).not.toContain("[\n\n![](");
    expect(written).toContain("Body text.");
  });

  it("uses feed description as fallback feed content when item.content is empty", async () => {
    const app = App.createMock();
    const settings = createSettings({
      defaultTemplate: "{{content}}",
      includeFrontmatter: false,
    });
    const saver = new ArticleSaver(app, settings, "https://proxy/?url=");

    vi.spyOn(
      fetchHelpers,
      "fetchWithProxyFallbackDetailed",
    ).mockResolvedValueOnce({
      content:
        '<body xmlns="http://www.w3.org/1999/xhtml">Organizations are accumulating a type of debt that no one has been hired to pay down.</body>',
      failureType: "none",
    });

    const item = createItem({
      title: "Substack Description Fallback",
      link: "https://behzodsirjani.substack.com/p/part-time-owners-full-time-debt",
      content: "",
      description:
        "<p>Organizations are accumulating a type of debt that no one has been hired to pay down.</p><p>At Vercel, I was brought in to handle some of this debt, but not all of it.</p>",
    });

    const file = await saver.saveArticleWithFullContent(item);

    expect(file).toBeInstanceOf(TFile);
    if (!(file instanceof TFile)) throw new Error("expected TFile");
    const written = await app.vault.read(file);

    expect(written).toContain(
      "At Vercel, I was brought in to handle some of this debt, but not all of it.",
    );
    expect(written).not.toContain(
      '<body xmlns="http://www.w3.org/1999/xhtml">',
    );
  });

  it("converts fetched HTML to markdown and saves it", async () => {
    const app = App.createMock();
    const settings = createSettings({
      defaultTemplate: "{{content}}",
      includeFrontmatter: false,
    });
    const saver = new ArticleSaver(app, settings, "https://proxy/?url=");

    vi.spyOn(
      fetchHelpers,
      "fetchWithProxyFallbackDetailed",
    ).mockResolvedValueOnce({
      content: "<article><p>Hello <strong>world</strong>.</p></article>",
      failureType: "none",
    });

    const item = createItem({ title: "Full Content" });
    const file = await saver.saveArticleWithFullContent(item);

    expect(file).toBeInstanceOf(TFile);
    if (!(file instanceof TFile)) throw new Error("expected TFile");
    const written = await app.vault.read(file);
    expect(written).toContain("Hello");
    expect(written).toContain("world");
  });

  it("falls back to feed content when full content is unavailable", async () => {
    const app = App.createMock();
    const settings = createSettings({
      defaultTemplate: "{{content}}",
      includeFrontmatter: false,
    });
    const saver = new ArticleSaver(app, settings, "https://proxy/?url=");

    vi.spyOn(
      fetchHelpers,
      "fetchWithProxyFallbackDetailed",
    ).mockResolvedValueOnce({
      content: "",
      failureType: "network",
    });
    const item = createItem({
      title: "Fallback Content",
      content:
        "<div><style>.bh__table { border: 1px solid #C0C0C0; }</style><p>Feed body wins.</p></div>",
    });
    const file = await saver.saveArticleWithFullContent(item);

    expect(file).toBeInstanceOf(TFile);
    expect(await app.vault.read(file!)).toContain("Feed body wins.");
    expect(
      parseSavedFrontmatter(await app.vault.read(file!)).value.contentBasis,
    ).toBe("feed");
  });

  it("falls back to feed content when the explicit website request throws", async () => {
    const app = App.createMock();
    const saver = new ArticleSaver(
      app,
      createSettings({ defaultTemplate: "{{content}}" }),
      "https://proxy/?url=",
    );
    vi.spyOn(
      fetchHelpers,
      "fetchWithProxyFallbackDetailed",
    ).mockRejectedValueOnce(new Error("offline"));
    const item = createItem({
      title: "Thrown Fetch Fallback",
      description: "<p>Durable feed fallback.</p>",
    });

    const file = await saver.saveArticleWithFullContent(item);

    expect(file).toBeInstanceOf(TFile);
    expect(await app.vault.read(file!)).toContain("Durable feed fallback.");
    expect(
      parseSavedFrontmatter(await app.vault.read(file!)).value.contentBasis,
    ).toBe("feed");
  });

  it("uses richer feed content when fetched article content is only a short excerpt", async () => {
    const app = App.createMock();
    const settings = createSettings({
      defaultTemplate: "# {{title}}\n\n{{content}}\n\n[Source]({{link}})",
      includeFrontmatter: false,
    });
    const saver = new ArticleSaver(app, settings, "https://proxy/?url=");

    vi.spyOn(
      fetchHelpers,
      "fetchWithProxyFallbackDetailed",
    ).mockResolvedValueOnce({
      content:
        '<body xmlns="http://www.w3.org/1999/xhtml">Q+A with one of the Broadview Six.</body>',
      failureType: "none",
    });

    const item = createItem({
      title: "Beehiiv Full Body",
      content:
        '<div class="beehiiv"><style> .bh__table, .bh__table_header, .bh__table_cell { border: 1px solid #C0C0C0; }</style><div class="beehiiv__body"><p>For the last seven months, Kat Abughazaleh was not allowed to go to Alaska.</p><p>The full interview continues from here with much more context.</p></div></div>',
    });

    const file = await saver.saveArticleWithFullContent(item);

    expect(file).toBeInstanceOf(TFile);
    if (!(file instanceof TFile)) throw new Error("expected TFile");
    const written = await app.vault.read(file);

    expect(written).toContain(
      "For the last seven months, Kat Abughazaleh was not allowed to go to Alaska.",
    );
    expect(written).toContain(
      "The full interview continues from here with much more context.",
    );
    expect(written).not.toContain(".bh__table");
    expect(written).not.toContain("border: 1px");
    expect(written).not.toContain("<body");
    expect(written).not.toContain('xmlns="http://www.w3.org/1999/xhtml"');
  });

  it("keeps embed links inline when saving beehiiv blockquote content", async () => {
    const app = App.createMock();
    const settings = createSettings({
      defaultTemplate: "{{content}}",
      includeFrontmatter: false,
    });
    const saver = new ArticleSaver(app, settings, "https://proxy/?url=");

    vi.spyOn(
      fetchHelpers,
      "fetchWithProxyFallbackDetailed",
    ).mockResolvedValueOnce({
      content: "<p>Short excerpt.</p>",
      failureType: "none",
    });

    const instagramUrl = "https://www.instagram.com/p/DY3yTRYjtma/?img_index=1";
    const blueskyUrl =
      "https://bsky.app/profile/marisakabas.bsky.social/post/3mmuh2ltnq22b";
    const item = createItem({
      title: "Beehiiv Embeds",
      content: `<div>
        <p>Enough feed text to be selected over the fetched excerpt.</p>
        <blockquote align="center" class="instagram-media">
          <a href="${instagramUrl}"><p dir="ltr" lang="en">Instagram post</p></a>
        </blockquote>
        <blockquote align="center" class="bluesky-embed">
          <p dir="ltr" lang="en"><p>I just spoke with Sister Sharon.</p></p>
          <a href="${blueskyUrl}"><p> &mdash; Marisa Kabas (@marisakabas.bsky.social) <br/> 9:25 PM - May 27, 2026 </p></a>
        </blockquote>
      </div>`,
    });

    const file = await saver.saveArticleWithFullContent(item);

    expect(file).toBeInstanceOf(TFile);
    if (!(file instanceof TFile)) throw new Error("expected TFile");
    const written = await app.vault.read(file);

    expect(written).toContain(`[Instagram post](${instagramUrl})`);
    expect(written).toContain(
      `[— Marisa Kabas (@marisakabas.bsky.social) 9:25 PM - May 27, 2026](${blueskyUrl})`,
    );
    expect(written).not.toContain("[\n>");
    expect(written).not.toContain("> ](");
  });

  it("skips full-content fetch for Bloomberg video routes and saves available content", async () => {
    const app = App.createMock();
    const settings = createSettings({
      defaultTemplate: "{{content}}",
      includeFrontmatter: false,
    });
    const saver = new ArticleSaver(app, settings, "https://proxy/?url=");

    const fetchSpy = vi.spyOn(fetchHelpers, "fetchWithProxyFallbackDetailed");
    fetchSpy.mockClear();

    const item = createItem({
      title: "Bloomberg Video",
      link: "https://www.bloomberg.com/news/videos/2026-05-12/sample-video",
      mediaType: "article",
      mediaContentType: "image/jpeg",
    });

    const file = await saver.saveArticleWithFullContent(item);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(file).toBeInstanceOf(TFile);
    expect(
      parseSavedFrontmatter(await app.vault.read(file!)).value.contentBasis,
    ).toBe("feed");
    expect(item.restrictedReason).toBeUndefined();
  });

  it("shows restricted-content notice once and falls back when content is paywalled", async () => {
    const app = App.createMock();
    const settings = createSettings({
      defaultTemplate: "{{content}}",
      includeFrontmatter: false,
    });
    const saver = new ArticleSaver(app, settings, "https://proxy/?url=");

    const logSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.spyOn(
      fetchHelpers,
      "fetchWithProxyFallbackDetailed",
    ).mockResolvedValueOnce({
      content: "",
      failureType: "restricted",
    });

    const item = createItem({ title: "Restricted Content" });
    await saver.saveArticleWithFullContent(item);

    expect(logSpy).toHaveBeenCalledWith(
      "[Stub Notice]",
      "Full article is restricted. Showing available feed excerpt.",
    );
    expect(logSpy).not.toHaveBeenCalledWith(
      "[Stub Notice]",
      expect.stringContaining("Network error:"),
    );
    expect(item.restrictedReason).toBe(RESTRICTED_ARTICLE_REASON);
  });
});

describe("ArticleSaver.verifySavedArticle", () => {
  it("returns true when the saved file exists in the vault", async () => {
    const app = App.createMock();
    const settings = createSettings();
    const saver = new ArticleSaver(
      app,
      settings,
      undefined,
      collectionSettings,
    );

    const item = createItem({ title: "Exists" });
    item.rssDashboardId = FIRST_ITEM_ID;
    const filePath = "Information/Saved/Exists.md";
    await app.vault.create(filePath, ownedNote(FIRST_ITEM_ID));

    item.saved = true;
    item.savedFilePath = filePath;
    item.tags = [{ name: "saved", color: "#3498db" }];

    expect(await saver.verifySavedArticle(item)).toBe(true);
    expect(item.saved).toBe(true);
  });

  it("clears saved state and removes the saved tag when the file is missing", async () => {
    const app = App.createMock();
    const settings = createSettings();
    const saver = new ArticleSaver(app, settings);

    const item = createItem({ title: "Missing" });
    item.saved = true;
    item.savedFilePath = "Articles/Missing.md";
    item.tags = [
      { name: "saved", color: "#3498db" },
      { name: "other", color: "#000" },
    ];

    expect(await saver.verifySavedArticle(item)).toBe(false);
    expect(item.saved).toBe(false);
    expect(item.savedFilePath).toBeUndefined();
    expect(item.tags.map((t) => t.name)).toEqual(["other"]);
  });
});

describe("ArticleSaver.fixSavedFilePaths", () => {
  it("repairs a saved path only by finding the same stable ID in the configured folder", async () => {
    const app = App.createMock();
    const settings = createSettings();
    const saver = new ArticleSaver(
      app,
      settings,
      undefined,
      collectionSettings,
    );

    await app.vault.create(
      "Information/Saved/Renamed.md",
      ownedNote(FIRST_ITEM_ID),
    );
    await app.vault.create(
      "Information/Saved/Item.md",
      ownedNote(SECOND_ITEM_ID),
    );

    const item = createItem({ title: "Item", rssDashboardId: FIRST_ITEM_ID });
    item.saved = true;
    item.savedFilePath = "Information/Saved/Item.md";

    const renameSpy = vi.spyOn(app.fileManager, "renameFile");
    await saver.fixSavedFilePaths([item]);

    expect(item.savedFilePath).toBe("Information/Saved/Renamed.md");
    expect(renameSpy).not.toHaveBeenCalled();
  });

  it("preserves an explicitly owned custom path during repair", async () => {
    const app = App.createMock();
    const settings = createSettings({ defaultFolder: "Legacy" });
    const saver = new ArticleSaver(
      app,
      settings,
      undefined,
      collectionSettings,
    );

    const oldPath = "Old Folder/Weird.md";
    const file = await app.vault.create(oldPath, ownedNote(FIRST_ITEM_ID));
    const item = createItem({
      title: "My / Weird : Title",
      rssDashboardId: FIRST_ITEM_ID,
      tags: [{ name: "saved", color: "#3498db" }],
    });
    item.saved = true;
    item.savedFilePath = oldPath;

    const renameSpy = vi.spyOn(app.fileManager, "renameFile");
    await saver.fixSavedFilePaths([item]);

    expect(renameSpy).not.toHaveBeenCalled();
    expect(file.path).toBe(oldPath);
    expect(item.savedFilePath).toBe(file.path);
    expect(item.saved).toBe(true);
  });

  it("confirms and migrates a pre-Task8 exact legacy note from the default RSS folder", async () => {
    const app = App.createMock();
    const saver = new ArticleSaver(
      app,
      createSettings({ defaultFolder: "RSS articles" }),
      undefined,
      collectionSettings,
    );
    const item = createItem({
      rssDashboardId: undefined,
      saved: true,
      savedFilePath: "RSS articles/Legacy Item.md",
    });
    await app.vault.create(item.savedFilePath!, legacySavedNote(item));

    await saver.fixSavedFilePaths([item]);

    expect(item.saved).toBe(true);
    expect(item.savedFilePath).toBe("Information/Saved/Test Article.md");
    expect(item.rssDashboardId).toMatch(/^[a-f0-9]{64}$/);
    const migrated = await app.vault.read(item.savedFilePath!);
    const { value } = parseSavedFrontmatter(migrated);
    expect(value.rssDashboardId).toBe(item.rssDashboardId);
    expect(value.customUserField).toBe("preserve me");
    expect(migrated).toContain("LEGACY BODY");
  });

  it("uses the deterministic suffix when a confirmed legacy migration meets an unrelated same-title note", async () => {
    const app = App.createMock();
    const saver = new ArticleSaver(
      app,
      createSettings({ defaultFolder: "RSS articles" }),
      undefined,
      collectionSettings,
    );
    const item = createItem({
      rssDashboardId: undefined,
      saved: true,
      savedFilePath: "RSS articles/Test Article.md",
    });
    await app.vault.create(item.savedFilePath!, legacySavedNote(item));
    await app.vault.create(
      "Information/Saved/Test Article.md",
      "---\ntitle: unrelated\n---\n\nUNRELATED BODY",
    );

    await saver.fixSavedFilePaths([item]);

    expect(item.savedFilePath).toBe(
      `Information/Saved/Test Article-${item.rssDashboardId?.slice(0, 8)}.md`,
    );
    expect(await app.vault.read("Information/Saved/Test Article.md")).toContain(
      "UNRELATED BODY",
    );
  });

  it.each([
    {
      name: "LF with comments, quotes, spacing, and a block scalar",
      newline: "\n",
      bom: true,
      frontmatter: [
        "title : 'Quoted # title' # keep comment",
        'source: "Test Feed" # keep source bytes',
        "guid: guid-1",
        "notes: |-",
        "  line: one",
        "  line two",
      ],
    },
    {
      name: "CRLF with single and double quoted scalars",
      newline: "\r\n",
      bom: false,
      frontmatter: [
        'title: "Double quoted" # comment',
        "source: 'Test Feed'",
        "guid: 'guid-1'",
        "notes: >-",
        "  folded value",
      ],
    },
  ])("injects legacy ownership byte-safely: $name", async ({ newline, frontmatter, bom }) => {
    const app = App.createMock();
    const saver = new ArticleSaver(
      app,
      createSettings({ defaultFolder: "RSS articles" }),
      undefined,
      collectionSettings,
    );
    const item = createItem({
      rssDashboardId: undefined,
      saved: true,
      savedFilePath: "RSS articles/Byte Safe.md",
    });
    const original = [
      `${bom ? "\uFEFF" : ""}---`,
      ...frontmatter,
      "---",
      "",
      "BODY byte-for-byte\t  ",
      "final line",
    ].join(newline);
    await app.vault.create(item.savedFilePath!, original);

    await saver.fixSavedFilePaths([item]);

    const migrated = await app.vault.read(item.savedFilePath!);
    const insertionStart = migrated.indexOf(`${newline}rssDashboardId:`);
    const closingStart = migrated.indexOf(`${newline}---`, insertionStart + 1);
    expect(insertionStart).toBeGreaterThan(0);
    expect(closingStart).toBeGreaterThan(insertionStart);
    expect(
      migrated.slice(0, insertionStart) + migrated.slice(closingStart),
    ).toBe(original);
    expect(migrated.startsWith(bom ? "\uFEFF---" : "---")).toBe(true);
    expect(migrated.slice(insertionStart, closingStart)).toContain(
      `rssDashboardId: ${JSON.stringify(item.rssDashboardId)}`,
    );
    expect(migrated.slice(insertionStart, closingStart)).toContain(
      "contentBasis: \"feed\"",
    );
    if (newline === "\r\n") {
      expect(migrated.replace(/\r\n/g, "")).not.toContain("\n");
    }
  });

  it("leaves a verified legacy candidate untouched when owned-line injection is unsafe", async () => {
    const app = App.createMock();
    const saver = new ArticleSaver(
      app,
      createSettings({ defaultFolder: "RSS articles" }),
      undefined,
      collectionSettings,
    );
    const item = createItem({
      rssDashboardId: undefined,
      saved: true,
      savedFilePath: "RSS articles/Partial Owned.md",
    });
    const original = [
      "---",
      'guid: "guid-1"',
      'source: "Test Feed"',
      'savedAt: "user-defined-existing-value" # do not rewrite',
      "---",
      "",
      "ORIGINAL BODY",
    ].join("\n");
    await app.vault.create(item.savedFilePath!, original);
    const modifySpy = vi.spyOn(app.vault, "modify");
    const renameSpy = vi.spyOn(app.fileManager, "renameFile");

    await saver.fixSavedFilePaths([item]);

    expect(item.savedNoteMigrationPending).toBe(true);
    expect(modifySpy).not.toHaveBeenCalled();
    expect(renameSpy).not.toHaveBeenCalled();
    expect(await app.vault.read(item.savedFilePath!)).toBe(original);
  });

  it.each([
    {
      name: "common GUID without an independent source",
      yaml: 'guid: "1"\nlink: "not-a-valid-url"',
      item: { guid: "1", link: "not-a-valid-url" },
      migrates: false,
    },
    {
      name: "matching GUID with the wrong source",
      yaml: 'guid: "guid-1"\nsource: "Another Feed"',
      item: { link: "not-a-valid-url" },
      migrates: false,
    },
    {
      name: "matching GUID with an exact source",
      yaml: 'guid: "guid-1"\nsource: "Test Feed"',
      item: { link: "not-a-valid-url" },
      migrates: true,
    },
    {
      name: "canonical article URL match",
      yaml: 'link: "https://example.com/article?utm_source=old"',
      item: { link: "https://example.com/article" },
      migrates: true,
    },
  ])("applies the legacy evidence threshold: $name", async ({ yaml, item: overrides, migrates }) => {
    const app = App.createMock();
    const saver = new ArticleSaver(
      app,
      createSettings({ defaultFolder: "RSS articles" }),
      undefined,
      collectionSettings,
    );
    const item = createItem({
      ...overrides,
      rssDashboardId: undefined,
      saved: true,
      savedFilePath: "RSS articles/Evidence.md",
    });
    const original = `---\n${yaml}\n---\n\nORIGINAL`;
    await app.vault.create(item.savedFilePath!, original);

    await saver.fixSavedFilePaths([item]);

    expect(item.saved).toBe(true);
    expect(Boolean(item.savedNoteMigrationPending)).toBe(!migrates);
    if (migrates) {
      expect(item.savedFilePath).toBe("Information/Saved/Test Article.md");
      expect(await app.vault.read(item.savedFilePath!)).toContain(
        `rssDashboardId: ${JSON.stringify(item.rssDashboardId)}`,
      );
    } else {
      expect(item.savedFilePath).toBe("RSS articles/Evidence.md");
      expect(await app.vault.read(item.savedFilePath!)).toBe(original);
    }
  });

  it("keeps an unconfirmed exact legacy note pending without clearing, renaming, or claiming it", async () => {
    const app = App.createMock();
    const settings = createSettings();
    const saver = new ArticleSaver(
      app,
      settings,
      undefined,
      collectionSettings,
    );
    await app.vault.create(
      "Information/Saved/Not A File.md",
      "---\ntitle: user note\n---\n\nUSER BODY",
    );

    const item = createItem({ title: "Not A File", rssDashboardId: undefined });
    item.saved = true;
    item.savedFilePath = "Information/Saved/Not A File.md";
    item.tags = [
      { name: "saved", color: "#3498db" },
      { name: "keep", color: "#000" },
    ];
    const warningCountBefore = vi.mocked(console.warn).mock.calls.length;

    await saver.fixSavedFilePaths([item]);
    await saver.fixSavedFilePaths([item]);

    expect(item.saved).toBe(true);
    expect(item.savedFilePath).toBe("Information/Saved/Not A File.md");
    expect(
      (
        item as FeedItem & {
          savedNoteMigrationPending?: boolean;
        }
      ).savedNoteMigrationPending,
    ).toBe(true);
    expect(item.tags.map((t) => t.name)).toEqual(["saved", "keep"]);
    expect(await app.vault.read("Information/Saved/Not A File.md")).toContain(
      "USER BODY",
    );
    expect(console.warn).toHaveBeenCalledWith(
      "[RSS Dashboard] Saved note ownership could not be verified; the existing path was left unchanged for manual review.",
    );
    expect(vi.mocked(console.warn).mock.calls.length - warningCountBefore).toBe(
      1,
    );
  });

  it("leaves a legacy note pending when strong identity matches conflict", async () => {
    const app = App.createMock();
    const saver = new ArticleSaver(
      app,
      createSettings(),
      undefined,
      collectionSettings,
    );
    const item = createItem({
      rssDashboardId: undefined,
      saved: true,
      savedFilePath: "RSS articles/Conflict.md",
    });
    await app.vault.create(
      item.savedFilePath!,
      legacySavedNote(item, "ORIGINAL", {
        guid: "different-guid",
        link: "https://example.com/different",
      }),
    );
    const modifySpy = vi.spyOn(app.vault, "modify");
    const renameSpy = vi.spyOn(app.fileManager, "renameFile");

    await saver.fixSavedFilePaths([item]);

    expect(item.saved).toBe(true);
    expect(item.savedFilePath).toBe("RSS articles/Conflict.md");
    expect(modifySpy).not.toHaveBeenCalled();
    expect(renameSpy).not.toHaveBeenCalled();
    expect(await app.vault.read(item.savedFilePath)).toContain("ORIGINAL");
  });
});

describe("ArticleSaver saved file lookups", () => {
  it("accepts savedFilePath only when it is inside the configured folder and owned by the stable ID", async () => {
    const app = App.createMock();
    const settings = createSettings({ defaultFolder: "Articles" });
    const saver = new ArticleSaver(
      app,
      settings,
      undefined,
      collectionSettings,
    );

    const item = createItem({
      title: "Title With / Slash",
      rssDashboardId: FIRST_ITEM_ID,
      saved: true,
      savedFilePath: "Information/Saved/Already Saved.md",
    });

    await app.vault.create(
      "Information/Saved/Already Saved.md",
      ownedNote(FIRST_ITEM_ID),
    );

    expect(await saver.checkSavedFileExists(item)).toBe(true);
    expect(item.savedFilePath).toBe("Information/Saved/Already Saved.md");
  });

  it("never falls back to an unowned same-title file", async () => {
    const app = App.createMock();
    const settings = createSettings({ defaultFolder: "/Articles/" });
    const saver = new ArticleSaver(
      app,
      settings,
      undefined,
      collectionSettings,
    );

    const item = createItem({
      title: "Legacy / Saved Article",
      rssDashboardId: FIRST_ITEM_ID,
      saved: true,
    });

    await app.vault.create(
      "Information/Saved/Legacy Saved Article.md",
      "user content",
    );

    expect(await saver.checkSavedFileExists(item)).toBe(false);
    expect(item.savedFilePath).toBeUndefined();
  });

  it("accepts an exactly owned savedFilePath outside the configured collection folder", async () => {
    const app = App.createMock();
    const settings = createSettings({ defaultFolder: "RSS articles" });
    const saver = new ArticleSaver(
      app,
      settings,
      undefined,
      collectionSettings,
    );

    const item = createItem({
      title: "My Article",
      rssDashboardId: FIRST_ITEM_ID,
      saved: true,
      savedFilePath: "Custom Folder/My Article.md",
    });

    await app.vault.create(
      "Custom Folder/My Article.md",
      ownedNote(FIRST_ITEM_ID),
    );

    const file = await saver.findSavedArticleFile(item);

    expect(file?.path).toBe("Custom Folder/My Article.md");
  });

  it.each([
    `---\nrssDashboardId: ${JSON.stringify(FIRST_ITEM_ID)}\nrssDashboardId: ${JSON.stringify(FIRST_ITEM_ID)}\n---\n`,
    `---\n"rssDashboardId": ${JSON.stringify(FIRST_ITEM_ID)}\nrssDashboardId: ${JSON.stringify(FIRST_ITEM_ID)}\n---\n`,
    `---\nnested:\n  rssDashboardId: ${JSON.stringify(FIRST_ITEM_ID)}\n---\n`,
    `---\nrssDashboardId: [${JSON.stringify(FIRST_ITEM_ID)}]\n---\n`,
    `---\nrssDashboardId: &id ${JSON.stringify(FIRST_ITEM_ID)}\ncopy: *id\n---\n`,
    `---\nrssDashboardId: [unterminated\n---\n`,
  ])("treats ambiguous ownership frontmatter as unowned", async (frontmatter) => {
    const app = App.createMock();
    const saver = new ArticleSaver(
      app,
      createSettings(),
      undefined,
      collectionSettings,
    );
    const path = "Information/Saved/Ambiguous.md";
    await app.vault.create(path, `${frontmatter}\nUSER BODY`);
    const item = createItem({
      title: "Ambiguous",
      rssDashboardId: FIRST_ITEM_ID,
      saved: true,
      savedFilePath: path,
    });

    expect(await saver.findSavedArticleFile(item)).toBeNull();
    expect(await app.vault.read(path)).toContain("USER BODY");
  });
});

describe("ArticleSaver.{{image}} template variable", () => {
  it("replaces {{image}} in default template with coverImage when present", async () => {
    const app = App.createMock();
    const imageUrl = "https://example.com/cover.jpg";
    const settings = createSettings({
      defaultTemplate: "{{image}}",
      includeFrontmatter: false,
    });
    const saver = new ArticleSaver(app, settings);

    const item = createItem({
      title: "Image Test",
      coverImage: imageUrl,
    });

    const file = await saver.saveArticle(item);
    expect(file).toBeInstanceOf(TFile);
    if (!file) return;
    const written = await app.vault.read(file);
    expect(written).toContain(imageUrl);
  });

  it("resolves {{image}} from itunes.image href when other images missing", async () => {
    const app = App.createMock();
    const settings = createSettings({
      defaultTemplate: "{{image}}",
      includeFrontmatter: false,
    });
    const saver = new ArticleSaver(app, settings);

    const itunesImageUrl = "https://example.com/itunes.jpg";
    const item = createItem({
      title: "Itunes Image Test",
      itunes: { image: { href: itunesImageUrl } },
    });

    const file = await saver.saveArticle(item);
    expect(file).toBeInstanceOf(TFile);
    if (!file) return;
    const written = await app.vault.read(file);
    expect(written).toContain(itunesImageUrl);
  });

  it("falls back to empty string when no image is present", async () => {
    const app = App.createMock();
    const settings = createSettings({
      defaultTemplate: "cover: {{image}}",
      includeFrontmatter: false,
    });
    const saver = new ArticleSaver(app, settings);

    const item = createItem({
      title: "No Image Test",
    });

    const file = await saver.saveArticle(item);
    expect(file).toBeInstanceOf(TFile);
    if (!file) return;
    const written = await app.vault.read(file);
    expect(written).toContain("cover: ");
  });

  it("prioritizes coverImage over image for {{image}} replacement", async () => {
    const app = App.createMock();
    const settings = createSettings({
      defaultTemplate: "{{image}}",
      includeFrontmatter: false,
    });
    const saver = new ArticleSaver(app, settings);

    const coverImageUrl = "https://example.com/cover.jpg";
    const item = createItem({
      title: "Priority Test",
      coverImage: coverImageUrl,
      image: "https://example.com/other.jpg",
    });

    const file = await saver.saveArticle(item);
    expect(file).toBeInstanceOf(TFile);
    if (!file) return;
    const written = await app.vault.read(file);
    expect(written).toContain(coverImageUrl);
  });
});
