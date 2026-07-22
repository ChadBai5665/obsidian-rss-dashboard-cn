import { beforeEach, describe, expect, it, vi } from "vitest";
import { App, Setting } from "obsidian";
import { renderHighlightsSettingsTab } from "../../../src/settings/tabs/highlights-settings-tab";
import { DEFAULT_SETTINGS, type RssDashboardSettings } from "../../../src/types/types";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";

function render(locale: "zh-CN" | "en"): HTMLElement {
  const settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as RssDashboardSettings;
  settings.locale = locale;
  settings.highlights = {
    enabled: true,
    defaultColor: "#ffd700",
    highlightInContent: true,
    highlightInTitles: true,
    highlightInSummaries: true,
    words: [{
      id: "one",
      text: "ExternalTerm",
      color: "#ffd700",
      enabled: true,
      wholeWord: true,
      caseSensitive: true,
      createdAt: 1,
    }],
  };
  const plugin = {
    app: App.createMock(),
    settings,
    saveSettings: vi.fn(async () => undefined),
    getActiveDashboardView: vi.fn(async () => null),
    getActiveReaderView: vi.fn(async () => null),
  };
  const container = document.body.createDiv();
  renderHighlightsSettingsTab(container, plugin as never, vi.fn());
  return container;
}

describe("highlight settings localization", () => {
  beforeEach(() => {
    installObsidianDomPolyfills();
    document.body.empty();
    (Setting.prototype as unknown as {
      addExtraButton(callback: (button: {
        setIcon(icon: string): unknown;
        setTooltip(tooltip: string): unknown;
        onClick(handler: () => void): unknown;
      }) => void): Setting;
    }).addExtraButton = function addExtraButton(callback) {
      const button = {
        setIcon() { return button; },
        setTooltip() { return button; },
        onClick() { return button; },
      };
      callback(button);
      return this;
    };
  });

  it.each([
    ["zh-CN", "全词匹配｜已启用｜区分大小写", "大小写"],
    ["en", "Whole word | Enabled | Case sensitive", "Case"],
  ] as const)("renders localized status and controls in %s", (locale, status, caseButton) => {
    const container = render(locale);
    expect(container.textContent).toContain("ExternalTerm");
    expect(container.textContent).toContain(status);
    expect(
      Array.from(container.querySelectorAll("button")).some(
        (button) => button.textContent === caseButton,
      ),
    ).toBe(true);
  });
});
