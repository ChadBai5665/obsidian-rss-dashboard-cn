/**
 * Tests for tab-orchestration helpers extracted from RssDashboardSettingTab.
 *
 * Functions under test:
 *   - SETTINGS_TAB_IDS — the canonical list of stable tab identities
 *   - isValidSettingsTab(id) — returns true only for known tab identities
 *   - getInitialTab() — returns the first (default) tab identity
 *
 * These are pure, zero-dependency exports from the settings-tab module.
 */
import { describe, it, expect } from "vitest";
import {
  SETTINGS_TAB_IDS,
  SETTINGS_TAB_NAMES,
  isValidSettingsTab,
  getInitialTab,
  normalizeSettingsTabId,
} from "../../../src/settings/tab-names";

// ── SETTINGS_TAB_NAMES ───────────────────────────────────────────────────────

describe("SETTINGS_TAB_IDS", () => {
  it("keeps the deprecated public aliases compatible", () => {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- compatibility contract
    const oldName: import("../../../src/settings/tab-names").SettingsTabName = "General";
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- compatibility contract
    expect(SETTINGS_TAB_NAMES).toEqual([
      "General", "Storage", "Display", "Sidebar", "Media", "Article saving",
      "Rules", "Highlights", "Import/Export", "Tags", "About",
    ]);
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- compatibility contract
    expect(SETTINGS_TAB_NAMES).not.toBe(SETTINGS_TAB_IDS);
    expect(oldName).toBe("General");
  });
  it("contains exactly 14 tabs", () => {
    expect(SETTINGS_TAB_IDS).toHaveLength(14);
  });

  it("includes all expected stable tab ids", () => {
    const expected = [
      "general",
      "sources",
      "topic-discovery",
      "tikhub",
      "storage",
      "display",
      "sidebar",
      "media",
      "article-saving",
      "rules",
      "highlights",
      "import-export",
      "tags",
      "about",
    ];
    for (const name of expected) {
      expect(SETTINGS_TAB_IDS, `missing tab "${name}"`).toContain(name);
    }
  });

  it("has 'general' as the first tab (default on open)", () => {
    expect(SETTINGS_TAB_IDS[0]).toBe("general");
  });
});

describe("normalizeSettingsTabId()", () => {
  it("accepts both stable IDs and exact legacy display names", () => {
    expect(normalizeSettingsTabId("display")).toBe("display");
    expect(normalizeSettingsTabId("Display")).toBe("display");
  });
  it.each(["__proto__", "constructor", "prototype", "toString"])(
    "rejects unsafe or inherited legacy name %s",
    (name) => {
      expect(normalizeSettingsTabId(name)).toBeNull();
    },
  );
});

// ── isValidSettingsTab ───────────────────────────────────────────────────────

describe("isValidSettingsTab()", () => {
  it("returns true for every known tab id", () => {
    for (const name of SETTINGS_TAB_IDS) {
      expect(isValidSettingsTab(name), `"${name}" should be valid`).toBe(true);
    }
  });

  it("returns false for an unknown tab name", () => {
    expect(isValidSettingsTab("Unknown")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isValidSettingsTab("")).toBe(false);
  });

  it("is case-sensitive — wrong case returns false", () => {
    expect(isValidSettingsTab("General")).toBe(false);
    expect(isValidSettingsTab("DISPLAY")).toBe(false);
  });

  it("returns false for a name with trailing space", () => {
    expect(isValidSettingsTab("general ")).toBe(false);
  });
});

// ── getInitialTab ────────────────────────────────────────────────────────────

describe("getInitialTab()", () => {
  it("returns 'general'", () => {
    expect(getInitialTab()).toBe("general");
  });

  it("is always the first entry in SETTINGS_TAB_IDS", () => {
    expect(getInitialTab()).toBe(SETTINGS_TAB_IDS[0]);
  });
});
