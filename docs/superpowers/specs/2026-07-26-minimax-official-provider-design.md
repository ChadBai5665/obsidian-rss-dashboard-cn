# MiniMax 官方平台连接设计

## 目标

在现有 AI 连接编辑器中加入 MiniMax 中国大陆版和国际版两个官方服务商选项，让用户可以直接填写对应区域的 API Key、模型 ID，并沿用现有的连接测试、手动 AI 操作和外部密钥存储流程。

本改动不迁移、不重写也不删除任何现有连接、API Key、订阅配置、采集历史或 Markdown 文件。

## 官方接口依据

MiniMax 两个区域都提供 OpenAI Chat Completions 兼容接口，并使用 Bearer API Key：

- 中国大陆版：`https://api.minimaxi.com/v1/chat/completions`
- 国际版：`https://api.minimax.io/v1/chat/completions`

对应官方文档：

- <https://platform.minimaxi.com/docs/api-reference/text-openai-api>
- <https://platform.minimax.io/docs/api-reference/text-openai-api>

模型 ID 不固化为插件默认值。编辑器保持必填、允许手动填写，并提示使用账户实际开放的完整模型 ID，例如当前官方文档中的 `MiniMax-M3`，而不是简写 `M3`。

## 用户界面

“服务商或兼容接口”下拉框新增两个选项：

1. `MiniMax（中国大陆）`
2. `MiniMax（国际）`

选择后分别自动锁定官方接口地址：

- 大陆版：`https://api.minimaxi.com/v1`
- 国际版：`https://api.minimax.io/v1`

接口协议显示为 `OpenAI Chat Completions`。模型 ID 保持空白并由用户填写。API Key 继续使用现有通用密码输入框，不增加新的密钥字段。

MiniMax 专属提示说明区域必须与 API Key 所属平台一致，并要求使用完整模型 ID。

## 连接与请求架构

新增两个稳定的服务商类型：

- `minimax-cn`
- `minimax-global`

二者都复用现有 `openai-chat` 协议和 `OpenAiChatProvider`。连接验证层把各自的官方地址视为固定地址，拒绝把大陆密钥与国际接口地址混合，也拒绝任意第三方地址冒充官方预设。第三方 MiniMax 中转仍应使用现有“OpenAI 兼容中转站”。

MiniMax 官方 OpenAPI 已将 `max_tokens` 标记为弃用，因此这两个服务商发送 `max_completion_tokens`。其他现有 OpenAI 兼容服务商保持当前请求字段，不随本改动改变。

响应继续使用现有 OpenAI Chat Completions 解析逻辑；错误继续映射为密钥无效、余额不足、限流、模型或请求无效、网络失败等现有中文提示。

## 密钥与数据安全

API Key 仍按连接 UUID 保存到知识库外的 `secrets.json`，不进入 `data.json`、导出文件、日志、Git 或测试夹具。

编辑现有连接并切换到 MiniMax 时保持原连接 UUID。API Key 输入框留空表示保留该 UUID 对应的已保存密钥；填写新密钥并测试不会自动保存，只有点击“保存”才会替换。

升级安装只替换：

- `main.js`
- `manifest.json`
- `styles.css`

不得删除或覆盖当前安装目录中的 `data.json`、备份文件，也不得修改 `.rss-dashboard-data/`、保存的 Markdown 或外部 `secrets.json`。

## 兼容性与迁移

现有服务商类型和连接数据全部保持有效。新增联合类型成员不会改变旧连接的序列化形状，不需要设置迁移。

现有错误或未知服务商仍按原验证规则拒绝。公开设置导入、AI 分析结果校验、服务商显示名称和隐私边界需要认识两个新类型，但不得扩大导出内容或发送范围。

## 测试设计

实施必须遵守测试先行，并至少覆盖：

1. 预设列表包含大陆版和国际版及各自固定地址。
2. 连接验证接受两个新类型，拒绝区域与地址不匹配。
3. 编辑弹窗显示两个中文选项、固定接口和 MiniMax 专属提示。
4. MiniMax 请求发送到正确的 `/v1/chat/completions` 地址。
5. MiniMax 使用 `max_completion_tokens`，不发送 `max_tokens`。
6. 现有 Kimi、DeepSeek、千问、GLM、OpenAI、Claude 和兼容中转请求保持不变。
7. MiniMax 连接仍从只读密钥接口取值，密钥不进入请求错误、设置或导出。
8. 旧连接无需迁移即可继续加载；新增连接可保存、测试、设为默认并执行手动 AI 操作。

完成后运行专项测试、国际化审计、完整 `npm run check`、发布产物检查，并在当前 Obsidian 知识库中只替换三个运行文件进行真实界面验证。真实 MiniMax API 请求仍由用户在界面中确认执行。
