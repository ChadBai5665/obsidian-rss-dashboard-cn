import type { Vault } from "obsidian";
import { describe, expect, it } from "vitest";
import type { AiAnalysisResult } from "../../../src/ai/analysis-result";
import { AnalysisRepository } from "../../../src/ai/analysis-repository";

const DATA_ROOT = ".rss-dashboard-data";
const ITEM_ID = "b".repeat(64);
const RESULT_ID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const BASE_PATH = `${DATA_ROOT}/analysis/${ITEM_ID}/20260721T123456789-summary.md`;

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
  private copyBarrier?: () => Promise<void>;

  constructor(
    storage: Storage = { files: new Map(), directories: new Set() },
  ) {
    this.files = storage.files;
    this.directories = storage.directories;
  }

  async exists(path: string): Promise<boolean> {
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
    if (this.files.has(path)) throw new Error(`Refusing overwrite: ${path}`);
    if (this.corruptWriteOnce) {
      this.corruptWriteOnce = false;
      this.files.set(path, content.slice(0, Math.max(1, Math.floor(content.length / 2))));
      return;
    }
    this.files.set(path, content);
  }

  async read(path: string): Promise<string> {
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
    if (this.files.has(to) || this.directories.has(to)) {
      throw new Error(`Destination exists: ${to}`);
    }
    if (this.failPartialCopyOnce) {
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

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
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
  it("stores one standalone artifact under the stable item and UTC timestamp path", async () => {
    const adapter = new InMemoryAdapter();

    const path = await repository(adapter).save(analysis());

    expect(path).toBe(BASE_PATH);
    expect(adapter.files.get(path)).toContain("resultId:");
    expect(adapter.files.get(path)).toContain("摘要正文");
    expect(temporaryFiles(adapter)).toEqual([]);
    expect(adapter.operations.some((operation) => operation.startsWith("copy:"))).toBe(true);
    expect(adapter.operations.some((operation) => operation.startsWith("rename:"))).toBe(true);
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
    expect(temporaryFiles(adapter)).toEqual([]);
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
      "exclusive atomic storage",
    );
    expect(adapter.operations).toEqual([]);
  });

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
