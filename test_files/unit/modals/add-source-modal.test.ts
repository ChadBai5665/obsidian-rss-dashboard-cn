import { beforeEach, describe, expect, it, vi } from "vitest";
import * as obsidian from "obsidian";
import { AddSourceModal } from "../../../src/modals/source-onboarding/add-source-modal";
import type { RssWebsiteVerification } from "../../../src/services/source-verification/rss-website-discovery";
import type { YouTubeChannelVerification } from "../../../src/services/source-verification/youtube-channel-resolver";
import type { VerifiedXProfile } from "../../../src/sources/tikhub/x-profile-resolver";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";

const flush = async () => await new Promise((resolve) => setTimeout(resolve, 0));

const youtube: YouTubeChannelVerification = Object.freeze({
  channelId: "UC1234567890123456789012",
  channelName: "OpenAI",
  channelUrl: "https://www.youtube.com/channel/UC1234567890123456789012",
  feedUrl: "https://www.youtube.com/feeds/videos.xml?channel_id=UC1234567890123456789012",
  latestTitle: "Latest video",
  hasEntries: true,
});

function options(overrides: Record<string, unknown> = {}) {
  return {
    locale: "zh-CN" as const,
    verifyRss: vi.fn(),
    verifyYouTube: vi.fn(async () => youtube),
    verifyX: vi.fn(),
    onSubscribe: vi.fn(async () => true),
    onOpenSettings: vi.fn(),
    xRequestCaps: { run: 40, day: 100 },
    ...overrides,
  };
}

beforeEach(() => {
  installObsidianDomPolyfills();
  document.body.empty();
  vi.restoreAllMocks();
});

describe("AddSourceModal", () => {
  it("shows three accessible cards and keeps navigation in one modal", () => {
    const modal = new AddSourceModal(obsidian.App.createMock(), options());
    modal.open();
    const cards = modal.contentEl.querySelectorAll(".rss-source-kind-card");
    expect(cards).toHaveLength(3);
    expect(Array.from(cards).map((card) => card.textContent)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("RSS / 网站"),
        expect.stringContaining("YouTube"),
        expect.stringContaining("X 账号"),
      ]),
    );

    (modal.contentEl.querySelector('[data-source-kind="youtube"]') as HTMLButtonElement).click();
    expect(modal.contentEl.querySelector("h2")?.textContent).toBe("添加 YouTube 频道");
    (modal.contentEl.querySelector(".rss-source-back-button") as HTMLButtonElement).click();
    expect(modal.contentEl.querySelectorAll(".rss-source-kind-card")).toHaveLength(3);
    expect(modal.containerEl.isConnected).toBe(true);
  });

  it("invalidates an earlier verification as soon as the input changes", async () => {
    const verifyYouTube = vi.fn(async () => youtube);
    const modal = new AddSourceModal(obsidian.App.createMock(), options({
      initialKind: "youtube",
      verifyYouTube,
    }));
    modal.open();
    const input = modal.contentEl.querySelector(".rss-source-identity-input") as HTMLInputElement;
    input.value = "https://www.youtube.com/@OpenAI";
    input.dispatchEvent(new Event("input"));
    (modal.contentEl.querySelector(".rss-source-detect-button") as HTMLButtonElement).click();
    expect(modal.contentEl.getAttribute("data-stage")).toBe("checking");
    await flush();

    expect(modal.contentEl.textContent).toContain("连接成功");
    expect(modal.contentEl.querySelector(".rss-source-verification-card")).not.toBeNull();
    const subscribe = modal.contentEl.querySelector(".rss-source-subscribe-button") as HTMLButtonElement;
    expect(subscribe.disabled).toBe(false);

    const confirmedInput = modal.contentEl.querySelector(".rss-source-identity-input") as HTMLInputElement;
    confirmedInput.value = "https://www.youtube.com/@Changed";
    confirmedInput.dispatchEvent(new Event("input"));
    expect(modal.contentEl.querySelector(".rss-source-verification-card")).toBeNull();
    expect((modal.contentEl.querySelector(".rss-source-subscribe-button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("requires an explicit warning acceptance for an empty RSS feed", async () => {
    const verification: RssWebsiteVerification = Object.freeze({
      inputUrl: "https://example.com",
      siteUrl: "https://example.com",
      candidates: [{ url: "https://example.com/feed.xml", title: "Example", format: "rss" }],
      selected: { url: "https://example.com/feed.xml", title: "Example", format: "rss" },
      hasEntries: false,
    });
    const onSubscribe = vi.fn(async () => true);
    const modal = new AddSourceModal(obsidian.App.createMock(), options({
      initialKind: "rss-website",
      verifyRss: vi.fn(async () => verification),
      onSubscribe,
    }));
    modal.open();
    const input = modal.contentEl.querySelector(".rss-source-identity-input") as HTMLInputElement;
    input.value = "https://example.com";
    input.dispatchEvent(new Event("input"));
    (modal.contentEl.querySelector(".rss-source-detect-button") as HTMLButtonElement).click();
    await flush();

    const subscribe = modal.contentEl.querySelector(".rss-source-subscribe-button") as HTMLButtonElement;
    expect(subscribe.disabled).toBe(true);
    const warning = modal.contentEl.querySelector(".rss-source-empty-warning input") as HTMLInputElement;
    warning.checked = true;
    warning.dispatchEvent(new Event("change"));
    expect(subscribe.disabled).toBe(false);
    warning.checked = false;
    warning.dispatchEvent(new Event("change"));
    expect(subscribe.disabled).toBe(true);
    warning.checked = true;
    warning.dispatchEvent(new Event("change"));
    expect(subscribe.disabled).toBe(false);
    subscribe.click();
    await flush();
    expect(onSubscribe).toHaveBeenCalledWith(expect.objectContaining({
      kind: "rss-website",
      verification,
      selectedCandidateUrl: "https://example.com/feed.xml",
      acceptedEmptyFeedWarning: true,
      initialImportPolicy: { mode: "lookback-days", days: 7 },
    }));
  });

  it("lets the user choose among multiple RSS candidates before subscribing", async () => {
    const verification: RssWebsiteVerification = {
      inputUrl: "https://example.com",
      siteUrl: "https://example.com",
      candidates: [
        { url: "https://example.com/news.xml", title: "News", format: "rss" },
        { url: "https://example.com/blog.xml", title: "Blog", format: "atom" },
      ],
      hasEntries: true,
    };
    const selectedVerification: RssWebsiteVerification = {
      inputUrl: "https://example.com/blog.xml",
      siteUrl: "https://example.com/blog.xml",
      candidates: [verification.candidates[1]],
      selected: verification.candidates[1],
      hasEntries: true,
    };
    const verifyRss = vi.fn()
      .mockResolvedValueOnce(verification)
      .mockResolvedValueOnce(selectedVerification);
    const modal = new AddSourceModal(obsidian.App.createMock(), options({
      initialKind: "rss-website",
      verifyRss,
    }));
    modal.open();
    const input = modal.contentEl.querySelector(".rss-source-identity-input") as HTMLInputElement;
    input.value = "https://example.com";
    input.dispatchEvent(new Event("input"));
    (modal.contentEl.querySelector(".rss-source-detect-button") as HTMLButtonElement).click();
    await flush();
    expect(modal.contentEl.querySelectorAll(".rss-source-candidate-option")).toHaveLength(2);
    expect((modal.contentEl.querySelector(".rss-source-subscribe-button") as HTMLButtonElement).disabled).toBe(true);
    (modal.contentEl.querySelectorAll(".rss-source-candidate-option input")[1] as HTMLInputElement).click();
    await flush();
    expect((modal.contentEl.querySelector(".rss-source-subscribe-button") as HTMLButtonElement).disabled).toBe(false);
    expect(verifyRss).toHaveBeenLastCalledWith(
      "https://example.com/blog.xml",
      expect.any(AbortSignal),
    );
  });

  it("shows verified X identity, defaults replies/reposts off, and confirms all history", async () => {
    const verified = {
      profile: Object.freeze({
        restId: "123",
        handle: "openai",
        displayName: "OpenAI",
        avatarUrl: "https://example.com/avatar.png",
        description: "AI research",
        verified: true,
      }),
      proof: Object.freeze({}),
    } as unknown as VerifiedXProfile;
    const onSubscribe = vi.fn(async () => true);
    const modal = new AddSourceModal(obsidian.App.createMock(), options({
      initialKind: "x-account",
      verifyX: vi.fn(async () => verified),
      onSubscribe,
    }));
    modal.open();
    const input = modal.contentEl.querySelector(".rss-source-identity-input") as HTMLInputElement;
    input.value = "@openai";
    input.dispatchEvent(new Event("input"));
    (modal.contentEl.querySelector(".rss-source-detect-button") as HTMLButtonElement).click();
    await flush();
    expect(modal.contentEl.textContent).toContain("OpenAI");
    expect(modal.contentEl.textContent).toContain("@openai");
    expect((modal.contentEl.querySelector('[data-option="include-replies"]') as HTMLInputElement).checked).toBe(false);
    expect((modal.contentEl.querySelector('[data-option="include-reposts"]') as HTMLInputElement).checked).toBe(false);

    const policy = modal.contentEl.querySelector(".rss-source-initial-import-select") as HTMLSelectElement;
    policy.value = "all";
    policy.dispatchEvent(new Event("change"));
    (modal.contentEl.querySelector(".rss-source-subscribe-button") as HTMLButtonElement).click();
    expect(document.body.textContent).toContain("单次上限 40 次");
    expect(document.body.textContent).toContain("每日上限 100 次");
    expect(onSubscribe).not.toHaveBeenCalled();
    const confirm = document.querySelector(".rss-source-history-confirm-button") as HTMLButtonElement;
    confirm.click();
    await flush();
    expect(onSubscribe).toHaveBeenCalledWith(expect.objectContaining({
      kind: "x-account",
      profile: verified.profile,
      verificationProof: verified.proof,
      includeReplies: false,
      includeReposts: false,
      confirmedAllAvailable: true,
    }));
  });

  it("localizes verification failures and offers settings for TikHub failures", async () => {
    const modal = new AddSourceModal(obsidian.App.createMock(), options({
      initialKind: "x-account",
      verifyX: vi.fn(async () => {
        throw Object.assign(new Error("secret"), { code: "missing-key" });
      }),
    }));
    modal.open();
    const input = modal.contentEl.querySelector(".rss-source-identity-input") as HTMLInputElement;
    input.value = "openai";
    input.dispatchEvent(new Event("input"));
    (modal.contentEl.querySelector(".rss-source-detect-button") as HTMLButtonElement).click();
    await flush();
    expect(modal.contentEl.textContent).toContain("尚未配置 TikHub API 密钥");
    expect(modal.contentEl.querySelector(".rss-source-open-settings-button")).not.toBeNull();
  });

  it("invalidates a pending check when cancelled and ignores its late result", async () => {
    let complete: ((value: YouTubeChannelVerification) => void) | undefined;
    const verifyYouTube = vi.fn(async () => await new Promise<YouTubeChannelVerification>(
      (resolve) => { complete = resolve; },
    ));
    const onSubscribe = vi.fn(async () => true);
    const modal = new AddSourceModal(obsidian.App.createMock(), options({
      initialKind: "youtube",
      verifyYouTube,
      onSubscribe,
    }));
    modal.open();
    const input = modal.contentEl.querySelector(".rss-source-identity-input") as HTMLInputElement;
    input.value = "@OpenAI";
    input.dispatchEvent(new Event("input"));
    (modal.contentEl.querySelector(".rss-source-detect-button") as HTMLButtonElement).click();
    (modal.contentEl.querySelector(".rss-source-onboarding-footer button") as HTMLButtonElement).click();
    complete?.(youtube);
    await flush();

    expect(modal.containerEl.isConnected).toBe(false);
    expect(modal.contentEl.childElementCount).toBe(0);
    expect(onSubscribe).not.toHaveBeenCalled();
  });

  it("keeps the chooser visible when a check finishes after going back", async () => {
    let complete: ((value: YouTubeChannelVerification) => void) | undefined;
    const modal = new AddSourceModal(obsidian.App.createMock(), options({
      initialKind: "youtube",
      verifyYouTube: vi.fn(async () => await new Promise<YouTubeChannelVerification>(
        (resolve) => { complete = resolve; },
      )),
    }));
    modal.open();
    const input = modal.contentEl.querySelector(".rss-source-identity-input") as HTMLInputElement;
    input.value = "@OpenAI";
    input.dispatchEvent(new Event("input"));
    (modal.contentEl.querySelector(".rss-source-detect-button") as HTMLButtonElement).click();
    (modal.contentEl.querySelector(".rss-source-back-button") as HTMLButtonElement).click();
    complete?.(youtube);
    await flush();

    expect(modal.contentEl.querySelectorAll(".rss-source-kind-card")).toHaveLength(3);
    expect(modal.contentEl.dataset.stage).toBe("choose");
  });

  it("prevents duplicate subscribe submissions while the first is pending", async () => {
    let finish: ((value: boolean) => void) | undefined;
    const onSubscribe = vi.fn(async () => await new Promise<boolean>(
      (resolve) => { finish = resolve; },
    ));
    const modal = new AddSourceModal(obsidian.App.createMock(), options({
      initialKind: "youtube",
      onSubscribe,
    }));
    modal.open();
    const input = modal.contentEl.querySelector(".rss-source-identity-input") as HTMLInputElement;
    input.value = "@OpenAI";
    input.dispatchEvent(new Event("input"));
    (modal.contentEl.querySelector(".rss-source-detect-button") as HTMLButtonElement).click();
    await flush();
    const subscribe = modal.contentEl.querySelector(".rss-source-subscribe-button") as HTMLButtonElement;
    subscribe.click();
    subscribe.click();

    expect(onSubscribe).toHaveBeenCalledTimes(1);
    expect(subscribe.disabled).toBe(true);
    finish?.(true);
    await flush();
  });

  it("supports keyboard verification, announces status, and keeps advanced settings collapsed", async () => {
    const verifyYouTube = vi.fn(async () => youtube);
    const modal = new AddSourceModal(obsidian.App.createMock(), options({
      initialKind: "youtube",
      verifyYouTube,
    }));
    modal.open();
    const details = modal.contentEl.querySelector(".rss-source-advanced") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    const input = modal.contentEl.querySelector(".rss-source-identity-input") as HTMLInputElement;
    input.value = "@OpenAI";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();

    expect(verifyYouTube).toHaveBeenCalledTimes(1);
    expect(modal.contentEl.querySelector(".rss-source-verification-card")?.getAttribute("role"))
      .toBe("status");
    const confirmedInput = modal.contentEl.querySelector(".rss-source-identity-input") as HTMLInputElement;
    confirmedInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(modal.containerEl.isConnected).toBe(false);
  });

  it.each([
    ["input-empty", "请先输入信息源"],
    ["input-too-long", "输入的信息源地址过长"],
    ["input-unsafe", "不支持的字符"],
    ["url-invalid", "有效 HTTP 或 HTTPS"],
    ["x-invalid-handle", "X 的账号"],
    ["youtube-invalid-handle", "YouTube 频道"],
    ["tikhub-disabled", "TikHub 尚未启用"],
    ["invalid-key", "密钥无效"],
    ["insufficient-balance", "余额不足"],
    ["rate-limited", "请求过于频繁"],
    ["not-found", "没有找到这个 X 账号"],
    ["network-timeout", "请求超时"],
    ["provider-failure", "TikHub 暂时无法识别"],
    ["network-request-failed", "无法连接这个信息源"],
    ["youtube-channel-not-found", "没有找到这个 YouTube 频道"],
    ["youtube-feed-invalid", "YouTube RSS 无效"],
    ["feed-not-found", "没有找到可用的 RSS"],
  ])("shows safe localized feedback for %s", async (code, expected) => {
    const modal = new AddSourceModal(obsidian.App.createMock(), options({
      initialKind: "x-account",
      verifyX: vi.fn(async () => {
        throw Object.assign(new Error("private provider response"), { code });
      }),
    }));
    modal.open();
    const input = modal.contentEl.querySelector(".rss-source-identity-input") as HTMLInputElement;
    input.value = "openai";
    input.dispatchEvent(new Event("input"));
    (modal.contentEl.querySelector(".rss-source-detect-button") as HTMLButtonElement).click();
    await flush();
    expect(modal.contentEl.textContent).toContain(expected);
    expect(modal.contentEl.textContent).not.toContain("private provider response");
  });
});
