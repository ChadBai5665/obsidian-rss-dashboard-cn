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
  SecretStoreCorruptError,
  SecretStoreSecurityError,
  type DesktopSecretFileSystem,
} from "../../../src/security/desktop-secret-store";

const CONNECTION_ID = "d4eb3f58-b672-4f73-b9f3-9cd2f0e57a8d";
const CONNECTION_ID_UPPER = CONNECTION_ID.toUpperCase();
const CONNECTION_B = "41ecf4d4-7301-4f0d-a333-dafb184a4013";
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
  it("reads a legacy uppercase UUID through lower- and uppercase callers", async () => {
    const { secretPath } = await createPath();
    await writeFile(secretPath, JSON.stringify({
      schemaVersion: 1,
      secrets: {
        [CONNECTION_ID_UPPER]: {
          apiKey: "legacy-uppercase-secret",
          updatedAt: "2026-07-23T00:00:00.000Z",
        },
      },
    }), { mode: 0o600 });
    const store = new DesktopSecretStore({ secretPath, platform: "linux" });

    await expect(store.get(CONNECTION_ID)).resolves.toBe("legacy-uppercase-secret");
    await expect(store.get(CONNECTION_ID_UPPER)).resolves.toBe("legacy-uppercase-secret");
    expect((await lstat(secretPath)).mode & 0o777).toBe(0o600);
  });

  it("atomically migrates legacy uppercase keys to lowercase on set and delete", async () => {
    const { secretPath } = await createPath();
    await writeFile(secretPath, JSON.stringify({
      schemaVersion: 1,
      secrets: {
        [CONNECTION_ID_UPPER]: {
          apiKey: "legacy-a",
          updatedAt: "2026-07-23T00:00:00.000Z",
        },
        [CONNECTION_B.toUpperCase()]: {
          apiKey: "legacy-b",
          updatedAt: "2026-07-23T00:00:00.000Z",
        },
      },
    }), { mode: 0o600 });
    const store = new DesktopSecretStore({
      secretPath,
      platform: "linux",
      randomSuffix: () => "legacy-case-migration",
      now: () => new Date("2026-07-23T01:00:00.000Z"),
    });

    await store.set(CONNECTION_ID_UPPER, "replacement-a");
    const afterSet = JSON.parse(await readFile(secretPath, "utf8")) as {
      secrets: Record<string, { apiKey: string }>;
    };
    expect(Object.keys(afterSet.secrets).sort()).toEqual([
      CONNECTION_B,
      CONNECTION_ID,
    ].sort());
    expect(afterSet.secrets[CONNECTION_ID]?.apiKey).toBe("replacement-a");
    expect((await lstat(secretPath)).mode & 0o777).toBe(0o600);

    await store.delete(CONNECTION_ID_UPPER);
    const afterDelete = JSON.parse(await readFile(secretPath, "utf8")) as {
      secrets: Record<string, { apiKey: string }>;
    };
    expect(afterDelete.secrets).toEqual({
      [CONNECTION_B]: {
        apiKey: "legacy-b",
        updatedAt: "2026-07-23T00:00:00.000Z",
      },
    });

    const directDeletePath = await createPath();
    await writeFile(directDeletePath.secretPath, JSON.stringify({
      schemaVersion: 1,
      secrets: {
        [CONNECTION_ID_UPPER]: {
          apiKey: "delete-me",
          updatedAt: "2026-07-23T00:00:00.000Z",
        },
        [CONNECTION_B.toUpperCase()]: {
          apiKey: "keep-me",
          updatedAt: "2026-07-23T00:00:00.000Z",
        },
      },
    }), { mode: 0o600 });
    const directDeleteStore = new DesktopSecretStore({
      secretPath: directDeletePath.secretPath,
      platform: "linux",
      randomSuffix: () => "legacy-direct-delete",
    });
    await directDeleteStore.delete(CONNECTION_ID_UPPER);
    const directDelete = JSON.parse(
      await readFile(directDeletePath.secretPath, "utf8"),
    ) as { secrets: Record<string, unknown> };
    expect(Object.keys(directDelete.secrets)).toEqual([CONNECTION_B]);
  });

  it("collapses identical case-folded duplicate records and rejects conflicting ones", async () => {
    const identical = {
      apiKey: "same-secret",
      updatedAt: "2026-07-23T00:00:00.000Z",
    };
    const safePath = await createPath();
    await writeFile(safePath.secretPath, JSON.stringify({
      schemaVersion: 1,
      secrets: {
        [CONNECTION_ID]: identical,
        [CONNECTION_ID_UPPER]: identical,
      },
    }), { mode: 0o600 });
    const safeStore = new DesktopSecretStore({
      secretPath: safePath.secretPath,
      platform: "linux",
      randomSuffix: () => "duplicate-collapse",
    });
    await expect(safeStore.get(CONNECTION_ID_UPPER)).resolves.toBe("same-secret");
    await safeStore.set(CONNECTION_ID, "replacement-secret");
    const collapsed = JSON.parse(await readFile(safePath.secretPath, "utf8")) as {
      secrets: Record<string, unknown>;
    };
    expect(Object.keys(collapsed.secrets)).toEqual([CONNECTION_ID]);

    for (const conflictingRecord of [
      {
        apiKey: "different-secret",
        updatedAt: "2026-07-23T00:00:00.000Z",
      },
      {
        apiKey: "same-secret",
        updatedAt: "2026-07-23T00:00:01.000Z",
      },
    ]) {
      const conflictPath = await createPath();
      const conflictingRaw = JSON.stringify({
        schemaVersion: 1,
        secrets: {
          [CONNECTION_ID]: identical,
          [CONNECTION_ID_UPPER]: conflictingRecord,
        },
      });
      await writeFile(conflictPath.secretPath, conflictingRaw, { mode: 0o600 });
      const conflictStore = new DesktopSecretStore({
        secretPath: conflictPath.secretPath,
        platform: "linux",
      });
      await expect(conflictStore.get(CONNECTION_ID)).rejects.toBeInstanceOf(
        SecretStoreCorruptError,
      );
      await expect(
        conflictStore.set(CONNECTION_ID, "must-not-overwrite-conflict"),
      ).rejects.toBeInstanceOf(SecretStoreCorruptError);
      expect(await readFile(conflictPath.secretPath, "utf8")).toBe(conflictingRaw);
    }
  });

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
