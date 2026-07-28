# Inline Streaming AI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the crowded AI confirmation modal with direct, explicit AI actions that stream the final answer inside the current article reader, survive UI close/reopen through local Markdown history, deduplicate in-flight requests, and preserve immutable result versions.

**Architecture:** Add a bounded desktop streaming transport and protocol-specific SSE parsers behind the existing provider interface. Extend `AiOperationService` with text-delta callbacks, then place generation/persistence in one plugin-owned task coordinator keyed by `itemId + operation`. A reusable inline panel subscribes to task state and queries strict read-only analysis history. ReaderView and the Dashboard's inline reader host the panel; list actions first open the internal reader, then select the requested operation.

**Tech Stack:** TypeScript 5.9, Obsidian desktop API, Node `http`/`https`, OpenAI-compatible Chat Completions SSE, Anthropic Messages SSE, Vitest 4, existing external secret store and Markdown analysis repository.

## Global Constraints

- AI remains optional and manual. Never run on startup, refresh, collection, save, export, or transcript retrieval.
- Clicking a named operation is the explicit authorization for one request using the current default/selected enabled connection; remove the separate send-confirmation step.
- No automatic provider fallback, probe, or retry. A non-stream JSON response may be consumed from the same HTTP response; never issue a second request merely to change streaming mode.
- Do not send or display `reasoning_effort`, `thinking`, hidden chain-of-thought, `reasoning_content`, or provider reasoning blocks. “深度分析” changes only the user-facing prompt.
- UI code never receives API keys, auth headers, raw SSE events, or full provider error bodies.
- Enforce timeout, abort, redirect, request/response size, event-count, line-length, output-character, and metadata limits before persistence.
- Same-origin redirects only. Reject cross-origin redirects rather than forwarding authorization.
- One active task per `itemId + operation`. Reopening subscribes to the same task; it cannot create a duplicate request.
- Collapse/close detaches UI only. Only “停止生成”, plugin unload, or full Obsidian exit aborts the task.
- Save a Markdown artifact only after a complete non-empty provider result. Abort/failure never creates a blank or partial file.
- “重新生成” always creates a new immutable file. Never overwrite prior analyses or user notes.
- Existing schemaVersion 1 analysis Markdown remains readable as history without migration or rewrite.
- Preserve existing external key files, connection IDs/settings, data folder, collected history, content cache, and saved-note insertion ownership checks.
- Every task follows red-green-refactor, runs focused tests, and commits independently.

---

## File Map

### New production files

- `src/ai/providers/sse-decoder.ts` — incremental UTF-8 SSE framing with strict bounds.
- `src/ai/providers/streaming-ai-transport.ts` — desktop HTTP(S) stream, timeout/abort, redirect validation, and bounded non-stream fallback body.
- `src/ai/analysis-markdown-parser.ts` — strict parser for repository-owned analysis Markdown.
- `src/ai/ai-operation-task-coordinator.ts` — in-flight dedupe, replayable state, completion persistence, reconnect, regenerate, and shutdown.
- `src/components/inline-ai-panel.ts` — compact task status, streamed final text, connection selector, result actions, and history.
- `src/styles/inline-ai-panel.css` — scoped responsive reader panel.

### Existing production files to modify

- `src/ai/providers/text-generation-provider.ts` — text-delta callback and streaming transport contract.
- `src/ai/providers/openai-chat-provider.ts` — `stream: true`, OpenAI SSE extraction, same-response JSON fallback.
- `src/ai/providers/anthropic-messages-provider.ts` — Anthropic SSE extraction and thinking-block exclusion.
- `src/ai/providers/provider-factory.ts` — create streaming-capable providers without changing external key storage.
- `src/ai/ai-operation-service.ts` — forward bounded deltas from provider to coordinator.
- `src/ai/analysis-result.ts` — accept `youtube-transcript` as a durable content basis.
- `src/ai/analysis-repository.ts` — strict list/read/latest APIs in addition to existing atomic save and verification.
- `src/ai/analysis-markdown.ts` — expose constants/helpers required by the exact inverse parser without loosening output.
- `src/views/reader-view.ts` — host inline panel below actions and route the AI menu to it.
- `src/components/article-renderer.ts` — host the same panel for Dashboard inline-reader mode.
- `src/views/dashboard-view.ts` — open an internal reader before dispatching an operation from a card/menu.
- `main.ts` — construct long-lived services/coordinator, expose reader routing, and abort on unload.
- `src/modals/ai-operation-modal.ts` — remove after all callers/tests migrate.
- `src/styles/index.css` — import panel styles.
- `src/i18n/zh-cn.ts`, `src/i18n/en.ts` — inline statuses, errors, history, and action labels.
- `README.md`, `docs/PRIVACY.zh-CN.md`, `docs/TROUBLESHOOTING.zh-CN.md` — manual streaming/persistence behavior and boundaries.

### Focused tests to create or modify

- `test_files/unit/ai/providers/sse-decoder.test.ts`
- `test_files/unit/ai/providers/streaming-ai-transport.test.ts`
- `test_files/unit/ai/providers/openai-chat-provider.test.ts`
- `test_files/unit/ai/providers/anthropic-messages-provider.test.ts`
- `test_files/unit/ai/ai-operation-service.test.ts`
- `test_files/unit/ai/analysis-markdown-parser.test.ts`
- `test_files/unit/ai/analysis-repository.test.ts`
- `test_files/unit/ai/ai-operation-task-coordinator.test.ts`
- `test_files/unit/components/inline-ai-panel.test.ts`
- `test_files/unit/views/reader-view-ai-actions.test.ts`
- `test_files/unit/views/reader-view-onclose-cleanup.test.ts`
- `test_files/unit/main/ai-operation-wiring.test.ts`
- `test_files/unit/modals/ai-operation-modal.test.ts` — delete after replacement.

---

### Task 1: Decode bounded SSE without exposing provider payloads

**Files:**

- Create: `src/ai/providers/sse-decoder.ts`
- Create: `test_files/unit/ai/providers/sse-decoder.test.ts`

**Interfaces:**

```ts
export interface ServerSentEvent {
  event?: string;
  data: string;
}

export class BoundedSseDecoder {
  push(chunk: Uint8Array): ServerSentEvent[];
  finish(): ServerSentEvent[];
}
```

- [ ] **Step 1: Write fragmentation and boundary tests**

Cover UTF-8 code points split across chunks; `\n`/`\r\n`; blank-line event termination; multiline `data:` joining; comments; optional `event:`; final event without terminal blank line; `[DONE]`; empty chunks; invalid UTF-8; excessive line/event/data length; too many events; and ignored `id`/`retry` fields.

- [ ] **Step 2: Run the test and verify red**

Run: `npm run test:unit -- test_files/unit/ai/providers/sse-decoder.test.ts`

Expected: FAIL because the decoder does not exist.

- [ ] **Step 3: Implement incremental decoding**

Use one fatal `TextDecoder("utf-8")` with streaming mode, a bounded carry buffer, and numeric ceilings exported for tests. Emit plain `{ event?, data }` copies only. Do not parse JSON or log lines in this layer.

- [ ] **Step 4: Run focused tests**

Run: `npm run test:unit -- test_files/unit/ai/providers/sse-decoder.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ai/providers/sse-decoder.ts test_files/unit/ai/providers/sse-decoder.test.ts
git commit -m "feat: add bounded SSE decoding"
```

### Task 2: Add a secure desktop streaming transport

**Files:**

- Create: `src/ai/providers/streaming-ai-transport.ts`
- Create: `test_files/unit/ai/providers/streaming-ai-transport.test.ts`
- Modify: `src/ai/providers/text-generation-provider.ts`

**Interfaces:**

```ts
export interface AiStreamingTransportResponse {
  status: number;
  headers: Record<string, string>;
  contentType: string;
  requestId?: string;
  bodyText?: string;
}

export type AiStreamingTransport = (
  request: AiTransportRequest,
  onChunk: (chunk: Uint8Array) => void,
) => Promise<AiStreamingTransportResponse>;

export type TextDeltaHandler = (text: string) => void;

export interface TextGenerationProvider {
  generate(
    request: TextGenerationRequest,
    onTextDelta?: TextDeltaHandler,
  ): Promise<TextGenerationResult>;
}
```

- [ ] **Step 1: Write local-server transport tests**

Use an ephemeral localhost HTTP server to test chunk delivery, request headers/body, timeout, caller abort, socket error, max response bytes, max chunk count, same-origin redirect, redirect limit, HTTPS-to-HTTP rejection, credentialed URL rejection, cross-origin redirect rejection, and bounded JSON body collection.

- [ ] **Step 2: Add secrecy tests**

Put an API-key sentinel in headers and an error-body sentinel in server output. Assert thrown public errors, logs, and serialized results contain neither sentinel. Assert authorization is never sent to a redirected different origin.

- [ ] **Step 3: Run tests and verify red**

Run: `npm run test:unit -- test_files/unit/ai/providers/streaming-ai-transport.test.ts`

Expected: FAIL because the transport does not exist.

- [ ] **Step 4: Implement Node HTTP(S) streaming**

Use `node:http`/`node:https` request APIs, `AbortSignal`, fixed timeout cleanup, and explicit response listeners. Validate URL protocol/credentials/host on every hop. Accept local HTTP only when the normalized connection URL already allows `localhost` or loopback. For SSE, call `onChunk` and do not retain raw body. For `application/json`, collect only the bounded same-response fallback text.

- [ ] **Step 5: Keep error mapping at the provider boundary**

The transport returns status/headers/request ID and bounded JSON fallback only. It must not return non-success body text to UI or logs. Convert network/timeout/abort failures into existing `ProviderError` codes without embedding causes.

- [ ] **Step 6: Run focused and platform tests**

Run: `npm run test:unit -- test_files/unit/ai/providers/streaming-ai-transport.test.ts test_files/unit/check-platform-compat.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/ai/providers/streaming-ai-transport.ts src/ai/providers/text-generation-provider.ts test_files/unit/ai/providers/streaming-ai-transport.test.ts
git commit -m "feat: add secure AI stream transport"
```

### Task 3: Stream only final-answer text from both provider protocols

**Files:**

- Modify: `src/ai/providers/openai-chat-provider.ts`
- Modify: `src/ai/providers/anthropic-messages-provider.ts`
- Modify: `src/ai/providers/provider-factory.ts`
- Modify: `test_files/unit/ai/providers/openai-chat-provider.test.ts`
- Modify: `test_files/unit/ai/providers/anthropic-messages-provider.test.ts`
- Modify: `test_files/unit/ai/providers/provider-factory.test.ts`

**Interfaces:**

- OpenAI body includes `stream: true`; omit optional `stream_options` so Kimi, DeepSeek, Qwen, GLM, MiniMax, OpenAI, and compatible relays share the narrowest common request. Usage metadata remains optional.
- Anthropic body includes `stream: true`.
- `generate(request, onTextDelta?)` returns the same final `TextGenerationResult` after accumulating validated deltas.

- [ ] **Step 1: Replace OpenAI non-stream expectations with failing stream tests**

Feed fragmented events containing role-only deltas, `delta.content`, usage, request ID, finish reason, `[DONE]`, `reasoning_content`, tool calls, malformed JSON, oversized content, and duplicate completion. Assert only `delta.content` reaches the callback/result and reasoning/tool fields are ignored.

- [ ] **Step 2: Add Anthropic stream tests**

Cover `message_start`, `content_block_start`, `content_block_delta` with `text_delta`, `thinking_delta`, signatures, `message_delta` usage, `message_stop`, malformed event order, multiple text blocks, empty output, and abort. Assert only `text_delta.text` is emitted.

- [ ] **Step 3: Add same-response JSON fallback tests**

For both protocols, return `application/json` from the original streaming request and assert the existing non-stream result parser produces one final callback/result. Assert transport call count remains exactly one.

- [ ] **Step 4: Run provider tests and verify red**

Run: `npm run test:unit -- test_files/unit/ai/providers/openai-chat-provider.test.ts test_files/unit/ai/providers/anthropic-messages-provider.test.ts test_files/unit/ai/providers/provider-factory.test.ts`

Expected: FAIL because providers currently send/parse non-stream JSON.

- [ ] **Step 5: Implement protocol state machines**

Use `BoundedSseDecoder`, defensive plain-data projection, cumulative output limits, and callback exception isolation. Ignore all unrecognized event fields. A malformed event ends the request with `malformed-response`; never display the raw event.

- [ ] **Step 6: Preserve status/error behavior**

Keep existing 400/401/402/429/5xx/timeout/abort mappings, model/base URL normalization, provider request ID sanitization, and token usage ceilings. Do not add a compatibility retry.

- [ ] **Step 7: Run focused tests**

Run: `npm run test:unit -- test_files/unit/ai/providers/sse-decoder.test.ts test_files/unit/ai/providers/streaming-ai-transport.test.ts test_files/unit/ai/providers/openai-chat-provider.test.ts test_files/unit/ai/providers/anthropic-messages-provider.test.ts test_files/unit/ai/providers/provider-factory.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/ai/providers test_files/unit/ai/providers
git commit -m "feat: stream final AI responses"
```

### Task 4: Forward bounded deltas through AiOperationService

**Files:**

- Modify: `src/ai/ai-operation-service.ts`
- Modify: `test_files/unit/ai/ai-operation-service.test.ts`

**Interfaces:**

```ts
export interface AiOperationRunInput {
  operation: AiOperation;
  item: CollectedItem;
  connectionId: string;
  fetchFullText: boolean;
  signal?: AbortSignal;
  onTextDelta?: TextDeltaHandler;
}
```

Apply the same optional callback to `AiPreparedOperationRunInput` until the old modal is removed.

- [ ] **Step 1: Add failing orchestration tests**

Assert content selection and prompt construction finish before the first delta, ordered deltas reach the caller exactly once, the final result text matches the concatenation, callback exceptions do not leak keys/provider data, abort stops forwarding, and operation errors retain existing safe codes.

- [ ] **Step 2: Run the test and verify red**

Run: `npm run test:unit -- test_files/unit/ai/ai-operation-service.test.ts`

Expected: FAIL because no callback is accepted/forwarded.

- [ ] **Step 3: Snapshot the callback safely**

Allow only an own data property containing a function. Keep all existing strict input checks. Wrap it in a service-owned callback that enforces string/non-empty/cumulative limits and stops after abort or terminal result.

- [ ] **Step 4: Forward to provider and verify the final invariant**

Call `provider.generate(request, safeOnDelta)`. After completion, require the normalized concatenated deltas to equal the provider result when deltas were emitted; otherwise fail as malformed rather than saving inconsistent text.

- [ ] **Step 5: Run focused tests**

Run: `npm run test:unit -- test_files/unit/ai/ai-operation-service.test.ts test_files/unit/ai/ai-privacy-boundary.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ai/ai-operation-service.ts test_files/unit/ai/ai-operation-service.test.ts
git commit -m "feat: expose AI text deltas safely"
```

### Task 5: Add strict read-only analysis history

**Files:**

- Create: `src/ai/analysis-markdown-parser.ts`
- Create: `test_files/unit/ai/analysis-markdown-parser.test.ts`
- Modify: `src/ai/analysis-markdown.ts`
- Modify: `src/ai/analysis-result.ts`
- Modify: `src/ai/analysis-repository.ts`
- Modify: `test_files/unit/ai/analysis-repository.test.ts`
- Modify: `test_files/unit/ai/analysis-markdown.test.ts`

**Interfaces:**

```ts
export interface AiAnalysisArtifact {
  path: string;
  record: Readonly<AiAnalysisHistoryRecord>;
}

export interface AiAnalysisHistoryRecord {
  schemaVersion: 1;
  id: string;
  itemId: string;
  sourceUrl?: string;
  operation: AiOperation;
  createdAt: string;
  connectionId?: string;
  connectionName: string;
  providerKind: AiProviderKind;
  model: string;
  contentBasis: ContentBasis;
  inputCharacterCount: number;
  inputTruncated: boolean;
  text: string;
}

export class AnalysisRepository {
  list(itemId: string, operation?: AiOperation): Promise<AiAnalysisArtifact[]>;
  latest(itemId: string, operation: AiOperation): Promise<AiAnalysisArtifact | null>;
  read(path: string): Promise<AiAnalysisArtifact | null>;
}
```

- [ ] **Step 1: Write exact inverse-parser tests**

Round-trip every valid analysis field, Unicode, multiline final text, optional source URL, each provider/operation/content basis including `youtube-transcript`, and collision-suffixed filenames. Existing v1 files omit `connectionId`, so parse them into a history record with `connectionId: undefined`; newly rendered v1 files add the normalized non-secret `connectionId` field. Reject duplicate/unknown frontmatter keys, aliases/tags, noncanonical timestamps, mismatched item/path, unsupported schema, invalid enum, empty/oversized text, traversal, symlink-like outside paths, accessors, and malformed delimiters.

- [ ] **Step 2: Write repository enumeration tests**

Assert listing touches only `{dataRoot}/analysis/{stableItemId}`, ignores temp/claim/backup/non-Markdown files, caps file count/bytes, parses each independently, sorts newest canonical `createdAt` first with path tie-breaker, filters by operation, and returns frozen snapshots. Invalid files are skipped, not deleted or rewritten.

- [ ] **Step 3: Run tests and verify red**

Run: `npm run test:unit -- test_files/unit/ai/analysis-markdown-parser.test.ts test_files/unit/ai/analysis-markdown.test.ts test_files/unit/ai/analysis-repository.test.ts`

Expected: FAIL because the parser/query methods do not exist.

- [ ] **Step 4: Implement the strict parser and safe paths**

Share operation/content-basis constants with `analysis-result.ts`; do not introduce general YAML parsing. Parse only the two deterministic v1 shapes emitted before and after the additive `connectionId` field. Validate the containing item directory and expected filename pattern before reading. `AiAnalysisHistoryRecord` is intentionally distinct from the fully trusted generation-time `AiAnalysisResult`.

- [ ] **Step 5: Preserve insertion ownership semantics**

History reads are display/open inputs. Do not silently make a parsed historical artifact eligible for saved-note insertion. Keep `withVerifiedArtifact` for a newly generated in-memory result/path pair; a reopened artifact can always be opened as Markdown and copied/linked by the user.

- [ ] **Step 6: Run focused tests**

Run: `npm run test:unit -- test_files/unit/ai/analysis-markdown-parser.test.ts test_files/unit/ai/analysis-markdown.test.ts test_files/unit/ai/analysis-repository.test.ts test_files/unit/ai/analysis-note-inserter.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/ai/analysis-markdown-parser.ts src/ai/analysis-markdown.ts src/ai/analysis-result.ts src/ai/analysis-repository.ts test_files/unit/ai/analysis-markdown-parser.test.ts test_files/unit/ai/analysis-markdown.test.ts test_files/unit/ai/analysis-repository.test.ts
git commit -m "feat: read AI analysis history safely"
```

### Task 6: Coordinate one persistent task per item and operation

**Files:**

- Create: `src/ai/ai-operation-task-coordinator.ts`
- Create: `test_files/unit/ai/ai-operation-task-coordinator.test.ts`

**Interfaces:**

```ts
export type AiTaskStatus =
  | "idle"
  | "preparing"
  | "generating"
  | "saving"
  | "complete"
  | "failed"
  | "aborted";

export interface AiTaskSnapshot {
  key: string;
  itemId: string;
  operation: AiOperation;
  status: AiTaskStatus;
  text: string;
  connectionId?: string;
  connectionName?: string;
  model?: string;
  contentBasis?: ContentBasis;
  artifactPath?: string;
  createdAt?: string;
  errorCode?: AiOperationErrorCode;
}

export class AiOperationTaskCoordinator {
  loadLatest(itemId: string, operation: AiOperation): Promise<AiTaskSnapshot>;
  start(input: StartAiTaskInput): Promise<AiTaskSnapshot>;
  regenerate(input: StartAiTaskInput): Promise<AiTaskSnapshot>;
  subscribe(itemId: string, operation: AiOperation, listener: (state: AiTaskSnapshot) => void): () => void;
  abort(itemId: string, operation: AiOperation): void;
  shutdown(): Promise<void>;
}
```

- [ ] **Step 1: Write concurrency and lifecycle tests**

Cover two `start` calls sharing one provider promise; late subscriber receives accumulated text immediately; unsubscribe/collapse does not abort; `loadLatest` reads Markdown without provider call; `start` on completed history returns it; `regenerate` creates a distinct result ID/path; stop aborts once; plugin shutdown aborts all; switching articles detaches listeners but task continues; failures create no save call; save failure changes status without losing generated text in memory; success publishes complete only after repository save.

- [ ] **Step 2: Add provenance and secrecy tests**

Assert the coordinator constructs `AiAnalysisResult` from normalized service output, item URL, injected UUID/clock, and selected connection; rejects mismatches; freezes every published snapshot; caps replay text; and never contains API keys/raw errors.

- [ ] **Step 3: Run tests and verify red**

Run: `npm run test:unit -- test_files/unit/ai/ai-operation-task-coordinator.test.ts`

Expected: FAIL because the coordinator does not exist.

- [ ] **Step 4: Implement shared task ownership**

Use a map keyed by `${itemId}\0${operation}`. The task owns its `AbortController`, accumulated final text, immutable terminal state, and listener set. Listener removal never controls task lifetime. Remove only aborted/failed tasks when a new explicit retry starts; retain completed snapshot in memory while the repository remains durable truth.

- [ ] **Step 5: Persist only complete results**

After `AiOperationService.run` succeeds and provenance validates, transition to saving, call `AnalysisRepository.save`, then publish complete with path. On abort/provider failure/save failure, publish a safe code and never create a second request automatically.

- [ ] **Step 6: Run focused tests**

Run: `npm run test:unit -- test_files/unit/ai/ai-operation-task-coordinator.test.ts test_files/unit/ai/ai-operation-service.test.ts test_files/unit/ai/analysis-repository.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/ai/ai-operation-task-coordinator.ts test_files/unit/ai/ai-operation-task-coordinator.test.ts
git commit -m "feat: coordinate persistent inline AI tasks"
```

### Task 7: Build the compact inline AI panel

**Files:**

- Create: `src/components/inline-ai-panel.ts`
- Create: `src/styles/inline-ai-panel.css`
- Create: `test_files/unit/components/inline-ai-panel.test.ts`
- Modify: `src/styles/index.css`
- Modify: `src/i18n/zh-cn.ts`
- Modify: `src/i18n/en.ts`

**Interfaces:**

```ts
export interface InlineAiPanelController {
  show(operation: AiOperation): Promise<void>;
  collapse(): void;
  expand(): void;
  destroy(): void;
}
```

- [ ] **Step 1: Write panel state tests**

Cover missing connection/key, idle, preparing, streaming, saving, complete from current task, complete from history, failed safe codes, aborted, collapsed, destroyed, history list, and multiple enabled connections. Assert opening latest history does not start AI and selecting a connection alone does not start AI.

- [ ] **Step 2: Write direct-action tests**

Assert `show("summary")` immediately starts only when no active/completed task exists; repeated show reattaches; “重新生成” calls `regenerate`; “停止生成” calls abort; collapse only unsubscribes/hides; “打开 Markdown” opens the exact artifact; “保存或插入知识库” is enabled only for a newly generated verified artifact; history opens older Markdown without replacing/deleting it.

- [ ] **Step 3: Run tests and verify red**

Run: `npm run test:unit -- test_files/unit/components/inline-ai-panel.test.ts`

Expected: FAIL because the component does not exist.

- [ ] **Step 4: Implement one-column semantic UI**

Render the panel below article actions, before source content. Header: operation, compact connection selector, collapse. Metadata: generation time/content basis/connection/model. Body: streamed plain text rendered safely as text/Markdown through existing sanitized renderer. Footer: stop while running; regenerate/open/insert/history after completion; configure/retry on failure.

- [ ] **Step 5: Add responsive scoped styles**

Keep content at reader width, prevent horizontal overflow, wrap buttons, limit metadata prominence, and use a single column on narrow windows. Do not use a fullscreen backdrop or modal selectors.

- [ ] **Step 6: Run component, i18n, and CSS checks**

Run: `npm run test:unit -- test_files/unit/components/inline-ai-panel.test.ts test_files/unit/i18n/i18n-audit.test.ts && npm run audit:i18n && npm run check:css-scope && npm run check:important`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/inline-ai-panel.ts src/styles/inline-ai-panel.css src/styles/index.css src/i18n/zh-cn.ts src/i18n/en.ts test_files/unit/components/inline-ai-panel.test.ts
git commit -m "feat: add inline AI result panel"
```

### Task 8: Route every AI action into an internal reader and remove the modal

**Files:**

- Modify: `src/views/reader-view.ts`
- Modify: `src/components/article-renderer.ts`
- Modify: `src/views/dashboard-view.ts`
- Modify: `main.ts`
- Delete: `src/modals/ai-operation-modal.ts`
- Modify: `test_files/unit/views/reader-view-ai-actions.test.ts`
- Modify: `test_files/unit/views/reader-view-onclose-cleanup.test.ts`
- Modify: `test_files/unit/main/ai-operation-wiring.test.ts`
- Delete: `test_files/unit/modals/ai-operation-modal.test.ts`

**Interfaces:**

- `ReaderView.showAiOperation(operation: AiOperation): Promise<void>`.
- `ArticleRenderer.showAiOperation(operation: AiOperation): Promise<void>` for Dashboard inline-reader mode.
- `RssDashboardView.openAiOperationInReader(item, operation): Promise<void>`.
- Replace `RssDashboardPlugin.openAiOperationForItem` with a composition method that prepares the trusted `CollectedItem` and returns `StartAiTaskInput`/panel dependencies without opening UI.

- [ ] **Step 1: Write routing tests before changing callers**

Assert a card/menu AI click opens the selected item in an internal reader even when normal reading preference is external browser, then invokes `showAiOperation`. For inline-reader preference, assert the Dashboard renders the article first and then opens the same inline panel. Assert an already open ReaderView reuses its panel and repeated clicks do not create another task.

- [ ] **Step 2: Write ReaderView lifecycle tests**

Assert the panel mounts after the header/action region and before content, item switch destroys only the old subscription, view close does not abort coordinator task, plugin unload calls coordinator shutdown, and localization refresh updates panel labels without restarting work.

- [ ] **Step 3: Run tests and verify red**

Run: `npm run test:unit -- test_files/unit/views/reader-view-ai-actions.test.ts test_files/unit/views/reader-view-onclose-cleanup.test.ts test_files/unit/main/ai-operation-wiring.test.ts`

Expected: FAIL because callbacks still open `AiOperationModal`.

- [ ] **Step 4: Construct long-lived AI dependencies in main.ts**

Create one `ContentRepository`, `AiContentSelector`, `AiOperationService`, `AnalysisRepository`, note inserter, and `AiOperationTaskCoordinator` after settings load. Read keys only inside provider construction. Rebind safe settings getters after changes; do not recreate/lose active tasks during ordinary view renders.

- [ ] **Step 5: Route from Dashboard and ReaderView**

Normalize the selected feed item through the existing trusted source snapshot. For list actions, force an internal reader host, await `displayItem`, and call `showAiOperation`. For reader menu actions, call the local panel directly. Keep operation buttons disabled with a localized reason when no trusted stable item ID exists.

- [ ] **Step 6: Preserve result actions**

Move existing open-analysis, save-source-first, verified insertion, and open-saved-note callbacks from modal wiring into panel dependencies. Do not weaken `AnalysisRepository.withVerifiedArtifact` or `AnalysisNoteInserter`.

- [ ] **Step 7: Remove modal production and test files**

After `rg "AiOperationModal|openAiOperationModal|activeAiModal" src main.ts test_files` finds only intended migration notes, delete the modal and its obsolete test. Ensure no large confirmation layout remains in generated CSS.

- [ ] **Step 8: Run focused integration tests**

Run: `npm run test:unit -- test_files/unit/components/inline-ai-panel.test.ts test_files/unit/views/reader-view-ai-actions.test.ts test_files/unit/views/reader-view-onclose-cleanup.test.ts test_files/unit/main/ai-operation-wiring.test.ts test_files/unit/ai/ai-operation-task-coordinator.test.ts`

Expected: PASS and no modal opens.

- [ ] **Step 9: Commit**

```bash
git add src/views/reader-view.ts src/components/article-renderer.ts src/views/dashboard-view.ts main.ts src/components/inline-ai-panel.ts test_files/unit/views test_files/unit/main/ai-operation-wiring.test.ts
git rm src/modals/ai-operation-modal.ts test_files/unit/modals/ai-operation-modal.test.ts
git commit -m "feat: move AI actions into the reader"
```

### Task 9: Document and verify inline AI behavior

**Files:**

- Modify: `README.md`
- Modify: `docs/PRIVACY.zh-CN.md`
- Modify: `docs/TROUBLESHOOTING.zh-CN.md`
- Modify: `test_files/unit/docs/public-release-documentation.test.ts`

- [ ] **Step 1: Add failing documentation assertions**

Require docs to state: manual-only operation, direct click authorization, default/selected connection, final-answer streaming, no hidden reasoning, same-task dedupe, stop behavior, Markdown path, reopen/history behavior, immutable regenerate, no blank file on failure, and how to fix missing/invalid API keys.

- [ ] **Step 2: Run the docs test and verify red**

Run: `npm run test:unit -- test_files/unit/docs/public-release-documentation.test.ts`

Expected: FAIL until the docs reflect the new UI.

- [ ] **Step 3: Update documentation and screenshots/copy references**

Remove references to “发送前确认” and the old AI modal. Explain that closing the article does not cancel an active task, but quitting Obsidian does; successful results live under `{dataFolder}/analysis/...`.

- [ ] **Step 4: Run the complete AI slice**

Run: `npm run test:unit -- test_files/unit/ai test_files/unit/components/inline-ai-panel.test.ts test_files/unit/views/reader-view-ai-actions.test.ts test_files/unit/main/ai-operation-wiring.test.ts test_files/unit/docs/public-release-documentation.test.ts`

Expected: PASS without real provider calls.

- [ ] **Step 5: Run repository policy checks**

Run: `npm run audit:i18n && npm run check:platform && npm run check:public && npm run check:css-scope && npm run check:important && git diff --check`

Expected: PASS; searches find no key, authorization header value, raw SSE fixture outside tests, or obsolete modal reference.

- [ ] **Step 6: Commit**

```bash
git add README.md docs test_files/unit/docs/public-release-documentation.test.ts
git commit -m "docs: explain inline AI persistence"
```
