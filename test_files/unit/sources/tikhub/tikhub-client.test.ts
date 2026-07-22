import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TikHubClient,
  TikHubClientError,
  type TikHubTransport,
  type TikHubTransportRequest,
} from "../../../../src/sources/tikhub/tikhub-client";
import type {
  TikHubBudgetReservation,
  TikHubRequestBudgetLike,
} from "../../../../src/sources/tikhub/request-budget";
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
) {
  const markAttempted = vi.fn();
  const releaseUnused = vi.fn(async () => undefined);
  const reservation: TikHubBudgetReservation = {
    total: 1,
    remaining: 1,
    markAttempted,
    releaseUnused,
  };
  const reserve = vi.fn(async () => reservation);
  const budget: TikHubRequestBudgetLike = { reserve };
  const requests: TikHubTransportRequest[] = [];
  const transport = vi.fn<TikHubTransport>(async (request) => {
    requests.push(request);
    return response;
  });
  const client = new TikHubClient({
    baseUrl: "https://api.tikhub.dev",
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
  it.each([
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
  it("defaults to an optional disabled .dev connection with bounded request limits", () => {
    expect(DEFAULT_SETTINGS.tikhub).toEqual({
      enabled: false,
      connectionId: "",
      baseUrl: "https://api.tikhub.dev",
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
});
