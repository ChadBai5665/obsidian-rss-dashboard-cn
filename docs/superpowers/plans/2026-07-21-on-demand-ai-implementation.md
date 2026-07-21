# RSS Dashboard CN On-Demand AI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional, manually triggered summary, Chinese translation, core-point extraction, and deep-analysis actions with multiple Chinese/international providers and compatible relays, while keeping collection fully functional without AI.

**Architecture:** Store non-secret AI connection metadata in plugin settings and keys in the external desktop secret store. Provider clients implement either OpenAI Chat Completions or Anthropic Messages behind one text-generation interface. A content-selection service sends only the chosen item's available content and labels its basis. Successful outputs are written as standalone Markdown analysis artifacts; inserting one into a saved note is a separate explicit action.

**Tech Stack:** TypeScript, Obsidian desktop API, OpenAI-compatible Chat Completions, Anthropic-compatible Messages API, Vitest with mocked HTTP responses, external `DesktopSecretStore` from the TikHub plan.

## Global Constraints

- AI is never required for collection, reading, starring, filtering, or Markdown saving.
- Never run summary, translation, ranking, or analysis automatically on refresh, startup, save, or export.
- Provide exactly these manual operations in v1: summary, translate to Simplified Chinese, extract core points, and deep analysis.
- No automatic provider failover. A failed request stays attached to the chosen connection and can be retried manually.
- Never send the whole vault, daily index, unrelated notes, hidden data directory, account subscription list, or TikHub search history.
- Show the user the content basis and approximate input size before sending.
- Missing/invalid key, insufficient balance, rate limit, timeout, empty output, or cancellation must not create an analysis file.
- Store successful AI results separately from collected source data. Source collection records remain factual and model-free.
- Provider model names change frequently; store the exact model ID entered by the user instead of baking a durable default model into code.
- `Claude Code` subscriptions/credentials are not assumed reusable. The settings copy must say that Claude requires an Anthropic API key or a compatible relay.
- Run focused tests before implementation and commit after each completed task.

---

## Task 1: Define AI connections, presets, and additive settings migration

**Files:**

- Create: `src/ai/ai-types.ts`
- Create: `src/ai/provider-presets.ts`
- Create: `src/ai/connection-validation.ts`
- Create: `test_files/unit/ai/provider-presets.test.ts`
- Create: `test_files/unit/ai/connection-validation.test.ts`
- Modify: `src/types/types.ts`
- Modify: `src/utils/settings-loader.ts`
- Modify: `test_files/unit/utils/settings-loader.test.ts`

- [ ] **Step 1: Write failing preset and migration tests**

Cover all visible choices:

| Preset | Protocol | Base URL |
|---|---|---|
| Kimi | OpenAI Chat | `https://api.moonshot.cn/v1` |
| DeepSeek | OpenAI Chat | `https://api.deepseek.com` |
| Qwen | OpenAI Chat | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| GLM | OpenAI Chat | `https://open.bigmodel.cn/api/paas/v4` |
| OpenAI | OpenAI Chat | `https://api.openai.com/v1` |
| Claude | Anthropic Messages | `https://api.anthropic.com` |
| OpenAI-compatible relay | OpenAI Chat | user-supplied HTTPS |
| Anthropic-compatible relay | Anthropic Messages | user-supplied HTTPS |

Also assert a fresh settings payload contains an empty connection list and no key fields.

- [ ] **Step 2: Run tests and confirm AI contracts are absent**

Run: `npm run test:unit -- test_files/unit/ai/provider-presets.test.ts test_files/unit/ai/connection-validation.test.ts test_files/unit/utils/settings-loader.test.ts`

Expected: FAIL.

- [ ] **Step 3: Define connection metadata**

Use:

```ts
export type AiProtocol = "openai-chat" | "anthropic-messages";
export type AiProviderKind = "kimi" | "deepseek" | "qwen" | "glm" | "openai" | "claude" | "openai-compatible" | "anthropic-compatible";

export interface AiConnection {
  id: string;
  name: string;
  providerKind: AiProviderKind;
  protocol: AiProtocol;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxInputCharacters: number;
  enabled: boolean;
}

export interface AiSettings {
  connections: AiConnection[];
  defaultConnectionId?: string;
}
```

Defaults per new connection: 60-second timeout, 80,000-character input cap, enabled. No connection is created automatically because every operation needs a real model ID and key.

- [ ] **Step 4: Validate endpoints and model fields**

Require HTTPS; permit `http://127.0.0.1` and `http://localhost` only for explicitly named local relays. Reject credentials in URLs, query strings, fragments, empty model IDs, control characters, and duplicate connection IDs. Normalize trailing slashes without removing intentional base paths.

- [ ] **Step 5: Add settings migration**

Add `ai: { connections: [] }` without changing feeds, collection, TikHub, or locale settings. Remove/ignore any legacy accidental `apiKey` fields during load and never re-save them.

- [ ] **Step 6: Re-run tests**

Run: `npm run test:unit -- test_files/unit/ai/provider-presets.test.ts test_files/unit/ai/connection-validation.test.ts test_files/unit/utils/settings-loader.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/ai/ai-types.ts src/ai/provider-presets.ts src/ai/connection-validation.ts src/types/types.ts src/utils/settings-loader.ts test_files/unit/ai test_files/unit/utils/settings-loader.test.ts
git commit -m "feat: define optional AI connections"
```

## Task 2: Implement OpenAI-compatible and Anthropic-compatible clients

**Files:**

- Create: `src/ai/providers/text-generation-provider.ts`
- Create: `src/ai/providers/openai-chat-provider.ts`
- Create: `src/ai/providers/anthropic-messages-provider.ts`
- Create: `src/ai/providers/provider-factory.ts`
- Create: `src/ai/providers/provider-error.ts`
- Create: `test_files/unit/ai/providers/openai-chat-provider.test.ts`
- Create: `test_files/unit/ai/providers/anthropic-messages-provider.test.ts`
- Create: `test_files/unit/ai/providers/provider-factory.test.ts`

- [ ] **Step 1: Write failing protocol contract tests**

For OpenAI-compatible connections assert:

```text
POST {baseUrl}/chat/completions
Authorization: Bearer {api-key}
Content-Type: application/json
body: { model, messages, stream: false }
result: choices[0].message.content
```

For Anthropic-compatible connections assert:

```text
POST {baseUrl}/v1/messages
x-api-key: {api-key}
anthropic-version: 2023-06-01
Content-Type: application/json
body: { model, max_tokens, system, messages }
result: concatenate response content blocks whose type is text
```

The URL joiner must avoid duplicate `/v1` segments for base URLs already ending with `/v1`, while preserving Qwen's `/compatible-mode/v1` and GLM's `/api/paas/v4` paths.

- [ ] **Step 2: Add failing error tests**

Cover 400 invalid request/model, 401/403 invalid key/authorization, 402 insufficient balance, 408/504 timeout, 429 rate limit, 5xx provider failure, malformed JSON, empty choices/content, network offline, and abort. Public errors expose no headers or response bodies.

- [ ] **Step 3: Run tests and confirm providers are absent**

Run: `npm run test:unit -- test_files/unit/ai/providers/openai-chat-provider.test.ts test_files/unit/ai/providers/anthropic-messages-provider.test.ts test_files/unit/ai/providers/provider-factory.test.ts`

Expected: FAIL.

- [ ] **Step 4: Define one provider interface**

```ts
export interface TextGenerationRequest {
  system: string;
  user: string;
  maxOutputTokens: number;
  signal?: AbortSignal;
}

export interface TextGenerationResult {
  text: string;
  providerRequestId?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface TextGenerationProvider {
  generate(request: TextGenerationRequest): Promise<TextGenerationResult>;
}
```

The factory resolves the key from `DesktopSecretStore` immediately before construction. No key appears in the connection metadata or returned provider status.

- [ ] **Step 5: Implement both protocols without SDK dependencies**

Use the existing request abstraction and plain JSON to keep the plugin bundle small. Set `store: false` for OpenAI Chat requests where accepted; if a compatible provider rejects that optional field, the preset can omit it through an explicit capability flag, not an automatic retry that doubles charges.

- [ ] **Step 6: Re-run tests**

Run: `npm run test:unit -- test_files/unit/ai/providers/openai-chat-provider.test.ts test_files/unit/ai/providers/anthropic-messages-provider.test.ts test_files/unit/ai/providers/provider-factory.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/ai/providers test_files/unit/ai/providers
git commit -m "feat: add compatible AI provider clients"
```

## Task 3: Select and label only the current item's content

**Files:**

- Create: `src/ai/content/ai-content-selector.ts`
- Create: `src/ai/content/content-size.ts`
- Create: `test_files/unit/ai/content/ai-content-selector.test.ts`
- Create: `test_files/unit/ai/content/content-size.test.ts`
- Modify: `src/collection/content-repository.ts`
- Modify: `src/utils/full-article-fetch.ts`

- [ ] **Step 1: Write failing content-selection tests**

Cover this priority and labeling:

1. Previously saved/fetched full text: `full-text`.
2. Standard feed description/content: `feed`.
3. X post text: `x-post`.
4. YouTube title plus channel-provided description: `title-description`.

Also prove that selection never reads unrelated vault files and that full-text network fetch happens only after an explicit AI action requests it.

- [ ] **Step 2: Run tests and confirm failure**

Run: `npm run test:unit -- test_files/unit/ai/content/ai-content-selector.test.ts test_files/unit/ai/content/content-size.test.ts`

Expected: FAIL.

- [ ] **Step 3: Define the selected-content contract**

```ts
export interface SelectedAiContent {
  itemId: string;
  title: string;
  sourceName: string;
  sourceUrl?: string;
  content: string;
  basis: ContentBasis;
  characterCount: number;
  truncated: boolean;
}
```

- [ ] **Step 4: Implement selection and bounded truncation**

Read `ContentRepository` before making a network request. Strip scripts/styles and normalize whitespace without rewriting the source's language. When content exceeds `maxInputCharacters`, keep the beginning and end with an explicit `[中间内容因输入上限省略]` marker. Do not silently claim the complete article was analyzed.

- [ ] **Step 5: Keep YouTube limitations explicit**

Do not fetch captions, transcripts, audio, or video. The selector must label YouTube input as title/description even when the description is long.

- [ ] **Step 6: Re-run tests**

Run: `npm run test:unit -- test_files/unit/ai/content/ai-content-selector.test.ts test_files/unit/ai/content/content-size.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/ai/content src/collection/content-repository.ts src/utils/full-article-fetch.ts test_files/unit/ai/content
git commit -m "feat: bound AI input to the selected item"
```

## Task 4: Add stable prompts and a manual AI operation service

**Files:**

- Create: `src/ai/prompts/prompt-types.ts`
- Create: `src/ai/prompts/prompt-builder.ts`
- Create: `src/ai/ai-operation-service.ts`
- Create: `test_files/unit/ai/prompts/prompt-builder.test.ts`
- Create: `test_files/unit/ai/ai-operation-service.test.ts`

- [ ] **Step 1: Write prompt and service tests**

Assert:

- Each operation has a distinct Chinese instruction and records its operation ID.
- Source content is delimited as untrusted reference text and cannot add tool/system instructions.
- Summary asks for claims and evidence, not a value score.
- Translation preserves names, links, numbers, and uncertainty.
- Core points distinguish source claims from the model's inference.
- Deep analysis requests assumptions, evidence, counterarguments, novelty, authority, and unresolved questions, but does not declare an objective Top 10.
- One click makes exactly one provider request after confirmation.
- No configured/default connection, missing key, invalid key, timeout, cancellation, or empty output returns a successful result.
- The service does not retry another provider.

- [ ] **Step 2: Run tests and confirm failure**

Run: `npm run test:unit -- test_files/unit/ai/prompts/prompt-builder.test.ts test_files/unit/ai/ai-operation-service.test.ts`

Expected: FAIL.

- [ ] **Step 3: Define operations**

```ts
export type AiOperation = "summary" | "translate-zh-cn" | "core-points" | "deep-analysis";
```

All prompts include source title, source name, original URL if present, content basis, truncation status, and the delimited content. Ask the model to state when evidence is insufficient.

- [ ] **Step 4: Implement manual-only orchestration**

Expose only:

```ts
run(input: {
  operation: AiOperation;
  item: CollectedItem;
  connectionId: string;
  fetchFullText: boolean;
  signal?: AbortSignal;
}): Promise<AiOperationResult>;
```

Do not register this service with startup refresh, collection, background import, save hooks, or timers.

- [ ] **Step 5: Re-run tests**

Run: `npm run test:unit -- test_files/unit/ai/prompts/prompt-builder.test.ts test_files/unit/ai/ai-operation-service.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ai/prompts src/ai/ai-operation-service.ts test_files/unit/ai/prompts test_files/unit/ai/ai-operation-service.test.ts
git commit -m "feat: add manual AI research operations"
```

## Task 5: Persist successful AI results as separate Markdown artifacts

**Files:**

- Create: `src/ai/analysis-result.ts`
- Create: `src/ai/analysis-repository.ts`
- Create: `src/ai/analysis-markdown.ts`
- Create: `test_files/unit/ai/analysis-repository.test.ts`
- Create: `test_files/unit/ai/analysis-markdown.test.ts`

- [ ] **Step 1: Write failing storage tests**

Assert:

- Output path is `.rss-dashboard-data/analysis/{item-id}/{timestamp}-{operation}.md`.
- Timestamp is UTC `YYYYMMDDTHHmmssSSS` and collisions append `-2`, `-3` rather than overwrite.
- Frontmatter records schema version, result ID, source item ID/URL, operation, created time, connection name, provider kind, model, content basis, character count, and truncation status.
- API keys, prompts, request headers, and complete provider response envelopes are absent.
- Empty/whitespace output is rejected before any directory/file write.
- Failed writes leave no partially named final file.

- [ ] **Step 2: Run tests and confirm failure**

Run: `npm run test:unit -- test_files/unit/ai/analysis-repository.test.ts test_files/unit/ai/analysis-markdown.test.ts`

Expected: FAIL.

- [ ] **Step 3: Define result metadata**

```ts
export interface AiAnalysisResult {
  schemaVersion: 1;
  id: string;
  itemId: string;
  operation: AiOperation;
  createdAt: string;
  connectionId: string;
  connectionName: string;
  providerKind: AiProviderKind;
  model: string;
  contentBasis: ContentBasis;
  inputCharacterCount: number;
  inputTruncated: boolean;
  text: string;
}
```

- [ ] **Step 4: Render safe Markdown and write atomically**

Escape frontmatter string values and keep model output in the body. Prefix the body with a visible provenance note. Write a temp sibling first and rename only after a non-empty complete body exists.

- [ ] **Step 5: Re-run tests**

Run: `npm run test:unit -- test_files/unit/ai/analysis-repository.test.ts test_files/unit/ai/analysis-markdown.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ai/analysis-result.ts src/ai/analysis-repository.ts src/ai/analysis-markdown.ts test_files/unit/ai/analysis-repository.test.ts test_files/unit/ai/analysis-markdown.test.ts
git commit -m "feat: store AI outputs as separate artifacts"
```

## Task 6: Add AI connection settings and explicit test actions

**Files:**

- Create: `src/settings/tabs/ai-settings-tab.ts`
- Create: `src/modals/ai-connection-modal.ts`
- Create: `test_files/unit/settings/ai-settings-tab.test.ts`
- Create: `test_files/unit/modals/ai-connection-modal.test.ts`
- Modify: `src/settings/settings-tab.ts`
- Modify: `src/settings/tab-names.ts`
- Modify: `src/i18n/en.ts`
- Modify: `src/i18n/zh-cn.ts`

- [ ] **Step 1: Write UI tests first**

Cover:

- All eight preset/relay choices are visible.
- Presets populate protocol/base URL but require the user to enter a model ID.
- Keys are written to `DesktopSecretStore`, then cleared from the input.
- Editing metadata does not reveal or overwrite a stored key unless a new key is entered.
- Delete key and delete connection are separate confirmed actions.
- Test connection is manual and sends a minimal `回复 OK` request only after the user clicks.
- Missing key, invalid key, insufficient balance, rate limit, and timeout show distinct localized messages.
- The Claude description says an Anthropic API key/compatible relay is required and a Claude Code login is not imported.
- Connection order and default connection persist without secrets.

- [ ] **Step 2: Run tests and confirm failure**

Run: `npm run test:unit -- test_files/unit/settings/ai-settings-tab.test.ts test_files/unit/modals/ai-connection-modal.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement connection CRUD and key status**

Save metadata through normal settings and keys directly through the external store. Display only `已配置密钥` / `未配置密钥`; never show a prefix/suffix fingerprint.

- [ ] **Step 4: Add provider-specific explanatory copy**

Explain that Qwen may use a workspace-specific base URL, relay compatibility varies, model IDs must match the selected account/region, and test calls may incur provider charges. Do not promise current model availability.

- [ ] **Step 5: Re-run tests**

Run: `npm run test:unit -- test_files/unit/settings/ai-settings-tab.test.ts test_files/unit/modals/ai-connection-modal.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/settings/tabs/ai-settings-tab.ts src/modals/ai-connection-modal.ts src/settings/settings-tab.ts src/settings/tab-names.ts src/i18n test_files/unit/settings/ai-settings-tab.test.ts test_files/unit/modals/ai-connection-modal.test.ts
git commit -m "feat: add optional AI connection settings"
```

## Task 7: Add manual item actions, preview, cancellation, and explicit insertion

**Files:**

- Create: `src/modals/ai-operation-modal.ts`
- Create: `src/ai/analysis-note-inserter.ts`
- Create: `test_files/unit/modals/ai-operation-modal.test.ts`
- Create: `test_files/unit/ai/analysis-note-inserter.test.ts`
- Modify: `src/components/article-list/utils/article-actions.ts`
- Modify: `src/components/article-list/utils/article-context-menu.ts`
- Modify: `src/views/reader-view.ts`
- Create: `test_files/unit/views/reader-view-ai-actions.test.ts`
- Modify: `src/i18n/en.ts`
- Modify: `src/i18n/zh-cn.ts`

- [ ] **Step 1: Write interaction tests**

Assert:

- Buttons exist for four manual operations in list context and reader view.
- Clicking with no enabled connection opens settings guidance and makes no request.
- Preview shows source, content basis, approximate characters, truncation, chosen connection/model, and full-text fetch toggle when applicable.
- Confirm starts one request; cancel aborts and creates no file.
- A success shows the saved analysis path and actions to open it or insert it into the item's saved note.
- Insert requires an existing saved note or first offers the normal save action.
- Inserting the same result twice is idempotent.
- User-authored note text is preserved byte-for-byte outside the inserted block.

- [ ] **Step 2: Run tests and confirm failure**

Run: `npm run test:unit -- test_files/unit/modals/ai-operation-modal.test.ts test_files/unit/ai/analysis-note-inserter.test.ts test_files/unit/views/reader-view-ai-actions.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement preview and confirmation**

No network call occurs before confirmation. Disable duplicate confirm clicks while a request is active. Keep the modal open with a retry option on safe errors; retries always use the same selected connection unless the user explicitly selects another.

- [ ] **Step 4: Implement marker-based note insertion**

Append this block to the saved note:

```md
<!-- RSS-DASHBOARD-CN:AI:${result.id}:START -->
## AI 分析：${operationLabel}

> 生成时间：... · 模型：... · 内容依据：...

${result.text}
<!-- RSS-DASHBOARD-CN:AI:${result.id}:END -->
```

If the result ID markers already exist, focus/open the block instead of writing again. Never update or replace another result block.

- [ ] **Step 5: Re-run tests**

Run: `npm run test:unit -- test_files/unit/modals/ai-operation-modal.test.ts test_files/unit/ai/analysis-note-inserter.test.ts test_files/unit/views/reader-view-ai-actions.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/modals/ai-operation-modal.ts src/ai/analysis-note-inserter.ts src/components/article-list/utils/article-actions.ts src/components/article-list/utils/article-context-menu.ts src/views/reader-view.ts src/i18n test_files/unit/modals/ai-operation-modal.test.ts test_files/unit/ai/analysis-note-inserter.test.ts test_files/unit/views/reader-view-ai-actions.test.ts
git commit -m "feat: expose manual AI actions per item"
```

## Task 8: Verify AI privacy boundaries and provider compatibility

**Files:**

- Create: `test_files/unit/ai/ai-privacy-boundary.test.ts`
- Modify only other files if verification exposes a defect.

- [ ] **Step 1: Add a privacy-boundary integration test**

Create a fake vault containing unrelated notes, collection files, saved notes, and a selected item. Spy on outbound JSON and prove only the selected item's metadata/content appear. Assert no vault paths, other titles, source lists, secret-file path, TikHub keywords, or unrelated text are present.

- [ ] **Step 2: Run the privacy test**

Run: `npm run test:unit -- test_files/unit/ai/ai-privacy-boundary.test.ts`

Expected: PASS after any necessary fixes.

- [ ] **Step 3: Run all AI and security tests**

Run: `npm run test:unit -- test_files/unit/ai test_files/unit/security test_files/unit/settings/ai-settings-tab.test.ts test_files/unit/modals/ai-connection-modal.test.ts test_files/unit/modals/ai-operation-modal.test.ts`

Expected: PASS.

- [ ] **Step 4: Perform bounded live smoke tests**

Using user-provided keys stored only through the plugin UI, test at least one OpenAI-compatible Chinese provider and, if available, one Anthropic-compatible connection. Use one short synthetic item for each. Verify successful Markdown provenance and then delete the synthetic output. Do not record keys or raw HTTP logs.

- [ ] **Step 5: Run full checks**

Run: `npm run audit:i18n && npm run test:unit && npm run lint && npm run build`

Expected: all commands exit 0.

- [ ] **Step 6: Scan tracked files for key-like material**

Run: `git grep -n -E '(sk-[A-Za-z0-9_-]{16,}|Bearer [A-Za-z0-9._-]{12,}|x-api-key["'"'"']?[[:space:]]*:)' -- ':!test_files/unit/security/*' ':!docs/superpowers/plans/*'`

Expected: no matches.

- [ ] **Step 7: Commit verification tests/fixes**

```bash
git add test_files/unit/ai/ai-privacy-boundary.test.ts
git add -u
git commit -m "test: verify AI privacy boundaries"
```

## Acceptance Checklist

- [ ] Collection works identically with zero AI connections.
- [ ] Kimi, DeepSeek, Qwen, GLM, OpenAI, Claude, and both relay protocols can be configured.
- [ ] Model IDs and compatible base URLs remain editable instead of becoming stale hard-coded assumptions.
- [ ] Summary, Chinese translation, core points, and deep analysis run only after an explicit item-level confirmation.
- [ ] YouTube AI input is labeled title/description and never implies transcript analysis.
- [ ] Missing/invalid credentials and provider failures create no empty artifact and trigger no fallback provider.
- [ ] Successful results are separate, provenance-rich Markdown files and can be explicitly inserted without overwriting notes.
- [ ] Only selected content is sent; whole-vault transmission is covered by an integration test.
- [ ] Unit tests, localization audit, lint, and build pass.
