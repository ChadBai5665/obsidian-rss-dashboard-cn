const ISO_FIXTURE_TIME = "2024-01-01T00:00:00.000Z";
const TWITTER_FIXTURE_TIME = "Mon Jan 01 00:00:00 +0000 2024";
const MAX_DEPTH = 64;
const MAX_NODES = 100_000;
const MAX_ARRAY_ENTRIES = 100_000;
const MAX_OBJECT_PROPERTIES = 20_000;
const SENSITIVE_TOKENS = new Set([
  "auth",
  "authentication",
  "authorization",
  "bearer",
  "credential",
  "credentials",
  "passwd",
  "password",
  "pwd",
  "secret",
  "token",
]);

/**
 * Clone a JSON-shaped TikHub response while removing provider metadata,
 * credentials, and personal capture inputs. Unsafe shapes fail closed.
 */
export function sanitizeTikHubFixture(value, aliases = {}) {
  const replacements = buildReplacements(aliases);
  const propertyAliases = buildPropertyAliases(aliases);
  const seen = new WeakSet();
  const state = { nodes: 0 };

  function sanitize(current, key = "", depth = 0) {
    if (depth > MAX_DEPTH) traversalLimit();
    if (
      isVolatileTimestampKey(key) &&
      (typeof current === "string" ||
        typeof current === "number" ||
        typeof current === "bigint")
    ) {
      return fixtureTimestamp(key);
    }
    if (typeof current === "string") {
      if (isSensitiveFixtureText(current)) return "[redacted]";
      const replaced = replaceAliases(current, replacements);
      return isSensitiveFixtureText(replaced) ? "[redacted]" : replaced;
    }
    if (
      current === null ||
      typeof current === "number" ||
      typeof current === "boolean"
    ) {
      if (typeof current === "number" && !Number.isFinite(current)) unsafeShape();
      return current;
    }
    if (typeof current !== "object") unsafeShape();

    state.nodes += 1;
    if (state.nodes > MAX_NODES || seen.has(current)) traversalLimit();
    seen.add(current);

    if (Array.isArray(current)) {
      requirePrototype(current, Array.prototype);
      if (current.length > MAX_ARRAY_ENTRIES) traversalLimit();
      const sanitized = [];
      for (let index = 0; index < current.length; index += 1) {
        const descriptor = safeDescriptor(current, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          unsafeShape();
        }
        if (isCursorObject(descriptor.value)) continue;
        const item = sanitize(descriptor.value, "", depth + 1);
        if (item !== undefined) sanitized.push(item);
      }
      return sanitized;
    }

    requirePrototype(current, Object.prototype, null);
    const properties = safeOwnPropertyNames(current);
    if (properties.length > MAX_OBJECT_PROPERTIES) traversalLimit();
    const sanitized = Object.create(null);
    for (const property of properties) {
      const descriptor = safeDescriptor(current, property);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        unsafeShape();
      }
      if (
        isUnsafeProperty(property) ||
        isProviderMetadataKey(property) ||
        isSensitiveCredentialKey(property)
      ) {
        continue;
      }
      const sanitizedProperty = replacePropertyAlias(property, propertyAliases);
      if (
        isUnsafeProperty(sanitizedProperty) ||
        isProviderMetadataKey(sanitizedProperty) ||
        isSensitiveCredentialKey(sanitizedProperty)
      ) {
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(sanitized, sanitizedProperty)) {
        unsafeShape();
      }
      const child = sanitize(descriptor.value, sanitizedProperty, depth + 1);
      if (child !== undefined) sanitized[sanitizedProperty] = child;
    }
    return sanitized;
  }

  return sanitize(value);
}

/**
 * Rejects raw capture shapes that could otherwise be silently removed by the
 * sanitizer. It reads descriptors only, so a rejected value is never logged,
 * serialized, or exposed through an accessor.
 */
export function assertTikHubRawFixtureSafe(value) {
  const seen = new WeakSet();
  const stack = [{ value, depth: 0 }];
  let nodes = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || current.depth > MAX_DEPTH) traversalLimit();
    const candidate = current.value;
    if (
      candidate === null ||
      typeof candidate === "string" ||
      typeof candidate === "number" ||
      typeof candidate === "boolean"
    ) {
      if (typeof candidate === "number" && !Number.isFinite(candidate)) unsafeShape();
      continue;
    }
    if (typeof candidate !== "object") unsafeShape();

    nodes += 1;
    if (nodes > MAX_NODES || seen.has(candidate)) traversalLimit();
    seen.add(candidate);

    if (Array.isArray(candidate)) {
      requirePrototype(candidate, Array.prototype);
      const length = safeArrayLength(candidate);
      if (length > MAX_ARRAY_ENTRIES) traversalLimit();
      for (let index = 0; index < length; index += 1) {
        const descriptor = safeDescriptor(candidate, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          unsafeShape();
        }
        stack.push({ value: descriptor.value, depth: current.depth + 1 });
      }
      assertNoUnexpectedArrayProperties(candidate, length);
      continue;
    }

    requirePrototype(candidate, Object.prototype, null);
    const properties = safeOwnPropertyNames(candidate);
    if (properties.length > MAX_OBJECT_PROPERTIES) traversalLimit();
    for (const property of properties) {
      if (isUnsafeProperty(property)) unsafeShape();
      if (isSensitiveCredentialKey(property) || isRawCapturePayloadKey(property)) {
        rawCaptureProhibited();
      }
      const descriptor = safeDescriptor(candidate, property);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        unsafeShape();
      }
      stack.push({ value: descriptor.value, depth: current.depth + 1 });
    }
  }
}

/** Ensures the write candidate is already canonical and contains no private input. */
export function assertTikHubFixtureSanitized(value, aliases = {}) {
  const replacements = buildReplacements(aliases);
  const canonical = sanitizeTikHubFixture(value, aliases);
  const serialized = safeSerialize(value);
  const canonicalSerialized = safeSerialize(canonical);
  const privatePatterns = replacements.map(({ pattern }) => pattern);
  const apiKey = typeof aliases.apiKey === "string" ? aliases.apiKey : "";

  if (
    serialized !== canonicalSerialized ||
    privatePatterns.some((pattern) => pattern.test(serialized)) ||
    (apiKey.length > 0 && serialized.includes(apiKey)) ||
    /\bBearer\b/i.test(serialized) ||
    /TIKHUB_API_KEY/i.test(serialized)
  ) {
    throw new Error("TikHub fixture sanitization verification failed.");
  }
}

export function isSensitiveCredentialKey(key) {
  const tokens = keyTokens(key);
  return (
    tokens.some((token) => SENSITIVE_TOKENS.has(token)) ||
    tokens.some((token) =>
      ["apikey", "accesskey", "privatekey", "secretkey"].includes(token),
    ) ||
    hasTokenPair(tokens, "api", "key") ||
    hasTokenPair(tokens, "access", "key") ||
    hasTokenPair(tokens, "private", "key") ||
    hasTokenPair(tokens, "secret", "key")
  );
}

function hasTokenPair(tokens, first, second) {
  return tokens.some((token, index) => token === first && tokens[index + 1] === second);
}

function isSensitiveFixtureText(value) {
  return (
    isProviderMetadataKey(value) ||
    isSensitiveCredentialKey(value) ||
    /\bBearer\b/i.test(value) ||
    /TIKHUB_API_KEY/i.test(value)
  );
}

function isProviderMetadataKey(key) {
  const tokens = keyTokens(key);
  const compact = tokens.join("");
  return (
    tokens.includes("cursor") ||
    tokens.includes("support") ||
    isRawCapturePayloadKey(key) ||
    compact.endsWith("requestid") ||
    compact.endsWith("cacheurl")
  );
}

function isRawCapturePayloadKey(key) {
  const tokens = keyTokens(key);
  return (
    hasTokenPair(tokens, "raw", "response") ||
    hasTokenPair(tokens, "raw", "payload")
  );
}

function keyTokens(key) {
  return key
    .normalize("NFKC")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function buildReplacements(aliases) {
  const replacements = [];
  for (const [input, alias] of [
    [aliases.handle, "fixture_account"],
    [aliases.query, "fixture_topic"],
  ]) {
    if (typeof input !== "string" || input.length === 0) continue;
    const plusEncoded = new URLSearchParams({ value: input })
      .toString()
      .slice("value=".length);
    const variants = new Set([input, encodeURIComponent(input), plusEncoded]);
    for (const variant of [...variants].sort((left, right) => right.length - left.length)) {
      replacements.push({
        pattern: new RegExp(escapeRegExp(variant), "gi"),
        replacement: variant === input ? alias : encodeURIComponent(alias),
      });
    }
  }
  return replacements;
}

function buildPropertyAliases(aliases) {
  const propertyAliases = [];
  for (const [input, replacement] of [
    [aliases.handle, "fixture_account"],
    [aliases.query, "fixture_topic"],
  ]) {
    if (typeof input !== "string" || input.length === 0) continue;
    propertyAliases.push({
      normalized: normalizePropertyAlias(input),
      replacement,
    });
  }
  return propertyAliases;
}

function replacePropertyAlias(property, propertyAliases) {
  const normalized = normalizePropertyAlias(property);
  const alias = propertyAliases.find((candidate) => candidate.normalized === normalized);
  return alias?.replacement ?? property;
}

function normalizePropertyAlias(value) {
  const plusDecoded = value.replace(/\+/g, " ");
  let decoded = plusDecoded;
  try {
    decoded = decodeURIComponent(plusDecoded);
  } catch {
    // Invalid percent sequences remain literal, so malformed keys cannot throw.
  }
  return decoded.normalize("NFKC").toLowerCase();
}

function replaceAliases(value, replacements) {
  let result = value;
  for (const { pattern, replacement } of replacements) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, replacement);
  }
  return result;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isVolatileTimestampKey(key) {
  const normalized = key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return (
    normalized === "createdat" ||
    normalized === "updatedat" ||
    normalized === "generatedat" ||
    normalized === "timestamp" ||
    normalized === "requesttime" ||
    normalized === "responsetime"
  );
}

function fixtureTimestamp(key) {
  return key.toLowerCase() === "created_at"
    ? TWITTER_FIXTURE_TIME
    : ISO_FIXTURE_TIME;
}

function isUnsafeProperty(key) {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}

function isCursorObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  requirePrototype(value, Object.prototype, null);
  const entryId = safeOwnString(value, "entryId");
  const type = safeOwnString(value, "type");
  const content = safeOwnObject(value, "content");
  const entryType = safeOwnString(content, "entryType");
  const cursorType = safeOwnString(content, "cursorType");
  return (
    entryId?.toLowerCase().startsWith("cursor-") === true ||
    type?.toLowerCase().includes("cursor") === true ||
    entryType?.toLowerCase().includes("cursor") === true ||
    cursorType !== undefined
  );
}

function safeOwnObject(value, key) {
  const property = safeOwnValue(value, key);
  return property && typeof property === "object" && !Array.isArray(property)
    ? property
    : undefined;
}

function safeOwnString(value, key) {
  const property = safeOwnValue(value, key);
  return typeof property === "string" ? property : undefined;
}

function safeOwnValue(value, key) {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    return undefined;
  }
  const descriptor = safeDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!("value" in descriptor)) unsafeShape();
  return descriptor.value;
}

function safeDescriptor(value, key) {
  try {
    return Object.getOwnPropertyDescriptor(value, key);
  } catch {
    unsafeShape();
  }
}

function safeOwnPropertyNames(value) {
  try {
    return Object.getOwnPropertyNames(value);
  } catch {
    unsafeShape();
  }
}

function requirePrototype(value, ...allowed) {
  let prototype;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    unsafeShape();
  }
  if (!allowed.includes(prototype)) unsafeShape();
}

function safeArrayLength(value) {
  const descriptor = safeDescriptor(value, "length");
  if (
    !descriptor ||
    !("value" in descriptor) ||
    !Number.isSafeInteger(descriptor.value) ||
    descriptor.value < 0
  ) {
    unsafeShape();
  }
  return descriptor.value;
}

function assertNoUnexpectedArrayProperties(value, length) {
  const properties = safeOwnPropertyNames(value);
  if (properties.length > length + 1) unsafeShape();
  for (const property of properties) {
    if (property === "length") continue;
    if (!/^(?:0|[1-9]\d*)$/.test(property) || Number(property) >= length) {
      unsafeShape();
    }
  }
}

function safeSerialize(value) {
  try {
    return JSON.stringify(value);
  } catch {
    throw new Error("TikHub fixture sanitization verification failed.");
  }
}

function unsafeShape() {
  throw new Error("TikHub fixture contains an unsafe object shape.");
}

function traversalLimit() {
  throw new Error("TikHub fixture exceeds safe traversal limits.");
}

function rawCaptureProhibited() {
  throw new Error("TikHub fixture response contains prohibited raw data.");
}
