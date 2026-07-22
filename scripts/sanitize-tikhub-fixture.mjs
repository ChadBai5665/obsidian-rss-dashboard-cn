const REMOVED_KEYS = new Set([
  "apikey",
  "accesstoken",
  "authorization",
  "bearertoken",
  "cacheurl",
  "cursor",
  "requestid",
  "support",
  "supportmetadata",
]);

const ISO_FIXTURE_TIME = "2024-01-01T00:00:00.000Z";
const TWITTER_FIXTURE_TIME = "Mon Jan 01 00:00:00 +0000 2024";

/**
 * Clone a TikHub response while removing provider metadata and personal capture inputs.
 * The input is never mutated and accessor properties are never invoked.
 */
export function sanitizeTikHubFixture(value, aliases = {}) {
  const replacements = [
    [aliases.handle, "fixture_account"],
    [aliases.query, "fixture_topic"],
  ].filter(([input]) => typeof input === "string" && input.length > 0);
  const seen = new WeakSet();

  function sanitize(current, key = "") {
    if (typeof current === "string") {
      if (isVolatileTimestampKey(key)) return fixtureTimestamp(key);
      return replaceAliases(current, replacements);
    }
    if (
      current === null ||
      typeof current === "number" ||
      typeof current === "boolean"
    ) {
      return current;
    }
    if (typeof current !== "object") return undefined;
    if (seen.has(current)) throw new Error("TikHub fixture contains a cycle.");
    seen.add(current);

    if (Array.isArray(current)) {
      const sanitized = [];
      for (let index = 0; index < current.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        if (!descriptor || !("value" in descriptor)) continue;
        if (isCursorObject(descriptor.value)) continue;
        const item = sanitize(descriptor.value);
        if (item !== undefined) sanitized.push(item);
      }
      seen.delete(current);
      return sanitized;
    }

    const sanitized = Object.create(null);
    for (const property of Object.getOwnPropertyNames(current)) {
      if (isRemovedKey(property) || isUnsafeProperty(property)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(current, property);
      if (!descriptor || !("value" in descriptor)) continue;
      const child = sanitize(descriptor.value, property);
      if (child !== undefined) sanitized[property] = child;
    }
    seen.delete(current);
    return sanitized;
  }

  return sanitize(value);
}

function isRemovedKey(key) {
  const normalized = key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return (
    REMOVED_KEYS.has(normalized) ||
    normalized.includes("cursor") ||
    normalized.endsWith("requestid") ||
    normalized.endsWith("cacheurl") ||
    normalized.startsWith("support") ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("accesstoken") ||
    normalized.endsWith("bearertoken")
  );
}

function isUnsafeProperty(key) {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}

function isVolatileTimestampKey(key) {
  const normalized = key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return (
    normalized === "createdat" ||
    normalized === "updatedat" ||
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

function replaceAliases(value, replacements) {
  let result = value;
  for (const [input, alias] of replacements) {
    result = result.replace(new RegExp(escapeRegExp(input), "gi"), alias);
    result = result.replace(
      new RegExp(escapeRegExp(encodeURIComponent(input)), "gi"),
      encodeURIComponent(alias),
    );
  }
  return result;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isCursorObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entryId = ownString(value, "entryId");
  const type = ownString(value, "type");
  const content = ownObject(value, "content");
  const entryType = ownString(content, "entryType");
  const cursorType = ownString(content, "cursorType");
  return (
    entryId?.toLowerCase().startsWith("cursor-") === true ||
    type?.toLowerCase().includes("cursor") === true ||
    entryType?.toLowerCase().includes("cursor") === true ||
    cursorType !== undefined
  );
}

function ownObject(value, key) {
  const property = ownValue(value, key);
  return property && typeof property === "object" && !Array.isArray(property)
    ? property
    : undefined;
}

function ownString(value, key) {
  const property = ownValue(value, key);
  return typeof property === "string" ? property : undefined;
}

function ownValue(value, key) {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
