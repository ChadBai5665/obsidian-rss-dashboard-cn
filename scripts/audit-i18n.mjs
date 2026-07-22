#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const UI_APIS = [
  "setText",
  "setName",
  "setDesc",
  "setPlaceholder",
  "setButtonText",
];
const ALL_APIS = [...UI_APIS, "Notice", "addCommand name"];
const DOM_TAGS = new Set([
  "a", "article", "button", "div", "footer", "header", "input", "label",
  "li", "main", "option", "p", "section", "select", "span", "ul",
]);
const MIME_PREFIXES = ["application/", "audio/", "font/", "image/", "text/", "video/"];
const OPENERS = new Map([["(", ")"], ["{", "}"], ["[", "]"]]);
const CLOSERS = new Set([")", "}", "]"]);

function compareCodePoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

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
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => compareCodePoints(left.name, right.name))
    .flatMap((entry) => {
      const target = join(directory, entry.name);
      if (entry.isDirectory()) return collectTypeScriptFiles(target);
      return entry.isFile() && entry.name.endsWith(".ts") ? [target] : [];
    });
}

function isIgnoredPath(root, file) {
  const normalized = relative(root, file).split(sep).join("/");
  return normalized.startsWith("src/i18n/") || normalized.endsWith(".test.ts") || normalized.endsWith(".spec.ts");
}

function isWhitespace(character) {
  return character === " " || character === "\t" || character === "\r" || character === "\n" || character === "\f";
}

function isIdentifierStart(character) {
  return Boolean(character) && ((character >= "A" && character <= "Z") || (character >= "a" && character <= "z") || character === "_" || character === "$");
}

function isIdentifierPart(character) {
  return isIdentifierStart(character) || (character >= "0" && character <= "9");
}

function isDigit(character) {
  return Boolean(character) && character >= "0" && character <= "9";
}

function canStartRegularExpression(previousToken) {
  if (!previousToken) return true;
  if (previousToken.type === "literal" || previousToken.type === "number") return false;
  if (previousToken.type === "identifier") {
    return new Set([
      "return", "case", "throw", "typeof", "void", "delete", "new",
      "in", "of", "yield", "await", "else", "do", "instanceof",
    ]).has(previousToken.value);
  }
  return ![")", "]", "}", ".", "?."].includes(previousToken.value);
}

/**
 * A deliberately small TypeScript lexer. It recognizes only the token classes
 * the audit needs, but consumes comments and literal bodies as opaque values so
 * API-shaped text cannot escape from comments or strings into the code stream.
 */
function tokenize(source) {
  const tokens = [];
  let index = 0;
  let line = 1;

  const advance = () => {
    if (source[index] === "\n") line += 1;
    index += 1;
  };
  const skipLineComment = () => {
    while (index < source.length && source[index] !== "\n") advance();
  };
  const skipBlockComment = () => {
    advance();
    advance();
    while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) advance();
    if (index < source.length) {
      advance();
      advance();
    }
  };
  const skipQuoted = (quote) => {
    advance();
    while (index < source.length) {
      if (source[index] === "\\") {
        advance();
        if (index < source.length) advance();
        continue;
      }
      if (source[index] === quote) {
        advance();
        return;
      }
      advance();
    }
  };
  const skipTemplateExpression = () => {
    let depth = 1;
    while (index < source.length && depth > 0) {
      if (source[index] === "/" && source[index + 1] === "/") {
        advance();
        advance();
        skipLineComment();
      } else if (source[index] === "/" && source[index + 1] === "*") {
        skipBlockComment();
      } else if (source[index] === "\"" || source[index] === "'") {
        skipQuoted(source[index]);
      } else if (source[index] === "`") {
        skipTemplate();
      } else if (source[index] === "{") {
        depth += 1;
        advance();
      } else if (source[index] === "}") {
        depth -= 1;
        advance();
      } else {
        advance();
      }
    }
  };
  const skipTemplate = () => {
    advance();
    while (index < source.length) {
      if (source[index] === "\\") {
        advance();
        if (index < source.length) advance();
      } else if (source[index] === "`") {
        advance();
        return;
      } else if (source[index] === "$" && source[index + 1] === "{") {
        advance();
        advance();
        skipTemplateExpression();
      } else {
        advance();
      }
    }
  };
  const readLiteral = (quote) => {
    const start = index;
    const tokenLine = line;
    advance();
    while (index < source.length) {
      if (source[index] === "\\") {
        advance();
        if (index < source.length) advance();
      } else if (source[index] === quote) {
        const value = source.slice(start + 1, index);
        advance();
        return { type: "literal", value, line: tokenLine, index: start };
      } else if (quote === "`" && source[index] === "$" && source[index + 1] === "{") {
        advance();
        advance();
        skipTemplateExpression();
      } else {
        advance();
      }
    }
    return { type: "literal", value: source.slice(start + 1), line: tokenLine, index: start };
  };
  const skipRegularExpression = () => {
    advance();
    let inCharacterClass = false;
    while (index < source.length) {
      const character = source[index];
      if (character === "\n" || character === "\r") return;
      if (character === "\\") {
        advance();
        if (index < source.length && source[index] !== "\n" && source[index] !== "\r") advance();
      } else if (inCharacterClass && character === "]") {
        inCharacterClass = false;
        advance();
      } else if (!inCharacterClass && character === "[") {
        inCharacterClass = true;
        advance();
      } else if (!inCharacterClass && character === "/") {
        advance();
        while (isIdentifierPart(source[index])) advance();
        return;
      } else {
        advance();
      }
    }
  };

  while (index < source.length) {
    const character = source[index];
    if (isWhitespace(character)) {
      advance();
    } else if (character === "/" && source[index + 1] === "/") {
      advance();
      advance();
      skipLineComment();
    } else if (character === "/" && source[index + 1] === "*") {
      skipBlockComment();
    } else if (character === "/" && canStartRegularExpression(tokens.at(-1))) {
      skipRegularExpression();
    } else if (character === "\"" || character === "'" || character === "`") {
      tokens.push(readLiteral(character));
    } else if (isIdentifierStart(character)) {
      const start = index;
      const tokenLine = line;
      advance();
      while (isIdentifierPart(source[index])) advance();
      tokens.push({ type: "identifier", value: source.slice(start, index), line: tokenLine, index: start });
    } else if (isDigit(character)) {
      const start = index;
      const tokenLine = line;
      advance();
      while (isDigit(source[index]) || source[index] === "." || source[index] === "_") advance();
      tokens.push({ type: "number", value: source.slice(start, index), line: tokenLine, index: start });
    } else {
      const tokenLine = line;
      const start = index;
      if (character === "?" && source[index + 1] === ".") {
        advance();
        advance();
        tokens.push({ type: "punct", value: "?.", line: tokenLine, index: start });
      } else {
        advance();
        tokens.push({ type: "punct", value: character, line: tokenLine, index: start });
      }
    }
  }
  return tokens;
}

function findMatching(tokens, start) {
  const expected = OPENERS.get(tokens[start]?.value);
  if (!expected) return -1;
  const stack = [expected];
  for (let index = start + 1; index < tokens.length; index += 1) {
    const token = tokens[index].value;
    if (OPENERS.has(token)) stack.push(OPENERS.get(token));
    else if (CLOSERS.has(token)) {
      if (token !== stack.at(-1)) return -1;
      stack.pop();
      if (stack.length === 0) return index;
    }
  }
  return -1;
}

function findCallOpen(tokens, identifierIndex) {
  let index = identifierIndex + 1;
  if (tokens[index]?.value === "?.") index += 1;
  return tokens[index]?.value === "(" ? index : -1;
}

function firstArgumentRange(tokens, callOpen, callClose) {
  let start = callOpen + 1;
  let end = callClose - 1;
  const stack = [];
  for (let index = start; index <= end; index += 1) {
    const value = tokens[index].value;
    if (OPENERS.has(value)) stack.push(OPENERS.get(value));
    else if (CLOSERS.has(value)) stack.pop();
    else if (value === "," && stack.length === 0) {
      end = index - 1;
      break;
    }
  }
  return [start, end];
}

function unwrapParentheses(tokens, start, end) {
  while (tokens[start]?.value === "(") {
    const close = findMatching(tokens, start);
    if (close !== end) break;
    start += 1;
    end -= 1;
  }
  return [start, end];
}

function directLiteral(tokens, start, end) {
  const primary = directLiteralPrimary(tokens, start, end);
  if (!primary) return undefined;
  let index = primary.next;
  while (index <= end) {
    if (tokens[index]?.type !== "identifier" || !["as", "satisfies"].includes(tokens[index].value)) {
      return undefined;
    }
    const typeEnd = consumeTypeWrapper(tokens, index + 1, end);
    if (typeEnd < index + 1) return undefined;
    index = typeEnd + 1;
  }
  return primary.literal;
}

function directLiteralPrimary(tokens, start, end) {
  if (tokens[start]?.type === "literal") {
    return { literal: tokens[start], next: start + 1 };
  }
  if (tokens[start]?.value !== "(") return undefined;
  const close = findMatching(tokens, start);
  if (close < 0 || close > end) return undefined;
  const literal = directLiteral(tokens, start + 1, close - 1);
  return literal ? { literal, next: close + 1 } : undefined;
}

function consumeTypeWrapper(tokens, start, end) {
  let index = start;
  let sawTypeToken = false;
  const expectedClosers = [];
  while (index <= end) {
    const token = tokens[index];
    if (expectedClosers.length === 0 && token.type === "identifier" && ["as", "satisfies"].includes(token.value)) {
      break;
    }
    if (token.type === "identifier" || token.type === "literal" || token.value === ".") {
      sawTypeToken = true;
    } else if (token.value === "<") {
      expectedClosers.push(">");
    } else if (token.value === "[") {
      expectedClosers.push("]");
    } else if (token.value === ",") {
      if (expectedClosers.length === 0) return -1;
    } else if (token.value === expectedClosers.at(-1)) {
      expectedClosers.pop();
    } else {
      return -1;
    }
    index += 1;
  }
  return sawTypeToken && expectedClosers.length === 0 ? index - 1 : -1;
}

function isNonUserFacingLiteral(value) {
  return value.length === 0 || value.startsWith("http://") || value.startsWith("https://") || value.startsWith("mailto:") || value.startsWith("icon-") || DOM_TAGS.has(value) || MIME_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function findingFor(root, file, token, api) {
  const path = relative(root, file).split(sep).join("/");
  return {
    path,
    line: token.line,
    api,
    literal: token.value,
    identity: `${path}:${token.line}:${api}:${token.value}`,
  };
}

function scanAddCommand(root, file, tokens, identifierIndex) {
  const callOpen = findCallOpen(tokens, identifierIndex);
  const callClose = callOpen < 0 ? -1 : findMatching(tokens, callOpen);
  if (callClose < 0) return [];
  let [start, end] = firstArgumentRange(tokens, callOpen, callClose);
  [start, end] = unwrapParentheses(tokens, start, end);
  if (tokens[start]?.value !== "{") return [];
  const objectClose = findMatching(tokens, start);
  if (objectClose < 0 || objectClose !== end) return [];

  const findings = [];
  const stack = [];
  for (let index = start + 1; index < objectClose; index += 1) {
    const value = tokens[index].value;
    if (OPENERS.has(value)) {
      stack.push(OPENERS.get(value));
      continue;
    }
    if (CLOSERS.has(value)) {
      stack.pop();
      continue;
    }
    if (stack.length !== 0 || (tokens[index].type !== "identifier" && tokens[index].type !== "literal") || tokens[index].value !== "name" || tokens[index + 1]?.value !== ":") continue;

    let propertyEnd = objectClose - 1;
    const propertyStack = [];
    for (let cursor = index + 2; cursor < objectClose; cursor += 1) {
      const cursorValue = tokens[cursor].value;
      if (OPENERS.has(cursorValue)) propertyStack.push(OPENERS.get(cursorValue));
      else if (CLOSERS.has(cursorValue)) propertyStack.pop();
      else if (cursorValue === "," && propertyStack.length === 0) {
        propertyEnd = cursor - 1;
        break;
      }
    }
    const literal = directLiteral(tokens, index + 2, propertyEnd);
    if (literal && !isNonUserFacingLiteral(literal.value)) findings.push(findingFor(root, file, literal, "addCommand name"));
  }
  return findings;
}

function scanCallLiterals(root, file, source) {
  const tokens = tokenize(source);
  const findings = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== "identifier") continue;

    if (UI_APIS.includes(token.value) || token.value === "Notice") {
      const callOpen = findCallOpen(tokens, index);
      const callClose = callOpen < 0 ? -1 : findMatching(tokens, callOpen);
      if (callClose >= 0) {
        const [start, end] = firstArgumentRange(tokens, callOpen, callClose);
        const literal = directLiteral(tokens, start, end);
        if (literal && !isNonUserFacingLiteral(literal.value)) {
          findings.push(findingFor(root, file, literal, token.value));
        }
      }
    }
    if (token.value === "addCommand") findings.push(...scanAddCommand(root, file, tokens, index));
  }
  return findings;
}

function parseAllowlistPattern(pattern) {
  const parts = pattern.split(":");
  if (parts.length < 4) return undefined;
  const [path, line, api, ...literalParts] = parts;
  const literal = literalParts.join(":");
  if (!path || !line || !api || !literal || [path, line, api].some((part) => part.includes("*") || part.includes("?") || part.includes("[") || part.includes("]"))) return undefined;
  if (![...line].every((character) => character >= "0" && character <= "9") || Number(line) < 1 || !ALL_APIS.includes(api)) return undefined;
  return { path, line, api, literal };
}

function loadAllowlist(root) {
  const allowlistPath = join(root, "scripts", "i18n-literal-allowlist.json");
  if (!existsSync(allowlistPath)) return { entries: [], errors: [] };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(allowlistPath, "utf8"));
  } catch (error) {
    return { entries: [], errors: [`invalid allowlist JSON: ${error.message}`] };
  }
  if (!Array.isArray(parsed)) return { entries: [], errors: ["allowlist must be an array"] };

  const errors = [];
  const entries = [];
  const patterns = new Set();
  for (const [index, entry] of parsed.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`invalid allowlist entry at index ${index}`);
      continue;
    }
    const { pattern, reason } = entry;
    if (typeof pattern !== "string" || !parseAllowlistPattern(pattern)) {
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
  const files = [...collectTypeScriptFiles(join(root, "src")), ...(existsSync(join(root, "main.ts")) ? [join(root, "main.ts")] : [])]
    .filter((file) => !isIgnoredPath(root, file));
  const findings = files
    .flatMap((file) => scanCallLiterals(root, file, readFileSync(file, "utf8")))
    .sort((left, right) => compareCodePoints(left.identity, right.identity));
  const { entries, errors } = loadAllowlist(root);
  const findingIds = new Set(findings.map((finding) => finding.identity));
  for (const entry of entries) {
    if (!findingIds.has(entry.pattern)) errors.push(`stale allowlist entry: ${entry.pattern}`);
  }
  if (errors.length > 0) {
    for (const error of errors) usage(error);
    process.exitCode = 2;
    return;
  }
  const allowed = new Set(entries.map((entry) => entry.pattern));
  for (const violation of findings.filter((finding) => !allowed.has(finding.identity))) {
    process.stdout.write(`${violation.path}:${violation.line} ${violation.api} ${JSON.stringify(violation.literal)}\n`);
  }
  process.exitCode = findings.some((finding) => !allowed.has(finding.identity)) ? 1 : 0;
}

main();
