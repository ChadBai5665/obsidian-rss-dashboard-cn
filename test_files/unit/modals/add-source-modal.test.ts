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
  latestPubDate: "2026-07-27T08:30:00.000Z",
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
    expect(modal.contentEl.querySelector(".rss-source-initial-import")).toBeNull();
    expect(modal.contentEl.querySelector(".rss-source-advanced")).toBeNull();
    expect(modal.contentEl.querySelector(".rss-source-subscribe-button")).toBeNull();
  });

  it("keeps initial and failed X identification minimal and retryable", async () => {
    const verified = {
      profile: {
        restId: "123",
        handle: "openai",
        displayName: "OpenAI",
        verified: true,
      },
      proof: Object.freeze({}),
    } as unknown as VerifiedXProfile;
    const verifyX = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("secret"), { code: "not-found" }))
      .mockResolvedValueOnce(verified);
    const modal = new AddSourceModal(obsidian.App.createMock(), options({
      initialKind: "x-account",
      verifyX,
    }));
    modal.open();

    expect(modal.contentEl.querySelector(".rss-source-x-options")).toBeNull();
    expect(modal.contentEl.querySelector(".rss-source-initial-import")).toBeNull();
    expect(modal.contentEl.querySelector(".rss-source-advanced")).toBeNull();
    expect(modal.contentEl.querySelector(".rss-source-subscribe-button")).toBeNull();

    const input = modal.contentEl.querySelector(".rss-source-identity-input") as HTMLInputElement;
    input.value = "@openai";
    input.dispatchEvent(new Event("input"));
    (modal.contentEl.querySelector(".rss-source-detect-button") as HTMLButtonElement).click();
    await flush();

    expect(modal.contentEl.dataset.stage).toBe("failed");
    expect(modal.contentEl.textContent).toContain("没有找到这个 X 账号");
    expect(modal.contentEl.querySelector(".rss-source-x-options")).toBeNull();
    expect(modal.contentEl.querySelector(".rss-source-initial-import")).toBeNull();
    expect(modal.contentEl.querySelector(".rss-source-advanced")).toBeNull();
    expect(modal.contentEl.querySelector(".rss-source-subscribe-button")).toBeNull();

    (modal.contentEl.querySelector(".rss-source-detect-button") as HTMLButtonElement).click();
    await flush();
    expect(modal.contentEl.dataset.stage).toBe("confirmed");
    expect(modal.contentEl.querySelector(".rss-source-x-options")).not.toBeNull();
    expect(modal.contentEl.querySelector(".rss-source-initial-import")).not.toBeNull();
    expect(modal.contentEl.querySelector(".rss-source-advanced")).not.toBeNull();
    expect(modal.contentEl.querySelector(".rss-source-subscribe-button")).not.toBeNull();
  });

  it.each([
    "OpenAI",
    "@OpenAI",
    "https://x.com/OpenAI",
    "https://twitter.com/OpenAI",
  ])("normalizes public X input before provider verification: %s", async (value) => {
    const verified = {
      profile: {
        restId: "123",
        handle: "openai",
        displayName: "OpenAI",
        verified: true,
      },
      proof: Object.freeze({}),
    } as unknown as VerifiedXProfile;
    const verifyX = vi.fn(async () => verified);
    const modal = new AddSourceModal(obsidian.App.createMock(), options({
      initialKind: "x-account",
      verifyX,
    }));
    modal.open();

    const input = modal.contentEl.querySelector(
      ".rss-source-identity-input",
    ) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event("input"));
    (modal.contentEl.querySelector(
      ".rss-source-detect-button",
    ) as HTMLButtonElement).click();
    await flush();

    expect(verifyX).toHaveBeenCalledWith("openai", expect.any(AbortSignal));
    expect(modal.contentEl.dataset.stage).toBe("confirmed");
  });

  it.each([
    "https://x.com/OpenAI/status/1",
    "https://x.com/OpenAI?screen_name=Other",
    "https://twitter.com/OpenAI#Other",
  ])("rejects an X route or query that is not an unambiguous profile: %s", async (value) => {
    const verifyX = vi.fn();
    const modal = new AddSourceModal(obsidian.App.createMock(), options({
      initialKind: "x-account",
      verifyX,
    }));
    modal.open();

    const input = modal.contentEl.querySelector(
      ".rss-source-identity-input",
    ) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event("input"));
    (modal.contentEl.querySelector(
      ".rss-source-detect-button",
    ) as HTMLButtonElement).click();
    await flush();

    expect(verifyX).not.toHaveBeenCalled();
    expect(modal.contentEl.textContent).toContain("X 的账号");
    expect(modal.contentEl.querySelector(".rss-source-subscribe-button")).toBeNull();
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

    expect(modal.contentEl.querySelector(".rss-source-initial-import")).toBeNull();
    expect(modal.contentEl.querySelector(".rss-source-advanced")).toBeNull();
    expect(modal.contentEl.querySelector(".rss-source-subscribe-button")).toBeNull();
    let warning = modal.contentEl.querySelector(".rss-source-empty-warning input") as HTMLInputElement;
    warning.checked = true;
    warning.dispatchEvent(new Event("change"));
    let subscribe = modal.contentEl.querySelector(".rss-source-subscribe-button") as HTMLButtonElement;
    expect(subscribe.disabled).toBe(false);
    expect(modal.contentEl.querySelector(".rss-source-initial-import")).not.toBeNull();
    expect(modal.contentEl.querySelector(".rss-source-advanced")).not.toBeNull();
    warning = modal.contentEl.querySelector(".rss-source-empty-warning input") as HTMLInputElement;
    warning.checked = false;
    warning.dispatchEvent(new Event("change"));
    expect(modal.contentEl.querySelector(".rss-source-subscribe-button")).toBeNull();
    warning = modal.contentEl.querySelector(".rss-source-empty-warning input") as HTMLInputElement;
    warning.checked = true;
    warning.dispatchEvent(new Event("change"));
    subscribe = modal.contentEl.querySelector(".rss-source-subscribe-button") as HTMLButtonElement;
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

  it("fails closed for an empty YouTube feed without an acceptance or subscribe path", async () => {
    const emptyYouTube: YouTubeChannelVerification = Object.freeze({
      ...youtube,
      latestTitle: undefined,
      latestPubDate: undefined,
      hasEntries: false,
    });
    const onSubscribe = vi.fn(async () => true);
    const modal = new AddSourceModal(obsidian.App.createMock(), options({
      initialKind: "youtube",
      verifyYouTube: vi.fn(async () => emptyYouTube),
      onSubscribe,
    }));
    modal.open();
    const input = modal.contentEl.querySelector(
      ".rss-source-identity-input",
    ) as HTMLInputElement;
    input.value = "https://www.youtube.com/@EmptyChannel";
    input.dispatchEvent(new Event("input"));
    (modal.contentEl.querySelector(
      ".rss-source-detect-button",
    ) as HTMLButtonElement).click();
    await flush();

    expect(modal.contentEl.textContent).toContain(
      "已找到频道，但频道的 YouTube RSS 无效。",
    );
    expect(modal.contentEl.querySelector(".rss-source-empty-warning")).toBeNull();
    expect(modal.contentEl.querySelector(".rss-source-verification-card")).toBeNull();
    expect(modal.contentEl.querySelector(".rss-source-initial-import")).toBeNull();
    expect(modal.contentEl.querySelector(".rss-source-subscribe-button")).toBeNull();
    expect(onSubscribe).not.toHaveBeenCalled();
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
    expect(modal.contentEl.querySelector(".rss-source-subscribe-button")).toBeNull();
    (modal.contentEl.querySelectorAll(".rss-source-candidate-option input")[1] as HTMLInputElement).click();
    await flush();
    expect((modal.contentEl.querySelector(".rss-source-subscribe-button") as HTMLButtonElement).disabled).toBe(false);
    expect(verifyRss).toHaveBeenLastCalledWith(
      "https://example.com/blog.xml",
      expect.any(AbortSignal),
    );
  });

  it("shows verified X identity, defaults replies/reposts off, and confirms all history", async () => {
    const profile = {
      restId: "123",
      handle: "openai",
      displayName: "OpenAI",
      avatarUrl: "https://example.com/avatar.png",
      description: "AI research",
      verified: true,
    };
    const verified = {
      profile,
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
    expect(modal.contentEl.textContent).toContain("账号状态：可访问");
    expect(modal.contentEl.textContent).toContain("认证状态：已认证");
    profile.displayName = "Mutated name";
    profile.description = "Mutated description";
    expect(modal.contentEl.textContent).not.toContain("Mutated");
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
      profile: expect.objectContaining({
        restId: "123",
        handle: "openai",
        displayName: "OpenAI",
        description: "AI research",
      }),
      verificationProof: verified.proof,
      includeReplies: false,
      includeReposts: false,
      confirmedAllAvailable: true,
    }));
    const request = onSubscribe.mock.calls[0][0];
    expect(request.profile).not.toBe(profile);
    expect(Object.isFrozen(request.profile)).toBe(true);
  });

  it("keeps advanced tags visible after verification redraws and source changes", async () => {
    const rss: RssWebsiteVerification = {
      inputUrl: "https://example.com/feed.xml",
      siteUrl: "https://example.com/feed.xml",
      candidates: [{ url: "https://example.com/feed.xml", title: "Example", format: "rss" }],
      selected: { url: "https://example.com/feed.xml", title: "Example", format: "rss" },
      hasEntries: true,
    };
    const modal = new AddSourceModal(obsidian.App.createMock(), options({
      initialKind: "youtube",
      verifyRss: vi.fn(async () => rss),
    }));
    modal.open();
    let input = modal.contentEl.querySelector(".rss-source-identity-input") as HTMLInputElement;
    input.value = "@OpenAI";
    input.dispatchEvent(new Event("input"));
    (modal.contentEl.querySelector(".rss-source-detect-button") as HTMLButtonElement).click();
    await flush();

    const tagInput = modal.contentEl.querySelectorAll<HTMLInputElement>(
      ".rss-source-advanced input[type='text']",
    )[1];
    tagInput.value = "ai, research";
    tagInput.dispatchEvent(new Event("input"));

    input = modal.contentEl.querySelector(".rss-source-identity-input") as HTMLInputElement;
    input.value = "@OpenAIResearch";
    input.dispatchEvent(new Event("input"));
    (modal.contentEl.querySelector(".rss-source-detect-button") as HTMLButtonElement).click();
    await flush();

    const redrawnTagInput = modal.contentEl.querySelectorAll<HTMLInputElement>(
      ".rss-source-advanced input[type='text']",
    )[1];
    expect(redrawnTagInput.value).toBe("ai, research");

    (modal.contentEl.querySelector(".rss-source-back-button") as HTMLButtonElement).click();
    (modal.contentEl.querySelector('[data-source-kind="rss-website"]') as HTMLButtonElement).click();
    input = modal.contentEl.querySelector(".rss-source-identity-input") as HTMLInputElement;
    input.value = rss.inputUrl;
    input.dispatchEvent(new Event("input"));
    (modal.contentEl.querySelector(".rss-source-detect-button") as HTMLButtonElement).click();
    await flush();
    const switchedTagInput = modal.contentEl.querySelectorAll<HTMLInputElement>(
      ".rss-source-advanced input[type='text']",
    )[1];
    expect(switchedTagInput.value).toBe("ai, research");
  });

  it("renders public verification metadata and isolates RSS snapshots from adapter mutation", async () => {
    const verification: RssWebsiteVerification = {
      inputUrl: "https://example.com",
      siteUrl: "https://example.com",
      candidates: [{ url: "https://example.com/feed.xml", title: "Example Feed", format: "rss" }],
      selected: { url: "https://example.com/feed.xml", title: "Example Feed", format: "rss" },
      latestTitle: "Original article",
      latestPubDate: "2026-07-26T12:00:00.000Z",
      hasEntries: true,
    };
    const onSubscribe = vi.fn(async () => true);
    const modal = new AddSourceModal(obsidian.App.createMock(), options({
      initialKind: "rss-website",
      verifyRss: vi.fn(async () => verification),
      onSubscribe,
    }));
    modal.open();
    const input = modal.contentEl.querySelector(".rss-source-identity-input") as HTMLInputElement;
    input.value = verification.inputUrl;
    input.dispatchEvent(new Event("input"));
    (modal.contentEl.querySelector(".rss-source-detect-button") as HTMLButtonElement).click();
    await flush();

    verification.candidates[0].title = "Mutated candidate";
    if (verification.selected) verification.selected.title = "Mutated selected";
    verification.latestTitle = "Mutated article";
    expect(modal.contentEl.textContent).toContain("来源类型：RSS / 网站");
    expect(modal.contentEl.textContent).toContain("发布时间：2026-07-26T12:00:00.000Z");
    expect(modal.contentEl.textContent).toContain("Example Feed");
    expect(modal.contentEl.textContent).toContain("Original article");
    expect(modal.contentEl.textContent).not.toContain("Mutated");

    (modal.contentEl.querySelector(".rss-source-subscribe-button") as HTMLButtonElement).click();
    await flush();
    const request = onSubscribe.mock.calls[0][0];
    expect(request.verification).not.toBe(verification);
    expect(request.verification.selected?.title).toBe("Example Feed");
    expect(request.verification.candidates[0].title).toBe("Example Feed");
    expect(request.verification.latestTitle).toBe("Original article");
    expect(Object.isFrozen(request.verification)).toBe(true);
    expect(Object.isFrozen(request.verification.candidates)).toBe(true);
    expect(Object.isFrozen(request.verification.candidates[0])).toBe(true);
    expect(Object.isFrozen(request.verification.selected)).toBe(true);
  });

  it("renders a YouTube channel URL and latest publication metadata", async () => {
    const modal = new AddSourceModal(obsidian.App.createMock(), options({
      initialKind: "youtube",
    }));
    modal.open();
    const input = modal.contentEl.querySelector(".rss-source-identity-input") as HTMLInputElement;
    input.value = "@OpenAI";
    input.dispatchEvent(new Event("input"));
    (modal.contentEl.querySelector(".rss-source-detect-button") as HTMLButtonElement).click();
    await flush();

    expect(modal.contentEl.textContent).toContain("来源类型：YouTube");
    expect(modal.contentEl.textContent).toContain(youtube.channelUrl);
    expect(modal.contentEl.textContent).not.toContain(youtube.feedUrl);
    expect(modal.contentEl.textContent).toContain("发布时间：2026-07-27T08:30:00.000Z");
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

  it("notifies the owning manager after a durable subscription update succeeds", async () => {
    const onSubscribed = vi.fn();
    const modal = new AddSourceModal(obsidian.App.createMock(), options({
      initialKind: "youtube",
      onSubscribed,
    }));
    modal.open();
    const input = modal.contentEl.querySelector(
      ".rss-source-identity-input",
    ) as HTMLInputElement;
    input.value = "@OpenAI";
    input.dispatchEvent(new Event("input"));
    (modal.contentEl.querySelector(
      ".rss-source-detect-button",
    ) as HTMLButtonElement).click();
    await flush();

    (modal.contentEl.querySelector(
      ".rss-source-subscribe-button",
    ) as HTMLButtonElement).click();
    await flush();

    expect(onSubscribed).toHaveBeenCalledTimes(1);
  });

  it("still closes after durable success when the optional owner callback fails", async () => {
    const modal = new AddSourceModal(obsidian.App.createMock(), options({
      initialKind: "youtube",
      onSubscribed: () => {
        throw new Error("owner view no longer exists");
      },
    }));
    modal.open();
    const input = modal.contentEl.querySelector(
      ".rss-source-identity-input",
    ) as HTMLInputElement;
    input.value = "@OpenAI";
    input.dispatchEvent(new Event("input"));
    (modal.contentEl.querySelector(
      ".rss-source-detect-button",
    ) as HTMLButtonElement).click();
    await flush();

    (modal.contentEl.querySelector(
      ".rss-source-subscribe-button",
    ) as HTMLButtonElement).click();
    await flush();

    expect(modal.containerEl.isConnected).toBe(false);
  });

  it("supports keyboard verification, announces status, and keeps advanced settings collapsed", async () => {
    const verifyYouTube = vi.fn(async () => youtube);
    const modal = new AddSourceModal(obsidian.App.createMock(), options({
      initialKind: "youtube",
      verifyYouTube,
    }));
    modal.open();
    expect(modal.contentEl.querySelector(".rss-source-advanced")).toBeNull();
    const input = modal.contentEl.querySelector(".rss-source-identity-input") as HTMLInputElement;
    input.value = "@OpenAI";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();

    expect(verifyYouTube).toHaveBeenCalledTimes(1);
    expect(modal.contentEl.querySelector(".rss-source-verification-card")?.getAttribute("role"))
      .toBe("status");
    const details = modal.contentEl.querySelector(".rss-source-advanced") as HTMLDetailsElement;
    expect(details.open).toBe(false);
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
    ["network-failure", "无法连接 TikHub"],
    ["malformed-response", "返回了无法读取的数据"],
    ["profile-shape-unsupported", "账号资料格式暂不支持"],
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

  it.each([
    ["no-candidate", "请确认账号主页仍可公开访问后重试。"],
    ["required-field-invalid", "请稍后重试，或更新插件后重新识别。"],
    ["identity-conflict", "请确认账号地址无误后重新识别。"],
    ["optional-field-conflict", "请稍后重试，或更新插件后重新识别。"],
    ["unsafe-structure", "请稍后重试；如果持续出现，请更新插件。"],
    ["unknown-shape", "请稍后重试，或更新插件后重新识别。"],
  ] as const)("explains unsupported X profile shape %s without exposing provider data", async (issue, detail) => {
    const providerValue = "provider-secret-value";
    const verifyX = vi.fn(async () => {
      throw Object.assign(new Error(providerValue), {
        code: "profile-shape-unsupported",
        diagnostic: Object.freeze({ issue, providerValue }),
      });
    });
    const modal = new AddSourceModal(obsidian.App.createMock(), options({
      initialKind: "x-account",
      verifyX,
    }));
    modal.open();
    const input = modal.contentEl.querySelector(".rss-source-identity-input") as HTMLInputElement;
    input.value = "openai";
    input.dispatchEvent(new Event("input"));
    (modal.contentEl.querySelector(".rss-source-detect-button") as HTMLButtonElement).click();
    await flush();

    expect(modal.contentEl.textContent).toContain("账号资料格式暂不支持");
    expect(modal.contentEl.textContent).toContain(detail);
    expect(modal.contentEl.textContent).not.toContain(providerValue);
    expect(modal.contentEl.querySelector(".rss-source-subscribe-button")).toBeNull();

    const failedInput = modal.contentEl.querySelector(".rss-source-identity-input") as HTMLInputElement;
    failedInput.value = "anthropic";
    failedInput.dispatchEvent(new Event("input"));
    expect(modal.contentEl.textContent).not.toContain("账号资料格式暂不支持");
    expect(modal.contentEl.textContent).not.toContain(detail);
    expect(verifyX).toHaveBeenCalledTimes(1);
    expect(modal.contentEl.querySelector(".rss-source-subscribe-button")).toBeNull();
  });
});
