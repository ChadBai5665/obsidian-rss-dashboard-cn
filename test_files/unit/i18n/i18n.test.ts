import { afterEach, describe, expect, it, vi } from "vitest";
import {
  catalogsHaveMatchingKeys,
  createTranslator,
  type TranslationCatalogOverrides,
  type TranslationParams,
} from "../../../src/i18n";
import { en } from "../../../src/i18n/en";
import { zhCN } from "../../../src/i18n/zh-cn";

describe("i18n", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (Object.prototype as Record<string, unknown>)[
      "test.prototype-pollution"
    ];
  });

  it("uses Chinese as the selected locale", () => {
    expect(createTranslator("zh-CN")("common.refresh")).toBe("刷新");
  });

  it("uses English when selected", () => {
    expect(createTranslator("en")("common.refresh")).toBe("Refresh");
  });

  it("interpolates string and number parameters as plain text", () => {
    const translate = createTranslator("en");

    expect(
      translate("notice.refreshedCount", {
        count: 3,
        source: "$&<img src=x onerror=alert(1)>",
      }),
    ).toBe("Refreshed 3 items from $&<img src=x onerror=alert(1)>");
    expect(translate("notice.refreshedCount", { count: 3 })).toBe(
      "Refreshed 3 items from {source}",
    );
  });

  it("falls back to English when a Chinese translation is absent", () => {
    const catalogs: TranslationCatalogOverrides = {
      "zh-CN": {
        "common.refresh": undefined,
      },
    };

    expect(createTranslator("zh-CN", { catalogs })("common.refresh")).toBe(
      "Refresh",
    );
  });

  it("returns an unknown key and warns once in development", () => {
    const warn = vi.fn();
    const translate = createTranslator("zh-CN", {
      warn,
      isProduction: false,
    });
    const unknownKey = "test.missing" as unknown as keyof typeof en;

    expect(translate(unknownKey)).toBe("test.missing");
    expect(translate(unknownKey)).toBe("test.missing");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does not warn for an unknown key in production", () => {
    const warn = vi.fn();
    const translate = createTranslator("zh-CN", {
      warn,
      isProduction: true,
    });
    const unknownKey = "test.missing" as unknown as keyof typeof en;

    translate(unknownKey);
    expect(warn).not.toHaveBeenCalled();
  });

  it("uses the build-time production flag instead of window.process", () => {
    vi.stubGlobal("__RSS_DASHBOARD_PRODUCTION__", true);
    vi.stubGlobal("process", { env: { NODE_ENV: "development" } });
    const warn = vi.fn();
    const unknownKey = "test.missing" as unknown as keyof typeof en;

    createTranslator("zh-CN", { warn })(unknownKey);

    expect(warn).not.toHaveBeenCalled();
  });

  it("warns in development even when window.process says production", () => {
    vi.stubGlobal("__RSS_DASHBOARD_PRODUCTION__", false);
    vi.stubGlobal("process", { env: { NODE_ENV: "production" } });
    const warn = vi.fn();
    const unknownKey = "test.missing" as unknown as keyof typeof en;

    createTranslator("zh-CN", { warn })(unknownKey);

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("uses only own catalog properties and ignores inherited locale overrides", () => {
    Object.defineProperty(Object.prototype, "test.prototype-pollution", {
      configurable: true,
      value: "poisoned catalog value",
    });
    const inheritedOverrides = Object.create({
      "zh-CN": { "common.refresh": "poisoned locale override" },
    }) as TranslationCatalogOverrides;
    const unknownKey = "test.prototype-pollution" as unknown as keyof typeof en;

    expect(createTranslator("zh-CN")("common.refresh")).toBe("刷新");
    expect(
      createTranslator("zh-CN", { catalogs: inheritedOverrides })(
        "common.refresh",
      ),
    ).toBe("刷新");
    expect(createTranslator("zh-CN", { isProduction: true })(unknownKey)).toBe(
      "test.prototype-pollution",
    );
  });

  it("interpolates only safe own parameters", () => {
    const translate = createTranslator("en", {
      catalogs: {
        en: {
          "notice.refreshedCount":
            "{__proto__} {constructor} {prototype} {count} {source}",
        },
      },
    });
    const nullPrototypeParams = Object.create(null) as TranslationParams;
    nullPrototypeParams.__proto__ = "unsafe";
    nullPrototypeParams.constructor = "unsafe";
    nullPrototypeParams.prototype = "unsafe";
    nullPrototypeParams.count = 5;
    nullPrototypeParams.source = "$&<b>literal</b>";
    const inheritedParams = Object.create({
      count: 42,
      source: "inherited",
    }) as TranslationParams;

    expect(translate("notice.refreshedCount", nullPrototypeParams)).toBe(
      "{__proto__} {constructor} {prototype} 5 $&<b>literal</b>",
    );
    expect(
      createTranslator("en")("notice.refreshedCount", inheritedParams),
    ).toBe("Refreshed {count} items from {source}");
  });

  it("keeps the built-in catalogs in key parity", () => {
    expect(catalogsHaveMatchingKeys(en, zhCN)).toBe(true);
    expect(Object.keys(zhCN).sort()).toEqual(Object.keys(en).sort());
  });
});
