#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, relative, join, sep } from "node:path";

const UI_APIS = [
  "setText",
  "setName",
  "setDesc",
  "setPlaceholder",
  "setButtonText",
];
const ALL_APIS = [...UI_APIS, "Notice", "addCommand name"];
const DOM_TAGS = new Set([
  "a",
  "article",
  "button",
  "div",
  "footer",
  "header",
  "input",
  "label",
  "li",
  "main",
  "option",
  "p",
  "section",
  "select",
  "span",
  "ul",
]);

function usage(message) {
  process.stderr.write(`i18n audit: ${message}\n`);
}

function parseArguments(argv) {
  let root = process.cwd();

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--root" && argv[index + 1]) {
      root = resolve(argv[index + 1]);
      index += 1;
      continue;
    }

    usage(`unknown argument ${argv[index]}`);
    process.exit(2);
  }

  return root;
}

function collectTypeScriptFiles(directory) {
  if (!existsSync(directory)) {
    return [];
  }

  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const target = join(directory, entry.name);
      if (entry.isDirectory()) {
        return collectTypeScriptFiles(target);
      }

      return entry.isFile() && entry.name.endsWith(".ts") ? [target] : [];
    });
}

function isIgnoredPath(root, file) {
  const normalized = relative(root, file).split(sep).join("/");
  return (
    normalized.startsWith("src/i18n/") ||
    normalized.includes("/test_files/") ||
    normalized.endsWith(".test.ts") ||
    normalized.endsWith(".spec.ts")
  );
}

function lineAt(source, index) {
  return source.slice(0, index).split("\n").length;
}

function readLiteral(source, start) {
  const quote = source[start];
  if (quote !== "\"" && quote !== "'" && quote !== "`") {
    return undefined;
  }

  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === quote) {
      return {
        value: source.slice(start + 1, index),
        end: index + 1,
      };
    }
  }

  return undefined;
}

function skipWhitespace(source, index) {
  while (index < source.length && /\s/.test(source[index])) {
    index += 1;
  }
  return index;
}

function isNonUserFacingLiteral(value) {
  return (
    value.length === 0 ||
    value.startsWith("http://") ||
    value.startsWith("https://") ||
    value.startsWith("mailto:") ||
    /^(application|audio|font|image|text|video)\//.test(value) ||
    value.startsWith("icon-") ||
    DOM_TAGS.has(value)
  );
}

function formatLiteral(value) {
  return JSON.stringify(value);
}

function findingFor(root, file, source, index, api, literal) {
  const path = relative(root, file).split(sep).join("/");
  const line = lineAt(source, index);
  return {
    path,
    line,
    api,
    literal,
    identity: `${path}:${line}:${api}:${literal}`,
  };
}

function scanCallLiterals(root, file, source) {
  const findings = [];
  const apiPattern = new RegExp(`\\b(${UI_APIS.join("|")})\\s*\\(`, "g");
  let match;

  while ((match = apiPattern.exec(source))) {
    const literalStart = skipWhitespace(source, apiPattern.lastIndex);
    const literal = readLiteral(source, literalStart);
    if (literal && !isNonUserFacingLiteral(literal.value)) {
      findings.push(findingFor(root, file, source, match.index, match[1], literal.value));
    }
  }

  const noticePattern = /\bnew\s+Notice\s*\(/g;
  while ((match = noticePattern.exec(source))) {
    const literalStart = skipWhitespace(source, noticePattern.lastIndex);
    const literal = readLiteral(source, literalStart);
    if (literal && !isNonUserFacingLiteral(literal.value)) {
      findings.push(findingFor(root, file, source, match.index, "Notice", literal.value));
    }
  }

  const commandPattern = /\baddCommand\s*\(\s*\{/g;
  while ((match = commandPattern.exec(source))) {
    const commandEnd = source.indexOf("});", commandPattern.lastIndex);
    const commandSource = source.slice(commandPattern.lastIndex, commandEnd < 0 ? source.length : commandEnd);
    const nameMatch = /\bname\s*:\s*/.exec(commandSource);
    if (!nameMatch) {
      continue;
    }
    const literalStart = skipWhitespace(
      commandSource,
      nameMatch.index + nameMatch[0].length,
    );
    const literal = readLiteral(commandSource, literalStart);
    if (literal && !isNonUserFacingLiteral(literal.value)) {
      const sourceIndex = commandPattern.lastIndex + nameMatch.index;
      findings.push(
        findingFor(root, file, source, sourceIndex, "addCommand name", literal.value),
      );
    }
  }

  return findings;
}

function loadAllowlist(root) {
  const allowlistPath = join(root, "scripts", "i18n-literal-allowlist.json");
  if (!existsSync(allowlistPath)) {
    return { entries: [], errors: [] };
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(allowlistPath, "utf8"));
  } catch (error) {
    return { entries: [], errors: [`invalid allowlist JSON: ${error.message}`] };
  }

  if (!Array.isArray(parsed)) {
    return { entries: [], errors: ["allowlist must be an array"] };
  }

  const errors = [];
  const entries = [];
  const patterns = new Set();
  const patternFormat = new RegExp(
    `^[^:*?[\\]\\\\]+:\\d+:(${ALL_APIS.map((api) => api.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")}):.+$`,
  );

  for (const [index, entry] of parsed.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`invalid allowlist entry at index ${index}`);
      continue;
    }

    const { pattern, reason } = entry;
    if (typeof pattern !== "string" || !patternFormat.test(pattern)) {
      errors.push(`invalid allowlist pattern at index ${index}`);
      continue;
    }
    if (typeof reason !== "string" || reason.trim().length === 0) {
      errors.push(`missing allowlist reason at index ${index}`);
      continue;
    }
    if (patterns.has(pattern)) {
      errors.push(`duplicate allowlist pattern: ${pattern}`);
      continue;
    }

    patterns.add(pattern);
    entries.push({ pattern, reason });
  }

  return { entries, errors };
}

function main() {
  const root = parseArguments(process.argv.slice(2));
  const files = [
    ...collectTypeScriptFiles(join(root, "src")),
    ...(existsSync(join(root, "main.ts")) ? [join(root, "main.ts")] : []),
  ].filter((file) => !isIgnoredPath(root, file));
  const findings = files
    .flatMap((file) => scanCallLiterals(root, file, readFileSync(file, "utf8")))
    .sort((left, right) => left.identity.localeCompare(right.identity));
  const { entries, errors } = loadAllowlist(root);
  const findingIds = new Set(findings.map((finding) => finding.identity));

  for (const entry of entries) {
    if (!findingIds.has(entry.pattern)) {
      errors.push(`stale allowlist entry: ${entry.pattern}`);
    }
  }

  if (errors.length > 0) {
    for (const error of errors) {
      usage(error);
    }
    process.exitCode = 2;
    return;
  }

  const allowed = new Set(entries.map((entry) => entry.pattern));
  const violations = findings.filter((finding) => !allowed.has(finding.identity));
  for (const violation of violations) {
    process.stdout.write(
      `${violation.path}:${violation.line} ${violation.api} ${formatLiteral(violation.literal)}\n`,
    );
  }

  process.exitCode = violations.length > 0 ? 1 : 0;
}

main();
