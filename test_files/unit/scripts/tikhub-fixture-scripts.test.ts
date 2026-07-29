import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename as fsRename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureTikHubFixtures,
  cleanupInactiveTikHubFixtureSets,
  readActiveTikHubFixtureSet,
  writeTikHubFixtureSet,
} from "../../../scripts/capture-tikhub-fixtures.mjs";
import {
  assertTikHubFixtureSanitized,
  sanitizeTikHubFixture,
} from "../../../scripts/sanitize-tikhub-fixture.mjs";
import { parseTikHubTimeline } from "../../../src/sources/tikhub/tikhub-parser";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "rss-dashboard-tikhub-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function candidateFixture(id = "1") {
  return {
    code: 200,
    data: {
      timeline: {
        instructions: [
          {
            entries: [
              {
                entryId: `tweet-${id}`,
                content: {
                  itemContent: {
                    tweet_results: {
                      result: {
                        rest_id: id,
                        core: {
                          user_results: {
                            result: { legacy: { screen_name: "fixture_ai" } },
                          },
                        },
                        legacy: { full_text: `Fixture ${id}` },
                      },
                    },
                  },
                },
              },
            ],
          },
        ],
      },
    },
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("sanitizeTikHubFixture", () => {
  it("removes provider metadata, cursors, secrets, personal inputs, and volatile values", () => {
    const raw = {
      request_id: "request-secret",
      requestId: "request-secret-2",
      x_request_id: "request-secret-3",
      cache_url: "https://cache.invalid/private_handle",
      support: { ticket: "private keywords" },
      support_url: "https://support.invalid/private_handle",
      api_key: "api-secret",
      ApiKey: "api-secret-camel",
      access_token: "access-secret",
      bearerCredential: "bearer-secret",
      auth: "auth-secret",
      password: "password-secret",
      ClientSecret: "client-secret",
      PRIVATE_HANDLE: "personal value",
      "private+keywords": "personal key",
      data: {
        screen_name: "private_handle",
        query: "private keywords",
        query_url:
          "https://example.invalid/?q=private+keywords&encoded=private%20keywords&handle=PRIVATE_HANDLE",
        created_at: "Tue Jul 21 12:34:56 +0000 2026",
        instructions: [
          {
            entries: [
              { entryId: "cursor-bottom-secret", content: { value: "cursor-secret" } },
              {
                entryId: "tweet-safe",
                content: { text: "PRIVATE_HANDLE wrote about PRIVATE KEYWORDS" },
              },
            ],
          },
        ],
      },
    };

    const sanitized = sanitizeTikHubFixture(raw, {
      handle: "private_handle",
      query: "private keywords",
    });
    const serialized = JSON.stringify(sanitized);

    expect(serialized).not.toMatch(
      /request-secret|cache\.invalid|support|api-secret|access-secret|bearer-secret|auth-secret|password-secret|client-secret|cursor-secret|private_handle|private(?:\+|%20| )keywords/i,
    );
    expect(sanitized).toMatchObject({
      data: {
        screen_name: "fixture_account",
        query: "fixture_topic",
        created_at: "Mon Jan 01 00:00:00 +0000 2024",
      },
    });
    expect(serialized).toContain("tweet-safe");
    expect(serialized).not.toContain("cursor-bottom-secret");
  });

  it("fails closed on accessors, custom prototypes, cycles, and oversized arrays", () => {
    const accessor = {};
    Object.defineProperty(accessor, "value", {
      enumerable: true,
      get() {
        throw new Error("private accessor value");
      },
    });
    const customPrototype = Object.create({ inherited: "private prototype value" });
    customPrototype.safe = true;
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const oversized: unknown[] = [];
    oversized.length = 100_001;

    expect(() => sanitizeTikHubFixture(accessor)).toThrow(
      "TikHub fixture contains an unsafe object shape.",
    );
    expect(() => sanitizeTikHubFixture(customPrototype)).toThrow(
      "TikHub fixture contains an unsafe object shape.",
    );
    expect(() => sanitizeTikHubFixture(cycle)).toThrow(
      "TikHub fixture exceeds safe traversal limits.",
    );
    expect(() => sanitizeTikHubFixture(oversized)).toThrow(
      "TikHub fixture exceeds safe traversal limits.",
    );
  });

  it("checks raw and aliased names so personal inputs cannot erase secret markers", () => {
    const requestIdField = ["request", "id"].join("_");
    const cacheUrlField = ["cache", "url"].join("_");
    const handleCollision = sanitizeTikHubFixture(
      { [requestIdField]: "request-secret", note: requestIdField },
      { handle: "id" },
    );
    const queryCollision = sanitizeTikHubFixture(
      { access_token: "token-secret", note: "access_token" },
      { query: "token" },
    );
    const urlCollision = sanitizeTikHubFixture(
      { [cacheUrlField]: "https://cache.invalid/private", note: cacheUrlField },
      { handle: "url" },
    );

    expect(handleCollision).toEqual({ note: "[redacted]" });
    expect(queryCollision).toEqual({ note: "[redacted]" });
    expect(urlCollision).toEqual({ note: "[redacted]" });
    expect(() =>
      assertTikHubFixtureSanitized(
        { access_token: "token-secret", note: "access_token" },
        { query: "token" },
      ),
    ).toThrow("TikHub fixture sanitization verification failed.");
  });

  it("preserves structural ID keys when the handle alias is exactly id", () => {
    const raw = Object.assign(candidateFixture("123"), { id: "personal account" });
    const sanitized = sanitizeTikHubFixture(raw, { handle: "id" });
    const entry = sanitized.data.timeline.instructions[0].entries[0];
    const result = entry.content.itemContent.tweet_results.result;

    expect(sanitized.fixture_account).toBe("personal account");
    expect(entry.entryId).toBe("tweet-123");
    expect(result.rest_id).toBe("123");
    expect(parseTikHubTimeline(sanitized).posts).toMatchObject([
      { id: "123", authorHandle: "fixture_ai" },
    ]);
  });

  it("preserves expanded URL keys when the query alias is exactly url", () => {
    const raw = Object.assign(candidateFixture("456"), { url: "personal topic" });
    const result =
      raw.data.timeline.instructions[0].entries[0].content.itemContent.tweet_results
        .result;
    Object.assign(result.legacy, {
      entities: {
        urls: [{ expanded_url: "https://example.com/fixture-report" }],
      },
    });

    const sanitized = sanitizeTikHubFixture(raw, { query: "url" });
    const sanitizedResult =
      sanitized.data.timeline.instructions[0].entries[0].content.itemContent
        .tweet_results.result;

    expect(sanitized.fixture_topic).toBe("personal topic");
    expect(sanitizedResult.legacy.entities.urls[0]).toHaveProperty(
      "expanded_url",
      "https://example.com/fixture-report",
    );
    expect(parseTikHubTimeline(sanitized).posts[0]?.externalUrls).toEqual([
      "https://example.com/fixture-report",
    ]);
  });

  it("normalizes numeric and bigint volatile timestamps before write validation", () => {
    const raw = {
      created_at: 1_721_234_567_890,
      timestamp: 9_007_199_254_740_993n,
      response_time: 1e30,
    };
    const sanitized = sanitizeTikHubFixture(raw);

    expect(sanitized).toEqual({
      created_at: "Mon Jan 01 00:00:00 +0000 2024",
      timestamp: "2024-01-01T00:00:00.000Z",
      response_time: "2024-01-01T00:00:00.000Z",
    });
    expect(() => assertTikHubFixtureSanitized(raw)).toThrow(
      "TikHub fixture sanitization verification failed.",
    );
    expect(() => assertTikHubFixtureSanitized(sanitized)).not.toThrow();
  });
});

describe("captureTikHubFixtures", () => {
  it("documents exactly three potentially billable requests in --help", () => {
    const output = execFileSync(
      globalThis.process.execPath,
      ["scripts/capture-tikhub-fixtures.mjs", "--help"],
      { cwd: globalThis.process.cwd(), encoding: "utf8" },
    );

    expect(output).toContain("exactly 3 potentially billable requests");
    expect(output).toContain("TIKHUB_API_KEY");
  });

  it("rejects a missing environment key before checking git or sending a request", async () => {
    const root = await temporaryDirectory();
    const fetchImpl = vi.fn();
    const isDestinationDirty = vi.fn(async () => false);

    await expect(
      captureTikHubFixtures({
        apiKey: undefined,
        handle: "fixture_account",
        query: "fixture topic",
        destinationDir: join(root, "fixtures", "tikhub"),
        fetchImpl,
        isDestinationDirty,
        log: () => undefined,
      }),
    ).rejects.toThrow("TikHub API key is required.");
    expect(isDestinationDirty).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("makes account, Latest, and Top calls once and writes only sanitized fixtures", async () => {
    const root = await temporaryDirectory();
    const destinationDir = join(root, "fixtures", "tikhub");
    const calls: Array<{ url: string; authorization?: string }> = [];
    const logs: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("Authorization") ?? undefined,
      });
      const fixture = candidateFixture(String(calls.length));
      Object.assign(fixture.data, {
        screen_name: "private_handle",
        query: "private keywords",
        created_at: "volatile timestamp",
      });
      return new Response(
        JSON.stringify({ ...fixture, request_id: "provider-request-id" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await captureTikHubFixtures({
      apiKey: "api-secret",
      handle: "private_handle",
      query: "private keywords",
      cwd: root,
      destinationDir,
      fetchImpl,
      isDestinationDirty: async () => false,
      log: (message: string) => logs.push(message),
    });

    expect(result.requestCount).toBe(3);
    expect(calls).toHaveLength(3);
    expect(calls.map(({ url }) => new URL(url).pathname)).toEqual([
      "/api/v1/twitter/web/fetch_user_post_tweet",
      "/api/v1/twitter/web/fetch_search_timeline",
      "/api/v1/twitter/web/fetch_search_timeline",
    ]);
    expect(calls.every(({ url }) => new URL(url).origin === "https://api.tikhub.io"))
      .toBe(true);
    expect(calls.map(({ url }) => new URL(url).searchParams.get("search_type"))).toEqual([
      null,
      "Latest",
      "Top",
    ]);
    expect(calls.every(({ authorization }) => authorization === "Bearer api-secret")).toBe(
      true,
    );
    expect(await readdir(destinationDir)).toEqual(["captures", "current.json"]);
    const active = await readActiveTikHubFixtureSet(destinationDir);
    expect(active?.files).toEqual([
      "account-posts.json",
      "search-latest.json",
      "search-top.json",
    ]);
    expect(active?.statistics).toEqual({
      "account-posts.json": { candidateCount: 1 },
      "search-latest.json": { candidateCount: 1 },
      "search-top.json": { candidateCount: 1 },
    });
    const written = active?.fixtures.map((fixture: unknown) => JSON.stringify(fixture)) ?? [];
    const observableOutput = `${logs.join("\n")}\n${written.join("\n")}`;
    expect(observableOutput).not.toMatch(
      /api-secret|private_handle|private keywords|provider-request-id|Bearer|cache_url/,
    );
    expect(logs).toEqual([
      "TikHub fixture request 1 of 3 completed.",
      "TikHub fixture request 2 of 3 completed.",
      "TikHub fixture request 3 of 3 completed.",
      "Wrote 3 sanitized TikHub fixtures.",
    ]);
  });

  it("never invokes transport-supplied response accessors", async () => {
    const root = await temporaryDirectory();
    let getterCalls = 0;
    const response = {};
    for (const key of ["ok", "status", "json"]) {
      Object.defineProperty(response, key, {
        get() {
          getterCalls += 1;
          throw new Error("api-secret private_handle private keywords");
        },
      });
    }

    const error = await captureTikHubFixtures({
      apiKey: "api-secret",
      handle: "private_handle",
      query: "private keywords",
      cwd: root,
      destinationDir: join(root, "fixtures", "tikhub"),
      fetchImpl: async () => response,
      isDestinationDirty: async () => false,
      log: () => undefined,
    }).catch((caught: unknown) => caught);

    expect(getterCalls).toBe(0);
    expect(String(error)).toBe(
      "Error: TikHub fixture request 1 failed with status unknown.",
    );
    expect(String(error)).not.toMatch(/api-secret|private_handle|private keywords/);
  });

  it("makes all three calls but refuses to activate a shape with no candidates", async () => {
    const root = await temporaryDirectory();
    const destinationDir = join(root, "fixtures", "tikhub");
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 200, data: { instructions: [] } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await expect(
      captureTikHubFixtures({
        apiKey: "api-secret",
        handle: "fixture_ai",
        query: "fixture topic",
        cwd: root,
        destinationDir,
        fetchImpl,
        isDestinationDirty: async () => false,
        log: () => undefined,
      }),
    ).rejects.toThrow("TikHub fixture response contained no tweet candidates.");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    await expect(readdir(destinationDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("aborts before any request when the destination is dirty", async () => {
    const root = await temporaryDirectory();
    const fetchImpl = vi.fn();

    await expect(
      captureTikHubFixtures({
        apiKey: "api-secret",
        handle: "private_handle",
        query: "private keywords",
        cwd: root,
        destinationDir: join(root, "fixtures", "tikhub"),
        fetchImpl,
        isDestinationDirty: async () => true,
        log: () => undefined,
      }),
    ).rejects.toThrow("TikHub fixture destination has uncommitted changes.");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses the real git preflight before calling the provider", async () => {
    const root = await temporaryDirectory();
    const destinationDir = join(root, "test_files", "fixtures", "tikhub");
    await mkdir(destinationDir, { recursive: true });
    await writeFile(join(destinationDir, "account-posts.json"), "{}\n", "utf8");
    for (const args of [
      ["init", "--quiet"],
      ["config", "user.email", "fixture@example.invalid"],
      ["config", "user.name", "Fixture Test"],
      ["add", "."],
      ["commit", "--quiet", "-m", "fixture baseline"],
    ]) {
      execFileSync("git", args, { cwd: root, stdio: "ignore" });
    }
    await writeFile(
      join(destinationDir, "account-posts.json"),
      '{"dirty":true}\n',
      "utf8",
    );
    const fetchImpl = vi.fn();

    await expect(
      captureTikHubFixtures({
        apiKey: "api-secret",
        handle: "fixture_ai",
        query: "fixture topic",
        cwd: root,
        destinationDir,
        fetchImpl,
        log: () => undefined,
      }),
    ).rejects.toThrow("TikHub fixture destination has uncommitted changes.");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a symlinked destination segment before checking git or sending a request", async () => {
    const root = await temporaryDirectory();
    const outside = join(root, "outside");
    const linked = join(root, "linked");
    await mkdir(outside);
    await symlink(outside, linked, "dir");
    const fetchImpl = vi.fn();
    const isDestinationDirty = vi.fn(async () => false);

    await expect(
      captureTikHubFixtures({
        apiKey: "api-secret",
        handle: "fixture_ai",
        query: "fixture topic",
        cwd: root,
        destinationDir: join(linked, "tikhub"),
        fetchImpl,
        isDestinationDirty,
        log: () => undefined,
      }),
    ).rejects.toThrow("TikHub fixture destination path is unsafe.");
    expect(isDestinationDirty).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a symlinked repository root before sending a request", async () => {
    const root = await temporaryDirectory();
    const realRoot = join(root, "real-repository");
    const linkedRoot = join(root, "linked-repository");
    await mkdir(realRoot);
    await symlink(realRoot, linkedRoot, "dir");
    const fetchImpl = vi.fn();
    const isDestinationDirty = vi.fn(async () => false);

    await expect(
      captureTikHubFixtures({
        apiKey: "api-secret",
        handle: "fixture_ai",
        query: "fixture topic",
        cwd: linkedRoot,
        destinationDir: join(linkedRoot, "fixtures", "tikhub"),
        fetchImpl,
        isDestinationDirty,
        log: () => undefined,
      }),
    ).rejects.toThrow("TikHub fixture repository path is unsafe.");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("leaves no partial files and emits no input or key when a request fails", async () => {
    const root = await temporaryDirectory();
    const destinationDir = join(root, "fixtures", "tikhub");
    const fetchImpl = vi.fn(async () => {
      if (fetchImpl.mock.calls.length === 3) {
        return { ok: false, status: 500, json: async () => ({ api_key: "api-secret" }) };
      }
      return { ok: true, status: 200, json: async () => ({ code: 200, data: {} }) };
    });

    const error = await captureTikHubFixtures({
      apiKey: "api-secret",
      handle: "private_handle",
      query: "private keywords",
      cwd: root,
      destinationDir,
      fetchImpl,
      isDestinationDirty: async () => false,
      log: () => undefined,
    }).catch((caught: unknown) => caught);

    expect(String(error)).toBe("Error: TikHub fixture request 3 failed with status 500.");
    expect(String(error)).not.toMatch(/api-secret|private_handle|private keywords|https?:/);
    await expect(readdir(destinationDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("TikHub raw capture fixture safety", () => {
  for (const prohibitedField of [
    "Authorization",
    "raw_response",
    "raw_payload",
  ]) {
    it(`rejects a nested ${prohibitedField} field before sanitizing or creating fixtures`, async () => {
      const root = await temporaryDirectory();
      const destinationDir = join(root, "fixtures", "tikhub");
      const logs: string[] = [];
      const raw = Object.assign(candidateFixture("capture"), {
        nested: [{ [prohibitedField]: candidateFixture("private") }],
      });
      const fetchImpl = vi.fn(
        async () =>
          new Response(JSON.stringify(raw), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      );

      const captureInput = {
        apiKey: ["fixture", "key"].join("-"),
        handle: "fixture_ai",
        query: "fixture topic",
        cwd: root,
        destinationDir,
        fetchImpl,
        isDestinationDirty: async () => false,
        log: (message: string) => logs.push(message),
      };
      const error = await captureTikHubFixtures(captureInput).catch(
        (caught: unknown) => caught,
      );

      expect(String(error)).toBe(
        "Error: TikHub fixture response contains prohibited raw data.",
      );
      expect(String(error)).not.toContain(captureInput.apiKey);
      expect(String(error)).not.toContain("private");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(logs).toEqual([]);
      await expect(readdir(destinationDir)).rejects.toMatchObject({ code: "ENOENT" });
    });
  }
});

describe("TikHub fixture copy-on-write activation", () => {
  it("rejects Authorization values before creating files", async () => {
    const root = await temporaryDirectory();
    const destinationDir = join(root, "live");
    const authorizationField = ["Author", "ization"].join("");
    const authorizationBearingFixture = Object.assign(candidateFixture("9"), {
      [authorizationField]: "fixture",
    });

    await expect(
      writeTikHubFixtureSet(destinationDir, [
        authorizationBearingFixture,
        candidateFixture("10"),
        candidateFixture("11"),
      ]),
    ).rejects.toThrow("TikHub fixture sanitization verification failed.");
    await expect(readdir(destinationDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects raw provider response wrappers before creating files", async () => {
    const root = await temporaryDirectory();
    const destinationDir = join(root, "live");
    const rawProviderResponse = Object.assign(candidateFixture("12"), {
      raw_response: candidateFixture("13"),
    });

    await expect(
      writeTikHubFixtureSet(destinationDir, [
        rawProviderResponse,
        candidateFixture("14"),
        candidateFixture("15"),
      ]),
    ).rejects.toThrow("TikHub fixture sanitization verification failed.");
    await expect(readdir(destinationDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects raw provider payload wrappers before creating files", async () => {
    const root = await temporaryDirectory();
    const destinationDir = join(root, "live");
    const rawProviderPayload = Object.assign(candidateFixture("16"), {
      raw_payload: candidateFixture("17"),
    });

    await expect(
      writeTikHubFixtureSet(destinationDir, [
        rawProviderPayload,
        candidateFixture("18"),
        candidateFixture("19"),
      ]),
    ).rejects.toThrow("TikHub fixture sanitization verification failed.");
    await expect(readdir(destinationDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a non-canonical credential-bearing set before creating files", async () => {
    const root = await temporaryDirectory();
    const destinationDir = join(root, "live");

    await expect(
      writeTikHubFixtureSet(destinationDir, [
        { bearerCredential: "private token" },
        {},
        {},
      ]),
    ).rejects.toThrow("TikHub fixture sanitization verification failed.");
    await expect(readdir(destinationDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves the old active set when manifest activation and cleanup both fail", async () => {
    const root = await temporaryDirectory();
    const destinationDir = join(root, "live");
    const oldCaptureDir = join(destinationDir, "captures", "old-capture");
    const fixtureNames = [
      "account-posts.json",
      "search-latest.json",
      "search-top.json",
    ];
    await mkdir(oldCaptureDir, { recursive: true });
    for (const name of fixtureNames) {
      await writeFile(
        join(oldCaptureDir, name),
        `${JSON.stringify(candidateFixture("1"))}\n`,
        "utf8",
      );
    }
    await writeFile(
      join(destinationDir, "current.json"),
      `${JSON.stringify({
        version: 2,
        activeVersion: "old-capture",
        files: fixtureNames,
        statistics: Object.fromEntries(
          fixtureNames.map((name) => [name, { candidateCount: 1 }]),
        ),
      })}\n`,
      "utf8",
    );

    let cleanupFailureInjected = false;
    const fsOps = {
      rename: async (from: string, to: string) => {
        if (to === join(destinationDir, "current.json")) {
          throw new Error("injected manifest rename failure");
        }
        await fsRename(from, to);
      },
      rm: async (path: string, options: { recursive?: boolean; force?: boolean }) => {
        if (
          !cleanupFailureInjected &&
          path === join(destinationDir, "captures", "new-capture")
        ) {
          cleanupFailureInjected = true;
          throw new Error("injected cleanup failure");
        }
        await rm(path, options);
      },
    };

    await expect(
      writeTikHubFixtureSet(
        destinationDir,
        fixtureNames.map(() => candidateFixture("2")),
        { captureId: "new-capture", fsOps },
      ),
    ).rejects.toThrow("TikHub fixture activation failed.");

    const active = await readActiveTikHubFixtureSet(destinationDir);
    expect(active?.fixtures).toEqual(fixtureNames.map(() => candidateFixture("1")));
    expect(await readdir(join(destinationDir, "captures", "new-capture"))).toEqual(
      fixtureNames,
    );
    for (const name of fixtureNames) {
      await expect(readFile(join(destinationDir, name), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    }

    await cleanupInactiveTikHubFixtureSets(destinationDir);
    expect(await readdir(join(destinationDir, "captures"))).toEqual(["old-capture"]);
  });
});
