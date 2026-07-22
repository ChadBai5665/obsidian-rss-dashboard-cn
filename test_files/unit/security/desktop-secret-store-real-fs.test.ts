import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import {
  DesktopSecretStore,
  SecretStoreSecurityError,
  type DesktopSecretFileSystem,
} from "../../../src/security/desktop-secret-store";

const CONNECTION_ID = "d4eb3f58-b672-4f73-b9f3-9cd2f0e57a8d";
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function createRealFileSystem(onTempChecked?: (tempPath: string) => Promise<void>, onTempWritten?: (parent: string) => Promise<void>): DesktopSecretFileSystem {
  return {
    lstat: async (path) => {
      try {
        return await lstat(path);
      } catch (error) {
        if (path.includes(".tmp-") && onTempChecked) await onTempChecked(path);
        throw error;
      }
    },
    mkdir,
    rename,
    unlink,
    chmod,
    realpath,
    openFile: async (path, flags, mode) => {
      const handle = await open(path, flags, mode);
      return {
        stat: () => handle.stat(),
        readFile: async () => handle.readFile({ encoding: "utf8" }),
        writeFile: async (content) => {
          await handle.writeFile(content, { encoding: "utf8" });
          if (path.includes(".tmp-") && onTempWritten) await onTempWritten(join(path, ".."));
        },
        truncate: (length) => handle.truncate(length),
        sync: () => handle.sync(),
        close: () => handle.close(),
      };
    },
    openDirectory: async (path, flags) => {
      const handle = await open(path, flags);
      return { stat: () => handle.stat(), sync: () => handle.sync(), close: () => handle.close() };
    },
  };
}

async function createPath(): Promise<{ root: string; parent: string; secretPath: string }> {
  const root = await mkdtemp(join(process.cwd(), ".tmp-rss-secret-real-"));
  temporaryRoots.push(root);
  const parent = join(root, "rss-dashboard-cn");
  await mkdir(parent, { mode: 0o700 });
  return { root, parent, secretPath: join(parent, "secrets.json") };
}

describe("DesktopSecretStore real filesystem ownership", () => {
  it("creates and repairs real Unix secret permissions on every write", async () => {
    const { parent, secretPath } = await createPath();
    await chmod(parent, 0o777);
    const store = new DesktopSecretStore({
      secretPath,
      platform: "linux",
      randomSuffix: () => "permissions",
      fileSystem: createRealFileSystem(),
    });

    await store.set(CONNECTION_ID, "temporary-test-secret");
    expect((await lstat(parent)).mode & 0o777).toBe(0o700);
    expect((await lstat(secretPath)).mode & 0o777).toBe(0o600);

    await chmod(parent, 0o777);
    await chmod(secretPath, 0o666);
    await store.set(CONNECTION_ID, "replacement-test-secret");
    expect((await lstat(parent)).mode & 0o777).toBe(0o700);
    expect((await lstat(secretPath)).mode & 0o777).toBe(0o600);
  });

  it("does not delete a competitor file created after the missing-temp check", async () => {
    const { secretPath } = await createPath();
    const tempPath = `${secretPath}.tmp-fixed`;
    const competitor = "competitor content must survive";
    let created = false;
    const store = new DesktopSecretStore({
      secretPath,
      platform: "linux",
      randomSuffix: () => "fixed",
      fileSystem: createRealFileSystem(async (checkedPath) => {
        if (!created && checkedPath === tempPath) {
          created = true;
          await writeFile(tempPath, competitor, { mode: 0o600, flag: "wx" });
        }
      }),
    });

    await expect(store.set(CONNECTION_ID, "secret-that-must-not-leak")).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(tempPath, "utf8")).toBe(competitor);
  });

  it("zeros a pinned temporary file when its parent is replaced before rename", async () => {
    const { root, parent, secretPath } = await createPath();
    const backup = join(root, "parent-backup");
    const replacementTemp = `${secretPath}.tmp-fixed`;
    const store = new DesktopSecretStore({
      secretPath,
      platform: "linux",
      randomSuffix: () => "fixed",
      fileSystem: createRealFileSystem(undefined, async () => {
        await rename(parent, backup);
        await mkdir(parent, { mode: 0o700 });
        await writeFile(replacementTemp, "replacement-owned-content", { mode: 0o600, flag: "wx" });
      }),
    });

    await expect(store.set(CONNECTION_ID, "secret-that-must-not-leak")).rejects.toBeInstanceOf(SecretStoreSecurityError);
    const backedUpTemp = join(backup, "secrets.json.tmp-fixed");
    expect((await lstat(backedUpTemp)).size).toBe(0);
    expect(await readFile(replacementTemp, "utf8")).toBe("replacement-owned-content");
    expect(await lstat(parent)).toMatchObject({ isDirectory: expect.any(Function) });
  });
});
