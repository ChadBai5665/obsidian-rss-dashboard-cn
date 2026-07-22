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

  it("removes URL fragments, quoted JSON key values, and repeated mixed-case headers", () => {
    const output = redactSensitiveText([
      'https://api.example.test/v1?safe=secret#token=fragment-secret',
      '{"X-API-Key":"quoted-secret", "token":"unicode-秘密"}',
      "X-Api-Key: first-secret; TOKEN=second-secret",
    ].join("\n"));

    for (const secret of ["secret", "fragment-secret", "quoted-secret", "unicode-秘密", "first-secret", "second-secret"]) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain("https://api.example.test/v1");
  });

  it("redacts protocol-relative and relative fragments plus access and refresh tokens", () => {
    const output = redactSensitiveText([
      "//api.example.test/path#access_token=protocol-secret",
      "../path#refresh_token=relative-secret",
      "access_token=standalone-secret; refresh_token: another-secret",
      '{"access_token":"json-secret","refresh_token":"json-refresh"}',
      "Authorization: Bearer first-bearer\nAuthorization: Bearer second-bearer",
    ].join("\n"));

    for (const secret of [
      "protocol-secret",
      "relative-secret",
      "standalone-secret",
      "another-secret",
      "json-secret",
      "json-refresh",
      "first-bearer",
      "second-bearer",
    ]) {
      expect(output).not.toContain(secret);
    }
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

  it("drops response-body fragments at the start or after a newline", () => {
    for (const raw of [
      "Body: body-secret",
      "Provider failed\nResponse body: body-secret",
    ]) {
      const result = sanitizeExternalError(new Error(raw));
      expect(result.message).not.toContain("body-secret");
      expect(result.message).not.toContain("Response body");
    }
  });

  it("does not invoke a malicious error message getter", () => {
    const result = sanitizeExternalError(Object.defineProperty({}, "message", {
      enumerable: true,
      get(): never {
        throw new Error("getter-secret");
      },
    }));

    expect(result).toEqual({
      code: "external-error",
      message: "External provider request failed.",
    });
  });

  it("does not invoke a proxy own-property trap while sanitizing an error", () => {
    const result = sanitizeExternalError(new Proxy({}, {
      getOwnPropertyDescriptor(): never {
        throw new Error("trap-secret");
      },
    }));

    expect(result).toEqual({
      code: "external-error",
      message: "External provider request failed.",
    });
  });
});
