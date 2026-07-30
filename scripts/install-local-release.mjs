import { createHash, randomBytes } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import * as defaultFileSystem from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { checkReleaseArtifacts } from "./check-release-artifacts.mjs";
import { isStrictSemVer } from "./check-version-consistency.mjs";

export const LOCAL_RELEASE_FILES = Object.freeze([
  "main.js",
  "manifest.json",
  "styles.css",
]);

const COPY_BUFFER_BYTES = 64 * 1024;
const JSON_MAX_BYTES = 1024 * 1024;
const REQUIRED_MANIFEST_STRINGS = Object.freeze([
  "id",
  "name",
  "author",
  "version",
  "minAppVersion",
  "description",
]);

function installerError(code, cause) {
  return new Error(code, cause === undefined ? undefined : { cause });
}

function isMissing(error) {
  return error && typeof error === "object" && error.code === "ENOENT";
}

function isExists(error) {
  return error && typeof error === "object" && error.code === "EEXIST";
}

async function lstatIfPresent(fileSystem, path) {
  try {
    return await fileSystem.lstat(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function directoryIdentityMatches(left, right) {
  return (
    left.isDirectory() &&
    right.isDirectory() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode
  );
}

function fileIdentityMatches(left, right) {
  return (
    left.isFile() &&
    right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function requireDirectory(fileSystem, path, missingCode, symlinkCode) {
  const status = await lstatIfPresent(fileSystem, path);
  if (!status) throw installerError(missingCode);
  if (status.isSymbolicLink()) throw installerError(symlinkCode);
  if (!status.isDirectory()) throw installerError(missingCode);
  return status;
}

async function assertDirectoryIdentity(fileSystem, path, pin, code) {
  const current = await lstatIfPresent(fileSystem, path);
  if (!current || !directoryIdentityMatches(current, pin)) {
    throw installerError(code);
  }
}

async function pinRegularFile(
  fileSystem,
  path,
  { hardlinkCode, missingCode, symlinkCode },
) {
  const status = await lstatIfPresent(fileSystem, path);
  if (!status) throw installerError(missingCode);
  if (status.isSymbolicLink()) throw installerError(symlinkCode);
  if (!status.isFile()) throw installerError(missingCode);
  if (status.nlink > 1) throw installerError(hardlinkCode);
  return status;
}

async function assertPinnedRegular(fileSystem, path, pin, code) {
  const current = await lstatIfPresent(fileSystem, path);
  if (
    !current ||
    current.isSymbolicLink() ||
    current.nlink > 1 ||
    !fileIdentityMatches(current, pin)
  ) {
    throw installerError(code);
  }
}

async function openPinnedReadHandle(fileSystem, path, pin, code) {
  await assertPinnedRegular(fileSystem, path, pin, code);
  let handle;
  try {
    handle = await fileSystem.open(
      path,
      fileConstants.O_RDONLY | (fileConstants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    throw installerError(code, error);
  }
  try {
    const opened = await handle.stat();
    if (!fileIdentityMatches(opened, pin) || opened.nlink > 1) {
      throw installerError(code);
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function readPinnedChunks({ handle, pin, onChunk, raceCode }) {
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  let total = 0;
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    await onChunk(buffer.subarray(0, bytesRead));
  }
  const after = await handle.stat();
  if (!fileIdentityMatches(after, pin) || after.nlink > 1) {
    throw installerError(raceCode);
  }
  return total;
}

async function hashPinnedFile(fileSystem, path, pin, raceCode) {
  const handle = await openPinnedReadHandle(fileSystem, path, pin, raceCode);
  const hash = createHash("sha256");
  try {
    await readPinnedChunks({
      handle,
      pin,
      onChunk: (chunk) => hash.update(chunk),
      raceCode,
    });
  } finally {
    await handle.close();
  }
  return `sha256:${hash.digest("hex")}`;
}

async function readPinnedFile(fileSystem, path, pin, raceCode, maxBytes) {
  if (pin.size === 0 || pin.size > maxBytes) throw installerError(raceCode);
  const handle = await openPinnedReadHandle(fileSystem, path, pin, raceCode);
  const chunks = [];
  let total = 0;
  try {
    await readPinnedChunks({
      handle,
      pin,
      onChunk: (chunk) => {
        total += chunk.length;
        if (total > maxBytes) throw installerError(raceCode);
        chunks.push(Buffer.from(chunk));
      },
      raceCode,
    });
  } finally {
    await handle.close();
  }
  return Buffer.concat(chunks, total);
}

function parsePlainJson(bytes, invalidCode) {
  let value;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch (error) {
    throw installerError(invalidCode, error);
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw installerError(invalidCode);
  }
  return value;
}

async function readManifest(fileSystem, path, pin, invalidCode, raceCode) {
  const value = parsePlainJson(
    await readPinnedFile(fileSystem, path, pin, raceCode, JSON_MAX_BYTES),
    invalidCode,
  );
  if (
    REQUIRED_MANIFEST_STRINGS.some(
      (field) =>
        typeof value[field] !== "string" ||
        value[field].length === 0 ||
        value[field].trim() !== value[field],
    ) ||
    !/^[a-z0-9][a-z0-9-]*$/.test(value.id) ||
    !isStrictSemVer(value.version) ||
    !isStrictSemVer(value.minAppVersion)
  ) {
    throw installerError(invalidCode);
  }
  return value;
}

async function readPackage(fileSystem, path, pin) {
  const value = parsePlainJson(
    await readPinnedFile(
      fileSystem,
      path,
      pin,
      "install-release-root-package-raced",
      JSON_MAX_BYTES,
    ),
    "install-release-root-package-invalid",
  );
  if (typeof value.version !== "string" || !isStrictSemVer(value.version)) {
    throw installerError("install-release-root-package-invalid");
  }
  return value;
}

async function writeAll(handle, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(
      bytes,
      offset,
      bytes.length - offset,
      null,
    );
    if (bytesWritten <= 0) throw installerError("install-write-stalled");
    offset += bytesWritten;
  }
}

async function copyPinnedFile({
  destination,
  expectedHash,
  fileSystem,
  mode,
  raceCode,
  source,
  sourcePin,
}) {
  const sourceHandle = await openPinnedReadHandle(
    fileSystem,
    source,
    sourcePin,
    raceCode,
  );
  let destinationHandle;
  const hash = createHash("sha256");
  try {
    destinationHandle = await fileSystem.open(
      destination,
      fileConstants.O_WRONLY |
        fileConstants.O_CREAT |
        fileConstants.O_EXCL |
        (fileConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await readPinnedChunks({
      handle: sourceHandle,
      pin: sourcePin,
      onChunk: async (chunk) => {
        hash.update(chunk);
        await writeAll(destinationHandle, chunk);
      },
      raceCode,
    });
    const copiedHash = `sha256:${hash.digest("hex")}`;
    if (expectedHash !== undefined && copiedHash !== expectedHash) {
      throw installerError(raceCode);
    }
    await destinationHandle.chmod(mode);
    await destinationHandle.sync();
    const destinationState = await destinationHandle.stat();
    if (!destinationState.isFile() || destinationState.nlink > 1) {
      throw installerError("install-copy-destination-invalid");
    }
  } catch (error) {
    await destinationHandle?.close().catch(() => undefined);
    destinationHandle = undefined;
    await fileSystem.rm(destination, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await sourceHandle.close();
    await destinationHandle?.close();
  }
  return pinRegularFile(fileSystem, destination, {
    hardlinkCode: "install-copy-destination-invalid",
    missingCode: "install-copy-destination-invalid",
    symlinkCode: "install-copy-destination-invalid",
  });
}

async function fsyncDirectory(fileSystem, path) {
  let handle;
  try {
    handle = await fileSystem.open(
      path,
      fileConstants.O_RDONLY |
        (fileConstants.O_DIRECTORY ?? 0) |
        (fileConstants.O_NOFOLLOW ?? 0),
    );
    await handle.sync();
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EISDIR"].includes(error?.code)) throw error;
  } finally {
    await handle?.close();
  }
}

async function fingerprintPath(fileSystem, path) {
  const hash = createHash("sha256");
  const update = (value) => hash.update(value);

  async function visit(current, relative) {
    const status = await lstatIfPresent(fileSystem, current);
    if (!status) {
      update(`A\0${relative}\0`);
      return;
    }
    if (status.isSymbolicLink()) {
      const target = await fileSystem.readlink(current);
      const after = await lstatIfPresent(fileSystem, current);
      if (
        !after ||
        !after.isSymbolicLink() ||
        after.dev !== status.dev ||
        after.ino !== status.ino ||
        after.mtimeMs !== status.mtimeMs ||
        after.ctimeMs !== status.ctimeMs
      ) {
        throw installerError("install-preserved-data-raced");
      }
      update(`L\0${relative}\0${target}\0`);
      return;
    }
    if (status.isDirectory()) {
      update(`D\0${relative}\0`);
      const names = await fileSystem.readdir(current);
      names.sort((left, right) => left.localeCompare(right, "en"));
      for (const name of names) {
        await visit(join(current, name), relative ? `${relative}/${name}` : name);
      }
      const after = await lstatIfPresent(fileSystem, current);
      if (
        !after ||
        !directoryIdentityMatches(after, status) ||
        after.mtimeMs !== status.mtimeMs ||
        after.ctimeMs !== status.ctimeMs
      ) {
        throw installerError("install-preserved-data-raced");
      }
      return;
    }
    if (status.isFile()) {
      if (status.nlink > 1) {
        throw installerError("install-target-artifact-hardlink-rejected");
      }
      update(`F\0${relative}\0`);
      const handle = await openPinnedReadHandle(
        fileSystem,
        current,
        status,
        "install-preserved-data-raced",
      );
      try {
        await readPinnedChunks({
          handle,
          pin: status,
          onChunk: (chunk) => update(chunk),
          raceCode: "install-preserved-data-raced",
        });
      } finally {
        await handle.close();
      }
      update("\0");
      return;
    }
    update(`O\0${relative}\0${status.mode}\0`);
  }

  await visit(path, "");
  return `sha256:${hash.digest("hex")}`;
}

async function fingerprintPreservedState({
  dataPath,
  fileSystem,
  historyPath,
  targetDir,
  targetDirectoryPin,
}) {
  await assertDirectoryIdentity(
    fileSystem,
    targetDir,
    targetDirectoryPin,
    "install-target-directory-identity-changed",
  );
  const integrity = {
    dataJson: await fingerprintPath(fileSystem, dataPath),
    history: await fingerprintPath(fileSystem, historyPath),
  };
  await assertDirectoryIdentity(
    fileSystem,
    targetDir,
    targetDirectoryPin,
    "install-target-directory-identity-changed",
  );
  return integrity;
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
      if (!isExists(error)) throw error;
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

function backupName(name) {
  return name === "manifest.json" ? "manifest.json.restore" : name;
}

async function removeTemporaryFiles(fileSystem, paths) {
  await Promise.all(
    paths.map((path) => fileSystem.rm(path, { force: true }).catch(() => undefined)),
  );
}

async function removeIncompleteBackup(fileSystem, backupDir, copiedPaths) {
  await removeTemporaryFiles(fileSystem, copiedPaths);
  await fileSystem.rmdir(backupDir).catch(() => undefined);
}

async function restoreProgramFiles({
  backupDir,
  backupPins,
  backupHashes,
  fileSystem,
  pluginId,
  targetDir,
  targetDirectoryPin,
  targetHashes,
  targetModes,
}) {
  const restoreTemps = [];
  try {
    for (let index = 0; index < LOCAL_RELEASE_FILES.length; index += 1) {
      const name = LOCAL_RELEASE_FILES[index];
      await assertDirectoryIdentity(
        fileSystem,
        targetDir,
        targetDirectoryPin,
        "install-target-directory-identity-changed",
      );
      const temporary = temporaryPath(targetDir, pluginId, "restore", index);
      restoreTemps.push(temporary);
      await copyPinnedFile({
        destination: temporary,
        expectedHash: backupHashes.get(name),
        fileSystem,
        mode: targetModes.get(name),
        raceCode: "install-backup-artifact-identity-changed",
        source: join(backupDir, backupName(name)),
        sourcePin: backupPins.get(name),
      });
      await fileSystem.rename(temporary, join(targetDir, name));
      await fsyncDirectory(fileSystem, targetDir);
      const restoredPin = await pinRegularFile(fileSystem, join(targetDir, name), {
        hardlinkCode: "install-target-artifact-hardlink-rejected",
        missingCode: "install-restore-verification-failed",
        symlinkCode: "install-restore-verification-failed",
      });
      const restoredHash = await hashPinnedFile(
        fileSystem,
        join(targetDir, name),
        restoredPin,
        "install-restore-verification-failed",
      );
      if (restoredHash !== targetHashes.get(name)) {
        throw installerError("install-restore-verification-failed");
      }
    }
  } finally {
    await removeTemporaryFiles(fileSystem, restoreTemps);
  }
}

async function acquireInstallLock(fileSystem, pluginsDir, pluginId) {
  const path = join(pluginsDir, `.${pluginId}.install.lock`);
  let handle;
  try {
    handle = await fileSystem.open(
      path,
      fileConstants.O_WRONLY |
        fileConstants.O_CREAT |
        fileConstants.O_EXCL |
        (fileConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
  } catch (error) {
    if (isExists(error)) throw installerError("install-already-running");
    throw installerError("install-lock-create-failed", error);
  }
  try {
    await handle.writeFile(`${process.pid}\n`);
    await handle.sync();
    const pin = await handle.stat();
    if (!pin.isFile() || pin.nlink > 1) throw installerError("install-lock-invalid");
    return { handle, path, pin };
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fileSystem.rm(path, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function releaseInstallLock(fileSystem, pluginsDir, pluginsPin, lock) {
  await lock.handle.close();
  await assertDirectoryIdentity(
    fileSystem,
    pluginsDir,
    pluginsPin,
    "install-plugins-directory-identity-changed",
  );
  await assertPinnedRegular(fileSystem, lock.path, lock.pin, "install-lock-identity-changed");
  await fileSystem.rm(lock.path);
  await fsyncDirectory(fileSystem, pluginsDir);
}

async function validateReleaseSet({ fileSystem, realRelease, releaseManifest, releasePins }) {
  const repositoryRoot = dirname(realRelease);
  if (basename(realRelease) !== "release") {
    throw installerError("install-release-directory-location-invalid");
  }
  const rootPins = new Map();
  for (const name of LOCAL_RELEASE_FILES) {
    rootPins.set(
      name,
      await pinRegularFile(fileSystem, join(repositoryRoot, name), {
        hardlinkCode: "install-release-artifact-hardlink-rejected",
        missingCode: "install-release-root-artifact-missing",
        symlinkCode: "install-release-root-artifact-symlink-rejected",
      }),
    );
  }
  const packagePin = await pinRegularFile(fileSystem, join(repositoryRoot, "package.json"), {
    hardlinkCode: "install-release-artifact-hardlink-rejected",
    missingCode: "install-release-root-package-missing",
    symlinkCode: "install-release-root-package-symlink-rejected",
  });
  const rootManifest = await readManifest(
    fileSystem,
    join(repositoryRoot, "manifest.json"),
    rootPins.get("manifest.json"),
    "install-release-root-manifest-invalid",
    "install-release-root-artifact-raced",
  );
  const packageJson = await readPackage(fileSystem, join(repositoryRoot, "package.json"), packagePin);
  if (
    rootManifest.id !== releaseManifest.id ||
    rootManifest.version !== releaseManifest.version ||
    packageJson.version !== releaseManifest.version
  ) {
    throw installerError("install-release-artifacts-invalid");
  }
  const releaseCheck = await checkReleaseArtifacts({ root: repositoryRoot });
  if (!releaseCheck.ok) throw installerError("install-release-artifacts-invalid");

  const releaseHashes = new Map();
  for (const name of LOCAL_RELEASE_FILES) {
    const releaseHash = await hashPinnedFile(
      fileSystem,
      join(realRelease, name),
      releasePins.get(name),
      "install-release-artifact-identity-changed",
    );
    const rootHash = await hashPinnedFile(
      fileSystem,
      join(repositoryRoot, name),
      rootPins.get(name),
      "install-release-root-artifact-raced",
    );
    if (releaseHash !== rootHash) throw installerError("install-release-artifacts-invalid");
    releaseHashes.set(name, releaseHash);
  }
  return releaseHashes;
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
  hooks = {},
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
  const targetDirectoryPin = await requireDirectory(
    fileSystem,
    realTarget,
    "install-target-missing",
    "install-target-symlink-rejected",
  );
  const releaseDirectoryPin = await requireDirectory(
    fileSystem,
    realRelease,
    "install-release-directory-missing",
    "install-release-directory-symlink-rejected",
  );
  const pluginsDir = dirname(realTarget);
  const obsidianDir = dirname(pluginsDir);
  if (basename(pluginsDir) !== "plugins" || basename(obsidianDir) !== ".obsidian") {
    throw installerError("install-target-location-invalid");
  }
  const vaultRoot = dirname(obsidianDir);
  if (vaultRoot === obsidianDir) throw installerError("install-target-location-invalid");
  const pluginsPin = await requireDirectory(
    fileSystem,
    pluginsDir,
    "install-target-location-invalid",
    "install-target-location-invalid",
  );

  const releasePins = new Map();
  for (const name of LOCAL_RELEASE_FILES) {
    releasePins.set(
      name,
      await pinRegularFile(fileSystem, join(realRelease, name), {
        hardlinkCode: "install-release-artifact-hardlink-rejected",
        missingCode: "install-release-artifact-missing",
        symlinkCode: "install-release-artifact-symlink-rejected",
      }),
    );
  }

  const targetPins = new Map();
  const targetManifestPath = join(realTarget, "manifest.json");
  const targetManifestStatus = await lstatIfPresent(fileSystem, targetManifestPath);
  if (!targetManifestStatus) throw installerError("install-target-manifest-missing");
  for (const name of LOCAL_RELEASE_FILES) {
    targetPins.set(
      name,
      await pinRegularFile(fileSystem, join(realTarget, name), {
        hardlinkCode: "install-target-artifact-hardlink-rejected",
        missingCode: "install-target-artifact-missing",
        symlinkCode: "install-target-artifact-symlink-rejected",
      }),
    );
  }
  const dataPath = join(realTarget, "data.json");
  const dataStatus = await lstatIfPresent(fileSystem, dataPath);
  if (dataStatus) {
    targetPins.set(
      "data.json",
      await pinRegularFile(fileSystem, dataPath, {
        hardlinkCode: "install-target-artifact-hardlink-rejected",
        missingCode: "install-target-artifact-invalid",
        symlinkCode: "install-target-artifact-symlink-rejected",
      }),
    );
  }

  const releaseManifest = await readManifest(
    fileSystem,
    join(realRelease, "manifest.json"),
    releasePins.get("manifest.json"),
    "install-release-manifest-invalid",
    "install-release-artifact-identity-changed",
  );
  const targetManifest = await readManifest(
    fileSystem,
    targetManifestPath,
    targetPins.get("manifest.json"),
    "install-target-manifest-invalid",
    "install-target-artifact-identity-changed",
  );
  if (releaseManifest.id !== targetManifest.id) {
    throw installerError("install-manifest-id-mismatch");
  }
  if (basename(realTarget) !== targetManifest.id) {
    throw installerError("install-target-id-mismatch");
  }

  const releaseHashes = await validateReleaseSet({
    fileSystem,
    realRelease,
    releaseManifest,
    releasePins,
  });
  await assertDirectoryIdentity(
    fileSystem,
    realRelease,
    releaseDirectoryPin,
    "install-release-directory-identity-changed",
  );

  const targetHashes = new Map();
  for (const [name, pin] of targetPins) {
    targetHashes.set(
      name,
      await hashPinnedFile(
        fileSystem,
        join(realTarget, name),
        pin,
        "install-target-artifact-identity-changed",
      ),
    );
  }

  const lock = await acquireInstallLock(fileSystem, pluginsDir, targetManifest.id);
  let primaryError;
  try {
    await hooks.afterLock?.();
    await assertDirectoryIdentity(
      fileSystem,
      realTarget,
      targetDirectoryPin,
      "install-target-directory-identity-changed",
    );
    const historyPath = join(vaultRoot, ".rss-dashboard-data");
    const integrityBefore = await fingerprintPreservedState({
      dataPath,
      fileSystem,
      historyPath,
      targetDir: realTarget,
      targetDirectoryPin,
    });

    const backupDir = await createBackupDirectory(fileSystem, realTarget, now);
    const backupPin = await requireDirectory(
      fileSystem,
      backupDir,
      "install-backup-create-failed",
      "install-backup-create-failed",
    );
    await fsyncDirectory(fileSystem, pluginsDir);
    const backupPins = new Map();
    const backupHashes = new Map();
    const copiedBackupPaths = [];
    try {
      for (const name of [...LOCAL_RELEASE_FILES, "data.json"]) {
        const sourcePin = targetPins.get(name);
        if (!sourcePin) continue;
        await hooks.beforeBackupCopy?.(name);
        const destination = join(backupDir, backupName(name));
        const copiedPin = await copyPinnedFile({
          destination,
          expectedHash: targetHashes.get(name),
          fileSystem,
          mode: 0o400,
          raceCode: "install-target-artifact-identity-changed",
          source: join(realTarget, name),
          sourcePin,
        });
        copiedBackupPaths.push(destination);
        backupPins.set(name, copiedPin);
        backupHashes.set(name, targetHashes.get(name));
      }
      await fsyncDirectory(fileSystem, backupDir);
      await assertDirectoryIdentity(
        fileSystem,
        backupDir,
        backupPin,
        "install-backup-directory-identity-changed",
      );
    } catch (error) {
      await removeIncompleteBackup(fileSystem, backupDir, copiedBackupPaths);
      throw installerError("install-backup-failed", error);
    }

    const temporaryFiles = [];
    const temporaryPins = new Map();
    try {
      for (let index = 0; index < LOCAL_RELEASE_FILES.length; index += 1) {
        const name = LOCAL_RELEASE_FILES[index];
        await hooks.beforeProgramCopy?.(name);
        await assertDirectoryIdentity(
          fileSystem,
          realRelease,
          releaseDirectoryPin,
          "install-release-directory-identity-changed",
        );
        await assertDirectoryIdentity(
          fileSystem,
          realTarget,
          targetDirectoryPin,
          "install-target-directory-identity-changed",
        );
        const temporary = temporaryPath(realTarget, targetManifest.id, "install", index);
        temporaryFiles.push(temporary);
        temporaryPins.set(
          name,
          await copyPinnedFile({
            destination: temporary,
            expectedHash: releaseHashes.get(name),
            fileSystem,
            mode: 0o600,
            raceCode: "install-release-artifact-identity-changed",
            source: join(realRelease, name),
            sourcePin: releasePins.get(name),
          }),
        );
        await assertDirectoryIdentity(
          fileSystem,
          realRelease,
          releaseDirectoryPin,
          "install-release-directory-identity-changed",
        );
        await assertDirectoryIdentity(
          fileSystem,
          realTarget,
          targetDirectoryPin,
          "install-target-directory-identity-changed",
        );
      }
      await fsyncDirectory(fileSystem, realTarget);

      const committed = [];
      try {
        for (let index = 0; index < LOCAL_RELEASE_FILES.length; index += 1) {
          const name = LOCAL_RELEASE_FILES[index];
          await hooks.beforeProgramCommit?.(name);
          await assertDirectoryIdentity(
            fileSystem,
            realTarget,
            targetDirectoryPin,
            "install-target-directory-identity-changed",
          );
          await assertDirectoryIdentity(
            fileSystem,
            pluginsDir,
            pluginsPin,
            "install-plugins-directory-identity-changed",
          );
          await assertPinnedRegular(
            fileSystem,
            join(realTarget, name),
            targetPins.get(name),
            "install-target-artifact-identity-changed",
          );
          const currentTargetHash = await hashPinnedFile(
            fileSystem,
            join(realTarget, name),
            targetPins.get(name),
            "install-target-artifact-identity-changed",
          );
          if (currentTargetHash !== targetHashes.get(name)) {
            throw installerError("install-target-artifact-identity-changed");
          }
          await assertPinnedRegular(
            fileSystem,
            temporaryFiles[index],
            temporaryPins.get(name),
            "install-temporary-artifact-identity-changed",
          );
          await fileSystem.rename(temporaryFiles[index], join(realTarget, name));
          committed.push(name);
          await assertDirectoryIdentity(
            fileSystem,
            realTarget,
            targetDirectoryPin,
            "install-target-directory-identity-changed",
          );
          await fsyncDirectory(fileSystem, realTarget);
        }

        await hooks.afterProgramCommit?.();
        for (const name of LOCAL_RELEASE_FILES) {
          const installedPin = await pinRegularFile(fileSystem, join(realTarget, name), {
            hardlinkCode: "install-target-artifact-hardlink-rejected",
            missingCode: "install-program-verification-failed",
            symlinkCode: "install-program-verification-failed",
          });
          const installedHash = await hashPinnedFile(
            fileSystem,
            join(realTarget, name),
            installedPin,
            "install-program-verification-failed",
          );
          if (releaseHashes.get(name) !== installedHash) {
            throw installerError("install-program-verification-failed");
          }
        }
        await hooks.afterProgramVerification?.();

        const integrityAfter = await fingerprintPreservedState({
          dataPath,
          fileSystem,
          historyPath,
          targetDir: realTarget,
          targetDirectoryPin,
        });
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
        if (committed.length === 0) {
          if (
            error instanceof Error &&
            (error.message.includes("identity-changed") ||
              error.message.includes("hardlink-rejected"))
          ) {
            throw error;
          }
          throw installerError("install-failed-before-program-change", error);
        }
        try {
          await restoreProgramFiles({
            backupDir,
            backupHashes,
            backupPins,
            fileSystem,
            pluginId: targetManifest.id,
            targetDir: realTarget,
            targetDirectoryPin,
            targetHashes,
            targetModes: new Map(
              LOCAL_RELEASE_FILES.map((name) => [name, targetPins.get(name).mode & 0o777]),
            ),
          });
        } catch (restoreError) {
          throw installerError("install-failed-restore-incomplete", restoreError);
        }
        throw installerError("install-failed-program-files-restored", error);
      }
    } finally {
      await removeTemporaryFiles(fileSystem, temporaryFiles);
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await releaseInstallLock(fileSystem, pluginsDir, pluginsPin, lock);
    } catch (lockError) {
      if (primaryError === undefined) {
        throw installerError("install-lock-cleanup-failed", lockError);
      }
    }
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
