import type { Vault } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import type { AiAnalysisResult } from "../../../src/ai/analysis-result";
import { renderAnalysisMarkdown } from "../../../src/ai/analysis-markdown";
import { AnalysisRepository } from "../../../src/ai/analysis-repository";

const DATA_ROOT = ".rss-dashboard-data";
const ITEM_ID = "b".repeat(64);
const RESULT_ID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const BASE_PATH = `${DATA_ROOT}/analysis/${ITEM_ID}/20260721T123456789-summary.md`;
const CLAIM_SOURCE_PATH = `${DATA_ROOT}/analysis/.claim-source-v1`;

interface Storage {
  files: Map<string, string>;
  directories: Set<string>;
}

class InMemoryAdapter {
  readonly files: Map<string, string>;
  readonly directories: Set<string>;
  readonly operations: string[] = [];
  failWrite = false;
  corruptWriteOnce = false;
  failCopy = false;
  failPartialCopyOnce = false;
  failRename = false;
  failRenameAfterMove = false;
  injectForeignBeforeContentClaim = false;
  injectForeignBeforeClaimSourceProcess = false;
  replaceWriteOnFirstExists = false;
  replaceReadOnList = false;
  readonly unreadable = new Set<string>();
  injectedForeignPath?: string;
  private copyBarrier?: () => Promise<void>;

  constructor(
    storage: Storage = { files: new Map(), directories: new Set() },
  ) {
    this.files = storage.files;
    this.directories = storage.directories;
  }

  async exists(path: string): Promise<boolean> {
    this.operations.push(`exists:${path}`);
    if (this.replaceWriteOnFirstExists) {
      this.replaceWriteOnFirstExists = false;
      this.write = async () => {
        throw new Error("Late replacement must not be called");
      };
    }
    return this.files.has(path) || this.directories.has(path);
  }

  async mkdir(path: string): Promise<void> {
    this.operations.push(`mkdir:${path}`);
    const parent = parentPath(path);
    if (parent && !this.directories.has(parent)) {
      throw new Error(`Missing parent directory: ${parent}`);
    }
    if (this.files.has(path)) throw new Error(`File blocks directory: ${path}`);
    this.directories.add(path);
  }

  async write(path: string, content: string): Promise<void> {
    this.operations.push(`write:${path}`);
    if (this.failWrite) throw new Error("Injected write failure");
    const parent = parentPath(path);
    if (parent && !this.directories.has(parent)) {
      throw new Error(`Missing parent directory: ${parent}`);
    }
    if (this.corruptWriteOnce) {
      this.corruptWriteOnce = false;
      this.files.set(path, content.slice(0, Math.max(1, Math.floor(content.length / 2))));
      return;
    }
    this.files.set(path, content);
  }

  async read(path: string): Promise<string> {
    this.operations.push(`read:${path}`);
    if (this.unreadable.has(path)) throw new Error(`Unreadable file: ${path}`);
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`Missing file: ${path}`);
    return content;
  }

  async copy(from: string, to: string): Promise<void> {
    this.operations.push(`copy:${from}:${to}`);
    if (this.failCopy) throw new Error("Injected atomic promotion failure");
    await this.copyBarrier?.();
    const content = this.files.get(from);
    if (content === undefined) throw new Error(`Missing source: ${from}`);
    if (
      this.injectForeignBeforeContentClaim &&
      to.includes("-content-")
    ) {
      this.injectForeignBeforeContentClaim = false;
      this.injectedForeignPath = to;
      this.files.set(to, "foreign bytes that must survive");
    }
    if (this.files.has(to) || this.directories.has(to)) {
      throw new Error(`Destination exists: ${to}`);
    }
    if (this.failPartialCopyOnce && to.endsWith(".tmp-claim")) {
      this.failPartialCopyOnce = false;
      this.files.set(to, content.slice(0, Math.max(1, Math.floor(content.length / 2))));
      throw new Error("Injected partial claim copy failure");
    }
    this.files.set(to, content);
  }

  async rename(from: string, to: string): Promise<void> {
    this.operations.push(`rename:${from}:${to}`);
    if (this.failRename) throw new Error("Injected atomic rename failure");
    const content = this.files.get(from);
    if (content === undefined) throw new Error(`Missing source: ${from}`);
    if (this.files.has(to) || this.directories.has(to)) {
      throw new Error(`Destination exists: ${to}`);
    }
    this.files.set(to, content);
    this.files.delete(from);
    if (this.failRenameAfterMove) {
      throw new Error("Injected post-move rename error");
    }
  }

  async remove(path: string): Promise<void> {
    this.operations.push(`remove:${path}`);
    this.files.delete(path);
  }

  async process(
    path: string,
    update: (content: string) => string,
  ): Promise<string> {
    this.operations.push(`process:${path}`);
    const parent = parentPath(path);
    if (parent && !this.directories.has(parent)) {
      throw new Error(`Missing parent directory: ${parent}`);
    }
    if (this.injectForeignBeforeClaimSourceProcess) {
      this.injectForeignBeforeClaimSourceProcess = false;
      this.files.set(path, "foreign process-race bytes");
    }
    const current = this.files.get(path) ?? "";
    const next = update(current);
    this.files.set(path, next);
    return next;
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    this.operations.push(`list:${path}`);
    if (this.replaceReadOnList) {
      this.replaceReadOnList = false;
      this.read = async () => {
        throw new Error("Late replacement must not be called");
      };
    }
    const prefix = `${path}/`;
    return {
      files: [...this.files.keys()].filter(
        (candidate) => candidate.startsWith(prefix) &&
          !candidate.slice(prefix.length).includes("/"),
      ),
      folders: [...this.directories].filter(
        (candidate) => candidate.startsWith(prefix) &&
          !candidate.slice(prefix.length).includes("/"),
      ),
    };
  }

  pauseCopyUntil(release: Promise<void>): void {
    this.copyBarrier = async () => await release;
  }
}

function parentPath(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator === -1 ? "" : path.slice(0, separator);
}

function analysis(
  overrides: Partial<AiAnalysisResult> = {},
): AiAnalysisResult {
  return {
    schemaVersion: 1,
    id: RESULT_ID,
    itemId: ITEM_ID,
    sourceUrl: "https://example.com/item",
    operation: "summary",
    createdAt: "2026-07-21T12:34:56.789Z",
    connectionId: "9d2c59b2-146d-4ca0-8a5a-b9ae9de44bb9",
    connectionName: "DeepSeek",
    providerKind: "deepseek",
    model: "deepseek-chat",
    contentBasis: "feed",
    inputCharacterCount: 888,
    inputTruncated: false,
    text: "摘要正文",
    ...overrides,
  };
}

function analysisPath(value: AiAnalysisResult, suffix = ""): string {
  const timestamp = value.createdAt.replace(/[-:.Z]/gu, "");
  return `${DATA_ROOT}/analysis/${value.itemId}/${timestamp}-${value.operation}${suffix}.md`;
}

function repository(
  adapter: InMemoryAdapter,
  vault = { adapter } as unknown as Vault,
): AnalysisRepository {
  let sequence = 0;
  return new AnalysisRepository(vault, DATA_ROOT, {
    randomSuffix: () => `test-${sequence++}-abcdefghijklmnop`,
  });
}

function finalFiles(adapter: InMemoryAdapter): string[] {
  return [...adapter.files.keys()].filter((path) => path.endsWith(".md"));
}

function temporaryFiles(adapter: InMemoryAdapter): string[] {
  return [...adapter.files.keys()].filter((path) => path.includes(".tmp-"));
}

describe("AnalysisRepository", () => {
  it("lists only valid immutable artifacts in the exact item directory and filters by operation", async () => {
    const adapter = new InMemoryAdapter();
    const target = repository(adapter);
    const directory = `${DATA_ROOT}/analysis/${ITEM_ID}`;
    const older = analysis({
      createdAt: "2026-07-21T12:34:55.789Z",
      text: "older",
    });
    const newerSummary = analysis({
      id: "69a10bdf-6d36-4388-bbe4-219da9c3ea46",
      createdAt: "2026-07-21T12:34:57.789Z",
      text: "newer-summary",
    });
    const newerAnalysis = analysis({
      id: "c56a4180-65aa-42ec-a945-5fd21dec0538",
      operation: "deep-analysis",
      createdAt: "2026-07-21T12:34:57.789Z",
      text: "newer-analysis",
    });
    const olderPath = `${directory}/20260721T123455789-summary.md`;
    const summaryPath = `${directory}/20260721T123457789-summary.md`;
    const analysisPath = `${directory}/20260721T123457789-deep-analysis.md`;
    adapter.files.set(olderPath, renderAnalysisMarkdown(older));
    adapter.files.set(summaryPath, renderAnalysisMarkdown(newerSummary));
    adapter.files.set(analysisPath, renderAnalysisMarkdown(newerAnalysis));
    adapter.files.set(`${directory}/invalid.md`, "not an artifact");
    adapter.files.set(`${directory}/ignored.md.tmp-claim`, "temporary");
    adapter.files.set(`${directory}/ignored.md.backup`, "backup");
    adapter.files.set(`${directory}/ignored.txt`, "other");
    adapter.files.set(
      `${DATA_ROOT}/analysis/${"c".repeat(64)}/20260721T123459789-summary.md`,
      renderAnalysisMarkdown(analysis({
        itemId: "c".repeat(64),
        createdAt: "2026-07-21T12:34:59.789Z",
      })),
    );
    adapter.unreadable.add(olderPath);

    const listed = await target.list(ITEM_ID);
    const summaries = await target.list(ITEM_ID, "summary");
    const latest = await target.latest(ITEM_ID, "deep-analysis");

    expect(listed.map(({ path }) => path)).toEqual([analysisPath, summaryPath]);
    expect(summaries.map(({ path }) => path)).toEqual([summaryPath]);
    expect(latest?.path).toBe(analysisPath);
    expect(Object.isFrozen(listed)).toBe(true);
    expect(Object.isFrozen(listed[0])).toBe(true);
    expect(Object.isFrozen(listed[0]?.record)).toBe(true);
    expect(adapter.operations.filter((entry) => entry.startsWith("list:")))
      .toEqual([
        `list:${directory}`,
        `list:${directory}`,
        `list:${directory}`,
      ]);
    expect(adapter.operations.some((entry) => entry.includes(`${"c".repeat(64)}/`)))
      .toBe(false);
    expect(adapter.operations.some((entry) =>
      /write:|remove:|rename:|copy:|process:|mkdir:/u.test(entry))).toBe(false);
  });

  it("reads only exact repository artifact paths and returns null for invalid, unreadable, or mismatched files", async () => {
    const adapter = new InMemoryAdapter();
    const target = repository(adapter);
    adapter.files.set(BASE_PATH, renderAnalysisMarkdown(analysis()));

    await expect(target.read(BASE_PATH)).resolves.toEqual({
      path: BASE_PATH,
      record: analysis(),
    });
    const readsAfterValid = adapter.operations.length;
    for (const path of [
      `/${BASE_PATH}`,
      `C:/${BASE_PATH}`,
      BASE_PATH.replace("/", "\\"),
      `${BASE_PATH}\0`,
      `${DATA_ROOT}/analysis/${ITEM_ID}/../${BASE_PATH.split("/").pop()}`,
      `Notes/${BASE_PATH.split("/").pop()}`,
    ]) {
      await expect(target.read(path)).resolves.toBeNull();
    }
    expect(adapter.operations).toHaveLength(readsAfterValid);

    adapter.files.set(BASE_PATH, renderAnalysisMarkdown(analysis({
      itemId: "c".repeat(64),
    })));
    await expect(target.read(BASE_PATH)).resolves.toBeNull();
    adapter.unreadable.add(BASE_PATH);
    await expect(target.read(BASE_PATH)).resolves.toBeNull();
  });

  it("bounds enumeration and reads while skipping oversized artifacts independently", async () => {
    const adapter = new InMemoryAdapter();
    const target = repository(adapter);
    const directory = `${DATA_ROOT}/analysis/${ITEM_ID}`;
    for (let index = 0; index < 300; index += 1) {
      const collision = index === 0 ? "" : `-${index + 1}`;
      adapter.files.set(
        `${directory}/20260721T123456789-summary${collision}.md`,
        renderAnalysisMarkdown(analysis({
          id: index % 2 === 0
            ? RESULT_ID
            : "69a10bdf-6d36-4388-bbe4-219da9c3ea46",
          text: `result-${index}`,
        })),
      );
    }
    adapter.files.set(
      `${directory}/20260721T123457789-summary.md`,
      "x".repeat(1_100_001),
    );

    const listed = await target.list(ITEM_ID);

    expect(listed.length).toBeLessThanOrEqual(256);
    expect(adapter.operations.filter((entry) => entry.startsWith("read:")).length)
      .toBeLessThanOrEqual(256);
    expect(listed.every(({ record }) => record.text.startsWith("result-"))).toBe(true);
  });

  it("keeps the newest 256 canonical paths before bounded reads", async () => {
    const adapter = new InMemoryAdapter();
    const target = repository(adapter);
    const start = Date.parse("2026-07-21T12:00:00.000Z");
    let expectedLatestPath = "";
    for (let index = 0; index < 300; index += 1) {
      const value = analysis({
        id: index % 2 === 0
          ? RESULT_ID
          : "69a10bdf-6d36-4388-bbe4-219da9c3ea46",
        createdAt: new Date(start + index).toISOString(),
        text: `result-${index}`,
      });
      const path = analysisPath(value);
      adapter.files.set(path, renderAnalysisMarkdown(value));
      if (index === 299) expectedLatestPath = path;
    }

    const listed = await target.list(ITEM_ID);
    const latest = await target.latest(ITEM_ID, "summary");

    expect(listed).toHaveLength(256);
    expect(listed[0]?.path).toBe(expectedLatestPath);
    expect(listed[0]?.record.text).toBe("result-299");
    expect(latest?.path).toBe(expectedLatestPath);
    expect(adapter.operations.filter((entry) => entry.startsWith("read:")).length)
      .toBeLessThanOrEqual(512);
  });

  it("filters canonical paths by operation before the 256-read cap", async () => {
    const adapter = new InMemoryAdapter();
    const target = repository(adapter);
    const start = Date.parse("2026-07-21T12:00:00.000Z");
    for (let index = 0; index < 300; index += 1) {
      const value = analysis({
        createdAt: new Date(start + index).toISOString(),
        text: `summary-${index}`,
      });
      adapter.files.set(analysisPath(value), renderAnalysisMarkdown(value));
    }
    const expected = analysis({
      operation: "deep-analysis",
      createdAt: new Date(start + 300).toISOString(),
      text: "wanted-deep-analysis",
    });
    const expectedPath = analysisPath(expected);
    adapter.files.set(expectedPath, renderAnalysisMarkdown(expected));

    const listed = await target.list(ITEM_ID, "deep-analysis");
    const latest = await target.latest(ITEM_ID, "deep-analysis");

    expect(listed.map(({ path }) => path)).toEqual([expectedPath]);
    expect(latest?.path).toBe(expectedPath);
    expect(adapter.operations.filter((entry) => entry.startsWith("read:")).length)
      .toBe(2);
  });

  it("binds read-only adapter methods before enumeration and does not require write capabilities", async () => {
    const adapter = new InMemoryAdapter();
    adapter.files.set(BASE_PATH, renderAnalysisMarkdown(analysis()));
    const readOnly: {
      read(path: string): Promise<string>;
      list(path: string): Promise<{ files: string[]; folders: string[] }>;
    } = {
      read: adapter.read.bind(adapter),
      list: async (path) => {
        const listing = await adapter.list(path);
        readOnly.read = async () => {
          throw new Error("Late replacement must not be called");
        };
        return listing;
      },
    };
    const target = repository(adapter, { adapter: readOnly } as unknown as Vault);

    await expect(target.list(ITEM_ID)).resolves.toHaveLength(1);
    await expect(target.read(BASE_PATH)).resolves.toBeNull();
  });

  it("fails closed on hostile list results without invoking accessors", async () => {
    const adapter = new InMemoryAdapter();
    let getterCalled = false;
    const hostile = {
      read: adapter.read.bind(adapter),
      list: async () => {
        const result = {};
        Object.defineProperty(result, "files", {
          get() {
            getterCalled = true;
            return [BASE_PATH];
          },
        });
        return result;
      },
    };
    const target = repository(adapter, { adapter: hostile } as unknown as Vault);

    await expect(target.list(ITEM_ID)).resolves.toEqual([]);
    expect(getterCalled).toBe(false);
    expect(adapter.operations).toEqual([]);
  });

  it("rejects hostile query inputs before adapter access", async () => {
    const adapter = new InMemoryAdapter();
    let coercionCalled = false;
    const hostile = {};
    Object.defineProperty(hostile, "toString", {
      get() {
        coercionCalled = true;
        return () => ITEM_ID;
      },
    });
    const target = repository(adapter);

    await expect(target.list(hostile as unknown as string)).resolves.toEqual([]);
    await expect(target.latest(
      hostile as unknown as string,
      "summary",
    )).resolves.toBeNull();
    expect(coercionCalled).toBe(false);
    expect(adapter.operations).toEqual([]);
  });

  it("binds a valid saved artifact to the expected result before running a consumer", async () => {
    const adapter = new InMemoryAdapter();
    const target = repository(adapter);
    const expected = analysis();
    const path = await target.save(expected);
    const consume = vi.fn(async (trusted: AiAnalysisResult) => trusted.id);

    await expect(target.withVerifiedArtifact(path, expected, consume))
      .resolves.toBe(RESULT_ID);

    expect(consume).toHaveBeenCalledTimes(1);
    expect(consume).toHaveBeenCalledWith(expected);
  });

  it("fails closed before the consumer when the artifact is missing, moved, replaced, or outside its controlled path", async () => {
    const cases = ["missing", "moved", "replaced", "outside"] as const;

    for (const scenario of cases) {
      const adapter = new InMemoryAdapter();
      const target = repository(adapter);
      const expected = analysis();
      const path = await target.save(expected);
      const consume = vi.fn(async () => "must-not-run");
      let candidatePath = path;

      if (scenario === "missing") {
        adapter.files.delete(path);
      } else if (scenario === "moved") {
        const moved = `${DATA_ROOT}/analysis/${ITEM_ID}/moved.md`;
        adapter.files.set(moved, adapter.files.get(path)!);
        adapter.files.delete(path);
      } else if (scenario === "replaced") {
        adapter.files.set(path, renderAnalysisMarkdown(analysis({
          id: "69a10bdf-6d36-4388-bbe4-219da9c3ea46",
          itemId: "c".repeat(64),
        })));
      } else {
        candidatePath = `Notes/${path.split("/").pop()}`;
        adapter.files.set(candidatePath, adapter.files.get(path)!);
      }

      await expect(target.withVerifiedArtifact(
        candidatePath,
        expected,
        consume,
      )).rejects.toThrow(/artifact/iu);
      expect(consume).not.toHaveBeenCalled();
    }
  });

  it("stores one standalone artifact under the stable item and UTC timestamp path", async () => {
    const adapter = new InMemoryAdapter();

    const path = await repository(adapter).save(analysis());

    expect(path).toBe(BASE_PATH);
    expect(adapter.files.get(path)).toContain("resultId:");
    expect(adapter.files.get(path)).toContain("摘要正文");
    expect(temporaryFiles(adapter)).toEqual([]);
    expect(adapter.operations.some((operation) => operation.startsWith("copy:"))).toBe(true);
    expect(adapter.operations.some((operation) => operation.startsWith("rename:"))).toBe(true);
    for (const operation of adapter.operations.filter((entry) => entry.startsWith("write:"))) {
      const path = operation.slice("write:".length);
      const writeIndex = adapter.operations.indexOf(operation);
      expect(
        adapter.operations
          .slice(0, writeIndex)
          .some((entry) => entry.startsWith("copy:") && entry.endsWith(`:${path}`)),
      ).toBe(true);
    }
  });

  it("appends numeric collision suffixes without overwriting existing artifacts", async () => {
    const adapter = new InMemoryAdapter();
    const target = repository(adapter);

    const first = await target.save(analysis({ text: "第一份" }));
    const second = await target.save(analysis({ id: "69a10bdf-6d36-4388-bbe4-219da9c3ea46", text: "第二份" }));
    const third = await target.save(analysis({ id: "c56a4180-65aa-42ec-a945-5fd21dec0538", text: "第三份" }));

    expect([first, second, third]).toEqual([
      BASE_PATH,
      BASE_PATH.replace(".md", "-2.md"),
      BASE_PATH.replace(".md", "-3.md"),
    ]);
    expect(adapter.files.get(first)).toContain("第一份");
    expect(adapter.files.get(second)).toContain("第二份");
    expect(adapter.files.get(third)).toContain("第三份");
  });

  it("serializes same-process writes across repository instances", async () => {
    const adapter = new InMemoryAdapter();
    const vault = { adapter } as unknown as Vault;
    const first = repository(adapter, vault);
    const second = repository(adapter, vault);

    const paths = await Promise.all([
      first.save(analysis({ text: "并发一" })),
      second.save(analysis({ id: "69a10bdf-6d36-4388-bbe4-219da9c3ea46", text: "并发二" })),
    ]);

    expect(new Set(paths).size).toBe(2);
    expect(adapter.files.get(CLAIM_SOURCE_PATH)).toBe(
      "rss-dashboard-cn-analysis-claim-source-v1",
    );
    expect(finalFiles(adapter).sort()).toEqual(paths.sort());
    expect(temporaryFiles(adapter)).toEqual([]);
  });

  it("uses exclusive promotion to resolve a cross-wrapper collision", async () => {
    const storage: Storage = { files: new Map(), directories: new Set() };
    const firstAdapter = new InMemoryAdapter(storage);
    const secondAdapter = new InMemoryAdapter(storage);
    let releaseFirst!: () => void;
    const firstCanCopy = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    firstAdapter.pauseCopyUntil(firstCanCopy);

    const firstSave = repository(firstAdapter).save(analysis({ text: "进程一" }));
    await Promise.resolve();
    const secondSave = repository(secondAdapter).save(
      analysis({ id: "69a10bdf-6d36-4388-bbe4-219da9c3ea46", text: "进程二" }),
    );
    releaseFirst();

    const paths = await Promise.all([firstSave, secondSave]);
    expect(new Set(paths).size).toBe(2);
    expect(paths).toContain(BASE_PATH);
    expect(paths).toContain(BASE_PATH.replace(".md", "-2.md"));
    expect(temporaryFiles(firstAdapter)).toEqual([]);
  });

  it("claims each staging path before writing and preserves a foreign race winner", async () => {
    const adapter = new InMemoryAdapter();
    adapter.injectForeignBeforeContentClaim = true;

    await expect(repository(adapter).save(analysis())).resolves.toBe(BASE_PATH);

    expect(adapter.injectedForeignPath).toBeTruthy();
    expect(adapter.files.get(adapter.injectedForeignPath ?? "")).toBe(
      "foreign bytes that must survive",
    );
    expect(adapter.files.get(BASE_PATH)).toContain("摘要正文");
  });

  it("keeps different outputs isolated when wrappers choose the same transaction paths", async () => {
    const storage: Storage = { files: new Map(), directories: new Set() };
    const firstAdapter = new InMemoryAdapter(storage);
    const secondAdapter = new InMemoryAdapter(storage);
    const fixedSuffix = "same-transaction-abcdefghijkl";
    const first = new AnalysisRepository(
      { adapter: firstAdapter } as unknown as Vault,
      DATA_ROOT,
      { randomSuffix: () => fixedSuffix },
    );
    const second = new AnalysisRepository(
      { adapter: secondAdapter } as unknown as Vault,
      DATA_ROOT,
      { randomSuffix: () => fixedSuffix },
    );

    const paths = await Promise.all([
      first.save(analysis({ text: "正文甲" })),
      second.save(analysis({
        id: "69a10bdf-6d36-4388-bbe4-219da9c3ea46",
        text: "正文乙",
      })),
    ]);

    const firstContentClaimTargets = firstAdapter.operations
      .filter((operation) => operation.startsWith("copy:") && operation.includes("-content-"))
      .map((operation) => operation.slice(operation.lastIndexOf(":") + 1));
    const secondContentClaimTargets = secondAdapter.operations
      .filter((operation) => operation.startsWith("copy:") && operation.includes("-content-"))
      .map((operation) => operation.slice(operation.lastIndexOf(":") + 1));
    expect(firstContentClaimTargets.some((path) => secondContentClaimTargets.includes(path))).toBe(
      true,
    );
    expect(new Set(paths).size).toBe(2);
    expect(storage.files.get(CLAIM_SOURCE_PATH)).toBe(
      "rss-dashboard-cn-analysis-claim-source-v1",
    );
    expect(paths.map((path) => storage.files.get(path)).join("\n")).toContain("正文甲");
    expect(paths.map((path) => storage.files.get(path)).join("\n")).toContain("正文乙");
  });

  it("does not overwrite a pre-existing user file", async () => {
    const adapter = new InMemoryAdapter();
    adapter.directories.add(DATA_ROOT);
    adapter.directories.add(`${DATA_ROOT}/analysis`);
    adapter.directories.add(`${DATA_ROOT}/analysis/${ITEM_ID}`);
    adapter.files.set(BASE_PATH, "user-owned bytes");

    const path = await repository(adapter).save(analysis());

    expect(path).toBe(BASE_PATH.replace(".md", "-2.md"));
    expect(adapter.files.get(BASE_PATH)).toBe("user-owned bytes");
  });

  it("preserves an unowned claim and advances to the next collision name", async () => {
    const adapter = new InMemoryAdapter();
    adapter.directories.add(DATA_ROOT);
    adapter.directories.add(`${DATA_ROOT}/analysis`);
    adapter.directories.add(`${DATA_ROOT}/analysis/${ITEM_ID}`);
    const foreignClaim = `${BASE_PATH}.tmp-claim`;
    adapter.files.set(foreignClaim, "another-process-ownership-token");

    const path = await repository(adapter).save(analysis());

    expect(path).toBe(BASE_PATH.replace(".md", "-2.md"));
    expect(adapter.files.get(foreignClaim)).toBe("another-process-ownership-token");
  });

  it("never overwrites a conflicting bootstrap claim source", async () => {
    const adapter = new InMemoryAdapter();
    adapter.directories.add(DATA_ROOT);
    adapter.directories.add(`${DATA_ROOT}/analysis`);
    adapter.files.set(CLAIM_SOURCE_PATH, "foreign bootstrap bytes");

    await expect(repository(adapter).save(analysis())).rejects.toThrow(
      "claim source",
    );
    expect(adapter.files.get(CLAIM_SOURCE_PATH)).toBe("foreign bootstrap bytes");
    expect(finalFiles(adapter)).toEqual([]);
  });

  it("preserves foreign bytes that win the absent-to-process bootstrap race", async () => {
    const adapter = new InMemoryAdapter();
    adapter.injectForeignBeforeClaimSourceProcess = true;

    await expect(repository(adapter).save(analysis())).rejects.toThrow(
      "claim source",
    );
    expect(adapter.files.get(CLAIM_SOURCE_PATH)).toBe("foreign process-race bytes");
    expect(finalFiles(adapter)).toEqual([]);
  });

  it("uses the bound adapter snapshot if a live method is replaced after validation", async () => {
    const adapter = new InMemoryAdapter();
    adapter.replaceWriteOnFirstExists = true;

    await expect(repository(adapter).save(analysis())).resolves.toBe(BASE_PATH);
    expect(adapter.files.get(BASE_PATH)).toContain("摘要正文");
  });

  it("rejects empty output before any storage operation", async () => {
    const adapter = new InMemoryAdapter();

    await expect(repository(adapter).save(analysis({ text: " \n\t" }))).rejects.toThrow(
      "AI analysis output must not be empty",
    );
    expect(adapter.operations).toEqual([]);
    expect(adapter.directories.size).toBe(0);
  });

  it("rejects hostile input before any storage operation", async () => {
    const adapter = new InMemoryAdapter();
    let getterCalled = false;
    const input = { ...analysis() } as Record<string, unknown>;
    Object.defineProperty(input, "itemId", {
      enumerable: true,
      get() {
        getterCalled = true;
        return ITEM_ID;
      },
    });

    await expect(repository(adapter).save(input)).rejects.toThrow(
      "Invalid AI analysis result",
    );
    expect(getterCalled).toBe(false);
    expect(adapter.operations).toEqual([]);
  });

  it("cleans the temporary sibling and creates no final file after write failure", async () => {
    const adapter = new InMemoryAdapter();
    adapter.failWrite = true;

    await expect(repository(adapter).save(analysis())).rejects.toThrow(
      "Injected write failure",
    );
    expect(finalFiles(adapter)).toEqual([]);
    expect(temporaryFiles(adapter)).toEqual([]);
  });

  it("rejects an incomplete temporary write before it can be renamed", async () => {
    const adapter = new InMemoryAdapter();
    adapter.corruptWriteOnce = true;

    await expect(repository(adapter).save(analysis())).rejects.toThrow(
      "temporary file verification failed",
    );
    expect(finalFiles(adapter)).toEqual([]);
    expect(temporaryFiles(adapter)).toHaveLength(1);
    expect(adapter.files.get(temporaryFiles(adapter)[0])).not.toBe(
      "rss-dashboard-cn-analysis-claim-source-v1",
    );
  });

  it("cleans the temporary sibling and creates no final file after promotion failure", async () => {
    const adapter = new InMemoryAdapter();
    adapter.failCopy = true;

    await expect(repository(adapter).save(analysis())).rejects.toThrow(
      "Injected atomic promotion failure",
    );
    expect(finalFiles(adapter)).toEqual([]);
    expect(temporaryFiles(adapter)).toEqual([]);
  });

  it("cleans the exclusive temporary sibling and creates no final file after rename failure", async () => {
    const adapter = new InMemoryAdapter();
    adapter.failRename = true;

    await expect(repository(adapter).save(analysis())).rejects.toThrow(
      "Injected atomic rename failure",
    );
    expect(finalFiles(adapter)).toEqual([]);
    expect(temporaryFiles(adapter)).toEqual([]);
  });

  it("never deletes an ambiguous partial claim and advances to a safe collision name", async () => {
    const adapter = new InMemoryAdapter();
    adapter.failPartialCopyOnce = true;

    await expect(repository(adapter).save(analysis())).resolves.toBe(
      BASE_PATH.replace(".md", "-2.md"),
    );
    expect(adapter.files.has(BASE_PATH)).toBe(false);
    expect(adapter.files.get(`${BASE_PATH}.tmp-claim`)).toBeTruthy();
    expect(temporaryFiles(adapter)).toEqual([`${BASE_PATH}.tmp-claim`]);
  });

  it("treats a verified post-move rename error as committed rather than reporting a failed write", async () => {
    const adapter = new InMemoryAdapter();
    adapter.failRenameAfterMove = true;

    await expect(repository(adapter).save(analysis())).resolves.toBe(BASE_PATH);
    expect(adapter.files.get(BASE_PATH)).toContain("摘要正文");
    expect(temporaryFiles(adapter)).toEqual([]);
  });

  it("fails before creating directories when exclusive atomic storage is unavailable", async () => {
    const adapter = new InMemoryAdapter();
    const incompatible = {
      exists: adapter.exists.bind(adapter),
      mkdir: adapter.mkdir.bind(adapter),
      write: adapter.write.bind(adapter),
      read: adapter.read.bind(adapter),
      rename: adapter.rename.bind(adapter),
    };
    const vault = { adapter: incompatible } as unknown as Vault;

    await expect(repository(adapter, vault).save(analysis())).rejects.toThrow(
      "complete atomic storage",
    );
    expect(adapter.operations).toEqual([]);
  });

  it.each(["exists", "mkdir", "write", "read", "copy", "remove", "rename", "process"])(
    "validates and binds adapter.%s before any storage operation",
    async (method) => {
      const adapter = new InMemoryAdapter();
      Object.defineProperty(adapter, method, { value: undefined });
      const vault = { adapter } as unknown as Vault;

      await expect(repository(adapter, vault).save(analysis())).rejects.toThrow(
        "complete atomic storage support",
      );
      expect(adapter.operations).toEqual([]);
      expect(adapter.directories.size).toBe(0);
      expect(adapter.files.size).toBe(0);
    },
  );

  it("rejects an unsafe temporary suffix before any storage operation", async () => {
    const adapter = new InMemoryAdapter();
    const vault = { adapter } as unknown as Vault;
    const target = new AnalysisRepository(vault, DATA_ROOT, {
      randomSuffix: () => "../../unsafe",
    });

    await expect(target.save(analysis())).rejects.toThrow(
      "Invalid AI analysis temporary suffix",
    );
    expect(adapter.operations).toEqual([]);
  });
});
