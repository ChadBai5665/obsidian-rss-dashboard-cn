import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderInitialImportControl } from "../../../src/modals/source-onboarding/initial-import-control";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";

beforeEach(() => {
  installObsidianDomPolyfills();
  document.body.empty();
});

describe("initial import control", () => {
  it("defaults to the last seven days and exposes every supported policy", () => {
    const container = document.createElement("div");
    const onChange = vi.fn();
    const control = renderInitialImportControl(container, {
      locale: "zh-CN",
      sourceKind: "youtube",
      onChange,
    });

    const options = Array.from(container.querySelectorAll("option"));
    expect(options.map((option) => option.textContent)).toEqual([
      "仅从现在开始",
      "最近 3 天",
      "最近 7 天",
      "最近 14 天",
      "最近 30 天",
      "最近 90 天",
      "自定义日期",
      "全部可获取历史",
    ]);
    expect(control.getPolicy()).toEqual({ mode: "lookback-days", days: 7 });
    expect(container.textContent).toContain("YouTube RSS 通常只提供频道最近的公开视频");
  });

  it("renders a required date for the custom policy", () => {
    const container = document.createElement("div");
    const onChange = vi.fn();
    const control = renderInitialImportControl(container, {
      locale: "en",
      sourceKind: "rss-website",
      onChange,
    });
    const select = container.querySelector("select") as HTMLSelectElement;
    select.value = "custom";
    select.dispatchEvent(new Event("change"));

    const date = container.querySelector("input[type=date]") as HTMLInputElement;
    expect(date).not.toBeNull();
    expect(date.required).toBe(true);
    expect(control.getPolicy()).toBeUndefined();

    date.value = "2026-07-01";
    date.dispatchEvent(new Event("change"));
    expect(control.getPolicy()).toEqual({ mode: "since-date", since: "2026-07-01" });
    expect(onChange).toHaveBeenLastCalledWith({ mode: "since-date", since: "2026-07-01" });
  });

  it("preserves an existing custom date", () => {
    const container = document.createElement("div");
    const control = renderInitialImportControl(container, {
      locale: "zh-CN",
      sourceKind: "x-account",
      initialPolicy: { mode: "since-date", since: "2026-06-01" },
    });

    expect((container.querySelector("select") as HTMLSelectElement).value).toBe("custom");
    expect((container.querySelector("input[type=date]") as HTMLInputElement).value)
      .toBe("2026-06-01");
    expect(control.getPolicy()).toEqual({ mode: "since-date", since: "2026-06-01" });
  });
});
