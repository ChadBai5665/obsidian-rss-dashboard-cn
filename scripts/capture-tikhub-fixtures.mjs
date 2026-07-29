import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  assertTikHubRawFixtureSafe,
  assertTikHubFixtureShapeSafe,
  assertTikHubFixtureSanitized,
  sanitizeTikHubFixture,
} from "./sanitize-tikhub-fixture.mjs";

const execFileAsync = promisify(execFile);
const API_ORIGIN = "https://api.tikhub.io";
const FIXTURE_NAMES = [
  "account-posts.json",
  "search-latest.json",
  "search-top.json",
];
const MAX_SHAPE_NODES = 100_000;
const MAX_SHAPE_DEPTH = 32;
const MAX_SHAPE_ARRAY_ENTRIES = 100_000;
const HELP = `Capture sanitized TikHub response fixtures.

This command makes exactly 3 potentially billable requests:
1 account timeline request, 1 Latest search request, and 1 Top search request.

Required environment variables:
  TIKHUB_API_KEY          TikHub key (environment only; never a command argument)
  TIKHUB_FIXTURE_HANDLE   Account used for the one-time shape capture
  TIKHUB_FIXTURE_QUERY    Search query used for the one-time shape capture

Usage:
  npm run fixtures:tikhub
`;

export async function captureTikHubFixtures(options) {
  const apiKey = requireNonBlank(options.apiKey, "TikHub API key is required.");
  const handle = requireHandle(options.handle);
  const query = requireNonBlank(options.query, "TikHub fixture query is required.");
  const destinationDir = resolve(options.destinationDir);
  const repositoryRoot = resolve(options.cwd ?? process.cwd());
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const isDestinationDirty =
    options.isDestinationDirty ??
    (async () => await gitDestinationIsDirty(destinationDir, repositoryRoot));
  const log = options.log ?? console.log;

  await assertSafeCapturePaths(repositoryRoot, destinationDir);
  if (await isDestinationDirty()) {
    throw new Error("TikHub fixture destination has uncommitted changes.");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("TikHub fixture HTTP transport is unavailable.");
  }

  const requests = buildRequests(handle, query);
  const sanitizedFixtures = [];
  for (let index = 0; index < requests.length; index += 1) {
    const raw = await fetchFixture(fetchImpl, requests[index], apiKey, index + 1);
    assertTikHubRawFixtureSafe(raw);
    const sanitized = sanitizeTikHubFixture(raw, { handle, query });
    assertTikHubFixtureSanitized(sanitized, { apiKey, handle, query });
    sanitizedFixtures.push(sanitized);
    log(`TikHub fixture request ${index + 1} of 3 completed.`);
  }

  await assertSafeCapturePaths(repositoryRoot, destinationDir);
  await writeTikHubFixtureSet(destinationDir, sanitizedFixtures);
  log("Wrote 3 sanitized TikHub fixtures.");
  return { requestCount: requests.length, files: [...FIXTURE_NAMES] };
}

function buildRequests(handle, query) {
  return [
    requestUrl("/api/v1/twitter/web/fetch_user_post_tweet", {
      screen_name: handle,
    }),
    requestUrl("/api/v1/twitter/web/fetch_search_timeline", {
      keyword: query,
      search_type: "Latest",
    }),
    requestUrl("/api/v1/twitter/web/fetch_search_timeline", {
      keyword: query,
      search_type: "Top",
    }),
  ];
}

function requestUrl(pathname, query) {
  const url = new URL(pathname, `${API_ORIGIN}/`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.toString();
}

async function fetchFixture(fetchImpl, url, apiKey, sequence) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch {
    throw new Error(`TikHub fixture request ${sequence} failed before a response.`);
  }

  const responseView = readResponseView(response);
  if (!responseView || responseView.ok !== true) {
    throw new Error(
      `TikHub fixture request ${sequence} failed with status ${responseView?.status ?? "unknown"}.`,
    );
  }
  try {
    const raw = await responseView.readJson();
    if (ownValue(raw, "code") !== 200) {
      throw new Error("provider rejected fixture request");
    }
    return raw;
  } catch {
    throw new Error(`TikHub fixture request ${sequence} returned invalid JSON.`);
  }
}

function readResponseView(response) {
  const standard = readStandardResponseView(response);
  if (standard) return standard;
  const ok = ownValue(response, "ok");
  const status = ownValue(response, "status");
  const json = ownValue(response, "json");
  if (
    typeof ok !== "boolean" ||
    !Number.isInteger(status) ||
    status < 100 ||
    status > 599 ||
    typeof json !== "function"
  ) {
    return undefined;
  }
  return { ok, status, readJson: async () => await json.call(response) };
}

function readStandardResponseView(response) {
  try {
    const prototype = globalThis.Response?.prototype;
    if (!prototype) return undefined;
    const statusGetter = Object.getOwnPropertyDescriptor(prototype, "status")?.get;
    const okGetter = Object.getOwnPropertyDescriptor(prototype, "ok")?.get;
    const json = trustedPrototypeMethod(prototype, "json");
    if (!statusGetter || !okGetter || !json) return undefined;
    const status = statusGetter.call(response);
    const ok = okGetter.call(response);
    if (typeof ok !== "boolean" || !Number.isInteger(status)) return undefined;
    return { ok, status, readJson: async () => await json.call(response) };
  } catch {
    return undefined;
  }
}

function trustedPrototypeMethod(prototype, key) {
  let current = prototype;
  while (current && current !== Object.prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor && "value" in descriptor && typeof descriptor.value === "function") {
      return descriptor.value;
    }
    current = Object.getPrototypeOf(current);
  }
  return undefined;
}

function fixtureStatistics(fixtures) {
  return Object.fromEntries(
    FIXTURE_NAMES.map((name, index) => [
      name,
      { candidateCount: countTikHubTweetCandidates(fixtures[index]) },
    ]),
  );
}

/** Independently counts GraphQL tweet-result candidates without parsing X posts. */
export function countTikHubTweetCandidates(payload) {
  let count = 0;
  const instructionArrays = findShapeNamedArrays(payload, "instructions");
  for (const instructions of instructionArrays) {
    for (const instruction of shapeArrayValues(instructions)) {
      const entries = ownValue(instruction, "entries");
      if (!Array.isArray(entries)) continue;
      for (const entry of shapeArrayValues(entries)) {
        if (isShapeCursorEntry(entry)) continue;
        count += countEntryTweetCandidates(entry);
      }
    }
  }
  return count;
}

function countEntryTweetCandidates(entry) {
  let count = 0;
  walkShape(entry, (record) => {
    for (const key of ["tweet_results", "tweetResult"]) {
      const container = ownValue(record, key);
      if (!container || typeof container !== "object" || Array.isArray(container)) {
        continue;
      }
      if (ownValue(container, "result") !== undefined) count += 1;
      return false;
    }
    return true;
  });
  return count;
}

function findShapeNamedArrays(payload, key) {
  const arrays = [];
  walkShape(payload, (record) => {
    const candidate = ownValue(record, key);
    if (Array.isArray(candidate)) arrays.push(candidate);
    return true;
  });
  return arrays;
}

function walkShape(root, visit) {
  const seen = new WeakSet();
  const stack = [{ value: root, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || current.depth > MAX_SHAPE_DEPTH) shapeLimit();
    const value = current.value;
    if (!value || typeof value !== "object") continue;
    if (seen.has(value)) shapeLimit();
    seen.add(value);
    nodes += 1;
    if (nodes > MAX_SHAPE_NODES) shapeLimit();

    if (Array.isArray(value)) {
      for (const child of shapeArrayValues(value)) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
      continue;
    }
    if (!visit(value)) continue;
    const keys = shapeKeys(value);
    for (const key of keys) {
      const child = ownValue(value, key);
      if (child !== undefined) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
}

function shapeArrayValues(value) {
  if (value.length > MAX_SHAPE_ARRAY_ENTRIES) shapeLimit();
  const keys = shapeKeys(value);
  if (keys.length > MAX_SHAPE_ARRAY_ENTRIES) shapeLimit();
  const result = [];
  for (const key of keys) {
    if (!/^(?:0|[1-9]\d*)$/.test(key)) continue;
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index < 0 || index >= value.length) continue;
    const child = ownValue(value, key);
    if (child !== undefined) result.push(child);
  }
  return result;
}

function shapeKeys(value) {
  try {
    return Object.keys(value);
  } catch {
    shapeLimit();
  }
}

function isShapeCursorEntry(entry) {
  const entryId = ownValue(entry, "entryId");
  if (typeof entryId === "string" && entryId.toLowerCase().startsWith("cursor-")) {
    return true;
  }
  const content = ownValue(entry, "content");
  const entryType = ownValue(content, "entryType");
  const cursorType = ownValue(content, "cursorType");
  return entryType === "TimelineTimelineCursor" || typeof cursorType === "string";
}

function shapeLimit() {
  throw new Error("TikHub fixture response shape is unsafe.");
}

function ownValue(value, key) {
  try {
    const descriptor =
      value && (typeof value === "object" || typeof value === "function")
        ? Object.getOwnPropertyDescriptor(value, key)
        : undefined;
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

async function assertSafeCapturePaths(repositoryRoot, destinationDir) {
  const rootStat = await safeLstat(repositoryRoot, "repository");
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("TikHub fixture repository path is unsafe.");
  }

  let realRepositoryRoot;
  try {
    realRepositoryRoot = await realpath(repositoryRoot);
  } catch {
    throw new Error("TikHub fixture repository path is unsafe.");
  }
  const relativePath = relative(repositoryRoot, destinationDir);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    throw new Error("TikHub fixture destination path is unsafe.");
  }

  let current = repositoryRoot;
  let deepestExisting = repositoryRoot;
  for (const segment of relativePath.split(sep)) {
    current = join(current, segment);
    const stat = await safeLstat(current, "destination");
    if (!stat) break;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("TikHub fixture destination path is unsafe.");
    }
    deepestExisting = current;
  }

  let realExisting;
  try {
    realExisting = await realpath(deepestExisting);
  } catch {
    throw new Error("TikHub fixture destination path is unsafe.");
  }
  const realRelative = relative(realRepositoryRoot, realExisting);
  if (realRelative === ".." || realRelative.startsWith(`..${sep}`)) {
    throw new Error("TikHub fixture destination path is unsafe.");
  }
}

async function safeLstat(path, kind) {
  try {
    return await lstat(path);
  } catch (error) {
    if (ownValue(error, "code") === "ENOENT" && kind === "destination") {
      return undefined;
    }
    throw new Error(
      kind === "repository"
        ? "TikHub fixture repository path is unsafe."
        : "TikHub fixture destination path is unsafe.",
    );
  }
}

export async function writeTikHubFixtureSet(
  destinationDir,
  fixtures,
  options = {},
) {
  if (!Array.isArray(fixtures) || fixtures.length !== FIXTURE_NAMES.length) {
    throw new Error("TikHub fixture activation failed.");
  }
  for (const fixture of fixtures) {
    assertTikHubFixtureShapeSafe(fixture);
    assertTikHubFixtureSanitized(fixture);
  }
  const statistics = fixtureStatistics(fixtures);
  if (
    Object.values(statistics).some(
      ({ candidateCount }) => !Number.isSafeInteger(candidateCount) || candidateCount <= 0,
    )
  ) {
    throw new Error("TikHub fixture response contained no tweet candidates.");
  }

  const captureId = options.captureId ?? randomUUID();
  if (!/^[A-Za-z0-9-]{1,128}$/.test(captureId)) {
    throw new Error("TikHub fixture activation failed.");
  }
  const fsOps = {
    rename: options.fsOps?.rename ?? rename,
    rm: options.fsOps?.rm ?? rm,
  };
  const capturesDir = join(destinationDir, "captures");
  await mkdir(capturesDir, { recursive: true, mode: 0o700 });
  await requireSafeDirectory(destinationDir);
  await requireSafeDirectory(capturesDir);

  const stagingDir = join(capturesDir, `.staging-${captureId}-${randomUUID()}`);
  const finalDir = join(capturesDir, captureId);
  const manifestPath = join(destinationDir, "current.json");
  const manifestTemp = join(destinationDir, `.current-${captureId}-${randomUUID()}.tmp`);
  let stagedAsFinal = false;

  try {
    await mkdir(stagingDir, { mode: 0o700 });
    for (let index = 0; index < FIXTURE_NAMES.length; index += 1) {
      await writeExclusiveJson(
        join(stagingDir, FIXTURE_NAMES[index]),
        fixtures[index],
      );
    }
    await fsOps.rename(stagingDir, finalDir);
    stagedAsFinal = true;
    await writeExclusiveJson(manifestTemp, {
      version: 2,
      activeVersion: captureId,
      files: FIXTURE_NAMES,
      statistics,
    });
    await fsOps.rename(manifestTemp, manifestPath);
  } catch {
    await bestEffortRemove(fsOps.rm, manifestTemp, false);
    await bestEffortRemove(fsOps.rm, stagedAsFinal ? finalDir : stagingDir, true);
    throw new Error("TikHub fixture activation failed.");
  }

  await cleanupInactiveTikHubFixtureSets(destinationDir, { fsOps }).catch(
    () => undefined,
  );
  return { captureId, files: [...FIXTURE_NAMES], statistics };
}

export async function readActiveTikHubFixtureSet(destinationDir) {
  const manifestPath = join(destinationDir, "current.json");
  const manifestStat = await optionalLstat(manifestPath);
  if (manifestStat) {
    if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
      throw new Error("TikHub fixture manifest is unsafe.");
    }
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch {
      throw new Error("TikHub fixture manifest is invalid.");
    }
    const manifestData = validManifestData(manifest);
    if (!manifestData) throw new Error("TikHub fixture manifest is invalid.");
    const captureDir = join(destinationDir, "captures", manifestData.activeVersion);
    await requireSafeDirectory(captureDir);
    return {
      captureRef: manifestData.activeVersion,
      files: [...FIXTURE_NAMES],
      statistics: manifestData.statistics,
      fixtures: await readFixtureFiles(captureDir),
    };
  }

  const legacyStates = await Promise.all(
    FIXTURE_NAMES.map(async (name) => await optionalLstat(join(destinationDir, name))),
  );
  if (legacyStates.every((state) => state === undefined)) return undefined;
  if (
    legacyStates.some(
      (state) => !state || state.isSymbolicLink() || !state.isFile(),
    )
  ) {
    throw new Error("TikHub fixture set is incomplete.");
  }
  const fixtures = await readFixtureFiles(destinationDir);
  return {
    captureRef: "legacy",
    files: [...FIXTURE_NAMES],
    statistics: fixtureStatistics(fixtures),
    fixtures,
  };
}

export async function cleanupInactiveTikHubFixtureSets(
  destinationDir,
  options = {},
) {
  const fsOps = { rm: options.fsOps?.rm ?? rm };
  const manifest = await readManifestCaptureId(destinationDir);
  const capturesDir = join(destinationDir, "captures");
  const capturesStat = await optionalLstat(capturesDir);
  if (!capturesStat) return;
  if (capturesStat.isSymbolicLink() || !capturesStat.isDirectory()) {
    throw new Error("TikHub fixture capture directory is unsafe.");
  }
  const entries = await readdir(capturesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    if (entry.name === manifest) continue;
    if (
      !/^[A-Za-z0-9-]{1,128}$/.test(entry.name) &&
      !/^\.staging-[A-Za-z0-9-]+$/.test(entry.name)
    ) {
      continue;
    }
    await fsOps.rm(join(capturesDir, entry.name), {
      recursive: true,
      force: true,
    });
  }
}

async function readManifestCaptureId(destinationDir) {
  const manifestPath = join(destinationDir, "current.json");
  const stat = await optionalLstat(manifestPath);
  if (!stat) return undefined;
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("TikHub fixture manifest is unsafe.");
  }
  try {
    const manifestData = validManifestData(
      JSON.parse(await readFile(manifestPath, "utf8")),
    );
    if (!manifestData) throw new Error("invalid manifest");
    return manifestData.activeVersion;
  } catch {
    throw new Error("TikHub fixture manifest is invalid.");
  }
}

function validManifestData(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return undefined;
  }
  const version = ownValue(manifest, "version");
  const activeVersion = ownValue(manifest, "activeVersion");
  const files = ownValue(manifest, "files");
  const statistics = ownValue(manifest, "statistics");
  const manifestKeys = Object.keys(manifest);
  if (
    version !== 2 ||
    manifestKeys.length !== 4 ||
    !["activeVersion", "files", "statistics", "version"].every((key) =>
      manifestKeys.includes(key),
    ) ||
    typeof activeVersion !== "string" ||
    !/^[A-Za-z0-9-]{1,128}$/.test(activeVersion) ||
    !Array.isArray(files) ||
    files.length !== FIXTURE_NAMES.length ||
    !FIXTURE_NAMES.every((name, index) => files[index] === name) ||
    !statistics ||
    typeof statistics !== "object" ||
    Array.isArray(statistics)
  ) {
    return undefined;
  }
  const statisticKeys = Object.keys(statistics);
  if (
    statisticKeys.length !== FIXTURE_NAMES.length ||
    !FIXTURE_NAMES.every((name) => statisticKeys.includes(name))
  ) {
    return undefined;
  }
  const normalizedStatistics = {};
  for (const name of FIXTURE_NAMES) {
    const entry = ownValue(statistics, name);
    const candidateCount = ownValue(entry, "candidateCount");
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      Object.keys(entry).length !== 1 ||
      !Number.isSafeInteger(candidateCount) ||
      candidateCount <= 0
    ) {
      return undefined;
    }
    normalizedStatistics[name] = { candidateCount };
  }
  return { activeVersion, statistics: normalizedStatistics };
}

async function readFixtureFiles(directory) {
  return await Promise.all(
    FIXTURE_NAMES.map(async (name) => {
      const path = join(directory, name);
      const stat = await optionalLstat(path);
      if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error("TikHub fixture set is incomplete.");
      }
      try {
        return JSON.parse(await readFile(path, "utf8"));
      } catch {
        throw new Error("TikHub fixture set is invalid.");
      }
    }),
  );
}

async function writeExclusiveJson(path, value) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function requireSafeDirectory(path) {
  const stat = await optionalLstat(path);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("TikHub fixture capture directory is unsafe.");
  }
}

async function optionalLstat(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (ownValue(error, "code") === "ENOENT") return undefined;
    throw error;
  }
}

async function bestEffortRemove(remove, path, recursive) {
  try {
    await remove(path, { recursive, force: true });
  } catch {
    // A complete unreferenced capture is safe and can be retried later.
  }
}

async function gitDestinationIsDirty(destinationDir, cwd = process.cwd()) {
  const repositoryRoot = resolve(cwd);
  const relativePath = relative(repositoryRoot, destinationDir);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`)
  ) {
    throw new Error("TikHub fixture destination must be inside the repository.");
  }
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      "git",
      ["status", "--porcelain", "--untracked-files=all", "--", relativePath],
      { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 1024 * 1024 },
    ));
  } catch {
    throw new Error("Unable to inspect the TikHub fixture destination in git.");
  }
  return stdout.trim().length > 0;
}

function requireNonBlank(value, message) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(message);
  }
  return value.trim();
}

function requireHandle(value) {
  const handle = requireNonBlank(value, "TikHub fixture handle is required.").replace(
    /^@/,
    "",
  );
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) {
    throw new Error("TikHub fixture handle is invalid.");
  }
  return handle;
}

async function runCli() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }
  await captureTikHubFixtures({
    apiKey: process.env.TIKHUB_API_KEY,
    handle: process.env.TIKHUB_FIXTURE_HANDLE,
    query: process.env.TIKHUB_FIXTURE_QUERY,
    destinationDir: join(
      process.cwd(),
      "test_files",
      "fixtures",
      "tikhub",
      "live",
    ),
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  runCli().catch((error) => {
    const message = error instanceof Error ? error.message : "TikHub fixture capture failed.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
