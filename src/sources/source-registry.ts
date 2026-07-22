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

function isDenseOwnArray(
  value: unknown,
  predicate: (entry: unknown) => boolean,
): value is unknown[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index++) {
    if (!hasOwn(value, index)) return false;
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
}

function sourceSignature(config: SourceConfig): string {
  return JSON.stringify(config);
}

function assertValidRefreshOutput(
  output: unknown,
  config: SourceConfig,
): SourceRefreshOutput {
  if (!isRecord(output) || !isRecord(output.feed)) {
    throw new InvalidSourceOutputError();
  }
  const feed = output.feed;
  const outputConfig = normalizeSourceConfig(feed.sourceConfig);
  const providerRequestCount = output.providerRequestCount;
  if (
    !isDenseOwnArray(output.items, isRecord) ||
    typeof providerRequestCount !== "number" ||
    !Number.isSafeInteger(providerRequestCount) ||
    providerRequestCount < 0 ||
    !isDenseOwnArray(
      output.warnings,
      (warning) => typeof warning === "string",
    ) ||
    feed.sourceKind !== config.kind ||
    !outputConfig ||
    sourceSignature(outputConfig) !== sourceSignature(config)
  ) {
    throw new InvalidSourceOutputError();
  }

  const expectedUrl = sourceConfigUrl(config);
  if (
    (expectedUrl !== undefined && feed.url !== expectedUrl) ||
    (config.kind === "feed" &&
      (typeof feed.url !== "string" || !feed.url.trim()))
  ) {
    throw new InvalidSourceOutputError();
  }

  return {
    feed: feed as unknown as SourceRefreshOutput["feed"],
    items: [...(output.items as SourceRefreshOutput["items"])],
    providerRequestCount,
    warnings: [...(output.warnings as SourceRefreshOutput["warnings"])],
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
