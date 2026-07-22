import { describe, expect, it } from "vitest";
import {
  AI_CONTENT_OMISSION_MARKER,
  limitAiContent,
} from "../../../../src/ai/content/content-size";

describe("limitAiContent", () => {
  it("returns complete content and its actual character count below the limit", () => {
    expect(limitAiContent("保留原文 language 123", 80)).toEqual({
      content: "保留原文 language 123",
      characterCount: 17,
      truncated: false,
    });
  });

  it("keeps both ends and inserts the explicit omission marker at the limit", () => {
    const result = limitAiContent("abcdefghijklmnopqrstuvwxyz", 25);

    expect(result).toEqual({
      content: `abcdef${AI_CONTENT_OMISSION_MARKER}uvwxyz`,
      characterCount: 25,
      truncated: true,
    });
  });

  it("does not split a UTF-16 surrogate pair while retaining both ends", () => {
    const result = limitAiContent(`开始😀${"中".repeat(30)}🌏结尾`, 24);

    expect(result.content).toContain(AI_CONTENT_OMISSION_MARKER);
    expect(result.content).not.toContain("\uD83D\uD83C");
    expect(() => encodeURIComponent(result.content)).not.toThrow();
    expect(result.characterCount).toBe(result.content.length);
    expect(result.characterCount).toBeLessThanOrEqual(24);
  });

  it("rejects unsafe or impossible input limits", () => {
    const minimum = AI_CONTENT_OMISSION_MARKER.length + 2;

    expect(() => limitAiContent("long enough", minimum - 1)).toThrow(
      "AI input character limit",
    );
    expect(() => limitAiContent("long enough", Number.MAX_SAFE_INTEGER + 1)).toThrow(
      "AI input character limit",
    );
  });
});
