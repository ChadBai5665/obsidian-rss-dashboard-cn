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

  it("shares a token for a duplicate click but supersedes an edited input", () => {
    const state = new VerificationController<VerifiedSource>();

    const first = state.begin("https://a.example/feed");
    expect(state.begin("https://a.example/feed")).toBe(first);

    const second = state.begin("https://b.example/feed");
    expect(second).not.toBe(first);
    expect(state.succeed(first, { title: "A", url: "https://a.example/feed" })).toBe(false);
    expect(state.succeed(second, { title: "B", url: "https://b.example/feed" })).toBe(true);
    expect(state.snapshot()).toEqual({
      status: "success",
      value: { title: "B", url: "https://b.example/feed" },
    });
  });

  it("permits subscription only after success or an accepted empty-feed warning", () => {
    const state = new VerificationController<VerifiedSource>();

    const success = state.begin("https://a.example/feed");
    state.succeed(success, { title: "A", url: "https://a.example/feed" });
    expect(state.canSubscribe()).toBe(true);

    const emptyFeed = state.begin("https://empty.example/feed");
    state.warn(emptyFeed, { title: "Empty", url: "https://empty.example/feed" }, "empty-feed");
    expect(state.canSubscribe()).toBe(true);

    const otherWarning = state.begin("https://choice.example");
    state.warn(otherWarning, { title: "Choice", url: "https://choice.example" }, "feed-selection-required");
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
