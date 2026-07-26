# MiniMax Official Providers and Default Models Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add official MiniMax mainland and international connections, and let every named official provider follow a release-maintained default model when its saved model field is blank while preserving explicit user model selections.

**Architecture:** Extend the immutable provider presets with official base URLs and `defaultModel`, preserve `model: ""` as a non-secret follow-default marker, and resolve it into a concrete request-only connection at one shared boundary. Both direct providers and the operation service use that resolved connection so requests, previews, test results, analysis artifacts, and Markdown provenance always show the actual model ID.

**Tech Stack:** TypeScript 5.9, Obsidian 1.8 plugin APIs, Vitest 4, existing OpenAI Chat Completions and Anthropic Messages providers, npm/esbuild release checks.

## Global Constraints

- Built-in defaults for this release are exactly: Kimi `kimi-latest`, DeepSeek `deepseek-v4-pro`, Qwen `qwen3.7-plus`, GLM `glm-5.2`, OpenAI `gpt-5.6`, Claude `claude-sonnet-5`, MiniMax mainland `MiniMax-M3`, and MiniMax international `MiniMax-M3`.
- Named official providers may persist `model: ""`; a non-empty saved model always overrides the built-in default and must never be overwritten by upgrades.
- `openai-compatible` and `anthropic-compatible` connections have no default model and must still reject a blank model.
- MiniMax mainland uses `https://api.minimaxi.com/v1`; MiniMax international uses `https://api.minimax.io/v1`; both use OpenAI Chat Completions with a Bearer API key.
- MiniMax sends `max_completion_tokens`; existing providers keep their current `max_tokens` behavior.
- Never copy API keys into `data.json`, exports, logs, fixtures, Git, or error text. Keep UUID-based keys in the existing external `secrets.json` only.
- Do not migrate or rewrite existing connections, subscriptions, collected history, analysis files, or saved Markdown.
- Live installation may replace only `main.js`, `manifest.json`, and `styles.css` in the user-confirmed Obsidian plugin directory. Private filesystem paths must remain outside the public repository.
- Do not make a real MiniMax request from development scripts. The user performs the paid connection test from the Obsidian editor after installation.
- Do not create or publish a new version tag or GitHub Release in this change; the branch, pull request, and merged source are the GitHub delivery surface unless the user separately requests a release.

---

## File Map

- `src/ai/ai-types.ts`: provider-kind union and persisted non-secret connection shape.
- `src/ai/provider-presets.ts`: canonical official endpoints, built-in defaults, creation helper, and request-time resolution helper.
- `src/ai/connection-validation.ts`: hostile-input-safe validation for persisted blank/default models and fixed official URLs.
- `src/ai/providers/provider-factory.ts`: secret lookup, resolved-connection construction, and provider-specific request capabilities.
- `src/ai/providers/openai-chat-provider.ts`: OpenAI-compatible request body and MiniMax token-limit field switch.
- `src/ai/ai-operation-service.ts`: operation orchestration and actual-model provenance.
- `src/modals/ai-operation-modal.ts`: preview and result provenance checks using the resolved model.
- `src/modals/ai-connection-modal.ts`: MiniMax choices, optional official model field, default placeholder, and relay-required validation.
- `src/settings/tabs/ai-settings-tab.ts`: provider display names and `默认（实际模型）` connection-list text.
- `src/ai/analysis-result.ts`: safe allowlist for the two new provider kinds.
- `src/i18n/zh-cn.ts`, `src/i18n/en.ts`: provider labels, model-default copy, MiniMax region guidance, and validation copy.
- `README.md`, `docs/TROUBLESHOOTING.zh-CN.md`: user-facing behavior and troubleshooting for default versus pinned models.
- `test_files/unit/**`: focused validation, provider request, modal, provenance, export, and privacy regressions.

---

### Task 1: Add canonical MiniMax presets and safe default-model resolution

**Files:**
- Modify: `src/ai/ai-types.ts`
- Modify: `src/ai/provider-presets.ts`
- Modify: `src/ai/connection-validation.ts`
- Modify: `src/ai/analysis-result.ts`
- Modify: `src/modals/ai-connection-modal.ts`
- Modify: `src/settings/tabs/ai-settings-tab.ts`
- Modify: `src/i18n/zh-cn.ts`
- Modify: `src/i18n/en.ts`
- Test: `test_files/unit/ai/provider-presets.test.ts`
- Test: `test_files/unit/ai/connection-validation.test.ts`
- Test: `test_files/unit/ai/analysis-markdown.test.ts`

**Interfaces:**
- Produces: provider kinds `"minimax-cn" | "minimax-global"`.
- Produces: `AiProviderPreset.defaultModel?: string`.
- Produces: `resolveAiConnectionForRequest(value: unknown): AiConnection | undefined`; a successful return always has a non-empty concrete `model`.
- Consumes later: Tasks 2–4 use `getAiProviderPreset()` for display metadata and `resolveAiConnectionForRequest()` for actual model provenance.

- [ ] **Step 1: Write failing preset and resolver tests**

Add exact expectations for all ten presets and the eight defaults:

```ts
expect(AI_PROVIDER_PRESETS.map(({ providerKind, defaultModel }) => [
  providerKind,
  defaultModel,
])).toEqual([
  ["kimi", "kimi-latest"],
  ["deepseek", "deepseek-v4-pro"],
  ["qwen", "qwen3.7-plus"],
  ["glm", "glm-5.2"],
  ["openai", "gpt-5.6"],
  ["claude", "claude-sonnet-5"],
  ["minimax-cn", "MiniMax-M3"],
  ["minimax-global", "MiniMax-M3"],
  ["openai-compatible", undefined],
  ["anthropic-compatible", undefined],
]);

const following = createAiConnection({
  id: CONNECTION_ID,
  name: "跟随默认",
  providerKind: "minimax-cn",
  model: "",
});
expect(following.model).toBe("");
expect(resolveAiConnectionForRequest(following)?.model).toBe("MiniMax-M3");

const pinned = createAiConnection({
  id: CONNECTION_ID,
  name: "固定模型",
  providerKind: "deepseek",
  model: "deepseek-account-model",
});
expect(resolveAiConnectionForRequest(pinned)?.model)
  .toBe("deepseek-account-model");
```

Add validation cases proving official blank models survive normalization, relay blank models fail, control characters still fail, and the two MiniMax URLs cannot be swapped:

```ts
expect(normalizeAiConnection(connection({
  providerKind: "kimi",
  protocol: "openai-chat",
  baseUrl: "https://api.moonshot.cn/v1",
  model: "",
})))
  .toMatchObject({ providerKind: "kimi", model: "" });
expect(normalizeAiConnection(connection({
  providerKind: "openai-compatible",
  baseUrl: "https://relay.example/v1",
  model: "",
}))).toBeUndefined();
expect(normalizeAiConnection(connection({ model: "bad\nmodel" })))
  .toBeUndefined();
expect(normalizeAiBaseUrl("https://api.minimax.io/v1", "minimax-cn"))
  .toBeUndefined();
```

Extend the analysis-result cases exercised through `renderAnalysisMarkdown()` so both MiniMax provider kinds are accepted and an unknown provider remains rejected.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npx vitest run --config vitest.config.mjs \
  test_files/unit/ai/provider-presets.test.ts \
  test_files/unit/ai/connection-validation.test.ts \
  test_files/unit/ai/analysis-markdown.test.ts
```

Expected: FAIL because the MiniMax kinds, `defaultModel`, resolver, and blank-official validation do not exist.

- [ ] **Step 3: Implement the provider metadata and resolver**

Extend `AiProviderKind`, then add `defaultModel` and the two MiniMax presets to both the canonical and validation-owned immutable maps. The preset entries must be:

```ts
{
  providerKind: "minimax-cn",
  protocol: "openai-chat",
  baseUrl: "https://api.minimaxi.com/v1",
  defaultModel: "MiniMax-M3",
},
{
  providerKind: "minimax-global",
  protocol: "openai-chat",
  baseUrl: "https://api.minimax.io/v1",
  defaultModel: "MiniMax-M3",
},
```

Change model normalization so it distinguishes invalid input from an intentionally empty string:

```ts
function normalizedOptionalText(value: unknown): string | undefined {
  if (typeof value !== "string" || hasControlCharacters(value)) {
    return undefined;
  }
  return value.normalize("NFC").trim();
}

const model = normalizedOptionalText(ownData(record, "model"));
if (
  model === undefined ||
  (model === "" && preset.defaultModel === undefined)
) return undefined;
```

Implement one resolver in `provider-presets.ts`:

```ts
export function resolveAiConnectionForRequest(
  value: unknown,
): AiConnection | undefined {
  const connection = normalizeAiConnection(value);
  if (!connection) return undefined;
  const preset = CANONICAL_PROVIDER_PRESETS.find(
    ({ providerKind }) => providerKind === connection.providerKind,
  );
  const model = connection.model || preset?.defaultModel;
  return model ? { ...connection, model } : undefined;
}
```

Update the new provider members in the analysis allowlist and both exhaustive provider-label maps. Add Chinese and English label keys now so TypeScript remains clean after the union expands.

- [ ] **Step 4: Run focused tests and type checking**

Run:

```bash
npx vitest run --config vitest.config.mjs \
  test_files/unit/ai/provider-presets.test.ts \
  test_files/unit/ai/connection-validation.test.ts \
  test_files/unit/ai/analysis-markdown.test.ts
npx tsc -noEmit -skipLibCheck
```

Expected: all focused tests PASS and TypeScript reports no missing exhaustive provider member.

- [ ] **Step 5: Commit**

```bash
git add src/ai/ai-types.ts src/ai/provider-presets.ts \
  src/ai/connection-validation.ts src/ai/analysis-result.ts \
  src/modals/ai-connection-modal.ts src/settings/tabs/ai-settings-tab.ts \
  src/i18n/zh-cn.ts src/i18n/en.ts \
  test_files/unit/ai/provider-presets.test.ts \
  test_files/unit/ai/connection-validation.test.ts \
  test_files/unit/ai/analysis-markdown.test.ts
git commit -m "feat: add MiniMax provider defaults"
```

---

### Task 2: Send correct MiniMax requests and record the actual resolved model

**Files:**
- Modify: `src/ai/providers/provider-factory.ts`
- Modify: `src/ai/providers/openai-chat-provider.ts`
- Modify: `src/ai/providers/anthropic-messages-provider.ts`
- Modify: `src/ai/ai-operation-service.ts`
- Modify: `src/modals/ai-operation-modal.ts`
- Test: `test_files/unit/ai/providers/provider-factory.test.ts`
- Test: `test_files/unit/ai/providers/openai-chat-provider.test.ts`
- Test: `test_files/unit/ai/providers/anthropic-messages-provider.test.ts`
- Test: `test_files/unit/ai/ai-operation-service.test.ts`
- Test: `test_files/unit/modals/ai-operation-modal.test.ts`

**Interfaces:**
- Consumes: `resolveAiConnectionForRequest(value)` from Task 1.
- Produces: `OpenAiChatProviderOptions.usesMaxCompletionTokens?: boolean`.
- Produces: every `AiOperationResult.model` is the concrete request model, including when the persisted connection model is blank.

- [ ] **Step 1: Write failing request-envelope and factory tests**

Add table-driven factory tests for both MiniMax regions using a secret reader and captured transport. Assert exact URLs and bodies:

```ts
it.each([
  ["minimax-cn", "https://api.minimaxi.com/v1/chat/completions"],
  ["minimax-global", "https://api.minimax.io/v1/chat/completions"],
] as const)("routes %s to its official API", async (providerKind, url) => {
  const provider = await createTextGenerationProvider(
    createAiConnection({
      id: CONNECTION_ID,
      name: "MiniMax",
      providerKind,
      model: "",
    }),
    secretReader(API_KEY),
    { transport },
  );
  await provider.generate(request());
  expect(transport).toHaveBeenCalledWith(expect.objectContaining({ url }));
  const body = JSON.parse(transport.mock.calls[0][0].body);
  expect(body).toMatchObject({
    model: "MiniMax-M3",
    max_completion_tokens: 512,
  });
  expect(body).not.toHaveProperty("max_tokens");
});
```

Retain explicit regression expectations that OpenAI/Kimi/DeepSeek/Qwen/GLM and OpenAI relays still send `max_tokens`, and Anthropic still sends `max_tokens` to `/v1/messages`.

Add operation-service tests where a saved blank Kimi model results in an outbound `kimi-latest` request and `AiOperationResult.model === "kimi-latest"`; add an explicit model test proving it stays pinned.

Add operation-modal tests asserting the preview renders the resolved model and accepts the service result when its model equals the resolved value rather than the persisted blank marker.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npx vitest run --config vitest.config.mjs \
  test_files/unit/ai/providers/provider-factory.test.ts \
  test_files/unit/ai/providers/openai-chat-provider.test.ts \
  test_files/unit/ai/providers/anthropic-messages-provider.test.ts \
  test_files/unit/ai/ai-operation-service.test.ts \
  test_files/unit/modals/ai-operation-modal.test.ts
```

Expected: FAIL because blank models are not resolved at runtime, MiniMax sends the old token field, and preview/provenance compare against the persisted blank value.

- [ ] **Step 3: Resolve connections before all provider construction**

At the factory and both direct provider constructors, replace plain normalization with resolution:

```ts
const connection = resolveAiConnectionForRequest(options.connection);
if (!connection || connection.protocol !== "openai-chat") {
  throw new ProviderError("invalid-connection", "The OpenAI-compatible connection is invalid.");
}
```

This defense-in-depth is required because tests and future callers may instantiate a provider without using the factory.

Add the MiniMax capability set in the factory:

```ts
const MAX_COMPLETION_TOKEN_PROVIDER_KINDS: ReadonlySet<AiProviderKind> =
  new Set(["minimax-cn", "minimax-global"]);

usesMaxCompletionTokens:
  MAX_COMPLETION_TOKEN_PROVIDER_KINDS.has(connection.providerKind),
```

- [ ] **Step 4: Implement the MiniMax token-limit switch**

Store the constructor flag in private state and build the body without ever sending both fields:

```ts
const body: Record<string, unknown> = {
  model: state.model,
  messages: [
    { role: "system", content: snapshot.system },
    { role: "user", content: snapshot.user },
  ],
  stream: false,
};
body[state.usesMaxCompletionTokens
  ? "max_completion_tokens"
  : "max_tokens"] = snapshot.maxOutputTokens;
```

Do not alter headers, URL joining, response parsing, secret redaction, retries, or existing `store: false` behavior.

- [ ] **Step 5: Use the effective connection for operation provenance**

In both `run()` and `runPrepared()`, resolve the selected persisted connection once after identity checks, pass the effective connection to the provider factory, and return `effectiveConnection.model`:

```ts
const effectiveConnection = resolveAiConnectionForRequest(connection);
if (!effectiveConnection) throw new AiOperationError("invalid-connection");
const provider = await this.providerFactory(effectiveConnection, this.secretStore);
// ...
return {
  // existing fields
  model: effectiveConnection.model,
  text,
};
```

Keep `sameConnection()` comparing persisted snapshots so a default mapping cannot hide a user edit between preview and send.

In `ai-operation-modal.ts`, render `resolveAiConnectionForRequest(selectedConnection)?.model` and compare generated provenance to the same resolved model. Refuse to run if resolution unexpectedly fails.

- [ ] **Step 6: Run focused tests and type checking**

Run:

```bash
npx vitest run --config vitest.config.mjs \
  test_files/unit/ai/providers/provider-factory.test.ts \
  test_files/unit/ai/providers/openai-chat-provider.test.ts \
  test_files/unit/ai/providers/anthropic-messages-provider.test.ts \
  test_files/unit/ai/ai-operation-service.test.ts \
  test_files/unit/modals/ai-operation-modal.test.ts
npx tsc -noEmit -skipLibCheck
```

Expected: all focused tests PASS; captured MiniMax bodies contain only `max_completion_tokens`; history-facing results contain the concrete model.

- [ ] **Step 7: Commit**

```bash
git add src/ai/providers/provider-factory.ts \
  src/ai/providers/openai-chat-provider.ts \
  src/ai/providers/anthropic-messages-provider.ts \
  src/ai/ai-operation-service.ts src/modals/ai-operation-modal.ts \
  test_files/unit/ai/providers/provider-factory.test.ts \
  test_files/unit/ai/providers/openai-chat-provider.test.ts \
  test_files/unit/ai/providers/anthropic-messages-provider.test.ts \
  test_files/unit/ai/ai-operation-service.test.ts \
  test_files/unit/modals/ai-operation-modal.test.ts
git commit -m "feat: resolve default models for AI requests"
```

---

### Task 3: Make the connection editor and settings list explain default versus pinned models

**Files:**
- Modify: `src/modals/ai-connection-modal.ts`
- Modify: `src/settings/tabs/ai-settings-tab.ts`
- Modify: `src/i18n/zh-cn.ts`
- Modify: `src/i18n/en.ts`
- Test: `test_files/unit/modals/ai-connection-modal.test.ts`
- Test: `test_files/unit/settings/ai-settings-tab.test.ts`

**Interfaces:**
- Consumes: `getAiProviderPreset(providerKind).defaultModel` and `resolveAiConnectionForRequest(connection)` from Task 1.
- Produces: official providers persist an empty model marker; relays still return `settings.ai.modelRequired` when blank.
- Produces: provider switch clears only the draft model field; opening an existing connection preserves its saved model.

- [ ] **Step 1: Write failing editor and list-rendering tests**

Update the provider-choice expectation to all ten entries, in this order:

```ts
expect(Array.from(provider.options).map(({ value }) => value)).toEqual([
  "kimi", "deepseek", "qwen", "glm", "openai", "claude",
  "minimax-cn", "minimax-global",
  "openai-compatible", "anthropic-compatible",
]);
```

Add tests proving:

```ts
setInput(modal, "连接名称", "默认 MiniMax");
provider.value = "minimax-cn";
provider.dispatchEvent(new Event("change"));
expect(setting(modal, "模型 ID").textContent)
  .toContain("留空使用默认模型：MiniMax-M3");
button(modal, "保存").click();
await flushPromises();
expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
  providerKind: "minimax-cn",
  baseUrl: "https://api.minimaxi.com/v1",
  model: "",
}));
```

Add a paired relay test: after switching to `openai-compatible`, filling a safe URL but leaving model blank must not save and must show `请输入模型 ID`.

Add tests that an explicit `MiniMax-M3-custom` value is preserved; switching to international clears the unsaved value and changes the default placeholder; editing an existing pinned connection retains its model; API Key test-before-save semantics remain unchanged.

In settings-tab tests, assert saved blank-model connections render `默认（MiniMax-M3）`, while pinned connections render their explicit model unchanged.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npx vitest run --config vitest.config.mjs \
  test_files/unit/modals/ai-connection-modal.test.ts \
  test_files/unit/settings/ai-settings-tab.test.ts
```

Expected: FAIL because the editor still globally requires a model and list rendering outputs the persisted empty string.

- [ ] **Step 3: Implement dynamic model-field behavior**

Keep a reference to the model `Setting`, then refresh its description and placeholder in `renderProviderFields()`:

```ts
const defaultModel = preset?.defaultModel;
modelSetting.setDesc(t(defaultModel
  ? "settings.ai.modelDefaultDesc"
  : "settings.ai.modelRequiredDesc", {
  ...(defaultModel ? { model: defaultModel } : {}),
}));
modelInput.placeholder = defaultModel
  ? t("settings.ai.modelDefaultPlaceholder", { model: defaultModel })
  : t("settings.ai.modelRequiredPlaceholder");
```

Replace global required validation with safe optional normalization:

```ts
const model = boundedOptionalText(input.model, MAX_MODEL_CHARACTERS);
if (model === undefined) {
  return { ok: false, error: "settings.ai.modelRequired" };
}
const preset = getAiProviderPreset(input.providerKind);
if (model === "" && !preset?.defaultModel) {
  return { ok: false, error: "settings.ai.modelRequired" };
}
```

`boundedOptionalText()` must return `""` for whitespace-only input, return normalized text for safe input, and return `undefined` only for non-string, over-limit, or control-character input.

For MiniMax provider guidance, display region-specific official-domain copy and remind the user that a manual override requires the complete model ID. Keep the API Key field and its save/test lifecycle untouched.

- [ ] **Step 4: Render the actual default in the connection list**

Resolve the display model without mutating the connection:

```ts
const resolved = resolveAiConnectionForRequest(connection);
const modelLabel = connection.model
  ? connection.model
  : t("settings.ai.defaultModelLabel", { model: resolved?.model ?? "" });
```

If resolution fails, retain the existing invalid-connection handling rather than rendering a fabricated model.

Add matching Chinese and English strings, including:

```ts
"settings.ai.provider.minimaxCn": "MiniMax（中国大陆）",
"settings.ai.provider.minimaxGlobal": "MiniMax（国际）",
"settings.ai.modelDefaultDesc": "可选。留空使用平台默认模型：{model}；填写后固定使用指定模型。",
"settings.ai.modelDefaultPlaceholder": "留空使用默认模型：{model}",
"settings.ai.modelRequiredDesc": "必填。兼容中转站没有统一默认模型。",
"settings.ai.defaultModelLabel": "默认（{model}）",
```

The English locale must carry equivalent meaning, not untranslated Chinese copy.

- [ ] **Step 5: Run focused tests and localization audit**

Run:

```bash
npx vitest run --config vitest.config.mjs \
  test_files/unit/modals/ai-connection-modal.test.ts \
  test_files/unit/settings/ai-settings-tab.test.ts
npm run audit:i18n
npx tsc -noEmit -skipLibCheck
```

Expected: tests PASS; both locale dictionaries have the same complete key set; no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add src/modals/ai-connection-modal.ts \
  src/settings/tabs/ai-settings-tab.ts src/i18n/zh-cn.ts src/i18n/en.ts \
  test_files/unit/modals/ai-connection-modal.test.ts \
  test_files/unit/settings/ai-settings-tab.test.ts
git commit -m "feat: explain AI default model selection"
```

---

### Task 4: Lock privacy, export, migration, and user-documentation behavior

**Files:**
- Modify: `README.md`
- Modify: `docs/TROUBLESHOOTING.zh-CN.md`
- Test: `test_files/unit/security/public-settings-export.test.ts`
- Test: `test_files/unit/ai/ai-privacy-boundary.test.ts`
- Test: `test_files/unit/settings/ai-settings-tab.test.ts`

**Interfaces:**
- Consumes: persisted blank model markers and request-time concrete models from Tasks 1–3.
- Produces: regression proof that no migration, export, or preview path leaks a key or rewrites a pinned model.

- [ ] **Step 1: Add failing cross-boundary regression tests**

Add tests with an API key canary that prove:

```ts
const connection = createAiConnection({
  id: CONNECTION_ID,
  name: "MiniMax 默认模型",
  providerKind: "minimax-global",
  model: "",
});
const settings = settingsFixture();
settings.ai = {
  connections: [connection],
  defaultConnectionId: CONNECTION_ID,
};
(settings as unknown as Record<string, unknown>).apiKey =
  "PRIVATE_API_KEY_CANARY";
const exported = buildPublicSettingsExport(settings, {
  includeSources: false,
});
const exportedAi = exported.ai as {
  connections: Array<Record<string, unknown>>;
};
expect(exportedAi.connections[0]).toMatchObject({
  providerKind: "minimax-global",
  model: "",
});
expect(JSON.stringify(exported)).not.toContain("PRIVATE_API_KEY_CANARY");
```

Add an import/normalization regression proving old non-empty models remain byte-for-byte pinned after load/save normalization. Add a privacy-boundary request test proving the MiniMax API key appears only in the outbound Authorization header, never in the request body, error message, analysis result, or Markdown artifact.

Retain the editor transaction tests showing that testing a newly entered key does not save it, saving metadata precedes key storage, and an empty edit key keeps the existing external key.

- [ ] **Step 2: Run regression tests and verify RED where coverage is missing**

Run:

```bash
npx vitest run --config vitest.config.mjs \
  test_files/unit/security/public-settings-export.test.ts \
  test_files/unit/ai/ai-privacy-boundary.test.ts \
  test_files/unit/settings/ai-settings-tab.test.ts
```

Expected: new MiniMax/default-model cases initially FAIL until all closed allowlists and effective-model paths from Tasks 1–3 are complete.

- [ ] **Step 3: Close any remaining boundary gaps with minimal code changes**

If a closed provider allowlist rejects MiniMax, add only `"minimax-cn"` and `"minimax-global"`. If an export path resolves `model: ""`, change it to export the normalized persisted connection rather than the request-time connection. If a result path records an empty model, change it to consume the effective request connection. Do not add keys, headers, prompts, feed URLs, or local filesystem paths to public settings or diagnostics.

- [ ] **Step 4: Document default and pinned model behavior**

Add a concise README table matching the exact defaults in Global Constraints and explain:

```markdown
- 模型 ID 留空：跟随当前插件版本内置的推荐模型。
- 填写模型 ID：固定使用该模型，后续升级不会覆盖。
- 兼容中转站：必须填写模型 ID。
- 更新插件只替换运行文件，不会删除连接、API Key 或 AI 历史文件。
```

In troubleshooting, add exact checks for a failed default model: confirm account/region availability, enter an account-enabled model ID to pin it, then use the in-editor test button. State that a successful unsaved-key test still requires clicking Save.

- [ ] **Step 5: Run regressions, documentation scans, and commit**

Run:

```bash
npx vitest run --config vitest.config.mjs \
  test_files/unit/security/public-settings-export.test.ts \
  test_files/unit/ai/ai-privacy-boundary.test.ts \
  test_files/unit/settings/ai-settings-tab.test.ts
npm run audit:i18n
npm run check:public
git diff --check
```

Expected: all commands PASS; the public scan finds no API key, local path, unfinished marker, or unsafe fixture.

```bash
git add README.md docs/TROUBLESHOOTING.zh-CN.md \
  test_files/unit/security/public-settings-export.test.ts \
  test_files/unit/ai/ai-privacy-boundary.test.ts \
  test_files/unit/settings/ai-settings-tab.test.ts
git commit -m "test: protect AI provider configuration data"
```

---

### Task 5: Verify, install without touching user data, and deliver through GitHub

**Files:**
- Generated and verified: `main.js`
- Generated and verified: `release/main.js`
- Generated and verified: `release/manifest.json`
- Generated and verified: `release/styles.css`
- Replace only in the validated private live directory: `main.js`, `manifest.json`, `styles.css`
- Preserve in the private live directory: `data.json`
- Preserve in the private vault: `.rss-dashboard-data/`
- Preserve in the private application-support directory: `secrets.json`

**Interfaces:**
- Consumes: all implementation and tests from Tasks 1–4.
- Produces: checked release artifacts, a safe live replacement, a pushed branch, and a merged GitHub pull request.

- [ ] **Step 1: Run the complete repository gate from a clean source state**

Run:

```bash
git diff --check
npm run check
npm run release:stage
npm run release:check
```

Expected: unit tests, localization audit, public/privacy scan, workflow/version policy, lint, TypeScript, production build, and release artifact validation all PASS. `release/` contains exactly `main.js`, `manifest.json`, and `styles.css`.

- [ ] **Step 2: Review the implementation diff against the confirmed design**

Run:

```bash
git status --short
git diff origin/main...HEAD --stat
git diff origin/main...HEAD -- \
  src/ai src/modals src/settings/tabs/ai-settings-tab.ts \
  src/i18n test_files/unit README.md docs/TROUBLESHOOTING.zh-CN.md
```

Verify that there is no API key literal, no migration that rewrites existing connections, no automatic AI call, and no file operation targeting user configuration or history.

- [ ] **Step 3: Snapshot protected files and back up current runtime files**

Read the three already user-confirmed private paths from the execution context into `RSS_DASHBOARD_LIVE_PLUGIN_DIR`, `RSS_DASHBOARD_HISTORY_DIR`, and `RSS_DASHBOARD_SECRET_FILE`; never add their values to a source file, commit, log message, or pull-request body. Resolve and validate them before any replacement:

```bash
test -n "${RSS_DASHBOARD_LIVE_PLUGIN_DIR:-}"
test -n "${RSS_DASHBOARD_HISTORY_DIR:-}"
test -n "${RSS_DASHBOARD_SECRET_FILE:-}"
rss_live_plugin_dir="$(realpath "$RSS_DASHBOARD_LIVE_PLUGIN_DIR")"
rss_history_dir="$(realpath "$RSS_DASHBOARD_HISTORY_DIR")"
rss_secret_file="$(realpath "$RSS_DASHBOARD_SECRET_FILE")"
case "$rss_live_plugin_dir" in */.obsidian/plugins/release) ;; *) exit 1;; esac
case "$rss_history_dir" in */.rss-dashboard-data) ;; *) exit 1;; esac
case "$rss_secret_file" in */rss-dashboard-cn/secrets.json) ;; *) exit 1;; esac
test -f "$rss_live_plugin_dir/data.json"
test -f "$rss_secret_file"
test -d "$rss_history_dir"
```

Run read-only metadata checks without printing secret contents, create a recoverable runtime backup, and record only the backup directory in the handoff:

```bash
stat -f '%m %z' "$rss_live_plugin_dir/data.json" "$rss_secret_file"
find "$rss_history_dir" -type f | wc -l
rss_runtime_backup="$(mktemp -d /tmp/rss-dashboard-cn-runtime-backup.XXXXXX)"
cp "$rss_live_plugin_dir/main.js" "$rss_runtime_backup/main.js"
cp "$rss_live_plugin_dir/manifest.json" "$rss_runtime_backup/manifest.json"
cp "$rss_live_plugin_dir/styles.css" "$rss_runtime_backup/styles.css"
```

Do not copy `data.json` or secrets because they are not being replaced.

- [ ] **Step 4: Replace only the three runtime files and verify byte equality**

Use only the already resolved and suffix-validated `rss_live_plugin_dir`:

```bash
cp release/main.js "$rss_live_plugin_dir/main.js"
cp release/manifest.json "$rss_live_plugin_dir/manifest.json"
cp release/styles.css "$rss_live_plugin_dir/styles.css"
cmp release/main.js "$rss_live_plugin_dir/main.js"
cmp release/manifest.json "$rss_live_plugin_dir/manifest.json"
cmp release/styles.css "$rss_live_plugin_dir/styles.css"
```

Repeat the `stat` and history file-count checks from Step 3. Expected: protected `data.json` and `secrets.json` timestamps/sizes match their pre-install snapshots, history file count is unchanged, and all three `cmp` commands return success.

- [ ] **Step 5: Push, open a pull request, wait for CI, and merge**

Run:

```bash
git status --short --branch
git push -u origin codex/add-minimax-official
gh pr create \
  --base main \
  --head codex/add-minimax-official \
  --title "feat: add MiniMax and provider default models" \
  --body "Adds official MiniMax mainland/international connections, release-maintained defaults for named AI providers, explicit-model overrides, request provenance, and privacy regressions. Verified with npm run check and release artifact checks."
gh pr checks --watch
gh pr merge --squash
```

Expected: CI passes, the pull request merges into `main`, and no release tag is created.

- [ ] **Step 6: User-visible Obsidian verification**

Ask the user to reload Obsidian or toggle `RSS Dashboard CN` off and on, then verify:

1. “添加 AI 连接” includes MiniMax mainland and international.
2. Each official provider shows its current default when model is blank.
3. A compatible relay still refuses a blank model.
4. Entering a MiniMax API Key and selecting “测试连接” tests without saving; a success message still says to select Save.
5. Selecting Save persists the connection and external key; reopening the editor never displays the saved key.
6. A manual AI operation preview shows `MiniMax-M3` or the user-pinned model, and a saved analysis Markdown records that same actual model.

If the real paid test fails, report the translated provider error and keep the configuration editor open. Do not change the user’s key or choose a different region/model automatically.
