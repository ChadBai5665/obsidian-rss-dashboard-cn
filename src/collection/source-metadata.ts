import type { XPostSourceMetadata } from "./collected-item";

const POST_ID = /^\d{1,30}$/u;
const ALLOWED_KEYS = new Set([
  "kind",
  "conversationId",
  "inReplyToId",
  "repostOfId",
  "quoteOfId",
  "externalUrls",
  "observationTags",
]);
const RELATION_KEYS = [
  "conversationId",
  "inReplyToId",
  "repostOfId",
  "quoteOfId",
] as const;

export function normalizeXPostSourceMetadata(
  value: unknown,
): XPostSourceMetadata | undefined {
  const record = plainRecord(value);
  if (
    !record ||
    !hasOwnData(record, "kind") ||
    ownData(record, "kind") !== "x-post" ||
    !hasOwnData(record, "externalUrls") ||
    !hasAllowedKeys(record)
  ) {
    return undefined;
  }
  const externalUrls = safeExternalUrls(ownData(record, "externalUrls"));
  if (!externalUrls) return undefined;
  const result: XPostSourceMetadata = {
    kind: "x-post",
    externalUrls,
  };
  if (Object.prototype.hasOwnProperty.call(record, "observationTags")) {
    const observationTags = safeObservationTags(ownData(record, "observationTags"));
    if (!observationTags) return undefined;
    result.observationTags = observationTags;
  }
  for (const key of RELATION_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const relation = ownData(record, key);
    if (typeof relation !== "string" || !POST_ID.test(relation)) {
      return undefined;
    }
    result[key] = relation;
  }
  return result;
}

export function mergeXPostSourceMetadata(
  previous: XPostSourceMetadata | undefined,
  incoming: XPostSourceMetadata | undefined,
): XPostSourceMetadata | undefined {
  if (!previous && !incoming) return undefined;
  if (!previous) return cloneMetadata(incoming as XPostSourceMetadata);
  if (!incoming) return cloneMetadata(previous);
  return {
    kind: "x-post",
    ...(incoming.conversationId ?? previous.conversationId
      ? { conversationId: incoming.conversationId ?? previous.conversationId }
      : {}),
    ...(incoming.inReplyToId ?? previous.inReplyToId
      ? { inReplyToId: incoming.inReplyToId ?? previous.inReplyToId }
      : {}),
    ...(incoming.repostOfId ?? previous.repostOfId
      ? { repostOfId: incoming.repostOfId ?? previous.repostOfId }
      : {}),
    ...(incoming.quoteOfId ?? previous.quoteOfId
      ? { quoteOfId: incoming.quoteOfId ?? previous.quoteOfId }
      : {}),
    externalUrls: [...new Set([...previous.externalUrls, ...incoming.externalUrls])],
    ...((previous.observationTags?.length ?? 0) > 0 ||
    (incoming.observationTags?.length ?? 0) > 0
      ? {
          observationTags: orderedObservationTags([
            ...(previous.observationTags ?? []),
            ...(incoming.observationTags ?? []),
          ]),
        }
      : {}),
  };
}

function cloneMetadata(value: XPostSourceMetadata): XPostSourceMetadata {
  return {
    ...value,
    externalUrls: [...value.externalUrls],
    ...(value.observationTags
      ? { observationTags: [...value.observationTags] }
      : {}),
  };
}

const OBSERVATION_TAGS = [
  "latest",
  "platform-top",
  "priority-account",
] as const;

function safeObservationTags(
  value: unknown,
): XPostSourceMetadata["observationTags"] | undefined {
  if (!Array.isArray(value) || value.length > OBSERVATION_TAGS.length) {
    return undefined;
  }
  const entries: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") {
      return undefined;
    }
    entries.push(descriptor.value);
  }
  if (new Set(entries).size !== entries.length) return undefined;
  const ordered = orderedObservationTags(entries);
  return ordered.length === entries.length ? ordered : undefined;
}

function orderedObservationTags(
  values: readonly string[],
): NonNullable<XPostSourceMetadata["observationTags"]> {
  const present = new Set(values);
  return OBSERVATION_TAGS.filter((tag) => present.has(tag));
}

function safeExternalUrls(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > 10_000) return undefined;
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") {
      return undefined;
    }
    try {
      const url = new URL(descriptor.value);
      if (
        (url.protocol !== "https:" && url.protocol !== "http:") ||
        url.username ||
        url.password ||
        url.toString() !== descriptor.value
      ) {
        return undefined;
      }
    } catch {
      return undefined;
    }
    result.push(descriptor.value);
  }
  return result;
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasAllowedKeys(record: Record<string, unknown>): boolean {
  return Object.keys(record).every((key) => ALLOWED_KEYS.has(key));
}

function hasOwnData(record: Record<string, unknown>, key: string): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor !== undefined && "value" in descriptor;
}

function ownData(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
