import { execFileSync, spawnSync } from "node:child_process";
import {
  lstat,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkVersionConsistency,
  isStrictSemVer,
} from "../../../scripts/check-version-consistency.mjs";
import { bumpVersion } from "../../../version-bump.mjs";

const temporaryDirectories: string[] = [];

async function fixtureRepository(version = "0.1.0"): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "rss-version-check-"));
  temporaryDirectories.push(repository);
  await writeFile(
    join(repository, "package.json"),
    `${JSON.stringify({
      name: "obsidian-rss-dashboard-cn",
      version,
      author: "ChadBai",
    }, null, 2)}\n`,
  );
  await writeFile(
    join(repository, "manifest.json"),
    `${JSON.stringify({
      id: "rss-dashboard-cn",
      name: "RSS Dashboard CN",
      version,
      minAppVersion: "1.1.0",
      author: "ChadBai",
      isDesktopOnly: true,
    }, null, 2)}\n`,
  );
  await writeFile(
    join(repository, "package-lock.json"),
    `${JSON.stringify({
      name: "obsidian-rss-dashboard-cn",
      version,
      lockfileVersion: 3,
      packages: {
        "": {
          name: "obsidian-rss-dashboard-cn",
          version,
        },
      },
    }, null, 2)}\n`,
  );
  await writeFile(
    join(repository, "versions.json"),
    `${JSON.stringify({ "2.5.0": "1.1.0", [version]: "1.1.0" }, null, 2)}\n`,
  );
  execFileSync("git", ["init", "-q"], { cwd: repository });
  execFileSync("git", ["config", "user.email", "fixture@example.invalid"], {
    cwd: repository,
  });
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: repository });
  execFileSync("git", ["add", "."], { cwd: repository });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: repository });
  return repository;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("version consistency validator", () => {
  it("accepts matching strict SemVer metadata and an exact ASCII tag", async () => {
    const repository = await fixtureRepository("0.1.0-beta.1");
    await expect(
      checkVersionConsistency({ repository, tag: "0.1.0-beta.1" }),
    ).resolves.toMatchObject({ ok: true, errors: [] });
    const packageJson = JSON.parse(
      await readFile(join(repository, "package.json"), "utf8"),
    );
    const manifest = JSON.parse(
      await readFile(join(repository, "manifest.json"), "utf8"),
    );
    expect(packageJson.name).toBe("obsidian-rss-dashboard-cn");
    expect(manifest.id).toBe("rss-dashboard-cn");
    expect(packageJson.name).not.toBe(manifest.id);
    expect(packageJson.author).toBe(manifest.author);
  });

  it("rejects mismatches, invalid SemVer, and a non-current versions tail", async () => {
    const repository = await fixtureRepository();
    const manifest = JSON.parse(
      await readFile(join(repository, "manifest.json"), "utf8"),
    );
    manifest.version = "01.0.0";
    manifest.minAppVersion = "not-semver";
    manifest.id = "other";
    manifest.name = "Other";
    manifest.isDesktopOnly = false;
    await writeFile(
      join(repository, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    await writeFile(
      join(repository, "versions.json"),
      `${JSON.stringify({ "0.1.0": "9.9.9", "2.5.0": "1.1.0" }, null, 2)}\n`,
    );

    const result = await checkVersionConsistency({ repository });

    expect(result.errors).toEqual(
      expect.arrayContaining([
        "manifest-version-invalid",
        "package-manifest-version-mismatch",
        "manifest-min-app-version-invalid",
        "versions-current-entry-mismatch",
        "versions-current-entry-not-last",
        "plugin-id-mismatch",
        "plugin-name-mismatch",
        "plugin-desktop-only-mismatch",
      ]),
    );
  });

  it("rejects leading-v, whitespace, refs, Unicode lookalikes, and unequal tags", async () => {
    const repository = await fixtureRepository();
    for (const tag of [
      "v0.1.0",
      " 0.1.0",
      "0.1.0 ",
      "refs/tags/0.1.0",
      "0.1.1",
      "０.１.０",
    ]) {
      const result = await checkVersionConsistency({ repository, tag });
      expect(result.ok, tag).toBe(false);
      expect(result.errors, tag).toContain("release-tag-invalid");
    }
  });

  it("uses a strict ASCII SemVer grammar", () => {
    expect(isStrictSemVer("0.1.0")).toBe(true);
    expect(isStrictSemVer("2.5.0-beta.10+build.2")).toBe(true);
    expect(isStrictSemVer("1.0.0-1alpha+build.2")).toBe(true);
    for (const invalid of [
      "01.0.0",
      "1.0",
      "1.0.0-",
      "1.0.0-01",
      "1.0.0+",
      "1.0.0\n",
      "１.０.０",
    ]) {
      expect(isStrictSemVer(invalid), invalid).toBe(false);
    }
  });

  it("returns deterministic CLI status without exposing file contents", async () => {
    const repository = await fixtureRepository();
    const script = join(process.cwd(), "scripts/check-version-consistency.mjs");
    const result = spawnSync(
      process.execPath,
      [script, "--repo", repository, "--tag", "v0.1.0"],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stdout.trim()).toBe("release-tag-invalid");
  }, 15_000);

  it("requires canonical package and lock metadata with the exact author", async () => {
    const repository = await fixtureRepository();
    const packageJson = JSON.parse(
      await readFile(join(repository, "package.json"), "utf8"),
    );
    packageJson.name = "other";
    packageJson.author = "Other";
    await writeFile(
      join(repository, "package.json"),
      `${JSON.stringify(packageJson, null, 2)}\n`,
    );
    const packageLock = JSON.parse(
      await readFile(join(repository, "package-lock.json"), "utf8"),
    );
    packageLock.version = "0.2.0";
    packageLock.name = "other";
    packageLock.packages[""].name = "other";
    packageLock.packages[""].version = "0.3.0";
    await writeFile(
      join(repository, "package-lock.json"),
      `${JSON.stringify(packageLock, null, 2)}\n`,
    );

    const result = await checkVersionConsistency({ repository });

    expect(result.errors).toEqual(
      expect.arrayContaining([
        "package-name-mismatch",
        "package-author-mismatch",
        "package-lock-version-mismatch",
        "package-lock-name-mismatch",
        "package-lock-root-name-mismatch",
        "package-lock-root-version-mismatch",
      ]),
    );
  });
});

async function prepareNpmVersionLifecycle(
  repository: string,
  targetVersion = "0.2.0",
): Promise<void> {
  for (const name of ["package.json", "package-lock.json"]) {
    const path = join(repository, name);
    const value = JSON.parse(await readFile(path, "utf8"));
    value.version = targetVersion;
    if (name === "package-lock.json") {
      value.packages[""].version = targetVersion;
    }
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  }
}

const lifecycleEnvironment = {
  npm_package_version: "0.2.0",
  npm_lifecycle_event: "version",
  npm_command: "version",
};

describe("version bump", () => {
  it("requires the npm version lifecycle and strict target version", async () => {
    const repository = await fixtureRepository();
    await expect(
      bumpVersion({
        repository,
        environment: {
          npm_package_version: "0.2.0",
          npm_lifecycle_event: "test",
          npm_command: "version",
        },
      }),
    ).rejects.toThrow("npm-version-lifecycle-required");
    await expect(
      bumpVersion({
        repository,
        environment: {
          npm_package_version: "v0.2.0",
          npm_lifecycle_event: "version",
          npm_command: "version",
        },
      }),
    ).rejects.toThrow("target-version-invalid");
  });

  it("refuses dirty metadata and preserves original bytes", async () => {
    const repository = await fixtureRepository();
    await prepareNpmVersionLifecycle(repository);
    const manifestPath = join(repository, "manifest.json");
    await writeFile(manifestPath, `${await readFile(manifestPath, "utf8")} `);
    const beforeManifest = await readFile(manifestPath);
    const beforeVersions = await readFile(join(repository, "versions.json"));

    await expect(
      bumpVersion({
        repository,
        environment: {
          npm_package_version: "0.2.0",
          npm_lifecycle_event: "version",
          npm_command: "version",
        },
      }),
    ).rejects.toThrow("version-worktree-unexpected-change");
    expect(await readFile(manifestPath)).toEqual(beforeManifest);
    expect(await readFile(join(repository, "versions.json"))).toEqual(
      beforeVersions,
    );
  });

  it("writes two-space JSON with trailing newlines and preserves history order", async () => {
    const repository = await fixtureRepository();
    await prepareNpmVersionLifecycle(repository);
    await bumpVersion({
      repository,
      environment: lifecycleEnvironment,
    });

    const manifest = await readFile(join(repository, "manifest.json"), "utf8");
    const versions = await readFile(join(repository, "versions.json"), "utf8");
    expect(manifest.endsWith("\n")).toBe(true);
    expect(versions.endsWith("\n")).toBe(true);
    expect(manifest).not.toContain("\t");
    expect(versions).not.toContain("\t");
    expect(Object.keys(JSON.parse(versions))).toEqual([
      "2.5.0",
      "0.1.0",
      "0.2.0",
    ]);
    expect(JSON.parse(manifest).version).toBe("0.2.0");
    expect(JSON.parse(versions)["0.2.0"]).toBe("1.1.0");
  });

  it("rolls back both files when installation fails partway", async () => {
    const repository = await fixtureRepository();
    await prepareNpmVersionLifecycle(repository);
    const beforeManifest = await readFile(join(repository, "manifest.json"));
    const beforeVersions = await readFile(join(repository, "versions.json"));

    await expect(
      bumpVersion({
        repository,
        environment: lifecycleEnvironment,
        hooks: {
          beforeVersionsInstall() {
            throw new Error("simulated-second-install-failure");
          },
        },
      }),
    ).rejects.toThrow("simulated-second-install-failure");
    expect(await readFile(join(repository, "manifest.json"))).toEqual(
      beforeManifest,
    );
    expect(await readFile(join(repository, "versions.json"))).toEqual(
      beforeVersions,
    );
  });

  it("rejects forged lifecycle state, lock mismatch, and unrelated dirty files", async () => {
    const repository = await fixtureRepository();
    await expect(
      bumpVersion({
        repository,
        environment: lifecycleEnvironment,
      }),
    ).rejects.toThrow("package-version-target-mismatch");

    await prepareNpmVersionLifecycle(repository);
    const packageLock = JSON.parse(
      await readFile(join(repository, "package-lock.json"), "utf8"),
    );
    packageLock.packages[""].version = "0.1.0";
    await writeFile(
      join(repository, "package-lock.json"),
      `${JSON.stringify(packageLock, null, 2)}\n`,
    );
    await expect(
      bumpVersion({
        repository,
        environment: lifecycleEnvironment,
      }),
    ).rejects.toThrow("package-lock-target-mismatch");

    packageLock.packages[""].version = "0.2.0";
    await writeFile(
      join(repository, "package-lock.json"),
      `${JSON.stringify(packageLock, null, 2)}\n`,
    );
    await writeFile(join(repository, "unrelated.txt"), "dirty");
    await expect(
      bumpVersion({
        repository,
        environment: lifecycleEnvironment,
      }),
    ).rejects.toThrow("version-worktree-unexpected-change");
  });

  it("rejects ignored untracked sensitive metadata during the lifecycle", async () => {
    const repository = await fixtureRepository();
    await prepareNpmVersionLifecycle(repository);
    await writeFile(join(repository, ".git/info/exclude"), ".envrc\n");
    await writeFile(join(repository, ".envrc"), "TOKEN=runtime-secret\n");

    await expect(
      bumpVersion({
        repository,
        environment: lifecycleEnvironment,
      }),
    ).rejects.toThrow("version-worktree-sensitive-untracked");
  });

  it(
    "runs successfully inside an actual temporary npm version lifecycle",
    async () => {
      const repository = await fixtureRepository();
      const packagePath = join(repository, "package.json");
      const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
      packageJson.scripts = {
        version: `node ${JSON.stringify(join(process.cwd(), "version-bump.mjs"))}`,
      };
      await writeFile(
        packagePath,
        `${JSON.stringify(packageJson, null, 2)}\n`,
      );
      execFileSync("git", ["add", "package.json"], { cwd: repository });
      execFileSync("git", ["commit", "-qm", "add version lifecycle"], {
        cwd: repository,
      });

      const result = spawnSync(
        "npm",
        ["version", "0.2.0", "--no-git-tag-version"],
        {
          cwd: repository,
          encoding: "utf8",
        },
      );

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      await expect(
        checkVersionConsistency({ repository }),
      ).resolves.toMatchObject({ ok: true, errors: [] });
    },
    30_000,
  );

  it("keeps exact recovery paths when a restore rename fails", async () => {
    const repository = await fixtureRepository();
    await prepareNpmVersionLifecycle(repository);
    const originalManifest = await readFile(join(repository, "manifest.json"));
    let restoreFailureInjected = false;

    await expect(
      bumpVersion({
        repository,
        environment: lifecycleEnvironment,
        hooks: {
          afterVersionsInstall() {
            throw new Error("simulated-install-failure");
          },
        },
        operations: {
          lstat,
          rename: async (source: string, destination: string) => {
            if (
              !restoreFailureInjected &&
              source.includes(".manifest-") &&
              source.endsWith(".backup") &&
              destination.endsWith("/manifest.json")
            ) {
              restoreFailureInjected = true;
              throw new Error("simulated-restore-failure");
            }
            await rename(source, destination);
          },
          rm,
        },
      }),
    ).rejects.toThrow(/version-recovery-required:.*\.manifest-.*\.backup/);

    const backupName = (await import("node:fs/promises").then(({ readdir }) =>
      readdir(repository),
    )).find(
      (name) => name.startsWith(".manifest-") && name.endsWith(".backup"),
    );
    expect(backupName).toBeDefined();
    expect(await readFile(join(repository, backupName!))).toEqual(
      originalManifest,
    );
  });

  it("retains named prior metadata when backup cleanup fails", async () => {
    const repository = await fixtureRepository();
    await prepareNpmVersionLifecycle(repository);

    await expect(
      bumpVersion({
        repository,
        environment: lifecycleEnvironment,
        operations: {
          rm: async (
            path: string,
            options?: Parameters<typeof rm>[1],
          ) => {
            if (path.endsWith(".backup")) {
              throw new Error("simulated-backup-cleanup-failure");
            }
            await rm(path, options);
          },
        },
      }),
    ).rejects.toThrow(/version-recovery-required:.*\.backup/);

    const names = await import("node:fs/promises").then(({ readdir }) =>
      readdir(repository),
    );
    expect(
      names.some(
        (name) => name.startsWith(".manifest-") && name.endsWith(".backup"),
      ),
    ).toBe(true);
    expect(
      names.some(
        (name) => name.startsWith(".versions-") && name.endsWith(".backup"),
      ),
    ).toBe(true);
  });

  it("reports the primary failure and retained temp path when temp cleanup fails", async () => {
    const repository = await fixtureRepository();
    await prepareNpmVersionLifecycle(repository);

    await expect(
      bumpVersion({
        repository,
        environment: lifecycleEnvironment,
        hooks: {
          beforeVersionsInstall() {
            throw new Error("simulated-primary-version-failure");
          },
        },
        operations: {
          rm: async (
            path: string,
            options?: Parameters<typeof rm>[1],
          ) => {
            if (
              path.includes(".versions-") &&
              path.endsWith(".tmp")
            ) {
              throw new Error("simulated-temp-cleanup-failure");
            }
            await rm(path, options);
          },
        },
      }),
    ).rejects.toThrow(
      /version-operation-failed:simulated-primary-version-failure;version-recovery-required:.*\.versions-.*\.tmp/,
    );

    const names = await import("node:fs/promises").then(({ readdir }) =>
      readdir(repository),
    );
    expect(
      names.some(
        (name) => name.startsWith(".versions-") && name.endsWith(".tmp"),
      ),
    ).toBe(true);
  });
});
