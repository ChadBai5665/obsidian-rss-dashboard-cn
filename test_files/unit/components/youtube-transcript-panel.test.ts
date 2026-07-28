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
import { createTranslator } from "../../../src/i18n";
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
  locale?: "zh-CN" | "en";
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
  const revokeChoiceSet = vi.fn();
  const runtime = {
    identity: "test-root",
    service: { get, revokeChoiceSet } satisfies YouTubeTranscriptPanelService,
    loadCached,
  };
  const panel = new YouTubeTranscriptPanel({
    container,
    locale: options.locale ?? "en",
    request: {
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      sourceUrl: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
    },
    resolveRuntime: () => runtime,
    openExternal,
    onReady,
  });
  return {
    panel,
    container,
    get,
    loadCached,
    openExternal,
    onReady,
    revokeChoiceSet,
  };
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

  it.each([
    ["showCached", (panel: YouTubeTranscriptPanel) => panel.showCached()],
    ["fetch", (panel: YouTubeTranscriptPanel) => panel.fetch()],
    ["refresh", (panel: YouTubeTranscriptPanel) => panel.refresh()],
    ["selectTrack", (panel: YouTubeTranscriptPanel) => panel.selectTrack("track-a")],
  ] as const)(
    "contains an initial runtime resolver failure from %s",
    async (_name, invoke) => {
      const container = document.createElement("div");
      const panel = new YouTubeTranscriptPanel({
        container,
        locale: "en",
        request: { itemId: ITEM_ID, videoId: VIDEO_ID },
        resolveRuntime: () => {
          throw new Error("Invalid data root");
        },
        openExternal: vi.fn(),
      });

      await expect(invoke(panel)).resolves.toBeUndefined();

      expect(state(container)).toBe("temporarily-unavailable");
      expect(container.querySelector(".rss-youtube-transcript-error")).not.toBeNull();
    },
  );

  it("contains a runtime resolver failure from a void button handler", async () => {
    const container = document.createElement("div");
    new YouTubeTranscriptPanel({
      container,
      locale: "en",
      request: { itemId: ITEM_ID, videoId: VIDEO_ID },
      resolveRuntime: () => {
        throw new Error("Invalid data root");
      },
      openExternal: vi.fn(),
    });

    container
      .querySelector<HTMLButtonElement>(".rss-youtube-transcript-fetch")
      ?.click();

    await vi.waitFor(() =>
      expect(state(container)).toBe("temporarily-unavailable"),
    );
  });

  it("uses opaque service track ids for equal-priority language choice", async () => {
    const get = vi
      .fn<YouTubeTranscriptPanelService["get"]>()
      .mockResolvedValueOnce({
        status: "selection-required",
        choiceSetId: "choice-set-test",
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
    ["invalid-video-id", "unavailable"],
    ["login-required", "login-required"],
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

  it.each([
    {
      locale: "zh-CN" as const,
      cookieText: "不会读取 Cookie",
      browserText: "系统默认浏览器",
    },
    {
      locale: "en" as const,
      cookieText: "does not read cookies",
      browserText: "system browser",
    },
  ])(
    "renders login-required as a dedicated $locale state with safe guidance",
    async ({ locale, cookieText, browserText }) => {
      const { panel, container } = createPanel({
        locale,
        get: async () => {
          throw new YouTubeTranscriptServiceError("login-required");
        },
      });

      await panel.fetch();

      expect(state(container)).toBe("login-required");
      expect(container.textContent).toContain(cookieText);
      expect(container.textContent).toContain(browserText);
      expect(
        container.querySelector(".rss-youtube-transcript-fetch"),
      ).not.toBeNull();
    },
  );

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

  it("resolves the current data-root runtime for every action in an already-open panel", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const rootAGet = vi.fn(async () => ({
      status: "ready",
      source: "fresh",
      content: transcript({ text: "Wrong old root." }),
    } as const));
    const rootBGet = vi.fn(async () => ({
      status: "ready",
      source: "fresh",
      content: transcript({ text: "Current root transcript." }),
    } as const));
    const rootALoad = vi.fn(async () => transcript({ text: "Old root cache." }));
    const rootBLoad = vi.fn(async () => null);
    let runtime = {
      identity: "root-a",
      service: { get: rootAGet, revokeChoiceSet: vi.fn() },
      loadCached: rootALoad,
    };
    const panel = new YouTubeTranscriptPanel({
      container,
      locale: "en",
      request: { itemId: ITEM_ID, videoId: VIDEO_ID },
      resolveRuntime: () => runtime,
      openExternal: vi.fn(),
    } as never);

    await panel.showCached();
    expect(container.textContent).toContain("Old root cache.");
    runtime = {
      identity: "root-b",
      service: { get: rootBGet, revokeChoiceSet: vi.fn() },
      loadCached: rootBLoad,
    };
    await panel.refresh();

    expect(rootAGet).not.toHaveBeenCalled();
    expect(rootBGet).toHaveBeenCalledTimes(1);
    expect(rootBLoad).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Current root transcript.");
  });

  it("releases its exact pending language choice when destroyed", async () => {
    const revokeChoiceSet = vi.fn();
    const get = vi.fn(async () => ({
      status: "selection-required",
      choiceSetId: "opaque-choice-set-a",
      tracks: [
        {
          id: "opaque-track-a",
          languageCode: "en",
          languageName: "English",
          isGenerated: false,
          provider: "innertube",
        },
      ],
    } as const));
    const container = document.createElement("div");
    const runtime = {
      identity: "root-a",
      service: { get, revokeChoiceSet },
      loadCached: async () => null,
    };
    const panel = new YouTubeTranscriptPanel({
      container,
      locale: "en",
      request: { itemId: ITEM_ID, videoId: VIDEO_ID },
      resolveRuntime: () => runtime,
      openExternal: vi.fn(),
    } as never);

    await panel.fetch();
    panel.destroy();

    expect(revokeChoiceSet).toHaveBeenCalledWith("opaque-choice-set-a");
  });

  it("revokes a same-root stale language choice before the replacement service settles", async () => {
    const rootARevoke = vi.fn();
    const rootAGet = vi.fn(async () => ({
      status: "selection-required",
      choiceSetId: "opaque-choice-set-a",
      tracks: [
        {
          id: "opaque-track-a",
          languageCode: "en",
          languageName: "English",
          isGenerated: false,
          provider: "innertube",
        },
      ],
    } as const));
    const rootBResult = deferred<YouTubeTranscriptServiceResult>();
    const rootBGet = vi.fn(async () => await rootBResult.promise);
    let runtime = {
      identity: "root-a",
      service: { get: rootAGet, revokeChoiceSet: rootARevoke },
      loadCached: vi.fn(async () => null),
    };
    const container = document.createElement("div");
    const panel = new YouTubeTranscriptPanel({
      container,
      locale: "en",
      request: { itemId: ITEM_ID, videoId: VIDEO_ID },
      resolveRuntime: () => runtime,
      openExternal: vi.fn(),
    });
    await panel.fetch();
    expect(state(container)).toBe("language-choice");

    runtime = {
      identity: "root-a",
      service: { get: rootBGet, revokeChoiceSet: vi.fn() },
      loadCached: vi.fn(async () => null),
    };
    const selecting = panel.selectTrack("opaque-track-a");
    const revokedBeforeReplacementSettled = rootARevoke.mock.calls.length === 1;
    const replacementRequest = rootBGet.mock.calls[0]?.[0];
    rootBResult.resolve({
      status: "ready",
      source: "fresh",
      content: transcript({ text: "Replacement runtime transcript." }),
    });
    await selecting;

    expect(revokedBeforeReplacementSettled).toBe(true);
    expect(rootARevoke).toHaveBeenCalledWith("opaque-choice-set-a");
    expect(replacementRequest).not.toHaveProperty("trackId");
  });

  it("clears a ready transcript when refresh runtime resolution fails", async () => {
    let resolverFails = false;
    const runtime = {
      identity: "root-a",
      service: {
        get: vi.fn(async () => ({
          status: "ready" as const,
          source: "fresh" as const,
          content: transcript({ text: "Old ready transcript." }),
        })),
        revokeChoiceSet: vi.fn(),
      },
      loadCached: vi.fn(async () => null),
    };
    const container = document.createElement("div");
    const panel = new YouTubeTranscriptPanel({
      container,
      locale: "en",
      request: { itemId: ITEM_ID, videoId: VIDEO_ID },
      resolveRuntime: () => {
        if (resolverFails) throw new Error("Invalid data root");
        return runtime;
      },
      openExternal: vi.fn(),
    });
    await panel.fetch();
    expect(container.textContent).toContain("Old ready transcript.");

    resolverFails = true;
    await expect(panel.refresh()).resolves.toBeUndefined();

    expect(state(container)).toBe("temporarily-unavailable");
    expect(container.textContent).not.toContain("Old ready transcript.");
    expect(runtime.service.get).toHaveBeenCalledTimes(1);
  });

  it("re-renders cached transcript localization without cache, service, or onReady side effects", async () => {
    const { panel, container, get, loadCached, onReady } = createPanel({
      cached: transcript(),
    });
    await panel.showCached();
    expect(container.textContent).toContain("YouTube transcript");
    expect(onReady).toHaveBeenCalledTimes(1);

    panel.refreshLocalization(createTranslator("zh-CN"), "zh-CN");

    expect(container.textContent).toContain("YouTube 字幕");
    expect(container.textContent).toContain("A durable public transcript.");
    expect(container.textContent).toContain("重新获取字幕");
    expect(
      container.querySelector(".rss-youtube-transcript-meta")?.textContent,
    ).toContain(new Date(transcript().fetchedAt).toLocaleString("zh-CN"));
    expect(loadCached).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("drops an in-flight ready result when the data-root runtime changes", async () => {
    const pending = deferred<YouTubeTranscriptServiceResult>();
    const rootAGet = vi.fn(async () => await pending.promise);
    const rootBGet = vi.fn(async () => ({
      status: "ready" as const,
      source: "fresh" as const,
      content: transcript({ text: "New root only." }),
    }));
    let runtime = {
      identity: "root-a",
      service: { get: rootAGet, revokeChoiceSet: vi.fn() },
      loadCached: vi.fn(async () => null),
    };
    const container = document.createElement("div");
    const onReady = vi.fn();
    const panel = new YouTubeTranscriptPanel({
      container,
      locale: "en",
      request: { itemId: ITEM_ID, videoId: VIDEO_ID },
      resolveRuntime: () => runtime,
      openExternal: vi.fn(),
      onReady,
    });

    const fetching = panel.fetch();
    runtime = {
      identity: "root-b",
      service: { get: rootBGet, revokeChoiceSet: vi.fn() },
      loadCached: vi.fn(async () => null),
    };
    pending.resolve({
      status: "ready",
      source: "fresh",
      content: transcript({ text: "Stale root transcript." }),
    });
    await fetching;

    expect(state(container)).toBe("idle");
    expect(container.textContent).not.toContain("Stale root transcript.");
    expect(onReady).not.toHaveBeenCalled();
    expect(rootBGet).not.toHaveBeenCalled();
  });

  it("drops an in-flight result when the runtime is replaced at the same data root", async () => {
    const pending = deferred<YouTubeTranscriptServiceResult>();
    let runtime = {
      identity: "root-a",
      service: {
        get: vi.fn(async () => await pending.promise),
        revokeChoiceSet: vi.fn(),
      },
      loadCached: vi.fn(async () => null),
    };
    const container = document.createElement("div");
    const onReady = vi.fn();
    const panel = new YouTubeTranscriptPanel({
      container,
      locale: "en",
      request: { itemId: ITEM_ID, videoId: VIDEO_ID },
      resolveRuntime: () => runtime,
      openExternal: vi.fn(),
      onReady,
    });

    const fetching = panel.fetch();
    runtime = {
      identity: "root-a",
      service: { get: vi.fn(), revokeChoiceSet: vi.fn() },
      loadCached: vi.fn(async () => null),
    };
    pending.resolve({
      status: "ready",
      source: "fresh",
      content: transcript({ text: "Stale same-root transcript." }),
    });
    await fetching;

    expect(state(container)).toBe("idle");
    expect(container.textContent).not.toContain("Stale same-root transcript.");
    expect(onReady).not.toHaveBeenCalled();
  });

  it("drops a stale cache when the data root changes during cache restore", async () => {
    const cached = deferred<YouTubeTranscriptCachedItemContent | null>();
    let runtime = {
      identity: "root-a",
      service: { get: vi.fn(), revokeChoiceSet: vi.fn() },
      loadCached: vi.fn(async () => await cached.promise),
    };
    const container = document.createElement("div");
    const onReady = vi.fn();
    const panel = new YouTubeTranscriptPanel({
      container,
      locale: "en",
      request: { itemId: ITEM_ID, videoId: VIDEO_ID },
      resolveRuntime: () => runtime,
      openExternal: vi.fn(),
      onReady,
    });

    const restoring = panel.showCached();
    runtime = {
      identity: "root-b",
      service: { get: vi.fn(), revokeChoiceSet: vi.fn() },
      loadCached: vi.fn(async () => null),
    };
    cached.resolve(transcript({ text: "Stale cached transcript." }));
    await restoring;

    expect(state(container)).toBe("idle");
    expect(container.textContent).not.toContain("Stale cached transcript.");
    expect(onReady).not.toHaveBeenCalled();
  });

  it("drops an in-flight failure when the data-root runtime changes", async () => {
    const pending = deferred<YouTubeTranscriptServiceResult>();
    let runtime = {
      identity: "root-a",
      service: {
        get: vi.fn(async () => await pending.promise),
        revokeChoiceSet: vi.fn(),
      },
      loadCached: vi.fn(async () => null),
    };
    const container = document.createElement("div");
    const panel = new YouTubeTranscriptPanel({
      container,
      locale: "en",
      request: { itemId: ITEM_ID, videoId: VIDEO_ID },
      resolveRuntime: () => runtime,
      openExternal: vi.fn(),
    });

    const fetching = panel.fetch();
    runtime = {
      identity: "root-b",
      service: { get: vi.fn(), revokeChoiceSet: vi.fn() },
      loadCached: vi.fn(async () => null),
    };
    pending.reject(new YouTubeTranscriptServiceError("timeout"));
    await fetching;

    expect(state(container)).toBe("idle");
    expect(container.textContent).not.toContain("timed out");
  });

  it("shows a current error instead of stale text when runtime resolution becomes invalid", async () => {
    const pending = deferred<YouTubeTranscriptServiceResult>();
    let invalid = false;
    const runtime = {
      identity: "root-a",
      service: {
        get: vi.fn(async () => await pending.promise),
        revokeChoiceSet: vi.fn(),
      },
      loadCached: vi.fn(async () => null),
    };
    const container = document.createElement("div");
    const onReady = vi.fn();
    const panel = new YouTubeTranscriptPanel({
      container,
      locale: "en",
      request: { itemId: ITEM_ID, videoId: VIDEO_ID },
      resolveRuntime: () => {
        if (invalid) throw new Error("Invalid data root");
        return runtime;
      },
      openExternal: vi.fn(),
      onReady,
    });

    const fetching = panel.fetch();
    invalid = true;
    pending.resolve({
      status: "ready",
      source: "fresh",
      content: transcript({ text: "Stale invalid-root text." }),
    });
    await fetching;

    expect(state(container)).toBe("temporarily-unavailable");
    expect(container.textContent).not.toContain("Stale invalid-root text.");
    expect(onReady).not.toHaveBeenCalled();
  });
});
