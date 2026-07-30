import { describe, expect, it } from "vitest";
import {
  VerificationController,
} from "../../../../src/services/source-verification/verification-state.js";

type VerifiedSource = {
  readonly title: string;
  readonly url: string;
};

describe("source verification state", () => {
  it("rejects a completion invalidated before it returns", () => {
    const state = new VerificationController<VerifiedSource>();
    const verifiedA = { title: "A", url: "https://a.example/feed" };

    const first = state.begin("https://a.example/feed");
    state.invalidate();

    expect(state.succeed(first, verifiedA)).toBe(false);
    expect(state.snapshot()).toEqual({ status: "idle" });

    const second = state.begin("https://b.example/feed");
    expect(state.fail(second, "feed-not-found")).toBe(true);
    expect(state.canSubscribe()).toBe(false);
  });

  it("creates a fresh token for every click, including duplicate input", () => {
    const state = new VerificationController<VerifiedSource>();

    const first = state.begin("https://a.example/feed");
    const second = state.begin("https://a.example/feed");
    expect(second).not.toBe(first);

    expect(state.succeed(first, { title: "A", url: "https://a.example/feed" })).toBe(false);
    expect(state.succeed(second, { title: "A", url: "https://a.example/feed" })).toBe(true);
    expect(state.snapshot()).toEqual({
      status: "success",
      value: { title: "A", url: "https://a.example/feed" },
    });
  });

  it("permits subscription only after success or current empty-feed warning acceptance", () => {
    const state = new VerificationController<VerifiedSource>();

    const success = state.begin("https://a.example/feed");
    state.succeed(success, { title: "A", url: "https://a.example/feed" });
    expect(state.canSubscribe()).toBe(true);

    const emptyFeed = state.begin("https://empty.example/feed");
    state.warn(emptyFeed, { title: "Empty", url: "https://empty.example/feed" }, "empty-feed");
    expect(state.snapshot()).toEqual({
      status: "warning",
      value: { title: "Empty", url: "https://empty.example/feed" },
      code: "empty-feed",
      accepted: false,
    });
    expect(state.canSubscribe()).toBe(false);
    expect(state.acceptWarning(emptyFeed)).toBe(true);
    expect(state.canSubscribe()).toBe(true);

    const otherWarning = state.begin("https://choice.example");
    state.warn(otherWarning, { title: "Choice", url: "https://choice.example" }, "feed-selection-required");
    expect(state.canSubscribe()).toBe(false);
  });

  it("rejects stale or non-empty-feed warning acceptance", () => {
    const state = new VerificationController<VerifiedSource>();
    const first = state.begin("https://empty.example/feed");
    state.warn(first, { title: "Empty", url: "https://empty.example/feed" }, "empty-feed");

    const second = state.begin("https://choice.example");
    expect(state.acceptWarning(first)).toBe(false);
    state.warn(second, { title: "Choice", url: "https://choice.example" }, "feed-selection-required");
    expect(state.acceptWarning(second)).toBe(false);
    expect(state.canSubscribe()).toBe(false);
  });

  it("rejects unsafe runtime codes without putting them into state", () => {
    const state = new VerificationController<VerifiedSource>();
    const warning = state.begin("https://a.example/feed");
    const value = { title: "A", url: "https://a.example/feed" };

    expect(state.warn(warning, value, "secret=value" as never)).toBe(false);
    expect(state.snapshot()).toEqual({ status: "checking" });

    expect(state.fail(warning, "secret=value" as never)).toBe(false);
    expect(state.snapshot()).toEqual({ status: "checking" });
  });

  it.each([
    "network-failure",
    "malformed-response",
    "profile-shape-unsupported",
  ] as const)("retains the safe TikHub diagnostic code %s", (code) => {
    const state = new VerificationController<VerifiedSource>();
    const token = state.begin("openai");

    expect(state.fail(token, code)).toBe(true);
    expect(state.snapshot()).toEqual({ status: "failure", code });
  });

  it("retains only valid X profile shape issues in a frozen current failure", () => {
    const state = new VerificationController<VerifiedSource>();
    const first = state.begin("openai");

    expect(state.fail(first, "profile-shape-unsupported", "identity-conflict")).toBe(true);
    expect(state.snapshot()).toEqual({
      status: "failure",
      code: "profile-shape-unsupported",
      detail: "identity-conflict",
    });
    expect(Object.isFrozen(state.snapshot())).toBe(true);
    expect(state.canSubscribe()).toBe(false);

    const second = state.begin("openai");
    expect(state.fail(first, "profile-shape-unsupported", "no-candidate")).toBe(false);
    expect(state.snapshot()).toEqual({ status: "checking" });

    expect(state.fail(second, "profile-shape-unsupported", "provider-value" as never)).toBe(true);
    expect(state.snapshot()).toEqual({
      status: "failure",
      code: "profile-shape-unsupported",
    });
    expect(state.canSubscribe()).toBe(false);
  });

  it("discards X profile details for every other failure code", () => {
    const state = new VerificationController<VerifiedSource>();
    const token = state.begin("openai");

    expect(state.fail(token, "network-failure", "identity-conflict" as never)).toBe(true);
    expect(state.snapshot()).toEqual({
      status: "failure",
      code: "network-failure",
    });
    expect(state.canSubscribe()).toBe(false);
  });

  it.each(["cancel", "close"])("invalidates an in-flight completion on %s", () => {
    const state = new VerificationController<VerifiedSource>();
    const token = state.begin("https://a.example/feed");

    state.invalidate();

    expect(state.succeed(token, { title: "A", url: "https://a.example/feed" })).toBe(false);
    expect(state.snapshot()).toEqual({ status: "idle" });
    expect(state.canSubscribe()).toBe(false);
  });

  it("returns immutable snapshots without retaining the checking input", () => {
    const state = new VerificationController<VerifiedSource>();

    state.begin("https://private.example/feed");

    expect(state.snapshot()).toEqual({ status: "checking" });
    expect(Object.isFrozen(state.snapshot())).toBe(true);
  });
});
