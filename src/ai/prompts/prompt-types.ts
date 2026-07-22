import type { ContentBasis } from "../../collection/collected-item";

export type AiOperation =
  | "summary"
  | "translate-zh-cn"
  | "core-points"
  | "deep-analysis";

export interface AiPrompt {
  operation: AiOperation;
  system: string;
  user: string;
  contentBasis: ContentBasis;
  inputCharacterCount: number;
  inputTruncated: boolean;
}
