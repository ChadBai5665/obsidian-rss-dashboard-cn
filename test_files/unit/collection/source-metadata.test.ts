import { describe, expect, it } from "vitest";
import {
  mergeXPostSourceMetadata,
  normalizeXPostSourceMetadata,
} from "../../../src/collection/source-metadata";

describe("X post source metadata", () => {
  it("keeps legacy metadata valid when observedSources is absent", () => {
    expect(normalizeXPostSourceMetadata({
      kind: "x-post",
      externalUrls: ["https://example.com/article"],
      observationTags: ["latest"],
    })).toEqual({
      kind: "x-post",
      externalUrls: ["https://example.com/article"],
      observationTags: ["latest"],
    });
  });

  it("requires observedSources to be a dense own array of exact data records", () => {
    const base = {
      kind: "x-post",
      externalUrls: [],
    } as const;
    const sparse = new Array(1);
    let getterCalls = 0;
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperties(accessor, {
      type: {
        enumerable: true,
        get: () => {
          getterCalls += 1;
          return "x-topic";
        },
      },
      id: { enumerable: true, value: "ai-apps" },
      bucket: { enumerable: true, value: "X/Topics" },
    });
    const withExtra = {
      type: "x-topic",
      id: "ai-apps",
      bucket: "X/Topics",
      score: 10,
    };
    const arrayWithExtra = [
      { type: "x-topic", id: "ai-apps", bucket: "X/Topics" },
    ];
    Object.defineProperty(arrayWithExtra, "extra", { value: true });

    for (const observedSources of [
      sparse,
      [accessor],
      [withExtra],
      arrayWithExtra,
    ]) {
      expect(normalizeXPostSourceMetadata({
        ...base,
        observedSources,
      })).toBeUndefined();
    }
    expect(getterCalls).toBe(0);
  });

  it("clones normalized and merged observations without retaining aliases", () => {
    const source = {
      type: "x-topic" as const,
      id: "ai-apps",
      bucket: "X/Topics",
    };
    const observedSources = [source];
    const normalized = normalizeXPostSourceMetadata({
      kind: "x-post",
      externalUrls: [],
      observedSources,
    });
    const merged = mergeXPostSourceMetadata(normalized, {
      kind: "x-post",
      externalUrls: [],
      observedSources: [
        {
          type: "x-account",
          id: "x-account-openai",
          bucket: "X/Accounts",
        },
      ],
    });

    source.id = "mutated";
    observedSources.push({
      type: "x-topic",
      id: "other",
      bucket: "X/Topics",
    });

    expect(normalized?.observedSources).toEqual([
      { type: "x-topic", id: "ai-apps", bucket: "X/Topics" },
    ]);
    expect(merged?.observedSources).toEqual([
      {
        type: "x-account",
        id: "x-account-openai",
        bucket: "X/Accounts",
      },
      { type: "x-topic", id: "ai-apps", bucket: "X/Topics" },
    ]);
    expect(merged?.observedSources?.[1]).not.toBe(
      normalized?.observedSources?.[0],
    );
  });
});
