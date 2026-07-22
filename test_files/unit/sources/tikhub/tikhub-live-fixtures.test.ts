import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readActiveTikHubFixtureSet } from "../../../../scripts/capture-tikhub-fixtures.mjs";
import { parseTikHubTimeline } from "../../../../src/sources/tikhub/tikhub-parser";

const liveDirectory = join(
  globalThis.process.cwd(),
  "test_files",
  "fixtures",
  "tikhub",
  "live",
);
const hasLiveCapture =
  existsSync(join(liveDirectory, "current.json")) ||
  ["account-posts.json", "search-latest.json", "search-top.json"].every((name) =>
    existsSync(join(liveDirectory, name)),
  );

describe.skipIf(!hasLiveCapture)("sanitized live TikHub response shapes", () => {
  it("satisfies provider-neutral parser invariants without fixed IDs, counts, or order", async () => {
    const live = await readActiveTikHubFixtureSet(liveDirectory);
    expect(live?.fixtures).toHaveLength(3);

    for (const [index, fixture] of (live?.fixtures ?? []).entries()) {
      const result = parseTikHubTimeline(fixture);
      const fileName = live?.files[index];
      const candidateCount = fileName
        ? live?.statistics?.[fileName]?.candidateCount
        : undefined;
      expect(Array.isArray(result.posts)).toBe(true);
      expect(Array.isArray(result.warnings)).toBe(true);
      expect(candidateCount).toBeGreaterThan(0);
      expect(result.candidateCount).toBe(candidateCount);
      expect(result.posts.length).toBeGreaterThan(0);
      expect(result.posts.length).toBeLessThanOrEqual(result.candidateCount);
      for (const post of result.posts) {
        expect(post.id).toMatch(/^\d+$/);
        expect(post.authorHandle).toMatch(/^[A-Za-z0-9_]{1,15}$/);
        expect(post.url).toBe(
          `https://x.com/${post.authorHandle}/status/${post.id}`,
        );
        expect(Array.isArray(post.externalUrls)).toBe(true);
        expect(Object.values(post.metrics).every(Number.isSafeInteger)).toBe(true);
      }
    }
  });
});
