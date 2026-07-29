import type { Vault } from "obsidian";
import { describe, expect, it } from "vitest";
import {
  TikHubCaptionJobRepository,
  captionJobKey,
  type TikHubCaptionJobRecord,
} from "../../../src/youtube-transcript/tikhub-caption-job-repository";

const DATA_ROOT = ".rss-dashboard-data";
const STATE_DIRECTORY = `${DATA_ROOT}/state`;
const JOBS_PATH = `${STATE_DIRECTORY}/youtube-caption-jobs.json`;
const ITEM_ID = "a".repeat(64);
const OTHER_ITEM_ID = "b".repeat(64);
const VIDEO_ID = "dQw4w9WgXcQ";
const CONNECTION_ID = "d4eb3f58-b672-4f73-b9f3-9cd2f0e57a8d";
const JOB_ID = "123e4567-e89b-12d3-a456-426614174000";
const INVALID_LANGUAGE_CODES = [
  ["empty", ""],
  ["control", "en\u0000"],
  ["whitespace", "a.zh Hans"],
  ["slash", "a.zh/Hans"],
  ["query", "a.zh?format=txt"],
  ["leading separator", ".zh-Hans"],
  ["trailing separator", "zh-Hans."],
  ["consecutive separators", "a..zh-Hans"],
  ["mixed empty segment", "a.-zh-Hans"],
  ["trailing hyphen", "en-"],
  ["repeated hyphen", "en--US"],
  ["overlong", "a".repeat(65)],
] as const;

class InMemoryAdapter {
  readonly files = new Map<string, string>();
  readonly directories = new Set<string>();
  readonly operations: string[] = [];
  private failRename: ((from: string, to: string) => boolean) | null = null;
  private pausedWrite:
    | {
      predicate: (path: string) => boolean;
      entered: Promise<void>;
      announceEntered: () => void;
      release: Promise<void>;
      resume: () => void;
    }
    | undefined;

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.directories.has(path);
  }

  async mkdir(path: string): Promise<void> {
    this.operations.push(`mkdir:${path}`);
    const parent = parentPath(path);
    if (parent && !this.directories.has(parent)) {
      throw new Error(`Missing parent directory: ${parent}`);
    }
    this.directories.add(path);
  }

  async read(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`Missing file: ${path}`);
    return value;
  }

  async write(path: string, content: string): Promise<void> {
    this.operations.push(`write:${path}`);
    const paused = this.pausedWrite;
    if (paused?.predicate(path)) {
      this.pausedWrite = undefined;
      paused.announceEntered();
      await paused.release;
    }
    const parent = parentPath(path);
    if (parent && !this.directories.has(parent)) {
      throw new Error(`Missing parent directory: ${parent}`);
    }
    this.files.set(path, content);
  }

  async rename(from: string, to: string): Promise<void> {
    this.operations.push(`rename:${from}:${to}`);
    if (this.failRename?.(from, to)) {
      this.failRename = null;
      throw new Error("Injected rename failure");
    }
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

  failNextRenameWhere(predicate: (from: string, to: string) => boolean): void {
    this.failRename = predicate;
  }

  pauseNextWriteWhere(predicate: (path: string) => boolean): {
    entered: Promise<void>;
    resume: () => void;
  } {
    let announceEntered!: () => void;
    let resume!: () => void;
    const entered = new Promise<void>((resolve) => {
      announceEntered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      resume = resolve;
    });
    this.pausedWrite = {
      predicate,
      entered,
      announceEntered,
      release,
      resume,
    };
    return { entered, resume };
  }
}

function createRecord(
  overrides: Partial<TikHubCaptionJobRecord> = {},
): TikHubCaptionJobRecord {
  const record: TikHubCaptionJobRecord = {
    schemaVersion: 1,
    itemId: ITEM_ID,
    videoId: VIDEO_ID,
    stage: "content",
    languageCode: "a.zh-Hans",
    format: "txt",
    jobId: JOB_ID,
    connectionId: CONNECTION_ID,
    createdAt: "2026-07-29T08:00:00.000Z",
    lastCheckedAt: "2026-07-29T08:01:00.000Z",
    status: "processing",
    ...overrides,
  };
  if (record.stage === "tracks" && overrides.languageCode === undefined) {
    delete record.languageCode;
  }
  return record;
}

function createRepository(
  adapter = new InMemoryAdapter(),
  vault = { adapter } as unknown as Vault,
  dataRoot = DATA_ROOT,
): {
  adapter: InMemoryAdapter;
  repository: TikHubCaptionJobRepository;
  vault: Vault;
} {
  return {
    adapter,
    repository: new TikHubCaptionJobRepository(vault, dataRoot),
    vault,
  };
}

function seedState(adapter: InMemoryAdapter, raw: string): void {
  adapter.directories.add(DATA_ROOT);
  adapter.directories.add(STATE_DIRECTORY);
  adapter.files.set(JOBS_PATH, raw);
}

function parentPath(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator === -1 ? "" : path.slice(0, separator);
}

describe("TikHubCaptionJobRepository", () => {
  it("builds stable, stage-specific keys and rejects ambiguous identities", () => {
    expect(captionJobKey(ITEM_ID, VIDEO_ID, "tracks")).toBe(
      `${ITEM_ID}:${VIDEO_ID}:tracks`,
    );
    expect(captionJobKey(ITEM_ID, VIDEO_ID, "content", "a.zh-Hans")).toBe(
      `${ITEM_ID}:${VIDEO_ID}:content:a.zh-Hans`,
    );
    expect(() => captionJobKey(ITEM_ID, VIDEO_ID, "tracks", "en")).toThrow();
    expect(() => captionJobKey(ITEM_ID, VIDEO_ID, "content")).toThrow();
  });

  it.each(INVALID_LANGUAGE_CODES)(
    "rejects an unsafe content-job language without creating state: %s",
    async (_label, languageCode) => {
      const test = createRepository();

      expect(() =>
        captionJobKey(ITEM_ID, VIDEO_ID, "content", languageCode)
      ).toThrow();
      await expect(
        test.repository.write(createRecord({ languageCode })),
      ).rejects.toThrow();
      expect(test.adapter.files.has(JOBS_PATH)).toBe(false);
    },
  );

  it("persists the exact record map at the configured data-root state path", async () => {
    const test = createRepository();
    const record = createRecord();
    const key = captionJobKey(
      record.itemId,
      record.videoId,
      record.stage,
      record.languageCode,
    );

    await test.repository.write(record);

    expect(JSON.parse(test.adapter.files.get(JOBS_PATH) ?? "null")).toEqual({
      schemaVersion: 1,
      jobs: { [key]: record },
    });
    expect(await test.repository.read(key)).toEqual(record);
    expect(test.adapter.files.has(`${DATA_ROOT}/youtube-caption-jobs.json`)).toBe(false);
  });

  it("persists no API key, Authorization, provider payload, credential URL, or transcript", async () => {
    const test = createRepository();
    await test.repository.write(createRecord());

    const persisted = (test.adapter.files.get(JOBS_PATH) ?? "").toLowerCase();
    for (const forbidden of [
      "apikey",
      "authorization",
      "providerpayload",
      "credentialurl",
      "transcript",
    ]) {
      expect(persisted).not.toContain(forbidden);
    }
  });

  it("retains different jobs when writes begin concurrently", async () => {
    const adapter = new InMemoryAdapter();
    const vault = { adapter } as unknown as Vault;
    const first = createRepository(adapter, vault).repository;
    const second = createRepository(adapter, vault).repository;
    const firstRecord = createRecord();
    const secondRecord = createRecord({
      itemId: OTHER_ITEM_ID,
      stage: "tracks",
      languageCode: undefined,
      jobId: "223e4567-e89b-12d3-a456-426614174000",
    });

    await Promise.all([first.write(firstRecord), second.write(secondRecord)]);

    expect(await first.read(captionJobKey(
      firstRecord.itemId,
      firstRecord.videoId,
      firstRecord.stage,
      firstRecord.languageCode,
    ))).toEqual(firstRecord);
    expect(await first.read(captionJobKey(
      secondRecord.itemId,
      secondRecord.videoId,
      secondRecord.stage,
      secondRecord.languageCode,
    ))).toEqual(secondRecord);
  });

  it("serializes same-key writes across repository instances", async () => {
    const adapter = new InMemoryAdapter();
    const vault = { adapter } as unknown as Vault;
    const first = createRepository(adapter, vault).repository;
    const second = createRepository(adapter, vault).repository;
    await first.write(createRecord());
    adapter.operations.length = 0;
    const pause = adapter.pauseNextWriteWhere((path) => path.startsWith(`${JOBS_PATH}.tmp-`));
    const firstReplacement = createRecord({
      jobId: "223e4567-e89b-12d3-a456-426614174000",
      lastCheckedAt: "2026-07-29T08:02:00.000Z",
    });
    const secondReplacement = createRecord({
      jobId: "323e4567-e89b-12d3-a456-426614174000",
      lastCheckedAt: "2026-07-29T08:03:00.000Z",
    });

    const firstWrite = first.write(firstReplacement);
    await pause.entered;
    const secondWrite = second.write(secondReplacement);
    await Promise.resolve();
    expect(
      adapter.operations.filter((operation) => operation.startsWith(`write:${JOBS_PATH}.tmp-`)),
    ).toHaveLength(1);
    pause.resume();
    await Promise.all([firstWrite, secondWrite]);

    const key = captionJobKey(ITEM_ID, VIDEO_ID, "content", "a.zh-Hans");
    expect(await first.read(key)).toEqual(secondReplacement);
    expect(
      [...adapter.files.keys()].filter(
        (path) => path.startsWith(`${JOBS_PATH}.tmp-`) || path.startsWith(`${JOBS_PATH}.backup-`),
      ),
    ).toEqual([]);
  });

  it("removes one job without overwriting a different job", async () => {
    const test = createRepository();
    const content = createRecord();
    const tracks = createRecord({
      itemId: OTHER_ITEM_ID,
      stage: "tracks",
      languageCode: undefined,
      jobId: "223e4567-e89b-12d3-a456-426614174000",
    });
    await test.repository.write(content);
    await test.repository.write(tracks);
    const contentKey = captionJobKey(ITEM_ID, VIDEO_ID, "content", "a.zh-Hans");
    const tracksKey = captionJobKey(OTHER_ITEM_ID, VIDEO_ID, "tracks");

    await test.repository.remove(contentKey);

    expect(await test.repository.read(contentKey)).toBeNull();
    expect(await test.repository.read(tracksKey)).toEqual(tracks);
  });

  it("rolls a failed replacement back to the prior durable jobs", async () => {
    const test = createRepository();
    const prior = createRecord();
    await test.repository.write(prior);
    test.adapter.failNextRenameWhere(
      (from, to) => from.startsWith(`${JOBS_PATH}.tmp-`) && to === JOBS_PATH,
    );

    await expect(test.repository.write(createRecord({
      jobId: "223e4567-e89b-12d3-a456-426614174000",
      lastCheckedAt: "2026-07-29T08:02:00.000Z",
    }))).rejects.toThrow("Injected rename failure");

    const key = captionJobKey(ITEM_ID, VIDEO_ID, "content", "a.zh-Hans");
    expect(await test.repository.read(key)).toEqual(prior);
    expect(
      [...test.adapter.files.keys()].filter(
        (path) => path.startsWith(`${JOBS_PATH}.tmp-`) || path.startsWith(`${JOBS_PATH}.backup-`),
      ),
    ).toEqual([]);
  });

  it("recovers a valid durable backup after interruption and cleans only owned siblings", async () => {
    const test = createRepository();
    const record = createRecord();
    await test.repository.write(record);
    await test.adapter.rename(JOBS_PATH, `${JOBS_PATH}.backup-interrupted`);
    test.adapter.files.set(`${JOBS_PATH}.tmp-interrupted`, "partial");
    test.adapter.files.set(`${JOBS_PATH}.other`, "unrelated sibling");
    test.adapter.files.set(`${STATE_DIRECTORY}/tikhub-requests.json`, "request history");
    test.adapter.files.set(`${DATA_ROOT}/content/${ITEM_ID}.md`, "cached content");
    const settingsPath = "config-dir/plugins/rss-dashboard-cn/data.json";
    test.adapter.files.set(settingsPath, "settings");
    const key = captionJobKey(ITEM_ID, VIDEO_ID, "content", "a.zh-Hans");

    expect(await test.repository.read(key)).toEqual(record);

    expect(test.adapter.files.has(JOBS_PATH)).toBe(true);
    expect(test.adapter.files.has(`${JOBS_PATH}.backup-interrupted`)).toBe(false);
    expect(test.adapter.files.has(`${JOBS_PATH}.tmp-interrupted`)).toBe(false);
    expect(test.adapter.files.get(`${JOBS_PATH}.other`)).toBe("unrelated sibling");
    expect(test.adapter.files.get(`${STATE_DIRECTORY}/tikhub-requests.json`)).toBe("request history");
    expect(test.adapter.files.get(`${DATA_ROOT}/content/${ITEM_ID}.md`)).toBe("cached content");
    expect(test.adapter.files.get(settingsPath)).toBe("settings");
  });

  it("fails closed on malformed JSON and preserves the original bytes", async () => {
    const test = createRepository();
    seedState(test.adapter, "{ malformed private bytes");
    const before = test.adapter.files.get(JOBS_PATH);
    const key = captionJobKey(ITEM_ID, VIDEO_ID, "content", "a.zh-Hans");

    await expect(test.repository.read(key)).rejects.toThrow();
    await expect(test.repository.write(createRecord())).rejects.toThrow();
    await expect(test.repository.remove(key)).rejects.toThrow();
    expect(test.adapter.files.get(JOBS_PATH)).toBe(before);
  });

  it.each([
    ["item ID", createRecord({ itemId: "../item" })],
    ["video ID", createRecord({ videoId: "too-short" })],
    ["connection ID", createRecord({ connectionId: CONNECTION_ID.toUpperCase() })],
    ["job ID", createRecord({ jobId: "../job" })],
    ["language ID", createRecord({ languageCode: "en/us" })],
    ["tracks language", createRecord({ stage: "tracks", languageCode: "en" })],
    ["content language", createRecord({ languageCode: undefined })],
    ["format", createRecord({ format: "vtt" as "txt" })],
    ["created timestamp", createRecord({ createdAt: "2026-07-29T08:00:00Z" })],
    ["checked timestamp", createRecord({ lastCheckedAt: "2026-02-30T08:00:00.000Z" })],
    ["timestamp order", createRecord({ lastCheckedAt: "2026-07-29T07:59:59.999Z" })],
    ["status", createRecord({ status: "completed" as "processing" })],
  ])("rejects an invalid %s without creating state", async (_label, record) => {
    const test = createRepository();

    await expect(test.repository.write(record)).rejects.toThrow();
    expect(test.adapter.files.has(JOBS_PATH)).toBe(false);
  });

  it("rejects unknown, forbidden, accessor-backed, and inherited record fields", async () => {
    const test = createRepository();
    const unknown = { ...createRecord(), providerPayload: { status: "processing" } };
    let getterCalled = false;
    const accessor = { ...createRecord() } as Record<string, unknown>;
    Object.defineProperty(accessor, "jobId", {
      enumerable: true,
      get() {
        getterCalled = true;
        return JOB_ID;
      },
    });
    const inherited = Object.create(createRecord()) as TikHubCaptionJobRecord;

    await expect(
      test.repository.write(unknown as unknown as TikHubCaptionJobRecord),
    ).rejects.toThrow();
    await expect(
      test.repository.write(accessor as unknown as TikHubCaptionJobRecord),
    ).rejects.toThrow();
    await expect(test.repository.write(inherited)).rejects.toThrow();
    expect(getterCalled).toBe(false);
    expect(test.adapter.files.has(JOBS_PATH)).toBe(false);
  });

  it.each([
    { schemaVersion: 1, jobs: [], description: "non-object jobs" },
    { schemaVersion: 1, jobs: {}, extra: true, description: "unknown top-level field" },
    {
      schemaVersion: 1,
      jobs: { unexpected: createRecord() },
      description: "record stored under a mismatched key",
    },
    {
      schemaVersion: 1,
      jobs: {
        [captionJobKey(ITEM_ID, VIDEO_ID, "content", "a.zh-Hans")]: {
          ...createRecord(),
          transcript: "must not be accepted",
        },
      },
      description: "unknown persisted record field",
    },
  ])("rejects persisted $description without rewriting it", async ({ description: _description, ...value }) => {
    const test = createRepository();
    const raw = JSON.stringify(value);
    seedState(test.adapter, raw);
    const key = captionJobKey(ITEM_ID, VIDEO_ID, "content", "a.zh-Hans");

    await expect(test.repository.read(key)).rejects.toThrow();
    expect(test.adapter.files.get(JOBS_PATH)).toBe(raw);
  });

  it.each(["", "/absolute", "../escape", "folder\\escape", "C:escape"])(
    "rejects unsafe configured data root: %s",
    (dataRoot) => {
      const adapter = new InMemoryAdapter();
      const vault = { adapter } as unknown as Vault;
      expect(() => new TikHubCaptionJobRepository(vault, dataRoot)).toThrow();
    },
  );
});
