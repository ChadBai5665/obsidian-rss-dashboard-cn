import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "obsidian";
import {
  AiOperationModal,
  openAiOperationModal,
} from "../../../src/modals/ai-operation-modal";
import { AiOperationError } from "../../../src/ai/ai-operation-service";
import { AnalysisArtifactVerificationError } from "../../../src/ai/analysis-repository";
import { createAiConnection } from "../../../src/ai/provider-presets";
import type { SelectedAiContent } from "../../../src/ai/content/ai-content-selector";
import type { CollectedItem } from "../../../src/collection/collected-item";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";

const ITEM_ID = "b".repeat(64);
const RESULT_ID = "123e4567-e89b-42d3-a456-426614174000";
const FIRST_ID = "9a76f539-c9ec-4c45-a8e5-156cc6740a8d";
const SECOND_ID = "b2e6a5d6-f3ad-4330-8781-4c621773e77d";

function item(overrides: Partial<CollectedItem> = {}): CollectedItem {
  return {
    schemaVersion: 1,
    id: ITEM_ID,
    sourceType: "rss",
    sourceId: "source-id",
    sourceName: "麦肯锡",
    sourceBucket: "咨询",
    title: "AI 行业观察",
    fetchedAt: "2026-07-23T00:00:00.000Z",
    firstSeenAt: "2026-07-23T00:00:00.000Z",
    lastSeenAt: "2026-07-23T00:00:00.000Z",
    url: "https://example.com/article",
    observationType: "new",
    topics: [],
    excerpt: "本地订阅摘要",
    contentBasis: "feed",
    read: false,
    starred: false,
    saved: false,
    collectionStatus: "collected",
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const result = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === label,
  );
  if (!(result instanceof HTMLButtonElement)) {
    throw new Error(`Missing button: ${label}`);
  }
  return result;
}

function harness(overrides: {
  item?: CollectedItem;
  connections?: ReturnType<typeof createAiConnection>[];
  select?: ReturnType<typeof vi.fn>;
  run?: ReturnType<typeof vi.fn>;
  runPrepared?: ReturnType<typeof vi.fn>;
  save?: ReturnType<typeof vi.fn>;
  getSavedNotePath?: () => string | undefined;
  saveArticleFirst?: ReturnType<typeof vi.fn>;
  insertIntoSavedNote?: ReturnType<typeof vi.fn>;
} = {}) {
  const defaultConnections = [
    createAiConnection({
      id: FIRST_ID,
      name: "Kimi 工作",
      providerKind: "kimi",
      model: "moonshot-account-model",
    }),
    createAiConnection({
      id: SECOND_ID,
      name: "Claude 研究",
      providerKind: "claude",
      model: "claude-account-model",
    }),
  ];
  defaultConnections[1].maxInputCharacters = 25_000;
  const connections = overrides.connections ?? defaultConnections;
  const select = overrides.select ?? vi.fn(async () => ({
    itemId: ITEM_ID,
    title: "AI 行业观察",
    sourceName: "麦肯锡",
    sourceUrl: "https://example.com/article",
    content: "本地订阅摘要",
    basis: "feed" as const,
    characterCount: 6,
    truncated: false,
  }));
  const run = overrides.run ?? vi.fn(async () => ({
    operation: "summary" as const,
    itemId: ITEM_ID,
    connectionId: FIRST_ID,
    connectionName: "Kimi 工作",
    providerKind: "kimi" as const,
    model: "moonshot-account-model",
    contentBasis: "feed" as const,
    inputCharacterCount: 6,
    inputTruncated: false,
    text: "摘要结果",
  }));
  const runPrepared = overrides.runPrepared ?? run;
  const save = overrides.save ?? vi.fn(async () =>
    `.rss-dashboard-data/analysis/${ITEM_ID}/20260723T010203004-summary.md`);
  const openAnalysis = vi.fn(async () => {});
  const insertIntoSavedNote = overrides.insertIntoSavedNote ?? vi.fn()
    .mockResolvedValueOnce({
      status: "inserted" as const,
      notePath: "Notes/source.md",
      marker: `RSS-DASHBOARD-CN:AI:${RESULT_ID}`,
    })
    .mockResolvedValue({
      status: "existing" as const,
      notePath: "Notes/source.md",
      marker: `RSS-DASHBOARD-CN:AI:${RESULT_ID}`,
    });
  const openSavedNote = vi.fn(async () => {});
  const saveArticleFirst = overrides.saveArticleFirst ?? vi.fn(async () => {});
  const modal = new AiOperationModal(new App(), {
    locale: "zh-CN",
    operation: "summary",
    item: overrides.item ?? item(),
    connections,
    defaultConnectionId: FIRST_ID,
    contentSelector: { select },
    operationService: { run, runPrepared },
    analysisRepository: { save },
    createResultId: () => RESULT_ID,
    now: () => new Date("2026-07-23T01:02:03.004Z"),
    openAnalysis,
    getSavedNotePath: overrides.getSavedNotePath ?? (() => "Notes/source.md"),
    insertIntoSavedNote,
    openSavedNote,
    saveArticleFirst,
  });
  modal.open();
  return {
    modal,
    select,
    run,
    runPrepared,
    save,
    openAnalysis,
    insertIntoSavedNote,
    openSavedNote,
    saveArticleFirst,
  };
}

beforeEach(() => {
  installObsidianDomPolyfills();
  document.body.empty();
  vi.restoreAllMocks();
});

describe("AiOperationModal", () => {
  it("sends the previewed feed snapshot even if cached full text appears before confirmation", async () => {
    let cacheAppeared = false;
    const select = vi.fn(async () => cacheAppeared
      ? {
          itemId: ITEM_ID,
          title: "AI 行业观察",
          sourceName: "麦肯锡",
          sourceUrl: "https://example.com/article",
          content: "后来出现的缓存全文",
          basis: "full-text" as const,
          characterCount: 9,
          truncated: false,
        }
      : {
          itemId: ITEM_ID,
          title: "AI 行业观察",
          sourceName: "麦肯锡",
          sourceUrl: "https://example.com/article",
          content: "本地订阅摘要",
          basis: "feed" as const,
          characterCount: 6,
          truncated: false,
        });
    const legacyRun = vi.fn(async () => ({
      operation: "summary" as const,
      itemId: ITEM_ID,
      connectionId: FIRST_ID,
      connectionName: "Kimi 工作",
      providerKind: "kimi" as const,
      model: "moonshot-account-model",
      contentBasis: "full-text" as const,
      inputCharacterCount: 9,
      inputTruncated: false,
      text: "错误地改用了缓存全文",
    }));
    const runPrepared = vi.fn(async () => ({
      operation: "summary" as const,
      itemId: ITEM_ID,
      connectionId: FIRST_ID,
      connectionName: "Kimi 工作",
      providerKind: "kimi" as const,
      model: "moonshot-account-model",
      contentBasis: "feed" as const,
      inputCharacterCount: 6,
      inputTruncated: false,
      text: "只使用预览摘要",
    }));
    const test = harness({ select, run: legacyRun, runPrepared });
    await vi.waitFor(() => expect(select).toHaveBeenCalledTimes(1));
    cacheAppeared = true;

    button(test.modal.contentEl, "确认发送").click();
    await vi.waitFor(() => expect(runPrepared).toHaveBeenCalledTimes(1));

    expect(legacyRun).not.toHaveBeenCalled();
    expect(select).toHaveBeenCalledTimes(1);
    expect(runPrepared).toHaveBeenCalledWith(expect.objectContaining({
      itemId: ITEM_ID,
      selectedContent: expect.objectContaining({
        content: "本地订阅摘要",
        basis: "feed",
      }),
    }));
  });

  it("refreshes and displays the real full-text preview before a second confirmation sends it once", async () => {
    const select = vi.fn(async ({ fetchFullText }: { fetchFullText: boolean }) =>
      fetchFullText
        ? {
            itemId: ITEM_ID,
            title: "AI 行业观察",
            sourceName: "麦肯锡",
            sourceUrl: "https://example.com/article",
            content: "获取后的网页全文内容",
            basis: "full-text" as const,
            characterCount: 10,
            truncated: true,
          }
        : {
            itemId: ITEM_ID,
            title: "AI 行业观察",
            sourceName: "麦肯锡",
            sourceUrl: "https://example.com/article",
            content: "本地订阅摘要",
            basis: "feed" as const,
            characterCount: 6,
            truncated: false,
          });
    const pending = deferred<never>();
    const legacyRun = vi.fn(() => pending.promise);
    const runPrepared = vi.fn(() => pending.promise);
    const test = harness({ select, run: legacyRun, runPrepared });
    await vi.waitFor(() => expect(select).toHaveBeenCalledTimes(1));
    test.modal.contentEl.querySelector<HTMLInputElement>(
      ".rss-dashboard-ai-full-text-toggle",
    )!.click();

    const confirm = button(test.modal.contentEl, "确认发送");
    confirm.click();
    confirm.click();
    await vi.waitFor(() => expect(select).toHaveBeenCalledTimes(2));

    expect(select).toHaveBeenLastCalledWith(expect.objectContaining({
      fetchFullText: true,
    }));
    expect(legacyRun).not.toHaveBeenCalled();
    expect(runPrepared).not.toHaveBeenCalled();
    expect(test.modal.contentEl.textContent).toContain("已取得全文");
    expect(test.modal.contentEl.textContent).toContain("约 10 个字符");
    expect(test.modal.contentEl.textContent).toContain("已按当前输入上限截断");
    expect(test.modal.contentEl.textContent).toContain("再次确认发送");

    button(test.modal.contentEl, "确认发送").click();
    button(test.modal.contentEl, "重试").click();
    expect(runPrepared).toHaveBeenCalledTimes(1);
    expect(runPrepared).toHaveBeenCalledWith(expect.objectContaining({
      selectedContent: expect.objectContaining({
        content: "获取后的网页全文内容",
        basis: "full-text",
        truncated: true,
      }),
    }));
  });

  it("creates no AI request or artifact when full-text preview preparation fails", async () => {
    const select = vi.fn()
      .mockResolvedValueOnce({
        itemId: ITEM_ID,
        title: "AI 行业观察",
        sourceName: "麦肯锡",
        sourceUrl: "https://example.com/article",
        content: "本地订阅摘要",
        basis: "feed" as const,
        characterCount: 6,
        truncated: false,
      })
      .mockRejectedValueOnce(new Error("publisher unavailable"));
    const runPrepared = vi.fn();
    const test = harness({ select, runPrepared });
    await vi.waitFor(() => expect(select).toHaveBeenCalledTimes(1));
    test.modal.contentEl.querySelector<HTMLInputElement>(
      ".rss-dashboard-ai-full-text-toggle",
    )!.click();

    button(test.modal.contentEl, "确认发送").click();

    await vi.waitFor(() => expect(test.modal.contentEl.textContent).toContain(
      "无法准备全文预览",
    ));
    expect(test.modal.contentEl.textContent).toContain("订阅源正文");
    expect(test.modal.contentEl.querySelector<HTMLInputElement>(
      ".rss-dashboard-ai-full-text-toggle",
    )?.checked).toBe(true);
    expect(button(test.modal.contentEl, "确认发送").disabled).toBe(false);
    expect(runPrepared).not.toHaveBeenCalled();
    expect(test.save).not.toHaveBeenCalled();
  });

  it("labels a full-text fetch fallback honestly and still requires a second confirmation", async () => {
    const select = vi.fn(async () => ({
      itemId: ITEM_ID,
      title: "AI 行业观察",
      sourceName: "麦肯锡",
      sourceUrl: "https://example.com/article",
      content: "仍然只有订阅摘要",
      basis: "feed" as const,
      characterCount: 8,
      truncated: false,
    }));
    const runPrepared = vi.fn(async () => ({
      operation: "summary" as const,
      itemId: ITEM_ID,
      connectionId: FIRST_ID,
      connectionName: "Kimi 工作",
      providerKind: "kimi" as const,
      model: "moonshot-account-model",
      contentBasis: "feed" as const,
      inputCharacterCount: 8,
      inputTruncated: false,
      text: "摘要结果",
    }));
    const test = harness({ select, runPrepared });
    await vi.waitFor(() => expect(select).toHaveBeenCalledTimes(1));
    test.modal.contentEl.querySelector<HTMLInputElement>(
      ".rss-dashboard-ai-full-text-toggle",
    )!.click();

    button(test.modal.contentEl, "确认发送").click();
    await vi.waitFor(() => expect(select).toHaveBeenCalledTimes(2));

    expect(test.modal.contentEl.textContent).toContain("未取得文章全文");
    expect(runPrepared).not.toHaveBeenCalled();
    button(test.modal.contentEl, "确认发送").click();
    await vi.waitFor(() => expect(runPrepared).toHaveBeenCalledTimes(1));
    expect(runPrepared).toHaveBeenCalledWith(expect.objectContaining({
      selectedContent: expect.objectContaining({ basis: "feed" }),
    }));
  });

  it("aborts a pending full-text preview on close without an AI request or artifact", async () => {
    const pendingFullText = deferred<SelectedAiContent>();
    const select = vi.fn()
      .mockResolvedValueOnce({
        itemId: ITEM_ID,
        title: "AI 行业观察",
        sourceName: "麦肯锡",
        sourceUrl: "https://example.com/article",
        content: "本地订阅摘要",
        basis: "feed" as const,
        characterCount: 6,
        truncated: false,
      })
      .mockImplementationOnce(() => pendingFullText.promise);
    const runPrepared = vi.fn();
    const test = harness({ select, runPrepared });
    await vi.waitFor(() => expect(select).toHaveBeenCalledTimes(1));
    test.modal.contentEl.querySelector<HTMLInputElement>(
      ".rss-dashboard-ai-full-text-toggle",
    )!.click();
    button(test.modal.contentEl, "确认发送").click();
    await vi.waitFor(() => expect(select).toHaveBeenCalledTimes(2));
    const signal = select.mock.calls[1][0].signal as AbortSignal;

    test.modal.close();
    pendingFullText.resolve({
      itemId: ITEM_ID,
      title: "AI 行业观察",
      sourceName: "麦肯锡",
      sourceUrl: "https://example.com/article",
      content: "晚到的网页全文",
      basis: "full-text",
      characterCount: 8,
      truncated: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(signal.aborted).toBe(true);
    expect(runPrepared).not.toHaveBeenCalled();
    expect(test.save).not.toHaveBeenCalled();
  });

  it("routes an empty enabled-connection set to localized settings guidance without touching AI dependencies", () => {
    const openSettings = vi.fn();
    const createModal = vi.fn();
    const showNotice = vi.fn();
    const returned = openAiOperationModal({
      connections: [],
      locale: "zh-CN",
      openSettings,
      createModal,
      showNotice,
    });

    expect(returned).toBeNull();
    expect(openSettings).toHaveBeenCalledTimes(1);
    expect(createModal).not.toHaveBeenCalled();
    expect(showNotice).toHaveBeenCalledWith(
      "请先在设置中启用一个 AI 连接，再使用此操作。",
    );
  });

  it("shows an honest local preview and performs no outbound operation before explicit confirmation", async () => {
    const test = harness();
    await vi.waitFor(() => expect(test.select).toHaveBeenCalledTimes(1));

    expect(test.modal.contentEl.textContent).toContain("AI 行业观察");
    expect(test.modal.contentEl.textContent).toContain("麦肯锡");
    expect(test.modal.contentEl.textContent).toContain("订阅源正文");
    expect(test.modal.contentEl.textContent).toContain("约 6 个字符");
    expect(test.modal.contentEl.textContent).toContain("未截断");
    expect(test.modal.contentEl.textContent).toContain("Kimi 工作");
    expect(test.modal.contentEl.textContent).toContain("moonshot-account-model");
    expect(test.modal.contentEl.querySelector<HTMLInputElement>(
      ".rss-dashboard-ai-full-text-toggle",
    )).not.toBeNull();
    expect(test.run).not.toHaveBeenCalled();
    expect(test.save).not.toHaveBeenCalled();
    expect(test.select).toHaveBeenNthCalledWith(1, expect.objectContaining({
      fetchFullText: false,
    }));

    const connection = test.modal.contentEl.querySelector<HTMLSelectElement>(
      ".rss-dashboard-ai-connection-select",
    )!;
    connection.value = SECOND_ID;
    connection.dispatchEvent(new Event("change"));
    expect(test.run).not.toHaveBeenCalled();
    expect(test.save).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(test.select).toHaveBeenCalledTimes(2));
    expect(test.select).toHaveBeenLastCalledWith(expect.objectContaining({
      fetchFullText: false,
      maxInputCharacters: 25_000,
    }));
    expect(test.modal.contentEl.textContent).toContain("Claude 研究");
    expect(test.modal.contentEl.textContent).toContain("claude-account-model");
    test.modal.contentEl.querySelector<HTMLInputElement>(
      ".rss-dashboard-ai-full-text-toggle",
    )!.click();
    expect(test.select).toHaveBeenCalledTimes(2);
    expect(test.run).not.toHaveBeenCalled();
  });

  it("shows the resolved blank-model default and accepts matching result provenance", async () => {
    const blankKimi = createAiConnection({
      id: FIRST_ID,
      name: "Kimi 工作",
      providerKind: "kimi",
      model: "",
    });
    const runPrepared = vi.fn(async () => ({
      operation: "summary" as const,
      itemId: ITEM_ID,
      connectionId: FIRST_ID,
      connectionName: "Kimi 工作",
      providerKind: "kimi" as const,
      model: "kimi-latest",
      contentBasis: "feed" as const,
      inputCharacterCount: 6,
      inputTruncated: false,
      text: "摘要结果",
    }));
    const test = harness({ connections: [blankKimi], runPrepared });
    await vi.waitFor(() => expect(test.select).toHaveBeenCalledTimes(1));

    expect(test.modal.contentEl.textContent).toContain("kimi-latest");
    button(test.modal.contentEl, "确认发送").click();
    await vi.waitFor(() => expect(test.save).toHaveBeenCalledTimes(1));
    expect(test.save).toHaveBeenCalledWith(expect.objectContaining({
      model: "kimi-latest",
    }));
  });

  it("shows the exact prompt-bounded character count and truncation used by the prepared request", async () => {
    const limited = createAiConnection({
      id: FIRST_ID,
      name: "Kimi 工作",
      providerKind: "kimi",
      model: "moonshot-account-model",
    });
    limited.maxInputCharacters = 15;
    const content = "abcdefghijklmnopqrstuvwxyz";
    const test = harness({
      connections: [limited],
      select: vi.fn(async () => ({
        itemId: ITEM_ID,
        title: "AI 行业观察",
        sourceName: "麦肯锡",
        sourceUrl: "https://example.com/article",
        content,
        basis: "feed" as const,
        characterCount: content.length,
        truncated: false,
      })),
    });
    await vi.waitFor(() => expect(test.select).toHaveBeenCalledTimes(1));

    expect(test.modal.contentEl.textContent).toContain("订阅源正文");
    expect(test.modal.contentEl.textContent).toContain("约 15 个字符");
    expect(test.modal.contentEl.textContent).toContain("已按当前输入上限截断");
  });

  it("does not offer a full-text toggle for YouTube title/description input", async () => {
    const test = harness({
      item: item({ sourceType: "youtube", contentBasis: "title-description" }),
      select: vi.fn(async () => ({
        itemId: ITEM_ID,
        title: "Video",
        sourceName: "YouTube",
        sourceUrl: "https://youtube.com/watch?v=abc",
        content: "Video description",
        basis: "title-description" as const,
        characterCount: 17,
        truncated: false,
      })),
    });
    await vi.waitFor(() => expect(test.select).toHaveBeenCalled());

    expect(test.modal.contentEl.querySelector(
      ".rss-dashboard-ai-full-text-toggle",
    )).toBeNull();
    expect(test.modal.contentEl.textContent).toContain("标题和摘要");
    button(test.modal.contentEl, "确认发送").click();
    await vi.waitFor(() => expect(test.runPrepared).toHaveBeenCalledTimes(1));
    expect(test.select).toHaveBeenCalledTimes(1);
    expect(test.runPrepared).toHaveBeenCalledWith(expect.objectContaining({
      selectedContent: expect.objectContaining({
        content: "Video description",
        basis: "title-description",
      }),
    }));
  });

  it("allows one confirm only and passes the explicit connection plus preview snapshot", async () => {
    const pending = deferred<never>();
    const run = vi.fn(() => pending.promise);
    const test = harness({ run });
    await vi.waitFor(() => expect(test.select).toHaveBeenCalled());
    const confirm = button(test.modal.contentEl, "确认发送");

    confirm.click();
    confirm.click();

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      operation: "summary",
      itemId: ITEM_ID,
      connectionId: FIRST_ID,
      selectedContent: expect.objectContaining({
        itemId: ITEM_ID,
        content: "本地订阅摘要",
        basis: "feed",
      }),
      signal: expect.any(AbortSignal),
    }));
    expect(confirm.disabled).toBe(true);
  });

  it("cancels locally, aborts the request, and discards a late non-cancellable success", async () => {
    const pending = deferred<{
      operation: "summary";
      itemId: string;
      connectionId: string;
      connectionName: string;
      providerKind: "kimi";
      model: string;
      contentBasis: "feed";
      inputCharacterCount: number;
      inputTruncated: boolean;
      text: string;
    }>();
    const run = vi.fn(() => pending.promise);
    const test = harness({ run });
    await vi.waitFor(() => expect(test.select).toHaveBeenCalled());
    button(test.modal.contentEl, "确认发送").click();
    const signal = run.mock.calls[0][0].signal as AbortSignal;

    button(test.modal.contentEl, "取消生成").click();
    expect(signal.aborted).toBe(true);
    pending.resolve({
      operation: "summary",
      itemId: ITEM_ID,
      connectionId: FIRST_ID,
      connectionName: "Kimi 工作",
      providerKind: "kimi",
      model: "moonshot-account-model",
      contentBasis: "feed",
      inputCharacterCount: 6,
      inputTruncated: false,
      text: "late success",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(test.save).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("late success");
  });

  it("does not write an artifact for a missing key and keeps retry as a fresh explicit action", async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new AiOperationError("missing-key"))
      .mockRejectedValueOnce(new AiOperationError("missing-key"));
    const test = harness({ run });
    await vi.waitFor(() => expect(test.select).toHaveBeenCalled());

    button(test.modal.contentEl, "确认发送").click();
    await vi.waitFor(() => expect(test.modal.contentEl.textContent).toContain("尚未配置 API 密钥"));
    expect(test.save).not.toHaveBeenCalled();

    button(test.modal.contentEl, "重试").click();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(run.mock.calls[1][0].connectionId).toBe(FIRST_ID);
    expect(test.save).not.toHaveBeenCalled();
  });

  it("saves a strict result once, then exposes explicit open and note-insert actions", async () => {
    const test = harness();
    await vi.waitFor(() => expect(test.select).toHaveBeenCalled());
    button(test.modal.contentEl, "确认发送").click();
    await vi.waitFor(() => expect(test.save).toHaveBeenCalledTimes(1));

    expect(test.save).toHaveBeenCalledWith({
      schemaVersion: 1,
      id: RESULT_ID,
      itemId: ITEM_ID,
      sourceUrl: "https://example.com/article",
      operation: "summary",
      createdAt: "2026-07-23T01:02:03.004Z",
      connectionId: FIRST_ID,
      connectionName: "Kimi 工作",
      providerKind: "kimi",
      model: "moonshot-account-model",
      contentBasis: "feed",
      inputCharacterCount: 6,
      inputTruncated: false,
      text: "摘要结果",
    });
    expect(test.modal.contentEl.textContent).toContain(
      `.rss-dashboard-data/analysis/${ITEM_ID}/20260723T010203004-summary.md`,
    );

    button(test.modal.contentEl, "打开分析文档").click();
    button(test.modal.contentEl, "插入已保存原文").click();
    await vi.waitFor(() => expect(test.openAnalysis).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(test.insertIntoSavedNote).toHaveBeenCalledTimes(1));
    expect(test.insertIntoSavedNote).toHaveBeenCalledWith(
      expect.objectContaining({ id: RESULT_ID }),
      `.rss-dashboard-data/analysis/${ITEM_ID}/20260723T010203004-summary.md`,
      "Notes/source.md",
    );

    button(test.modal.contentEl, "插入已保存原文").click();
    await vi.waitFor(() => expect(test.insertIntoSavedNote).toHaveBeenCalledTimes(2));
    expect(test.modal.contentEl.textContent).toContain("已存在，未重复写入");
    expect(test.openSavedNote).toHaveBeenCalledWith(
      "Notes/source.md",
      `RSS-DASHBOARD-CN:AI:${RESULT_ID}`,
    );
  });

  it("shows a localized error and performs no note insertion when the saved artifact no longer verifies", async () => {
    const insertIntoSavedNote = vi.fn(async () => {
      throw new AnalysisArtifactVerificationError();
    });
    const test = harness({ insertIntoSavedNote });
    await vi.waitFor(() => expect(test.select).toHaveBeenCalled());
    button(test.modal.contentEl, "确认发送").click();
    await vi.waitFor(() => expect(test.save).toHaveBeenCalledTimes(1));

    button(test.modal.contentEl, "插入已保存原文").click();

    await vi.waitFor(() => expect(test.modal.contentEl.textContent).toContain(
      "分析文档已缺失或发生变化",
    ));
    expect(insertIntoSavedNote).toHaveBeenCalledTimes(1);
    expect(test.openSavedNote).not.toHaveBeenCalled();
  });

  it("rejects operation results whose item, operation, or connection provenance differs from the confirmed request", async () => {
    const maliciousResults = [
      { itemId: "c".repeat(64) },
      { operation: "deep-analysis" as const },
      { connectionId: SECOND_ID },
      { contentBasis: "full-text" as const },
      { inputCharacterCount: 7 },
      { inputTruncated: true },
    ];
    for (const malicious of maliciousResults) {
      const run = vi.fn(async () => ({
        operation: "summary" as const,
        itemId: ITEM_ID,
        connectionId: FIRST_ID,
        connectionName: "Kimi 工作",
        providerKind: "kimi" as const,
        model: "moonshot-account-model",
        contentBasis: "feed" as const,
        inputCharacterCount: 6,
        inputTruncated: false,
        text: "摘要结果",
        ...malicious,
      }));
      const test = harness({ run });
      await vi.waitFor(() => expect(test.select).toHaveBeenCalled());
      button(test.modal.contentEl, "确认发送").click();
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(test.save).not.toHaveBeenCalled();
      expect(test.modal.contentEl.textContent).toContain("没有创建分析文档");
      test.modal.close();
    }
  });

  it("offers the normal article-save action before insertion when no saved note exists", async () => {
    let savedPath: string | undefined;
    const saveArticleFirst = vi.fn(async () => { savedPath = "Notes/new.md"; });
    const test = harness({
      getSavedNotePath: () => savedPath,
      saveArticleFirst,
    });
    await vi.waitFor(() => expect(test.select).toHaveBeenCalled());
    button(test.modal.contentEl, "确认发送").click();
    await vi.waitFor(() => expect(test.save).toHaveBeenCalled());

    expect(test.modal.contentEl.textContent).toContain("需要先保存原文笔记");
    expect(test.modal.contentEl.querySelector("button")?.textContent).not.toBe("插入已保存原文");
    button(test.modal.contentEl, "先保存原文").click();
    await vi.waitFor(() => expect(saveArticleFirst).toHaveBeenCalledTimes(1));
    expect(test.insertIntoSavedNote).not.toHaveBeenCalled();
    expect(test.modal.contentEl.textContent).toContain("插入已保存原文");
  });

  it("aborts and suppresses stale completion when the modal closes", async () => {
    const pending = deferred<never>();
    const run = vi.fn(() => pending.promise);
    const test = harness({ run });
    await vi.waitFor(() => expect(test.select).toHaveBeenCalled());
    button(test.modal.contentEl, "确认发送").click();
    const signal = run.mock.calls[0][0].signal as AbortSignal;

    test.modal.close();

    expect(signal.aborted).toBe(true);
    expect(test.save).not.toHaveBeenCalled();
    expect(test.modal.contentEl.textContent).toBe("");
  });

  it("defers close once artifact saving starts so it never reports cancellation while a write is committing", async () => {
    const pendingSave = deferred<string>();
    const save = vi.fn(() => pendingSave.promise);
    const test = harness({ save });
    await vi.waitFor(() => expect(test.select).toHaveBeenCalled());
    button(test.modal.contentEl, "确认发送").click();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(test.modal.contentEl.textContent).toContain("正在把分析保存为单独的 Markdown 文档");

    test.modal.close();
    expect(test.modal.containerEl.isConnected).toBe(true);
    expect(test.modal.contentEl.textContent).not.toContain("已取消");

    pendingSave.resolve(
      `.rss-dashboard-data/analysis/${ITEM_ID}/20260723T010203004-summary.md`,
    );
    await vi.waitFor(() => expect(test.modal.containerEl.isConnected).toBe(false));
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("finishes closing after a deferred artifact save rejects", async () => {
    const pendingSave = deferred<string>();
    const test = harness({ save: vi.fn(() => pendingSave.promise) });
    await vi.waitFor(() => expect(test.select).toHaveBeenCalled());
    button(test.modal.contentEl, "确认发送").click();
    await vi.waitFor(() => expect(test.save).toHaveBeenCalledTimes(1));

    test.modal.close();
    pendingSave.reject(new Error("write failed"));

    await vi.waitFor(() => expect(test.modal.containerEl.isConnected).toBe(false));
  });

  it("keeps the modal attached while an explicit note insertion is committing", async () => {
    const pendingInsert = deferred<{
      status: "inserted";
      notePath: string;
      marker: string;
    }>();
    const test = harness();
    test.insertIntoSavedNote.mockReset();
    test.insertIntoSavedNote.mockReturnValueOnce(pendingInsert.promise);
    await vi.waitFor(() => expect(test.select).toHaveBeenCalled());
    button(test.modal.contentEl, "确认发送").click();
    await vi.waitFor(() => expect(test.save).toHaveBeenCalled());
    button(test.modal.contentEl, "插入已保存原文").click();
    await vi.waitFor(() => expect(test.insertIntoSavedNote).toHaveBeenCalledTimes(1));

    test.modal.close();
    expect(test.modal.containerEl.isConnected).toBe(true);
    pendingInsert.resolve({
      status: "inserted",
      notePath: "Notes/source.md",
      marker: `RSS-DASHBOARD-CN:AI:${RESULT_ID}`,
    });

    await vi.waitFor(() => expect(test.modal.containerEl.isConnected).toBe(false));
  });
});
