import { createHash, randomBytes } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import * as defaultFileSystem from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const LOCAL_RELEASE_FILES = Object.freeze([
  "main.js",
  "manifest.json",
  "styles.css",
]);

function installerError(code, cause) {
  return new Error(code, cause === undefined ? undefined : { cause });
}

function isMissing(error) {
  return error && typeof error === "object" && error.code === "ENOENT";
}

async function lstatIfPresent(fileSystem, path) {
  try {
    return await fileSystem.lstat(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function requireDirectory(fileSystem, path, missingCode, symlinkCode) {
  const status = await lstatIfPresent(fileSystem, path);
  if (!status) throw installerError(missingCode);
  if (status.isSymbolicLink()) throw installerError(symlinkCode);
  if (!status.isDirectory()) throw installerError(missingCode);
}

async function requireRegularFile(
  fileSystem,
  path,
  missingCode,
  symlinkCode,
) {
  const status = await lstatIfPresent(fileSystem, path);
  if (!status) throw installerError(missingCode);
  if (status.isSymbolicLink()) throw installerError(symlinkCode);
  if (!status.isFile()) throw installerError(missingCode);
  return status;
}

async function validateOptionalTargetFile(fileSystem, path) {
  const status = await lstatIfPresent(fileSystem, path);
  if (!status) return undefined;
  if (status.isSymbolicLink()) {
    throw installerError("install-target-artifact-symlink-rejected");
  }
  if (!status.isFile()) {
    throw installerError("install-target-artifact-invalid");
  }
  return status;
}

async function readManifest(fileSystem, path, invalidCode) {
  let value;
  try {
    value = JSON.parse(await fileSystem.readFile(path, "utf8"));
  } catch (error) {
    throw installerError(invalidCode, error);
  }
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.id !== "string" ||
    value.id.trim() !== value.id ||
    value.id.length === 0
  ) {
    throw installerError(invalidCode);
  }
  return value;
}

function digest(parts) {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return `sha256:${hash.digest("hex")}`;
}

async function fingerprintPath(fileSystem, path) {
  const parts = [];

  async function visit(current, relative) {
    const status = await lstatIfPresent(fileSystem, current);
    if (!status) {
      parts.push(`A\0${relative}\0`);
      return;
    }
    if (status.isSymbolicLink()) {
      parts.push(`L\0${relative}\0${await fileSystem.readlink(current)}\0`);
      return;
    }
    if (status.isDirectory()) {
      parts.push(`D\0${relative}\0`);
      const names = await fileSystem.readdir(current);
      names.sort((left, right) => left.localeCompare(right, "en"));
      for (const name of names) {
        await visit(join(current, name), relative ? `${relative}/${name}` : name);
      }
      return;
    }
    if (status.isFile()) {
      parts.push(`F\0${relative}\0`);
      parts.push(await fileSystem.readFile(current));
      parts.push("\0");
      return;
    }
    parts.push(`O\0${relative}\0${status.mode}\0`);
  }

  await visit(path, "");
  return digest(parts);
}

async function fingerprintFile(fileSystem, path) {
  return digest([await fileSystem.readFile(path)]);
}

function backupTimestamp(now) {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw installerError("install-clock-invalid");
  }
  return value.toISOString().replaceAll("-", "").replaceAll(":", "");
}

async function createBackupDirectory(fileSystem, targetDir, now) {
  const parent = dirname(targetDir);
  const base = `${basename(targetDir)}.backup-${backupTimestamp(now)}`;
  for (let suffix = 0; suffix < 1000; suffix += 1) {
    const candidate = join(parent, suffix === 0 ? base : `${base}-${suffix}`);
    try {
      await fileSystem.mkdir(candidate, { mode: 0o700 });
      return candidate;
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "EEXIST") {
        throw error;
      }
    }
  }
  throw installerError("install-backup-name-exhausted");
}

function temporaryPath(targetDir, pluginId, purpose, index) {
  return join(
    targetDir,
    `.${pluginId}-${purpose}-${randomBytes(8).toString("hex")}-${index}.tmp`,
  );
}

async function removeTemporaryFiles(fileSystem, paths) {
  await Promise.all(
    paths.map((path) => fileSystem.rm(path, { force: true }).catch(() => undefined)),
  );
}

async function restoreProgramFiles({
  backupDir,
  fileSystem,
  pluginId,
  targetDir,
  targetStates,
}) {
  const restoreTemps = [];
  try {
    for (let index = 0; index < LOCAL_RELEASE_FILES.length; index += 1) {
      const name = LOCAL_RELEASE_FILES[index];
      const destination = join(targetDir, name);
      const state = targetStates.get(name);
      if (!state) {
        await fileSystem.rm(destination, { force: true });
        continue;
      }
      const temporary = temporaryPath(targetDir, pluginId, "restore", index);
      restoreTemps.push(temporary);
      await fileSystem.copyFile(
        join(backupDir, name),
        temporary,
        fileConstants.COPYFILE_EXCL,
      );
      await fileSystem.chmod(temporary, state.mode & 0o777);
      await fileSystem.rename(temporary, destination);
    }
  } finally {
    await removeTemporaryFiles(fileSystem, restoreTemps);
  }
}

export function parseInstallArguments(arguments_) {
  if (
    arguments_.length !== 2 ||
    arguments_[0] !== "--target" ||
    typeof arguments_[1] !== "string" ||
    arguments_[1].trim().length === 0
  ) {
    if (
      arguments_.length === 0 ||
      (arguments_.length === 1 && arguments_[0] === "--target")
    ) {
      throw installerError("install-target-required");
    }
    throw installerError("install-arguments-invalid");
  }
  return { targetDir: arguments_[1] };
}

export async function installLocalRelease({
  fileSystem = defaultFileSystem,
  now = () => new Date(),
  releaseDir,
  targetDir,
}) {
  if (typeof releaseDir !== "string" || releaseDir.trim().length === 0) {
    throw installerError("install-release-directory-required");
  }
  if (typeof targetDir !== "string" || targetDir.trim().length === 0) {
    throw installerError("install-target-required");
  }

  const requestedTarget = resolve(targetDir);
  const requestedRelease = resolve(releaseDir);
  await requireDirectory(
    fileSystem,
    requestedTarget,
    "install-target-missing",
    "install-target-symlink-rejected",
  );
  await requireDirectory(
    fileSystem,
    requestedRelease,
    "install-release-directory-missing",
    "install-release-directory-symlink-rejected",
  );

  const realTarget = await fileSystem.realpath(requestedTarget);
  const realRelease = await fileSystem.realpath(requestedRelease);
  const pluginsDir = dirname(realTarget);
  const obsidianDir = dirname(pluginsDir);
  if (basename(pluginsDir) !== "plugins" || basename(obsidianDir) !== ".obsidian") {
    throw installerError("install-target-location-invalid");
  }
  const vaultRoot = dirname(obsidianDir);
  if (vaultRoot === obsidianDir) {
    throw installerError("install-target-location-invalid");
  }

  for (const name of LOCAL_RELEASE_FILES) {
    await requireRegularFile(
      fileSystem,
      join(realRelease, name),
      "install-release-artifact-missing",
      "install-release-artifact-symlink-rejected",
    );
  }

  const targetStates = new Map();
  for (const name of [...LOCAL_RELEASE_FILES, "data.json"]) {
    const state = await validateOptionalTargetFile(fileSystem, join(realTarget, name));
    if (state) targetStates.set(name, state);
  }
  if (!targetStates.has("manifest.json")) {
    throw installerError("install-target-manifest-missing");
  }

  const releaseManifest = await readManifest(
    fileSystem,
    join(realRelease, "manifest.json"),
    "install-release-manifest-invalid",
  );
  const targetManifest = await readManifest(
    fileSystem,
    join(realTarget, "manifest.json"),
    "install-target-manifest-invalid",
  );
  if (releaseManifest.id !== targetManifest.id) {
    throw installerError("install-manifest-id-mismatch");
  }
  if (basename(realTarget) !== targetManifest.id) {
    throw installerError("install-target-id-mismatch");
  }

  const dataPath = join(realTarget, "data.json");
  const historyPath = join(vaultRoot, ".rss-dashboard-data");
  const integrityBefore = {
    dataJson: await fingerprintPath(fileSystem, dataPath),
    history: await fingerprintPath(fileSystem, historyPath),
  };

  const backupDir = await createBackupDirectory(fileSystem, realTarget, now);
  for (const name of [...LOCAL_RELEASE_FILES, "data.json"]) {
    if (!targetStates.has(name)) continue;
    const backupPath = join(backupDir, name);
    await fileSystem.copyFile(join(realTarget, name), backupPath);
    await fileSystem.chmod(backupPath, 0o400);
  }

  const temporaryFiles = [];
  const committed = [];
  try {
    for (let index = 0; index < LOCAL_RELEASE_FILES.length; index += 1) {
      const name = LOCAL_RELEASE_FILES[index];
      const temporary = temporaryPath(realTarget, targetManifest.id, "install", index);
      temporaryFiles.push(temporary);
      await fileSystem.copyFile(
        join(realRelease, name),
        temporary,
        fileConstants.COPYFILE_EXCL,
      );
    }

    for (let index = 0; index < LOCAL_RELEASE_FILES.length; index += 1) {
      const name = LOCAL_RELEASE_FILES[index];
      await fileSystem.rename(temporaryFiles[index], join(realTarget, name));
      committed.push(name);
    }

    for (const name of LOCAL_RELEASE_FILES) {
      const sourceHash = await fingerprintFile(fileSystem, join(realRelease, name));
      const installedHash = await fingerprintFile(fileSystem, join(realTarget, name));
      if (sourceHash !== installedHash) {
        throw installerError("install-program-verification-failed");
      }
    }

    const integrityAfter = {
      dataJson: await fingerprintPath(fileSystem, dataPath),
      history: await fingerprintPath(fileSystem, historyPath),
    };
    if (
      integrityBefore.dataJson !== integrityAfter.dataJson ||
      integrityBefore.history !== integrityAfter.history
    ) {
      throw installerError("install-preserved-data-verification-failed");
    }

    return {
      backupDir,
      installed: [...LOCAL_RELEASE_FILES],
      integrity: {
        dataJson: {
          before: integrityBefore.dataJson,
          after: integrityAfter.dataJson,
          unchanged: true,
        },
        history: {
          before: integrityBefore.history,
          after: integrityAfter.history,
          unchanged: true,
        },
      },
      targetDir: realTarget,
    };
  } catch (error) {
    await removeTemporaryFiles(fileSystem, temporaryFiles);
    if (committed.length === 0) {
      throw installerError("install-failed-before-program-change", error);
    }
    try {
      await restoreProgramFiles({
        backupDir,
        fileSystem,
        pluginId: targetManifest.id,
        targetDir: realTarget,
        targetStates,
      });
    } catch (restoreError) {
      throw installerError("install-failed-restore-incomplete", restoreError);
    }
    throw installerError("install-failed-program-files-restored", error);
  } finally {
    await removeTemporaryFiles(fileSystem, temporaryFiles);
  }
}

async function main() {
  try {
    const { targetDir } = parseInstallArguments(process.argv.slice(2));
    const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    const result = await installLocalRelease({
      releaseDir: join(repositoryRoot, "release"),
      targetDir,
    });
    console.log("install-local-success");
    console.log(`backup-directory: ${basename(result.backupDir)}`);
    console.log("preserved-data-verified");
  } catch (error) {
    const message =
      error instanceof Error && error.message.startsWith("install-")
        ? error.message
        : "install-operational-error";
    console.error(message);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
