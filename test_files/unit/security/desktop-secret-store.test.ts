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

class MemoryDesktopFileSystem implements DesktopSecretFileSystem {
  readonly files = new Map<string, string>();
  readonly directories = new Set<string>(["/", "/private", "/private/config"]);
  readonly symlinks = new Set<string>();
  readonly operations: string[] = [];
  readonly modes = new Map<string, number>();

  async lstat(path: string) {
    this.operations.push(`lstat:${path}`);
    if (this.symlinks.has(path)) return { isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false };
    if (this.directories.has(path)) return { isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false };
    if (this.files.has(path)) return { isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true };
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
    if (options.flag !== "wx") throw new Error("Temp writes must be exclusive");
    if (this.files.has(path) || this.symlinks.has(path)) {
      throw Object.assign(new Error(`EEXIST: ${path}`), { code: "EEXIST" });
    }
    this.files.set(path, content);
  }

  async rename(from: string, to: string): Promise<void> {
    this.operations.push(`rename:${from}:${to}`);
    const value = this.files.get(from);
    if (value === undefined) throw new Error(`No temp file at ${from}`);
    this.files.delete(from);
    this.files.set(to, value);
  }

  async chmod(path: string, mode: number): Promise<void> {
    this.operations.push(`chmod:${path}:${mode.toString(8)}`);
    this.modes.set(path, mode);
  }

  async fsyncFile(path: string): Promise<void> {
    this.operations.push(`fsync-file:${path}`);
  }

  async fsyncDirectory(path: string): Promise<void> {
    this.operations.push(`fsync-dir:${path}`);
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
    fileSystem.files.set(SECRET_PATH, "{ invalid JSON");

    await expect(store.set(CONNECTION_A, "secret")).rejects.toBeInstanceOf(SecretStoreCorruptError);
    expect(fileSystem.files.get(SECRET_PATH)).toBe("{ invalid JSON");
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
