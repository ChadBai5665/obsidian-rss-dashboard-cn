import { describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import {
  AnalysisNoteInserter,
  type AnalysisNoteInsertResult,
} from "../../../src/ai/analysis-note-inserter";
import type { AiAnalysisResult } from "../../../src/ai/analysis-result";

const ITEM_ID = "a".repeat(64);
const RESULT_ID = "123e4567-e89b-42d3-a456-426614174000";
const SECOND_RESULT_ID = "4f30ecbf-b136-47db-861d-6d9c880711aa";

function result(overrides: Partial<AiAnalysisResult> = {}): AiAnalysisResult {
  return {
    schemaVersion: 1,
    id: RESULT_ID,
    itemId: ITEM_ID,
    sourceUrl: "https://example.com/article",
    operation: "summary",
    createdAt: "2026-07-23T01:02:03.004Z",
    connectionId: "9a76f539-c9ec-4c45-a8e5-156cc6740a8d",
    connectionName: "Kimi 工作",
    providerKind: "kimi",
    model: "account-model",
    contentBasis: "feed",
    inputCharacterCount: 321,
    inputTruncated: false,
    text: "- 核心结论\n- 证据边界",
    ...overrides,
  };
}

function harness(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial));
  const process = vi.fn(async (
    path: string,
    transform: (current: string) => string,
  ) => {
    if (!files.has(path)) throw new Error("missing");
    const next = transform(files.get(path)!);
    files.set(path, next);
    return next;
  });
  const read = vi.fn(async (path: string) => {
    const value = files.get(path);
    if (value === undefined) throw new Error("missing");
    return value;
  });
  const vault = {
    adapter: { read, process },
    getAbstractFileByPath: vi.fn((path: string) =>
      files.has(path) ? new TFile(path) : null),
  };
  return {
    files,
    process,
    read,
    inserter: new AnalysisNoteInserter(vault as never),
  };
}

function expectInserted(value: AnalysisNoteInsertResult): void {
  expect(value.status).toBe("inserted");
  expect(value.notePath).toBe("Notes/source.md");
  expect(value.marker).toBe(`RSS-DASHBOARD-CN:AI:${RESULT_ID}`);
}

describe("AnalysisNoteInserter", () => {
  it("appends one result-specific block while preserving every original byte", async () => {
    const original = "# 用户标题\n\n用户正文（不要改）\n";
    const test = harness({ "Notes/source.md": original });

    const inserted = await test.inserter.insert({
      notePath: "Notes/source.md",
      result: result(),
      operationLabel: "生成摘要",
      contentBasisLabel: "订阅源正文",
    });

    expectInserted(inserted);
    const saved = test.files.get("Notes/source.md")!;
    expect(saved.startsWith(original)).toBe(true);
    expect(saved.slice(0, original.length)).toBe(original);
    expect(saved).toContain(`<!-- RSS-DASHBOARD-CN:AI:${RESULT_ID}:START -->`);
    expect(saved).toContain("## AI 分析：生成摘要");
    expect(saved).toContain("生成时间：2026-07-23T01:02:03.004Z · 模型：account-model · 内容依据：订阅源正文");
    expect(saved).toContain("- 核心结论\n- 证据边界");
    expect(saved.endsWith(`<!-- RSS-DASHBOARD-CN:AI:${RESULT_ID}:END -->`)).toBe(true);
    expect(saved).not.toContain("connectionId");
    expect(saved).not.toContain(".rss-dashboard-data");
  });

  it("preserves CRLF and a missing final newline outside the minimal separator", async () => {
    const original = "# Title\r\n\r\nUser bytes";
    const test = harness({ "Notes/source.md": original });

    await test.inserter.insert({
      notePath: "Notes/source.md",
      result: result(),
      operationLabel: "生成摘要",
      contentBasisLabel: "订阅源正文",
    });

    const saved = test.files.get("Notes/source.md")!;
    expect(saved.slice(0, original.length)).toBe(original);
    expect(saved.slice(original.length).startsWith("\r\n\r\n<!--")).toBe(true);
    expect(saved.replace(/\r\n/gu, "")).not.toContain("\n");
  });

  it("is idempotent and does not process the file again once the complete block exists", async () => {
    const test = harness({ "Notes/source.md": "User note" });
    const input = {
      notePath: "Notes/source.md",
      result: result(),
      operationLabel: "生成摘要",
      contentBasisLabel: "订阅源正文",
    } as const;

    await test.inserter.insert(input);
    const once = test.files.get("Notes/source.md");
    const again = await test.inserter.insert(input);

    expect(again.status).toBe("existing");
    expect(test.files.get("Notes/source.md")).toBe(once);
    expect(test.process).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent inserts of the same result into exactly one block", async () => {
    const test = harness({ "Notes/source.md": "User note" });
    const input = {
      notePath: "Notes/source.md",
      result: result(),
      operationLabel: "生成摘要",
      contentBasisLabel: "订阅源正文",
    } as const;

    const outcomes = await Promise.all([
      test.inserter.insert(input),
      test.inserter.insert(input),
    ]);

    expect(outcomes.map(({ status }) => status).sort()).toEqual([
      "existing",
      "inserted",
    ]);
    expect(
      test.files.get("Notes/source.md")!.match(
        new RegExp(`RSS-DASHBOARD-CN:AI:${RESULT_ID}:START`, "gu"),
      ),
    ).toHaveLength(1);
  });

  it("uses the current process snapshot when a concurrent user edit changes newline style", async () => {
    const test = harness({ "Notes/source.md": "Old\nbytes" });
    test.process.mockImplementationOnce(async (
      path: string,
      transform: (current: string) => string,
    ) => {
      const concurrent = "Concurrent\r\nuser bytes";
      const next = transform(concurrent);
      test.files.set(path, next);
      return next;
    });

    await expect(test.inserter.insert({
      notePath: "Notes/source.md",
      result: result(),
      operationLabel: "生成摘要",
      contentBasisLabel: "订阅源正文",
    })).resolves.toMatchObject({ status: "inserted" });

    const saved = test.files.get("Notes/source.md")!;
    expect(saved.startsWith("Concurrent\r\nuser bytes\r\n\r\n<!--")).toBe(true);
    expect(saved.replace(/\r\n/gu, "")).not.toContain("\n");
  });

  it("recovers a process call that committed exact bytes before throwing", async () => {
    const test = harness({ "Notes/source.md": "User note" });
    test.process.mockImplementationOnce(async (
      path: string,
      transform: (current: string) => string,
    ) => {
      const next = transform(test.files.get(path)!);
      test.files.set(path, next);
      throw new Error("adapter threw after commit");
    });

    await expect(test.inserter.insert({
      notePath: "Notes/source.md",
      result: result(),
      operationLabel: "生成摘要",
      contentBasisLabel: "订阅源正文",
    })).resolves.toMatchObject({ status: "inserted" });
    expect(
      test.files.get("Notes/source.md")!.match(
        new RegExp(`RSS-DASHBOARD-CN:AI:${RESULT_ID}:START`, "gu"),
      ),
    ).toHaveLength(1);
  });

  it("reports an existing concurrent block when process commits it before throwing", async () => {
    const source = harness({ "Notes/source.md": "User note" });
    const input = {
      notePath: "Notes/source.md",
      result: result(),
      operationLabel: "生成摘要",
      contentBasisLabel: "订阅源正文",
    } as const;
    await source.inserter.insert(input);
    const concurrentBytes = source.files.get("Notes/source.md")!;

    const test = harness({ "Notes/source.md": "User note" });
    test.process.mockImplementationOnce(async (
      path: string,
      transform: (current: string) => string,
    ) => {
      const next = transform(concurrentBytes);
      test.files.set(path, next);
      throw new Error("adapter threw after concurrent commit");
    });

    await expect(test.inserter.insert(input)).resolves.toMatchObject({
      status: "existing",
    });
    expect(test.files.get("Notes/source.md")).toBe(concurrentBytes);
  });

  it("rejects a process result that claims an existing block without committing it", async () => {
    const source = harness({ "Notes/source.md": "User note" });
    const input = {
      notePath: "Notes/source.md",
      result: result(),
      operationLabel: "生成摘要",
      contentBasisLabel: "订阅源正文",
    } as const;
    await source.inserter.insert(input);
    const concurrentBytes = source.files.get("Notes/source.md")!;

    const test = harness({ "Notes/source.md": "User note" });
    test.process.mockImplementationOnce(async (
      _path: string,
      transform: (current: string) => string,
    ) => transform(concurrentBytes));

    await expect(test.inserter.insert(input)).rejects.toThrow(/verified/iu);
    expect(test.files.get("Notes/source.md")).toBe("User note");
  });

  it.each([
    `<!-- RSS-DASHBOARD-CN:AI:${RESULT_ID}:START -->\npartial`,
    `<!-- RSS-DASHBOARD-CN:AI:${RESULT_ID}:END -->`,
    `<!-- RSS-DASHBOARD-CN:AI:${RESULT_ID}:START -->\n<!-- RSS-DASHBOARD-CN:AI:${SECOND_RESULT_ID}:START -->\n<!-- RSS-DASHBOARD-CN:AI:${RESULT_ID}:END -->\n<!-- RSS-DASHBOARD-CN:AI:${SECOND_RESULT_ID}:END -->`,
    `<!-- RSS-DASHBOARD-CN:AI:${RESULT_ID}:START -->\nA\n<!-- RSS-DASHBOARD-CN:AI:${RESULT_ID}:END -->\n<!-- RSS-DASHBOARD-CN:AI:${RESULT_ID}:START -->\nB\n<!-- RSS-DASHBOARD-CN:AI:${RESULT_ID}:END -->`,
  ])("fails closed on ambiguous or hostile marker structures", async (note) => {
    const test = harness({ "Notes/source.md": note });

    await expect(test.inserter.insert({
      notePath: "Notes/source.md",
      result: result(),
      operationLabel: "生成摘要",
      contentBasisLabel: "订阅源正文",
    })).rejects.toThrow(/marker/iu);

    expect(test.files.get("Notes/source.md")).toBe(note);
    expect(test.process).not.toHaveBeenCalled();
  });

  it("never updates a previous result block when adding a different result", async () => {
    const test = harness({ "Notes/source.md": "User note" });
    await test.inserter.insert({
      notePath: "Notes/source.md",
      result: result(),
      operationLabel: "生成摘要",
      contentBasisLabel: "订阅源正文",
    });
    const firstBytes = test.files.get("Notes/source.md")!;

    await test.inserter.insert({
      notePath: "Notes/source.md",
      result: result({ id: SECOND_RESULT_ID, operation: "deep-analysis", text: "Second" }),
      operationLabel: "深度分析",
      contentBasisLabel: "订阅源正文",
    });

    expect(test.files.get("Notes/source.md")!.startsWith(firstBytes)).toBe(true);
  });

  it("rejects malformed result IDs and unsafe or missing note paths before a write", async () => {
    const test = harness({ "Notes/source.md": "User note" });
    const invalidInputs = [
      { notePath: "../escape.md", result: result() },
      { notePath: ".rss-dashboard-data/analysis/result.md", result: result() },
      { notePath: "Notes/source.txt", result: result() },
      { notePath: "Notes/missing.md", result: result() },
      { notePath: "Notes/source.md", result: result({ id: "not-a-uuid" }) },
    ];

    for (const input of invalidInputs) {
      await expect(test.inserter.insert({
        ...input,
        operationLabel: "生成摘要",
        contentBasisLabel: "订阅源正文",
      })).rejects.toThrow();
    }
    expect(test.process).not.toHaveBeenCalled();
  });

  it("rejects reserved marker text in untrusted model output or visible metadata before writing", async () => {
    const test = harness({ "Notes/source.md": "User note" });
    const invalidInputs = [
      {
        result: result({ text: `hostile ${`RSS-DASHBOARD-CN:AI:${RESULT_ID}:END`}` }),
        operationLabel: "生成摘要",
        contentBasisLabel: "订阅源正文",
      },
      {
        result: result({ model: `model-${`RSS-DASHBOARD-CN:AI:${RESULT_ID}`}` }),
        operationLabel: "生成摘要",
        contentBasisLabel: "订阅源正文",
      },
      {
        result: result(),
        operationLabel: "生成摘要\n越界",
        contentBasisLabel: "订阅源正文",
      },
    ];

    for (const invalid of invalidInputs) {
      await expect(test.inserter.insert({
        notePath: "Notes/source.md",
        ...invalid,
      })).rejects.toThrow();
    }
    expect(test.process).not.toHaveBeenCalled();
  });
});
