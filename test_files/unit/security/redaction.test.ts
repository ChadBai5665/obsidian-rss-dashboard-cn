import { describe, expect, it } from "vitest";
import {
  redactSensitiveText,
  sanitizeExternalError,
} from "../../../src/security/redaction";

describe("redactSensitiveText", () => {
  it("redacts authorization and API-key header values", () => {
    const output = redactSensitiveText(
      "Authorization: Bearer bearer-secret; x-api-key: header-secret; api_key=another-secret; token=token-secret",
    );

    for (const secret of ["bearer-secret", "header-secret", "another-secret", "token-secret"]) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain("[redacted]");
  });

  it("removes every query value without removing the safe URL path", () => {
    const output = redactSensitiveText(
      "Request https://api.example.test/v1/items?api_key=query-secret&token=token-secret&safe=still-secret failed",
    );

    expect(output).toContain("https://api.example.test/v1/items");
    expect(output).not.toContain("query-secret");
    expect(output).not.toContain("token-secret");
    expect(output).not.toContain("still-secret");
  });
});

describe("sanitizeExternalError", () => {
  it("keeps a stable status code and safe provider message without response bodies", () => {
    const result = sanitizeExternalError({
      status: 429,
      message: "TikHub rejected the request: https://api.example.test/v1?api_key=secret body: {token: leaked}",
      body: "response body with another-secret",
    });

    expect(result.code).toBe("external-429");
    expect(result.message).toContain("TikHub rejected the request");
    expect(result.message).not.toContain("secret");
    expect(result.message).not.toContain("another-secret");
    expect(result.message).not.toContain("body:");
  });

  it("caps public messages at 300 characters and does not leak a thrown response body", () => {
    const result = sanitizeExternalError(
      Object.assign(new Error(`Authorization: Bearer ${"a".repeat(500)}`), {
        response: { data: "response-secret" },
      }),
    );

    expect(result.message.length).toBeLessThanOrEqual(300);
    expect(result.message).not.toContain("response-secret");
    expect(result.message).not.toContain("a".repeat(30));
  });
});
