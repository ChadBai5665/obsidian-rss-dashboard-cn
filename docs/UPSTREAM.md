# 上游同步策略

RSS Dashboard CN 是 [Aditya Amatya 的 Obsidian RSS Dashboard](https://github.com/amatya-aditya/obsidian-rss-dashboard) 的 MIT 衍生版本。

## 当前基线

- 上游版本：`2.5.0`
- 上游基线提交：`048e739672337b323361cc0ce7d7bfeab7d7416b`
- 上游远程名称：`upstream`
- 上游默认分支：`master`

当前中文分支的功能、隐私边界和数据格式均建立在这一个明确基线上。后续同步时不得把“上游最新”当作已验证状态。

## 获取与审阅上游变化

先获取提交和标签，不直接合并：

```bash
git fetch upstream --tags
git log --oneline --decorate 048e739672337b323361cc0ce7d7bfeab7d7416b..upstream/master
git diff --stat 048e739672337b323361cc0ce7d7bfeab7d7416b..upstream/master
```

在独立同步分支或 worktree 中逐项审阅变化，特别留意 `main.ts`、设置结构、存储迁移、网络请求、文章保存和媒体解析。优先按可审阅的小批次合并或移植；不要在未经测试的情况下直接覆盖中文分支。

同步完成后，更新本文档中的上游版本和完整提交哈希，并在提交说明中记录采用、改写和暂缓的上游变化。

## 必须重新验证的分支不变量

每次同步至少重新验证：

- 插件 ID 始终为 `rss-dashboard-cn`，名称为 `RSS Dashboard CN`，且仅桌面端运行。
- TikHub 与 AI 密钥只保存在知识库外的桌面密钥文件；设置、导出、日志和诊断信息不得包含密钥。
- 简体中文仍是默认语言，英文可选，全部翻译目录通过完整性检查。
- 启动刷新遵守本地日期和刷新间隔；同日重启不会无条件重复刷新。
- 每日采集、来源分片、状态索引和用户状态继续符合当前 collection schema，并保持可恢复写入。
- 保存文章不覆盖现有 Markdown；重复条目打开原文件，同标题冲突使用稳定 ID 后缀。
- AI 仍只在用户明确点击单条操作后调用；采集、排序和 Top 内容选择不依赖模型。
- TikHub 计费请求仍经过启用状态、密钥、请求预算和用户确认边界。

## 同步后的检查

```bash
npm ci
npm run check
npm run release:stage
npm run release:check
npm run check:public
```

若存储、网络、保存或启动刷新发生变化，还需在仓库外的一次性 Obsidian 知识库中重复安装、刷新、失败恢复、重启和卸载冒烟测试。真实 TikHub 或 AI 调用必须使用专用测试凭据，并单独获得授权。
