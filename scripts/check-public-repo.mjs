import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PUBLIC_SCAN_LIMITS = Object.freeze({
  maxTrackedFiles: 20_000,
  maxFileBytes: 4 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxLineBytes: 512 * 1024,
  maxAllowlistBytes: 256 * 1024,
  maxAllowlistEntries: 256,
  maxPrivateTerms: 256,
  maxFindings: 200,
});

const CONTENT_RULE_IDS = new Set([
  "home-path",
  "vault-secret-path",
  "credential-value",
  "credential-url",
  "private-key-material",
  "private-x-handle",
  "private-topic-keyword",
  "unfinished-release-placeholder",
  "unfinished-author-metadata",
  "file-size-limit",
  "line-size-limit",
  "total-size-limit",
]);

const NEVER_ALLOWLIST_RULE_IDS = new Set([
  "private-key-material",
  "tracked-symlink",
  "unsafe-tracked-path",
  "forbidden-env-file",
  "forbidden-secret-file",
  "forbidden-private-key-file",
  "forbidden-private-data",
  "forbidden-generated-collection",
  "forbidden-raw-provider-fixture",
  "forbidden-diagnostics",
  "forbidden-generated-data",
  "file-size-limit",
  "line-size-limit",
  "total-size-limit",
]);

const RELEASE_FACING_PATHS = new Set([
  "readme.md",
  "notice.md",
  "contributing.md",
  "package.json",
  "manifest.json",
  "docs/install.zh-cn.md",
  "docs/privacy.zh-cn.md",
  "docs/troubleshooting.zh-cn.md",
  "docs/security.md",
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function fingerprintFinding(rule, lineText) {
  return `sha256:${sha256(`${rule}\0${lineText}`)}`;
}

export function parseNulPaths(output) {
  const paths = [];
  let start = 0;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== 0) {
      continue;
    }
    paths.push(output.subarray(start, index).toString("utf8"));
    start = index + 1;
  }
  if (start !== output.length) {
    throw new Error("git-path-output-not-nul-terminated");
  }
  return paths.filter((entry) => entry.length > 0);
}

function parseStageEntries(output) {
  const entries = new Map();
  for (const record of parseNulPaths(output)) {
    const separator = record.indexOf("\t");
    if (separator < 0) throw new Error("git-stage-output-invalid");
    const header = record.slice(0, separator);
    const path = record.slice(separator + 1);
    const match = header.match(/^([0-7]{6}) ([a-f0-9]{40,64}) (\d+)$/);
    if (!match || !path) throw new Error("git-stage-output-invalid");
    if (match[3] !== "0") throw new Error("git-unmerged-entry");
    entries.set(path, { mode: match[1], objectId: match[2] });
  }
  return entries;
}

function safeDisplayPath(path) {
  return path
    .replaceAll("\\", "/")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, (character) => {
      if (character === "\n") return "\\n";
      if (character === "\r") return "\\r";
      if (character === "\t") return "\\t";
      return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
    })
    .slice(0, 512);
}

function isSafeRelativePath(path) {
  if (
    path.length === 0 ||
    path.length > 1_024 ||
    path.includes("\0") ||
    path.includes("\\") ||
    isAbsolute(path) ||
    /^[A-Za-z]:/.test(path) ||
    path.startsWith("//")
  ) {
    return false;
  }
  const segments = path.split("/");
  return segments.every(
    (segment) => segment.length > 0 && segment !== "." && segment !== "..",
  );
}

function filenameRule(path) {
  const normalized = path.toLowerCase();
  const segments = normalized.split("/");
  const basename = segments.at(-1) ?? "";
  if (basename === ".env" || basename.startsWith(".env.")) {
    return "forbidden-env-file";
  }
  if (basename === "secrets.json") {
    return "forbidden-secret-file";
  }
  if (
    /^(?:id_rsa|id_ed25519|id_ecdsa)$/.test(basename) ||
    /\.(?:pem|p12|pfx|key)$/.test(basename)
  ) {
    return "forbidden-private-key-file";
  }
  if (segments.includes(".rss-dashboard-data")) {
    return "forbidden-private-data";
  }
  if (segments.includes("信息收集")) {
    return "forbidden-generated-collection";
  }
  if (
    segments.includes("raw") &&
    /(?:tikhub|provider|openai|anthropic|ai[-_.]?response)/i.test(normalized)
  ) {
    return "forbidden-raw-provider-fixture";
  }
  if (
    basename.endsWith(".diagnostics.json") ||
    segments.includes("diagnostics-output")
  ) {
    return "forbidden-diagnostics";
  }
  if (
    segments.some((segment) =>
      /^(?:collection-data|content-cache|ai-analysis|ai-results)$/.test(segment),
    )
  ) {
    return "forbidden-generated-data";
  }
  return undefined;
}

function decodePercentLayers(value) {
  const values = [value];
  let current = value;
  for (let count = 0; count < 2; count += 1) {
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) break;
      values.push(decoded);
      current = decoded;
    } catch {
      break;
    }
  }
  return values;
}

function hasCredentialUrl(value) {
  return (
    /(?:https?|ftp):\/\/[^/\s:@]+:[^/\s@]+@/i.test(value) ||
    /(?:https?|ftp):\/\/[^\s"'<>]+[?&](?:api[_-]?key|access[_-]?token|token|secret|password)=[^&#\s"'<>]{4,}/i.test(
      value,
    )
  );
}

function hasCredentialValue(value) {
  if (
    /\bauthorization["']?\s*[:=]\s*["']?(?:bearer|basic)\s+(?![{<$`])[A-Za-z0-9._~+/-]{4,}/i.test(
      value,
    )
  ) {
    return true;
  }
  if (
    /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password)["']?\s*[:=]\s*(["'])(?![{<$])[^"'\r\n]{8,}\1/i.test(
      value,
    )
  ) {
    return true;
  }
  if (
    /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password)\b\s*[:=]\s*(?![{<$`"'(])(?=[A-Za-z0-9_-]{8,}(?:[\s,;)}\]]|$))(?=[A-Za-z0-9_-]*-)[A-Za-z0-9_-]+/i.test(
      value,
    )
  ) {
    return true;
  }
  return /\b(?:sk|xox[baprs]|gh[pousr])-[A-Za-z0-9_-]{12,}\b/.test(value);
}

function contentRulesForLine(path, lineText, privateTerms) {
  const rules = [];
  const decodedLayers = decodePercentLayers(lineText);
  if (
    decodedLayers.some(
      (value) =>
        /(?:file:\/\/\/|\/)(?:Users|home)\/[^/\s"'<>]+(?:\/|\\)/.test(
          value,
        ) ||
        /[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'<>]+[\\/]|\\\\[A-Za-z0-9._-]{1,64}\\[A-Za-z0-9$._-]{1,64}(?:\\|$)/i.test(
          value,
        ),
    )
  ) {
    rules.push("home-path");
  }
  if (
    decodedLayers.some(
      (value) =>
        /(?:file:\/\/\/|\/)(?:Users|home)\/[^/\s"'<>]+[\\/][^\r\n]*?(?:\.obsidian[\\/]plugins[\\/][^\s"'<>]*secrets\.json|(?:Library[\\/]Application Support|\.config)[\\/]+rss-dashboard-cn[\\/]+secrets\.json)/.test(
          value,
        ) ||
        /[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'<>]+[\\/][^\r\n]*?(?:\.obsidian[\\/]plugins[\\/][^\s"'<>]*secrets\.json|AppData[\\/]Roaming[\\/]+rss-dashboard-cn[\\/]+secrets\.json)/i.test(
          value,
        ),
    )
  ) {
    rules.push("vault-secret-path");
  }
  if (decodedLayers.some(hasCredentialValue)) {
    rules.push("credential-value");
  }
  if (decodedLayers.some(hasCredentialUrl)) {
    rules.push("credential-url");
  }
  if (
    /-----BEGIN (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----/.test(lineText)
  ) {
    rules.push("private-key-material");
  }
  const lowerLine = lineText.toLocaleLowerCase("en-US");
  if (
    privateTerms.handles.some((handle) =>
      lowerLine.includes(handle.toLocaleLowerCase("en-US")),
    )
  ) {
    rules.push("private-x-handle");
  }
  if (
    privateTerms.keywords.some((keyword) =>
      lowerLine.includes(keyword.toLocaleLowerCase("en-US")),
    )
  ) {
    rules.push("private-topic-keyword");
  }
  if (RELEASE_FACING_PATHS.has(path.toLowerCase())) {
    if (
      /\b(?:TODO|TBD)\b|YOUR[_ -]?NAME|your-name\/your-repo|your-repo|sample author|example\.com/i.test(
        lineText,
      )
    ) {
      rules.push("unfinished-release-placeholder");
    }
    if (
      path.toLowerCase() === "package.json" &&
      /"author"\s*:\s*""/.test(lineText)
    ) {
      rules.push("unfinished-author-metadata");
    }
  }
  return [...new Set(rules)];
}

async function readBoundedJson(path, maxBytes, errorCode) {
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > maxBytes) {
    throw new Error(errorCode);
  }
  const bytes = await readFile(path);
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function validatePrivateTerms(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error("private-terms-invalid");
  }
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "handles" && key !== "keywords")) {
    throw new Error("private-terms-invalid");
  }
  const handles = value.handles ?? [];
  const keywords = value.keywords ?? [];
  if (!Array.isArray(handles) || !Array.isArray(keywords)) {
    throw new Error("private-terms-invalid");
  }
  if (handles.length + keywords.length > PUBLIC_SCAN_LIMITS.maxPrivateTerms) {
    throw new Error("private-terms-limit");
  }
  for (const term of [...handles, ...keywords]) {
    if (
      typeof term !== "string" ||
      term.length < 2 ||
      term.length > 128 ||
      term.trim() !== term ||
      /[\u0000-\u001f\u007f]/.test(term)
    ) {
      throw new Error("private-terms-invalid");
    }
  }
  return { handles: [...new Set(handles)], keywords: [...new Set(keywords)] };
}

function validateAllowlist(value) {
  if (
    !Array.isArray(value) ||
    value.length > PUBLIC_SCAN_LIMITS.maxAllowlistEntries
  ) {
    throw new Error("allowlist-shape-invalid");
  }
  const entries = [];
  const keys = new Set();
  const today = new Date().toISOString().slice(0, 10);
  for (const candidate of value) {
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      Array.isArray(candidate) ||
      Object.getPrototypeOf(candidate) !== Object.prototype
    ) {
      throw new Error("allowlist-entry-invalid");
    }
    const candidateKeys = Object.keys(candidate);
    if (
      candidateKeys.some(
        (key) =>
          !["path", "rule", "line", "fingerprint", "reason", "expires"].includes(
            key,
          ),
      )
    ) {
      throw new Error("allowlist-entry-invalid");
    }
    const { path, rule, line, fingerprint, reason, expires } = candidate;
    if (
      typeof path !== "string" ||
      !isSafeRelativePath(path) ||
      /[*?[\]{}]/.test(path) ||
      filenameRule(path) !== undefined ||
      typeof rule !== "string" ||
      !CONTENT_RULE_IDS.has(rule) ||
      NEVER_ALLOWLIST_RULE_IDS.has(rule) ||
      !Number.isSafeInteger(line) ||
      line < 1 ||
      typeof fingerprint !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(fingerprint) ||
      typeof reason !== "string" ||
      reason.trim() !== reason ||
      reason.length < 8 ||
      reason.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(reason) ||
      (expires !== undefined &&
        (typeof expires !== "string" ||
          !/^\d{4}-\d{2}-\d{2}$/.test(expires) ||
          expires < today))
    ) {
      throw new Error("allowlist-entry-invalid");
    }
    const key = `${path}\0${rule}\0${line}\0${fingerprint}`;
    if (keys.has(key)) {
      throw new Error("allowlist-entry-duplicate");
    }
    keys.add(key);
    entries.push({ path, rule, line, fingerprint, reason, expires, key });
  }
  return entries;
}

function findingKey(finding) {
  return `${finding.path}\0${finding.rule}\0${finding.line}\0${finding.fingerprint}`;
}

function renderFindings(findings) {
  return findings
    .map(
      (finding) =>
        `${finding.rule} ${safeDisplayPath(finding.path)}:${finding.line} ${finding.fingerprint.slice(0, 19)}`,
    )
    .join("\n");
}

async function safeReadTrackedFile(absolutePath, expectedSize) {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(absolutePath, constants.O_RDONLY | noFollow);
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size !== expectedSize) {
      throw new Error("tracked-file-raced");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function scanPublicRepository({
  repository = process.cwd(),
  allowlistPath = resolve(repository, "scripts/public-scan-allowlist.json"),
  privateTermsPath,
} = {}) {
  try {
    const root = resolve(repository);
    const trackedOutput = execFileSync("git", ["ls-files", "-z"], {
      cwd: root,
      encoding: "buffer",
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const trackedPaths = parseNulPaths(trackedOutput);
    if (trackedPaths.length > PUBLIC_SCAN_LIMITS.maxTrackedFiles) {
      return {
        exitCode: 2,
        findings: [],
        output: "tracked-file-count-limit",
      };
    }
    const stageEntries = parseStageEntries(
      execFileSync("git", ["ls-files", "--stage", "-z"], {
        cwd: root,
        encoding: "buffer",
        maxBuffer: 16 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );

    const allowlistValue = await readBoundedJson(
      resolve(allowlistPath),
      PUBLIC_SCAN_LIMITS.maxAllowlistBytes,
      "allowlist-size-invalid",
    );
    const allowlist = validateAllowlist(allowlistValue);
    const privateTerms = privateTermsPath
      ? validatePrivateTerms(
          await readBoundedJson(
            resolve(privateTermsPath),
            PUBLIC_SCAN_LIMITS.maxAllowlistBytes,
            "private-terms-size-invalid",
          ),
        )
      : { handles: [], keywords: [] };

    const allFindings = [];
    let totalBytes = 0;
    let limitReached = false;
    const addFinding = (path, line, rule, lineText) => {
      if (allFindings.length >= PUBLIC_SCAN_LIMITS.maxFindings) {
        limitReached = true;
        return;
      }
      allFindings.push({
        path,
        line,
        rule,
        fingerprint: fingerprintFinding(rule, lineText),
      });
    };

    for (const path of trackedPaths) {
      if (!isSafeRelativePath(path)) {
        addFinding(path, 0, "unsafe-tracked-path", path);
        continue;
      }
      const absolutePath = resolve(root, path);
      const fromRoot = relative(root, absolutePath);
      if (
        fromRoot.startsWith("..") ||
        isAbsolute(fromRoot) ||
        fromRoot.replaceAll("\\", "/") !== path
      ) {
        addFinding(path, 0, "unsafe-tracked-path", path);
        continue;
      }
      let stats;
      try {
        stats = await lstat(absolutePath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      const stageEntry = stageEntries.get(path);
      const stageMode = stageEntry?.mode;
      if (stats?.isSymbolicLink() || (!stats && stageMode === "120000")) {
        addFinding(path, 0, "tracked-symlink", path);
        continue;
      }
      if ((stats && !stats.isFile()) || (!stats && !/^100(?:644|755)$/.test(stageMode ?? ""))) {
        addFinding(path, 0, "unsafe-tracked-path", path);
        continue;
      }
      const filenameFinding = filenameRule(path);
      if (filenameFinding) {
        addFinding(path, 0, filenameFinding, path);
      }
      const expectedSize = stats?.size;
      if (
        expectedSize !== undefined &&
        expectedSize > PUBLIC_SCAN_LIMITS.maxFileBytes
      ) {
        addFinding(path, 0, "file-size-limit", path);
        continue;
      }
      const bytes = stats
        ? await safeReadTrackedFile(absolutePath, expectedSize)
        : execFileSync("git", ["cat-file", "blob", stageEntry.objectId], {
            cwd: root,
            encoding: "buffer",
            env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
            maxBuffer: PUBLIC_SCAN_LIMITS.maxFileBytes + 1,
            stdio: ["ignore", "pipe", "ignore"],
          });
      if (bytes.length > PUBLIC_SCAN_LIMITS.maxFileBytes) {
        addFinding(path, 0, "file-size-limit", path);
        continue;
      }
      totalBytes += bytes.length;
      if (totalBytes > PUBLIC_SCAN_LIMITS.maxTotalBytes) {
        addFinding(path, 0, "total-size-limit", path);
        break;
      }
      if (bytes.includes(0)) {
        continue;
      }
      let text;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        continue;
      }
      const lines = text.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const lineText = lines[index].endsWith("\r")
          ? lines[index].slice(0, -1)
          : lines[index];
        if (Buffer.byteLength(lineText, "utf8") > PUBLIC_SCAN_LIMITS.maxLineBytes) {
          addFinding(path, index + 1, "line-size-limit", lineText);
          continue;
        }
        for (const rule of contentRulesForLine(path, lineText, privateTerms)) {
          addFinding(path, index + 1, rule, lineText);
        }
      }
      if (limitReached) break;
    }

    if (limitReached) {
      return {
        exitCode: 2,
        findings: [],
        output: "finding-count-limit",
      };
    }

    allFindings.sort(
      (left, right) =>
        left.path.localeCompare(right.path, "en") ||
        left.line - right.line ||
        left.rule.localeCompare(right.rule, "en"),
    );
    const allowlistByKey = new Map(allowlist.map((entry) => [entry.key, entry]));
    const usedAllowlistKeys = new Set();
    const findings = allFindings.filter((finding) => {
      const key = findingKey(finding);
      if (!allowlistByKey.has(key)) return true;
      usedAllowlistKeys.add(key);
      return false;
    });
    if (allowlist.some((entry) => !usedAllowlistKeys.has(entry.key))) {
      return {
        exitCode: 2,
        findings: [],
        output: "allowlist-stale-entry",
      };
    }
    return {
      exitCode: findings.length === 0 ? 0 : 1,
      findings,
      output: renderFindings(findings),
    };
  } catch {
    return {
      exitCode: 2,
      findings: [],
      output: "public-scan-operational-error",
    };
  }
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!["--repo", "--allowlist", "--private-terms"].includes(argument)) {
      throw new Error("argument-invalid");
    }
    const value = argv[index + 1];
    if (!value) throw new Error("argument-missing");
    index += 1;
    if (argument === "--repo") options.repository = value;
    if (argument === "--allowlist") options.allowlistPath = value;
    if (argument === "--private-terms") options.privateTermsPath = value;
  }
  return options;
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch {
    console.error("public-scan-arguments-invalid");
    process.exitCode = 2;
    return;
  }
  const result = await scanPublicRepository(options);
  if (result.output) {
    console.log(result.output);
  }
  process.exitCode = result.exitCode;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
