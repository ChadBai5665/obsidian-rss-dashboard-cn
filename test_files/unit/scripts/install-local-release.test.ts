/* eslint-disable obsidianmd/hardcoded-config-path -- This filesystem installer must validate the documented on-disk plugin location without an Obsidian Vault instance. */
import * as nodeFileSystem from "node:fs/promises";
import { Buffer } from "node:buffer";
import { constants as fileConstants } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  installLocalRelease,
  parseInstallArguments,
} from "../../../scripts/install-local-release.mjs";

const temporaryDirectories: string[] = [];
const releaseFiles = ["main.js", "manifest.json", "styles.css"] as const;

interface Fixture {
  backupParent: string;
  historyFile: string;
  releaseDir: string;
  repositoryRoot: string;
  targetDir: string;
}

const releaseManifest = {
  author: "ChadBai",
  description: "RSS dashboard",
  id: "rss-dashboard-cn",
  minAppVersion: "1.1.0",
  name: "RSS Dashboard CN",
  version: "0.1.0",
};

const targetManifest = {
  ...releaseManifest,
  version: "0.0.9",
};

async function createFixture(): Promise<Fixture> {
  const root = await nodeFileSystem.mkdtemp(join(tmpdir(), "rss-local-install-"));
  temporaryDirectories.push(root);
  const vaultRoot = join(root, "vault");
  const targetDir = join(
    vaultRoot,
    ".obsidian",
    "plugins",
    "rss-dashboard-cn",
  );
  const releaseDir = join(root, "release");
  const historyFile = join(
    vaultRoot,
    ".rss-dashboard-data",
    "collections",
    "day.jsonl",
  );
  await nodeFileSystem.mkdir(targetDir, { recursive: true });
  await nodeFileSystem.mkdir(releaseDir, { recursive: true });
  await nodeFileSystem.mkdir(dirname(historyFile), { recursive: true });
  await Promise.all([
    nodeFileSystem.writeFile(join(targetDir, "main.js"), "old-main\n"),
    nodeFileSystem.writeFile(
      join(targetDir, "manifest.json"),
      `${JSON.stringify(targetManifest)}\n`,
    ),
    nodeFileSystem.writeFile(join(targetDir, "styles.css"), "old-style\n"),
    nodeFileSystem.writeFile(join(targetDir, "data.json"), '{"saved":true}\n'),
    nodeFileSystem.writeFile(join(targetDir, "local-only.txt"), "keep-me\n"),
    nodeFileSystem.writeFile(join(root, "main.js"), "new-main\n"),
    nodeFileSystem.writeFile(join(root, "manifest.json"), `${JSON.stringify(releaseManifest)}\n`),
    nodeFileSystem.writeFile(join(root, "styles.css"), "new-style\n"),
    nodeFileSystem.writeFile(
      join(root, "package.json"),
      `${JSON.stringify({ name: "obsidian-rss-dashboard-cn", version: "0.1.0" })}\n`,
    ),
    nodeFileSystem.writeFile(join(releaseDir, "main.js"), "new-main\n"),
    nodeFileSystem.writeFile(
      join(releaseDir, "manifest.json"),
      `${JSON.stringify(releaseManifest)}\n`,
    ),
    nodeFileSystem.writeFile(join(releaseDir, "styles.css"), "new-style\n"),
    nodeFileSystem.writeFile(join(root, "do-not-copy.txt"), "private\n"),
    nodeFileSystem.writeFile(historyFile, '{"history":"keep"}\n'),
  ]);
  const realTargetDir = await nodeFileSystem.realpath(targetDir);
  return {
    backupParent: dirname(realTargetDir),
    historyFile: await nodeFileSystem.realpath(historyFile),
    releaseDir: await nodeFileSystem.realpath(releaseDir),
    repositoryRoot: await nodeFileSystem.realpath(root),
    targetDir: realTargetDir,
  };
}

async function expectOldProgramFiles(fixture: Fixture): Promise<void> {
  expect(await nodeFileSystem.readFile(join(fixture.targetDir, "main.js"), "utf8")).toBe(
    "old-main\n",
  );
  expect(
    JSON.parse(await nodeFileSystem.readFile(join(fixture.targetDir, "manifest.json"), "utf8")),
  ).toEqual(targetManifest);
  expect(await nodeFileSystem.readFile(join(fixture.targetDir, "styles.css"), "utf8")).toBe(
    "old-style\n",
  );
}

async function expectNoInstallerResidue(fixture: Fixture): Promise<void> {
  const targetNames = await nodeFileSystem.readdir(fixture.targetDir);
  expect(targetNames.filter((name) => name.endsWith(".tmp"))).toEqual([]);
  const siblingNames = await nodeFileSystem.readdir(fixture.backupParent);
  expect(siblingNames.filter((name) => name.endsWith(".install.lock"))).toEqual([]);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      nodeFileSystem.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("safe local release installer", () => {
  it("requires one explicit target argument", () => {
    expect(() => parseInstallArguments([])).toThrow("install-target-required");
    expect(() => parseInstallArguments(["--target"])).toThrow(
      "install-target-required",
    );
    expect(() => parseInstallArguments(["--target", "/vault/plugin", "extra"])).toThrow(
      "install-arguments-invalid",
    );
    expect(parseInstallArguments(["--target", "/vault/plugin"])).toEqual({
      targetDir: "/vault/plugin",
    });
  });

  it("updates only program artifacts while preserving data and history", async () => {
    const fixture = await createFixture();

    const result = await installLocalRelease({
      releaseDir: fixture.releaseDir,
      targetDir: fixture.targetDir,
    });

    expect(await nodeFileSystem.readFile(join(fixture.targetDir, "main.js"), "utf8")).toBe(
      "new-main\n",
    );
    expect(
      await nodeFileSystem.readFile(join(fixture.targetDir, "manifest.json"), "utf8"),
    ).toContain('"version":"0.1.0"');
    expect(
      await nodeFileSystem.readFile(join(fixture.targetDir, "styles.css"), "utf8"),
    ).toBe("new-style\n");
    expect(await nodeFileSystem.readFile(join(fixture.targetDir, "data.json"), "utf8")).toBe(
      '{"saved":true}\n',
    );
    expect(await nodeFileSystem.readFile(fixture.historyFile, "utf8")).toBe(
      '{"history":"keep"}\n',
    );
    expect(
      await nodeFileSystem.readFile(join(fixture.targetDir, "local-only.txt"), "utf8"),
    ).toBe("keep-me\n");
    await expect(
      nodeFileSystem.access(join(fixture.targetDir, "do-not-copy.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    expect(dirname(result.backupDir)).toBe(fixture.backupParent);
    expect(basename(result.backupDir)).toMatch(
      /^rss-dashboard-cn\.backup-\d{8}T\d{6}\.\d{3}Z(?:-\d+)?$/,
    );
    expect(result.installed).toEqual(releaseFiles);
    expect(result.integrity.dataJson.before).toBe(result.integrity.dataJson.after);
    expect(result.integrity.history.before).toBe(result.integrity.history.after);
    expect(result.integrity.dataJson.unchanged).toBe(true);
    expect(result.integrity.history.unchanged).toBe(true);

    expect(await nodeFileSystem.readFile(join(result.backupDir, "main.js"), "utf8")).toBe(
      "old-main\n",
    );
    expect(await nodeFileSystem.readFile(join(result.backupDir, "data.json"), "utf8")).toBe(
      '{"saved":true}\n',
    );
    await expect(nodeFileSystem.access(join(result.backupDir, "manifest.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      JSON.parse(
        await nodeFileSystem.readFile(join(result.backupDir, "manifest.json.restore"), "utf8"),
      ),
    ).toEqual(targetManifest);
    for (const file of ["main.js", "manifest.json.restore", "styles.css", "data.json"] as const) {
      const mode = (await nodeFileSystem.stat(join(result.backupDir, file))).mode;
      expect(mode & (fileConstants.S_IWUSR | fileConstants.S_IWGRP | fileConstants.S_IWOTH)).toBe(0);
    }
  });

  it("rejects targets outside an exact .obsidian/plugins/<id> location", async () => {
    const fixture = await createFixture();
    const outside = join(dirname(dirname(dirname(fixture.targetDir))), "not-a-plugin");
    await nodeFileSystem.mkdir(outside);
    await nodeFileSystem.writeFile(
      join(outside, "manifest.json"),
      '{"id":"not-a-plugin"}\n',
    );

    await expect(
      installLocalRelease({ releaseDir: fixture.releaseDir, targetDir: outside }),
    ).rejects.toThrow("install-target-location-invalid");
  });

  it("rejects missing, mismatched, and wrongly located manifest identities before mutation", async () => {
    const missing = await createFixture();
    await nodeFileSystem.rm(join(missing.releaseDir, "manifest.json"));
    await expect(
      installLocalRelease({ releaseDir: missing.releaseDir, targetDir: missing.targetDir }),
    ).rejects.toThrow("install-release-artifact-missing");
    expect(await nodeFileSystem.readFile(join(missing.targetDir, "main.js"), "utf8")).toBe(
      "old-main\n",
    );

    const mismatch = await createFixture();
    await nodeFileSystem.writeFile(
      join(mismatch.releaseDir, "manifest.json"),
      `${JSON.stringify({ ...releaseManifest, id: "another-plugin" })}\n`,
    );
    await expect(
      installLocalRelease({
        releaseDir: mismatch.releaseDir,
        targetDir: mismatch.targetDir,
      }),
    ).rejects.toThrow("install-manifest-id-mismatch");

    const wrongFolder = await createFixture();
    const renamed = join(dirname(wrongFolder.targetDir), "wrong-folder");
    await nodeFileSystem.rename(wrongFolder.targetDir, renamed);
    await expect(
      installLocalRelease({ releaseDir: wrongFolder.releaseDir, targetDir: renamed }),
    ).rejects.toThrow("install-target-id-mismatch");
  });

  it("strictly validates release and target Obsidian manifests before mutation", async () => {
    const missingReleaseField = await createFixture();
    const withoutName = {
      author: releaseManifest.author,
      description: releaseManifest.description,
      id: releaseManifest.id,
      minAppVersion: releaseManifest.minAppVersion,
      version: releaseManifest.version,
    };
    await nodeFileSystem.writeFile(
      join(missingReleaseField.releaseDir, "manifest.json"),
      `${JSON.stringify(withoutName)}\n`,
    );
    await expect(
      installLocalRelease({
        releaseDir: missingReleaseField.releaseDir,
        targetDir: missingReleaseField.targetDir,
      }),
    ).rejects.toThrow("install-release-manifest-invalid");
    await expectOldProgramFiles(missingReleaseField);

    const numericReleaseVersion = await createFixture();
    await nodeFileSystem.writeFile(
      join(numericReleaseVersion.releaseDir, "manifest.json"),
      `${JSON.stringify({ ...releaseManifest, version: 1 })}\n`,
    );
    await expect(
      installLocalRelease({
        releaseDir: numericReleaseVersion.releaseDir,
        targetDir: numericReleaseVersion.targetDir,
      }),
    ).rejects.toThrow("install-release-manifest-invalid");
    await expectOldProgramFiles(numericReleaseVersion);

    const invalidTargetVersion = await createFixture();
    await nodeFileSystem.writeFile(
      join(invalidTargetVersion.targetDir, "manifest.json"),
      `${JSON.stringify({ ...targetManifest, version: "01.0.0" })}\n`,
    );
    await expect(
      installLocalRelease({
        releaseDir: invalidTargetVersion.releaseDir,
        targetDir: invalidTargetVersion.targetDir,
      }),
    ).rejects.toThrow("install-target-manifest-invalid");
  });

  it("rejects stale or mixed release artifacts against repository metadata", async () => {
    const staleRelease = await createFixture();
    await nodeFileSystem.writeFile(
      join(staleRelease.releaseDir, "manifest.json"),
      `${JSON.stringify({ ...releaseManifest, version: "0.0.9" })}\n`,
    );
    await expect(
      installLocalRelease({
        releaseDir: staleRelease.releaseDir,
        targetDir: staleRelease.targetDir,
      }),
    ).rejects.toThrow("install-release-artifacts-invalid");
    await expectOldProgramFiles(staleRelease);

    const packageMismatch = await createFixture();
    await nodeFileSystem.writeFile(
      join(packageMismatch.repositoryRoot, "package.json"),
      `${JSON.stringify({ name: "obsidian-rss-dashboard-cn", version: "0.2.0" })}\n`,
    );
    await expect(
      installLocalRelease({
        releaseDir: packageMismatch.releaseDir,
        targetDir: packageMismatch.targetDir,
      }),
    ).rejects.toThrow("install-release-artifacts-invalid");
    await expectOldProgramFiles(packageMismatch);

    const bundleMismatch = await createFixture();
    await nodeFileSystem.writeFile(join(bundleMismatch.releaseDir, "main.js"), "stale-main\n");
    await expect(
      installLocalRelease({
        releaseDir: bundleMismatch.releaseDir,
        targetDir: bundleMismatch.targetDir,
      }),
    ).rejects.toThrow("install-release-artifacts-invalid");
    await expectOldProgramFiles(bundleMismatch);

    const extraArtifact = await createFixture();
    await nodeFileSystem.writeFile(join(extraArtifact.releaseDir, "unexpected.txt"), "no\n");
    await expect(
      installLocalRelease({
        releaseDir: extraArtifact.releaseDir,
        targetDir: extraArtifact.targetDir,
      }),
    ).rejects.toThrow("install-release-artifacts-invalid");
  });

  it("rejects symbolic-link targets and source or destination artifacts", async () => {
    const linkedTarget = await createFixture();
    const targetLink = join(linkedTarget.backupParent, "linked-plugin");
    await nodeFileSystem.symlink(linkedTarget.targetDir, targetLink, "dir");
    await expect(
      installLocalRelease({ releaseDir: linkedTarget.releaseDir, targetDir: targetLink }),
    ).rejects.toThrow("install-target-symlink-rejected");

    const linkedSource = await createFixture();
    await nodeFileSystem.rm(join(linkedSource.releaseDir, "main.js"));
    await nodeFileSystem.symlink(
      join(linkedSource.releaseDir, "styles.css"),
      join(linkedSource.releaseDir, "main.js"),
    );
    await expect(
      installLocalRelease({
        releaseDir: linkedSource.releaseDir,
        targetDir: linkedSource.targetDir,
      }),
    ).rejects.toThrow("install-release-artifact-symlink-rejected");

    const linkedDestination = await createFixture();
    await nodeFileSystem.rm(join(linkedDestination.targetDir, "main.js"));
    await nodeFileSystem.symlink(
      join(linkedDestination.targetDir, "styles.css"),
      join(linkedDestination.targetDir, "main.js"),
    );
    await expect(
      installLocalRelease({
        releaseDir: linkedDestination.releaseDir,
        targetDir: linkedDestination.targetDir,
      }),
    ).rejects.toThrow("install-target-artifact-symlink-rejected");
  });

  it("requires all existing target program files and rejects hard links", async () => {
    const missingManifest = await createFixture();
    await nodeFileSystem.rm(join(missingManifest.targetDir, "manifest.json"));
    await expect(
      installLocalRelease({
        releaseDir: missingManifest.releaseDir,
        targetDir: missingManifest.targetDir,
      }),
    ).rejects.toThrow("install-target-manifest-missing");

    for (const missingName of ["main.js", "styles.css"] as const) {
      const missing = await createFixture();
      await nodeFileSystem.rm(join(missing.targetDir, missingName));
      await expect(
        installLocalRelease({ releaseDir: missing.releaseDir, targetDir: missing.targetDir }),
      ).rejects.toThrow("install-target-artifact-missing");
    }

    const hardLinkedSource = await createFixture();
    const sourceLink = join(hardLinkedSource.repositoryRoot, "linked-main.js");
    await nodeFileSystem.link(join(hardLinkedSource.releaseDir, "main.js"), sourceLink);
    await expect(
      installLocalRelease({
        releaseDir: hardLinkedSource.releaseDir,
        targetDir: hardLinkedSource.targetDir,
      }),
    ).rejects.toThrow("install-release-artifact-hardlink-rejected");
    await expectOldProgramFiles(hardLinkedSource);

    const hardLinkedData = await createFixture();
    const dataLink = join(hardLinkedData.repositoryRoot, "linked-data.json");
    await nodeFileSystem.link(join(hardLinkedData.targetDir, "data.json"), dataLink);
    await expect(
      installLocalRelease({
        releaseDir: hardLinkedData.releaseDir,
        targetDir: hardLinkedData.targetDir,
      }),
    ).rejects.toThrow("install-target-artifact-hardlink-rejected");
    await expectOldProgramFiles(hardLinkedData);
  });

  it("streams large history fingerprints without readFile and never follows history symlinks", async () => {
    const fixture = await createFixture();
    const historyRoot = join(dirname(dirname(fixture.historyFile)));
    await nodeFileSystem.writeFile(fixture.historyFile, Buffer.alloc(3 * 1024 * 1024, 0x61));
    const secret = join(fixture.repositoryRoot, "external-secret.txt");
    await nodeFileSystem.writeFile(secret, "do-not-read\n");
    await nodeFileSystem.symlink(secret, join(dirname(fixture.historyFile), "secret-link"));

    let maxHistoryRead = 0;
    let externalSecretOpened = false;
    const fileSystem = {
      ...nodeFileSystem,
      open: async (...arguments_: Parameters<typeof nodeFileSystem.open>) => {
        const path = typeof arguments_[0] === "string" ? arguments_[0] : "";
        if (path === secret) externalSecretOpened = true;
        const handle = await nodeFileSystem.open(...arguments_);
        if (!path.startsWith(historyRoot)) return handle;
        return new Proxy(handle, {
          get(target, property) {
            if (property === "read") {
              return async (...readArguments: unknown[]) => {
                const first = readArguments[0];
                if (Buffer.isBuffer(first) || first instanceof Uint8Array) {
                  maxHistoryRead = Math.max(maxHistoryRead, first.byteLength);
                }
                return Reflect.apply(target.read, target, readArguments);
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
      readFile: async (path: Parameters<typeof nodeFileSystem.readFile>[0], ...rest: unknown[]) => {
        const pathText = typeof path === "string" ? path : "";
        if (pathText.startsWith(historyRoot)) {
          throw new Error("history-readFile-forbidden");
        }
        if (pathText === secret) externalSecretOpened = true;
        return Reflect.apply(nodeFileSystem.readFile, nodeFileSystem, [path, ...rest]);
      },
    };

    await installLocalRelease({
      fileSystem,
      releaseDir: fixture.releaseDir,
      targetDir: fixture.targetDir,
    });

    expect(maxHistoryRead).toBeGreaterThan(0);
    expect(maxHistoryRead).toBeLessThanOrEqual(64 * 1024);
    expect(externalSecretOpened).toBe(false);
  });

  it("commits each artifact by renaming a complete temporary file in the target directory", async () => {
    const fixture = await createFixture();
    const renames: Array<[string, string]> = [];
    const fileSystem = {
      ...nodeFileSystem,
      rename: async (source: string, destination: string) => {
        renames.push([source, destination]);
        await nodeFileSystem.rename(source, destination);
      },
    };

    await installLocalRelease({
      fileSystem,
      releaseDir: fixture.releaseDir,
      targetDir: fixture.targetDir,
    });

    const installRenames = renames.filter(([, destination]) =>
      releaseFiles.includes(basename(destination) as (typeof releaseFiles)[number]),
    );
    expect(installRenames).toHaveLength(3);
    for (const [source, destination] of installRenames) {
      expect(dirname(source)).toBe(fixture.targetDir);
      expect(basename(source)).toMatch(/^\.rss-dashboard-cn-install-.+\.tmp$/);
      expect(dirname(destination)).toBe(fixture.targetDir);
    }
    expect(
      (await nodeFileSystem.readdir(fixture.targetDir)).filter((name) =>
        name.includes("-install-"),
      ),
    ).toEqual([]);
  });

  it("rejects a source replaced after validation without copying external contents", async () => {
    const fixture = await createFixture();
    const source = join(fixture.releaseDir, "main.js");
    const secret = join(fixture.repositoryRoot, "external-secret.js");
    await nodeFileSystem.writeFile(secret, "external-secret-marker\n");

    await expect(
      installLocalRelease({
        hooks: {
          beforeProgramCopy: async (name: string) => {
            if (name !== "main.js") return;
            await nodeFileSystem.rm(source);
            await nodeFileSystem.symlink(secret, source);
          },
        },
        releaseDir: fixture.releaseDir,
        targetDir: fixture.targetDir,
      }),
    ).rejects.toThrow("install-release-artifact-identity-changed");

    await expectOldProgramFiles(fixture);
    expect(await nodeFileSystem.readFile(join(fixture.targetDir, "main.js"), "utf8")).not.toContain(
      "external-secret-marker",
    );
    await expectNoInstallerResidue(fixture);
  });

  it("rejects a regular source inode replacement after validation", async () => {
    const fixture = await createFixture();
    const source = join(fixture.releaseDir, "styles.css");

    await expect(
      installLocalRelease({
        hooks: {
          beforeProgramCopy: async (name: string) => {
            if (name !== "styles.css") return;
            await nodeFileSystem.rename(source, `${source}.old`);
            await nodeFileSystem.writeFile(source, "replacement-style\n");
          },
        },
        releaseDir: fixture.releaseDir,
        targetDir: fixture.targetDir,
      }),
    ).rejects.toThrow("install-release-artifact-identity-changed");

    await expectOldProgramFiles(fixture);
    await expectNoInstallerResidue(fixture);
  });

  it("pins the target directory and destination artifacts around mutation", async () => {
    const directoryRace = await createFixture();
    let fakeDirectoryIdentity = false;
    const directoryFileSystem = {
      ...nodeFileSystem,
      lstat: async (path: Parameters<typeof nodeFileSystem.lstat>[0], ...rest: unknown[]) => {
        const status = await Reflect.apply(nodeFileSystem.lstat, nodeFileSystem, [path, ...rest]);
        if (fakeDirectoryIdentity && String(path) === directoryRace.targetDir) {
          return new Proxy(status, {
            get(target, property, receiver) {
              if (property === "ino") return target.ino + 1;
              return Reflect.get(target, property, receiver);
            },
          });
        }
        return status;
      },
    };
    await expect(
      installLocalRelease({
        fileSystem: directoryFileSystem,
        hooks: {
          beforeProgramCommit: async () => {
            fakeDirectoryIdentity = true;
          },
        },
        releaseDir: directoryRace.releaseDir,
        targetDir: directoryRace.targetDir,
      }),
    ).rejects.toThrow("install-target-directory-identity-changed");
    fakeDirectoryIdentity = false;
    await expectOldProgramFiles(directoryRace);
    await expectNoInstallerResidue(directoryRace);

    const artifactRace = await createFixture();
    const originalMain = join(artifactRace.targetDir, "main.js");
    await expect(
      installLocalRelease({
        hooks: {
          beforeProgramCommit: async (name: string) => {
            if (name !== "main.js") return;
            await nodeFileSystem.rename(originalMain, `${originalMain}.raced`);
            await nodeFileSystem.writeFile(originalMain, "raced-old-main\n");
          },
        },
        releaseDir: artifactRace.releaseDir,
        targetDir: artifactRace.targetDir,
      }),
    ).rejects.toThrow("install-target-artifact-identity-changed");
    expect(await nodeFileSystem.readFile(originalMain, "utf8")).toBe("raced-old-main\n");
    await expectNoInstallerResidue(artifactRace);
  });

  it("pins the target directory around final preserved-data hashing", async () => {
    const fixture = await createFixture();
    let raceNextTargetCheck = false;
    const fileSystem = {
      ...nodeFileSystem,
      lstat: async (path: Parameters<typeof nodeFileSystem.lstat>[0], ...rest: unknown[]) => {
        const status = await Reflect.apply(nodeFileSystem.lstat, nodeFileSystem, [path, ...rest]);
        if (raceNextTargetCheck && path === fixture.targetDir) {
          raceNextTargetCheck = false;
          return new Proxy(status, {
            get(target, property, receiver) {
              if (property === "ino") return target.ino + 1;
              return Reflect.get(target, property, receiver);
            },
          });
        }
        return status;
      },
    };

    await expect(
      installLocalRelease({
        fileSystem,
        hooks: {
          afterProgramVerification: async () => {
            raceNextTargetCheck = true;
          },
        },
        releaseDir: fixture.releaseDir,
        targetDir: fixture.targetDir,
      }),
    ).rejects.toThrow("install-failed-program-files-restored");
    await expectOldProgramFiles(fixture);
    await expectNoInstallerResidue(fixture);
  });

  it("serializes installs with an atomic sibling lock and cleans the lock", async () => {
    const fixture = await createFixture();
    let releaseFirst!: () => void;
    let announceFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      announceFirst = resolve;
    });
    const continueFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = installLocalRelease({
      hooks: {
        afterLock: async () => {
          announceFirst();
          await continueFirst;
        },
      },
      releaseDir: fixture.releaseDir,
      targetDir: fixture.targetDir,
    });
    await Promise.race([
      firstStarted,
      first.then(() => {
        throw new Error("install-lock-hook-not-reached");
      }),
    ]);

    await expect(
      installLocalRelease({ releaseDir: fixture.releaseDir, targetDir: fixture.targetDir }),
    ).rejects.toThrow("install-already-running");
    releaseFirst();
    await first;
    await expectNoInstallerResidue(fixture);
  });

  it("fsyncs copied files and containing directories before reporting success", async () => {
    const fixture = await createFixture();
    let fileSyncs = 0;
    let directorySyncs = 0;
    const fileSystem = {
      ...nodeFileSystem,
      open: async (...arguments_: Parameters<typeof nodeFileSystem.open>) => {
        const handle = await nodeFileSystem.open(...arguments_);
        const status = await handle.stat();
        return new Proxy(handle, {
          get(target, property) {
            if (property === "sync") {
              return async () => {
                if (status.isDirectory()) directorySyncs += 1;
                else fileSyncs += 1;
                return target.sync();
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    };

    await installLocalRelease({
      fileSystem,
      releaseDir: fixture.releaseDir,
      targetDir: fixture.targetDir,
    });

    expect(fileSyncs).toBeGreaterThanOrEqual(7);
    expect(directorySyncs).toBeGreaterThanOrEqual(3);
  });

  it.each([1, 2, 3])(
    "restores all three program artifacts when commit rename %i fails",
    async (failingRename) => {
    const fixture = await createFixture();
    let installRename = 0;
    const fileSystem = {
      ...nodeFileSystem,
      rename: async (source: string, destination: string) => {
        if (
          basename(source).startsWith(".rss-dashboard-cn-install-") &&
          releaseFiles.includes(basename(destination) as (typeof releaseFiles)[number])
        ) {
          installRename += 1;
          if (installRename === failingRename) {
            throw new Error("synthetic-rename-failure");
          }
        }
        await nodeFileSystem.rename(source, destination);
      },
    };

    await expect(
      installLocalRelease({
        fileSystem,
        releaseDir: fixture.releaseDir,
        targetDir: fixture.targetDir,
      }),
    ).rejects.toThrow(
      failingRename === 1
        ? "install-failed-before-program-change"
        : "install-failed-program-files-restored",
    );

    await expectOldProgramFiles(fixture);
    expect(await nodeFileSystem.readFile(join(fixture.targetDir, "data.json"), "utf8")).toBe(
      '{"saved":true}\n',
    );
    expect(await nodeFileSystem.readFile(fixture.historyFile, "utf8")).toBe(
      '{"history":"keep"}\n',
    );
    const backups = (await nodeFileSystem.readdir(fixture.backupParent)).filter((name) =>
      name.startsWith("rss-dashboard-cn.backup-"),
    );
    expect(backups).toHaveLength(1);
    await expectNoInstallerResidue(fixture);
    },
  );

  it("restores program files when installed program verification fails", async () => {
    const fixture = await createFixture();
    await expect(
      installLocalRelease({
        hooks: {
          afterProgramCommit: async () => {
            await nodeFileSystem.writeFile(join(fixture.targetDir, "main.js"), "corrupt\n");
          },
        },
        releaseDir: fixture.releaseDir,
        targetDir: fixture.targetDir,
      }),
    ).rejects.toThrow("install-failed-program-files-restored");
    await expectOldProgramFiles(fixture);
    await expectNoInstallerResidue(fixture);
  });

  it("restores program files and reports preserved data mutation", async () => {
    const fixture = await createFixture();
    await expect(
      installLocalRelease({
        hooks: {
          afterProgramVerification: async () => {
            await nodeFileSystem.writeFile(join(fixture.targetDir, "data.json"), '{"raced":true}\n');
          },
        },
        releaseDir: fixture.releaseDir,
        targetDir: fixture.targetDir,
      }),
    ).rejects.toThrow("install-failed-program-files-restored");
    await expectOldProgramFiles(fixture);
    expect(await nodeFileSystem.readFile(join(fixture.targetDir, "data.json"), "utf8")).toBe(
      '{"raced":true}\n',
    );
    await expectNoInstallerResidue(fixture);
  });

  it("cleans an incomplete backup and lock when backup copy fails", async () => {
    const fixture = await createFixture();
    await expect(
      installLocalRelease({
        hooks: {
          beforeBackupCopy: async (name: string) => {
            if (name === "manifest.json") throw new Error("synthetic-backup-failure");
          },
        },
        releaseDir: fixture.releaseDir,
        targetDir: fixture.targetDir,
      }),
    ).rejects.toThrow("install-backup-failed");
    await expectOldProgramFiles(fixture);
    expect(
      (await nodeFileSystem.readdir(fixture.backupParent)).filter((name) =>
        name.startsWith("rss-dashboard-cn.backup-"),
      ),
    ).toEqual([]);
    await expectNoInstallerResidue(fixture);
  });
});
