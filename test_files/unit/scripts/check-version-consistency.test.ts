import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
      author: "Confirmed Author",
    }, null, 2)}\n`,
  );
  await writeFile(
    join(repository, "manifest.json"),
    `${JSON.stringify({
      id: "rss-dashboard-cn",
      name: "RSS Dashboard CN",
      version,
      minAppVersion: "1.1.0",
      author: "Confirmed Author",
      isDesktopOnly: true,
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
  });
});

describe("version bump", () => {
  it("requires the npm version lifecycle and strict target version", async () => {
    const repository = await fixtureRepository();
    await expect(
      bumpVersion({
        repository,
        environment: {
          npm_package_version: "0.2.0",
          npm_lifecycle_event: "test",
        },
      }),
    ).rejects.toThrow("npm-version-lifecycle-required");
    await expect(
      bumpVersion({
        repository,
        environment: {
          npm_package_version: "v0.2.0",
          npm_lifecycle_event: "version",
        },
      }),
    ).rejects.toThrow("target-version-invalid");
  });

  it("refuses dirty metadata and preserves original bytes", async () => {
    const repository = await fixtureRepository();
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
        },
      }),
    ).rejects.toThrow("version-metadata-dirty");
    expect(await readFile(manifestPath)).toEqual(beforeManifest);
    expect(await readFile(join(repository, "versions.json"))).toEqual(
      beforeVersions,
    );
  });

  it("writes two-space JSON with trailing newlines and preserves history order", async () => {
    const repository = await fixtureRepository();
    await bumpVersion({
      repository,
      environment: {
        npm_package_version: "0.2.0",
        npm_lifecycle_event: "version",
      },
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
    const beforeManifest = await readFile(join(repository, "manifest.json"));
    const beforeVersions = await readFile(join(repository, "versions.json"));

    await expect(
      bumpVersion({
        repository,
        environment: {
          npm_package_version: "0.2.0",
          npm_lifecycle_event: "version",
        },
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
});
