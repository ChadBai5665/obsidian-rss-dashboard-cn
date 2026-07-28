import {
  snapshotAiAnalysisResult,
  type AiAnalysisResult,
} from "./analysis-result";

export const ANALYSIS_MARKDOWN_PROVENANCE_NOTE =
  "> [!info] AI 生成内容：来源项目、模型和内容依据记录在上方属性中，请结合原始来源核验。";

/** Render a safe, deterministic YAML frontmatter projection plus unmodified model text. */
export function renderAnalysisMarkdown(value: unknown): string {
  const result = snapshotAiAnalysisResult(value);
  const lines = [
    "---",
    `schemaVersion: ${result.schemaVersion}`,
    `resultId: ${yamlString(result.id)}`,
    `sourceItemId: ${yamlString(result.itemId)}`,
    result.sourceUrl === undefined
      ? "sourceUrl: null"
      : `sourceUrl: ${yamlString(result.sourceUrl)}`,
    `operation: ${yamlString(result.operation)}`,
    `createdAt: ${yamlString(result.createdAt)}`,
    `connectionId: ${yamlString(result.connectionId)}`,
    `connectionName: ${yamlString(result.connectionName)}`,
    `providerKind: ${yamlString(result.providerKind)}`,
    `model: ${yamlString(result.model)}`,
    `contentBasis: ${yamlString(result.contentBasis)}`,
    `inputCharacterCount: ${result.inputCharacterCount}`,
    `inputTruncated: ${String(result.inputTruncated)}`,
    "---",
    "",
    ANALYSIS_MARKDOWN_PROVENANCE_NOTE,
    "",
  ];
  const prefix = lines.join("\n");
  return `${prefix}${result.text}${result.text.endsWith("\n") ? "" : "\n"}`;
}

/** JSON string literals are a reversible subset of YAML double-quoted scalars. */
function yamlString(value: string): string {
  return JSON.stringify(value);
}

export type { AiAnalysisResult };
