/* eslint-disable obsidianmd/hardcoded-config-path -- This filesystem installer must validate the documented on-disk plugin location without an Obsidian Vault instance. */
import * as nodeFileSystem from "node:fs/promises";
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
  targetDir: string;
}

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
      '{"id":"rss-dashboard-cn","version":"0.0.9"}\n',
    ),
    nodeFileSystem.writeFile(join(targetDir, "styles.css"), "old-style\n"),
    nodeFileSystem.writeFile(join(targetDir, "data.json"), '{"saved":true}\n'),
    nodeFileSystem.writeFile(join(targetDir, "local-only.txt"), "keep-me\n"),
    nodeFileSystem.writeFile(join(releaseDir, "main.js"), "new-main\n"),
    nodeFileSystem.writeFile(
      join(releaseDir, "manifest.json"),
      '{"id":"rss-dashboard-cn","version":"0.1.0"}\n',
    ),
    nodeFileSystem.writeFile(join(releaseDir, "styles.css"), "new-style\n"),
    nodeFileSystem.writeFile(join(releaseDir, "do-not-copy.txt"), "private\n"),
    nodeFileSystem.writeFile(historyFile, '{"history":"keep"}\n'),
  ]);
  const realTargetDir = await nodeFileSystem.realpath(targetDir);
  return {
    backupParent: dirname(realTargetDir),
    historyFile: await nodeFileSystem.realpath(historyFile),
    releaseDir: await nodeFileSystem.realpath(releaseDir),
    targetDir: realTargetDir,
  };
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
    for (const file of [...releaseFiles, "data.json"] as const) {
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
      '{"id":"another-plugin","version":"0.1.0"}\n',
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

  it("restores all three program artifacts when a commit step fails", async () => {
    const fixture = await createFixture();
    let failed = false;
    const fileSystem = {
      ...nodeFileSystem,
      rename: async (source: string, destination: string) => {
        if (
          !failed &&
          basename(source).startsWith(".rss-dashboard-cn-install-") &&
          basename(destination) === "manifest.json"
        ) {
          failed = true;
          throw new Error("synthetic-rename-failure");
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
    ).rejects.toThrow("install-failed-program-files-restored");

    expect(await nodeFileSystem.readFile(join(fixture.targetDir, "main.js"), "utf8")).toBe(
      "old-main\n",
    );
    expect(
      await nodeFileSystem.readFile(join(fixture.targetDir, "manifest.json"), "utf8"),
    ).toContain('"version":"0.0.9"');
    expect(
      await nodeFileSystem.readFile(join(fixture.targetDir, "styles.css"), "utf8"),
    ).toBe("old-style\n");
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
  });
});
