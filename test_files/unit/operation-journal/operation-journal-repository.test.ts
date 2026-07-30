import type { DataAdapter, Vault } from "obsidian";
import { describe, expect, it } from "vitest";
import {
  OPERATION_JOURNAL_MAX_FILE_BYTES,
  OPERATION_JOURNAL_MAX_READ_EVENTS,
  OPERATION_JOURNAL_MAX_TOTAL_BYTES,
  OperationJournalRepository,
} from "../../../src/operation-journal/operation-journal-repository";
import type { OperationEvent } from "../../../src/operation-journal/operation-event";

const DATA_ROOT = ".rss-dashboard-data";
const STATE_DIRECTORY = `${DATA_ROOT}/state`;
const JOURNAL_DIRECTORY = `${STATE_DIRECTORY}/operation-journal`;

class InMemoryAdapter {
  readonly files = new Map<string, string>();
  readonly directories = new Set<string>();
  readonly sizes = new Map<string, number>();
  readonly operations: string[] = [];
  failNextList = false;
  failRemovePath: string | null = null;
  private appendBarrier: Promise<void> | null = null;
  private releaseAppendBarrier: (() => void) | null = null;

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.directories.has(path);
  }

  async mkdir(path: string): Promise<void> {
    this.operations.push(`mkdir:${path}`);
    const parent = parentPath(path);
    if (parent && !this.directories.has(parent)) {
      throw new Error("Missing parent directory");
    }
    this.directories.add(path);
  }

  async append(path: string, content: string): Promise<void> {
    this.operations.push(`append:${path}`);
    const previous = this.files.get(path);
    if (previous === undefined) throw new Error("Missing append target");
    if (this.appendBarrier !== null) await this.appendBarrier;
    await Promise.resolve();
    this.files.set(path, previous + content);
    this.sizes.delete(path);
  }

  async read(path: string): Promise<string> {
    this.operations.push(`read:${path}`);
    const content = this.files.get(path);
    if (content === undefined) throw new Error("Missing read target");
    return content;
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    this.operations.push(`list:${path}`);
    if (this.failNextList) {
      this.failNextList = false;
      throw new Error("Injected maintenance failure");
    }
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

  async stat(path: string) {
    if (this.files.has(path)) {
      return {
        type: "file",
        ctime: 0,
        mtime: 0,
        size: this.sizes.get(path) ?? byteLength(this.files.get(path) ?? ""),
      };
    }
    if (this.directories.has(path)) {
      return { type: "folder", ctime: 0, mtime: 0, size: 0 };
    }
    return null;
  }

  async remove(path: string): Promise<void> {
    this.operations.push(`remove:${path}`);
    if (this.failRemovePath === path) {
      this.failRemovePath = null;
      throw new Error("Injected remove failure");
    }
    if (!this.files.delete(path)) throw new Error("Missing remove target");
    this.sizes.delete(path);
  }

  pauseAppends(): () => void {
    this.appendBarrier = new Promise<void>((resolve) => {
      this.releaseAppendBarrier = resolve;
    });
    return () => {
      this.releaseAppendBarrier?.();
      this.appendBarrier = null;
      this.releaseAppendBarrier = null;
    };
  }
}

function createRepository(
  adapter = new InMemoryAdapter(),
  dataRoot = DATA_ROOT,
  vault = createVault(adapter),
): {
  adapter: InMemoryAdapter;
  repository: OperationJournalRepository;
  vault: Vault;
} {
  return {
    adapter,
    repository: new OperationJournalRepository(vault, dataRoot),
    vault,
  };
}

function createVault(adapter: InMemoryAdapter): Vault {
  return {
    adapter: adapter as unknown as DataAdapter,
    create: async (path: string, content: string) => {
      adapter.operations.push(`create:${path}`);
      if (adapter.files.has(path)) throw new Error("File already exists");
      if (!adapter.directories.has(parentPath(path))) {
        throw new Error("Missing create parent");
      }
      adapter.files.set(path, content);
      adapter.sizes.delete(path);
      return {};
    },
  } as unknown as Vault;
}

function seedJournal(adapter: InMemoryAdapter): void {
  adapter.directories.add(DATA_ROOT);
  adapter.directories.add(STATE_DIRECTORY);
  adapter.directories.add(JOURNAL_DIRECTORY);
}

function seedFile(
  adapter: InMemoryAdapter,
  date: string,
  content: string,
  size?: number,
): string {
  seedJournal(adapter);
  const path = `${JOURNAL_DIRECTORY}/${date}.jsonl`;
  adapter.files.set(path, content);
  if (size !== undefined) adapter.sizes.set(path, size);
  return path;
}

function createEvent(
  index: number,
  occurredAt: Date = new Date(2026, 6, 30, 12, 0, 0),
): OperationEvent {
  const suffix = String(index).padStart(12, "0");
  return {
    schemaVersion: 1,
    eventId: `10000000-0000-4000-8000-${suffix}`,
    operationId: `20000000-0000-4000-8000-${suffix}`,
    occurredAt: occurredAt.toISOString(),
    category: "refresh",
    action: "all",
    trigger: "manual",
    stage: "refreshing",
    status: "progress",
    subject: { sourceId: `source-${index}` },
    details: { total: index },
  };
}

function line(event: OperationEvent): string {
  return `${JSON.stringify(event)}\n`;
}

function parentPath(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator === -1 ? "" : path.slice(0, separator);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

describe("OperationJournalRepository append", () => {
  it("creates only the fixed data, state, journal, and local-day file paths", async () => {
    const test = createRepository();
    const localMorning = new Date(2026, 6, 31, 0, 5, 0);

    await expect(test.repository.append(createEvent(1, localMorning))).resolves.toEqual({
      maintenanceIncomplete: false,
    });

    expect(test.adapter.operations).toEqual([
      `mkdir:${DATA_ROOT}`,
      `mkdir:${STATE_DIRECTORY}`,
      `mkdir:${JOURNAL_DIRECTORY}`,
      `list:${JOURNAL_DIRECTORY}`,
      `create:${JOURNAL_DIRECTORY}/2026-07-31.jsonl`,
    ]);
    expect(test.adapter.files.get(`${JOURNAL_DIRECTORY}/2026-07-31.jsonl`)).toBe(
      line(createEvent(1, localMorning)),
    );
  });

  it("attempts retention once per local day across repository instances", async () => {
    const adapter = new InMemoryAdapter();
    const vault = createVault(adapter);
    const first = createRepository(adapter, DATA_ROOT, vault).repository;
    const second = createRepository(adapter, DATA_ROOT, vault).repository;

    await first.append(createEvent(1, new Date(2026, 6, 30, 9)));
    await second.append(createEvent(2, new Date(2026, 6, 30, 10)));
    await first.append(createEvent(3, new Date(2026, 6, 31, 0, 1)));

    expect(
      adapter.operations.filter((operation) => operation === `list:${JOURNAL_DIRECTORY}`),
    ).toHaveLength(2);
  });

  it("serializes concurrent appends across repository instances without losing lines", async () => {
    const adapter = new InMemoryAdapter();
    const vault = createVault(adapter);
    const first = createRepository(adapter, DATA_ROOT, vault).repository;
    const second = createRepository(adapter, DATA_ROOT, vault).repository;
    const occurredAt = new Date(2026, 6, 30, 12);
    await first.append(createEvent(1, occurredAt));
    const release = adapter.pauseAppends();

    const writes = Promise.all([
      first.append(createEvent(2, occurredAt)),
      second.append(createEvent(3, occurredAt)),
    ]);
    await Promise.resolve();
    release();
    await writes;

    const persisted = adapter.files
      .get(`${JOURNAL_DIRECTORY}/2026-07-30.jsonl`)
      ?.trim()
      .split("\n")
      .map((raw) => JSON.parse(raw) as OperationEvent);
    expect(persisted?.map((event) => event.eventId)).toEqual([
      createEvent(1, occurredAt).eventId,
      createEvent(2, occurredAt).eventId,
      createEvent(3, occurredAt).eventId,
    ]);
  });

  it("writes events from different local dates to different files", async () => {
    const test = createRepository();

    await test.repository.append(createEvent(1, new Date(2026, 6, 30, 23, 59)));
    await test.repository.append(createEvent(2, new Date(2026, 6, 31, 0, 1)));

    expect(test.adapter.files.has(`${JOURNAL_DIRECTORY}/2026-07-30.jsonl`)).toBe(true);
    expect(test.adapter.files.has(`${JOURNAL_DIRECTORY}/2026-07-31.jsonl`)).toBe(true);
  });

  it("continues append after prune failure and reports incomplete maintenance", async () => {
    const test = createRepository();
    seedJournal(test.adapter);
    test.adapter.failNextList = true;

    await expect(test.repository.append(createEvent(1))).resolves.toEqual({
      maintenanceIncomplete: true,
    });
    expect(test.adapter.files.has(`${JOURNAL_DIRECTORY}/2026-07-30.jsonl`)).toBe(true);
  });

  it("rejects an append failure even when maintenance succeeded", async () => {
    const adapter = new InMemoryAdapter();
    seedJournal(adapter);
    const vault = {
      ...createVault(adapter),
      create: async () => {
        throw new Error("Injected append failure");
      },
    } as unknown as Vault;
    const repository = createRepository(adapter, DATA_ROOT, vault).repository;

    await expect(repository.append(createEvent(1))).rejects.toThrow("Injected append failure");
  });
});

describe("OperationJournalRepository bounded reads", () => {
  it("ignores an unterminated final line and marks only that date incomplete", async () => {
    const test = createRepository();
    seedFile(test.adapter, "2026-07-30", line(createEvent(1)) + JSON.stringify(createEvent(2)));

    await expect(
      test.repository.readRange({ days: 7, now: new Date(2026, 6, 30, 18) }),
    ).resolves.toEqual({
      events: [createEvent(1)],
      incompleteDates: ["2026-07-30"],
      corruptDates: [],
      truncated: false,
    });
  });

  it("keeps legal lines around a corrupt middle line", async () => {
    const test = createRepository();
    seedFile(test.adapter, "2026-07-30", `${line(createEvent(1))}{invalid-json}\n${line(createEvent(2))}`);

    const result = await test.repository.readRange({
      days: 7,
      now: new Date(2026, 6, 30, 18),
    });

    expect(result.events).toEqual([createEvent(1), createEvent(2)]);
    expect(result.incompleteDates).toEqual([]);
    expect(result.corruptDates).toEqual(["2026-07-30"]);
    expect(result.truncated).toBe(false);
  });

  it("fails closed on an unknown schema without exposing its line", async () => {
    const test = createRepository();
    seedFile(
      test.adapter,
      "2026-07-30",
      `${line(createEvent(1))}${JSON.stringify({ schemaVersion: 2, payload: "synthetic" })}\n`,
    );

    const result = await test.repository.readRange({
      days: 7,
      now: new Date(2026, 6, 30, 18),
    });

    expect(result.events).toEqual([createEvent(1)]);
    expect(result.incompleteDates).toEqual(["2026-07-30"]);
    expect(result.truncated).toBe(true);
    expect(result).not.toHaveProperty("raw");
    expect(result).not.toHaveProperty("error");
  });

  it("does not read an oversized daily file", async () => {
    const test = createRepository();
    seedFile(test.adapter, "2026-07-30", line(createEvent(1)), OPERATION_JOURNAL_MAX_FILE_BYTES + 1);

    const result = await test.repository.readRange({
      days: 7,
      now: new Date(2026, 6, 30, 18),
    });

    expect(result).toEqual({
      events: [],
      incompleteDates: [],
      corruptDates: [],
      truncated: true,
    });
    expect(test.adapter.operations).not.toContain(`read:${JOURNAL_DIRECTORY}/2026-07-30.jsonl`);
  });

  it("reads newest dates first and stops at the requested event limit", async () => {
    const test = createRepository();
    seedFile(test.adapter, "2026-07-29", line(createEvent(1)));
    seedFile(test.adapter, "2026-07-30", `${line(createEvent(2))}${line(createEvent(3))}`);

    const result = await test.repository.readRange({
      days: 7,
      now: new Date(2026, 6, 30, 18),
      maxEvents: 2,
    });

    expect(result.events).toEqual([createEvent(2), createEvent(3)]);
    expect(result.truncated).toBe(true);
    expect(OPERATION_JOURNAL_MAX_READ_EVENTS).toBeGreaterThan(2);
    expect(test.adapter.operations).not.toContain(`read:${JOURNAL_DIRECTORY}/2026-07-29.jsonl`);
  });

  it("stops at the total character bound instead of probing older files", async () => {
    const test = createRepository();
    const nearlyTwoMiB = `${"x".repeat(1_900_000 - 1)}\n`;
    for (const date of [
      "2026-07-30",
      "2026-07-29",
      "2026-07-28",
      "2026-07-27",
      "2026-07-26",
    ]) {
      seedFile(test.adapter, date, nearlyTwoMiB);
    }
    seedFile(test.adapter, "2026-07-25", `${"x".repeat(1_000_000 - 1)}\n`);
    seedFile(test.adapter, "2026-07-24", line(createEvent(1)));

    const result = await test.repository.readRange({
      days: 7,
      now: new Date(2026, 6, 30, 18),
    });

    expect(result.truncated).toBe(true);
    expect(test.adapter.operations).not.toContain(
      `read:${JOURNAL_DIRECTORY}/2026-07-24.jsonl`,
    );
  });
});

describe("OperationJournalRepository retention and controls", () => {
  it("deletes expired logs before oldest capacity candidates", async () => {
    const test = createRepository();
    const expired = seedFile(test.adapter, "2026-06-20", "", 2 * 1024 * 1024);
    const oldestRetained = seedFile(test.adapter, "2026-07-28", "", 5 * 1024 * 1024);
    const recent = seedFile(test.adapter, "2026-07-29", "", 6 * 1024 * 1024);
    const today = seedFile(test.adapter, "2026-07-30", "", 1024);

    await test.repository.prune(new Date(2026, 6, 30, 12));

    expect(test.adapter.operations.filter((operation) => operation.startsWith("remove:"))).toEqual([
      `remove:${expired}`,
      `remove:${oldestRetained}`,
    ]);
    expect(test.adapter.files.has(recent)).toBe(true);
    expect(test.adapter.files.has(today)).toBe(true);
  });

  it("never auto-deletes today's file even when it alone exceeds the total limit", async () => {
    const test = createRepository();
    const today = seedFile(
      test.adapter,
      "2026-07-30",
      "",
      OPERATION_JOURNAL_MAX_TOTAL_BYTES + 1,
    );

    await test.repository.prune(new Date(2026, 6, 30, 12));

    expect(test.adapter.files.has(today)).toBe(true);
    expect(test.adapter.operations.some((operation) => operation.startsWith("remove:"))).toBe(false);
  });

  it("never deletes unknown files, invalid dates, subdirectories, or sibling state", async () => {
    const test = createRepository();
    seedJournal(test.adapter);
    const protectedPaths = [
      `${JOURNAL_DIRECTORY}/notes.txt`,
      `${JOURNAL_DIRECTORY}/2026-07-30.json`,
      `${JOURNAL_DIRECTORY}/2026-02-30.jsonl`,
      `${STATE_DIRECTORY}/source-refresh.json`,
    ];
    for (const path of protectedPaths) test.adapter.files.set(path, "synthetic");
    test.adapter.directories.add(`${JOURNAL_DIRECTORY}/2026-06-01.jsonl`);
    seedFile(test.adapter, "2026-06-20", "");

    await test.repository.prune(new Date(2026, 6, 30, 12));

    for (const path of protectedPaths) expect(test.adapter.files.has(path)).toBe(true);
    expect(test.adapter.directories.has(`${JOURNAL_DIRECTORY}/2026-06-01.jsonl`)).toBe(true);
  });

  it("clear removes only strictly valid date JSONL files and preserves directories", async () => {
    const test = createRepository();
    const controlled = [
      seedFile(test.adapter, "2026-07-29", line(createEvent(1))),
      seedFile(test.adapter, "2026-07-30", line(createEvent(2))),
    ];
    const unknown = `${JOURNAL_DIRECTORY}/notes.txt`;
    test.adapter.files.set(unknown, "synthetic");

    await test.repository.clear();

    for (const path of controlled) expect(test.adapter.files.has(path)).toBe(false);
    expect(test.adapter.files.has(unknown)).toBe(true);
    expect(test.adapter.directories.has(JOURNAL_DIRECTORY)).toBe(true);
  });

  it("stops controlled deletion immediately when a removal fails", async () => {
    const test = createRepository();
    const first = seedFile(test.adapter, "2026-06-18", "");
    const second = seedFile(test.adapter, "2026-06-19", "");
    test.adapter.failRemovePath = first;

    await expect(test.repository.prune(new Date(2026, 6, 30, 12))).rejects.toThrow();

    expect(test.adapter.operations.filter((operation) => operation.startsWith("remove:"))).toEqual([
      `remove:${first}`,
    ]);
    expect(test.adapter.files.has(second)).toBe(true);
  });

  it("stats count only strictly controlled files and valid events", async () => {
    const test = createRepository();
    const firstContent = `${line(createEvent(1))}{invalid-json}\n`;
    const secondContent = line(createEvent(2));
    seedFile(test.adapter, "2026-07-29", firstContent);
    seedFile(test.adapter, "2026-07-30", secondContent);
    test.adapter.files.set(`${JOURNAL_DIRECTORY}/notes.txt`, line(createEvent(3)));
    test.adapter.files.set(`${JOURNAL_DIRECTORY}/2026-02-30.jsonl`, line(createEvent(4)));

    await expect(test.repository.stats(new Date(2026, 6, 30, 12))).resolves.toEqual({
      bytes: byteLength(firstContent) + byteLength(secondContent),
      days: 2,
      eventCount: 2,
      earliestDate: "2026-07-29",
    });
  });
});
