# RSS Dashboard CN 中文安装指南

RSS Dashboard CN `0.1.0` 当前采用手动安装。你需要拿到同一版本的三个独立文件：

- `main.js`
- `manifest.json`
- `styles.css`

不要只复制源代码，也不要混用不同版本的文件。

## 首次安装

1. 在 Obsidian 中打开目标知识库。
2. 打开知识库在操作系统中的文件夹，并显示隐藏文件。
3. 进入知识库的 `.obsidian/plugins/`。如果 `plugins` 不存在，先创建它。
4. 创建文件夹 `rss-dashboard-cn`。
5. 把三个文件复制进去，最终结构必须是：

```text
{vault-root}/.obsidian/plugins/rss-dashboard-cn/
  main.js
  manifest.json
  styles.css
```

6. 回到 Obsidian，重新加载应用；如果插件列表仍未更新，完全退出后重新打开。
7. 打开“设置 → 第三方插件”。若安全模式仍开启，按 Obsidian 的提示允许第三方插件。
8. 找到 `RSS Dashboard CN` 并启用。
9. 打开命令面板，运行“打开 RSS 信息台”确认插件可以加载。

`{vault-root}` 表示当前知识库根目录，不是操作系统用户目录。

## 第一次配置

1. 先添加一个普通 RSS、网站、播客或 YouTube 来源，确认基础采集可用。
2. 默认刷新模式是“每天打开时刷新”。Obsidian 必须保持打开；关闭后没有后台任务。
3. 只有需要 X 账号或主题采集时才启用 TikHub，并设置单次/每日请求上限。
4. 只有需要手动摘要、翻译、核心观点或深度分析时才添加 AI 连接。
5. TikHub 和 AI 密钥保存在知识库之外；未配置密钥不会影响普通采集。

## 更新

1. 先在“设置 → 第三方插件”中禁用 `RSS Dashboard CN`。
2. 备份需要保留的 Markdown、插件设置和 `.rss-dashboard-data`。
3. 确认新的 `main.js`、`manifest.json`、`styles.css` 来自同一个版本。
4. 一次性替换插件目录中的三个旧文件。
5. 重新加载或重启 Obsidian，再启用插件。
6. 打开插件设置，确认显示的版本与新的 `manifest.json` 一致。

不要保留旧 `main.js` 配新 `manifest.json`，也不要只替换其中一个文件。

## 卸载

1. 在 Obsidian 中禁用插件。
2. 完全退出 Obsidian。
3. 删除准确的插件安装目录：

```text
{vault-root}/.obsidian/plugins/rss-dashboard-cn/
```

4. 重新打开 Obsidian，确认插件不再出现。

卸载不会自动删除：

- `.rss-dashboard-data/` 中的采集记录、缓存、状态、分片和 AI 分析产物；
- `信息收集/每日采集/`；
- `信息收集/已保存/`；
- 你配置的其他保存目录；
- 从分片或知识库元数据模式回退后保留的恢复副本；
- 操作系统用户目录中的外部 `secrets.json`。

如果还要清理数据，请按 [隐私与数据说明](PRIVACY.zh-CN.md) 的顺序操作。若 `信息收集` 还存有其他笔记，只删除你已经核对属于插件的文件，不要删除整个目录。

## 安装后看不到插件

依次检查：

1. 文件夹名必须是 `rss-dashboard-cn`。
2. 三个文件必须直接位于该文件夹中，不能再多套一层压缩包目录。
3. `manifest.json` 必须能正常打开，且 `id` 为 `rss-dashboard-cn`。
4. Obsidian 已允许第三方插件。
5. 已重新加载或完全重启 Obsidian。
6. 当前打开的知识库就是你复制文件的那个知识库。

仍无法加载时，参见 [中文故障排查](TROUBLESHOOTING.zh-CN.md)。
