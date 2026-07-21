import type { en } from "./en";

export type Locale = "zh-CN" | "en";

export type TranslationKey = keyof typeof en;

export type TranslationParams = Record<string, string | number>;

export type Translator = (
  key: TranslationKey,
  params?: TranslationParams,
) => string;

export type TranslationCatalog = Record<TranslationKey, string>;

/**
 * Runtime catalog overrides are intentionally partial to support controlled
 * compatibility tests and future plugin-provided catalog patches. Production
 * catalogs remain complete through TranslationCatalog's compile-time contract.
 */
export type TranslationCatalogOverrides = Partial<
  Record<Locale, Partial<Record<TranslationKey, string | undefined>>>
>;
