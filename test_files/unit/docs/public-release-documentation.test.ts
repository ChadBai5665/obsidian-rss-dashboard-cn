import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function read(relativePath: string): string {
  return readFileSync(relativePath, "utf8");
}

function section(document: string, heading: string): string {
  const marker = `${heading}\n`;
  const start = document.indexOf(marker);
  if (start < 0) throw new Error(`Missing documentation section: ${heading}`);
  const contentStart = start + marker.length;
  const level = heading.match(/^#+/u)?.[0].length ?? 1;
  const nextHeading = document
    .slice(contentStart)
    .search(new RegExp(`\\n#{1,${level}} `, "u"));
  return nextHeading < 0
    ? document.slice(contentStart)
    : document.slice(contentStart, contentStart + nextHeading);
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

  it("documents the public-caption boundary without substituting metadata or speech recognition", () => {
    const readme = section(
      read("README.md"),
      "## YouTube 字幕与播放边界",
    );
    const privacy = section(
      read("docs/PRIVACY.zh-CN.md"),
      "### 采集请求",
    );
    const troubleshooting = section(
      read("docs/TROUBLESHOOTING.zh-CN.md"),
      "## YouTube 字幕或播放不可用",
    );

    for (const document of [readme, privacy, troubleshooting]) {
      expect(document).toContain("公开人工字幕");
      expect(document).toContain("自动生成字幕");
      expect(document).toMatch(/标题.*简介.*不会.*字幕/su);
      expect(document).toMatch(/没有.*公开字幕.*无字幕/su);
    }

    expect(readme).toContain("不伪造字幕");
    expect(readme).toContain("Whisper");
    expect(readme).toContain("ASR");
    expect(readme).toContain("FFmpeg");
    expect(readme).toContain("Python");
    expect(readme).toContain("Bun");
    expect(readme).toContain("字幕 SaaS");
    expect(readme).toMatch(
      /明确.*没有.*公开字幕.*可选工具或字幕提供方.*失败.*无字幕/su,
    );
    expect(readme).toMatch(/本地保存失败.*不会.*无字幕/su);
    expect(troubleshooting).toMatch(
      /明确.*没有.*公开字幕.*可选工具或字幕提供方.*失败.*无字幕/su,
    );
    expect(troubleshooting).toMatch(/本地保存失败.*不会.*无字幕/su);
    expect(troubleshooting).toMatch(
      /显示“需要登录”.*不会读取.*Cookie.*系统默认浏览器/su,
    );
  });

  it("documents the optional yt-dlp process boundary and never presents it as required", () => {
    const install = section(
      read("docs/INSTALL.zh-CN.md"),
      "### 可选的 YouTube 字幕回退",
    );
    const privacy = section(
      read("docs/PRIVACY.zh-CN.md"),
      "### 采集请求",
    );
    const security = section(
      read("docs/SECURITY.md"),
      "### YouTube 字幕进程边界",
    );
    const troubleshooting = section(
      read("docs/TROUBLESHOOTING.zh-CN.md"),
      "## YouTube 字幕或播放不可用",
    );

    for (const document of [install, privacy, security]) {
      expect(document).toContain("可选本地回退");
      expect(document).toContain("execFile");
      expect(document).toContain("不启用 shell");
      expect(document).toMatch(/不读取.*Cookie/su);
      expect(document).toMatch(/不使用.*浏览器.*登录/su);
      expect(document).toMatch(/不下载.*视频.*音频/su);
    }

    expect(install).toContain("yt-dlp --version");
    expect(install).toContain("不会自动安装或更新");
    expect(install).toMatch(/不是.*必需/su);
    expect(install).toMatch(/固定.*参数/su);
    expect(install).toMatch(/不写入.*输出文件/su);
    expect(troubleshooting).toContain("yt-dlp --version");
  });

  it("documents browser-login separation and transcript cache lifecycle", () => {
    const readme = section(
      read("README.md"),
      "## YouTube 字幕与播放边界",
    );
    const install = section(read("docs/INSTALL.zh-CN.md"), "## 更新");
    const privacyDocument = read("docs/PRIVACY.zh-CN.md");
    const privacy = section(privacyDocument, "## 知识库内的数据");
    const privacyRemote = section(
      privacyDocument,
      "### 界面渲染的远程资源",
    );
    const troubleshootingDocument = read("docs/TROUBLESHOOTING.zh-CN.md");
    const troubleshooting = section(
      troubleshootingDocument,
      "## YouTube 字幕或播放不可用",
    );
    const remoteTroubleshooting = section(
      troubleshootingDocument,
      "## 只浏览页面却出现了网络请求",
    );

    for (const document of [readme, privacyRemote, troubleshooting]) {
      expect(document).toContain("系统默认浏览器");
      expect(document).toMatch(/内嵌预览.*登录状态.*不相通/su);
    }

    expect(privacy).toContain(".rss-dashboard-data/content/{itemId}.md");
    expect(privacy).toContain("youtube-transcript");
    expect(privacy).toMatch(/读取.*缓存.*不会.*网络请求/su);
    expect(privacy).toMatch(/重新获取字幕.*原子/su);
    expect(privacy).toMatch(/schemaVersion 1.*继续读取.*不重写/su);
    expect(install).toMatch(/字幕缓存.*原地保留/su);
    expect(readme).toMatch(/重新获取字幕.*替换.*缓存/su);
    expect(remoteTroubleshooting).toContain("只有点击“内嵌预览”");
    expect(remoteTroubleshooting).toContain("youtube-nocookie.com");
    expect(remoteTroubleshooting).not.toContain(
      "打开 YouTube 播放器会请求",
    );
  });
});
