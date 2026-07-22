import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureTikHubFixtures } from "../../../scripts/capture-tikhub-fixtures.mjs";
import { sanitizeTikHubFixture } from "../../../scripts/sanitize-tikhub-fixture.mjs";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "rss-dashboard-tikhub-test-"));
  temporaryDirectories.push(directory);
  return directory;
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
      data: {
        screen_name: "private_handle",
        query: "private keywords",
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
      /request-secret|cache\.invalid|support|api-secret|cursor-secret|private_handle|private keywords/i,
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
      return {
        ok: true,
        status: 200,
        json: async () => ({
          code: 200,
          request_id: "provider-request-id",
          data: {
            screen_name: "private_handle",
            query: "private keywords",
            created_at: "volatile timestamp",
            instructions: [],
          },
        }),
      };
    });

    const result = await captureTikHubFixtures({
      apiKey: "api-secret",
      handle: "private_handle",
      query: "private keywords",
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
    expect(calls.map(({ url }) => new URL(url).searchParams.get("search_type"))).toEqual([
      null,
      "Latest",
      "Top",
    ]);
    expect(calls.every(({ authorization }) => authorization === "Bearer api-secret")).toBe(
      true,
    );
    expect(await readdir(destinationDir)).toEqual([
      "account-posts.json",
      "search-latest.json",
      "search-top.json",
    ]);

    const written = await Promise.all(
      ["account-posts.json", "search-latest.json", "search-top.json"].map(
        async (name) => await readFile(join(destinationDir, name), "utf8"),
      ),
    );
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

  it("aborts before any request when the destination is dirty", async () => {
    const root = await temporaryDirectory();
    const fetchImpl = vi.fn();

    await expect(
      captureTikHubFixtures({
        apiKey: "api-secret",
        handle: "private_handle",
        query: "private keywords",
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
