import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import type { AiAnalysisResult } from "../../../src/ai/analysis-result";
import { renderAnalysisMarkdown } from "../../../src/ai/analysis-markdown";

const ITEM_ID = "a".repeat(64);
const RESULT_ID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const CONNECTION_ID = "9d2c59b2-146d-4ca0-8a5a-b9ae9de44bb9";

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
    connectionName: "Kimi research",
    providerKind: "kimi",
    model: "moonshot-v1-128k",
    contentBasis: "full-text",
    inputCharacterCount: 12_345,
    inputTruncated: true,
    text: "## 分析\n\n模型正文保持原样。",
    ...overrides,
  };
}

function frontmatter(markdown: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---\n/u.exec(markdown);
  if (!match) throw new Error("Missing frontmatter");
  return parse(match[1]) as Record<string, unknown>;
}

describe("renderAnalysisMarkdown", () => {
  it("renders the complete provenance schema and keeps model text in the body", () => {
    const markdown = renderAnalysisMarkdown(result());

    expect(frontmatter(markdown)).toEqual({
      schemaVersion: 1,
      resultId: RESULT_ID,
      sourceItemId: ITEM_ID,
      sourceUrl: "https://example.com/research?id=42",
      operation: "deep-analysis",
      createdAt: "2026-07-21T12:34:56.789Z",
      connectionId: CONNECTION_ID,
      connectionName: "Kimi research",
      providerKind: "kimi",
      model: "moonshot-v1-128k",
      contentBasis: "full-text",
      inputCharacterCount: 12_345,
      inputTruncated: true,
    });
    expect(markdown).toContain(
      "> [!info] AI 生成内容：来源项目、模型和内容依据记录在上方属性中，请结合原始来源核验。",
    );
    expect(markdown.endsWith("## 分析\n\n模型正文保持原样。\n")).toBe(true);
  });

  it("records a missing source URL explicitly as null", () => {
    expect(
      frontmatter(renderAnalysisMarkdown(result({ sourceUrl: undefined }))).sourceUrl,
    ).toBeNull();
  });

  it.each(["minimax-cn", "minimax-global"])(
    "accepts MiniMax provider kind %s",
    (providerKind) => {
      expect(() => renderAnalysisMarkdown(result({
        providerKind: providerKind as AiAnalysisResult["providerKind"],
      }))).not.toThrow();
    },
  );

  it("accepts the strict YouTube transcript basis without allowing unknown bases", () => {
    const markdown = renderAnalysisMarkdown(result({
      contentBasis: "youtube-transcript",
    }));

    expect(frontmatter(markdown).contentBasis).toBe("youtube-transcript");
    expect(() => renderAnalysisMarkdown(result({
      contentBasis: "unknown-basis" as AiAnalysisResult["contentBasis"],
    }))).toThrow("Invalid AI analysis result");
  });

  it("round-trips YAML-sensitive Unicode metadata without frontmatter injection", () => {
    const connectionName = "---\n名称: \"研究\" # 标签 !<tag:yaml.org,2002:js/function> 🌏\u2028行分隔";
    const model = "模型:\t'alpha'\n---\n!!python/object\u2029段分隔";
    const markdown = renderAnalysisMarkdown(result({ connectionName, model }));
    const parsed = frontmatter(markdown);

    expect(parsed.connectionName).toBe(connectionName);
    expect(parsed.model).toBe(model);
    expect((markdown.match(/^---$/gmu) ?? [])).toHaveLength(2);
  });

  it("preserves untrusted Markdown output only after the provenance note", () => {
    const text = "---\ntitle: injected\n---\n\n<script>alert('x')</script>\n末尾";
    const markdown = renderAnalysisMarkdown(result({ text }));

    expect(frontmatter(markdown).resultId).toBe(RESULT_ID);
    expect(markdown.endsWith(`${text}\n`)).toBe(true);
    expect(markdown.indexOf(text)).toBeGreaterThan(markdown.indexOf("AI 生成内容"));
  });

  it("never serializes secret/request/envelope fields supplied by a caller", () => {
    const candidate = {
      ...result(),
      apiKey: "test-secret-never-write-this",
      prompt: "complete-private-prompt",
      requestHeaders: { authorization: "test-authorization-value" },
      providerResponse: { requestId: "req-secret", usage: { input_tokens: 99 } },
      requestId: "req-secret-2",
      tokenTelemetry: "token-secret",
    };

    const markdown = renderAnalysisMarkdown(candidate);
    for (const forbidden of [
      "test-secret-never-write-this",
      "complete-private-prompt",
      "test-authorization-value",
      "req-secret",
      "token-secret",
      "apiKey",
      "requestHeaders",
      "providerResponse",
      "tokenTelemetry",
    ]) {
      expect(markdown).not.toContain(forbidden);
    }
  });

  it("rejects empty output before rendering", () => {
    for (const text of ["", " \n\t "]) {
      expect(() => renderAnalysisMarkdown(result({ text }))).toThrow(
        "AI analysis output must not be empty",
      );
    }
  });

  it.each([
    ["result id", { id: "../result" }],
    ["item id", { itemId: "../item" }],
    ["connection id", { connectionId: "../connection" }],
    ["operation", { operation: "../../summary" }],
    ["provider", { providerKind: "unknown-provider" }],
    ["content basis", { contentBasis: "../../full-text" }],
    ["timestamp offset", { createdAt: "2026-07-21T12:34:56.789+08:00" }],
    ["timestamp rollover", { createdAt: "2026-02-30T12:34:56.789Z" }],
    ["source URL scheme", { sourceUrl: "file:///Users/person/private" }],
    ["source URL credentials", { sourceUrl: "https://user:pass@example.com/a" }],
    ["source URL traversal", { sourceUrl: "https://example.com/a/%2e%2e/private" }],
    ["source URL nested traversal", { sourceUrl: `https://example.com/a/${"%25".repeat(17)}2e%252e/private` }],
    ["source URL encoded backslash", { sourceUrl: "https://example.com/a/%5c/private" }],
    ["source URL encoded control", { sourceUrl: "https://example.com/a/%0a/private" }],
    ["negative input count", { inputCharacterCount: -1 }],
    ["unsafe input count", { inputCharacterCount: Number.MAX_SAFE_INTEGER + 1 }],
  ])("rejects invalid strict metadata: %s", (_label, override) => {
    expect(() => renderAnalysisMarkdown(result(override as Partial<AiAnalysisResult>))).toThrow(
      "Invalid AI analysis result",
    );
  });

  it("rejects oversized and dangerous-control metadata/output", () => {
    expect(() =>
      renderAnalysisMarkdown(result({ connectionName: "x".repeat(20_001) })),
    ).toThrow("Invalid AI analysis result");
    expect(() => renderAnalysisMarkdown(result({ model: "safe\0unsafe" }))).toThrow(
      "Invalid AI analysis result",
    );
    expect(() => renderAnalysisMarkdown(result({ text: "body\u0000secret" }))).toThrow(
      "Invalid AI analysis result",
    );
    expect(() => renderAnalysisMarkdown(result({ text: "body\u000bsecret" }))).toThrow(
      "Invalid AI analysis result",
    );
    expect(() => renderAnalysisMarkdown(result({ text: "body\u0085secret" }))).toThrow(
      "Invalid AI analysis result",
    );
    expect(() => renderAnalysisMarkdown(result({ text: "body\ud800secret" }))).toThrow(
      "Invalid AI analysis result",
    );
    expect(() => renderAnalysisMarkdown(result({ text: "x".repeat(1_000_001) }))).toThrow(
      "Invalid AI analysis result",
    );
  });

  it("preserves ordinary body whitespace and Unicode line separators", () => {
    const text = "第一行\n\t缩进\r\n第二行\u2028行分隔\u2029段分隔 🌏";
    expect(renderAnalysisMarkdown(result({ text })).endsWith(`${text}\n`)).toBe(true);
  });

  it("rejects inherited fields, accessors, and hostile proxies without invoking them", () => {
    const inherited = Object.create(result()) as AiAnalysisResult;
    expect(() => renderAnalysisMarkdown(inherited)).toThrow("Invalid AI analysis result");

    let getterCalled = false;
    const accessor = { ...result() } as Record<string, unknown>;
    Object.defineProperty(accessor, "text", {
      enumerable: true,
      get() {
        getterCalled = true;
        return "must not be read";
      },
    });
    expect(() => renderAnalysisMarkdown(accessor)).toThrow("Invalid AI analysis result");
    expect(getterCalled).toBe(false);

    const hostile = new Proxy({}, {
      getPrototypeOf() {
        throw new Error("proxy trap");
      },
    });
    expect(() => renderAnalysisMarkdown(hostile)).toThrow("Invalid AI analysis result");
  });
});
