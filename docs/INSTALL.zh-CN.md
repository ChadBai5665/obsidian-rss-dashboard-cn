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

已经完成首次安装后，推荐使用仓库提供的非破坏性本地更新器：

1. 先在“设置 → 第三方插件”中禁用 `RSS Dashboard CN`。
2. 在本仓库中准备好同一版本的 `release/main.js`、`release/manifest.json`、`release/styles.css`。
3. 运行以下命令，把示例路径替换为当前知识库中已经存在的插件目录：

```bash
npm run install:local -- --target "/path/to/vault/.obsidian/plugins/rss-dashboard-cn"
```

目标目录必须显式填写。更新器不会从用户目录推断知识库，也不会创建首次安装所需的插件目录。它会先核对目标确实位于 `.obsidian/plugins/<插件 ID>`、新旧 `manifest.json` 的插件 ID 一致、版本是有效的 SemVer，并确认仓库根目录、`package.json` 与 `release/` 中的版本和三个程序文件完全一致。缺失、陈旧、混合版本、符号链接或硬链接发布文件都会在覆盖前被拒绝。

更新器只替换以下三个程序文件：

- `main.js`
- `manifest.json`
- `styles.css`

以下内容会原地保留：

- 插件设置 `data.json`；
- 知识库根目录的 `.rss-dashboard-data/` 采集记录、缓存、索引和状态；
- `信息收集/` 及其他目录中已经保存的 Markdown；
- 知识库之外的 TikHub 与 AI 外部密钥文件。

更新器不会读取、复制、移动或输出外部密钥文件。它会用固定大小的数据块逐步计算更新前后的 `data.json` 与整个 `.rss-dashboard-data/` 哈希；历史目录中的符号链接只记录链接本身，不会跟随到目录外部。只有确认两者未变化，安装才算成功。

覆盖前，更新器会在目标插件目录旁创建类似下面的时间戳备份，而不是放到系统临时目录：

```text
{vault-root}/.obsidian/plugins/
  rss-dashboard-cn/
  rss-dashboard-cn.backup-20260728T120000.000Z/
```

备份中包含更新前存在的三个程序文件，以及只读的 `data.json` 副本。为避免 Obsidian 把备份目录误认成可执行插件，旧清单在备份中命名为 `manifest.json.restore`，恢复时再改回 `manifest.json`。程序文件使用目标目录内的临时文件完成原子替换；同一个插件同一时间只允许一个安装进程。临时文件和备份文件会在改名提交前同步写入磁盘；如果替换或校验中途失败，更新器会自动恢复原来的三个程序文件，并保留完整备份供人工核对。

命令成功后：

1. 重新加载或完全重启 Obsidian。
2. 再启用 `RSS Dashboard CN`。
3. 打开插件设置，确认显示的版本与新的 `manifest.json` 一致。
4. 打开信息台，确认原有订阅、设置和历史仍在。

### 从时间戳备份恢复

如果更新成功后仍需要回退：

1. 在 Obsidian 中禁用插件并完全退出 Obsidian。
2. 找到插件目录旁最近一次 `rss-dashboard-cn.backup-<时间戳>` 文件夹。
3. 把其中的 `main.js`、`styles.css` 复制回 `rss-dashboard-cn`，再把 `manifest.json.restore` 复制到目标目录并命名为 `manifest.json`，同时替换三个文件。
4. 正常情况下不要恢复 `data.json`，因为更新器从未修改当前设置。只有确认当前设置文件本身损坏、并且明确接受回到备份时刻的设置后，才人工使用备份中的 `data.json`。
5. 重新加载或重启 Obsidian，再启用插件。

也可以继续手动更新：先自行备份需要保留的 Markdown、插件设置和 `.rss-dashboard-data`，确认三个发布文件属于同一版本，再同时替换三个程序文件。

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
