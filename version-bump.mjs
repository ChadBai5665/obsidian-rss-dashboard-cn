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

function assertVersionFilesClean(repository) {
  const status = execFileSync(
    "git",
    [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=no",
      "--",
      "manifest.json",
      "versions.json",
    ],
    {
      cwd: repository,
      encoding: "buffer",
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (status.length !== 0) {
    throw new Error("version-metadata-dirty");
  }
}

export async function bumpVersion({
  repository = process.cwd(),
  environment = process.env,
  hooks = {},
} = {}) {
  const root = resolve(repository);
  const targetVersion = environment.npm_package_version;
  if (environment.npm_lifecycle_event !== "version") {
    throw new Error("npm-version-lifecycle-required");
  }
  if (!isStrictSemVer(targetVersion)) {
    throw new Error("target-version-invalid");
  }
  assertVersionFilesClean(root);

  const manifestPath = join(root, "manifest.json");
  const versionsPath = join(root, "versions.json");
  const [manifestSource, versionsSource] = await Promise.all([
    readMetadata(manifestPath, "manifest"),
    readMetadata(versionsPath, "versions"),
  ]);
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
  try {
    await writeFile(manifestTemp, serializeJson(nextManifest), {
      flag: "wx",
      mode: 0o600,
    });
    await writeFile(versionsTemp, serializeJson(nextVersions), {
      flag: "wx",
      mode: 0o600,
    });
    await writeFile(manifestBackup, manifestSource.bytes, {
      flag: "wx",
      mode: 0o600,
    });
    manifestBackupPresent = true;
    await writeFile(versionsBackup, versionsSource.bytes, {
      flag: "wx",
      mode: 0o600,
    });
    versionsBackupPresent = true;

    await rename(manifestTemp, manifestPath);
    manifestInstalled = true;
    await hooks.beforeVersionsInstall?.();
    await rename(versionsTemp, versionsPath);
    versionsInstalled = true;

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
      rm(manifestBackup),
      rm(versionsBackup),
    ]);
    if (cleanup[0].status === "fulfilled") manifestBackupPresent = false;
    if (cleanup[1].status === "fulfilled") versionsBackupPresent = false;
    return {
      version: targetVersion,
      minAppVersion: installedManifest.parsed.minAppVersion,
    };
  } catch (error) {
    if (versionsInstalled && versionsBackupPresent) {
      await rename(versionsBackup, versionsPath);
      versionsBackupPresent = false;
      versionsInstalled = false;
    }
    if (manifestInstalled && manifestBackupPresent) {
      await rename(manifestBackup, manifestPath);
      manifestBackupPresent = false;
      manifestInstalled = false;
    }
    throw error;
  } finally {
    await Promise.allSettled([
      rm(manifestTemp, { force: true }),
      rm(versionsTemp, { force: true }),
      manifestBackupPresent
        ? rm(manifestBackup, { force: true })
        : Promise.resolve(),
      versionsBackupPresent
        ? rm(versionsBackup, { force: true })
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
