import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sensitiveRuleIdsForText } from "./release-safety-rules.mjs";

export const RELEASE_BUNDLE_MAX_BYTES = 16 * 1024 * 1024;
const RELEASE_FILE_MAX_BYTES = 20 * 1024 * 1024;
const ALLOWED_RELEASE_FILES = Object.freeze([
  "main.js",
  "manifest.json",
  "styles.css",
]);

async function lstatIfPresent(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function readRegularFileNoFollow(
  path,
  displayName,
  {
    maxBytes = RELEASE_FILE_MAX_BYTES,
    prefix = "source",
    requireNonEmpty = true,
  } = {},
) {
  const before = await lstatIfPresent(path);
  if (!before) throw new Error(`${prefix}-missing:${displayName}`);
  if (before.isSymbolicLink()) {
    throw new Error(`${prefix}-symlink:${displayName}`);
  }
  if (!before.isFile()) {
    throw new Error(`${prefix}-not-file:${displayName}`);
  }
  if (requireNonEmpty && before.size === 0) {
    throw new Error(`${prefix}-empty-file:${displayName}`);
  }
  if (before.size > maxBytes) {
    throw new Error(
      displayName === "main.js"
        ? "bundle-size-limit"
        : `${prefix}-size-limit:${displayName}`,
    );
  }
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const after = await handle.stat();
    if (
      !after.isFile() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size
    ) {
      throw new Error(`${prefix}-file-raced:${displayName}`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export function inspectBundle(bytes) {
  if (bytes.length > RELEASE_BUNDLE_MAX_BYTES) {
    throw new Error("bundle-size-limit");
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("bundle-not-utf8");
  }
  const sensitiveRules = sensitiveRuleIdsForText(text);
  if (sensitiveRules.includes("home-path")) {
    throw new Error("bundle-private-path");
  }
  if (
    sensitiveRules.some((rule) =>
      ["credential-value", "credential-url", "private-key-material"].includes(
        rule,
      ),
    )
  ) {
    throw new Error("bundle-credential");
  }
  if (
    /\/\/[#@]\s*sourceMappingURL\s*=|\/\*[#@]\s*sourceMappingURL\s*=|"sources"\s*:\s*\[/i.test(
      text,
    )
  ) {
    throw new Error("bundle-source-map");
  }
}

async function expectedReleaseFiles(root) {
  const stylesStats = await lstatIfPresent(join(root, "styles.css"));
  if (!stylesStats) return ["main.js", "manifest.json"];
  if (stylesStats.isSymbolicLink()) {
    throw new Error("source-symlink:styles.css");
  }
  if (!stylesStats.isFile()) {
    throw new Error("source-not-file:styles.css");
  }
  return [...ALLOWED_RELEASE_FILES];
}

async function inspectReleaseDirectory({ root, directory }) {
  const errors = [];
  const releaseStats = await lstatIfPresent(directory);
  if (!releaseStats) {
    return { ok: false, errors: ["release-directory-missing"] };
  }
  if (releaseStats.isSymbolicLink()) {
    return { ok: false, errors: ["release-directory-symlink"] };
  }
  if (!releaseStats.isDirectory()) {
    return { ok: false, errors: ["release-directory-not-directory"] };
  }

  let expected;
  try {
    expected = await expectedReleaseFiles(root);
  } catch (error) {
    return { ok: false, errors: [error.message] };
  }
  const entries = await readdir(directory, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  for (const name of names) {
    if (!expected.includes(name)) {
      errors.push(`release-extra-file:${name}`);
    }
  }
  for (const name of expected) {
    if (!names.includes(name)) {
      errors.push(`release-missing-file:${name}`);
    }
  }

  const releaseBytes = new Map();
  for (const name of expected) {
    if (!names.includes(name)) continue;
    const entry = entries.find((candidate) => candidate.name === name);
    if (entry?.isSymbolicLink()) {
      errors.push(`release-symlink:${name}`);
      continue;
    }
    if (!entry?.isFile()) {
      errors.push(`release-not-file:${name}`);
      continue;
    }
    try {
      const bytes = await readRegularFileNoFollow(join(directory, name), name, {
        prefix: "release",
        maxBytes:
          name === "main.js" ? RELEASE_BUNDLE_MAX_BYTES : RELEASE_FILE_MAX_BYTES,
      });
      releaseBytes.set(name, bytes);
    } catch (error) {
      errors.push(error.message);
    }
  }

  const mainBytes = releaseBytes.get("main.js");
  if (mainBytes) {
    try {
      inspectBundle(mainBytes);
    } catch (error) {
      errors.push(error.message);
    }
  }

  for (const name of ["manifest.json", "styles.css"]) {
    const candidate = releaseBytes.get(name);
    if (!candidate) continue;
    try {
      const source = await readRegularFileNoFollow(join(root, name), name, {
        prefix: "source",
      });
      if (!candidate.equals(source)) {
        errors.push(
          name === "manifest.json"
            ? "release-manifest-mismatch:manifest.json"
            : "release-styles-mismatch:styles.css",
        );
      }
    } catch (error) {
      errors.push(error.message);
    }
  }

  errors.sort();
  return { ok: errors.length === 0, errors };
}

export async function checkReleaseArtifacts({ root = process.cwd() } = {}) {
  const resolvedRoot = resolve(root);
  return inspectReleaseDirectory({
    root: resolvedRoot,
    directory: join(resolvedRoot, "release"),
  });
}

async function prepareStage(root, stageDirectory) {
  const expected = await expectedReleaseFiles(root);
  const sources = new Map();
  for (const name of expected) {
    const bytes = await readRegularFileNoFollow(join(root, name), name, {
      maxBytes:
        name === "main.js" ? RELEASE_BUNDLE_MAX_BYTES : RELEASE_FILE_MAX_BYTES,
    });
    if (name === "main.js") inspectBundle(bytes);
    sources.set(name, bytes);
  }
  await mkdir(stageDirectory, { mode: 0o700 });
  for (const name of expected) {
    await writeFile(join(stageDirectory, name), sources.get(name), {
      flag: "wx",
      mode: 0o600,
    });
  }
  const validation = await inspectReleaseDirectory({
    root,
    directory: stageDirectory,
  });
  if (!validation.ok) {
    throw new Error(validation.errors.join(","));
  }
}

export async function stageReleaseArtifacts({
  root = process.cwd(),
  hooks = {},
  operations = {},
} = {}) {
  const resolvedRoot = resolve(root);
  const ops = {
    lstat,
    mkdir,
    realpath,
    rename,
    rm,
    writeFile,
    ...operations,
  };
  const nonce = `${process.pid}-${randomUUID()}`;
  const releaseDirectory = join(resolvedRoot, "release");
  const stageDirectory = join(resolvedRoot, `.release-stage-${nonce}`);
  const backupDirectory = join(resolvedRoot, `.release-backup-${nonce}`);
  let priorMoved = false;
  let installed = false;
  let preserveBackup = false;
  let primaryError;
  const rootBefore = await ops.lstat(resolvedRoot);
  const rootRealpath = await ops.realpath(resolvedRoot);
  const assertRootIdentity = async () => {
    // Node does not expose openat(2); pin the parent by checking realpath and inode
    // around every directory swap and retain backups whenever identity is uncertain.
    const current = await ops.lstat(resolvedRoot);
    const currentRealpath = await ops.realpath(resolvedRoot);
    if (
      !current.isDirectory() ||
      current.dev !== rootBefore.dev ||
      current.ino !== rootBefore.ino ||
      currentRealpath !== rootRealpath
    ) {
      throw new Error("release-root-identity-changed");
    }
  };
  const renameWithinRoot = async (source, destination) => {
    await assertRootIdentity();
    await ops.rename(source, destination);
    await assertRootIdentity();
  };
  try {
    const existingRelease = await lstatIfPresent(releaseDirectory);
    if (existingRelease?.isSymbolicLink()) {
      throw new Error("release-directory-symlink");
    }
    await prepareStage(resolvedRoot, stageDirectory);
    await hooks.beforeInstall?.();

    if (existingRelease) {
      await renameWithinRoot(releaseDirectory, backupDirectory);
      priorMoved = true;
    }
    try {
      await hooks.afterBackup?.();
      await renameWithinRoot(stageDirectory, releaseDirectory);
      installed = true;
      const finalValidation = await inspectReleaseDirectory({
        root: resolvedRoot,
        directory: releaseDirectory,
      });
      if (!finalValidation.ok) {
        throw new Error(finalValidation.errors.join(","));
      }
    } catch (error) {
      if (installed) {
        try {
          await renameWithinRoot(releaseDirectory, stageDirectory);
          installed = false;
        } catch {
          preserveBackup = priorMoved;
          throw new Error(
            priorMoved
              ? `release-recovery-required:${backupDirectory}`
              : "release-install-recovery-failed",
          );
        }
      }
      if (priorMoved) {
        try {
          await renameWithinRoot(backupDirectory, releaseDirectory);
          priorMoved = false;
        } catch {
          preserveBackup = true;
          throw new Error(`release-recovery-required:${backupDirectory}`);
        }
      }
      throw error;
    }
    if (priorMoved) {
      try {
        await ops.rm(backupDirectory, { recursive: true });
        priorMoved = false;
      } catch {
        preserveBackup = true;
        throw new Error(`release-recovery-required:${backupDirectory}`);
      }
    }
    return { ok: true, files: await expectedReleaseFiles(resolvedRoot) };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    let stageCleanupFailed = false;
    if (!installed) {
      try {
        await ops.rm(stageDirectory, { recursive: true, force: true });
      } catch {
        stageCleanupFailed = true;
      }
    }
    if (priorMoved && !preserveBackup) {
      const releasePresent = await lstatIfPresent(releaseDirectory);
      if (!releasePresent) {
        try {
          await renameWithinRoot(backupDirectory, releaseDirectory);
          priorMoved = false;
        } catch {
          preserveBackup = true;
        }
      }
    }
    if (stageCleanupFailed) {
      const primaryMessage =
        primaryError instanceof Error
          ? primaryError.message
          : "release-stage-cleanup-failed";
      throw new Error(
        `release-operation-failed:${primaryMessage};release-recovery-required:${stageDirectory}`,
      );
    }
  }
}

function parseArguments(argv) {
  let mode;
  let root = process.cwd();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--stage" || argument === "--check") {
      if (mode) throw new Error("mode-duplicate");
      mode = argument.slice(2);
      continue;
    }
    if (argument === "--root") {
      root = argv[index + 1];
      if (!root) throw new Error("root-missing");
      index += 1;
      continue;
    }
    throw new Error("argument-invalid");
  }
  if (!mode) throw new Error("mode-required");
  return { mode, root };
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch {
    console.error("release-artifact-arguments-invalid");
    process.exitCode = 2;
    return;
  }
  try {
    if (options.mode === "stage") {
      const result = await stageReleaseArtifacts({ root: options.root });
      console.log(`release-staged:${result.files.join(",")}`);
      return;
    }
    const result = await checkReleaseArtifacts({ root: options.root });
    if (!result.ok) {
      console.log(result.errors.join("\n"));
      process.exitCode = 1;
      return;
    }
    console.log("release-artifacts-valid");
  } catch (error) {
    console.error(error?.message ?? "release-artifact-operational-error");
    process.exitCode = 2;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
