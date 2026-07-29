import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TikHubClient,
  TikHubClientError,
  type TikHubBatchHandle,
  type TikHubTransport,
  type TikHubTransportRequest,
  type TikHubYouTubeCaptionRequest,
} from "../../../../src/sources/tikhub/tikhub-client";
import type { TikHubRequestBudgetLike } from "../../../../src/sources/tikhub/request-budget";
import { DEFAULT_SETTINGS } from "../../../../src/types/types";
import { loadAndNormalizeSettings } from "../../../../src/utils/settings-loader";

const API_KEY = "external-secret";

function success(data: unknown = { items: [1] }, requestId = "req-safe-123") {
  return {
    status: 200,
    text: JSON.stringify({ code: 200, data, request_id: requestId }),
    headers: {},
  };
}

function createHarness(
  response: Awaited<ReturnType<TikHubTransport>> = success(),
  baseUrl = "https://api.tikhub.dev",
) {
  const markAttempted = vi.fn();
  const releaseUnused = vi.fn();
  const reserve = vi.fn(async (count: number) => {
    const reservation = {
      total: count,
      remaining: count,
      markAttempted: () => {
        markAttempted();
        reservation.remaining -= 1;
      },
      releaseUnused: async () => {
        releaseUnused();
        const released = reservation.remaining;
        reservation.remaining = 0;
        return released;
      },
    };
    return reservation;
  });
  const budget: TikHubRequestBudgetLike = { reserve };
  const requests: TikHubTransportRequest[] = [];
  const transport = vi.fn<TikHubTransport>(async (request) => {
    requests.push(request);
    return response;
  });
  const client = new TikHubClient({
    baseUrl,
    timeoutMs: 20_000,
    budget,
    transport,
  });
  return {
    budget,
    client,
    markAttempted,
    releaseUnused,
    requests,
    reserve,
    transport,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("TikHubClient exact request contract", () => {
  it("sends exact budgeted YouTube caption list and content requests", async () => {
    const list = createHarness(success({
      video_id: "dQw4w9WgXcQ",
      captions: [{ language_code: "en", language_name: "English" }],
    }));

    await expect(list.client.fetchYouTubeCaptions({
      apiKey: API_KEY,
      videoId: "dQw4w9WgXcQ",
    })).resolves.toEqual({
      data: {
        video_id: "dQw4w9WgXcQ",
        captions: [{ language_code: "en", language_name: "English" }],
      },
      requestId: "req-safe-123",
    });
    expect(list.requests).toEqual([{
      url: "https://api.tikhub.dev/api/v1/youtube/web_v2/get_video_captions?video_id=dQw4w9WgXcQ",
      method: "GET",
      headers: { Authorization: `Bearer ${API_KEY}` },
    }]);
    expect(list.reserve).toHaveBeenCalledWith(1);
    expect(list.markAttempted).toHaveBeenCalledOnce();

    const content = createHarness(success({
      video_id: "dQw4w9WgXcQ",
      language_code: "en",
      language_name: "English",
      format: "txt",
      content: "Caption text",
    }));
    await expect(content.client.fetchYouTubeCaptions({
      apiKey: API_KEY,
      videoId: "dQw4w9WgXcQ",
      languageCode: "en",
      format: "txt",
    })).resolves.toMatchObject({ data: { content: "Caption text" } });
    expect(content.requests[0]?.url).toBe(
      "https://api.tikhub.dev/api/v1/youtube/web_v2/get_video_captions?video_id=dQw4w9WgXcQ&language_code=en&format=txt",
    );
    expect(content.reserve).toHaveBeenCalledWith(1);
    expect(content.markAttempted).toHaveBeenCalledOnce();
  });

  it("ignores a runtime cursor instead of contaminating a caption request", async () => {
    const test = createHarness(success({
      video_id: "dQw4w9WgXcQ",
      captions: [{ language_code: "en", language_name: "English" }],
    }));
    const input = {
      apiKey: API_KEY,
      videoId: "dQw4w9WgXcQ",
      cursor: "private-cursor",
    } as TikHubYouTubeCaptionRequest & { cursor: string };

    await test.client.fetchYouTubeCaptions(input);

    expect(test.requests[0]?.url).toBe(
      "https://api.tikhub.dev/api/v1/youtube/web_v2/get_video_captions?video_id=dQw4w9WgXcQ",
    );
    expect(test.requests[0]?.url).not.toContain("cursor");
    expect(test.reserve).toHaveBeenCalledWith(1);
  });

  it("polls only the fixed free caption-result endpoint without reserving budget", async () => {
    const test = createHarness(success({ status: "active", job_id: "123e4567-e89b-12d3-a456-426614174000" }));

    await expect(test.client.fetchYouTubeCaptionResult({
      apiKey: API_KEY,
      jobId: "123e4567-e89b-12d3-a456-426614174000",
      format: "txt",
    })).resolves.toEqual({
      data: {
        status: "active",
        job_id: "123e4567-e89b-12d3-a456-426614174000",
      },
      requestId: "req-safe-123",
    });

    expect(test.requests).toEqual([{
      url: "https://api.tikhub.dev/api/v1/youtube/web_v2/get_video_captions_result?job_id=123e4567-e89b-12d3-a456-426614174000&format=txt",
      method: "GET",
      headers: { Authorization: `Bearer ${API_KEY}` },
    }]);
    expect(test.reserve).not.toHaveBeenCalled();
    expect(test.markAttempted).not.toHaveBeenCalled();
    expect(test.releaseUnused).not.toHaveBeenCalled();
  });

  it("cannot use an internal generic executor to send an arbitrary free request", async () => {
    const test = createHarness();
    const internal = test.client as unknown as {
      performRequest?: (
        url: URL,
        apiKey: string,
        signal: AbortSignal | undefined,
        markAttempted: () => void,
      ) => Promise<unknown>;
    };

    const invoke = async () => {
      if (typeof internal.performRequest !== "function") {
        throw new Error("Generic free executor is unavailable.");
      }
      return await internal.performRequest(
        new URL("https://untrusted.invalid/private"),
        API_KEY,
        undefined,
        () => undefined,
      );
    };

    await expect(invoke()).rejects.toThrow("Generic free executor is unavailable.");
    expect(test.requests).toEqual([]);
    expect(test.reserve).not.toHaveBeenCalled();
  });

  it("ignores arbitrary runtime fields on the free caption-result request", async () => {
    const test = createHarness(success({
      status: "queued",
      job_id: "123e4567-e89b-12d3-a456-426614174000",
    }));
    const input = {
      apiKey: API_KEY,
      jobId: "123e4567-e89b-12d3-a456-426614174000",
      format: "txt" as const,
      endpoint: "https://untrusted.invalid/private",
      cursor: "private-cursor",
      query: "private-query",
    };

    await test.client.fetchYouTubeCaptionResult(input);

    expect(test.requests[0]?.url).toBe(
      "https://api.tikhub.dev/api/v1/youtube/web_v2/get_video_captions_result?job_id=123e4567-e89b-12d3-a456-426614174000&format=txt",
    );
    expect(test.reserve).not.toHaveBeenCalled();
  });

  it("keeps the YouTube request contract identical on the international base", async () => {
    const paid = createHarness(success({
      video_id: "dQw4w9WgXcQ",
      captions: [],
      message: "No captions found",
      message_zh: "未找到字幕",
    }), "https://api.tikhub.io");
    await paid.client.fetchYouTubeCaptions({
      apiKey: API_KEY,
      videoId: "dQw4w9WgXcQ",
    });
    expect(paid.requests[0]?.url).toBe(
      "https://api.tikhub.io/api/v1/youtube/web_v2/get_video_captions?video_id=dQw4w9WgXcQ",
    );

    const free = createHarness(success({
      status: "queued",
      job_id: "123e4567-e89b-12d3-a456-426614174000",
    }), "https://api.tikhub.io");
    await free.client.fetchYouTubeCaptionResult({
      apiKey: API_KEY,
      jobId: "123e4567-e89b-12d3-a456-426614174000",
      format: "txt",
    });
    expect(free.requests[0]?.url).toBe(
      "https://api.tikhub.io/api/v1/youtube/web_v2/get_video_captions_result?job_id=123e4567-e89b-12d3-a456-426614174000&format=txt",
    );
    expect(free.reserve).not.toHaveBeenCalled();
  });

  it("rejects invalid caption inputs before budget or transport", async () => {
    const test = createHarness();

    await expect(test.client.fetchYouTubeCaptions({
      apiKey: API_KEY,
      videoId: "../private",
    })).rejects.toMatchObject({ code: "invalid-query" });
    await expect(test.client.fetchYouTubeCaptions({
      apiKey: API_KEY,
      videoId: "dQw4w9WgXcQ",
      languageCode: "en\u0000",
      format: "txt",
    })).rejects.toMatchObject({ code: "invalid-query" });
    await expect(test.client.fetchYouTubeCaptionResult({
      apiKey: API_KEY,
      jobId: "../private-job",
      format: "txt",
    })).rejects.toMatchObject({ code: "invalid-query" });

    expect(test.reserve).not.toHaveBeenCalled();
    expect(test.transport).not.toHaveBeenCalled();
  });

  it("applies the shared response-size limit to free caption-result polling", async () => {
    const text = JSON.stringify({
      code: 200,
      data: { padding: "x".repeat(5_000_000) },
    });
    const test = createHarness({ status: 200, text, headers: {} });

    await expect(test.client.fetchYouTubeCaptionResult({
      apiKey: API_KEY,
      jobId: "123e4567-e89b-12d3-a456-426614174000",
      format: "txt",
    })).rejects.toMatchObject({ code: "malformed-response" });
    expect(test.reserve).not.toHaveBeenCalled();
  });

  it("shares sanitized status and abort handling with free result polling", async () => {
    const rejected = createHarness({
      status: 401,
      text: `provider leaked ${API_KEY}`,
      headers: { "x-request-id": "req-safe-poll" },
    });
    const error = await rejected.client.fetchYouTubeCaptionResult({
      apiKey: API_KEY,
      jobId: "123e4567-e89b-12d3-a456-426614174000",
      format: "txt",
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "invalid-key",
      status: 401,
      requestId: "req-safe-poll",
    });
    expect(String(error)).not.toContain(API_KEY);
    expect(rejected.reserve).not.toHaveBeenCalled();

    const aborted = createHarness();
    aborted.transport.mockImplementationOnce(() => new Promise(() => undefined));
    const controller = new AbortController();
    const pending = aborted.client.fetchYouTubeCaptionResult({
      apiKey: API_KEY,
      jobId: "123e4567-e89b-12d3-a456-426614174000",
      format: "txt",
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    expect(aborted.reserve).not.toHaveBeenCalled();
  });

  it("rejects a caption result whose job ID does not match the requested job", async () => {
    const test = createHarness(success({
      status: "active",
      job_id: "87654321-e89b-12d3-a456-426614174000",
    }));

    const error = await test.client.fetchYouTubeCaptionResult({
      apiKey: API_KEY,
      jobId: "123e4567-e89b-12d3-a456-426614174000",
      format: "txt",
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "malformed-response" });
    expect(String(error)).not.toContain("87654321");
    expect(test.reserve).not.toHaveBeenCalled();
  });

  it("verifies the saved key against the official account endpoint without requiring content data", async () => {
    const test = createHarness({
      status: 200,
      text: JSON.stringify({
        code: 200,
        router: "/api/v1/tikhub/user/get_user_info",
        api_key_data: {
          api_key_name: "Obsidian",
          api_key_scopes: ["Twitter-Web-API"],
          created_at: "2026-07-26T00:00:00Z",
          expires_at: "2027-07-26T00:00:00Z",
          api_key_status: 1,
        },
        user_data: {
          email: "account@example.com",
          balance: 1,
          free_credit: 1,
          email_verified: true,
          account_disabled: false,
          is_active: true,
        },
      }),
      headers: {},
    });

    await expect(test.client.verifyAccount({ apiKey: API_KEY })).resolves.toBeUndefined();

    expect(test.requests).toEqual([{
      url: "https://api.tikhub.dev/api/v1/tikhub/user/get_user_info",
      method: "GET",
      headers: { Authorization: `Bearer ${API_KEY}` },
    }]);
    expect(test.reserve).toHaveBeenCalledWith(1);
    expect(test.markAttempted).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "user profile",
      invoke: (client: TikHubClient) =>
        client.fetchUserProfile({ apiKey: API_KEY, handle: "openai" }),
      url: "https://api.tikhub.dev/api/v1/twitter/web/fetch_user_profile?screen_name=openai",
    },
    {
      name: "user posts",
      invoke: (client: TikHubClient) =>
        client.fetchUserPosts({ apiKey: API_KEY, handle: "openai" }),
      url: "https://api.tikhub.dev/api/v1/twitter/web/fetch_user_post_tweet?screen_name=openai",
    },
    {
      name: "user replies",
      invoke: (client: TikHubClient) =>
        client.fetchUserReplies({ apiKey: API_KEY, handle: "openai" }),
      url: "https://api.tikhub.dev/api/v1/twitter/web/fetch_user_tweet_replies?screen_name=openai",
    },
    {
      name: "latest search",
      invoke: (client: TikHubClient) =>
        client.fetchSearchTimeline({
          apiKey: API_KEY,
          query: "agent ops",
          searchType: "Latest",
        }),
      url: "https://api.tikhub.dev/api/v1/twitter/web/fetch_search_timeline?keyword=agent+ops&search_type=Latest",
    },
    {
      name: "top search",
      invoke: (client: TikHubClient) =>
        client.fetchSearchTimeline({
          apiKey: API_KEY,
          query: "agent ops",
          searchType: "Top",
        }),
      url: "https://api.tikhub.dev/api/v1/twitter/web/fetch_search_timeline?keyword=agent+ops&search_type=Top",
    },
  ])("sends the exact $name request", async ({ invoke, url }) => {
    const test = createHarness();

    await expect(invoke(test.client)).resolves.toEqual({
      data: { items: [1] },
      requestId: "req-safe-123",
    });

    expect(test.requests).toEqual([
      {
        url,
        method: "GET",
        headers: { Authorization: `Bearer ${API_KEY}` },
      },
    ]);
    expect(url).not.toContain("rest_id");
    expect(test.reserve).toHaveBeenCalledWith(1);
    expect(test.markAttempted).toHaveBeenCalledTimes(1);
    expect(test.releaseUnused).toHaveBeenCalledTimes(1);
  });

  it("joins the official profile path onto the selected international preset", async () => {
    const test = createHarness(success(), "https://api.tikhub.io");

    await test.client.fetchUserProfile({ apiKey: API_KEY, handle: "openai" });

    expect(test.requests[0]?.url).toBe(
      "https://api.tikhub.io/api/v1/twitter/web/fetch_user_profile?screen_name=openai",
    );
  });

  it("includes a non-empty cursor and omits an empty cursor instead of serializing undefined", async () => {
    const withCursor = createHarness();
    await withCursor.client.fetchUserPosts({
      apiKey: API_KEY,
      handle: "openai",
      cursor: "cursor/value",
    });
    expect(withCursor.requests[0]?.url).toBe(
      "https://api.tikhub.dev/api/v1/twitter/web/fetch_user_post_tweet?screen_name=openai&cursor=cursor%2Fvalue",
    );

    const withoutCursor = createHarness();
    await withoutCursor.client.fetchUserPosts({
      apiKey: API_KEY,
      handle: "openai",
      cursor: "   ",
    });
    expect(withoutCursor.requests[0]?.url).toBe(
      "https://api.tikhub.dev/api/v1/twitter/web/fetch_user_post_tweet?screen_name=openai",
    );
    expect(withoutCursor.requests[0]?.url).not.toContain("undefined");
  });

  it("keeps the API key method-scoped instead of retaining it on the client", async () => {
    const test = createHarness();
    await test.client.fetchUserPosts({ apiKey: API_KEY, handle: "openai" });

    expect(JSON.stringify(test.client)).not.toContain(API_KEY);
    expect(Object.values(test.client as unknown as Record<string, unknown>)).not.toContain(
      API_KEY,
    );
  });

  it("creates and consumes one client-owned opaque batch without double accounting", async () => {
    const test = createHarness();
    const batch = await test.client.reserveBatch(2);

    await test.client.fetchSearchTimeline({
      apiKey: API_KEY,
      query: "AI",
      searchType: "Latest",
      batch,
    });
    await test.client.fetchSearchTimeline({
      apiKey: API_KEY,
      query: "AI",
      searchType: "Top",
      batch,
    });
    await test.client.releaseBatch(batch);

    expect(test.reserve).toHaveBeenCalledOnce();
    expect(test.reserve).toHaveBeenCalledWith(2);
    expect(test.markAttempted).toHaveBeenCalledTimes(2);
    expect(test.releaseUnused).toHaveBeenCalledOnce();
  });

  it("rejects forged, cross-client, exhausted, and released batch handles before transport", async () => {
    const owner = createHarness();
    const other = createHarness();
    const forged = {} as TikHubBatchHandle;

    await expect(
      owner.client.fetchSearchTimeline({
        apiKey: API_KEY,
        query: "AI",
        searchType: "Latest",
        batch: forged,
      }),
    ).rejects.toMatchObject({ code: "invalid-batch" });
    expect(owner.transport).not.toHaveBeenCalled();

    const batch = await owner.client.reserveBatch(2);
    await expect(
      other.client.fetchSearchTimeline({
        apiKey: API_KEY,
        query: "AI",
        searchType: "Latest",
        batch,
      }),
    ).rejects.toMatchObject({ code: "invalid-batch" });
    expect(other.transport).not.toHaveBeenCalled();
    expect(other.reserve).not.toHaveBeenCalled();

    for (const searchType of ["Latest", "Top"] as const) {
      await owner.client.fetchSearchTimeline({
        apiKey: API_KEY,
        query: "AI",
        searchType,
        batch,
      });
    }
    await expect(
      owner.client.fetchSearchTimeline({
        apiKey: API_KEY,
        query: "AI",
        searchType: "Latest",
        batch,
      }),
    ).rejects.toMatchObject({ code: "invalid-batch" });
    expect(owner.transport).toHaveBeenCalledTimes(2);

    await owner.client.releaseBatch(batch);
    await expect(owner.client.releaseBatch(batch)).rejects.toMatchObject({
      code: "invalid-batch",
    });
    await expect(
      owner.client.fetchSearchTimeline({
        apiKey: API_KEY,
        query: "AI",
        searchType: "Latest",
        batch,
      }),
    ).rejects.toMatchObject({ code: "invalid-batch" });
    expect(owner.transport).toHaveBeenCalledTimes(2);
  });

  it("fails closed and releases a malformed reserve-two result with total one", async () => {
    const test = createHarness();
    const releaseUnused = vi.fn(async () => 1);
    test.reserve.mockResolvedValueOnce({
      total: 1,
      remaining: 1,
      markAttempted: vi.fn(),
      releaseUnused,
    });

    await expect(test.client.reserveBatch(2)).rejects.toMatchObject({
      code: "invalid-batch",
    });
    expect(releaseUnused).toHaveBeenCalledOnce();
    expect(test.transport).not.toHaveBeenCalled();
  });

  it("revalidates a batch remaining snapshot as a safe positive integer before transport", async () => {
    const test = createHarness();
    const reservation = {
      total: 2,
      remaining: 2,
      markAttempted: vi.fn(),
      releaseUnused: vi.fn(async () => 0),
    };
    test.reserve.mockResolvedValueOnce(reservation);
    const batch = await test.client.reserveBatch(2);
    reservation.remaining = Number.NaN;

    await expect(
      test.client.fetchSearchTimeline({
        apiKey: API_KEY,
        query: "AI",
        searchType: "Latest",
        batch,
      }),
    ).rejects.toMatchObject({ code: "invalid-batch" });
    expect(test.transport).not.toHaveBeenCalled();
  });

  it("sanitizes a hostile transport error whose status accessor throws secret data", async () => {
    const test = createHarness();
    const secretError = new Error(
      `transport leaked ${API_KEY} https://api.tikhub.dev/path?keyword=private`,
    );
    Object.defineProperty(secretError, "status", {
      get() {
        throw secretError;
      },
    });
    test.transport.mockRejectedValueOnce(secretError);

    const error = await test.client
      .fetchUserPosts({ apiKey: API_KEY, handle: "private-handle" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TikHubClientError);
    expect(error).toMatchObject({ code: "network-failure" });
    expect(String(error)).not.toContain(API_KEY);
    expect(String(error)).not.toContain("private-handle");
    expect(String(error)).not.toContain("keyword=private");
  });

  it("does not trust a transport-supplied TikHubClientError message", async () => {
    const test = createHarness();
    test.transport.mockRejectedValueOnce(
      new TikHubClientError(
        "provider-rejected",
        `transport leaked ${API_KEY} for private-handle`,
      ),
    );

    const error = await test.client
      .fetchUserPosts({ apiKey: API_KEY, handle: "private-handle" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TikHubClientError);
    expect(error).toMatchObject({ code: "network-failure" });
    expect(String(error)).not.toContain(API_KEY);
    expect(String(error)).not.toContain("private-handle");
  });

  it.each(["status", "headers", "text"] as const)(
    "maps a resolved response %s getter to a static typed error",
    async (property) => {
      const test = createHarness();
      const response: Record<string, unknown> = {
        status: 200,
        headers: {},
        text: JSON.stringify({ code: 200, data: {} }),
      };
      let getterCalls = 0;
      Object.defineProperty(response, property, {
        enumerable: true,
        get() {
          getterCalls += 1;
          throw new Error(`getter leaked ${API_KEY} for private-handle`);
        },
      });
      test.transport.mockResolvedValueOnce(
        response as unknown as Awaited<ReturnType<TikHubTransport>>,
      );

      const error = await test.client
        .fetchUserPosts({ apiKey: API_KEY, handle: "private-handle" })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(TikHubClientError);
      expect(error).toMatchObject({ code: "malformed-response" });
      expect(String(error)).not.toContain(API_KEY);
      expect(JSON.stringify(error)).not.toContain(API_KEY);
      expect(getterCalls).toBe(0);
    },
  );

  it("maps a resolved response header-value getter to a static typed error", async () => {
    const test = createHarness();
    const headers: Record<string, string> = {};
    let getterCalls = 0;
    Object.defineProperty(headers, "x-request-id", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error(`header getter leaked ${API_KEY}`);
      },
    });
    test.transport.mockResolvedValueOnce({
      status: 200,
      headers,
      text: JSON.stringify({ code: 200, data: {} }),
    });

    const error = await test.client
      .fetchUserPosts({ apiKey: API_KEY, handle: "private-handle" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TikHubClientError);
    expect(error).toMatchObject({ code: "malformed-response" });
    expect(String(error)).not.toContain(API_KEY);
    expect(JSON.stringify(error)).not.toContain(API_KEY);
    expect(getterCalls).toBe(0);
  });

  it("maps a malicious transport thenable getter to a static typed error", async () => {
    const test = createHarness();
    const thenable = {};
    Object.defineProperty(thenable, "then", {
      get() {
        throw new TikHubClientError(
          "provider-rejected",
          `then getter leaked ${API_KEY} for private-handle`,
        );
      },
    });
    test.transport.mockImplementationOnce(
      () => thenable as Promise<Awaited<ReturnType<TikHubTransport>>>,
    );

    const error = await test.client
      .fetchUserPosts({ apiKey: API_KEY, handle: "private-handle" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TikHubClientError);
    expect(error).toMatchObject({ code: "network-failure" });
    expect(String(error)).not.toContain(API_KEY);
    expect(JSON.stringify(error)).not.toContain(API_KEY);
  });

  it("releases the reservation when transport throws before a network attempt", async () => {
    const test = createHarness();
    test.transport.mockImplementationOnce(() => {
      throw new TikHubClientError(
        "provider-rejected",
        `transport leaked ${API_KEY} for private-handle`,
      );
    });

    const error = await test.client
      .fetchUserPosts({ apiKey: API_KEY, handle: "private-handle" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TikHubClientError);
    expect(error).toMatchObject({ code: "network-failure" });
    expect(String(error)).not.toContain(API_KEY);
    expect(test.markAttempted).not.toHaveBeenCalled();
    expect(test.releaseUnused).toHaveBeenCalledTimes(1);
  });

  it.each([
    [401, "invalid-key"],
    [403, "invalid-key"],
    [402, "insufficient-balance"],
    [429, "rate-limited"],
    [422, "invalid-query"],
    [500, "provider-failure"],
    [503, "provider-failure"],
  ])("maps HTTP %i to a typed sanitized %s error", async (status, code) => {
    const response = {
      status,
      text: `provider leaked ${API_KEY} https://api.tikhub.dev/path?keyword=private`,
      headers: {},
    };
    const test = createHarness(response);

    const error = await test.client
      .fetchUserPosts({ apiKey: API_KEY, handle: "private-handle" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TikHubClientError);
    expect(error).toMatchObject({ code, status });
    expect(String(error)).not.toContain(API_KEY);
    expect(String(error)).not.toContain("private-handle");
    expect(String(error)).not.toContain("keyword=private");
    expect(test.markAttempted).toHaveBeenCalledTimes(1);
    expect(test.releaseUnused).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed JSON with a typed sanitized error", async () => {
    const test = createHarness({ status: 200, text: "not json", headers: {} });

    await expect(
      test.client.fetchUserPosts({ apiKey: API_KEY, handle: "openai" }),
    ).rejects.toMatchObject({ code: "malformed-response", status: 200 });
  });

  it("maps a non-200 provider envelope without exposing the provider body", async () => {
    const test = createHarness({
      status: 200,
      text: JSON.stringify({
        code: 429,
        message: `secret ${API_KEY}`,
        request_id: "req-safe",
      }),
      headers: {},
    });

    const error = await test.client
      .fetchUserPosts({ apiKey: API_KEY, handle: "openai" })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "rate-limited",
      status: 429,
      requestId: "req-safe",
    });
    expect(String(error)).not.toContain(API_KEY);
  });

  it("omits an unsafe provider request ID", async () => {
    const test = createHarness(success({}, `request ${API_KEY}`));

    await expect(
      test.client.fetchUserPosts({ apiKey: API_KEY, handle: "openai" }),
    ).resolves.toEqual({ data: {} });
  });

  it.each([
    {
      name: "successful body",
      response: success({}, `req-${API_KEY}-body`),
      expectedCode: undefined,
    },
    {
      name: "successful header",
      response: {
        status: 200,
        text: JSON.stringify({ code: 200, data: {} }),
        headers: { "x-request-id": `req-${API_KEY}-header` },
      },
      expectedCode: undefined,
    },
    {
      name: "provider-error body",
      response: {
        status: 200,
        text: JSON.stringify({
          code: 429,
          request_id: `req-${API_KEY}-body`,
        }),
        headers: {},
      },
      expectedCode: "rate-limited",
    },
    {
      name: "provider-error header",
      response: {
        status: 429,
        text: "provider rejected",
        headers: { "x-request-id": `req-${API_KEY}-header` },
      },
      expectedCode: "rate-limited",
    },
  ])("never returns the current API key through a $name request ID", async ({
    response,
    expectedCode,
  }) => {
    const test = createHarness(response);

    const outcome = await test.client
      .fetchUserPosts({ apiKey: API_KEY, handle: "openai" })
      .catch((error: unknown) => error);

    if (expectedCode) expect(outcome).toMatchObject({ code: expectedCode });
    expect((outcome as { requestId?: string }).requestId).toBeUndefined();
    expect(JSON.stringify(outcome)).not.toContain(API_KEY);
  });

  it("times out a pending request with a typed error while counting the network attempt", async () => {
    vi.useFakeTimers();
    const test = createHarness();
    test.transport.mockImplementationOnce(() => new Promise(() => undefined));
    const promise = test.client.fetchUserPosts({ apiKey: API_KEY, handle: "openai" });
    const assertion = expect(promise).rejects.toMatchObject({ code: "timeout" });

    await vi.advanceTimersByTimeAsync(20_000);

    await assertion;
    expect(test.markAttempted).toHaveBeenCalledTimes(1);
    expect(test.releaseUnused).toHaveBeenCalledTimes(1);
  });

  it("maps an AbortSignal to a typed abort error while counting an attempted request", async () => {
    const test = createHarness();
    test.transport.mockImplementationOnce(() => new Promise(() => undefined));
    const controller = new AbortController();
    const promise = test.client.fetchUserPosts({
      apiKey: API_KEY,
      handle: "openai",
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(test.markAttempted).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(promise).rejects.toMatchObject({ code: "aborted" });
    expect(test.markAttempted).toHaveBeenCalledTimes(1);
    expect(test.releaseUnused).toHaveBeenCalledTimes(1);
  });

  it("releases a reservation when cancellation wins before the transport is invoked", async () => {
    const controller = new AbortController();
    const test = createHarness();
    test.reserve.mockImplementationOnce(async () => {
      controller.abort();
      return {
        total: 1,
        remaining: 1,
        markAttempted: test.markAttempted,
        releaseUnused: test.releaseUnused,
      };
    });

    await expect(
      test.client.fetchUserPosts({
        apiKey: API_KEY,
        handle: "openai",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(test.transport).not.toHaveBeenCalled();
    expect(test.markAttempted).not.toHaveBeenCalled();
    expect(test.releaseUnused).toHaveBeenCalledTimes(1);
  });

  it("does not reserve or call the network for a blank method-scoped API key", async () => {
    const test = createHarness();

    await expect(
      test.client.fetchUserPosts({ apiKey: "   ", handle: "openai" }),
    ).rejects.toMatchObject({ code: "missing-key" });
    expect(test.reserve).not.toHaveBeenCalled();
    expect(test.transport).not.toHaveBeenCalled();
  });

  it.each([
    "http://api.example.com",
    "https://api.example.com/path",
    "https://api.example.com/a/..",
    "https://api.example.com/%2e%2e",
    "https://api.example.com\\..",
    "https://api.example.com?query=1",
    "https://api.example.com#fragment",
    "https://user:password@api.example.com",
  ])("rejects a custom base URL that is not an HTTPS origin: %s", (baseUrl) => {
    const test = createHarness();

    expect(
      () =>
        new TikHubClient({
          baseUrl,
          timeoutMs: 20_000,
          budget: test.budget,
          transport: test.transport,
        }),
    ).toThrow("HTTPS origin");
  });
});

describe("TikHub settings metadata", () => {
  const TIKHUB_SECRET_SENTINEL = "tikhub-secret-sentinel";

  it("defaults to the official primary API with bounded request limits", () => {
    expect(DEFAULT_SETTINGS.tikhub).toEqual({
      enabled: false,
      youtubeTranscriptFallbackEnabled: false,
      connectionId: "",
      baseUrl: "https://api.tikhub.io",
      timeoutMs: 20_000,
      maxRequestsPerRun: 40,
      maxRequestsPerDay: 100,
    });
  });

  it("normalizes persisted values and rejects non-origin base URLs", () => {
    const normalized = loadAndNormalizeSettings({
      tikhub: {
        enabled: true,
        connectionId: "d4eb3f58-b672-4f73-b9f3-9cd2f0e57a8d",
        baseUrl: "https://custom.example.com/",
        timeoutMs: 9_000,
        maxRequestsPerRun: 5,
        maxRequestsPerDay: 20,
      },
    });
    expect(normalized.tikhub).toEqual({
      enabled: true,
      youtubeTranscriptFallbackEnabled: false,
      connectionId: "d4eb3f58-b672-4f73-b9f3-9cd2f0e57a8d",
      baseUrl: "https://custom.example.com",
      timeoutMs: 9_000,
      maxRequestsPerRun: 5,
      maxRequestsPerDay: 20,
    });

    for (const baseUrl of [
      "http://custom.example.com",
      "https://custom.example.com/path",
      "https://custom.example.com?query=1",
      "https://custom.example.com#fragment",
    ]) {
      expect(
        loadAndNormalizeSettings({
          tikhub: { ...DEFAULT_SETTINGS.tikhub, enabled: true, baseUrl },
        }).tikhub,
      ).toEqual(DEFAULT_SETTINGS.tikhub);
    }
  });

  it("normalizes TikHub settings idempotently", () => {
    const first = loadAndNormalizeSettings({
      tikhub: {
        enabled: true,
        connectionId: "d4eb3f58-b672-4f73-b9f3-9cd2f0e57a8d",
        baseUrl: "https://custom.example.com/",
        timeoutMs: 9_000,
        maxRequestsPerRun: 5,
        maxRequestsPerDay: 20,
      },
    });

    expect(loadAndNormalizeSettings(first).tikhub).toEqual(first.tikhub);
  });

  it("removes scoped TikHub and AI secret aliases without touching unrelated top-level settings", () => {
    const raw = {
      tikhubApiKey: TIKHUB_SECRET_SENTINEL,
      TikHubApiKey: TIKHUB_SECRET_SENTINEL,
      TIKHUBBEARERTOKEN: TIKHUB_SECRET_SENTINEL,
      tikhubToken: TIKHUB_SECRET_SENTINEL,
      apiKey: "unrelated-top-level-key",
      token: "unrelated-top-level-token",
      ai: {
        apiKey: "ai-key-preserved",
        accessToken: "ai-token-preserved",
      },
      tikhub: {
        ...DEFAULT_SETTINGS.tikhub,
        apiKey: TIKHUB_SECRET_SENTINEL,
        token: TIKHUB_SECRET_SENTINEL,
        accessToken: TIKHUB_SECRET_SENTINEL,
        bearerToken: TIKHUB_SECRET_SENTINEL,
        APIKEY: TIKHUB_SECRET_SENTINEL,
        Bearer_Token: TIKHUB_SECRET_SENTINEL,
      },
    } as unknown as Partial<typeof DEFAULT_SETTINGS>;

    const normalized = loadAndNormalizeSettings(raw) as unknown as Record<
      string,
      unknown
    >;

    expect(normalized.tikhubApiKey).toBeUndefined();
    expect(normalized.TikHubApiKey).toBeUndefined();
    expect(normalized.TIKHUBBEARERTOKEN).toBeUndefined();
    expect(normalized.tikhubToken).toBeUndefined();
    expect(normalized.apiKey).toBe("unrelated-top-level-key");
    expect(normalized.token).toBe("unrelated-top-level-token");
    expect(normalized.ai).toEqual({ connections: [] });
    expect(JSON.stringify(normalized)).not.toContain(TIKHUB_SECRET_SENTINEL);
  });

  it("normalizes null-prototype TikHub settings without retaining aliases", () => {
    const tikhub = Object.assign(Object.create(null) as Record<string, unknown>, {
      enabled: true,
      connectionId: "d4eb3f58-b672-4f73-b9f3-9cd2f0e57a8d",
      baseUrl: "https://custom.example.com/",
      timeoutMs: 9_000,
      maxRequestsPerRun: 5,
      maxRequestsPerDay: 20,
      apiKey: TIKHUB_SECRET_SENTINEL,
      bearer_token: TIKHUB_SECRET_SENTINEL,
    });
    const raw = Object.assign(Object.create(null) as Record<string, unknown>, {
      tikhub,
      tikhubApiKey: TIKHUB_SECRET_SENTINEL,
    });

    const first = loadAndNormalizeSettings(
      raw as unknown as Partial<typeof DEFAULT_SETTINGS>,
    );
    const second = loadAndNormalizeSettings(first);

    expect(first.tikhub).toEqual({
      enabled: true,
      youtubeTranscriptFallbackEnabled: false,
      connectionId: "d4eb3f58-b672-4f73-b9f3-9cd2f0e57a8d",
      baseUrl: "https://custom.example.com",
      timeoutMs: 9_000,
      maxRequestsPerRun: 5,
      maxRequestsPerDay: 20,
    });
    expect(JSON.stringify(first)).not.toContain(TIKHUB_SECRET_SENTINEL);
    expect(second.tikhub).toEqual(first.tikhub);
  });

  it("ignores inherited TikHub settings and secret aliases", () => {
    const inherited = {
      enabled: true,
      connectionId: "d4eb3f58-b672-4f73-b9f3-9cd2f0e57a8d",
      baseUrl: "https://inherited.example.com",
      timeoutMs: 9_000,
      maxRequestsPerRun: 5,
      maxRequestsPerDay: 20,
      apiKey: TIKHUB_SECRET_SENTINEL,
    };
    const tikhub = Object.create(inherited) as Record<string, unknown>;

    const normalized = loadAndNormalizeSettings({
      tikhub,
    } as unknown as Partial<typeof DEFAULT_SETTINGS>);

    expect(normalized.tikhub).toEqual(DEFAULT_SETTINGS.tikhub);
    expect(JSON.stringify(normalized)).not.toContain(TIKHUB_SECRET_SENTINEL);
  });

  it("does not inherit TikHub secrets from an own __proto__ payload", () => {
    const raw = JSON.parse(
      `{"__proto__":{"tikhubApiKey":"${TIKHUB_SECRET_SENTINEL}"}}`,
    ) as Partial<typeof DEFAULT_SETTINGS>;

    const normalized = loadAndNormalizeSettings(raw) as unknown as Record<
      string,
      unknown
    >;

    expect(Object.getPrototypeOf(normalized)).toBe(Object.prototype);
    expect(normalized.tikhubApiKey).toBeUndefined();
    expect(JSON.stringify(normalized)).not.toContain(TIKHUB_SECRET_SENTINEL);
  });

  it("does not invoke a top-level TikHub secret alias accessor", () => {
    const raw: Record<string, unknown> = {
      tikhub: { ...DEFAULT_SETTINGS.tikhub },
    };
    let getterCalls = 0;
    Object.defineProperty(raw, "tikhubApiKey", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error(TIKHUB_SECRET_SENTINEL);
      },
    });

    const normalized = loadAndNormalizeSettings(
      raw as unknown as Partial<typeof DEFAULT_SETTINGS>,
    );

    expect(getterCalls).toBe(0);
    expect(JSON.stringify(normalized)).not.toContain(TIKHUB_SECRET_SENTINEL);
  });
});

describe("strict async track completion client compatibility", () => {
  it("accepts completed tracks only when the result job matches the requested job", async () => {
    const test = createHarness(success({
      job_id: "123e4567-e89b-12d3-a456-426614174000",
      status: "completed",
      video_id: "dQw4w9WgXcQ",
      captions: [{ language_code: "en", language_name: "English" }],
    }));

    await expect(test.client.fetchYouTubeCaptionResult({
      apiKey: API_KEY,
      jobId: "123e4567-e89b-12d3-a456-426614174000",
      format: "txt",
    })).resolves.toMatchObject({
      data: {
        job_id: "123e4567-e89b-12d3-a456-426614174000",
        status: "completed",
        video_id: "dQw4w9WgXcQ",
      },
    });
    expect(test.reserve).not.toHaveBeenCalled();
  });

  it("rejects completed tracks when the result job does not match", async () => {
    const test = createHarness(success({
      job_id: "87654321-e89b-12d3-a456-426614174000",
      status: "completed",
      video_id: "dQw4w9WgXcQ",
      captions: [],
    }));

    const error = await test.client.fetchYouTubeCaptionResult({
      apiKey: API_KEY,
      jobId: "123e4567-e89b-12d3-a456-426614174000",
      format: "txt",
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "malformed-response" });
    expect(String(error)).not.toContain("87654321");
    expect(test.reserve).not.toHaveBeenCalled();
  });
});
