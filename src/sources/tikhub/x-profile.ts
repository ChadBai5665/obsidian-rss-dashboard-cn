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

export const X_PROFILE_MAX_WALK_DEPTH = 32;
export const X_PROFILE_MAX_WALK_NODES = 25_000;
export const X_PROFILE_MAX_ARRAY_ENTRIES = 100_000;
export const X_PROFILE_MAX_OBJECT_PROPERTIES = 10_000;
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

interface NormalizedProfileCandidate {
  restId: string;
  handle: string;
  displayName: string;
  avatarUrl?: string;
  description?: string;
  verified?: boolean;
}

/** Projects one untrusted TikHub profile payload into a provider-neutral record. */
export function parseXProfile(payload: unknown): XProfile {
  try {
    const candidates: NormalizedProfileCandidate[] = [];
    let notFound = false;
    const seen = new WeakSet<object>();
    const stack: WalkEntry[] = [{ value: payload, depth: 0 }];
    let visited = 0;

    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) continue;
      if (current.depth > X_PROFILE_MAX_WALK_DEPTH) throw malformedProfile();
      const value = current.value;
      if (!isObject(value)) continue;
      if (seen.has(value)) continue;
      seen.add(value);
      visited += 1;
      if (visited > X_PROFILE_MAX_WALK_NODES) throw malformedProfile();

      const properties = ownDataProperties(value);
      if (isNotFoundRecord(properties)) notFound = true;
      candidates.push(...profileCandidate(properties));

      for (let index = properties.length - 1; index >= 0; index -= 1) {
        const child = properties[index]?.value;
        if (isObject(child)) {
          stack.push({ value: child, depth: current.depth + 1 });
        }
      }
    }

    if (notFound && candidates.length === 0) {
      throw new XProfileParseError("not-found");
    }
    if (notFound || candidates.length === 0) throw malformedProfile();
    return reconcileCandidates(candidates);
  } catch (error) {
    if (error instanceof XProfileParseError) throw error;
    throw malformedProfile();
  }
}

function profileCandidate(
  properties: readonly DataProperty[],
): NormalizedProfileCandidate[] {
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
    return [];
  }

  const restId = safeText(restIdValue, MAX_REST_ID_LENGTH);
  if (!restId) throw malformedProfile();

  const legacyProperties = legacy ?? [];
  const candidates: NormalizedProfileCandidate[] = [];
  if (hasLegacyPair) {
    candidates.push(normalizedCandidate({
      restId,
      handleValue: legacyHandle,
      displayNameValue: legacyName,
      avatarValue: optionalPropertyValue(legacyProperties, "profile_image_url_https"),
      descriptionValue: optionalPropertyValue(legacyProperties, "description"),
      verified: legacyVerified(properties, legacyProperties),
    }));
  }
  if (hasCurrentPair) {
    candidates.push(normalizedCandidate({
      restId,
      handleValue: currentHandle,
      displayNameValue: currentName,
      avatarValue: nestedPropertyValue(properties, "avatar", "image_url"),
      descriptionValue: nestedPropertyValue(properties, "profile_bio", "description"),
      verified: modernVerified(properties),
    }));
  }
  return candidates;
}

function normalizedCandidate(input: {
  restId: string;
  handleValue: unknown;
  displayNameValue: unknown;
  avatarValue: unknown;
  descriptionValue: unknown;
  verified: boolean | undefined;
}): NormalizedProfileCandidate {
  const handle = normalizeXHandle(input.handleValue);
  const displayName = safeText(input.displayNameValue, MAX_DISPLAY_NAME_LENGTH);
  if (!handle || !displayName) throw malformedProfile();
  return withoutUndefined({
    restId: input.restId,
    handle,
    displayName,
    avatarUrl: optionalHttpsUrl(input.avatarValue),
    description: optionalText(input.descriptionValue, MAX_DESCRIPTION_LENGTH, true),
    verified: input.verified,
  });
}

function profileIdentity(candidate: NormalizedProfileCandidate): string {
  return `${candidate.restId}\0${normalizeXHandle(candidate.handle)}`;
}

function reconcileCandidates(
  candidates: readonly NormalizedProfileCandidate[],
): XProfile {
  const reconciled = new Map<string, NormalizedProfileCandidate>();
  for (const candidate of candidates) {
    const identity = profileIdentity(candidate);
    const existing = reconciled.get(identity);
    reconciled.set(
      identity,
      existing ? mergeCandidates(existing, candidate) : candidate,
    );
  }
  if (reconciled.size !== 1) throw malformedProfile();
  const profile = reconciled.values().next().value;
  if (!profile) throw malformedProfile();
  return withoutUndefined({
    restId: profile.restId,
    handle: profile.handle,
    displayName: profile.displayName,
    avatarUrl: profile.avatarUrl,
    description: profile.description,
    verified: profile.verified ?? false,
  });
}

function mergeCandidates(
  first: NormalizedProfileCandidate,
  second: NormalizedProfileCandidate,
): NormalizedProfileCandidate {
  if (
    first.restId !== second.restId ||
    first.handle !== second.handle ||
    first.displayName !== second.displayName
  ) {
    throw malformedProfile();
  }
  return withoutUndefined({
    restId: first.restId,
    handle: first.handle,
    displayName: first.displayName,
    avatarUrl: mergeOptional(first.avatarUrl, second.avatarUrl),
    description: mergeOptional(first.description, second.description),
    verified: mergeOptional(first.verified, second.verified),
  });
}

function mergeOptional<T>(first: T | undefined, second: T | undefined): T | undefined {
  if (first !== undefined && second !== undefined && first !== second) {
    throw malformedProfile();
  }
  return first ?? second;
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
  if (Array.isArray(value) && value.length > X_PROFILE_MAX_ARRAY_ENTRIES) {
    throw malformedProfile();
  }
  if (Object.getOwnPropertySymbols(value).length > 0) throw malformedProfile();

  const names = Object.getOwnPropertyNames(value);
  if (names.length > X_PROFILE_MAX_OBJECT_PROPERTIES) throw malformedProfile();
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
  if (!isObject(container) || Array.isArray(container)) throw malformedProfile();
  const nested = ownDataProperties(container);
  return optionalPropertyValue(nested, valueKey);
}

function legacyVerified(
  properties: readonly DataProperty[],
  legacy: readonly DataProperty[],
): boolean | undefined {
  const blue = optionalBoolean(properties, "is_blue_verified");
  const legacyVerifiedValue = optionalBoolean(legacy, "verified");
  if (blue === true || legacyVerifiedValue === true) return true;
  if (blue === false || legacyVerifiedValue === false) return false;
  return undefined;
}

function modernVerified(properties: readonly DataProperty[]): boolean | undefined {
  const verification = propertyValue(properties, "verification");
  if (verification === undefined || verification === null || verification === "") {
    return undefined;
  }
  if (!isObject(verification) || Array.isArray(verification)) {
    throw malformedProfile();
  }
  return optionalBoolean(ownDataProperties(verification), "verified");
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
