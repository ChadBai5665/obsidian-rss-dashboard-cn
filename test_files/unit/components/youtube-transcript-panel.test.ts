import { beforeEach, describe, expect, it, vi } from "vitest";
import type { YouTubeTranscriptCachedItemContent } from "../../../src/collection/content-repository";
import {
  YouTubeTranscriptPanel,
  type YouTubeTranscriptPanelService,
} from "../../../src/components/youtube-transcript-panel";
import {
  YouTubeTranscriptServiceError,
  type YouTubeTranscriptRequest,
  type YouTubeTranscriptServiceResult,
} from "../../../src/youtube-transcript/youtube-transcript-service";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";

installObsidianDomPolyfills();

const ITEM_ID = "a".repeat(64);
const VIDEO_ID = "dQw4w9WgXcQ";

function transcript(
  overrides: Partial<YouTubeTranscriptCachedItemContent> = {},
): YouTubeTranscriptCachedItemContent {
  return {
    schemaVersion: 2,
    contentBasis: "youtube-transcript",
    itemId: ITEM_ID,
    sourceUrl: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
    fetchedAt: "2026-07-28T06:00:00.000Z",
    videoId: VIDEO_ID,
    languageCode: "en",
    languageName: "English",
    isGenerated: false,
    provider: "innertube",
    text: "A durable public transcript.",
    ...overrides,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function createPanel(options: {
  cached?: YouTubeTranscriptCachedItemContent | null;
  get?: (request: YouTubeTranscriptRequest) => Promise<YouTubeTranscriptServiceResult>;
} = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const get = vi.fn(
    options.get ??
      (async () => ({
        status: "ready",
        source: "fresh",
        content: transcript(),
      } as const)),
  );
  const loadCached = vi.fn(
    async () => options.cached === undefined ? null : options.cached,
  );
  const openExternal = vi.fn();
  const onReady = vi.fn();
  const panel = new YouTubeTranscriptPanel({
    container,
    locale: "en",
    request: {
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      sourceUrl: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
    },
    service: { get } satisfies YouTubeTranscriptPanelService,
    loadCached,
    openExternal,
    onReady,
  });
  return { panel, container, get, loadCached, openExternal, onReady };
}

function state(container: HTMLElement): string | null {
  return container
    .querySelector<HTMLElement>(".rss-youtube-transcript-panel")
    ?.getAttribute("data-state") ?? null;
}

describe("YouTubeTranscriptPanel", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("starts compact and restores a matching local cache without provider work", async () => {
    const { panel, container, get, loadCached, onReady } = createPanel({
      cached: transcript(),
    });

    expect(state(container)).toBe("idle");
    await panel.showCached();

    expect(state(container)).toBe("cached");
    expect(container.textContent).toContain("A durable public transcript.");
    expect(container.textContent).toContain("Manual captions");
    expect(container.querySelector(".modal")).toBeNull();
    expect(loadCached).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
    expect(onReady).toHaveBeenCalledWith(transcript());
  });

  it("ignores a cache for a different item or video and keeps the explicit fetch action", async () => {
    const { panel, container, get } = createPanel({
      cached: transcript({ videoId: "M7lc1UVf-VE" }),
    });

    await panel.showCached();

    expect(state(container)).toBe("idle");
    expect(container.querySelector(".rss-youtube-transcript-fetch")).not.toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it("shows checking before an explicit initial fetch and renders a manual result", async () => {
    const pending = deferred<YouTubeTranscriptServiceResult>();
    const { panel, container, get } = createPanel({
      get: async () => await pending.promise,
    });

    const fetching = panel.fetch();
    expect(state(container)).toBe("checking");
    expect(get).toHaveBeenCalledWith(
      expect.objectContaining({ refresh: false, signal: expect.any(AbortSignal) }),
    );

    pending.resolve({ status: "ready", source: "fresh", content: transcript() });
    await fetching;

    expect(state(container)).toBe("complete-manual");
    expect(container.textContent).toContain("A durable public transcript.");
    expect(container.querySelector(".rss-youtube-transcript-refresh")).not.toBeNull();
  });

  it("uses opaque service track ids for equal-priority language choice", async () => {
    const get = vi
      .fn<YouTubeTranscriptPanelService["get"]>()
      .mockResolvedValueOnce({
        status: "selection-required",
        tracks: [
          {
            id: "track-opaque-one",
            languageCode: "en",
            languageName: "English",
            isGenerated: false,
            provider: "innertube",
          },
          {
            id: "track-opaque-two",
            languageCode: "zh-Hans",
            languageName: "Chinese (Simplified)",
            isGenerated: false,
            provider: "innertube",
          },
        ],
      })
      .mockResolvedValueOnce({
        status: "ready",
        source: "fresh",
        content: transcript({
          languageCode: "zh-Hans",
          languageName: "Chinese (Simplified)",
        }),
      });
    const { panel, container } = createPanel({ get });

    await panel.fetch();
    expect(state(container)).toBe("language-choice");
    const choices = container.querySelectorAll<HTMLButtonElement>(
      ".rss-youtube-transcript-language",
    );
    expect(choices).toHaveLength(2);

    choices[1]?.click();
    await vi.waitFor(() => expect(state(container)).toBe("complete-manual"));
    expect(get).toHaveBeenLastCalledWith(
      expect.objectContaining({ trackId: "track-opaque-two" }),
    );
  });

  it("marks generated captions and refreshes only through the refresh action", async () => {
    const { panel, container, get } = createPanel({
      cached: transcript({ isGenerated: true }),
      get: async () => ({
        status: "ready",
        source: "fresh",
        content: transcript({ isGenerated: true, text: "Fresh auto captions." }),
      }),
    });
    await panel.showCached();

    container
      .querySelector<HTMLButtonElement>(".rss-youtube-transcript-refresh")
      ?.click();
    await vi.waitFor(() => expect(state(container)).toBe("complete-auto"));

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(expect.objectContaining({ refresh: true }));
    expect(container.textContent).toContain("Automatic captions");
    expect(container.textContent).toContain("Fresh auto captions.");
  });

  it.each([
    ["no-captions", "no-captions"],
    ["fallback-unavailable", "fallback-unavailable"],
    ["temporarily-unavailable", "temporarily-unavailable"],
    ["video-unavailable", "unavailable"],
    ["login-required", "unavailable"],
    ["timeout", "timeout"],
  ] as const)("keeps %s failures inline", async (code, expectedState) => {
    const { panel, container } = createPanel({
      get: async () => {
        throw new YouTubeTranscriptServiceError(code);
      },
    });

    await panel.fetch();

    expect(state(container)).toBe(expectedState);
    expect(container.querySelector(".rss-youtube-transcript-error")).not.toBeNull();
    expect(document.body.querySelector(".modal")).toBeNull();
  });

  it("aborts active work without allowing a late completion to change the UI", async () => {
    const pending = deferred<YouTubeTranscriptServiceResult>();
    let signal: AbortSignal | undefined;
    const { panel, container } = createPanel({
      get: async (request) => {
        signal = request.signal;
        return await pending.promise;
      },
    });

    const fetching = panel.fetch();
    panel.abort();
    expect(signal?.aborted).toBe(true);
    expect(state(container)).toBe("aborted");

    pending.resolve({ status: "ready", source: "fresh", content: transcript() });
    await fetching;
    expect(state(container)).toBe("aborted");
    expect(container.textContent).not.toContain("A durable public transcript.");
  });

  it("destroys state, handlers, and pending work permanently", async () => {
    const pending = deferred<YouTubeTranscriptServiceResult>();
    let signal: AbortSignal | undefined;
    const { panel, container, get } = createPanel({
      get: async (request) => {
        signal = request.signal;
        return await pending.promise;
      },
    });

    const fetching = panel.fetch();
    panel.destroy();

    expect(signal?.aborted).toBe(true);
    expect(state(container)).toBe("destroyed");
    expect(container.querySelector("button")).toBeNull();
    await panel.refresh();
    expect(get).toHaveBeenCalledTimes(1);

    pending.resolve({ status: "ready", source: "fresh", content: transcript() });
    await fetching;
    expect(state(container)).toBe("destroyed");
  });
});
