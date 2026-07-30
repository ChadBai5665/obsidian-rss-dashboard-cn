# YouTube TikHub Transcript Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicitly enabled TikHub fallback to on-demand YouTube transcript retrieval while preserving free-first behavior, durable local Markdown caching, paid-request limits, and all existing user data.

**Architecture:** Keep `YouTubeTranscriptService` as the reader-facing orchestrator, but replace its hard-coded two-provider path with an ordered provider chain: InnerTube, TikHub, then local `yt-dlp`. Extend the existing TikHub client with two paid caption operations and one tightly allowlisted free async-result operation; persist async job IDs below the configured data root so reopening Obsidian resumes rather than recreates a paid job.

**Tech Stack:** TypeScript 5.9, Obsidian 1.8 APIs, Node.js 20.19+, Vitest 4, existing vault adapter repositories, desktop secret store, and TikHub request ledger.

## Global Constraints

- Provider order is exactly: durable cache → InnerTube → TikHub → local `yt-dlp`.
- TikHub captions run only after “获取字幕” or “重新获取”; startup/interval refresh, history import, and background collection never request captions.
- `tikhub.youtubeTranscriptFallbackEnabled` defaults to `false` for public installs and imports.
- Each paid caption operation is estimated at `$0.008 USD` from the 2026-07-29 endpoint docs; UI copy must say “预计”.
- The free async-result endpoint never consumes the paid ledger and never becomes a generic unmetered request primitive.
- API keys remain only in external desktop `secrets.json`; no key, auth header, provider payload, credential URL, or raw response enters the vault, logs, fixtures, exports, or Git.
- Existing schemaVersion 1 full-text cache and schemaVersion 2 InnerTube/`yt-dlp` transcript cache remain readable without bulk rewrite.
- Installation replaces only `main.js`, `manifest.json`, and `styles.css`; preserve `data.json`, external secrets, `.rss-dashboard-data`, subscriptions, history, AI output, and user Markdown.
- The separate AI analysis Markdown write failure is outside this plan.
- Automated tests use fake transports and sanitized fixtures. No live TikHub call occurs before a fresh authorization for one named video and at most two paid requests.

## File Map

- `src/types/types.ts`, `src/utils/settings-loader.ts`, `src/security/public-settings-export.ts`: persisted opt-in and import/export policy.
- `src/settings/tabs/tikhub-settings-tab.ts`: fallback toggle and price disclosure.
- `src/sources/tikhub/youtube-caption-response.ts`: strict response projection.
- `src/sources/tikhub/tikhub-client.ts`: exact paid caption and free result requests.
- `src/youtube-transcript/tikhub-caption-job-repository.ts`: atomic pending-job state.
- `src/youtube-transcript/tikhub-transcript-provider.ts`: TikHub adapter and bounded polling.
- `src/youtube-transcript/transcript-types.ts`, `src/youtube-transcript/youtube-transcript-service.ts`: provider types and ordered orchestration.
- `src/collection/content-repository.ts`: `provider: tikhub` cache support.
- `src/components/youtube-transcript-panel.ts`: progress, usage, and errors.
- `main.ts`: lazy settings, key, budget, client, and repository wiring.
- `src/i18n/zh-cn.ts`, `src/i18n/en.ts`, `src/styles/youtube-transcript.css`: compact bilingual UI.
- `README.md`, `docs/PRIVACY.zh-CN.md`, release docs: public boundaries.

---

### Task 1: Persist an Explicit, Public-Safe Caption Opt-In

**Files:**
- Modify: `src/types/types.ts`
- Modify: `src/utils/settings-loader.ts`
- Modify: `src/security/public-settings-export.ts`
- Modify: `src/settings/tabs/tikhub-settings-tab.ts`
- Modify: `src/i18n/zh-cn.ts`
- Modify: `src/i18n/en.ts`
- Test: `test_files/unit/utils/settings-loader.test.ts`
- Test: `test_files/unit/security/public-settings-export.test.ts`
- Test: `test_files/unit/settings/tikhub-settings-tab.test.ts`

**Interfaces:**
- Produces: `TikHubSettings.youtubeTranscriptFallbackEnabled: boolean`
- Consumes: current TikHub enable flag, connection identity, endpoint, timeout, and caps.

- [ ] **Step 1: Write failing normalization/export/UI tests**

Add concrete assertions:

```ts
expect(loadAndNormalizeSettings({
  tikhub: { ...DEFAULT_SETTINGS.tikhub },
}).tikhub.youtubeTranscriptFallbackEnabled).toBe(false);

expect(loadAndNormalizeSettings({
  tikhub: {
    ...DEFAULT_SETTINGS.tikhub,
    youtubeTranscriptFallbackEnabled: true,
  },
}).tikhub.youtubeTranscriptFallbackEnabled).toBe(true);

expect(buildPublicSettingsExport(settingsFixture(), {
  includeSources: false,
}).tikhub).toMatchObject({
  youtubeTranscriptFallbackEnabled: true,
});
```

Also test inherited/getter-backed values are ignored, public import disables TikHub and clears connection binding, the toggle rolls back on save failure, and rendering/toggling does not read or test the key.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
npx vitest run --config vitest.config.mjs \
  test_files/unit/utils/settings-loader.test.ts \
  test_files/unit/security/public-settings-export.test.ts \
  test_files/unit/settings/tikhub-settings-tab.test.ts
```

Expected: failures because the field and toggle do not exist.

- [ ] **Step 3: Implement the persisted field and toggle**

Use this exact type/default:

```ts
export interface TikHubSettings {
  enabled: boolean;
  youtubeTranscriptFallbackEnabled: boolean;
  connectionId: string;
  baseUrl: "https://api.tikhub.dev" | "https://api.tikhub.io" | string;
  timeoutMs: number;
  maxRequestsPerRun: number;
  maxRequestsPerDay: number;
}

youtubeTranscriptFallbackEnabled: false,
```

Normalize only an own data property equal to `true`. Export the non-secret boolean, but keep imported TikHub connections disabled/unbound. Render the toggle after the main TikHub switch with this meaning: only explicit subtitle actions can use it; first retrieval is usually two requests, estimated `$0.016`. Use the existing busy/rollback save pattern. The toggle itself performs no network or key read.

- [ ] **Step 4: Verify settings and localization**

```bash
npx vitest run --config vitest.config.mjs \
  test_files/unit/utils/settings-loader.test.ts \
  test_files/unit/security/public-settings-export.test.ts \
  test_files/unit/settings/tikhub-settings-tab.test.ts
npm run audit:i18n
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/types/types.ts src/utils/settings-loader.ts \
  src/security/public-settings-export.ts \
  src/settings/tabs/tikhub-settings-tab.ts \
  src/i18n/zh-cn.ts src/i18n/en.ts \
  test_files/unit/utils/settings-loader.test.ts \
  test_files/unit/security/public-settings-export.test.ts \
  test_files/unit/settings/tikhub-settings-tab.test.ts
git commit -m "feat: add TikHub caption fallback opt-in"
```

### Task 2: Add a Strict TikHub Caption Response and Request Contract

**Files:**
- Create: `src/sources/tikhub/youtube-caption-response.ts`
- Modify: `src/sources/tikhub/tikhub-client.ts`
- Modify: `src/sources/tikhub/tikhub-types.ts`
- Create: `test_files/unit/sources/tikhub/youtube-caption-response.test.ts`
- Modify: `test_files/unit/sources/tikhub/tikhub-client.test.ts`

**Interfaces:**
- Produces: `parseTikHubCaptionResponse(value, expectedVideoId): TikHubCaptionResponse`
- Produces: `TikHubClient.fetchYouTubeCaptions(input)`
- Produces: `TikHubClient.fetchYouTubeCaptionResult(input)`
- Consumes: existing safe transport, envelope projection, timeout, and budget.

- [ ] **Step 1: Write failing parser tests**

Test documented list, content, processing, pending, and empty-caption shapes:

```ts
expect(parseTikHubCaptionResponse({
  video_id: "dQw4w9WgXcQ",
  captions: [
    { language_code: "en", language_name: "English" },
    { language_code: "a.zh-Hans", language_name: "Chinese (auto)" },
  ],
}, "dQw4w9WgXcQ")).toEqual({
  kind: "tracks",
  videoId: "dQw4w9WgXcQ",
  tracks: [
    { languageCode: "en", languageName: "English", isGenerated: false },
    { languageCode: "a.zh-Hans", languageName: "Chinese (auto)", isGenerated: true },
  ],
});

expect(parseTikHubCaptionResponse({
  video_id: "dQw4w9WgXcQ",
  status: "processing",
  job_id: "123e4567-e89b-12d3-a456-426614174000",
}, "dQw4w9WgXcQ")).toMatchObject({
  kind: "processing",
  jobId: "123e4567-e89b-12d3-a456-426614174000",
});
```

Also cover completed `format: "txt"` with non-empty `content`, queued/active result, mismatched video IDs, duplicate languages, accessors, inherited fields, controls, oversized lists/text, invalid job IDs, and unknown statuses.

- [ ] **Step 2: Write failing exact-request tests**

```ts
await client.fetchYouTubeCaptions({
  ...sanitizedCaptionAuthFixture(),
  videoId: "dQw4w9WgXcQ",
});
expect(request.url).toBe(
  "https://api.tikhub.dev/api/v1/youtube/web_v2/get_video_captions?video_id=dQw4w9WgXcQ",
);
expect(reserve).toHaveBeenCalledWith(1);

await client.fetchYouTubeCaptionResult({
  ...sanitizedCaptionAuthFixture(),
  jobId: "123e4567-e89b-12d3-a456-426614174000",
  format: "txt",
});
expect(reserve).not.toHaveBeenCalled();
```

Add the content URL assertion with `language_code=en&format=txt` and international-base parity.

- [ ] **Step 3: Run tests and verify RED**

```bash
npx vitest run --config vitest.config.mjs \
  test_files/unit/sources/tikhub/youtube-caption-response.test.ts \
  test_files/unit/sources/tikhub/tikhub-client.test.ts
```

Expected: missing parser and client methods.

- [ ] **Step 4: Implement the response union**

```ts
export type TikHubCaptionResponse =
  | { kind: "tracks"; videoId: string; tracks: TikHubCaptionTrack[] }
  | { kind: "content"; videoId: string; languageCode: string; languageName: string; isGenerated: boolean; text: string }
  | { kind: "processing"; videoId: string; jobId: string }
  | { kind: "pending"; jobId: string }
  | { kind: "no-captions"; videoId: string };
```

Read only own data properties. Reject getters/prototypes, duplicate conflicts, more than 256 tracks, unsafe language fields, oversized text, and unknown fields/statuses. Infer generated captions from the documented `a.` code prefix unless an own boolean agrees.

- [ ] **Step 5: Implement two metered methods and one allowlisted free method**

```ts
export interface TikHubYouTubeCaptionRequest {
  apiKey: string;
  videoId: string;
  languageCode?: string;
  format?: "txt";
  signal?: AbortSignal;
}

export interface TikHubYouTubeCaptionResultRequest {
  apiKey: string;
  jobId: string;
  format: "txt";
  signal?: AbortSignal;
}
```

Use the existing budgeted request path for `/get_video_captions`. Add a private result-only path hard-coded to `/get_video_captions_result` with identical auth, HTTPS-origin, timeout, abort, response-limit, envelope, request-ID, and status checks but no budget reservation. Do not add a public `metered: false` option.

- [ ] **Step 6: Verify client safety**

```bash
npx vitest run --config vitest.config.mjs \
  test_files/unit/sources/tikhub/youtube-caption-response.test.ts \
  test_files/unit/sources/tikhub/tikhub-client.test.ts \
  test_files/unit/sources/tikhub/request-budget.test.ts \
  test_files/unit/sources/tikhub/request-ledger.test.ts
```

Expected: pass, with zero reservations for result polling.

- [ ] **Step 7: Commit**

```bash
git add src/sources/tikhub/youtube-caption-response.ts \
  src/sources/tikhub/tikhub-client.ts src/sources/tikhub/tikhub-types.ts \
  test_files/unit/sources/tikhub/youtube-caption-response.test.ts \
  test_files/unit/sources/tikhub/tikhub-client.test.ts
git commit -m "feat: add TikHub YouTube caption client"
```

### Task 3: Persist Pending TikHub Caption Jobs Atomically

**Files:**
- Create: `src/youtube-transcript/tikhub-caption-job-repository.ts`
- Create: `test_files/unit/youtube-transcript/tikhub-caption-job-repository.test.ts`

**Interfaces:**
- Produces: `TikHubCaptionJobRepository.read(key)`, `write(record)`, `remove(key)`
- Produces: `captionJobKey(itemId, videoId, stage, languageCode?)`
- Consumes: Obsidian `Vault`, configured data root, atomic adapter rename/remove.

- [ ] **Step 1: Write failing repository tests**

Persist this exact record below `{dataRoot}/state/youtube-caption-jobs.json`:

```ts
export interface TikHubCaptionJobRecord {
  schemaVersion: 1;
  itemId: string;
  videoId: string;
  stage: "tracks" | "content";
  languageCode?: string;
  format: "txt";
  jobId: string;
  connectionId: string;
  createdAt: string;
  lastCheckedAt: string;
  status: "processing";
}
```

Test same-key serialization, multi-key retention, atomic rollback/recovery, invalid IDs/timestamps/fields, malformed JSON, getter/prototype rejection, and absence of key/auth/payload/transcript fields.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run --config vitest.config.mjs \
  test_files/unit/youtube-transcript/tikhub-caption-job-repository.test.ts
```

Expected: missing module.

- [ ] **Step 3: Implement strict atomic storage**

Persist `{ schemaVersion: 1, jobs: Record<string, TikHubCaptionJobRecord> }`. Validate stable item/video/connection/job/language identities, exact own field sets, and ISO timestamps. Serialize through a process-global queue keyed by vault identity plus path. Follow the request-ledger/content-repository pattern: temp write, old-final backup, final rename, rollback on failure, and cleanup limited to repository-owned siblings.

- [ ] **Step 4: Verify atomicity**

```bash
npx vitest run --config vitest.config.mjs \
  test_files/unit/youtube-transcript/tikhub-caption-job-repository.test.ts \
  test_files/unit/collection/content-repository.test.ts \
  test_files/unit/sources/tikhub/request-ledger.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/youtube-transcript/tikhub-caption-job-repository.ts \
  test_files/unit/youtube-transcript/tikhub-caption-job-repository.test.ts
git commit -m "feat: persist TikHub caption jobs"
```

### Task 4: Generalize Transcript Types and Ordered Provider Orchestration

**Files:**
- Modify: `src/youtube-transcript/transcript-types.ts`
- Modify: `src/youtube-transcript/youtube-transcript-service.ts`
- Modify: `src/youtube-transcript/innertube-transcript-provider.ts`
- Modify: `src/youtube-transcript/yt-dlp-transcript-provider.ts`
- Modify: `src/collection/content-repository.ts`
- Modify: `test_files/unit/youtube-transcript/transcript-types.test.ts`
- Modify: `test_files/unit/youtube-transcript/youtube-transcript-service.test.ts`
- Modify: `test_files/unit/collection/content-repository.test.ts`

**Interfaces:**
- Produces: `YouTubeTranscriptProvider = "innertube" | "tikhub" | "yt-dlp"`
- Produces: ordered `TranscriptProviderRegistration[]`
- Produces: progress, usage, and sanitized provider failures.
- Produces: optional `TranscriptProvider.onPersisted()` cleanup hook, invoked only after durable cache write.
- Consumes: cache transactions, metadata repair, choice leases, dedupe, abort logic.

- [ ] **Step 1: Rewrite the service harness and add failing chain tests**

```ts
const providers: TranscriptProviderRegistration[] = [
  { source: "innertube", provider: innerTube },
  { source: "tikhub", provider: tikHub, isAvailable: async () => tikHubEnabled },
  { source: "yt-dlp", provider: ytDlp, isAvailable: async () => ytDlpEnabled },
];

new YouTubeTranscriptService({
  providers,
  contentRepository: content,
  metadataRepository: metadata,
  clock,
});
```

Test cache short-circuit, exact order, unavailable skip, TikHub failure then `yt-dlp`, TikHub processing stop, error precedence, provider-bound language choices, duplicate-click coalescing, and usage 0/1/2.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run --config vitest.config.mjs \
  test_files/unit/youtube-transcript/transcript-types.test.ts \
  test_files/unit/youtube-transcript/youtube-transcript-service.test.ts \
  test_files/unit/collection/content-repository.test.ts
```

Expected: missing provider and ordered options.

- [ ] **Step 3: Add stable types**

```ts
export type YouTubeTranscriptProvider = "innertube" | "tikhub" | "yt-dlp";

export type YouTubeTranscriptProgressStage =
  | "checking-cache"
  | "trying-innertube"
  | "trying-tikhub"
  | "waiting-tikhub"
  | "trying-yt-dlp"
  | "saving";

export interface YouTubeTranscriptUsage {
  tikhubPaidRequests: 0 | 1 | 2;
}

export interface YouTubeTranscriptProgress {
  stage: YouTubeTranscriptProgressStage;
  usage: YouTubeTranscriptUsage;
}

export interface TranscriptProviderRegistration {
  source: YouTubeTranscriptProvider;
  provider: TranscriptProvider;
  isAvailable?: () => Promise<boolean>;
}

export interface TranscriptProvider {
  listTracks(videoId: string, signal?: AbortSignal): Promise<YouTubeCaptionTrack[]>;
  fetchTrack(track: YouTubeCaptionTrack, signal?: AbortSignal): Promise<YouTubeTranscript>;
  onPersisted?(track: YouTubeCaptionTrack, transcript: YouTubeTranscript): Promise<void>;
}
```

Extend requests with a guarded progress callback and ready results with usage. Add static TikHub codes for missing/invalid key, balance, budget, limit, processing, expired job, and malformed response. Never retain raw messages.

- [ ] **Step 4: Implement ordered iteration**

Validate a non-empty, unique-source chain. Preserve current generation tokens, in-flight dedupe, cache transaction, opaque choice IDs, cancellation, and metadata repair. Stop on `tikhub-processing`; otherwise continue for eligible provider errors. Prefer actionable TikHub key/balance/budget failures over generic local unavailability, and never turn auth/network/format failures into `no-captions`. Guard progress callbacks so UI exceptions cannot fail retrieval.

Increment TikHub usage only after a paid list/content call returns a valid response; an empty caption list counts as one. Ambiguous transport failure uses “可能已发送” copy instead of an exact charge claim.

- [ ] **Step 5: Accept `provider: "tikhub"` in schemaVersion 2**

```ts
const transcript = createTranscriptContent({ provider: "tikhub" });
await repository.write(transcript);
expect(await repository.read(ITEM_ID)).toEqual(transcript);
```

Keep all byte-preservation tests for old schemaVersion 1/2 files. Do not migrate old files.

- [ ] **Step 6: Verify transcript regressions**

```bash
npx vitest run --config vitest.config.mjs \
  test_files/unit/youtube-transcript \
  test_files/unit/collection/content-repository.test.ts
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add src/youtube-transcript/transcript-types.ts \
  src/youtube-transcript/youtube-transcript-service.ts \
  src/youtube-transcript/innertube-transcript-provider.ts \
  src/youtube-transcript/yt-dlp-transcript-provider.ts \
  src/collection/content-repository.ts \
  test_files/unit/youtube-transcript \
  test_files/unit/collection/content-repository.test.ts
git commit -m "refactor: order YouTube transcript providers"
```

### Task 5: Implement the TikHub Transcript Provider and Bounded Resume

**Files:**
- Create: `src/youtube-transcript/tikhub-transcript-provider.ts`
- Create: `test_files/unit/youtube-transcript/tikhub-transcript-provider.test.ts`

**Interfaces:**
- Produces: `TikHubTranscriptProvider implements OptionalTranscriptProvider`
- Consumes: caption client/parser, external-key reader, current settings callback, job repository.

- [ ] **Step 1: Write failing provider tests**

Construct with explicit seams:

```ts
new TikHubTranscriptProvider({
  getSettings: () => settings.tikhub,
  getApiKey: async (connectionId) => secretStore.get(connectionId),
  createClient: () => client,
  jobs,
  clock: () => new Date("2026-07-29T10:00:00.000Z"),
  delay: async () => undefined,
  pollIntervalMs: 3_000,
  maxPolls: 10,
});
```

Cover disabled opt-in, invalid connection ID, missing key, list/content success, empty list, `a.` captions, call counts, async list/content persistence, completed free resume, pending after ten polls, abort, changed connection, expired job, malformed data, and every TikHub/budget/ledger error mapping.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run --config vitest.config.mjs \
  test_files/unit/youtube-transcript/tikhub-transcript-provider.test.ts
```

Expected: missing module.

- [ ] **Step 3: Implement lazy availability, key lookup, list, and fetch**

`isAvailable()` returns false only when TikHub or its caption opt-in is disabled. Once enabled, validate connection ID, read the external key at call time, create a client from current endpoint/timeout/caps, and call the paid endpoint. Map all failures to static transcript codes.

TikHub track locators contain only video ID, language code/name, generated flag, and `format: "txt"`. They contain no credential URL. `fetchTrack()` rejects any other provider locator.

- [ ] **Step 4: Implement durable processing**

For tracks and content:

1. Read a matching current-connection job before a paid call.
2. Resume it through the free result endpoint.
3. If a paid response returns processing, atomically save the job before polling.
4. Poll every 3 seconds, at most 10 times.
5. On completion return projected data.
6. If pending, surface `tikhub-processing` and retain the job.
7. If invalid/expired, surface `tikhub-job-expired` and never silently recreate a paid job.

Implement the ordered-provider cleanup hook only after the content cache is durable:

```ts
onPersisted(
  track: YouTubeCaptionTrack,
  transcript: YouTubeTranscript,
): Promise<void>;
```

The service calls this after cache write succeeds. InnerTube and `yt-dlp` do not need the optional hook.

- [ ] **Step 5: Verify provider integration**

```bash
npx vitest run --config vitest.config.mjs \
  test_files/unit/youtube-transcript/tikhub-transcript-provider.test.ts \
  test_files/unit/youtube-transcript/tikhub-caption-job-repository.test.ts \
  test_files/unit/youtube-transcript/youtube-transcript-service.test.ts \
  test_files/unit/sources/tikhub/youtube-caption-response.test.ts \
  test_files/unit/sources/tikhub/tikhub-client.test.ts
```

Expected: pass with fake transports only.

- [ ] **Step 6: Commit**

```bash
git add src/youtube-transcript/tikhub-transcript-provider.ts \
  test_files/unit/youtube-transcript/tikhub-transcript-provider.test.ts
git commit -m "feat: add TikHub transcript provider"
```

### Task 51: Bridge Operation Evidence and Durable Cleanup Tokens

This is an independently reviewed bridge task created after Task 4 reached its five-fix ceiling. It changes the generic provider/service contract only; Task 5 will consume the contract in its own fix loop.

**Files:**
- Modify: `src/youtube-transcript/transcript-types.ts`
- Modify: `src/youtube-transcript/youtube-transcript-service.ts`
- Modify: `test_files/unit/youtube-transcript/transcript-types.test.ts`
- Modify: `test_files/unit/youtube-transcript/youtube-transcript-service.test.ts`

**Interfaces:**
- Produces: immutable per-operation TikHub billing evidence.
- Produces: a success envelope with an optional opaque, memory-only persistence token.
- Produces: sanitized ambiguous-attempt metadata on final service errors.
- Consumes: the exact `TikHubClientError.paidRequestAttempted` boundary from Task 2.

- [ ] **Step 1: Add failing contract and service tests**

Use these exact public shapes:

```ts
export interface TranscriptProviderOperationEvidence {
  readonly tikhubPaidRequests: 0 | 1;
  readonly paidRequestAttempted: boolean;
}

export interface TranscriptProviderOperationResult<T> {
  readonly kind: "transcript-provider-operation-result";
  readonly value: T;
  readonly evidence: TranscriptProviderOperationEvidence;
  readonly persistenceToken?: unknown;
}
```

Provide a validated factory that returns runtime-frozen envelopes and evidence. `tikhubPaidRequests: 1` requires `paidRequestAttempted: true`. Evidence contains no endpoint, key, request ID, raw provider body, or provider message.

Extend provider `listTracks` and `fetchTrack` return types to accept either the existing bare value or an operation envelope. Existing InnerTube and `yt-dlp` implementations remain source-compatible and continue returning bare values. TikHub operations must fail closed unless they return a valid envelope or throw a `YouTubeTranscriptError` carrying valid operation evidence.

Extend `YouTubeTranscriptError` with optional immutable operation evidence. Extend `YouTubeTranscriptServiceError` with a runtime-frozen boolean `tikhubPaidRequestPossiblySent`; do not add attempted requests to `YouTubeTranscriptUsage`, which continues to report only confirmed `0 | 1 | 2` paid calls.

Cover: frozen validation; invalid evidence; non-TikHub bare compatibility; TikHub bare/malformed envelope rejection; paid list plus paid content = 2; free resumed list plus paid content = 1; free pending/expired = 0; paid processing = confirmed 1; ambiguous transport error = confirmed 0 plus `tikhubPaidRequestPossiblySent: true`; a paid list plus ambiguous content error = confirmed 1 plus possibly sent; provider choice leases preserve list evidence exactly once; repeated normalization cannot double-add evidence.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run --config vitest.config.mjs \
  test_files/unit/youtube-transcript/transcript-types.test.ts \
  test_files/unit/youtube-transcript/youtube-transcript-service.test.ts
```

Expected: missing operation evidence/envelope and incorrect inferred usage.

- [ ] **Step 3: Replace source-based inference with operation-bound evidence**

Remove every `source === "tikhub"` usage increment. Validate and apply each settled provider operation's evidence exactly once, including sanitized thrown errors. Never infer a charge from provider source, result shape, polling, or fallback order.

Confirmed usage is the bounded sum of operation evidence, maximum two calls. `tikhubPaidRequestPossiblySent` becomes true only when a failed paid operation reached transport but has no confirmed paid response. Success envelopes with one confirmed request do not create an ambiguity warning. Progress and ready results expose confirmed usage only.

List envelopes must not contain a persistence token. A fetch envelope may contain one opaque token. The service keeps it in memory only and passes it as the optional fourth argument to `onPersisted` only after the transcript cache write is durable. Do not pass it after a rollback, pre-write abort, malformed result, or provider failure. Do not retain it in choices, progress, service results, failures, logs, cache JSON, or locators.

```ts
onPersisted?(
  track: YouTubeCaptionTrack,
  transcript: YouTubeTranscript,
  context: TranscriptProviderOperationContext,
  persistenceToken?: unknown,
): Promise<void>;
```

The existing rule remains: once the cache write is durable, cleanup failure cannot invalidate the saved transcript. Bare non-TikHub providers remain compatible and receive no token.

- [ ] **Step 4: Verify orchestration regressions**

```bash
npx vitest run --config vitest.config.mjs \
  test_files/unit/youtube-transcript/transcript-types.test.ts \
  test_files/unit/youtube-transcript/youtube-transcript-service.test.ts \
  test_files/unit/youtube-transcript/innertube-transcript-provider.test.ts \
  test_files/unit/youtube-transcript/yt-dlp-transcript-provider.test.ts \
  test_files/unit/collection/content-repository.test.ts
```

Expected: pass with fake providers only and no live TikHub request.

- [ ] **Step 5: Commit**

```bash
git add src/youtube-transcript/transcript-types.ts \
  src/youtube-transcript/youtube-transcript-service.ts \
  test_files/unit/youtube-transcript/transcript-types.test.ts \
  test_files/unit/youtube-transcript/youtube-transcript-service.test.ts
git commit -m "refactor: bridge transcript operation evidence"
```

### Task 6: Wire Current Settings, Secrets, Budget, and Jobs into the Runtime

**Files:**
- Modify: `main.ts`
- Modify: `test_files/unit/main/plugin-lifecycle.test.ts`
- Create: `test_files/unit/main/youtube-transcript-tikhub-wiring.test.ts`

**Interfaces:**
- Produces: runtime order InnerTube → TikHub → `yt-dlp`.
- Consumes: desktop secret store, request ledger/budget, client, job repository.

- [ ] **Step 1: Write failing runtime tests**

Assert provider order and that settings changes are observed on the next explicit operation:

```ts
expect(providerSources(runtime.service)).toEqual([
  "innertube",
  "tikhub",
  "yt-dlp",
]);
```

Prove no key read occurs on plugin load, dashboard render, article open, cache read, daily refresh, or runtime construction. Prove disposing polling aborts network but retains the saved job.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run --config vitest.config.mjs \
  test_files/unit/main/youtube-transcript-tikhub-wiring.test.ts \
  test_files/unit/main/plugin-lifecycle.test.ts
```

Expected: TikHub is absent from transcript runtime.

- [ ] **Step 3: Add lazy current-setting factories**

Create one job repository for the data root and a TikHub provider whose callbacks read `this.settings.tikhub` only after an explicit transcript operation reaches TikHub. Create the ledger/budget/client from the current connection ID, base URL, timeout, and caps. X and YouTube share the same daily ledger.

Key access is call-scoped:

```ts
const secretStore = new DesktopSecretStore();
const getApiKey = async (connectionId: string): Promise<string | undefined> =>
  await secretStore.get(connectionId);
```

Do not retain the resolved string after the awaited call.

- [ ] **Step 4: Verify no background/AI calls**

```bash
npx vitest run --config vitest.config.mjs \
  test_files/unit/main/youtube-transcript-tikhub-wiring.test.ts \
  test_files/unit/main/plugin-lifecycle.test.ts \
  test_files/unit/main/feed-refresh-pipeline.test.ts \
  test_files/unit/ai/content/ai-content-selector.test.ts
```

Expected: pass; only explicit transcript actions reach TikHub.

- [ ] **Step 5: Commit**

```bash
git add main.ts \
  test_files/unit/main/plugin-lifecycle.test.ts \
  test_files/unit/main/youtube-transcript-tikhub-wiring.test.ts
git commit -m "feat: wire TikHub transcript fallback"
```

### Task 7: Render Compact Progress, Usage, and Actionable Errors

**Files:**
- Modify: `src/components/youtube-transcript-panel.ts`
- Modify: `src/i18n/zh-cn.ts`
- Modify: `src/i18n/en.ts`
- Modify: `src/styles/youtube-transcript.css`
- Modify: `test_files/unit/components/youtube-transcript-panel.test.ts`

**Interfaces:**
- Consumes: request progress, result usage, sanitized failure summaries.
- Produces: inline reader status; no modal.

- [ ] **Step 1: Write failing panel tests**

```ts
onProgress({ stage: "trying-innertube" });
expect(container.textContent).toContain("正在尝试免费字幕");

onProgress({ stage: "trying-tikhub" });
expect(container.textContent).toContain("正在使用 TikHub");

onProgress({ stage: "waiting-tikhub" });
expect(container.textContent).toContain("TikHub 正在处理");
```

Also test: cache has no usage; fresh TikHub result shows one/two requests and `$0.008`/`$0.016`; provider badge; refresh cost warning; processing “继续查询”; distinct invalid-key/balance/budget/limit/job-expired/malformed copy; repeated clicks do not create a modal.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run --config vitest.config.mjs \
  test_files/unit/components/youtube-transcript-panel.test.ts
```

Expected: missing progress/usage states.

- [ ] **Step 3: Implement guarded progress and result snapshots**

Pass a progress callback from `runRequest()` and guard it with runtime identity and operation sequence. Extend snapshots so localization and collapse/expand rerender without another service call.

Metadata format:

```text
{language} · {manual/automatic} · 来源：{InnerTube/TikHub/yt-dlp} · 获取于 {time}
```

Show estimated usage only for the current fresh operation; reopening cache shows none.

- [ ] **Step 4: Implement compact failure actions**

Show the most actionable reason plus a compact source line, never raw provider text. Processing uses “继续查询”; expired jobs use “重新获取（可能产生 TikHub 费用）”; key/config failures add “打开 TikHub 设置”. Scope CSS below the existing reader panel; stack actions below 720px.

- [ ] **Step 5: Verify UI, CSS, and i18n**

```bash
npx vitest run --config vitest.config.mjs \
  test_files/unit/components/youtube-transcript-panel.test.ts \
  test_files/unit/views/reader-view-content-cache.test.ts \
  test_files/unit/views/reader-view-onclose-cleanup.test.ts
npm run audit:i18n
npm run check:css-scope
npm run check:important
```

Expected: pass with no unscoped rule or new `!important`.

- [ ] **Step 6: Commit**

```bash
git add src/components/youtube-transcript-panel.ts \
  src/i18n/zh-cn.ts src/i18n/en.ts \
  src/styles/youtube-transcript.css \
  test_files/unit/components/youtube-transcript-panel.test.ts
git commit -m "feat: show TikHub transcript progress"
```

### Task 8: Document Privacy, Billing, and Release Boundaries

**Files:**
- Modify: `README.md`
- Modify: `docs/PRIVACY.zh-CN.md`
- Modify: `docs/release/0.1.0-readiness.md`
- Modify: `docs/release/0.1.0-smoke-test.md`
- Modify: `docs/plugin-scorecard.md`
- Modify: `test_files/unit/docs/public-release-documentation.test.ts`
- Modify: `test_files/unit/scripts/tikhub-fixture-scripts.test.ts`

**Interfaces:**
- Consumes: implemented behavior/storage.
- Produces: honest public claims; no live-success claim before acceptance.

- [ ] **Step 1: Write failing doc-contract tests**

```ts
expect(readme).toContain("本地缓存 → 免费字幕 → TikHub → yt-dlp");
expect(readme).toContain("预计 $0.008");
expect(readme).toContain("默认关闭");
expect(privacy).toContain("youtube-caption-jobs.json");
expect(privacy).toContain("不会随每日刷新获取字幕");
expect(readiness).toContain("最多两次 TikHub 字幕请求");
```

Extend fixture-script safety so no capture path can commit Authorization values or raw provider payloads.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run --config vitest.config.mjs \
  test_files/unit/docs/public-release-documentation.test.ts \
  test_files/unit/scripts/tikhub-fixture-scripts.test.ts
```

Expected: current docs still describe TikHub as X-only.

- [ ] **Step 3: Update docs**

Document optional X plus on-demand YouTube use, endpoint-specific estimate, shared caps, default-off consent, free polling, charged empty-caption possibility, pending-job path, cache behavior, and provider-controlled final billing. Keep the real paid path “not run” until Task 10.

- [ ] **Step 4: Verify public safety**

```bash
npx vitest run --config vitest.config.mjs \
  test_files/unit/docs/public-release-documentation.test.ts \
  test_files/unit/scripts/tikhub-fixture-scripts.test.ts
npm run check:public
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/PRIVACY.zh-CN.md \
  docs/release/0.1.0-readiness.md docs/release/0.1.0-smoke-test.md \
  docs/plugin-scorecard.md \
  test_files/unit/docs/public-release-documentation.test.ts \
  test_files/unit/scripts/tikhub-fixture-scripts.test.ts
git commit -m "docs: explain TikHub transcript billing"
```

### Task 9: Run Full Verification and Stage the Release Candidate

**Files:**
- Verify: whole repository
- Generated by approved build: `main.js`, `styles.css`, `release/main.js`, `release/manifest.json`, `release/styles.css`

**Interfaces:**
- Consumes: Tasks 1–8.
- Produces: test-clean public-safe release candidate; no live call.

- [ ] **Step 1: Run full checks**

```bash
npm run check
```

Expected: unit, i18n, public/workflow/version, CSS, lint, TypeScript, and production build pass.

- [ ] **Step 2: Stage and verify release**

```bash
npm run release:stage
npm run release:check
```

Expected: release contains only the three allowed files and no credential/private path/source map.

- [ ] **Step 3: Review diff and scan secrets**

```bash
git status --short
git diff --check
git diff --stat HEAD~8..HEAD
git grep -n -I -E 'Bearer [A-Za-z0-9._-]{12,}|api[_-]?key[=:][^* ]' -- \
  ':!package-lock.json' ':!docs/superpowers'
```

Expected: only intended paths; no credential values. Review each path before staging.

- [ ] **Step 4: Commit tracked build artifacts**

```bash
git add main.js styles.css release/main.js release/manifest.json release/styles.css
git commit -m "build: stage TikHub transcript fallback"
```

If status proves a listed artifact is ignored or identical, omit that exact path rather than force it.

### Task 91: Hydrate TikHub Secret Status Before Live Acceptance

**Why this bridge task exists:** Task 10 found that saving the current TikHub key changed the external secret file, but reopening the TikHub settings tab still displayed “未配置”. The renderer initializes `hasSecret` to false and calls `updateStatus()`, yet never invokes its existing `refreshSecretStatus()` on initial render. This makes the UI claim “missing” before checking secure storage and also collapses a storage-read error into the same copy.

**Files:**
- Modify: `src/settings/tabs/tikhub-settings-tab.ts`
- Modify: `src/i18n/zh-cn.ts`
- Modify: `src/i18n/en.ts`
- Modify: `test_files/unit/settings/tikhub-settings-tab.test.ts`

**Interfaces:**
- Consumes: the existing `SecretStore.getStatus(connectionId)` safe projection.
- Produces: truthful initial checking/configured/missing/unavailable status; no key value enters settings, logs, tests, or Git.

- [ ] **Step 1: Write failing settings tests**

Prove initial render calls `getStatus()` exactly once for a canonical current connection, displays a neutral checking state while pending, then displays configured or missing from the resolved projection. Prove a rejected status read displays a distinct safe “无法读取密钥状态” recovery message rather than falsely claiming no key. Prove invalid/blank connection IDs remain missing without a secret read, and stale async completion from a disposed/re-rendered tab cannot overwrite the current status.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run --config vitest.config.mjs \
  test_files/unit/settings/tikhub-settings-tab.test.ts
```

Expected: initial render never calls `getStatus()` and cannot represent checking/unavailable.

- [ ] **Step 3: Implement the minimal status state machine**

Use only `checking`, `configured`, `missing`, and `unavailable`. Invoke the existing async refresh during initial render after the status element exists. Keep the current epoch/render guards. Saving a key sets configured; deleting sets missing; read/security/corruption failure sets unavailable. Never render exception text, paths, connection IDs, or secret values.

- [ ] **Step 4: Verify and commit**

```bash
npx vitest run --config vitest.config.mjs \
  test_files/unit/settings/tikhub-settings-tab.test.ts
npm run audit:i18n
npm run check:public
npm run lint
npx tsc --noEmit --skipLibCheck
```

```bash
git add src/settings/tabs/tikhub-settings-tab.ts \
  src/i18n/zh-cn.ts src/i18n/en.ts \
  test_files/unit/settings/tikhub-settings-tab.test.ts
git commit -m "fix: refresh TikHub key status"
```

After review, rebuild/re-stage/reinstall the three program files with Obsidian fully exited, then resume Task 10 without resetting its zero paid-attempt ledger.

### Task 10: Install Safely and Run One Explicitly Authorized Live Acceptance

**Files:**
- Source: `release/main.js`, `release/manifest.json`, `release/styles.css`
- Target: the exact active vault plugin directory supplied at acceptance time
- Protect: target `data.json`
- Protect: the active vault's `.rss-dashboard-data/`
- Protect: the desktop external secret file resolved by the plugin's secret-store implementation

**Interfaces:**
- Consumes: verified release and fresh paid authorization.
- Produces: real-vault evidence for one named video.

- [ ] **Step 1: Record non-secret pre-install evidence**

With Obsidian fully exited, record existence, sizes, counts, and SHA-256 hashes for settings, external secret file, state/content/subscription/analysis files. Never print contents or credential URLs. The installer has no dry-run flag, so perform its read-only release validation first:

```bash
npm run release:check
```

Expected: the release directory contains exactly the three allowed, verified program files. Separately resolve and inspect the exact target directory before any installer call; do not infer it from a glob or environment variable.

- [ ] **Step 2: Install after Obsidian-close confirmation**

```bash
node scripts/install-local-release.mjs \
  --target /absolute/path/to/active-vault/.obsidian/plugins/rss-dashboard-cn
```

Expected: recoverable backup; `data.json` remains byte-identical.

- [ ] **Step 3: Enable only the self-use opt-in**

After backing up `data.json`, change only:

```json
{
  "tikhub": {
    "youtubeTranscriptFallbackEnabled": true
  }
}
```

Preserve all sibling data and connection ID. Do not read/rewrite the external secret. Reopen and confirm settings, sources, and history remain.

- [ ] **Step 4: Stop for a fresh paid authorization**

Present exact video title/ID and maximum exposure: two requests, estimated `$0.016`; polling documented free. Do not reuse earlier X authorization. Continue only after explicit approval.

- [ ] **Step 5: Run the one-video acceptance**

1. Click “获取字幕” once.
2. Observe free failure then TikHub progress.
3. Complete language choice and transcript.
4. Confirm estimated request count.
5. Confirm non-empty local `youtube-transcript` with `provider: "tikhub"`.
6. Collapse/switch/restart Obsidian.
7. Confirm cache recovery and no ledger increase.
8. Confirm AI content selection reads cache without caption request.
9. Do not click “重新获取” during this acceptance.

- [ ] **Step 6: Verify preservation and record honest evidence**

Compare pre/post non-secret hashes/counts. Settings may differ only for the authorized opt-in and normal plugin timestamps; external secret hash, subscriptions, history, prior content, analysis, and user Markdown remain unchanged except one transcript and normal ledger/job state. Update smoke test and scorecard without key/header/raw response/full transcript/private paths.

- [ ] **Step 7: Commit acceptance docs**

```bash
git add docs/release/0.1.0-smoke-test.md docs/plugin-scorecard.md
git commit -m "docs: verify TikHub transcript fallback"
```

## Final Verification Gate

```bash
npm run check
npm run release:check
git status --short
git log --oneline -12
```

Completion requires automated checks, public-safety checks, release verification, real-vault preservation checks, and the authorized one-video acceptance. A successful build, commit, or TikHub response alone is not completion.
