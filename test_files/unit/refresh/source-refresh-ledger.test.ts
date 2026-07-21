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
});
