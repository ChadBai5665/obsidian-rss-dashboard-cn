import { getEventListeners } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  AI_PROMPT_ENVELOPE_RESERVE_CHARACTERS,
  MAX_AI_REQUEST_CHARACTERS,
  MAX_AI_SELECTED_CONTENT_CHARACTERS,
} from "../../../../src/ai/ai-types";
import type { CollectedItem } from "../../../../src/collection/collected-item";
import type { CachedItemContent } from "../../../../src/collection/content-repository";
import {
  AiContentSelector,
  type AiContentRepository,
  type AiFullTextFetcher,
} from "../../../../src/ai/content/ai-content-selector";
import { AI_CONTENT_OMISSION_MARKER } from "../../../../src/ai/content/content-size";

const ITEM_ID = "a".repeat(64);

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function item(overrides: Partial<CollectedItem> = {}): CollectedItem {
  return {
    schemaVersion: 1,
    id: ITEM_ID,
    sourceType: "rss",
    sourceId: "source-1",
    sourceName: "示例来源",
    sourceBucket: "研究",
    title: "示例标题",
    fetchedAt: "2026-07-23T00:00:00.000Z",
    firstSeenAt: "2026-07-23T00:00:00.000Z",
    lastSeenAt: "2026-07-23T00:00:00.000Z",
    url: "https://example.com/article",
    observationType: "new",
    topics: [],
    excerpt: "订阅源摘要",
    contentBasis: "feed",
    read: false,
    starred: false,
    saved: false,
    collectionStatus: "collected",
    ...overrides,
  };
}

function cached(text: string): CachedItemContent {
  return {
    schemaVersion: 1,
    itemId: ITEM_ID,
    sourceUrl: "https://example.com/article",
    fetchedAt: "2026-07-23T00:00:00.000Z",
    contentBasis: "full-text",
    text,
  };
}

function repository(
  result: CachedItemContent | null,
  order?: string[],
): AiContentRepository & { read: ReturnType<typeof vi.fn> } {
  return {
    read: vi.fn(async (itemId: string) => {
      order?.push(`repository:${itemId}`);
      return result;
    }),
  };
}

describe("AiContentSelector", () => {
  it("prefers cached full text, removes active HTML, and preserves source language", async () => {
    const contentRepository = repository(
      cached(
        "<style>.hidden { display: none }</style><p>第一段 English 123</p>" +
          "<script>stealSecret()</script><p>第二段</p>",
      ),
    );
    const fullTextFetcher = vi.fn();
    const selector = new AiContentSelector({ contentRepository, fullTextFetcher });

    const result = await selector.select({
      item: item(),
      maxInputCharacters: 1_000,
      fetchFullText: true,
    });

    expect(result).toEqual({
      itemId: ITEM_ID,
      title: "示例标题",
      sourceName: "示例来源",
      sourceUrl: "https://example.com/article",
      content: "第一段 English 123 第二段",
      basis: "full-text",
      characterCount: 19,
      truncated: false,
    });
    expect(contentRepository.read).toHaveBeenCalledWith(ITEM_ID);
    expect(fullTextFetcher).not.toHaveBeenCalled();
  });

  it("uses only the selected feed item's description when no full text exists", async () => {
    const contentRepository = repository(null);
    const selector = new AiContentSelector({ contentRepository });

    const result = await selector.select({
      item: item({ excerpt: "<p>当前条目</p><style>不应出现</style> 的摘要" }),
      maxInputCharacters: 1_000,
      fetchFullText: false,
    });

    expect(result.content).toBe("当前条目 的摘要");
    expect(result.basis).toBe("feed");
    expect(contentRepository.read).toHaveBeenCalledTimes(1);
    expect(contentRepository.read).toHaveBeenCalledWith(ITEM_ID);
  });

  it.each([
    "I <3 Obsidian",
    "x < y > z",
    "保留 <not-really-closed ordinary text",
  ])("preserves non-tag angle-bracket text: %s", async (excerpt) => {
    const selector = new AiContentSelector({ contentRepository: repository(null) });

    const result = await selector.select({
      item: item({ excerpt }),
      maxInputCharacters: 1_000,
      fetchFullText: false,
    });

    expect(result.content).toBe(excerpt);
  });

  it.each([
    "<script/>SECRET",
    "<style/>HIDDEN",
  ])("does not treat a raw-text opening slash as self-closing: %s", async (excerpt) => {
    const selector = new AiContentSelector({ contentRepository: repository(null) });

    const result = await selector.select({
      item: item({ excerpt: `可见${excerpt}` }),
      maxInputCharacters: 1_000,
      fetchFullText: false,
    });

    expect(result.content).toBe("可见");
    expect(result.content).not.toContain("SECRET");
    expect(result.content).not.toContain("HIDDEN");
  });

  it.each(["=oops", ".foo", "\\x", "!x"])(
    "does not close raw script text through an invalid tag-name delimiter %s",
    async (suffix) => {
      const selector = new AiContentSelector({ contentRepository: repository(null) });
      const result = await selector.select({
        item: item({
          excerpt: `可见<script>SECRET</script${suffix}>LEAK</script>安全尾部`,
        }),
        maxInputCharacters: 1_000,
        fetchFullText: false,
      });

      expect(result.content).toBe("可见 安全尾部");
      expect(result.content).not.toContain("SECRET");
      expect(result.content).not.toContain("LEAK");
    },
  );

  it.each(["=oops", ".foo", "\\x", "!x"])(
    "does not open raw script text through an invalid tag-name delimiter %s",
    async (suffix) => {
      const selector = new AiContentSelector({ contentRepository: repository(null) });
      const result = await selector.select({
        item: item({ excerpt: `可见<script${suffix}>应保留` }),
        maxInputCharacters: 1_000,
        fetchFullText: false,
      });

      expect(result.content).toBe("可见 应保留");
    },
  );

  it("matches raw-text close tags case-insensitively and only when complete", async () => {
    const selector = new AiContentSelector({ contentRepository: repository(null) });

    const mixedCase = await selector.select({
      item: item({ excerpt: "可见<ScRiPt>SECRET</sCrIpT>安全" }),
      maxInputCharacters: 1_000,
      fetchFullText: false,
    });
    expect(mixedCase.content).toBe("可见 安全");

    const incomplete = await selector.select({
      item: item({ excerpt: "可见<script>SECRET</script" }),
      maxInputCharacters: 1_000,
      fetchFullText: false,
    });
    expect(incomplete.content).toBe("可见");
  });

  it("uses the first complete raw-text close even after a nested opening", async () => {
    const selector = new AiContentSelector({ contentRepository: repository(null) });
    const result = await selector.select({
      item: item({
        excerpt: "可见<script>SECRET<script>INNER</script>安全尾部",
      }),
      maxInputCharacters: 1_000,
      fetchFullText: false,
    });

    expect(result.content).toBe("可见 安全尾部");
  });

  it("labels X text as x-post and never fetches the X page", async () => {
    const contentRepository = repository(null);
    const fullTextFetcher = vi.fn();
    const selector = new AiContentSelector({ contentRepository, fullTextFetcher });

    const result = await selector.select({
      item: item({
        sourceType: "x-account",
        contentBasis: "x-post",
        excerpt: "这是 X 帖子的原文",
        url: "https://x.com/example/status/1",
      }),
      maxInputCharacters: 1_000,
      fetchFullText: true,
    });

    expect(result.content).toBe("这是 X 帖子的原文");
    expect(result.basis).toBe("x-post");
    expect(fullTextFetcher).not.toHaveBeenCalled();
  });

  it("uses only a YouTube title and channel-provided description", async () => {
    const contentRepository = repository(cached("不应使用的缓存转录文本"));
    const fullTextFetcher = vi.fn();
    const selector = new AiContentSelector({ contentRepository, fullTextFetcher });

    const result = await selector.select({
      item: item({
        sourceType: "youtube",
        contentBasis: "title-description",
        title: "视频标题",
        excerpt: "频道提供的视频说明".repeat(30),
        url: "https://www.youtube.com/watch?v=video-id",
      }),
      maxInputCharacters: 120,
      fetchFullText: true,
    });

    expect(result.content.startsWith("视频标题 频道提供的视频说明")).toBe(true);
    expect(result.content).toContain(AI_CONTENT_OMISSION_MARKER);
    expect(result.basis).toBe("title-description");
    expect(result.truncated).toBe(true);
    expect(contentRepository.read).not.toHaveBeenCalled();
    expect(fullTextFetcher).not.toHaveBeenCalled();
  });

  it("makes a network request only for an explicit AI full-text action and only after the cache read", async () => {
    const order: string[] = [];
    const contentRepository = repository(null, order);
    const fullTextFetcher: AiFullTextFetcher = vi.fn(async (request) => {
      order.push(`network:${request.itemId}`);
      return {
        content: "<article><p>明确请求后取得的正文</p></article>",
        failureType: "none",
      };
    });
    const selector = new AiContentSelector({ contentRepository, fullTextFetcher });

    const withoutRequest = await selector.select({
      item: item(),
      maxInputCharacters: 1_000,
      fetchFullText: false,
    });

    expect(withoutRequest.basis).toBe("feed");
    expect(fullTextFetcher).not.toHaveBeenCalled();

    const withRequest = await selector.select({
      item: item(),
      maxInputCharacters: 1_000,
      fetchFullText: true,
    });

    expect(withRequest.content).toBe("明确请求后取得的正文");
    expect(withRequest.basis).toBe("full-text");
    expect(order).toEqual([
      `repository:${ITEM_ID}`,
      `repository:${ITEM_ID}`,
      `network:${ITEM_ID}`,
    ]);
    expect(fullTextFetcher).toHaveBeenCalledWith({
      itemId: ITEM_ID,
      url: "https://example.com/article",
      signal: undefined,
    });
  });

  it("never asks for unrelated vault files or another collected item", async () => {
    const requestedItemIds: string[] = [];
    const contentRepository: AiContentRepository = {
      read: async (itemId: string) => {
        requestedItemIds.push(itemId);
        return null;
      },
    };
    const selector = new AiContentSelector({ contentRepository });

    await selector.select({
      item: item(),
      maxInputCharacters: 1_000,
      fetchFullText: false,
    });

    expect(requestedItemIds).toEqual([ITEM_ID]);
  });

  it("bounds oversized source input before returning it to the model", async () => {
    const selector = new AiContentSelector({ contentRepository: repository(null) });

    const result = await selector.select({
      item: item({ excerpt: `<p>${"甲".repeat(2_500_000)}</p>` }),
      maxInputCharacters: 80,
      fetchFullText: false,
    });

    expect(result.characterCount).toBe(80);
    expect(result.content).toContain(AI_CONTENT_OMISSION_MARKER);
    expect(result.truncated).toBe(true);
  });

  it("reserves provider request capacity for the prompt envelope", async () => {
    const selector = new AiContentSelector({ contentRepository: repository(null) });

    const result = await selector.select({
      item: item({ excerpt: "甲".repeat(MAX_AI_REQUEST_CHARACTERS) }),
      maxInputCharacters: MAX_AI_REQUEST_CHARACTERS,
      fetchFullText: false,
    });

    expect(result.characterCount).toBe(MAX_AI_SELECTED_CONTENT_CHARACTERS);
    expect(result.content).toContain(AI_CONTENT_OMISSION_MARKER);
    expect(result.truncated).toBe(true);
    expect(MAX_AI_REQUEST_CHARACTERS - result.characterCount).toBeGreaterThanOrEqual(
      AI_PROMPT_ENVELOPE_RESERVE_CHARACTERS,
    );
  });

  it("retains the real visible beginning and end across a very large middle", async () => {
    const selector = new AiContentSelector({ contentRepository: repository(null) });
    const result = await selector.select({
      item: item({
        excerpt: `UNIQUE_HEAD ${"中".repeat(2_000_000)} UNIQUE_END`,
      }),
      maxInputCharacters: 200,
      fetchFullText: false,
    });

    expect(result.content.startsWith("UNIQUE_HEAD")).toBe(true);
    expect(result.content.endsWith("UNIQUE_END")).toBe(true);
    expect(result.content).toContain(AI_CONTENT_OMISSION_MARKER);
    expect(result.truncated).toBe(true);
    expect(result.content.indexOf("UNIQUE_HEAD")).toBeLessThan(
      result.content.indexOf(AI_CONTENT_OMISSION_MARKER),
    );
    expect(result.content.indexOf(AI_CONTENT_OMISSION_MARKER)).toBeLessThan(
      result.content.indexOf("UNIQUE_END"),
    );
    expect(result.characterCount).toBe(result.content.length);
  });

  it("normalizes a huge whitespace middle before deciding whether content was truncated", async () => {
    const selector = new AiContentSelector({ contentRepository: repository(null) });
    const result = await selector.select({
      item: item({ excerpt: `HEAD${" ".repeat(1_000_000)}TAIL` }),
      maxInputCharacters: 200,
      fetchFullText: false,
    });

    expect(result).toMatchObject({
      content: "HEAD TAIL",
      characterCount: 9,
      truncated: false,
    });
    expect(result.content).not.toContain(AI_CONTENT_OMISSION_MARKER);
  });

  it("normalizes decoded entities and Unicode whitespace before bounding", async () => {
    const selector = new AiContentSelector({ contentRepository: repository(null) });
    const whitespace = "&nbsp;\u3000&#32;".repeat(100_000);
    const result = await selector.select({
      item: item({ excerpt: `HEAD${whitespace}TAIL &amp; &#x1F642;` }),
      maxInputCharacters: 200,
      fetchFullText: false,
    });

    expect(result).toMatchObject({
      content: "HEAD TAIL & 🙂",
      characterCount: 14,
      truncated: false,
    });
    expect(result.content).not.toContain(AI_CONTENT_OMISSION_MARKER);
  });

  it("strips script content before bounding hostile oversized HTML", async () => {
    const selector = new AiContentSelector({ contentRepository: repository(null) });
    const oversized = `${"正文".repeat(300_000)}<script>${"SECRET".repeat(200_000)}</script>`;

    const result = await selector.select({
      item: item({ excerpt: oversized }),
      maxInputCharacters: 100,
      fetchFullText: false,
    });

    expect(result.content).toContain(AI_CONTENT_OMISSION_MARKER);
    expect(result.content).not.toContain("SECRET");
    expect(result.content.endsWith("正文正文")).toBe(true);
  });

  it("uses a bounded deterministic scan for repeated unclosed script and style tags", async () => {
    const selector = new AiContentSelector({ contentRepository: repository(null) });
    const hostile = `可见开头${"<script>secret".repeat(80_000)}${"<style>hidden".repeat(80_000)}`;
    const select = () => selector.select({
      item: item({ excerpt: hostile }),
      maxInputCharacters: 200,
      fetchFullText: false,
    });

    const first = await select();
    const second = await select();

    expect(second).toEqual(first);
    expect(first.content.startsWith("可见开头")).toBe(true);
    expect(first.content).not.toContain("secret");
    expect(first.content).not.toContain("hidden");
    expect(first.content).not.toContain(AI_CONTENT_OMISSION_MARKER);
    expect(first.truncated).toBe(false);
  });

  it.each([
    ["comment", `前文<!--${"注释".repeat(550_000)}-->尾文`],
    ["attribute", `前文<div data-hidden="${"属性".repeat(550_000)}">尾文</div>`],
  ])("does not report truncation for fully scanned non-visible HTML %s", async (_case, excerpt) => {
    const selector = new AiContentSelector({ contentRepository: repository(null) });

    const result = await selector.select({
      item: item({ excerpt }),
      maxInputCharacters: 200,
      fetchFullText: false,
    });

    expect(result).toMatchObject({
      content: "前文 尾文",
      characterCount: 5,
      truncated: false,
    });
    expect(result.content).not.toContain(AI_CONTENT_OMISSION_MARKER);
  });

  it("falls back to the feed item when cached or fetched HTML has no readable text", async () => {
    const cachedSelector = new AiContentSelector({
      contentRepository: repository(cached("<script>cachedSecret()</script>")),
    });

    const cachedFallback = await cachedSelector.select({
      item: item({ excerpt: "可读的订阅源摘要" }),
      maxInputCharacters: 1_000,
      fetchFullText: false,
    });
    expect(cachedFallback).toMatchObject({
      basis: "feed",
      content: "可读的订阅源摘要",
    });

    const fetchedSelector = new AiContentSelector({
      contentRepository: repository(null),
      fullTextFetcher: vi.fn(async () => ({
        content: "<style>fetched-secret { color: red }</style>",
        failureType: "none",
      })),
    });
    const fetchedFallback = await fetchedSelector.select({
      item: item({ excerpt: "仍应使用当前摘要" }),
      maxInputCharacters: 1_000,
      fetchFullText: true,
    });
    expect(fetchedFallback).toMatchObject({
      basis: "feed",
      content: "仍应使用当前摘要",
    });
  });

  it("rejects an invalid input limit before reading cache or making a network request", async () => {
    const contentRepository = repository(null);
    const fullTextFetcher = vi.fn();
    const selector = new AiContentSelector({ contentRepository, fullTextFetcher });

    await expect(
      selector.select({
        item: item(),
        maxInputCharacters: 1,
        fetchFullText: true,
      }),
    ).rejects.toThrow("AI input character limit");
    expect(contentRepository.read).not.toHaveBeenCalled();
    expect(fullTextFetcher).not.toHaveBeenCalled();
  });

  it("honors genuine cancellation without invoking a hostile signal accessor", async () => {
    const contentRepository = repository(null);
    const fullTextFetcher = vi.fn();
    const selector = new AiContentSelector({ contentRepository, fullTextFetcher });
    const controller = new AbortController();
    controller.abort();

    await expect(
      selector.select({
        item: item(),
        maxInputCharacters: 1_000,
        fetchFullText: true,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(contentRepository.read).not.toHaveBeenCalled();
    expect(fullTextFetcher).not.toHaveBeenCalled();

    let accessorInvoked = false;
    const hostileSignal = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostileSignal, "aborted", {
      get() {
        accessorInvoked = true;
        throw new Error("private signal accessor");
      },
    });
    await expect(
      selector.select({
        item: item(),
        maxInputCharacters: 1_000,
        fetchFullText: true,
        signal: hostileSignal as unknown as AbortSignal,
      }),
    ).rejects.toThrow("Invalid AI content selection request");
    expect(accessorInvoked).toBe(false);
  });

  it("does not continue with feed input when cancellation happens during full-text fetch", async () => {
    const controller = new AbortController();
    const selector = new AiContentSelector({
      contentRepository: repository(null),
      fullTextFetcher: vi.fn(async () => {
        controller.abort();
        throw new Error("transport stopped");
      }),
    });

    await expect(
      selector.select({
        item: item(),
        maxInputCharacters: 1_000,
        fetchFullText: true,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("does not use cached or feed input when cancellation happens during repository read", async () => {
    const controller = new AbortController();
    const contentRepository: AiContentRepository = {
      read: vi.fn(async () => {
        controller.abort();
        return cached("<p>取消后不应使用的缓存正文</p>");
      }),
    };
    const fullTextFetcher = vi.fn();
    const selector = new AiContentSelector({ contentRepository, fullTextFetcher });

    await expect(
      selector.select({
        item: item(),
        maxInputCharacters: 1_000,
        fetchFullText: true,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fullTextFetcher).not.toHaveBeenCalled();
  });

  it("aborts a never-settling repository read and absorbs its late rejection", async () => {
    const controller = new AbortController();
    const pendingRead = deferred<CachedItemContent | null>();
    const baselineListeners = getEventListeners(controller.signal, "abort").length;
    const selector = new AiContentSelector({
      contentRepository: { read: () => pendingRead.promise },
    });

    const pending = selector.select({
      item: item(),
      maxInputCharacters: 1_000,
      fetchFullText: false,
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(
        baselineListeners + 1,
      );
    });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(
      baselineListeners,
    );
    pendingRead.reject(new Error("late repository failure"));
    await Promise.resolve();
    await Promise.resolve();
  });

  it("aborts a never-settling full-text fetch, absorbs late completion, and cleans listeners", async () => {
    const controller = new AbortController();
    const pendingFetch = deferred<Awaited<ReturnType<AiFullTextFetcher>>>();
    const baselineListeners = getEventListeners(controller.signal, "abort").length;
    const selector = new AiContentSelector({
      contentRepository: repository(null),
      fullTextFetcher: () => pendingFetch.promise,
    });

    const pending = selector.select({
      item: item(),
      maxInputCharacters: 1_000,
      fetchFullText: true,
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(
        baselineListeners + 1,
      );
    });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(
      baselineListeners,
    );
    pendingFetch.resolve({ content: "<p>迟到正文</p>", failureType: "none" });
    await Promise.resolve();
  });

  it("removes trusted abort listeners after a normal selection", async () => {
    const controller = new AbortController();
    const baselineListeners = getEventListeners(controller.signal, "abort").length;
    const selector = new AiContentSelector({ contentRepository: repository(null) });

    await selector.select({
      item: item(),
      maxInputCharacters: 1_000,
      fetchFullText: false,
      signal: controller.signal,
    });

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(
      baselineListeners,
    );
  });

  it("does not invoke item or fetch-result accessors", async () => {
    let itemAccessorInvoked = false;
    const accessorItem = item() as unknown as Record<string, unknown>;
    Object.defineProperty(accessorItem, "title", {
      enumerable: true,
      get() {
        itemAccessorInvoked = true;
        throw new Error("private item accessor");
      },
    });
    const selector = new AiContentSelector({ contentRepository: repository(null) });

    await expect(
      selector.select({
        item: accessorItem as unknown as CollectedItem,
        maxInputCharacters: 1_000,
        fetchFullText: false,
      }),
    ).rejects.toThrow("Invalid selected item");
    expect(itemAccessorInvoked).toBe(false);

    let resultAccessorInvoked = false;
    const hostileResult: Record<string, unknown> = { failureType: "none" };
    Object.defineProperty(hostileResult, "content", {
      enumerable: true,
      get() {
        resultAccessorInvoked = true;
        throw new Error("private fetched accessor");
      },
    });
    const fetchSelector = new AiContentSelector({
      contentRepository: repository(null),
      fullTextFetcher: vi.fn(async () => hostileResult as never),
    });

    const fallback = await fetchSelector.select({
      item: item(),
      maxInputCharacters: 1_000,
      fetchFullText: true,
    });
    expect(fallback.basis).toBe("feed");
    expect(resultAccessorInvoked).toBe(false);
  });
});
