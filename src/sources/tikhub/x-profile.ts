import { normalizeXHandle } from "../source-config";

export interface XProfile {
  restId: string;
  handle: string;
  displayName: string;
  avatarUrl?: string;
  description?: string;
  verified: boolean;
}

export type XProfileParseErrorCode = "not-found" | "malformed-profile";

export class XProfileParseError extends Error {
  constructor(readonly code: XProfileParseErrorCode) {
    super(code);
    this.name = "XProfileParseError";
  }
}

const MAX_WALK_DEPTH = 32;
const MAX_WALK_NODES = 25_000;
const MAX_ARRAY_ENTRIES = 100_000;
const MAX_OBJECT_PROPERTIES = 10_000;
const MAX_REST_ID_LENGTH = 128;
const MAX_DISPLAY_NAME_LENGTH = 256;
const MAX_DESCRIPTION_LENGTH = 1_600;
const MAX_AVATAR_URL_LENGTH = 2_048;
const USER_NOT_FOUND_CODES = new Set<unknown>([
  404,
  "UserNotFound",
  "user-not-found",
  "user_not_found",
]);

interface WalkEntry {
  value: unknown;
  depth: number;
}

type CandidateResult =
  | { kind: "none" }
  | { kind: "profile"; profile: XProfile };

/** Projects one untrusted TikHub profile payload into a provider-neutral record. */
export function parseXProfile(payload: unknown): XProfile {
  try {
    const candidates: XProfile[] = [];
    let notFound = false;
    const seen = new WeakSet<object>();
    const stack: WalkEntry[] = [{ value: payload, depth: 0 }];
    let visited = 0;

    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) continue;
      if (current.depth > MAX_WALK_DEPTH) throw malformedProfile();
      const value = current.value;
      if (!isObject(value)) continue;
      if (seen.has(value)) continue;
      seen.add(value);
      visited += 1;
      if (visited > MAX_WALK_NODES) throw malformedProfile();

      const properties = ownDataProperties(value);
      if (isNotFoundRecord(properties)) notFound = true;
      const candidate = profileCandidate(properties);
      if (candidate.kind === "profile") candidates.push(candidate.profile);

      for (let index = properties.length - 1; index >= 0; index -= 1) {
        const child = properties[index]?.value;
        if (isObject(child)) {
          stack.push({ value: child, depth: current.depth + 1 });
        }
      }
    }

    if (candidates.length === 1 && !notFound) return candidates[0];
    if (candidates.length === 0 && notFound) {
      throw new XProfileParseError("not-found");
    }
    throw malformedProfile();
  } catch (error) {
    if (error instanceof XProfileParseError) throw error;
    throw malformedProfile();
  }
}

function profileCandidate(properties: readonly DataProperty[]): CandidateResult {
  const restIdValue = propertyValue(properties, "rest_id");
  const legacyValue = propertyValue(properties, "legacy");
  const coreValue = propertyValue(properties, "core");
  const legacy = isObject(legacyValue) ? ownDataProperties(legacyValue) : undefined;
  const core = isObject(coreValue) ? ownDataProperties(coreValue) : undefined;

  const legacyHandle = legacy && propertyValue(legacy, "screen_name");
  const legacyName = legacy && propertyValue(legacy, "name");
  const currentHandle = core && propertyValue(core, "screen_name");
  const currentName = core && propertyValue(core, "name");
  const hasLegacyPair = legacyHandle !== undefined && legacyName !== undefined;
  const hasCurrentPair = currentHandle !== undefined && currentName !== undefined;
  if (restIdValue === undefined || (!hasLegacyPair && !hasCurrentPair)) {
    return { kind: "none" };
  }
  if (hasLegacyPair && hasCurrentPair) throw malformedProfile();

  const restId = safeText(restIdValue, MAX_REST_ID_LENGTH);
  const handle = normalizeXHandle(hasLegacyPair ? legacyHandle : currentHandle);
  const displayName = safeText(
    hasLegacyPair ? legacyName : currentName,
    MAX_DISPLAY_NAME_LENGTH,
  );
  if (!restId || !handle || !displayName) throw malformedProfile();

  const legacyProperties = legacy ?? [];
  const avatarValue = hasLegacyPair
    ? optionalPropertyValue(legacyProperties, "profile_image_url_https")
    : nestedPropertyValue(properties, "avatar", "image_url");
  const descriptionValue = hasLegacyPair
    ? optionalPropertyValue(legacyProperties, "description")
    : nestedPropertyValue(properties, "profile_bio", "description");
  const avatarUrl = optionalHttpsUrl(avatarValue);
  const description = optionalText(descriptionValue, MAX_DESCRIPTION_LENGTH, true);
  const verified = hasLegacyPair
    ? legacyVerified(properties, legacyProperties)
    : modernVerified(properties);

  return {
    kind: "profile",
    profile: withoutUndefined({
      restId,
      handle,
      displayName,
      avatarUrl,
      description,
      verified,
    }),
  };
}

interface DataProperty {
  key: string;
  value: unknown;
}

function ownDataProperties(value: object): DataProperty[] {
  const prototype: unknown = Object.getPrototypeOf(value);
  if (
    prototype !== Object.prototype &&
    prototype !== null &&
    !(Array.isArray(value) && prototype === Array.prototype)
  ) {
    throw malformedProfile();
  }
  if (Array.isArray(value) && value.length > MAX_ARRAY_ENTRIES) {
    throw malformedProfile();
  }
  if (Object.getOwnPropertySymbols(value).length > 0) throw malformedProfile();

  const names = Object.getOwnPropertyNames(value);
  if (names.length > MAX_OBJECT_PROPERTIES) throw malformedProfile();
  const properties: DataProperty[] = [];
  for (const key of names) {
    if (Array.isArray(value) && key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) throw malformedProfile();
    properties.push({ key, value: descriptor.value });
  }
  return properties;
}

function propertyValue(
  properties: readonly DataProperty[],
  key: string,
): unknown {
  return properties.find((property) => property.key === key)?.value;
}

function hasProperty(
  properties: readonly DataProperty[],
  key: string,
): boolean {
  return properties.some((property) => property.key === key);
}

function optionalPropertyValue(
  properties: readonly DataProperty[],
  key: string,
): unknown {
  return hasProperty(properties, key) ? propertyValue(properties, key) : undefined;
}

function nestedPropertyValue(
  properties: readonly DataProperty[],
  containerKey: string,
  valueKey: string,
): unknown {
  const container = propertyValue(properties, containerKey);
  if (container === undefined || container === null || container === "") {
    return undefined;
  }
  if (!isObject(container)) throw malformedProfile();
  const nested = ownDataProperties(container);
  return optionalPropertyValue(nested, valueKey);
}

function legacyVerified(
  properties: readonly DataProperty[],
  legacy: readonly DataProperty[],
): boolean {
  const blue = optionalBoolean(properties, "is_blue_verified");
  const legacyVerifiedValue = optionalBoolean(legacy, "verified");
  return blue === true || legacyVerifiedValue === true;
}

function modernVerified(properties: readonly DataProperty[]): boolean {
  const verification = propertyValue(properties, "verification");
  if (verification === undefined || verification === null || verification === "") {
    return false;
  }
  if (!isObject(verification)) throw malformedProfile();
  return optionalBoolean(ownDataProperties(verification), "verified") ?? false;
}

function optionalBoolean(
  properties: readonly DataProperty[],
  key: string,
): boolean | undefined {
  if (!hasProperty(properties, key)) return undefined;
  const value = propertyValue(properties, key);
  if (value === null || value === "") return undefined;
  if (typeof value !== "boolean") throw malformedProfile();
  return value;
}

function safeText(
  value: unknown,
  maxLength: number,
  allowLineBreaks = false,
): string | undefined {
  if (typeof value !== "string" || value.length > maxLength) return undefined;
  const normalized = value.trim();
  if (!normalized || hasUnsafeControl(normalized, allowLineBreaks)) return undefined;
  return normalized;
}

function optionalText(
  value: unknown,
  maxLength: number,
  allowLineBreaks = false,
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const text = safeText(value, maxLength, allowLineBreaks);
  if (!text) throw malformedProfile();
  return text;
}

function optionalHttpsUrl(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const text = safeText(value, MAX_AVATAR_URL_LENGTH);
  if (!text || text !== value) throw malformedProfile();
  try {
    const url = new URL(text);
    if (
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password
    ) throw malformedProfile();
    return url.toString();
  } catch (error) {
    if (error instanceof XProfileParseError) throw error;
    throw malformedProfile();
  }
}

function hasUnsafeControl(value: string, allowLineBreaks: boolean): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (allowLineBreaks && (codePoint === 9 || codePoint === 10 || codePoint === 13)) {
      continue;
    }
    if (codePoint <= 31 || codePoint === 127) return true;
  }
  return false;
}

function isNotFoundRecord(properties: readonly DataProperty[]): boolean {
  return propertyValue(properties, "__typename") === "UserUnavailable" ||
    USER_NOT_FOUND_CODES.has(propertyValue(properties, "code"));
}

function withoutUndefined<T extends Record<string, unknown>>(
  value: T,
): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

function malformedProfile(): XProfileParseError {
  return new XProfileParseError("malformed-profile");
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" || typeof value === "function") &&
    value !== null;
}
