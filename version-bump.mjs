import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isStrictSemVer } from "./scripts/check-version-consistency.mjs";

const VERSION_FILE_MAX_BYTES = 1024 * 1024;

async function readMetadata(path, name) {
  const before = await lstat(path);
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.size === 0 ||
    before.size > VERSION_FILE_MAX_BYTES
  ) {
    throw new Error(`${name}-unsafe`);
  }
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const after = await handle.stat();
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size
    ) {
      throw new Error(`${name}-raced`);
    }
    const bytes = await handle.readFile();
    const parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.getPrototypeOf(parsed) !== Object.prototype
    ) {
      throw new Error(`${name}-shape-invalid`);
    }
    return { bytes, parsed };
  } finally {
    await handle.close();
  }
}

function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseStatusPaths(output) {
  const records = output.toString("utf8").split("\0");
  const paths = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.length < 4 || record[2] !== " ") {
      throw new Error("git-status-output-invalid");
    }
    paths.push(record.slice(3));
    if (/[RC]/.test(record.slice(0, 2))) index += 1;
  }
  return paths;
}

function assertExpectedNpmVersionChanges(repository) {
  const status = execFileSync(
    "git",
    [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ],
    {
      cwd: repository,
      encoding: "buffer",
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  const paths = parseStatusPaths(status);
  if (
    paths.some(
      (path) => path !== "package.json" && path !== "package-lock.json",
    )
  ) {
    throw new Error("version-worktree-unexpected-change");
  }
  if (
    !paths.includes("package.json") ||
    !paths.includes("package-lock.json")
  ) {
    throw new Error("npm-version-files-not-dirty");
  }
  const ignoredSensitive = execFileSync(
    "git",
    [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "-z",
      "--",
      ":(glob)**/.env*",
      ":(glob)**/secrets.json",
    ],
    {
      cwd: repository,
      encoding: "buffer",
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (ignoredSensitive.length !== 0) {
    throw new Error("version-worktree-sensitive-untracked");
  }
}

export async function bumpVersion({
  repository = process.cwd(),
  environment = process.env,
  hooks = {},
  operations = {},
} = {}) {
  const root = resolve(repository);
  const targetVersion = environment.npm_package_version;
  if (
    environment.npm_lifecycle_event !== "version" ||
    environment.npm_command !== "version"
  ) {
    throw new Error("npm-version-lifecycle-required");
  }
  if (!isStrictSemVer(targetVersion)) {
    throw new Error("target-version-invalid");
  }
  const packagePath = join(root, "package.json");
  const packageLockPath = join(root, "package-lock.json");
  const manifestPath = join(root, "manifest.json");
  const versionsPath = join(root, "versions.json");
  const [packageSource, packageLockSource, manifestSource, versionsSource] =
    await Promise.all([
    readMetadata(packagePath, "package"),
    readMetadata(packageLockPath, "package-lock"),
    readMetadata(manifestPath, "manifest"),
    readMetadata(versionsPath, "versions"),
  ]);
  if (packageSource.parsed.version !== targetVersion) {
    throw new Error("package-version-target-mismatch");
  }
  if (
    packageLockSource.parsed.version !== targetVersion ||
    packageLockSource.parsed.packages?.[""]?.version !== targetVersion
  ) {
    throw new Error("package-lock-target-mismatch");
  }
  assertExpectedNpmVersionChanges(root);
  if (!isStrictSemVer(manifestSource.parsed.minAppVersion)) {
    throw new Error("manifest-min-app-version-invalid");
  }

  const existingKeys = Object.keys(versionsSource.parsed);
  if (
    Object.hasOwn(versionsSource.parsed, targetVersion) &&
    existingKeys.at(-1) !== targetVersion
  ) {
    throw new Error("historical-version-order-conflict");
  }
  const nextManifest = { ...manifestSource.parsed, version: targetVersion };
  const nextVersions = { ...versionsSource.parsed };
  nextVersions[targetVersion] = manifestSource.parsed.minAppVersion;

  const nonce = `${process.pid}-${randomUUID()}`;
  const manifestTemp = join(root, `.manifest-${nonce}.tmp`);
  const versionsTemp = join(root, `.versions-${nonce}.tmp`);
  const manifestBackup = join(root, `.manifest-${nonce}.backup`);
  const versionsBackup = join(root, `.versions-${nonce}.backup`);
  let manifestInstalled = false;
  let versionsInstalled = false;
  let manifestBackupPresent = false;
  let versionsBackupPresent = false;
  let preserveManifestBackup = false;
  let preserveVersionsBackup = false;
  const ops = { lstat, rename, rm, writeFile, ...operations };
  try {
    await ops.writeFile(manifestTemp, serializeJson(nextManifest), {
      flag: "wx",
      mode: 0o600,
    });
    await ops.writeFile(versionsTemp, serializeJson(nextVersions), {
      flag: "wx",
      mode: 0o600,
    });
    await ops.writeFile(manifestBackup, manifestSource.bytes, {
      flag: "wx",
      mode: 0o600,
    });
    manifestBackupPresent = true;
    await ops.writeFile(versionsBackup, versionsSource.bytes, {
      flag: "wx",
      mode: 0o600,
    });
    versionsBackupPresent = true;

    await ops.rename(manifestTemp, manifestPath);
    manifestInstalled = true;
    await hooks.beforeVersionsInstall?.();
    await ops.rename(versionsTemp, versionsPath);
    versionsInstalled = true;
    await hooks.afterVersionsInstall?.();

    const [installedManifest, installedVersions] = await Promise.all([
      readMetadata(manifestPath, "manifest"),
      readMetadata(versionsPath, "versions"),
    ]);
    if (
      installedManifest.parsed.version !== targetVersion ||
      installedVersions.parsed[targetVersion] !==
        installedManifest.parsed.minAppVersion ||
      Object.keys(installedVersions.parsed).at(-1) !== targetVersion
    ) {
      throw new Error("version-install-verification-failed");
    }
    const cleanup = await Promise.allSettled([
      ops.rm(manifestBackup),
      ops.rm(versionsBackup),
    ]);
    if (cleanup[0].status === "fulfilled") manifestBackupPresent = false;
    if (cleanup[1].status === "fulfilled") versionsBackupPresent = false;
    if (cleanup.some((result) => result.status === "rejected")) {
      preserveManifestBackup = manifestBackupPresent;
      preserveVersionsBackup = versionsBackupPresent;
      const paths = [
        manifestBackupPresent ? manifestBackup : undefined,
        versionsBackupPresent ? versionsBackup : undefined,
      ].filter(Boolean);
      throw new Error(`version-recovery-required:${paths.join(",")}`);
    }
    return {
      version: targetVersion,
      minAppVersion: installedManifest.parsed.minAppVersion,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("version-recovery-required:")
    ) {
      throw error;
    }
    const recoveryPaths = [];
    if (versionsInstalled && versionsBackupPresent) {
      try {
        await ops.rename(versionsBackup, versionsPath);
        versionsBackupPresent = false;
        versionsInstalled = false;
      } catch {
        preserveVersionsBackup = true;
        recoveryPaths.push(versionsBackup);
      }
    }
    if (manifestInstalled && manifestBackupPresent) {
      try {
        await ops.rename(manifestBackup, manifestPath);
        manifestBackupPresent = false;
        manifestInstalled = false;
      } catch {
        preserveManifestBackup = true;
        recoveryPaths.push(manifestBackup);
      }
    }
    if (recoveryPaths.length > 0) {
      throw new Error(`version-recovery-required:${recoveryPaths.join(",")}`);
    }
    throw error;
  } finally {
    await Promise.allSettled([
      ops.rm(manifestTemp, { force: true }),
      ops.rm(versionsTemp, { force: true }),
      manifestBackupPresent && !preserveManifestBackup
        ? ops.rm(manifestBackup, { force: true })
        : Promise.resolve(),
      versionsBackupPresent && !preserveVersionsBackup
        ? ops.rm(versionsBackup, { force: true })
        : Promise.resolve(),
    ]);
  }
}

async function main() {
  try {
    const result = await bumpVersion();
    console.log(`version-bumped:${result.version}`);
  } catch (error) {
    console.error(error?.message ?? "version-bump-failed");
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
