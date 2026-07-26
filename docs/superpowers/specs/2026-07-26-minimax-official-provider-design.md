# MiniMax 官方平台与默认模型设计

## 目标

在现有 AI 连接编辑器中加入 MiniMax 中国大陆版和国际版两个官方服务商选项，让用户可以直接填写对应区域的 API Key，并沿用现有的连接测试、手动 AI 操作和外部密钥存储流程。

同时为所有具名官方平台提供插件内置的当前推荐模型：模型 ID 留空时跟随插件默认值；填写模型 ID 时固定使用用户指定值。OpenAI 与 Anthropic 兼容中转站没有统一的平台默认模型，仍必须填写模型 ID。

本改动不迁移、不重写也不删除任何现有连接、API Key、订阅配置、采集历史或 Markdown 文件。

## 官方接口依据

MiniMax 两个区域都提供 OpenAI Chat Completions 兼容接口，并使用 Bearer API Key：

- 中国大陆版：`https://api.minimaxi.com/v1/chat/completions`
- 国际版：`https://api.minimax.io/v1/chat/completions`

对应官方文档：

- <https://platform.minimaxi.com/docs/api-reference/text-openai-api>
- <https://platform.minimax.io/docs/api-reference/text-openai-api>

MiniMax 模型 ID 使用官方完整名称，例如 `MiniMax-M3`，不能使用 `M3` 这类界面简写。

## 默认模型规则

插件内置下表作为 2026-07-26 版本的推荐默认值：

| 官方平台 | 留空时实际使用的模型 | 选择依据 |
| --- | --- | --- |
| Kimi | `kimi-latest` | 官方提供的最新稳定模型别名 |
| DeepSeek | `deepseek-v4-pro` | 当前最新旗舰质量模型 |
| 千问 | `qwen3.7-plus` | 当前稳定的通用模型，避开 preview 型号 |
| GLM | `glm-5.2` | 当前最新通用旗舰模型 |
| OpenAI | `gpt-5.6` | 官方当前推荐的通用旗舰模型 |
| Claude | `claude-sonnet-5` | 当前通用能力、速度与成本较均衡的模型 |
| MiniMax（中国大陆） | `MiniMax-M3` | 大陆平台当前最新通用模型 |
| MiniMax（国际） | `MiniMax-M3` | 国际平台当前最新通用模型 |

默认值依据以下官方模型页面维护：

- Kimi：<https://platform.kimi.com/docs/models>
- DeepSeek：<https://api-docs.deepseek.com/quick_start/pricing/>
- 千问：<https://help.aliyun.com/zh/model-studio/models>
- GLM：<https://docs.bigmodel.cn/cn/guide/start/introduction>
- OpenAI：<https://developers.openai.com/api/docs/models>
- Claude：<https://platform.claude.com/docs/en/about-claude/models/overview>
- MiniMax：中国大陆与国际版接口文档见上一节

这里的“平台默认”是插件随版本发布的、经过核对的推荐模型映射，不是把空模型直接发送给服务商。多数模型接口仍要求请求中明确包含 `model`。因此运行测试或 AI 操作前，插件必须先把空值解析成表中的实际模型 ID，再发送请求。

连接中保存的模型字段遵循以下规则：

- 具名官方平台留空：持久化 `model: ""`，表示跟随插件默认值。
- 具名官方平台非空：持久化用户填写的完整模型 ID，表示固定模型。
- OpenAI 或 Anthropic 兼容中转站：模型 ID 仍为必填；留空不能保存或测试。
- 后续插件版本更新默认模型映射时，所有仍为空的连接自动使用新默认值；已经填写的连接绝不被覆盖。

## 用户界面

“服务商或兼容接口”下拉框新增两个选项：

1. `MiniMax（中国大陆）`
2. `MiniMax（国际）`

选择后分别自动锁定官方接口地址：

- 大陆版：`https://api.minimaxi.com/v1`
- 国际版：`https://api.minimax.io/v1`

接口协议显示为 `OpenAI Chat Completions`。API Key 继续使用现有通用密码输入框，不增加新的密钥字段。

所有具名官方平台的“模型 ID”输入框改为可选，并显示当前解析结果，例如 `留空使用默认模型：MiniMax-M3`。用户填写内容后，该内容就是固定模型；清空后恢复跟随默认。连接列表显示 `默认（MiniMax-M3）` 或对应平台的实际默认模型，不能只显示空白。

兼容中转站继续提示“模型 ID 必填”，不提供默认值。切换服务商时模型输入框清空，避免把上个平台的模型 ID 错带到新平台；编辑已有连接时则保留该连接当前已保存的值。

MiniMax 专属提示说明区域必须与 API Key 所属平台一致，并提示手动指定时使用完整模型 ID。

## 连接与请求架构

新增两个稳定的服务商类型：

- `minimax-cn`
- `minimax-global`

二者都复用现有 `openai-chat` 协议和 `OpenAiChatProvider`。连接验证层把各自的官方地址视为固定地址，拒绝把大陆密钥与国际接口地址混合，也拒绝任意第三方地址冒充官方预设。第三方 MiniMax 中转仍应使用现有“OpenAI 兼容中转站”。

官方平台预设增加 `defaultModel`。连接验证允许具名官方平台保存空模型，但兼容中转站仍拒绝空模型。请求前通过单一解析函数生成只用于本次运行的“有效连接”：如果保存值为空，就填入该平台的 `defaultModel`；如果保存值非空，就原样使用。Provider 只接收已经解析且模型非空的有效连接，避免每个 Provider 各自实现默认逻辑。

连接测试、请求预览、实际 AI 操作、分析结果及 Markdown 来源记录都必须使用并显示本次实际发送的模型 ID，不能把空字符串或含糊的“默认”写入结果。这样即使未来插件默认值更新，历史分析仍能追溯当时实际使用的模型。

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

现有服务商类型和连接数据全部保持有效。所有已经填写模型 ID 的旧连接继续固定使用原值，不会因默认模型功能而改变。仅新建连接或用户主动清空模型字段后，才进入跟随默认模式。

新增联合类型成员以及允许官方连接保存空模型不会改变旧连接的序列化形状，不需要设置迁移。导入和导出设置时保留空模型标记，但不导出 API Key；导入后仍根据具名服务商解析默认模型。兼容中转站的空模型继续作为无效配置拒绝。

现有错误或未知服务商仍按原验证规则拒绝。公开设置导入、AI 分析结果校验、服务商显示名称和隐私边界需要认识两个新类型，但不得扩大导出内容或发送范围。

## 测试设计

实施必须遵守测试先行，并至少覆盖：

1. 预设列表包含大陆版和国际版及各自固定地址。
2. 默认模型表包含全部八个具名官方平台，兼容中转站没有默认模型。
3. 具名官方连接允许保存空模型，并在测试和运行前解析成当前默认值。
4. 用户填写的模型覆盖默认值，现有非空模型连接保持原样。
5. OpenAI 与 Anthropic 兼容中转站仍拒绝空模型。
6. 连接验证接受两个 MiniMax 类型，拒绝区域与地址不匹配。
7. 编辑弹窗显示两个 MiniMax 中文选项、固定接口、默认模型提示和 MiniMax 专属提示。
8. 切换服务商清空未保存的模型输入；编辑已有连接保留其已保存值。
9. 连接列表、请求预览、实际请求、分析结果和 Markdown 记录都显示实际解析后的模型 ID。
10. MiniMax 请求发送到正确的 `/v1/chat/completions` 地址。
11. MiniMax 使用 `max_completion_tokens`，不发送 `max_tokens`。
12. 现有 Kimi、DeepSeek、千问、GLM、OpenAI、Claude 和兼容中转请求除默认模型解析外保持不变。
13. MiniMax 连接仍从只读密钥接口取值，密钥不进入请求错误、设置或导出。
14. 旧连接无需迁移即可继续加载；新增连接可保存、测试、设为默认并执行手动 AI 操作。

完成后运行专项测试、国际化审计、完整 `npm run check`、发布产物检查，并在当前 Obsidian 知识库中只替换三个运行文件进行真实界面验证。真实 MiniMax API 请求仍由用户在界面中确认执行。
