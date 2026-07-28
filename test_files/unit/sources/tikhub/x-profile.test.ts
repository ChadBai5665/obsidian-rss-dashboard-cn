import { describe, expect, it } from "vitest";

import {
  parseXProfile,
  XProfileParseError,
} from "../../../../src/sources/tikhub/x-profile";

const LEGACY_FIXTURE = {
  data: {
    user: {
      result: {
        __typename: "User",
        rest_id: "123",
        is_blue_verified: true,
        legacy: {
          screen_name: "openai",
          name: "OpenAI",
          profile_image_url_https:
            "https://pbs.twimg.com/profile_images/example.jpg",
          description: "Research and deployment company",
          verified: false,
        },
      },
    },
  },
};

describe("parseXProfile", () => {
  it("projects the allowlisted legacy profile fields without retaining provider data", () => {
    const result = parseXProfile(LEGACY_FIXTURE);

    expect(result).toEqual({
      restId: "123",
      handle: "openai",
      displayName: "OpenAI",
      avatarUrl: "https://pbs.twimg.com/profile_images/example.jpg",
      description: "Research and deployment company",
      verified: true,
    });
    expect(Object.keys(result).sort()).toEqual([
      "avatarUrl",
      "description",
      "displayName",
      "handle",
      "restId",
      "verified",
    ]);
    expect(JSON.stringify(result)).not.toMatch(/legacy|cache_url|request_id/u);
  });

  it("projects the current profile layout through harmless wrapper variation", () => {
    expect(parseXProfile({
      result: {
        rest_id: "456",
        core: { screen_name: "OpenAI", name: "OpenAI Research" },
        avatar: {
          image_url: "https://pbs.twimg.com/profile_images/current.png",
        },
        profile_bio: { description: "Current profile shape" },
        verification: { verified: true },
      },
    })).toEqual({
      restId: "456",
      handle: "openai",
      displayName: "OpenAI Research",
      avatarUrl: "https://pbs.twimg.com/profile_images/current.png",
      description: "Current profile shape",
      verified: true,
    });
  });

  it("treats a null optional profile bio container as absent", () => {
    expect(parseXProfile({
      result: {
        rest_id: "456",
        core: { screen_name: "OpenAI", name: "OpenAI Research" },
        avatar: {
          image_url: "https://pbs.twimg.com/profile_images/current.png",
        },
        profile_bio: null,
        verification: { verified: false },
      },
    })).toEqual({
      restId: "456",
      handle: "openai",
      displayName: "OpenAI Research",
      avatarUrl: "https://pbs.twimg.com/profile_images/current.png",
      verified: false,
    });
  });

  it("rejects zero or multiple viable profile candidates", () => {
    expect(() => parseXProfile({ data: null })).toThrow(
      expect.objectContaining({ code: "malformed-profile" }),
    );
    expect(() => parseXProfile({
      data: [LEGACY_FIXTURE.data.user.result, {
        rest_id: "456",
        legacy: { screen_name: "second", name: "Second" },
      }],
    })).toThrow(expect.objectContaining({ code: "malformed-profile" }));
  });

  it.each([
    { data: { result: { __typename: "UserUnavailable" } } },
    { data: { errors: [{ code: "user-not-found" }] } },
  ])("recognizes an explicit bounded not-found marker", (payload) => {
    expect(() => parseXProfile(payload)).toThrow(
      expect.objectContaining({ code: "not-found" }),
    );
  });

  it("rejects accessors without invoking them", () => {
    let getterCalls = 0;
    const hostile = { rest_id: "123" } as Record<string, unknown>;
    Object.defineProperty(hostile, "legacy", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return { screen_name: "openai", name: "OpenAI" };
      },
    });

    expect(() => parseXProfile({ data: hostile })).toThrow(
      expect.objectContaining({ code: "malformed-profile" }),
    );
    expect(getterCalls).toBe(0);
  });

  it("rejects custom prototypes before projecting their data", () => {
    const candidate = Object.assign(Object.create({ inherited: "private" }), {
      rest_id: "123",
      legacy: { screen_name: "openai", name: "OpenAI" },
    });

    expect(() => parseXProfile({ data: candidate })).toThrow(
      expect.objectContaining({ code: "malformed-profile" }),
    );
  });

  it.each([
    ["oversized display name", {
      rest_id: "123",
      legacy: { screen_name: "openai", name: "x".repeat(300) },
    }],
    ["control character", {
      rest_id: "123",
      legacy: { screen_name: "openai", name: "Open\u0000AI" },
    }],
    ["non-HTTPS avatar URL", {
      rest_id: "123",
      legacy: {
        screen_name: "openai",
        name: "OpenAI",
        profile_image_url_https: "http://private.example/avatar.jpg",
      },
    }],
  ])("rejects an unsafe %s", (_name, candidate) => {
    expect(() => parseXProfile({ data: candidate })).toThrow(
      expect.objectContaining({ code: "malformed-profile" }),
    );
  });

  it("bounds traversal depth and oversized arrays", () => {
    let deep: Record<string, unknown> = {
      rest_id: "123",
      legacy: { screen_name: "openai", name: "OpenAI" },
    };
    for (let depth = 0; depth < 40; depth += 1) deep = { data: deep };
    const oversized: unknown[] = [];
    oversized.length = 100_001;

    expect(() => parseXProfile(deep)).toThrow(XProfileParseError);
    expect(() => parseXProfile({ data: oversized })).toThrow(
      expect.objectContaining({ code: "malformed-profile" }),
    );
  });

  it("rejects an over-depth duplicate hidden beside a shallow valid profile", () => {
    let hiddenDuplicate: Record<string, unknown> = {
      rest_id: "456",
      legacy: { screen_name: "duplicate", name: "Duplicate" },
    };
    for (let depth = 0; depth < 34; depth += 1) {
      hiddenDuplicate = { data: hiddenDuplicate };
    }

    expect(() => parseXProfile({
      shallow: LEGACY_FIXTURE.data.user.result,
      hiddenDuplicate,
    })).toThrow(expect.objectContaining({ code: "malformed-profile" }));
  });
});
