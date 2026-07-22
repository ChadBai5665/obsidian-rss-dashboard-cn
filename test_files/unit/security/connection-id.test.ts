import { describe, expect, it } from "vitest";

import {
  isCanonicalConnectionId,
  normalizeConnectionId,
  requireConnectionId,
} from "../../../src/security/connection-id";

describe("shared external-secret connection IDs", () => {
  it("accepts case-insensitive UUID input and returns canonical lowercase", () => {
    const uppercase = "D4EB3F58-B672-4F73-B9F3-9CD2F0E57A8D";
    const lowercase = uppercase.toLowerCase();
    expect(normalizeConnectionId(uppercase)).toBe(lowercase);
    expect(requireConnectionId(uppercase)).toBe(lowercase);
    expect(isCanonicalConnectionId(uppercase)).toBe(false);
    expect(isCanonicalConnectionId(lowercase)).toBe(true);
  });

  it.each(["not-a-uuid", "d4eb3f58b6724f73b9f39cd2f0e57a8d", "", null])(
    "rejects invalid connection ID %j",
    (value) => {
      expect(normalizeConnectionId(value)).toBeUndefined();
    },
  );
});
