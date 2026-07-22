import type { Vault } from "obsidian";
import { describe, expect, it } from "vitest";
import {
  TikHubRequestLedger,
  TikHubRequestLedgerError,
} from "../../../../src/sources/tikhub/request-ledger";

const DATA_FOLDER = ".rss-dashboard-data";
const STATE_FOLDER = `${DATA_FOLDER}/state`;
const LEDGER_PATH = `${STATE_FOLDER}/tikhub-requests.json`;

interface InMemoryStorage {
  files: Map<string, string>;
  directories: Set<string>;
}

class InMemoryAdapter {
  readonly files: Map<string, string>;
  readonly directories: Set<string>;
  readonly operations: string[] = [];

  constructor(
    storage: InMemoryStorage = {
      files: new Map<string, string>(),
      directories: new Set<string>(),
    },
  ) {
    this.files = storage.files;
    this.directories = storage.directories;
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.directories.has(path);
  }

  async read(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return value;
  }

  async write(path: string, content: string): Promise<void> {
    this.operations.push(`write:${path}`);
    const separator = path.lastIndexOf("/");
    const parent = separator === -1 ? "" : path.slice(0, separator);
    if (parent && !this.directories.has(parent)) throw new Error(`Missing parent: ${parent}`);
    this.files.set(path, content);
  }

  async mkdir(path: string): Promise<void> {
    this.operations.push(`mkdir:${path}`);
    const separator = path.lastIndexOf("/");
    const parent = separator === -1 ? "" : path.slice(0, separator);
    if (parent && !this.directories.has(parent)) throw new Error(`Missing parent: ${parent}`);
    this.directories.add(path);
  }

  async rename(from: string, to: string): Promise<void> {
    this.operations.push(`rename:${from}:${to}`);
    const value = this.files.get(from);
    if (value === undefined) throw new Error(`Missing source: ${from}`);
    this.files.delete(from);
    this.files.set(to, value);
  }

  async remove(path: string): Promise<void> {
    this.operations.push(`remove:${path}`);
    this.files.delete(path);
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const prefix = `${path}/`;
    return {
      files: [...this.files.keys()].filter(
        (candidate) =>
          candidate.startsWith(prefix) &&
          !candidate.slice(prefix.length).includes("/"),
      ),
      folders: [...this.directories].filter(
        (candidate) =>
          candidate.startsWith(prefix) &&
          !candidate.slice(prefix.length).includes("/"),
      ),
    };
  }
}

function createLedger(
  adapter = new InMemoryAdapter(),
  now = new Date(2026, 6, 22, 9, 0, 0),
  storageIdentity = "vault:test-storage",
  randomSuffix = "fixed",
) {
  const vault = { adapter } as unknown as Vault;
  return {
    adapter,
    ledger: new TikHubRequestLedger(vault, DATA_FOLDER, {
      now: () => now,
      randomSuffix: () => randomSuffix,
      storageIdentity,
    }),
  };
}

describe("TikHubRequestLedger", () => {
  it.each([
    "",
    " vault:shared",
    "vault/shared",
    "vault:shared?query",
    "vault:shared#fragment",
    "x".repeat(129),
  ])("rejects an unsafe storage lock identity: %s", (storageIdentity) => {
    const adapter = new InMemoryAdapter();
    const vault = { adapter } as unknown as Vault;

    expect(
      () =>
        new TikHubRequestLedger(vault, DATA_FOLDER, {
          storageIdentity,
        }),
    ).toThrow("storage identity");
  });

  it("persists only the local date and aggregate count", async () => {
    const test = createLedger();

    await test.ledger.reserve(2, 10);

    expect(JSON.parse(test.adapter.files.get(LEDGER_PATH) ?? "null")).toEqual({
      localDate: "2026-07-22",
      count: 2,
    });
    const persisted = test.adapter.files.get(LEDGER_PATH) ?? "";
    for (const forbidden of [
      "endpoint",
      "handle",
      "keyword",
      "query",
      "url",
      "secret",
      "response",
    ]) {
      expect(persisted.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("resets the aggregate count when the local calendar date changes", async () => {
    const adapter = new InMemoryAdapter();
    adapter.directories.add(DATA_FOLDER);
    adapter.directories.add(STATE_FOLDER);
    adapter.files.set(LEDGER_PATH, JSON.stringify({ localDate: "2026-07-21", count: 9 }));
    const test = createLedger(adapter);

    await test.ledger.reserve(1, 10);

    expect(await test.ledger.getSnapshot()).toEqual({
      localDate: "2026-07-22",
      count: 1,
    });
  });

  it("rejects the complete reservation without writing when it exceeds the daily cap", async () => {
    const test = createLedger();
    await test.ledger.reserve(8, 10);
    const before = test.adapter.files.get(LEDGER_PATH);

    await expect(test.ledger.reserve(3, 10)).rejects.toMatchObject({
      name: "TikHubRequestLedgerError",
      code: "daily-limit",
    });
    expect(test.adapter.files.get(LEDGER_PATH)).toBe(before);
  });

  it("keeps attempted calls counted and atomically releases only unused reservations", async () => {
    const test = createLedger();
    const reservation = await test.ledger.reserve(3, 10);

    reservation.markAttempted();
    await reservation.releaseUnused();

    expect(await test.ledger.getSnapshot()).toEqual({
      localDate: "2026-07-22",
      count: 1,
    });
    expect(reservation.remaining).toBe(0);
  });

  it("releases one reservation at most once when cleanup races", async () => {
    const test = createLedger();
    const reservation = await test.ledger.reserve(3, 10);
    reservation.markAttempted();

    const released = await Promise.all([
      reservation.releaseUnused(),
      reservation.releaseUnused(),
    ]);

    expect(released.sort()).toEqual([0, 2]);
    expect(await test.ledger.getSnapshot()).toEqual({
      localDate: "2026-07-22",
      count: 1,
    });
  });

  it("serializes concurrent reservations across ledger instances sharing one adapter", async () => {
    const adapter = new InMemoryAdapter();
    const first = createLedger(adapter).ledger;
    const second = createLedger(adapter).ledger;

    const outcomes = await Promise.allSettled([
      first.reserve(7, 10),
      second.reserve(7, 10),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(JSON.parse(adapter.files.get(LEDGER_PATH) ?? "null")).toEqual({
      localDate: "2026-07-22",
      count: 7,
    });
  });

  it("serializes concurrent reservations across adapters for one storage target", async () => {
    const storage: InMemoryStorage = {
      files: new Map<string, string>(),
      directories: new Set<string>(),
    };
    const firstAdapter = new InMemoryAdapter(storage);
    const secondAdapter = new InMemoryAdapter(storage);
    const first = createLedger(
      firstAdapter,
      new Date(2026, 6, 22, 9, 0, 0),
      "vault:shared-storage",
      "first",
    ).ledger;
    const second = createLedger(
      secondAdapter,
      new Date(2026, 6, 22, 9, 0, 0),
      "vault:shared-storage",
      "second",
    ).ledger;

    const outcomes = await Promise.allSettled([
      first.reserve(7, 10),
      second.reserve(7, 10),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );
    expect(rejected?.reason).toMatchObject({ code: "daily-limit" });
    expect(JSON.parse(storage.files.get(LEDGER_PATH) ?? "null")).toEqual({
      localDate: "2026-07-22",
      count: 7,
    });
  });

  it("fails closed on dirty JSON and preserves the corrupt bytes", async () => {
    const adapter = new InMemoryAdapter();
    adapter.directories.add(DATA_FOLDER);
    adapter.directories.add(STATE_FOLDER);
    adapter.files.set(LEDGER_PATH, "{ dirty secret endpoint bytes");
    const test = createLedger(adapter);

    await expect(test.ledger.reserve(1, 10)).rejects.toMatchObject({
      name: "TikHubRequestLedgerError",
      code: "corrupt-ledger",
    });
    expect(test.adapter.files.get(LEDGER_PATH)).toBe("{ dirty secret endpoint bytes");
  });

  it("fails closed when an interrupted replacement leaves only a backup", async () => {
    const adapter = new InMemoryAdapter();
    adapter.directories.add(DATA_FOLDER);
    adapter.directories.add(STATE_FOLDER);
    adapter.files.set(
      `${LEDGER_PATH}.backup-orphaned`,
      JSON.stringify({ localDate: "2026-07-22", count: 9 }),
    );
    const test = createLedger(adapter);

    await expect(test.ledger.reserve(1, 10)).rejects.toMatchObject({
      name: "TikHubRequestLedgerError",
      code: "corrupt-ledger",
    });
    expect(adapter.files.has(LEDGER_PATH)).toBe(false);
  });

  it.each([
    { localDate: "2026-7-22", count: 1 },
    { localDate: "2026-02-30", count: 1 },
    { localDate: "2026-07-22", count: -1 },
    { localDate: "2026-07-22", count: 1, endpoint: "/private" },
  ])("rejects a malformed persisted schema without silently normalizing it", async (value) => {
    const adapter = new InMemoryAdapter();
    adapter.directories.add(DATA_FOLDER);
    adapter.directories.add(STATE_FOLDER);
    const raw = JSON.stringify(value);
    adapter.files.set(LEDGER_PATH, raw);
    const test = createLedger(adapter);

    await expect(test.ledger.getSnapshot()).rejects.toBeInstanceOf(TikHubRequestLedgerError);
    expect(adapter.files.get(LEDGER_PATH)).toBe(raw);
  });

  it("uses sibling temporary files and rename operations for durable writes", async () => {
    const test = createLedger();
    await test.ledger.reserve(1, 10);

    expect(test.adapter.operations).toContain(
      `write:${LEDGER_PATH}.tmp-fixed`,
    );
    expect(test.adapter.operations).toContain(
      `rename:${LEDGER_PATH}.tmp-fixed:${LEDGER_PATH}`,
    );
    expect(test.adapter.files.has(`${LEDGER_PATH}.tmp-fixed`)).toBe(false);
  });
});
