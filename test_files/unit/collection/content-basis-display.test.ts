import { describe, expect, it } from "vitest";
import { getContentBasisLabel } from "../../../src/collection/content-basis-display";

describe("content basis display", () => {
  it("localizes stable stored enum values without changing the values", () => {
    const stored = "full-text" as const;
    expect(getContentBasisLabel(stored)).toBe("已取得全文");
    expect(getContentBasisLabel(stored, "en")).toBe("Retrieved full text");
    expect(stored).toBe("full-text");
  });
});
