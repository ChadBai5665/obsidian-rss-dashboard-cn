import type { Vault } from "obsidian";
import { describe, expect, it } from "vitest";
import { SourceRefreshLedger } from "../../../src/refresh/source-refresh-ledger";

class InMemoryAdapter {
  readonly files = new Map<string, string>();
  readonly directories = new Set<string>();

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.directories.has(path);
  }

  async read(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`Missing file: ${path}`);
    return content;
  }

  async write(path: string, content: string): Promise<void> {
    const separator = path.lastIndexOf("/");
    const parent = separator === -1 ? "" : path.slice(0, separator);
    if (parent && !this.directories.has(parent)) {
      throw new Error(`Missing parent directory: ${parent}`);
    }
    this.files.set(path, content);
  }

  async mkdir(path: string): Promise<void> {
    const separator = path.lastIndexOf("/");
    const parent = separator === -1 ? "" : path.slice(0, separator);
    if (parent && !this.directories.has(parent)) {
      throw new Error(`Missing parent directory: ${parent}`);
    }
    this.directories.add(path);
  }
}

function createLedger(): { adapter: InMemoryAdapter; ledger: SourceRefreshLedger } {
  const adapter = new InMemoryAdapter();
  const vault = { adapter } as unknown as Vault;
  return {
    adapter,
    ledger: new SourceRefreshLedger(vault, ".rss-dashboard-data"),
  };
}

async function persistErrorMessage(message: string): Promise<string> {
  const { adapter, ledger } = createLedger();
  await ledger.recordError("feed-1", new Date(2026, 6, 21, 9, 0, 0), {
    code: "request-failed",
    message,
  });
  return adapter.files.get(
    ".rss-dashboard-data/state/source-refresh.json",
  ) ?? "";
}

describe("SourceRefreshLedger", () => {
  it("stores source attempts and advances the local success date only on success", async () => {
    const { adapter, ledger } = createLedger();
    const attemptAt = new Date(2026, 6, 21, 9, 30, 0);
    const successAt = new Date(2026, 6, 21, 9, 31, 0);

    await ledger.recordAttempt("feed-1", attemptAt);
    await ledger.recordSuccess("feed-1", successAt);

    expect(await ledger.getState("feed-1")).toMatchObject({
      sourceId: "feed-1",
      status: "success",
      lastAttemptAt: attemptAt.toISOString(),
      lastSuccessAt: successAt.toISOString(),
      lastSuccessDate: "2026-07-21",
    });
    expect(adapter.files.get(".rss-dashboard-data/state/source-refresh.json")).toContain(
      '"feed-1"',
    );
  });

  it("keeps the last success date but makes a later failed attempt eligible for retry", async () => {
    const { ledger } = createLedger();
    await ledger.recordSuccess("feed-1", new Date(2026, 6, 21, 8, 0, 0));
    await ledger.recordError("feed-1", new Date(2026, 6, 21, 9, 0, 0), {
      code: "network",
      message: "Request failed",
    });

    expect(await ledger.getState("feed-1")).toMatchObject({
      status: "error",
      lastSuccessDate: "2026-07-21",
      errorCode: "network",
      errorMessage: "Request failed",
    });
    expect(await ledger.haveAllSourcesSucceededOnDate(["feed-1"], "2026-07-21")).toBe(
      false,
    );
  });

  it("returns only current sources that still need a local-day refresh", async () => {
    const { ledger } = createLedger();
    const today = new Date(2026, 6, 21, 9, 0, 0);

    await ledger.recordSuccess("succeeded-today", today);
    await ledger.recordSuccess("succeeded-yesterday", new Date(2026, 6, 20, 9, 0, 0));
    await ledger.recordAttempt("idle", today);
    await ledger.recordError("errored", today, {
      code: "network",
      message: "Retry me",
    });
    await ledger.recordError("deleted-source", today, {
      code: "network",
      message: "This source is no longer subscribed",
    });

    await expect(
      ledger.getDueSourceIds([
        "succeeded-today",
        "errored",
        "missing",
        "succeeded-yesterday",
        "idle",
      ], today),
    ).resolves.toEqual([
      "errored",
      "missing",
      "succeeded-yesterday",
      "idle",
    ]);
  });

  it("redacts URL queries and header-like secrets from persisted error messages", async () => {
    const { ledger } = createLedger();
    const message = `Authorization: Bearer super-secret-token; https://api.example.com/feed?api_key=secret&token=also-secret ${"x".repeat(400)}`;

    await ledger.recordError("feed-1", new Date(2026, 6, 21, 9, 0, 0), {
      code: "request-failed",
      message,
    });

    const state = await ledger.getState("feed-1");
    expect(state?.errorMessage).not.toContain("super-secret-token");
    expect(state?.errorMessage).not.toContain("api_key=secret");
    expect(state?.errorMessage).not.toContain("token=also-secret");
    expect(state?.errorMessage?.length).toBeLessThanOrEqual(300);
  });

  it("redacts every credential value from compound headers and relative URLs", async () => {
    const { adapter, ledger } = createLedger();
    const secretValues = [
      "cookie-session-secret",
      "cookie-refresh-secret",
      "digest-realm-secret",
      "digest-nonce-secret",
      "api-key-secret",
      "relative-query-secret",
      "parent-relative-secret",
      "bare-relative-secret",
    ];
    const message = [
      "Request /feed?session=relative-query-secret&lang=zh failed",
      "Retry ../feed?session=parent-relative-secret then feed?session=bare-relative-secret",
      "Cookie: session=cookie-session-secret; refresh=cookie-refresh-secret",
      "Authorization: Digest realm=digest-realm-secret, nonce=digest-nonce-secret, response=hash",
      "X-API-Key: api-key-secret",
    ].join("; ");

    await ledger.recordError("feed-1", new Date(2026, 6, 21, 9, 0, 0), {
      code: "request-failed",
      message,
    });

    const persisted = adapter.files.get(
      ".rss-dashboard-data/state/source-refresh.json",
    ) ?? "";
    for (const secret of secretValues) {
      expect(persisted).not.toContain(secret);
    }
    expect(persisted).not.toContain("/feed?");
  });

  it("redacts folded Authorization header continuations", async () => {
    const persisted = await persistErrorMessage(
      "Authorization: Digest realm=one,\n nonce=continuation-secret",
    );

    expect(persisted).not.toContain("continuation-secret");
    expect(persisted).toContain("Authorization: [redacted]");
  });

  it("redacts every query component from an absolute URL", async () => {
    const persisted = await persistErrorMessage(
      "Request https://example.com/feed?absolute-secret=1;absolute-continuation=2 failed",
    );

    expect(persisted).not.toContain("absolute-secret");
    expect(persisted).not.toContain("absolute-continuation");
    expect(persisted).toContain("https://example.com/feed");
  });

  it("redacts every query component from a root-relative URL", async () => {
    const persisted = await persistErrorMessage(
      "Request /feed?root-secret=1;root-continuation=2 failed",
    );

    expect(persisted).not.toContain("root-secret");
    expect(persisted).not.toContain("root-continuation");
    expect(persisted).toContain("Request /feed failed");
  });

  it("redacts a query from a path-relative URL", async () => {
    const persisted = await persistErrorMessage(
      "Request feed?path-secret=1 failed",
    );

    expect(persisted).not.toContain("path-secret");
    expect(persisted).toContain("Request feed failed");
  });

  it("redacts a query-only reference", async () => {
    const persisted = await persistErrorMessage(
      "Request ?query-only-secret=1 failed",
    );

    expect(persisted).not.toContain("query-only-secret");
    expect(persisted).toContain("Request failed");
  });

  it("does not lose a source state when independent refreshes finish together", async () => {
    const { ledger } = createLedger();

    await Promise.all([
      ledger.recordSuccess("feed-1", new Date(2026, 6, 21, 9, 0, 0)),
      ledger.recordSuccess("feed-2", new Date(2026, 6, 21, 9, 0, 0)),
    ]);

    expect(await ledger.getStates()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceId: "feed-1", status: "success" }),
        expect.objectContaining({ sourceId: "feed-2", status: "success" }),
      ]),
    );
  });

  it("does not lose state when two ledger instances share one vault path", async () => {
    const adapter = new InMemoryAdapter();
    const vault = { adapter } as unknown as Vault;
    const firstLedger = new SourceRefreshLedger(vault, ".rss-dashboard-data");
    const secondLedger = new SourceRefreshLedger(vault, ".rss-dashboard-data");

    await Promise.all([
      firstLedger.recordSuccess("feed-1", new Date(2026, 6, 21, 9, 0, 0)),
      secondLedger.recordSuccess("feed-2", new Date(2026, 6, 21, 9, 0, 0)),
    ]);

    expect(await firstLedger.getStates()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceId: "feed-1", status: "success" }),
        expect.objectContaining({ sourceId: "feed-2", status: "success" }),
      ]),
    );
  });

  it.each([
    "{",
    JSON.stringify({ schemaVersion: 2, sources: {} }),
    JSON.stringify({ schemaVersion: 1, sources: [] }),
  ])("self-heals invalid persisted ledger state: %s", async (invalidContent) => {
    const { adapter, ledger } = createLedger();
    adapter.directories.add(".rss-dashboard-data");
    adapter.directories.add(".rss-dashboard-data/state");
    adapter.files.set(
      ".rss-dashboard-data/state/source-refresh.json",
      invalidContent,
    );

    await ledger.recordSuccess("feed-1", new Date(2026, 6, 21, 9, 0, 0));

    const persisted = JSON.parse(
      adapter.files.get(".rss-dashboard-data/state/source-refresh.json") ?? "",
    ) as { schemaVersion: number; sources: Record<string, unknown> };
    expect(Array.isArray(persisted.sources)).toBe(false);
    expect(persisted).toMatchObject({
      schemaVersion: 1,
      sources: { "feed-1": { sourceId: "feed-1", status: "success" } },
    });
  });
});
