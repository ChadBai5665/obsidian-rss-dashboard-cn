import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { sanitizeTikHubFixture } from "./sanitize-tikhub-fixture.mjs";

const execFileAsync = promisify(execFile);
const API_ORIGIN = "https://api.tikhub.dev";
const FIXTURE_NAMES = [
  "account-posts.json",
  "search-latest.json",
  "search-top.json",
];
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
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const isDestinationDirty =
    options.isDestinationDirty ??
    (async () => await gitDestinationIsDirty(destinationDir, options.cwd));
  const log = options.log ?? console.log;

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
    const sanitized = sanitizeTikHubFixture(raw, { handle, query });
    assertSanitizedFixture(sanitized, { apiKey, handle, query });
    sanitizedFixtures.push(sanitized);
    log(`TikHub fixture request ${index + 1} of 3 completed.`);
  }

  await replaceFixtureDirectory(destinationDir, sanitizedFixtures);
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

  const status = safeStatus(response);
  if (!response || ownValue(response, "ok") !== true) {
    throw new Error(
      `TikHub fixture request ${sequence} failed with status ${status ?? "unknown"}.`,
    );
  }
  try {
    const json = ownValue(response, "json");
    if (typeof json !== "function") throw new Error("missing JSON reader");
    const raw = await json.call(response);
    if (ownValue(raw, "code") !== 200) {
      throw new Error("provider rejected fixture request");
    }
    return raw;
  } catch {
    throw new Error(`TikHub fixture request ${sequence} returned invalid JSON.`);
  }
}

function safeStatus(response) {
  try {
    const descriptor =
      response && typeof response === "object"
        ? Object.getOwnPropertyDescriptor(response, "status")
        : undefined;
    const status = descriptor && "value" in descriptor ? descriptor.value : undefined;
    return Number.isInteger(status) && status >= 100 && status <= 599
      ? status
      : undefined;
  } catch {
    return undefined;
  }
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

function assertSanitizedFixture(value, privateValues) {
  const serialized = JSON.stringify(value);
  const forbiddenPatterns = [
    /Bearer/i,
    /api_key/i,
    /request_id/i,
    /cache_url/i,
    /TIKHUB_API_KEY/i,
  ];
  if (
    forbiddenPatterns.some((pattern) => pattern.test(serialized)) ||
    [privateValues.apiKey, privateValues.handle, privateValues.query].some(
      (privateValue) => privateValue && serialized.includes(privateValue),
    )
  ) {
    throw new Error("TikHub fixture sanitization verification failed.");
  }
}

async function replaceFixtureDirectory(destinationDir, fixtures) {
  const parent = dirname(destinationDir);
  const base = destinationDir.slice(parent.length + 1);
  await mkdir(parent, { recursive: true });
  const stagingDir = await mkdtemp(join(parent, `.${base}-stage-`));
  const backupDir = join(parent, `.${base}-backup-${randomUUID()}`);
  let destinationWasMoved = false;

  try {
    for (let index = 0; index < FIXTURE_NAMES.length; index += 1) {
      const serialized = `${JSON.stringify(fixtures[index], null, 2)}\n`;
      await writeFile(join(stagingDir, FIXTURE_NAMES[index]), serialized, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
    }

    if (await exists(destinationDir)) {
      await rename(destinationDir, backupDir);
      destinationWasMoved = true;
    }
    try {
      await rename(stagingDir, destinationDir);
    } catch (error) {
      if (destinationWasMoved) await rename(backupDir, destinationDir);
      throw error;
    }
    if (destinationWasMoved) await rm(backupDir, { recursive: true, force: true });
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
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

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
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
    destinationDir: join(process.cwd(), "test_files", "fixtures", "tikhub"),
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
