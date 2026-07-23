# RSS Dashboard CN 隐私与数据说明

本文对应 `0.1.0` 的实际实现。插件以本地存储为主，但订阅刷新、可选 TikHub 和手动 AI 操作都可能向外部服务发送请求。

## 知识库内的数据

以下为默认位置，均相对知识库根目录：

| 路径 | 内容 |
|---|---|
| `.obsidian/plugins/rss-dashboard-cn/data.json` | 插件设置元数据；可包含订阅定义、显示设置、文件夹、X 账号/关键词和非密钥连接元数据 |
| `.rss-dashboard-data/collections/YYYY-MM-DD.jsonl` | 按本机日期保存的采集记录 |
| `.rss-dashboard-data/content/{itemId}.md` | 用户明确读取或抓取过的单条全文缓存 |
| `.rss-dashboard-data/state/item-index.json` | 采集项目索引 |
| `.rss-dashboard-data/state/source-refresh.json` | 每个来源的刷新状态 |
| `.rss-dashboard-data/state/tikhub-requests.json` | 本机日 TikHub 请求预算账本 |
| `.rss-dashboard-data/analysis/{itemId}/` | 手动 AI 操作生成的独立 Markdown 产物 |
| `.rss-dashboard-data/feeds/` | 默认 Feed 分片 |
| `.rss-dashboard-data/user-state.json` | 分片存储下的已读、收藏、保存等用户状态 |
| `信息收集/每日采集/` | 每日 Markdown 索引 |
| `信息收集/已保存/` | 用户主动保存的 Markdown |

用户可以修改采集根、每日索引、保存笔记、Feed 分片和元数据目录。使用“知识库位置”保存设置元数据时，配置目录下会出现 `data.json`；切回插件默认位置后，原文件会保留为恢复副本。

从分片存储切回传统 JSON 只改变当前写入模式，不自动删除 `.rss-dashboard-data/feeds/`。这些保留内容可能仍包含订阅和文章状态，不能把它们当成空目录公开分享。

## 知识库外的密钥文件

TikHub 和所有 AI 连接共用一个外部 `secrets.json`。默认路径为：

- macOS：`~/Library/Application Support/rss-dashboard-cn/secrets.json`
- Linux：`${XDG_CONFIG_HOME}/rss-dashboard-cn/secrets.json`；未设置绝对的 `XDG_CONFIG_HOME` 时使用 `~/.config/rss-dashboard-cn/secrets.json`
- Windows：`%APPDATA%\rss-dashboard-cn\secrets.json`；`APPDATA` 不可用时使用当前用户目录下的 `AppData\Roaming\rss-dashboard-cn\secrets.json`

在 macOS/Linux 等 Unix 系统上，插件创建目录时限制为当前用户访问（`0700`），密钥文件限制为当前用户读写（`0600`），并在写入时重新校正权限。Windows 版本依赖操作系统账户和文件系统访问控制；它不是 Windows Credential Manager、DPAPI 或其他加密凭证库。

插件没有实现 macOS Keychain、Windows Credential Manager 或系统级硬件密钥保护。拥有当前系统账户或足够文件权限的人仍可能读取该文件。

## 设置导入与导出

- TikHub 和 AI 的 API 密钥不进入公共设置导出或便携设置包。
- 外部密钥文件路径、请求历史、采集正文、AI 分析产物和保存笔记不应进入公共设置导出。
- 包含来源定义的导出仍可能包含 Feed 地址、X 账号、关键词、文件夹名等个人信息；分享前必须人工检查。
- 导入后，TikHub 会被关闭并清除连接绑定；AI 连接会换成本机新标识并保持停用。用户需要重新配置或绑定密钥。

不要把完整 `data.json`、`.rss-dashboard-data`、原始 TikHub/模型响应或真实 Feed 导出作为公开问题附件。

## 外部请求类别

根据代码核对，插件可能发生以下外部请求：

1. 刷新你配置的 RSS、Atom、JSON Feed、播客 Feed 或网站，并在需要时进行 Feed 自动发现。
2. 获取你打开或保存的单条网页全文、图片或网站图标。
3. 获取 YouTube 频道/视频 Feed 和元数据；播放时使用 YouTube 的隐私增强嵌入域。插件不下载字幕、音频或视频。
4. 解析播客平台、Apple Podcasts、Mastodon 或内置发现/Small Web 页面所需的公开元数据。
5. 当直连受限且你启用了代理能力时，请求配置或内置的代理地址；代理会看到目标 URL。
6. 仅在 TikHub 已启用且刷新 X 账号或 X 主题时，请求配置的 TikHub 接口。
7. 仅在你对选中的单条信息确认 AI 操作时，请求所选 AI 服务商或兼容中转地址。

第三方服务可能记录请求、IP、账号用量并产生费用，具体取决于服务商政策。

## AI 发送边界

AI 操作不会自动运行。确认后发送的是当前选中单条信息的受限快照，包括操作所需的标题、来源名称/地址、正文或简介以及明确的操作指令。

- 不扫描或发送其他订阅、其他文章、其他笔记、保存目录或整个知识库。
- YouTube 只使用标题和简介。
- 普通 Feed/网站/播客只有在用户明确选择全文时，才会为该条内容尝试抓取全文。
- X 使用已采集的单条帖子内容；不会为了 AI 操作再搜索其他 X 内容。
- 每次确认只选择一个连接；没有自动故障转移。

AI 生成结果会先作为独立 Markdown 保存在 `.rss-dashboard-data/analysis/`。用户随后可以打开结果，或明确选择把带所有权标记的结果插入已保存笔记。

## 遥测与日志

当前代码未集成产品遥测、行为分析 SDK 或后台使用统计上报。插件仍会为完成上述功能访问外部来源，Obsidian、操作系统、代理或第三方服务可能各自保留网络日志。

安全诊断只应包含版本、操作系统类型、来源种类计数、结构化状态码和时间等最小信息。复制前会显示预览；仍建议人工复核。

## 安全备份

备份前先判断你的目标：

- 只保留知识成果：备份 `信息收集/每日采集/`、`信息收集/已保存/` 和自定义保存目录。
- 保留订阅与状态：同时备份插件 `data.json`、配置的元数据位置和 `.rss-dashboard-data/`。
- 迁移到另一台电脑：不要通过知识库同步密钥文件；在新设备上重新配置 TikHub/AI 密钥。

备份文件本身可能包含私人订阅和正文，应使用你信任的存储位置。

## 安全删除顺序

1. 在 Obsidian 中禁用 `RSS Dashboard CN`，然后完全退出 Obsidian。
2. 备份要保留的 Markdown 和设置。
3. 若要卸载，删除准确的插件目录 `.obsidian/plugins/rss-dashboard-cn/`。
4. 若要删除采集数据，核对当前设置中的采集根和存储目录，再删除默认 `.rss-dashboard-data/` 或对应的自定义目录。
5. 若要删除用户可见 Markdown，只删除已核对属于插件的 `信息收集/每日采集/`、`信息收集/已保存/` 或自定义目录中的文件；不要删除混有其他笔记的上级目录。
6. 核对是否存在回退后保留的旧分片目录或旧元数据 `data.json`，按需单独删除。
7. 若不再使用 TikHub/AI，最后删除当前操作系统对应的外部 `secrets.json`；如果同一系统账户下还有其他知识库使用本插件，删除它会同时移除这些连接密钥。

不要使用指向整个知识库、整个用户目录或未展开变量的递归删除操作。
