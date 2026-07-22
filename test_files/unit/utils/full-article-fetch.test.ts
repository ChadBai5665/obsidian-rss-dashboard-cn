import { getEventListeners } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchDetailed = vi.hoisted(() => vi.fn());

vi.mock("../../../src/utils/fetch-helpers", () => ({
  fetchWithProxyFallbackDetailed: fetchDetailed,
}));

import { fetchFullArticleContentWithOutcome } from "../../../src/utils/full-article-fetch";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  fetchDetailed.mockReset();
});

describe("full article fetch cancellation", () => {
  it("locally aborts a pending Obsidian fetch, absorbs late rejection, and removes its listener", async () => {
    const result = deferred<{ content: string; failureType: "none" }>();
    fetchDetailed.mockReturnValue(result.promise);
    const controller = new AbortController();
    const baselineListeners = getEventListeners(controller.signal, "abort").length;

    const pending = fetchFullArticleContentWithOutcome(
      "https://example.com/article",
      undefined,
      controller.signal,
    );
    await vi.waitFor(() => {
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(
        baselineListeners + 1,
      );
    });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(
      baselineListeners,
    );
    result.reject(new Error("late requestUrl failure"));
    await Promise.resolve();
    await Promise.resolve();
  });

  it("removes the abort listener after a normal fetch", async () => {
    fetchDetailed.mockResolvedValue({ content: "<p>正文</p>", failureType: "none" });
    const controller = new AbortController();
    const baselineListeners = getEventListeners(controller.signal, "abort").length;

    await expect(fetchFullArticleContentWithOutcome(
      "https://example.com/article",
      undefined,
      controller.signal,
    )).resolves.toEqual({ content: "<p>正文</p>", failureType: "none" });
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(
      baselineListeners,
    );
  });
});
