import { createTranslator } from "../i18n";
import type { TranslationKey, Translator } from "../i18n/types";
import type {
  SourceAdapter,
  SourceRefreshContext,
  SourceRefreshOutput,
} from "./source-adapter";
import type { SourceConfig, SourceKind } from "./source-config";

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

function assertValidRefreshOutput(output: SourceRefreshOutput): void {
  if (
    !Number.isSafeInteger(output.providerRequestCount) ||
    output.providerRequestCount < 0 ||
    !Array.isArray(output.warnings)
  ) {
    throw new Error("Invalid source refresh output");
  }
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
    const output = await this.get(config.kind).refresh(config, context);
    assertValidRefreshOutput(output);
    return output;
  }
}
