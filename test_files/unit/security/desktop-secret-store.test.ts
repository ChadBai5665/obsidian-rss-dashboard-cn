import { describe, expect, it } from "vitest";
import {
  DesktopSecretStore,
  SecretStoreCorruptError,
  SecretStoreSecurityError,
  type DesktopSecretFileSystem,
} from "../../../src/security/desktop-secret-store";

const CONNECTION_A = "d4eb3f58-b672-4f73-b9f3-9cd2f0e57a8d";
const CONNECTION_B = "41ecf4d4-7301-4f0d-a333-dafb184a4013";
const SECRET_PATH = "/private/config/rss-dashboard-cn/secrets.json";
const SECRET_DIRECTORY = "/private/config/rss-dashboard-cn";

class MemoryDesktopFileSystem implements DesktopSecretFileSystem {
  readonly files = new Map<string, string>();
  readonly directories = new Set<string>(["/", "/private", "/private/config"]);
  readonly symlinks = new Set<string>();
  readonly operations: string[] = [];
  readonly modes = new Map<string, number>();
  readonly directoryInodes = new Map<string, number>();
  failAt?: "write" | "chmod" | "fsync-file" | "lstat-after-write" | "rename";
  swapParentAfterTempWrite = false;

  private stats(path: string, kind: "directory" | "file" | "symlink") {
    const numericIdentity = this.directoryInodes.get(path) ?? Math.max(1, [...path].reduce((sum, char) => sum + char.charCodeAt(0), 0));
    return {
      isSymbolicLink: () => kind === "symlink",
      isDirectory: () => kind === "directory",
      isFile: () => kind === "file",
      dev: 1,
      ino: numericIdentity,
    };
  }

  async lstat(path: string) {
    this.operations.push(`lstat:${path}`);
    if (this.failAt === "lstat-after-write" && this.files.has(`${SECRET_PATH}.tmp-fixed`)) {
      throw new Error("lstat-after-write");
    }
    if (this.symlinks.has(path)) return this.stats(path, "symlink");
    if (this.directories.has(path)) return this.stats(path, "directory");
    if (this.files.has(path)) return this.stats(path, "file");
    const error = Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    throw error;
  }

  async mkdir(path: string, options: { recursive: true; mode: number }) {
    this.operations.push(`mkdir:${path}:${options.mode.toString(8)}`);
    this.directories.add(path);
    this.modes.set(path, options.mode);
  }

  async readFile(path: string): Promise<string> {
    this.operations.push(`read:${path}`);
    const value = this.files.get(path);
    if (value === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    return value;
  }

  async writeFile(path: string, content: string, options: { flag: "wx" }): Promise<void> {
    this.operations.push(`write:${path}`);
    if (this.failAt === "write") {
      this.files.set(path, content);
      throw new Error("write");
    }
    if (options.flag !== "wx") throw new Error("Temp writes must be exclusive");
    if (this.files.has(path) || this.symlinks.has(path)) {
      throw Object.assign(new Error(`EEXIST: ${path}`), { code: "EEXIST" });
    }
    this.files.set(path, content);
  }

  async rename(from: string, to: string): Promise<void> {
    this.operations.push(`rename:${from}:${to}`);
    if (this.failAt === "rename") throw new Error("rename");
    const value = this.files.get(from);
    if (value === undefined) throw new Error(`No temp file at ${from}`);
    this.files.delete(from);
    this.files.set(to, value);
  }

  async unlink(path: string): Promise<void> {
    this.operations.push(`unlink:${path}`);
    this.files.delete(path);
  }

  async chmod(path: string, mode: number): Promise<void> {
    this.operations.push(`chmod:${path}:${mode.toString(8)}`);
    if (this.failAt === "chmod" && path.endsWith(".tmp-fixed")) throw new Error("chmod");
    this.modes.set(path, mode);
  }

  async fsyncFile(path: string): Promise<void> {
    this.operations.push(`fsync-file:${path}`);
    if (this.failAt === "fsync-file") throw new Error("fsync-file");
  }

  async fsyncDirectory(path: string): Promise<void> {
    this.operations.push(`fsync-dir:${path}`);
  }

  async realpath(path: string): Promise<string> {
    this.operations.push(`realpath:${path}`);
    if (this.symlinks.has(path)) throw new Error(`Unexpected symlink realpath: ${path}`);
    return path;
  }

  async openFile(path: string, flags: number): Promise<{
    stat: () => Promise<Awaited<ReturnType<MemoryDesktopFileSystem["lstat"]>>>;
    readFile: () => Promise<string>;
    writeFile: (content: string) => Promise<void>;
    sync: () => Promise<void>;
    close: () => Promise<void>;
  }> {
    this.operations.push(`open-file:${path}:${flags}`);
    const temporary = path.endsWith(".tmp-fixed");
    if (!temporary && !this.files.has(path) && !this.symlinks.has(path)) {
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    }
    if (temporary && (this.files.has(path) || this.symlinks.has(path))) {
      throw Object.assign(new Error(`EEXIST: ${path}`), { code: "EEXIST" });
    }
    if (temporary) this.files.set(path, "");
    return {
      stat: () => this.lstat(path),
      readFile: () => this.readFile(path),
      writeFile: async (content) => {
        if (this.failAt === "write") throw new Error("write");
        this.operations.push(`write:${path}`);
        this.files.set(path, content);
        if (this.swapParentAfterTempWrite) {
          this.directoryInodes.set(SECRET_DIRECTORY, 999_999);
        }
      },
      sync: async () => {
        if (this.failAt === "fsync-file") throw new Error("fsync-file");
        this.operations.push(`fsync-file:${path}`);
      },
      close: async () => undefined,
    };
  }

  async openDirectory(path: string, flags: number): Promise<{
    stat: () => Promise<Awaited<ReturnType<MemoryDesktopFileSystem["lstat"]>>>;
    sync: () => Promise<void>;
    close: () => Promise<void>;
  }> {
    this.operations.push(`open-dir:${path}:${flags}`);
    const stats = await this.lstat(path);
    return {
      stat: async () => stats,
      sync: () => this.fsyncDirectory(path),
      close: async () => undefined,
    };
  }
}

function createStore(fileSystem = new MemoryDesktopFileSystem()) {
  return {
    fileSystem,
    store: new DesktopSecretStore({
      fileSystem,
      secretPath: SECRET_PATH,
      platform: "linux",
      randomSuffix: () => "fixed",
      now: () => new Date("2026-07-22T08:00:00.000Z"),
    }),
  };
}

describe("DesktopSecretStore", () => {
  it("creates the parent and a schema-only secret file on first write", async () => {
    const { fileSystem, store } = createStore();

    await store.set(CONNECTION_A, "first-secret");

    expect(fileSystem.directories.has("/private/config/rss-dashboard-cn")).toBe(true);
    expect(JSON.parse(fileSystem.files.get(SECRET_PATH) ?? "")).toEqual({
      schemaVersion: 1,
      secrets: {
        [CONNECTION_A]: {
          apiKey: "first-secret",
          updatedAt: "2026-07-22T08:00:00.000Z",
        },
      },
    });
    expect(fileSystem.files.get(SECRET_PATH)).not.toContain("history");
    expect(fileSystem.files.get(SECRET_PATH)).not.toContain("provider");
  });

  it("sets, reads, replaces, and deletes an API key by UUID connection ID", async () => {
    const { store } = createStore();
    await store.set(CONNECTION_A, "first-secret");
    await expect(store.get(CONNECTION_A)).resolves.toBe("first-secret");

    await store.set(CONNECTION_A, "replacement-secret");
    await expect(store.get(CONNECTION_A)).resolves.toBe("replacement-secret");
    await expect(store.has(CONNECTION_A)).resolves.toBe(true);

    await store.delete(CONNECTION_A);
    await expect(store.get(CONNECTION_A)).resolves.toBeUndefined();
    await expect(store.has(CONNECTION_A)).resolves.toBe(false);
  });

  it("rejects invalid connection IDs before touching the file system", async () => {
    const { fileSystem, store } = createStore();

    await expect(store.set("../../not-a-uuid", "secret")).rejects.toThrow("connection ID");
    expect(fileSystem.operations).toEqual([]);
  });

  it("uses a sibling temp file, fsyncs it, then atomically renames it", async () => {
    const { fileSystem, store } = createStore();
    await store.set(CONNECTION_A, "first-secret");

    const temp = `${SECRET_PATH}.tmp-fixed`;
    expect(fileSystem.operations).toContain(`write:${temp}`);
    expect(fileSystem.operations).toContain(`fsync-file:${temp}`);
    expect(fileSystem.operations).toContain(`rename:${temp}:${SECRET_PATH}`);
    expect(fileSystem.operations.indexOf(`fsync-file:${temp}`)).toBeLessThan(
      fileSystem.operations.indexOf(`rename:${temp}:${SECRET_PATH}`),
    );
    expect(fileSystem.operations).toContain(`fsync-dir:/private/config/rss-dashboard-cn`);
  });

  it("tightens Unix directory and file modes after every write", async () => {
    const { fileSystem, store } = createStore();
    await store.set(CONNECTION_A, "first-secret");
    await store.set(CONNECTION_A, "replacement-secret");

    expect(fileSystem.modes.get("/private/config/rss-dashboard-cn")).toBe(0o700);
    expect(fileSystem.modes.get(SECRET_PATH)).toBe(0o600);
    expect(fileSystem.operations.filter((entry) => entry === `chmod:${SECRET_PATH}:600`)).toHaveLength(2);
  });

  it("rejects a secret file or its immediate parent when it is a symlink", async () => {
    const { fileSystem, store } = createStore();
    fileSystem.directories.add(SECRET_DIRECTORY);
    fileSystem.symlinks.add(SECRET_PATH);
    await expect(store.get(CONNECTION_A)).rejects.toBeInstanceOf(SecretStoreSecurityError);

    const parentCase = createStore();
    parentCase.fileSystem.symlinks.add("/private/config/rss-dashboard-cn");
    await expect(parentCase.store.set(CONNECTION_A, "secret")).rejects.toBeInstanceOf(
      SecretStoreSecurityError,
    );
  });

  it("rejects a symlink in the external secret directory's parent chain", async () => {
    const { fileSystem, store } = createStore();
    fileSystem.symlinks.add("/private/config");

    await expect(store.set(CONNECTION_A, "secret")).rejects.toBeInstanceOf(
      SecretStoreSecurityError,
    );
  });

  it("preserves a corrupt file and reports a typed error instead of replacing it", async () => {
    const { fileSystem, store } = createStore();
    fileSystem.directories.add(SECRET_DIRECTORY);
    fileSystem.files.set(SECRET_PATH, "{ invalid JSON");

    await expect(store.set(CONNECTION_A, "secret")).rejects.toBeInstanceOf(SecretStoreCorruptError);
    expect(fileSystem.files.get(SECRET_PATH)).toBe("{ invalid JSON");
  });

  it.each([
    '{"schemaVersion":1,"secrets":{},"history":[]}',
    '{"schemaVersion":1,"secrets":{},"provider":"TikHub"}',
    `{"schemaVersion":1,"secrets":{"${CONNECTION_A}":{"apiKey":"secret","updatedAt":"2026-07-22T08:00:00.000Z","metadata":{}}}}`,
    '{"schemaVersion":1,"secrets":{"__proto__":{"apiKey":"secret","updatedAt":"2026-07-22T08:00:00.000Z"}}}',
    '{"schemaVersion":1,"secrets":{"constructor":{"apiKey":"secret","updatedAt":"2026-07-22T08:00:00.000Z"}}}',
  ])("rejects a non-exact schema without overwriting it: %s", async (raw) => {
    const { fileSystem, store } = createStore();
    fileSystem.directories.add(SECRET_DIRECTORY);
    fileSystem.files.set(SECRET_PATH, raw);

    await expect(store.set(CONNECTION_A, "replacement-secret")).rejects.toBeInstanceOf(
      SecretStoreCorruptError,
    );
    await expect(store.delete(CONNECTION_A)).rejects.toBeInstanceOf(
      SecretStoreCorruptError,
    );
    expect(fileSystem.files.get(SECRET_PATH)).toBe(raw);
  });

  it("cleans the sibling temporary file whenever an atomic-write stage fails", async () => {
    for (const stage of ["write", "chmod", "fsync-file", "lstat-after-write", "rename"] as const) {
      const { fileSystem, store } = createStore();
      fileSystem.failAt = stage;

      await expect(store.set(CONNECTION_A, "first-secret")).rejects.toThrow(stage);
      expect([...fileSystem.files.keys()]).not.toContain(`${SECRET_PATH}.tmp-fixed`);
      expect(fileSystem.files.get(SECRET_PATH)).toBeUndefined();
    }
  });

  it("rejects a parent directory replacement after opening it and removes the temp secret", async () => {
    const { fileSystem, store } = createStore();
    fileSystem.swapParentAfterTempWrite = true;

    await expect(store.set(CONNECTION_A, "first-secret")).rejects.toBeInstanceOf(
      SecretStoreSecurityError,
    );
    expect(fileSystem.files.has(`${SECRET_PATH}.tmp-fixed`)).toBe(false);
    expect(fileSystem.files.has(SECRET_PATH)).toBe(false);
  });

  it("serializes concurrent stores for the same external secret path", async () => {
    const fileSystem = new MemoryDesktopFileSystem();
    const first = createStore(fileSystem).store;
    const second = createStore(fileSystem).store;

    await Promise.all([
      first.set(CONNECTION_A, "first-secret"),
      second.set(CONNECTION_B, "second-secret"),
    ]);

    await expect(first.get(CONNECTION_A)).resolves.toBe("first-secret");
    await expect(first.get(CONNECTION_B)).resolves.toBe("second-secret");
  });

  it("projects settings/status as hasSecret only", async () => {
    const { store } = createStore();
    await store.set(CONNECTION_A, "never-expose-this-value");

    const status = await store.getStatus(CONNECTION_A);
    expect(status).toEqual({ hasSecret: true });
    expect(JSON.stringify(status)).not.toContain("never-expose-this-value");
    expect(Object.keys(status)).toEqual(["hasSecret"]);
  });
});
