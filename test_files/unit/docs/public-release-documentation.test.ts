import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function read(relativePath: string): string {
  return readFileSync(relativePath, "utf8");
}

describe("public release documentation", () => {
  it("discloses the default proxy mode, complete target URL exposure, and disable tradeoff", () => {
    const readme = read("README.md");
    const privacy = read("docs/PRIVACY.zh-CN.md");
    const troubleshooting = read("docs/TROUBLESHOOTING.zh-CN.md");

    for (const document of [readme, privacy, troubleshooting]) {
      expect(document).toContain("默认已启用");
      expect(document).toContain("自动轮换");
      expect(document).toContain("完整目标 URL");
      expect(document).toContain("代理运营方");
      expect(document).toContain("设置 → 常规 → 代理");
      expect(document).toMatch(/关闭.*代理.*降低.*成功率/su);
    }

    expect(privacy).toContain("先尝试直接请求");
    expect(privacy).toContain("不构成隐私背书");
  });

  it("separates collection traffic, browser-rendered remote resources, and local Markdown", () => {
    const privacy = read("docs/PRIVACY.zh-CN.md");
    const troubleshooting = read("docs/TROUBLESHOOTING.zh-CN.md");

    expect(privacy).toContain("采集请求");
    expect(privacy).toContain("界面渲染的远程资源");
    expect(privacy).toContain("本地 Markdown 与远程引用");
    expect(privacy).toContain("https://www.google.com/s2/favicons");
    expect(privacy).toContain("IP 地址");
    expect(privacy).toContain("来源域名");
    expect(privacy).toContain("目标域名");
    expect(privacy).toContain("youtube-nocookie.com");
    expect(privacy).toMatch(/仍.*第三方请求/su);
    expect(troubleshooting).toContain("远程封面");
    expect(troubleshooting).toContain("Google favicon");
    expect(troubleshooting).toContain("本地 Markdown");
  });

  it("keeps pre-public security guidance and the scorecard free of unfinished public claims", () => {
    const security = read("docs/SECURITY.md");
    const scorecard = read("docs/plugin-scorecard.md");
    const obsoleteCommunityListing = `${["community", "obsidian", "md"].join(".")}/plugins/rss-dashboard`;
    const unfinished = new RegExp(
      `${["TO", "DO"].join("")}|${["TB", "D"].join("")}|your-name|your-repo`,
      "iu",
    );

    expect(security).toContain("尚未公布公开安全报告渠道");
    expect(security).toContain("不要提交或粘贴");
    expect(security).toContain("完整 `data.json`");
    expect(security).toContain("原始 TikHub");
    expect(security).toContain("真实 X 账号");
    expect(security).toContain("知识库路径");
    expect(security).not.toContain(
      "github.com/amatya-aditya/obsidian-rss-dashboard/issues",
    );
    expect(security).not.toMatch(unfinished);

    expect(scorecard).toContain("RSS Dashboard CN 0.1.0");
    expect(scorecard).toContain("已验证");
    expect(scorecard).toContain("尚未验证");
    expect(scorecard).not.toContain(obsoleteCommunityListing);
    expect(scorecard).not.toMatch(unfinished);
  });
});
