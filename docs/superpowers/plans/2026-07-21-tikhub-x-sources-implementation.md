# RSS Dashboard CN TikHub and X Sources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add paid, bounded TikHub collection for watched X accounts and topic discovery while keeping credentials outside the Obsidian vault and storing observations in the same neutral collection pipeline as RSS.

**Architecture:** Represent X inputs as typed source configurations and route them through source adapters. A TikHub client owns authenticated HTTP calls, request budgets, error classification, and redaction; response parsers convert provider payloads into a small internal `XPost` type; account/topic adapters map those posts into `FeedItem` and `CollectedItem`. Account subscriptions and saved topics participate in daily-on-open refresh, and manual refresh uses the same path.

**Tech Stack:** TypeScript, Obsidian desktop API, Node `fs/promises` and `os`, TikHub Twitter Web API, Vitest with sanitized JSON fixtures.

## Global Constraints

- TikHub is optional. RSS, websites, and YouTube must work without a TikHub key.
- Use `GET /api/v1/twitter/web/fetch_user_post_tweet` for account posts and `GET /api/v1/twitter/web/fetch_search_timeline` for topic search.
- Use `GET /api/v1/twitter/web/fetch_user_tweet_replies` only when a watched account explicitly enables replies; explain that it is an additional billable request.
- Default account mode retains original posts and excludes replies/reposts. Replies and reposts are independent per-account switches.
- Topic discovery stores TikHub/X `Latest` and `Top` as observation categories. Never rename `Top` to a plugin recommendation or quality judgment.
- Do not write, like, repost, follow, or otherwise mutate X.
- Do not download X images/video; store original URLs and text metadata only.
- Enforce request caps before issuing a paid request. Display estimates as estimates, never as an invoice.
- Never store TikHub keys in plugin settings, the vault, git, fixtures, logs, thrown URLs, or notices.
- Run focused tests before implementation and commit after each completed task.

---

## Task 1: Build the external desktop secret store and redaction layer

**Files:**

- Create: `src/security/secret-types.ts`
- Create: `src/security/secret-path.ts`
- Create: `src/security/desktop-secret-store.ts`
- Create: `src/security/redaction.ts`
- Create: `test_files/unit/security/secret-path.test.ts`
- Create: `test_files/unit/security/desktop-secret-store.test.ts`
- Create: `test_files/unit/security/redaction.test.ts`

- [ ] **Step 1: Write failing platform-path and permission tests**

Prove these exact paths:

```text
macOS:   ~/Library/Application Support/rss-dashboard-cn/secrets.json
Windows: %APPDATA%/rss-dashboard-cn/secrets.json
Linux:   $XDG_CONFIG_HOME/rss-dashboard-cn/secrets.json
fallback ~/.config/rss-dashboard-cn/secrets.json
```

Also prove:

- A first write creates the parent directory and JSON file.
- Unix directory mode is `0700` and file mode is `0600` after every write.
- A key can be set, read, replaced, and deleted by connection ID.
- Writes use a temporary sibling followed by rename.
- Redaction removes `Bearer ...`, `x-api-key`, `api_key`, `token`, and URL query values.
- Returned settings/status objects expose only `hasSecret`, never the secret value.

- [ ] **Step 2: Run tests and confirm modules are missing**

Run: `npm run test:unit -- test_files/unit/security/secret-path.test.ts test_files/unit/security/desktop-secret-store.test.ts test_files/unit/security/redaction.test.ts`

Expected: FAIL.

- [ ] **Step 3: Define the secret file schema**

Use:

```ts
interface SecretFileV1 {
  schemaVersion: 1;
  secrets: Record<string, { apiKey: string; updatedAt: string }>;
}
```

Connection IDs are non-secret UUIDs stored in plugin settings. The store API accepts only those IDs; provider names are metadata outside this file.

- [ ] **Step 4: Implement atomic read/write and permission correction**

Reject symlinks for the secret file path. Parse invalid JSON as a typed `SecretStoreCorruptError` and preserve the bad file; do not overwrite it silently. Write JSON with no request history or metadata beyond the schema above.

- [ ] **Step 5: Implement reusable redaction**

Expose:

```ts
redactSensitiveText(input: string): string;
sanitizeExternalError(error: unknown): { code: string; message: string };
```

Cap public messages at 300 characters. Keep status code and safe provider message, but strip query strings, authorization material, and response bodies.

- [ ] **Step 6: Re-run tests**

Run: `npm run test:unit -- test_files/unit/security/secret-path.test.ts test_files/unit/security/desktop-secret-store.test.ts test_files/unit/security/redaction.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/security test_files/unit/security
git commit -m "feat: add external desktop secret storage"
```

## Task 2: Add typed source adapters and X source settings

**Files:**

- Create: `src/sources/source-adapter.ts`
- Create: `src/sources/source-registry.ts`
- Create: `src/sources/source-config.ts`
- Create: `test_files/unit/sources/source-registry.test.ts`
- Create: `test_files/unit/sources/source-config.test.ts`
- Modify: `src/types/types.ts`
- Modify: `src/utils/settings-loader.ts`
- Modify: `test_files/unit/utils/settings-loader.test.ts`

- [ ] **Step 1: Write failing source configuration tests**

Test migration of existing feeds to `sourceKind: "feed"`, validation of watched accounts and topics, and stable synthetic URLs:

```text
tikhub://x-account/{lowercase-handle}
tikhub://x-topic/{topic-id}
```

Reject handles containing `@`, spaces, query strings, or path separators after normalization. Deduplicate handles case-insensitively.

- [ ] **Step 2: Run tests and confirm source types are absent**

Run: `npm run test:unit -- test_files/unit/sources/source-config.test.ts test_files/unit/sources/source-registry.test.ts test_files/unit/utils/settings-loader.test.ts`

Expected: FAIL.

- [ ] **Step 3: Define discriminated source configuration**

Use:

```ts
export interface XAccountSourceConfig {
  kind: "x-account";
  id: string;
  handle: string;
  displayName?: string;
  includeReplies: boolean;
  includeReposts: boolean;
  folder: string;
  topics: string[];
}

export interface XTopicSourceConfig {
  kind: "x-topic";
  id: string;
  name: string;
  includeKeywords: string[];
  excludeKeywords: string[];
  priorityAccounts: string[];
  windowDays: 1 | 3 | 7 | 14 | 30;
  folder: string;
}
```

Add `sourceKind` and `sourceConfig` to `Feed` as an additive migration so upstream code continues to treat standard feeds normally.

- [ ] **Step 4: Define the adapter contract**

```ts
export interface SourceRefreshContext {
  now: Date;
  signal?: AbortSignal;
}

export interface SourceRefreshOutput {
  feed: Feed;
  items: FeedItem[];
  providerRequestCount: number;
  warnings: string[];
}

export interface SourceAdapter<TConfig extends SourceConfig> {
  kind: TConfig["kind"];
  refresh(config: TConfig, context: SourceRefreshContext): Promise<SourceRefreshOutput>;
}
```

The registry throws a localized unsupported-source error rather than silently falling back to RSS parsing.

- [ ] **Step 5: Re-run tests**

Run: `npm run test:unit -- test_files/unit/sources/source-config.test.ts test_files/unit/sources/source-registry.test.ts test_files/unit/utils/settings-loader.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/sources src/types/types.ts src/utils/settings-loader.ts test_files/unit/sources test_files/unit/utils/settings-loader.test.ts
git commit -m "feat: add typed X source configurations"
```

## Task 3: Implement TikHub client, error mapping, and paid-request budgets

**Files:**

- Create: `src/sources/tikhub/tikhub-types.ts`
- Create: `src/sources/tikhub/tikhub-client.ts`
- Create: `src/sources/tikhub/request-budget.ts`
- Create: `src/sources/tikhub/request-ledger.ts`
- Create: `test_files/unit/sources/tikhub/tikhub-client.test.ts`
- Create: `test_files/unit/sources/tikhub/request-budget.test.ts`
- Create: `test_files/unit/sources/tikhub/request-ledger.test.ts`
- Modify: `src/types/types.ts`

- [ ] **Step 1: Write client and budget tests using mocked requests**

Assert exact request behavior:

```text
GET {baseUrl}/api/v1/twitter/web/fetch_user_post_tweet?screen_name={handle}
GET {baseUrl}/api/v1/twitter/web/fetch_user_tweet_replies?screen_name={handle}
GET {baseUrl}/api/v1/twitter/web/fetch_search_timeline?keyword={query}&search_type=Latest
GET {baseUrl}/api/v1/twitter/web/fetch_search_timeline?keyword={query}&search_type=Top
Authorization: Bearer {external-secret}
```

Do not send `rest_id` when using `screen_name`; omit empty `cursor` instead of serializing `undefined`.

Also test 401/403 invalid key, 402/429 balance/rate constraints, 422 invalid query, 5xx provider failure, timeout, malformed JSON, provider `code !== 200`, and abort.

- [ ] **Step 2: Run tests and confirm failure**

Run: `npm run test:unit -- test_files/unit/sources/tikhub/tikhub-client.test.ts test_files/unit/sources/tikhub/request-budget.test.ts test_files/unit/sources/tikhub/request-ledger.test.ts`

Expected: FAIL.

- [ ] **Step 3: Add TikHub connection metadata to settings**

Use:

```ts
interface TikHubSettings {
  enabled: boolean;
  connectionId: string;
  baseUrl: "https://api.tikhub.dev" | "https://api.tikhub.io" | string;
  timeoutMs: number;
  maxRequestsPerRun: number;
  maxRequestsPerDay: number;
}
```

Defaults: disabled, `.dev`, 20-second timeout, 40 requests per run, 100 per local date. Custom base URLs must be HTTPS and may not include a path, query, or fragment.

- [ ] **Step 4: Implement a reservation-based request budget**

Before each HTTP call, atomically reserve one request in `.rss-dashboard-data/state/tikhub-requests.json`. Store local date and counts only; never store endpoints, keywords, handles, URLs, or provider response data. If a network call is never attempted because secret lookup fails or an earlier batch call aborts the remaining work, release every unused reservation. If a request reaches the network, count it even when the provider rejects it.

- [ ] **Step 5: Implement the client**

Use Obsidian `requestUrl` or the existing request abstraction so CORS does not determine behavior. The client accepts the API key as a method-scoped value and never stores it on a long-lived public object. Parse the TikHub envelope and return only `data` plus a safe request ID for diagnostics.

- [ ] **Step 6: Re-run tests**

Run: `npm run test:unit -- test_files/unit/sources/tikhub/tikhub-client.test.ts test_files/unit/sources/tikhub/request-budget.test.ts test_files/unit/sources/tikhub/request-ledger.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/sources/tikhub src/types/types.ts test_files/unit/sources/tikhub
git commit -m "feat: add bounded TikHub API client"
```

## Task 4: Capture sanitized live fixtures and build a defensive X parser

**Files:**

- Create: `scripts/capture-tikhub-fixtures.mjs`
- Create: `scripts/sanitize-tikhub-fixture.mjs`
- Create: `test_files/fixtures/tikhub/account-posts.json`
- Create: `test_files/fixtures/tikhub/search-latest.json`
- Create: `test_files/fixtures/tikhub/search-top.json`
- Create: `src/sources/tikhub/x-post.ts`
- Create: `src/sources/tikhub/tikhub-parser.ts`
- Create: `test_files/unit/sources/tikhub/tikhub-parser.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Create synthetic minimal fixtures and failing parser tests**

Tests must cover an original post, reply, repost, quote, thread continuation, URL entity, external article link, missing metrics, deleted/unavailable entry, cursor instruction, and an unknown entry type. Unknown/malformed entries are skipped with warnings; they never abort the whole response.

- [ ] **Step 2: Run parser tests and confirm failure**

Run: `npm run test:unit -- test_files/unit/sources/tikhub/tikhub-parser.test.ts`

Expected: FAIL.

- [ ] **Step 3: Define the provider-neutral X record**

```ts
export interface XPost {
  id: string;
  authorHandle: string;
  authorName?: string;
  text: string;
  createdAt?: string;
  url: string;
  conversationId?: string;
  inReplyToId?: string;
  repostOfId?: string;
  quoteOfId?: string;
  externalUrls: string[];
  metrics: { replies?: number; reposts?: number; likes?: number; quotes?: number; views?: number };
}
```

Parse multiple known Twitter GraphQL nesting shapes by walking instruction entries and recognizing tweet-result objects, but emit only this internal shape. Do not expose the raw provider response to views or repositories.

- [ ] **Step 4: Implement a sanitizing fixture capture script**

The script reads `TIKHUB_API_KEY` only from the process environment, performs exactly three calls—one account page, one `Latest` search, one `Top` search—then removes request IDs, cache URLs, support metadata, cursors, personal query inputs, and volatile timestamps before writing fixtures. Replace the tested handle and keywords with stable fixture aliases while preserving response structure. Abort before any call if the destination fixture directory is dirty in git.

- [ ] **Step 5: Add explicit capture command**

Add:

```json
{
  "scripts": {
    "fixtures:tikhub": "node scripts/capture-tikhub-fixtures.mjs"
  }
}
```

Document inside the script's `--help` output that the command makes three potentially billable requests. Never run it automatically from tests or build.

- [ ] **Step 6: Capture and inspect live response shapes once a valid key is available**

Run after the user has exported `TIKHUB_API_KEY` in the invoking shell: `npm run fixtures:tikhub`

Expected: exactly three requests reported, three sanitized fixture files written, and `rg -n 'Bearer|api_key|request_id|cache_url|TIKHUB_API_KEY' test_files/fixtures/tikhub` returns no matches.

If a key is unavailable, complete the parser against synthetic fixtures but mark TikHub live verification incomplete; do not claim public-release readiness until this step passes.

- [ ] **Step 7: Re-run parser tests against sanitized live shapes**

Run: `npm run test:unit -- test_files/unit/sources/tikhub/tikhub-parser.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add scripts/capture-tikhub-fixtures.mjs scripts/sanitize-tikhub-fixture.mjs test_files/fixtures/tikhub src/sources/tikhub/x-post.ts src/sources/tikhub/tikhub-parser.ts test_files/unit/sources/tikhub/tikhub-parser.test.ts package.json
git commit -m "test: capture sanitized TikHub response shapes"
```

## Task 5: Implement watched-account collection

**Files:**

- Create: `src/sources/tikhub/x-account-adapter.ts`
- Create: `src/sources/tikhub/x-feed-mapper.ts`
- Create: `test_files/unit/sources/tikhub/x-account-adapter.test.ts`
- Modify: `src/sources/source-registry.ts`

- [ ] **Step 1: Write adapter tests**

Assert:

- A default account refresh makes one account-post request.
- Original posts are retained; replies and reposts are excluded by default.
- `includeReposts` changes filtering without making another request.
- `includeReplies` makes exactly one additional reply request and merges/deduplicates IDs.
- A missing/invalid key fails before a paid request and returns a localized actionable error.
- X post text becomes title/excerpt without HTML execution.
- Stable item identity is based on X post ID, not mutable metrics.
- Metrics updates merge into the same record.

- [ ] **Step 2: Run tests and confirm failure**

Run: `npm run test:unit -- test_files/unit/sources/tikhub/x-account-adapter.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement mapping**

Use post ID as `guid`, `https://x.com/{handle}/status/{post-id}` as canonical URL, `contentBasis: "x-post"`, `sourceType: "x-account"`, and the configured source folder as `sourceBucket`. Truncate list titles to 120 Unicode code points but preserve complete post text in the feed description/content field.

- [ ] **Step 4: Implement account filtering and deduplication**

Define original as neither reply nor repost. Quotes remain originals with `quoteOfId`. When replies are enabled, merge the reply endpoint response by post ID. Sort by created time descending and ID as a deterministic tie-breaker.

- [ ] **Step 5: Register the adapter**

Resolve the key from `DesktopSecretStore` per refresh, reserve budget before calls, and release all local references after mapping completes.

- [ ] **Step 6: Re-run tests**

Run: `npm run test:unit -- test_files/unit/sources/tikhub/x-account-adapter.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/sources/tikhub/x-account-adapter.ts src/sources/tikhub/x-feed-mapper.ts src/sources/source-registry.ts test_files/unit/sources/tikhub/x-account-adapter.test.ts
git commit -m "feat: collect watched X accounts through TikHub"
```

## Task 6: Implement topic discovery with Latest and platform Top

**Files:**

- Create: `src/sources/tikhub/x-search-query.ts`
- Create: `src/sources/tikhub/x-topic-adapter.ts`
- Create: `src/sources/tikhub/linked-page-grouper.ts`
- Create: `test_files/unit/sources/tikhub/x-search-query.test.ts`
- Create: `test_files/unit/sources/tikhub/x-topic-adapter.test.ts`
- Create: `test_files/unit/sources/tikhub/linked-page-grouper.test.ts`
- Modify: `src/sources/source-registry.ts`

- [ ] **Step 1: Write query and adapter tests**

Cover:

- Chinese/English include terms are OR-grouped and quoted when necessary.
- Exclusions become `-"term"` clauses.
- `since:YYYY-MM-DD` is computed from the configured local window.
- The same query is sent once with `Latest` and once with `Top`.
- Priority accounts add one optional `Latest` query scoped to `(from:a OR from:b)`; empty priority accounts do not add a request.
- Client-side date filtering enforces 1/3/7/14/30 days even if the provider ignores `since:`.
- Results retain `observationType` metadata `latest`, `platform-top`, or `priority-account` without a plugin score.
- Duplicate post IDs merge their observation categories.
- A shared external article URL groups related posts but does not label the page high-value.

- [ ] **Step 2: Run tests and confirm failure**

Run: `npm run test:unit -- test_files/unit/sources/tikhub/x-search-query.test.ts test_files/unit/sources/tikhub/x-topic-adapter.test.ts test_files/unit/sources/tikhub/linked-page-grouper.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement safe X query construction**

Normalize whitespace, reject control characters, cap each term at 100 code points, cap the complete query at 500 code points, and require at least one include term. Treat X search operators from user input as literal quoted text; only the builder may add `since:` and `from:` operators.

- [ ] **Step 4: Implement topic refresh request planning**

Before executing calls, produce an exact plan and ask the request budget to reserve the whole batch. A normal topic costs two requests; a topic with priority accounts costs three. If the remaining budget cannot cover the batch, make no partial topic calls and record a budget warning. Commit reservations as calls reach the network and release any unattempted tail when an earlier call fails or the user cancels.

- [ ] **Step 5: Map observation categories without changing the collection schema contract**

Add `observationTags?: string[]` to the X source metadata carried by `FeedItem`, then map it into deterministic collection `topics` such as `x:latest`, `x:platform-top`, and `x:priority-account`. Do not overload the collection `ObservationType` field, which remains `new | updated | rediscovered`.

- [ ] **Step 6: Group shared linked pages**

Canonicalize non-X external URLs and expose groups in topic view data. Keep every X post as its own collected item. The group contains `url`, objective post count, authors, and post IDs; it contains no score or recommendation.

- [ ] **Step 7: Re-run tests**

Run: `npm run test:unit -- test_files/unit/sources/tikhub/x-search-query.test.ts test_files/unit/sources/tikhub/x-topic-adapter.test.ts test_files/unit/sources/tikhub/linked-page-grouper.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/sources/tikhub/x-search-query.ts src/sources/tikhub/x-topic-adapter.ts src/sources/tikhub/linked-page-grouper.ts src/sources/source-registry.ts test_files/unit/sources/tikhub
git commit -m "feat: add neutral X topic discovery"
```

## Task 7: Add TikHub, account, and topic settings UI

**Files:**

- Create: `src/settings/tabs/sources-settings-tab.ts`
- Create: `src/settings/tabs/topic-discovery-settings-tab.ts`
- Create: `src/settings/tabs/tikhub-settings-tab.ts`
- Create: `src/modals/x-account-source-modal.ts`
- Create: `src/modals/x-topic-source-modal.ts`
- Create: `test_files/unit/settings/sources-settings-tab.test.ts`
- Create: `test_files/unit/settings/topic-discovery-settings-tab.test.ts`
- Create: `test_files/unit/settings/tikhub-settings-tab.test.ts`
- Create: `test_files/unit/modals/x-account-source-modal.test.ts`
- Create: `test_files/unit/modals/x-topic-source-modal.test.ts`
- Modify: `src/settings/settings-tab.ts`
- Modify: `src/settings/tab-names.ts`
- Modify: `src/i18n/en.ts`
- Modify: `src/i18n/zh-cn.ts`

- [ ] **Step 1: Write UI tests first**

Assert:

- TikHub can be disabled without deleting source definitions.
- Base presets show mainland `.dev`, overseas `.io`, and validated custom HTTPS.
- The key field is always blank/masked after save; the UI shows only configured/not configured.
- Test connection makes one explicitly confirmed request only when the user clicks it.
- Account modal defaults replies/reposts to off and displays the extra-request warning.
- Topic window offers exactly 1, 3, 7, 14, 30 with 7 selected by default.
- Before save/test, the UI shows the estimated requests per refresh and the configured caps.
- Invalid/expired key and insufficient balance have distinct Chinese messages.

- [ ] **Step 2: Run tests and confirm failure**

Run: `npm run test:unit -- test_files/unit/settings/sources-settings-tab.test.ts test_files/unit/settings/topic-discovery-settings-tab.test.ts test_files/unit/settings/tikhub-settings-tab.test.ts test_files/unit/modals/x-account-source-modal.test.ts test_files/unit/modals/x-topic-source-modal.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement key save/delete without settings persistence**

On save, write the key directly to `DesktopSecretStore`, clear the input element value, update only `hasSecret`, and never pass the key to `plugin.saveSettings()`. Deleting requires confirmation and disables paid refresh until a new key is stored.

- [ ] **Step 4: Implement source editors**

Display request math before save:

```text
account: 1 request (+1 when replies enabled)
topic: 2 requests (+1 when priority accounts are configured)
```

Label this as an estimate because pricing and provider behavior can change.

- [ ] **Step 5: Re-run tests**

Run: `npm run test:unit -- test_files/unit/settings/sources-settings-tab.test.ts test_files/unit/settings/topic-discovery-settings-tab.test.ts test_files/unit/settings/tikhub-settings-tab.test.ts test_files/unit/modals/x-account-source-modal.test.ts test_files/unit/modals/x-topic-source-modal.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/settings src/modals/x-account-source-modal.ts src/modals/x-topic-source-modal.ts src/i18n test_files/unit/settings test_files/unit/modals/x-account-source-modal.test.ts test_files/unit/modals/x-topic-source-modal.test.ts
git commit -m "feat: add X subscription and TikHub settings"
```

## Task 8: Integrate X sources into daily refresh and dashboard

**Files:**

- Modify: `main.ts`
- Modify: `src/services/collection-service.ts`
- Modify: `src/views/dashboard-view.ts`
- Create: `src/views/topic-discovery-section.ts`
- Modify: `test_files/unit/main/feed-refresh-pipeline.test.ts`
- Modify: `test_files/unit/services/collection-service.test.ts`
- Modify: `test_files/unit/views/dashboard-collection-sections.test.ts`
- Create: `test_files/unit/views/topic-discovery-section.test.ts`

- [ ] **Step 1: Write end-to-end orchestration tests with mocked TikHub client**

Prove:

- Enabled X accounts/topics participate in daily-on-open refresh.
- Disabled TikHub sources report configuration errors without blocking RSS sources.
- X data writes JSONL and daily Markdown before source ledger success.
- Every X topic result returned for the configured window is observed in that day's snapshot, so an unchanged post seen again on a later date is marked `rediscovered` rather than omitted.
- Account/topic manual refresh uses the same adapter and budget.
- The topic section visually separates `最新`, `平台 Top`, and `重点账号命中`.
- The dashboard can filter by account, topic, observation tag, date, starred, saved, and read state.
- No X item receives an automatically generated quality score.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `npm run test:unit -- test_files/unit/main/feed-refresh-pipeline.test.ts test_files/unit/services/collection-service.test.ts test_files/unit/views/dashboard-collection-sections.test.ts test_files/unit/views/topic-discovery-section.test.ts`

Expected: FAIL.

- [ ] **Step 3: Route source kinds through the registry**

Standard `feed` sources continue through the upstream parser. `x-account` and `x-topic` use registered adapters. Convert all outputs to the existing collection pipeline; do not add a separate X database. Account sources collect new/materially changed posts; topic sources intentionally pass every returned in-window result to the daily repository so cross-date rediscovery remains visible.

- [ ] **Step 4: Add topic discovery presentation**

Display provider categories and objective engagement metrics with a fetched timestamp. Metrics are optional and provider-supplied; label missing values as unavailable, not zero. Linked-page groups show only factual counts and sources.

- [ ] **Step 5: Re-run tests**

Run: `npm run test:unit -- test_files/unit/main/feed-refresh-pipeline.test.ts test_files/unit/services/collection-service.test.ts test_files/unit/views/dashboard-collection-sections.test.ts test_files/unit/views/topic-discovery-section.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add main.ts src/services/collection-service.ts src/views test_files/unit/main/feed-refresh-pipeline.test.ts test_files/unit/services/collection-service.test.ts test_files/unit/views
git commit -m "feat: integrate X sources into daily collection"
```

## Task 9: Complete TikHub regression, privacy, and cost checks

**Files:**

- Modify only if verification exposes a defect.

- [ ] **Step 1: Scan tracked files for secrets and raw TikHub envelopes**

Run: `git grep -n -E 'Bearer [A-Za-z0-9._-]{12,}|TIKHUB_API_KEY=|"request_id"|"cache_url"' -- ':!docs/superpowers/plans/*' ':!test_files/unit/security/*'`

Expected: no secret or raw-envelope matches. Test strings that deliberately validate redaction may remain only in the excluded security tests.

- [ ] **Step 2: Run all unit tests**

Run: `npm run test:unit`

Expected: all tests PASS.

- [ ] **Step 3: Run localization audit, lint, and build**

Run: `npm run audit:i18n && npm run lint && npm run build`

Expected: all commands exit 0.

- [ ] **Step 4: Perform one bounded manual TikHub smoke test**

In a disposable vault with low caps, configure one account and one topic. Confirm the UI predicts three requests total when replies/priority accounts are off, daily collection succeeds, a second same-day Obsidian restart makes no automatic paid requests, and manual refresh clearly reports its request estimate before execution.

- [ ] **Step 5: Verify external secret location and permissions**

On macOS run: `stat -f '%Sp %N' "$HOME/Library/Application Support/rss-dashboard-cn/secrets.json"`

Expected: `-rw-------` for the file. Confirm no secret file exists anywhere inside the disposable vault.

- [ ] **Step 6: Commit verification fixes if needed**

If no correction was needed, do not create an empty commit. Otherwise:

```bash
git add -u
git commit -m "fix: complete TikHub integration verification"
```

## Acceptance Checklist

- [ ] Default account collection includes originals only; replies/reposts are explicit switches.
- [ ] Topic collection supports bilingual includes, exclusions, priority accounts, and 1/3/7/14/30-day windows.
- [ ] `Latest` and platform `Top` remain provider categories, not plugin judgments.
- [ ] Paid requests are predicted, reserved, capped, and counted without storing sensitive query history.
- [ ] A missing or invalid key never creates empty collection/analysis files.
- [ ] TikHub failure does not block RSS, website, or YouTube refresh.
- [ ] Secrets are external to the vault with Unix `0600` permissions.
- [ ] Live fixtures were captured with no more than three explicit paid calls and sanitized before commit.
- [ ] Unit tests, localization audit, lint, and build pass.
