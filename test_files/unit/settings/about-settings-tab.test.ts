import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderAboutTab } from "../../../src/settings/tabs/about-settings-tab";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";

beforeEach(() => {
  installObsidianDomPolyfills();
  document.body.empty();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("renderAboutTab()", () => {
  it("renders only one clearly labelled upstream attribution link", () => {
    const containerEl = document.createElement("div");
    document.body.appendChild(containerEl);
    const plugin = {
      manifest: {
        name: "RSS Dashboard CN",
        version: "0.1.0",
      },
      settings: { locale: "zh-CN" },
    };

    renderAboutTab(containerEl, plugin as unknown as import("../../../main").default);

    expect(
      containerEl.querySelector(".rss-dashboard-about-title")?.textContent,
    ).toBe("RSS Dashboard CN");
    expect(
      containerEl.querySelector(".rss-dashboard-about-version")?.textContent,
    ).toBe("v0.1.0");

    const links = Array.from(containerEl.querySelectorAll("a"));
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute("href")).toBe(
      "https://github.com/amatya-aditya/obsidian-rss-dashboard",
    );
    expect(links[0].getAttribute("target")).toBe("_blank");
    expect(links[0].getAttribute("rel")).toBe("noopener noreferrer");
    expect(links[0].textContent).toContain("上游");

    expect(containerEl.textContent).toContain("Aditya Amatya");
    expect(containerEl.textContent).toContain("2.5.0");
    expect(containerEl.textContent).toContain("不是本分支的支持渠道");
    expect(containerEl.textContent).not.toContain("Marcd35");
    expect(containerEl.textContent).not.toContain("Discord");
    expect(containerEl.textContent).not.toContain("请作者喝咖啡");

    const html = containerEl.innerHTML;
    expect(html).not.toContain("/issues");
    expect(html).not.toContain("buymeacoffee");
    expect(html).not.toContain("ko-fi");
    expect(html).not.toContain("advanced-multi-column");
    expect(html).not.toContain("obsidian-media-slider");
    expect(html).not.toContain("obsidian-zen-space");
  });

  it("renders Chinese fork boundaries by default and keeps English selectable", () => {
    const chineseContainer = document.createElement("div");
    renderAboutTab(
      chineseContainer,
      { manifest: { name: "RSS 信息台", version: "0.1.0" }, settings: { locale: "zh-CN" } } as unknown as import("../../../main").default,
    );
    expect(chineseContainer.textContent).toContain("中文优先");
    expect(chineseContainer.textContent).toContain("手动触发");
    expect(chineseContainer.textContent).toContain("尚未公布公开问题反馈地址");

    const englishContainer = document.createElement("div");
    renderAboutTab(
      englishContainer,
      { manifest: { name: "RSS Dashboard CN", version: "0.1.0" }, settings: { locale: "en" } } as unknown as import("../../../main").default,
    );
    expect(englishContainer.textContent).toContain("Chinese-first");
    expect(englishContainer.textContent).toContain("manually triggered");
    expect(englishContainer.textContent).toContain(
      "No public issue-reporting address has been announced",
    );
  });
});
