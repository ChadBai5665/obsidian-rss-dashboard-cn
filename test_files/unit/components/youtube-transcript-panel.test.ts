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
  hasPendingContinuation?: () => Promise<boolean>;
  continuePending?: (
    request: YouTubeTranscriptRequest,
  ) => Promise<YouTubeTranscriptServiceResult & { status: "ready" }>;
  locale?: "zh-CN" | "en";
  openTikHubSettings?: () => void | Promise<void>;
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
  const hasPendingContinuation = vi.fn(
    options.hasPendingContinuation ?? (async () => false),
  );
  const continuePending = vi.fn(
    options.continuePending ?? (async () => {
      throw new YouTubeTranscriptServiceError("tikhub-job-expired");
    }),
  );
  const runtime = {
    identity: "test-root",
    service: {
      get,
      readCached: loadCached,
      hasPendingContinuation,
      continuePending,
      revokeChoiceSet,
    } satisfies YouTubeTranscriptPanelService,
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
    openTikHubSettings: options.openTikHubSettings,
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
    hasPendingContinuation,
    continuePending,
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

  it("passively renders a durable continuation without starting listing or continuation work", async () => {
    const { panel, container, get, hasPendingContinuation, continuePending } =
      createPanel({ hasPendingContinuation: async () => true });

    await panel.showCached();

    expect(state(container)).toBe("tikhub-processing");
    expect(container.textContent).toContain("Continue checking");
    expect(hasPendingContinuation).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
    expect(continuePending).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("$0.008");
    expect(container.textContent).not.toContain("$0.016");
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

    pending.resolve({
      status: "ready",
      source: "fresh",
      content: transcript(),
      usage: { tikhubPaidRequests: 0 },
    });
    await fetching;

    expect(state(container)).toBe("complete-manual");
    expect(container.textContent).toContain("A durable public transcript.");
    expect(container.querySelector(".rss-youtube-transcript-refresh")).not.toBeNull();
  });

  it("shows guarded provider progress inline for the current request", async () => {
    const pending = deferred<YouTubeTranscriptServiceResult>();
    let onProgress: YouTubeTranscriptRequest["onProgress"];
    const { panel, container } = createPanel({
      locale: "zh-CN",
      get: async (request) => {
        onProgress = request.onProgress;
        return await pending.promise;
      },
    });

    const fetching = panel.fetch();
    onProgress?.({ stage: "trying-innertube", usage: { tikhubPaidRequests: 0 } });
    expect(container.textContent).toContain("正在尝试免费字幕");

    onProgress?.({ stage: "trying-tikhub", usage: { tikhubPaidRequests: 1 } });
    expect(container.textContent).toContain("正在使用 TikHub");

    onProgress?.({ stage: "waiting-tikhub", usage: { tikhubPaidRequests: 1 } });
    expect(container.textContent).toContain("TikHub 正在处理");
    expect(container.querySelector(".modal")).toBeNull();

    pending.resolve({
      status: "ready",
      source: "fresh",
      content: transcript(),
      usage: { tikhubPaidRequests: 1 },
    });
    await fetching;

    expect(container.textContent).toContain("预计1次 TikHub 请求（约 $0.008）");
  });

  it("keeps repeated fetch button clicks inline while the service dedupes work", async () => {
    const pending = deferred<YouTubeTranscriptServiceResult>();
    const providerWork = vi.fn();
    let sharedWork: Promise<YouTubeTranscriptServiceResult> | undefined;
    const { container, get } = createPanel({
      get: async () => {
        if (!sharedWork) {
          providerWork();
          sharedWork = pending.promise;
        }
        return await sharedWork;
      },
    });
    const fetch = container.querySelector<HTMLButtonElement>(
      ".rss-youtube-transcript-fetch",
    );

    fetch?.click();
    fetch?.click();

    expect(get).toHaveBeenCalledTimes(2);
    expect(providerWork).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".modal")).toBeNull();

    pending.resolve({
      status: "ready",
      source: "fresh",
      content: transcript(),
      usage: { tikhubPaidRequests: 0 },
    });
    await vi.waitFor(() => expect(state(container)).toBe("complete-manual"));
    expect(container.querySelector(".modal")).toBeNull();
  });

  it("drops stale provider progress after a newer request starts", async () => {
    const first = deferred<YouTubeTranscriptServiceResult>();
    const second = deferred<YouTubeTranscriptServiceResult>();
    const requests: YouTubeTranscriptRequest[] = [];
    const { panel, container } = createPanel({
      locale: "zh-CN",
      get: async (request) => {
        requests.push(request);
        return await (requests.length === 1 ? first.promise : second.promise);
      },
    });

    const firstFetch = panel.fetch();
    const secondFetch = panel.refresh();
    requests[1]?.onProgress?.({
      stage: "trying-innertube",
      usage: { tikhubPaidRequests: 0 },
    });
    expect(container.textContent).toContain("正在尝试免费字幕");
    requests[0]?.onProgress?.({
      stage: "trying-tikhub",
      usage: { tikhubPaidRequests: 1 },
    });

    expect(container.textContent).toContain("正在尝试免费字幕");
    expect(container.textContent).not.toContain("正在使用 TikHub");
    second.resolve({
      status: "ready",
      source: "fresh",
      content: transcript({ text: "Newest transcript." }),
      usage: { tikhubPaidRequests: 0 },
    });
    first.resolve({
      status: "ready",
      source: "fresh",
      content: transcript({ text: "Stale transcript." }),
      usage: { tikhubPaidRequests: 1 },
    });
    await Promise.all([firstFetch, secondFetch]);

    expect(container.textContent).toContain("Newest transcript.");
    expect(container.textContent).not.toContain("Stale transcript.");
  });

  it("shows fresh TikHub usage and provider metadata but never cache usage", async () => {
    const { panel, container } = createPanel({
      locale: "zh-CN",
      cached: transcript({ provider: "tikhub" }),
      get: async () => ({
        status: "ready",
        source: "fresh",
        content: transcript({ provider: "tikhub" }),
        usage: { tikhubPaidRequests: 2 },
      }),
    });

    await panel.showCached();
    expect(container.textContent).toContain("来源：TikHub");
    expect(container.textContent).not.toContain("预计2次 TikHub 请求（约 $0.016）");

    await panel.refresh();
    expect(container.textContent).toContain("预计2次 TikHub 请求（约 $0.016）");
    expect(container.textContent).toContain("重新获取可能产生 TikHub 费用");
  });

  it.each([
    ["tikhub-processing", "TikHub 正在处理字幕", "继续查询"],
    ["tikhub-invalid-key", "TikHub 密钥无效", "打开 TikHub 设置"],
    ["tikhub-missing-key", "尚未配置 TikHub 密钥", "打开 TikHub 设置"],
    ["tikhub-insufficient-balance", "TikHub 余额不足", "检查 TikHub 余额"],
    ["tikhub-budget-unavailable", "今日 TikHub 请求额度已用完", "明天再试"],
    ["tikhub-rate-limited", "TikHub 请求过于频繁", "稍后重试"],
    ["tikhub-job-expired", "TikHub 的字幕任务已过期", "重新获取（可能产生 TikHub 费用）"],
    ["tikhub-malformed-response", "TikHub 返回的数据无法使用", "重新获取字幕"],
  ] as const)(
    "renders %s as a safe inline actionable error",
    async (code, message, action) => {
      const { panel, container } = createPanel({
        locale: "zh-CN",
        ...(code === "tikhub-invalid-key" ||
            code === "tikhub-missing-key" ||
            code === "tikhub-insufficient-balance"
          ? { openTikHubSettings: vi.fn() }
          : {}),
        get: async () => {
          throw new YouTubeTranscriptServiceError(
            code,
            undefined,
            [],
            { tikhubPaidRequests: 0 },
            true,
          );
        },
      });

      await panel.fetch();

      expect(container.textContent).toContain(message);
      expect(container.textContent).toContain(action);
      expect(container.textContent).toContain("请求可能已发送，实际费用以 TikHub 账单为准");
      expect(container.textContent).not.toContain("requestId");
      expect(container.querySelector(".modal")).toBeNull();
    },
  );

  it("uses only explicit continuation and preserves the same-session two-request usage", async () => {
    const get = vi.fn(async () => {
      throw new YouTubeTranscriptServiceError(
        "tikhub-processing",
        undefined,
        [],
        { tikhubPaidRequests: 2 },
      );
    });
    const continuePending = vi.fn(async () => ({
      status: "ready" as const,
      source: "fresh" as const,
      content: transcript({ provider: "tikhub" }),
      usage: { tikhubPaidRequests: 0 as const },
    }));
    const { panel, container } = createPanel({ get, continuePending });

    await panel.fetch();
    expect(container.textContent).toContain("Estimated 2 TikHub request(s) (about $0.016)");
    container
      .querySelector<HTMLButtonElement>(".rss-youtube-transcript-continue")
      ?.click();
    await vi.waitFor(() => expect(state(container)).toBe("complete-manual"));

    expect(continuePending).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Estimated 2 TikHub request(s) (about $0.016)");
  });

  it("keeps confirmed usage visible while a free continuation is pending and localized", async () => {
    const pending = deferred<YouTubeTranscriptServiceResult & { status: "ready" }>();
    const { panel, container } = createPanel({
      get: async () => {
        throw new YouTubeTranscriptServiceError(
          "tikhub-processing",
          undefined,
          [],
          { tikhubPaidRequests: 2 },
        );
      },
      continuePending: async () => pending.promise,
    });

    await panel.fetch();
    container
      .querySelector<HTMLButtonElement>(".rss-youtube-transcript-continue")
      ?.click();

    expect(state(container)).toBe("fetching");
    expect(container.textContent).toContain(
      "Estimated 2 TikHub request(s) (about $0.016)",
    );

    panel.refreshLocalization(createTranslator("zh-CN"), "zh-CN");

    expect(state(container)).toBe("fetching");
    expect(container.textContent).toContain("预计2次 TikHub 请求（约 $0.016）");

    pending.resolve({
      status: "ready",
      source: "fresh",
      content: transcript({ provider: "tikhub" }),
      usage: { tikhubPaidRequests: 0 },
    });
    await vi.waitFor(() => expect(state(container)).toBe("complete-manual"));
  });

  it("keeps newly confirmed usage visible across pending progress updates", async () => {
    const pending = deferred<YouTubeTranscriptServiceResult>();
    const { panel, container } = createPanel({
      get: async (request) => {
        request.onProgress?.({
          stage: "waiting-tikhub",
          usage: { tikhubPaidRequests: 2 },
        });
        return pending.promise;
      },
    });

    void panel.fetch();

    expect(state(container)).toBe("fetching");
    expect(container.textContent).toContain(
      "Estimated 2 TikHub request(s) (about $0.016)",
    );

    panel.refreshLocalization(createTranslator("zh-CN"), "zh-CN");

    expect(container.textContent).toContain("预计2次 TikHub 请求（约 $0.016）");
    pending.reject(new YouTubeTranscriptServiceError("aborted"));
    await vi.waitFor(() => expect(state(container)).toBe("aborted"));
  });

  it.each([
    ["tikhub-processing", 1, false, "$0.008"],
    ["tikhub-processing", 2, false, "$0.016"],
    ["no-captions", 1, false, "$0.008"],
    ["temporarily-unavailable", 1, true, "$0.008"],
    ["aborted", 0, true, ""],
  ] as const)(
    "keeps confirmed usage and independent ambiguity for %s with %s confirmed requests",
    async (code, confirmed, possiblySent, cost) => {
      const { panel, container } = createPanel({
        locale: "en",
        get: async () => {
          throw new YouTubeTranscriptServiceError(
            code,
            undefined,
            [],
            { tikhubPaidRequests: confirmed },
            possiblySent,
          );
        },
      });

      await panel.fetch();

      if (cost) expect(container.textContent).toContain(cost);
      else expect(container.textContent).not.toContain("Estimated 1 TikHub request");
      expect(container.textContent.includes("request may have been sent")).toBe(
        possiblySent,
      );
    },
  );

  it("re-renders a generic failure with exact usage and ambiguity in the new locale", async () => {
    const { panel, container } = createPanel({
      locale: "en",
      get: async () => {
        throw new YouTubeTranscriptServiceError(
          "temporarily-unavailable",
          undefined,
          [],
          { tikhubPaidRequests: 1 },
          true,
        );
      },
    });
    await panel.fetch();

    panel.refreshLocalization(createTranslator("zh-CN"), "zh-CN");

    expect(container.textContent).toContain("预计1次 TikHub 请求（约 $0.008）");
    expect(container.textContent).toContain("请求可能已发送，实际费用以 TikHub 账单为准");
    expect(container.textContent).not.toContain("private provider detail");
  });

  it("opens TikHub settings exactly once for a key recovery without retrying", async () => {
    const openTikHubSettings = vi.fn();
    const { panel, container, get } = createPanel({
      locale: "zh-CN",
      openTikHubSettings,
      get: async () => {
        throw new YouTubeTranscriptServiceError("tikhub-invalid-key");
      },
    });

    await panel.fetch();
    container
      .querySelector<HTMLButtonElement>(".rss-youtube-transcript-tikhub-settings")
      ?.click();

    expect(openTikHubSettings).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".modal")).toBeNull();
  });

  it("does not render a dead TikHub settings action without a recovery callback", async () => {
    const { panel, container } = createPanel({
      locale: "zh-CN",
      get: async () => {
        throw new YouTubeTranscriptServiceError("tikhub-missing-key");
      },
    });

    await panel.fetch();

    expect(
      container.querySelector(".rss-youtube-transcript-tikhub-settings"),
    ).toBeNull();
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
        throw new YouTubeTranscriptServiceError(
          code,
          undefined,
          [],
          { tikhubPaidRequests: 1 },
          true,
        );
      },
    });

    await panel.fetch();

    expect(state(container)).toBe(expectedState);
    expect(container.querySelector(".rss-youtube-transcript-error")).not.toBeNull();
    expect(container.textContent).toContain("$0.008");
    expect(container.textContent).toContain("request may have been sent");
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
      service: {
        get: rootAGet,
        readCached: rootALoad,
        revokeChoiceSet: vi.fn(),
      },
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
      service: {
        get: rootBGet,
        readCached: rootBLoad,
        revokeChoiceSet: vi.fn(),
      },
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
      service: { get, readCached: async () => null, revokeChoiceSet },
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
      service: {
        get: rootAGet,
        readCached: vi.fn(async () => null),
        revokeChoiceSet: rootARevoke,
      },
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
      service: {
        get: rootBGet,
        readCached: vi.fn(async () => null),
        revokeChoiceSet: vi.fn(),
      },
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
        readCached: vi.fn(async () => null),
        revokeChoiceSet: vi.fn(),
      },
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
      service: {
        get: rootAGet,
        readCached: vi.fn(async () => null),
        revokeChoiceSet: vi.fn(),
      },
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
      service: {
        get: rootBGet,
        readCached: vi.fn(async () => null),
        revokeChoiceSet: vi.fn(),
      },
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
        readCached: vi.fn(async () => null),
        revokeChoiceSet: vi.fn(),
      },
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
      service: {
        get: vi.fn(),
        readCached: vi.fn(async () => null),
        revokeChoiceSet: vi.fn(),
      },
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
      service: {
        get: vi.fn(),
        readCached: vi.fn(async () => await cached.promise),
        revokeChoiceSet: vi.fn(),
      },
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
      service: {
        get: vi.fn(),
        readCached: vi.fn(async () => null),
        revokeChoiceSet: vi.fn(),
      },
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
        readCached: vi.fn(async () => null),
        revokeChoiceSet: vi.fn(),
      },
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
      service: {
        get: vi.fn(),
        readCached: vi.fn(async () => null),
        revokeChoiceSet: vi.fn(),
      },
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
        readCached: vi.fn(async () => null),
        revokeChoiceSet: vi.fn(),
      },
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
