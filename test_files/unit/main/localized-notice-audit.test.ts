import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("main plugin notice localization audit", () => {
  it("routes every plugin-owned Notice through the typed notice helper", () => {
    const source = readFileSync("main.ts", "utf8");
    const directNotices = source
      .split("\n")
      .map((line, index) => ({ line: index + 1, text: line.trim() }))
      .filter(
        ({ text }) =>
          text.includes("new Notice(") &&
          !text.includes("return new Notice(this.t(key, params), duration)"),
      );

    expect(directNotices).toEqual([]);
    expect(source).toContain("private notify(");
  });

  it("does not expose caught exception text through localized notice parameters", () => {
    const source = readFileSync("main.ts", "utf8");
    expect(source).not.toMatch(/(?:notify|new Notice)[\s\S]{0,120}(?:error\.message|String\(error\))/);
  });
});
