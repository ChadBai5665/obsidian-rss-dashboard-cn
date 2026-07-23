import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION_FILE_MAX_BYTES = 1024 * 1024;
const EXPECTED_PACKAGE_NAME = "obsidian-rss-dashboard-cn";
const EXPECTED_PLUGIN_AUTHOR = "ChadBai";
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function isStrictSemVer(value) {
  return typeof value === "string" && SEMVER_PATTERN.test(value);
}

async function readJsonNoFollow(path, name) {
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
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      await handle.readFile(),
    );
    const value = JSON.parse(text);
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      throw new Error(`${name}-shape-invalid`);
    }
    return value;
  } finally {
    await handle.close();
  }
}

export async function checkVersionConsistency({
  repository = process.cwd(),
  tag,
} = {}) {
  const root = resolve(repository);
  const [packageJson, packageLock, manifest, versions] = await Promise.all([
    readJsonNoFollow(join(root, "package.json"), "package-json"),
    readJsonNoFollow(join(root, "package-lock.json"), "package-lock-json"),
    readJsonNoFollow(join(root, "manifest.json"), "manifest-json"),
    readJsonNoFollow(join(root, "versions.json"), "versions-json"),
  ]);
  const errors = [];
  const packageVersion = packageJson.version;
  const manifestVersion = manifest.version;
  const minAppVersion = manifest.minAppVersion;

  if (!isStrictSemVer(packageVersion)) {
    errors.push("package-version-invalid");
  }
  if (!isStrictSemVer(manifestVersion)) {
    errors.push("manifest-version-invalid");
  }
  if (packageVersion !== manifestVersion) {
    errors.push("package-manifest-version-mismatch");
  }
  if (packageLock.version !== packageVersion) {
    errors.push("package-lock-version-mismatch");
  }
  if (packageLock.name !== EXPECTED_PACKAGE_NAME) {
    errors.push("package-lock-name-mismatch");
  }
  const lockRoot =
    packageLock.packages &&
    typeof packageLock.packages === "object" &&
    !Array.isArray(packageLock.packages)
      ? packageLock.packages[""]
      : undefined;
  if (
    !lockRoot ||
    typeof lockRoot !== "object" ||
    Array.isArray(lockRoot)
  ) {
    errors.push("package-lock-root-missing");
  } else {
    if (
      lockRoot.name !== packageJson.name ||
      lockRoot.name !== EXPECTED_PACKAGE_NAME
    ) {
      errors.push("package-lock-root-name-mismatch");
    }
    if (lockRoot.version !== packageVersion) {
      errors.push("package-lock-root-version-mismatch");
    }
  }
  if (!isStrictSemVer(minAppVersion)) {
    errors.push("manifest-min-app-version-invalid");
  }
  if (versions[packageVersion] !== minAppVersion) {
    errors.push("versions-current-entry-mismatch");
  }
  const versionKeys = Object.keys(versions);
  if (versionKeys.length === 0 || versionKeys.at(-1) !== packageVersion) {
    errors.push("versions-current-entry-not-last");
  }
  for (const [version, requiredAppVersion] of Object.entries(versions)) {
    if (
      !isStrictSemVer(version) ||
      !isStrictSemVer(requiredAppVersion)
    ) {
      errors.push("versions-history-invalid");
      break;
    }
  }
  if (manifest.id !== "rss-dashboard-cn") {
    errors.push("plugin-id-mismatch");
  }
  if (manifest.name !== "RSS Dashboard CN") {
    errors.push("plugin-name-mismatch");
  }
  if (manifest.isDesktopOnly !== true) {
    errors.push("plugin-desktop-only-mismatch");
  }
  if (packageJson.name !== EXPECTED_PACKAGE_NAME) {
    errors.push("package-name-mismatch");
  }
  if (packageJson.author !== EXPECTED_PLUGIN_AUTHOR) {
    errors.push("package-author-mismatch");
  }
  if (manifest.author !== EXPECTED_PLUGIN_AUTHOR) {
    errors.push("manifest-author-mismatch");
  }
  if (
    tag !== undefined &&
    (typeof tag !== "string" ||
      !isStrictSemVer(tag) ||
      tag !== packageVersion ||
      !/^[\u0021-\u007e]+$/.test(tag))
  ) {
    errors.push("release-tag-invalid");
  }

  const uniqueErrors = [...new Set(errors)].sort();
  return { ok: uniqueErrors.length === 0, errors: uniqueErrors };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "--repo" && argument !== "--tag") {
      throw new Error("argument-invalid");
    }
    const value = argv[index + 1];
    if (!value) throw new Error("argument-missing");
    index += 1;
    if (argument === "--repo") options.repository = value;
    if (argument === "--tag") options.tag = value;
  }
  return options;
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch {
    console.error("version-check-arguments-invalid");
    process.exitCode = 2;
    return;
  }
  try {
    const result = await checkVersionConsistency(options);
    if (!result.ok) {
      console.log(result.errors.join("\n"));
      process.exitCode = 1;
      return;
    }
    console.log("version-consistency-valid");
  } catch {
    console.error("version-check-operational-error");
    process.exitCode = 2;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
