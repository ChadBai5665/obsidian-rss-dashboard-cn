import { afterEach, describe, expect, it, vi } from "vitest";
import {
  catalogsHaveMatchingKeys,
  createTranslator,
  type TranslationCatalogOverrides,
} from "../../../src/i18n";
import { en } from "../../../src/i18n/en";
import { zhCN } from "../../../src/i18n/zh-cn";

describe("i18n", () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
        source: "<img src=x onerror=alert(1)>",
      }),
    ).toBe("Refreshed 3 items from <img src=x onerror=alert(1)>");
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

  it("keeps the built-in catalogs in key parity", () => {
    expect(catalogsHaveMatchingKeys(en, zhCN)).toBe(true);
    expect(Object.keys(zhCN).sort()).toEqual(Object.keys(en).sort());
  });
});
