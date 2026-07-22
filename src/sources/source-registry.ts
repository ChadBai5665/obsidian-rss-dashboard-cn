import { createTranslator } from "../i18n";
import type { TranslationKey, Translator } from "../i18n/types";
import type {
  SourceAdapter,
  SourceRefreshContext,
  SourceRefreshOutput,
} from "./source-adapter";
import {
  isSourceKind,
  normalizeSourceConfig,
  sourceConfigUrl,
  type SourceConfig,
  type SourceKind,
} from "./source-config";
import { canonicalExternalPageUrl } from "./tikhub/linked-page-grouper";

export class UnsupportedSourceError extends Error {
  readonly code = "unsupported-source";
  readonly translationKey: TranslationKey = "source.unsupported";

  constructor(kind: string, translate: Translator) {
    super(translate("source.unsupported", { kind }));
    this.name = "UnsupportedSourceError";
  }
}

export interface SourceRegistryOptions {
  translate?: Translator;
}
type AnySourceAdapter = SourceAdapter<SourceConfig>;

export class InvalidSourceOutputError extends Error {
  readonly code = "invalid-source-output";

  constructor() {
    super("Invalid source refresh output");
    this.name = "InvalidSourceOutputError";
  }
}

export class InvalidSourceConfigError extends Error {
  readonly code = "invalid-source-config";

  constructor() {
    super("Invalid source configuration");
    this.name = "InvalidSourceConfigError";
  }
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const MISSING = Symbol("missing-own-property");

function ownDataValue(
  value: Record<string, unknown>,
  key: string,
): unknown {
  if (!hasOwn(value, key)) return MISSING;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : MISSING;
}

function isDenseOwnArray(
  value: unknown,
  predicate: (entry: unknown) => boolean,
): value is unknown[] {
  try {
    if (!Array.isArray(value) || Reflect.getPrototypeOf(value) !== Array.prototype) {
      return false;
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const length: unknown =
      lengthDescriptor && "value" in lengthDescriptor
        ? lengthDescriptor.value
        : undefined;
    if (
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > 100_000
    ) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length + 1 || !keys.includes("length")) return false;
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        !descriptor ||
        !("value" in descriptor) ||
        !predicate(descriptor.value)
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function sourceSignature(config: SourceConfig): string {
  return JSON.stringify(config);
}

const FEED_ITEM_REQUIRED_FIELDS = [
  "title",
  "link",
  "description",
  "pubDate",
  "guid",
  "feedTitle",
  "feedUrl",
  "coverImage",
] as const;

function isFeedItem(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return FEED_ITEM_REQUIRED_FIELDS.every(
    (field) => typeof ownDataValue(value, field) === "string",
  );
}

function isFeed(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const lastUpdated = ownDataValue(value, "lastUpdated");
  return (
    typeof ownDataValue(value, "title") === "string" &&
    typeof ownDataValue(value, "url") === "string" &&
    typeof ownDataValue(value, "folder") === "string" &&
    typeof lastUpdated === "number" &&
    Number.isFinite(lastUpdated) &&
    ownDataValue(value, "sourceKind") !== MISSING &&
    ownDataValue(value, "sourceConfig") !== MISSING &&
    isDenseOwnArray(ownDataValue(value, "items"), isFeedItem)
  );
}

function isLinkedPageGroup(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasExactOwnDataKeys(value, ["url", "postCount", "authors", "postIds"])
  ) return false;
  const url = ownDataValue(value, "url");
  const postCount = ownDataValue(value, "postCount");
  const authors = ownDataValue(value, "authors");
  const postIds = ownDataValue(value, "postIds");
  return (
    typeof url === "string" &&
    canonicalExternalPageUrl(url) === url &&
    typeof postCount === "number" &&
    Number.isSafeInteger(postCount) &&
    postCount > 1 &&
    isDenseOwnArray(authors, (entry) => typeof entry === "string") &&
    isDenseOwnArray(
      postIds,
      (entry) => typeof entry === "string" && /^\d{1,30}$/u.test(entry),
    ) &&
    new Set(postIds as string[]).size === postCount
  );
}

function hasExactOwnDataKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  try {
    const keys = Reflect.ownKeys(value);
    return (
      keys.length === expected.length &&
      expected.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor !== undefined && "value" in descriptor;
      })
    );
  } catch {
    return false;
  }
}

function assertValidRefreshOutput(
  output: unknown,
  config: SourceConfig,
): SourceRefreshOutput {
  if (!isRecord(output)) {
    throw new InvalidSourceOutputError();
  }
  const feed = ownDataValue(output, "feed");
  const items = ownDataValue(output, "items");
  const providerRequestCount = ownDataValue(output, "providerRequestCount");
  const warnings = ownDataValue(output, "warnings");
  const linkedPageGroups = ownDataValue(output, "linkedPageGroups");
  if (!isFeed(feed)) throw new InvalidSourceOutputError();
  const outputConfig = normalizeSourceConfig(ownDataValue(feed, "sourceConfig"));
  if (
    !isDenseOwnArray(items, isFeedItem) ||
    typeof providerRequestCount !== "number" ||
    !Number.isSafeInteger(providerRequestCount) ||
    providerRequestCount < 0 ||
    !isDenseOwnArray(
      warnings,
      (warning) => typeof warning === "string",
    ) ||
    (linkedPageGroups !== MISSING &&
      !isDenseOwnArray(linkedPageGroups, isLinkedPageGroup)) ||
    ownDataValue(feed, "sourceKind") !== config.kind ||
    !outputConfig ||
    sourceSignature(outputConfig) !== sourceSignature(config)
  ) {
    throw new InvalidSourceOutputError();
  }

  const expectedUrl = sourceConfigUrl(config);
  if (
    (expectedUrl !== undefined && ownDataValue(feed, "url") !== expectedUrl) ||
    (config.kind === "feed" &&
      (typeof ownDataValue(feed, "url") !== "string" ||
        !(ownDataValue(feed, "url") as string).trim()))
  ) {
    throw new InvalidSourceOutputError();
  }

  return {
    feed: feed as unknown as SourceRefreshOutput["feed"],
    items: [...(items as SourceRefreshOutput["items"])],
    providerRequestCount,
    warnings: [...(warnings as SourceRefreshOutput["warnings"])],
    ...(linkedPageGroups === MISSING
      ? {}
      : {
          linkedPageGroups: (linkedPageGroups as NonNullable<
            SourceRefreshOutput["linkedPageGroups"]
          >).map((group) => ({
            url: group.url,
            postCount: group.postCount,
            authors: [...group.authors],
            postIds: [...group.postIds],
          })),
        }),
  };
}

/** Registered adapters are explicit: X sources never fall through to RSS. */
export class SourceRegistry {
  private readonly adapters = new Map<SourceKind, AnySourceAdapter>();
  private readonly translate: Translator;

  constructor(options: SourceRegistryOptions = {}) {
    this.translate = options.translate ?? createTranslator("zh-CN");
  }

  register<TConfig extends SourceConfig>(
    adapter: SourceAdapter<TConfig>,
  ): void {
    if (
      !isRecord(adapter) ||
      !hasOwn(adapter, "kind") ||
      !isSourceKind(adapter.kind) ||
      !hasOwn(adapter, "refresh") ||
      typeof adapter.refresh !== "function"
    ) {
      throw new Error("Invalid source adapter");
    }
    if (this.adapters.has(adapter.kind)) {
      throw new Error(`Source adapter already registered: ${adapter.kind}`);
    }
    this.adapters.set(adapter.kind, adapter as unknown as AnySourceAdapter);
  }

  get(kind: SourceKind): AnySourceAdapter {
    const adapter = this.adapters.get(kind);
    if (!adapter) throw new UnsupportedSourceError(kind, this.translate);
    return adapter;
  }

  async refresh<TConfig extends SourceConfig>(
    config: TConfig,
    context: SourceRefreshContext,
  ): Promise<SourceRefreshOutput> {
    const normalizedConfig = normalizeSourceConfig(config);
    if (!normalizedConfig) throw new InvalidSourceConfigError();
    const output = await this.get(normalizedConfig.kind).refresh(
      normalizedConfig,
      context,
    );
    return assertValidRefreshOutput(output, normalizedConfig);
  }
}
