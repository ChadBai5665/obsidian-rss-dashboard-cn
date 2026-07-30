import { describe, expect, it } from "vitest";
import {
  parseAnalysisMarkdown,
  type AiAnalysisHistoryRecord,
} from "../../../src/ai/analysis-markdown-parser";
import { renderAnalysisMarkdown } from "../../../src/ai/analysis-markdown";
import {
  AI_ANALYSIS_CONTENT_BASES,
  AI_ANALYSIS_OPERATIONS,
  AI_ANALYSIS_PROVIDER_KINDS,
  type AiAnalysisResult,
} from "../../../src/ai/analysis-result";

const DATA_ROOT = ".rss-dashboard-data";
const ANALYSIS_ROOT = `${DATA_ROOT}/analysis`;
const ITEM_ID = "a".repeat(64);
const RESULT_ID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const CONNECTION_ID = "9d2c59b2-146d-4ca0-8a5a-b9ae9de44bb9";
const PATH = `${ANALYSIS_ROOT}/${ITEM_ID}/20260721T123456789-deep-analysis.md`;

function result(
  overrides: Partial<AiAnalysisResult> = {},
): AiAnalysisResult {
  return {
    schemaVersion: 1,
    id: RESULT_ID,
    itemId: ITEM_ID,
    sourceUrl: "https://example.com/research?id=42",
    operation: "deep-analysis",
    createdAt: "2026-07-21T12:34:56.789Z",
    connectionId: CONNECTION_ID,
    connectionName: "研究连接 🌏",
    providerKind: "deepseek",
    model: "模型-v1",
    contentBasis: "youtube-transcript",
    inputCharacterCount: 12_345,
    inputTruncated: true,
    text: "第一行\n\n第二行\n\t缩进 🌏",
    ...overrides,
  };
}

function pathFor(value: AiAnalysisResult, suffix = ""): string {
  const timestamp = value.createdAt.replace(/[-:.Z]/gu, "");
  return `${ANALYSIS_ROOT}/${value.itemId}/${timestamp}-${value.operation}${suffix}.md`;
}

function parse(
  markdown: unknown,
  path: unknown = PATH,
  analysisRoot: unknown = ANALYSIS_ROOT,
) {
  return parseAnalysisMarkdown(markdown, path, analysisRoot);
}

describe("parseAnalysisMarkdown", () => {
  it("round-trips the repository-owned schema-v1 shape with Unicode and multiline text", () => {
    const expected = result();
    const artifact = parse(renderAnalysisMarkdown(expected));

    expect(artifact).toEqual({
      path: PATH,
      record: expected,
    });
    expect(Object.isFrozen(artifact)).toBe(true);
    expect(Object.isFrozen(artifact?.record)).toBe(true);
  });

  it("round-trips a missing source URL and every supported operation, provider, and basis", () => {
    for (const operation of AI_ANALYSIS_OPERATIONS) {
      const expected = result({ operation, sourceUrl: undefined });
      expect(parse(renderAnalysisMarkdown(expected), pathFor(expected))?.record)
        .toEqual(expected);
    }
    for (const providerKind of AI_ANALYSIS_PROVIDER_KINDS) {
      const expected = result({ providerKind });
      expect(parse(renderAnalysisMarkdown(expected), pathFor(expected))?.record)
        .toEqual(expected);
    }
    for (const contentBasis of AI_ANALYSIS_CONTENT_BASES) {
      const expected = result({ contentBasis });
      expect(parse(renderAnalysisMarkdown(expected), pathFor(expected))?.record)
        .toEqual(expected);
    }
  });

  it("treats delimiter-like provenance text in the final body as ordinary model output", () => {
    const expected = result({
      text:
        "开头\n---\n\n" +
        "> [!info] AI 生成内容：来源项目、模型和内容依据记录在上方属性中，请结合原始来源核验。\n" +
        "结尾",
    });

    expect(parse(renderAnalysisMarkdown(expected))?.record.text).toBe(expected.text);
  });

  it.each([
    "x",
    "x\n",
    "x\n\n",
    "第一行 🌏\n第二行\n",
  ])("round-trips the exact final text including trailing newlines", (text) => {
    const expected = result({ text });

    expect(parse(renderAnalysisMarkdown(expected))?.record.text).toBe(text);
  });

  it("renders distinct bytes for final text with and without a trailing newline", () => {
    const withoutTrailingNewline = renderAnalysisMarkdown(result({ text: "x" }));
    const withTrailingNewline = renderAnalysisMarkdown(result({ text: "x\n" }));

    expect(withTrailingNewline).not.toBe(withoutTrailingNewline);
  });

  it("reads old schema-v1 artifacts without connectionId and valid collision suffixes", () => {
    const expected = result();
    const legacy = renderAnalysisMarkdown(expected)
      .replace(`connectionId: "${CONNECTION_ID}"\n`, "");
    const second = parse(legacy, pathFor(expected, "-2"));
    const last = parse(legacy, pathFor(expected, "-10000"));

    const legacyRecord: AiAnalysisHistoryRecord = {
      ...expected,
      connectionId: undefined,
    };
    expect(second).toEqual({
      path: pathFor(expected, "-2"),
      record: legacyRecord,
    });
    expect(last?.record.connectionId).toBeUndefined();
  });

  it.each([
    ["duplicate key", (markdown: string) =>
      markdown.replace(`model: "模型-v1"`, `model: "模型-v1"\nmodel: "other"`)],
    ["unknown key", (markdown: string) =>
      markdown.replace(`model: "模型-v1"`, `unknown: "x"\nmodel: "模型-v1"`)],
    ["YAML alias", (markdown: string) =>
      markdown.replace(`connectionName: "研究连接 🌏"`, "connectionName: *alias")],
    ["YAML tag", (markdown: string) =>
      markdown.replace(`connectionName: "研究连接 🌏"`, "connectionName: !!str value")],
    ["malformed opening delimiter", (markdown: string) =>
      markdown.replace(/^---\n/u, "--\n")],
    ["malformed closing delimiter", (markdown: string) =>
      markdown.replace(/\n---\n\n/u, "\n----\n\n")],
    ["unsupported schema", (markdown: string) =>
      markdown.replace("schemaVersion: 1", "schemaVersion: 2")],
    ["noncanonical timestamp", (markdown: string) =>
      markdown.replace(
        `"2026-07-21T12:34:56.789Z"`,
        `"2026-07-21T20:34:56.789+08:00"`,
      )],
    ["invalid operation", (markdown: string) =>
      markdown.replace(`operation: "deep-analysis"`, `operation: "unknown"`)],
    ["invalid provider", (markdown: string) =>
      markdown.replace(`providerKind: "deepseek"`, `providerKind: "unknown"`)],
    ["invalid content basis", (markdown: string) =>
      markdown.replace(
        `contentBasis: "youtube-transcript"`,
        `contentBasis: "unknown"`,
      )],
    ["empty text", (markdown: string) =>
      markdown.slice(0, markdown.indexOf("第一行"))],
    ["oversized text", (markdown: string) =>
      markdown.slice(0, markdown.indexOf("第一行")) + "x".repeat(1_000_001) + "\n"],
  ])("rejects %s", (_label, mutate) => {
    expect(parse(mutate(renderAnalysisMarkdown(result())))).toBeNull();
  });

  it.each([
    ["mismatched item directory", `${ANALYSIS_ROOT}/${"b".repeat(64)}/20260721T123456789-deep-analysis.md`],
    ["mismatched timestamp", `${ANALYSIS_ROOT}/${ITEM_ID}/20260721T123456788-deep-analysis.md`],
    ["mismatched operation", `${ANALYSIS_ROOT}/${ITEM_ID}/20260721T123456789-summary.md`],
    ["collision one", pathFor(result(), "-1")],
    ["collision leading zero", pathFor(result(), "-02")],
    ["collision over limit", pathFor(result(), "-10001")],
    ["traversal", `${ANALYSIS_ROOT}/${ITEM_ID}/../${PATH.split("/").pop()}`],
    ["absolute", `/${PATH}`],
    ["Windows drive", `C:/${PATH}`],
    ["backslash", PATH.replace("/", "\\")],
    ["NUL", `${PATH}\0.md`],
    ["outside root", `other/analysis/${ITEM_ID}/${PATH.split("/").pop()}`],
    ["nested path", `${ANALYSIS_ROOT}/${ITEM_ID}/nested/${PATH.split("/").pop()}`],
  ])("rejects unsafe or mismatched path: %s", (_label, path) => {
    expect(parse(renderAnalysisMarkdown(result()), path)).toBeNull();
  });

  it("rejects unsafe parser inputs without invoking accessors or inherited values", () => {
    let getterCalled = false;
    const accessor = {};
    Object.defineProperty(accessor, "toString", {
      get() {
        getterCalled = true;
        return () => renderAnalysisMarkdown(result());
      },
    });
    const inherited = Object.create({
      markdown: renderAnalysisMarkdown(result()),
    });

    expect(parse(accessor)).toBeNull();
    expect(parse(inherited)).toBeNull();
    expect(parse(renderAnalysisMarkdown(result()), new String(PATH))).toBeNull();
    expect(getterCalled).toBe(false);
  });
});
