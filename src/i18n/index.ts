/* global __RSS_DASHBOARD_PRODUCTION__ */

import { en } from "./en";
import type {
  Locale,
  TranslationCatalog,
  TranslationCatalogOverrides,
  TranslationKey,
  TranslationParams,
  Translator,
} from "./types";
import { zhCN } from "./zh-cn";

export { en } from "./en";
export { zhCN } from "./zh-cn";
export type {
  Locale,
  TranslationCatalog,
  TranslationCatalogOverrides,
  TranslationKey,
  TranslationParams,
  Translator,
} from "./types";

export const catalogs: Readonly<Record<Locale, TranslationCatalog>> = {
  en,
  "zh-CN": zhCN,
};

export interface TranslatorOptions {
  /** Partial runtime overrides; primarily for compatibility checks and tests. */
  catalogs?: TranslationCatalogOverrides;
  /** Injectable warning sink keeps plugin tests independent from console state. */
  warn?: (message: string) => void;
  /** Overrides environment detection for deterministic tests. */
  isProduction?: boolean;
}

function isProductionBuild(): boolean {
  return (
    typeof __RSS_DASHBOARD_PRODUCTION__ === "boolean" &&
    __RSS_DASHBOARD_PRODUCTION__
  );
}

function hasOwn(object: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

const UNSAFE_PARAMETER_NAMES = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/** Returns true only when two catalogs expose the exact same key set. */
export function catalogsHaveMatchingKeys(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();

  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index])
  );
}

if (!catalogsHaveMatchingKeys(en, zhCN)) {
  throw new Error("RSS Dashboard localization catalogs have mismatched keys.");
}

function resolveTemplate(
  locale: Locale,
  key: TranslationKey,
  overrides?: TranslationCatalogOverrides,
): string | undefined {
  const selectedOverride = getOwnCatalogOverride(overrides, locale);
  const selectedValue =
    selectedOverride && hasOwn(selectedOverride, key)
      ? getOwnTranslation(selectedOverride, key)
      : getOwnTranslation(catalogs[locale], key);

  if (selectedValue !== undefined) {
    return selectedValue;
  }

  if (locale !== "en") {
    const englishOverride = getOwnCatalogOverride(overrides, "en");
    const englishValue =
      englishOverride && hasOwn(englishOverride, key)
        ? getOwnTranslation(englishOverride, key)
        : getOwnTranslation(catalogs.en, key);
    if (englishValue !== undefined) {
      return englishValue;
    }
  }

  // A caller can use a typed key in normal code, while an old third-party
  // integration can still fail visibly and safely rather than throwing during
  // rendering.
  return undefined;
}

function getOwnCatalogOverride(
  overrides: TranslationCatalogOverrides | undefined,
  locale: Locale,
): Partial<Record<TranslationKey, string | undefined>> | undefined {
  if (!overrides || !hasOwn(overrides, locale)) {
    return undefined;
  }

  return overrides[locale];
}

function getOwnTranslation(
  catalog: Partial<Record<TranslationKey, string | undefined>>,
  key: TranslationKey,
): string | undefined {
  if (!hasOwn(catalog, key)) {
    return undefined;
  }

  const value = catalog[key];
  return typeof value === "string" ? value : undefined;
}

function interpolate(
  template: string,
  params: TranslationParams | undefined,
): string {
  return template.replace(
    /\{([A-Za-z0-9_]+)\}/g,
    (placeholder: string, name: string) => {
      const value =
        params && !UNSAFE_PARAMETER_NAMES.has(name) && hasOwn(params, name)
          ? params[name]
          : undefined;
      // Missing parameters stay visible. Values are returned as text only: this
      // translator never interprets HTML, Markdown, or template expressions.
      return value === undefined ? placeholder : String(value);
    },
  );
}

/**
 * Produces a plain-text translator. Chinese is an independent catalog that
 * falls back to English per key, so a future partial translation cannot break
 * command labels or settings rendering.
 */
export function createTranslator(
  locale: Locale,
  options: TranslatorOptions = {},
): Translator {
  const warnedKeys = new Set<string>();
  const warn = options.warn ?? console.warn;
  const isProduction = options.isProduction ?? isProductionBuild();

  return (key, params) => {
    const template = resolveTemplate(locale, key, options.catalogs);
    if (template !== undefined) {
      return interpolate(template, params);
    }

    const keyString = key as string;
    if (!isProduction && !warnedKeys.has(keyString)) {
      warnedKeys.add(keyString);
      warn(`Missing RSS Dashboard translation: ${keyString}`);
    }

    return keyString;
  };
}
