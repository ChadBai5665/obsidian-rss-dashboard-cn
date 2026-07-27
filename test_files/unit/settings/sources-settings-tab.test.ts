import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderSourcesSettingsTab } from "../../../src/settings/tabs/sources-settings-tab";
import { DEFAULT_SETTINGS } from "../../../src/types/types";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";

beforeEach(() => {
  installObsidianDomPolyfills();
  document.body.empty();
  vi.restoreAllMocks();
});

describe("renderSourcesSettingsTab", () => {
  it("routes source management to the Dashboard instead of editing X settings directly", async () => {
    const containerEl = document.body.createDiv();
    const activateView = vi.fn(async () => undefined);

    renderSourcesSettingsTab(containerEl, {
      settings: structuredClone(DEFAULT_SETTINGS),
      activateView,
    });

    expect(containerEl.querySelectorAll("button")).toHaveLength(1);
    const button = containerEl.querySelector("button") as HTMLButtonElement;
    expect(button.textContent).toBe("打开 RSS 信息台");
    expect(containerEl.textContent).not.toContain("添加 X 账号");

    button.click();
    await Promise.resolve();

    expect(activateView).toHaveBeenCalledTimes(1);
  });
});
