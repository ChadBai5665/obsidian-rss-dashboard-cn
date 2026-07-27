# Source Subscription Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build one user-facing subscription flow that identifies and verifies RSS/websites, YouTube channels, and X accounts before saving, supports a configurable first-import range, and preserves configuration and collected history across later updates.

**Architecture:** Introduce small source-verification services behind a single `AddSourceModal`, then pass a typed verified subscription request into plugin-owned persistence commands. Keep RSS/YouTube on the existing feed parser, keep X on the existing TikHub adapter and request ledger, and persist only non-secret verification/import state with each `Feed`. Add cursor-aware X first import without changing daily topic discovery.

**Tech Stack:** TypeScript 5.9, Obsidian 1.8 API, Vitest 4, existing DOM test polyfills, existing TikHub client/budget/secret store, CSS modules assembled through `src/styles/index.css`.

## Global Constraints

- Desktop-only behavior remains unchanged; do not add mobile support claims.
- Add no runtime dependency and inject no remote script.
- The default first-import range is exactly the most recent 7 days.
- RSS/YouTube “all available” means every item returned by the current official feed response, not complete platform history.
- X “all available” must require a second confirmation, show paid-request risk, obey per-run/per-day limits, persist its cursor checkpoint, and allow stop/resume.
- Never store or log TikHub/AI keys, authorization headers, raw provider responses, personal filesystem paths, private handles, or topic queries.
- Input edits invalidate prior verification immediately; unverified, failed, stale, or empty results can never be saved.
- Detect explicit platform hosts before generic path patterns; `youtube.com/@handle` must never enter Mastodon discovery.
- Settings retain API endpoints, keys, budgets, default folders/tags, and global retention. The Dashboard owns normal source add/manage interactions.
- Deleting a subscription preserves collection JSONL, daily indexes, saved Markdown, cached full text, and manual AI output unless the user separately confirms local collection purge.
- Keep URI feed-add, OPML import/export, Podcast, Mastodon, Nitter, daily-on-open refresh, manual refresh, and failed-source retry behavior working.
- Public source, fixtures, plans, tests, docs, and logs must not contain the user's real vault path or live credentials.
- Every task follows red-green-refactor, runs its focused tests, and commits independently.

---

## File Map

### New production files

- `src/sources/initial-import-policy.ts` — validated first-import policy, cutoff calculation, progress normalization, and item filtering.
- `src/services/source-verification/source-identifier.ts` — normalize RSS/website URLs, YouTube identifiers, and X handles/profile URLs.
- `src/services/source-verification/rss-website-discovery.ts` — validate direct feeds and discover declared feed links from HTML.
- `src/services/source-verification/youtube-channel-resolver.ts` — resolve a supported YouTube identifier to a canonical channel/feed preview.
- `src/services/source-verification/verification-state.ts` — stale-safe verification state transitions shared by the modal.
- `src/sources/tikhub/x-profile.ts` — defensively parse the TikHub profile response into a minimal safe profile.
- `src/sources/tikhub/x-profile-resolver.ts` — read the external key and perform one budgeted TikHub profile lookup.
- `src/services/subscription-service.ts` — canonical duplicate keys, add/update/pause/remove operations, and default-history-preserving deletion.
- `src/modals/source-onboarding/add-source-modal.ts` — three-card, same-window add flow.
- `src/modals/source-onboarding/initial-import-control.ts` — reusable first-import selector and X all-history warning.
- `src/modals/source-onboarding/verification-card.ts` — read-only success/warning card renderer.
- `src/styles/source-onboarding-modal.css` — scoped responsive layout for the three-card flow and confirmation card.
- `scripts/install-local-release.mjs` — target-parameterized installer that copies only release artifacts and proves protected data is unchanged.

### Existing production files to modify

- `src/types/types.ts` — optional first-import policy/progress and subscription lifecycle fields on `Feed`.
- `src/utils/settings-loader.ts` — normalize new optional fields without turning legacy feeds into pending imports.
- `src/security/public-settings-export.ts` — export safe policy/lifecycle fields but never cursors or provider progress.
- `src/services/feed-parser/feed-preview.ts` and `src/services/feed-parser/types.ts` — expose latest entry title and parsed feed type in previews.
- `src/modals/feed-manager/feed-preview-loader.ts` — platform-first resolution and richer verified preview output.
- `src/services/media-service.ts` — keep YouTube identifier resolution focused and stop generic Mastodon collision.
- `src/sources/tikhub/tikhub-client.ts` — add official X profile call while retaining the current budget/transport boundary.
- `src/sources/tikhub/tikhub-parser.ts` — extract a safe bottom cursor along with posts.
- `src/sources/tikhub/x-account-adapter.ts` — bounded multi-page first import, checkpointing, and history merge.
- `src/sources/tikhub/x-feed-mapper.ts` — preserve prior items and first-import state when mapping account pages.
- `src/sources/source-adapter.ts` and `src/sources/source-registry.ts` — pass/snapshot feed-owned import state safely for all adapters.
- `main.ts` — expose typed subscription commands and wire verification dependencies.
- `src/components/sidebar.ts` — open the new hub from the existing “添加订阅源” action.
- `src/modals/feed-manager/feed-manager-modal.ts` — become the unified RSS/YouTube/X account manager.
- `src/modals/feed-manager-modal.ts` — export the new public modal while retaining edit modal compatibility.
- `src/settings/tabs/sources-settings-tab.ts` — replace deep add form with a Dashboard entry link and keep infrastructure-only summaries.
- `src/i18n/zh-cn.ts`, `src/i18n/en.ts`, `src/i18n/types.ts` — all new user-facing copy and error states.
- `src/styles/index.css` and generated root `styles.css` — include the scoped onboarding/manager styles.
- `package.json`, `README.md`, `docs/INSTALL.zh-CN.md` — safe local-install command and non-destructive update contract.

### New focused test files

- `test_files/unit/sources/initial-import-policy.test.ts`
- `test_files/unit/services/source-verification/source-identifier.test.ts`
- `test_files/unit/services/source-verification/rss-website-discovery.test.ts`
- `test_files/unit/services/source-verification/youtube-channel-resolver.test.ts`
- `test_files/unit/services/source-verification/verification-state.test.ts`
- `test_files/unit/modals/feed-preview-loader.test.ts`
- `test_files/unit/sources/tikhub/x-profile.test.ts`
- `test_files/unit/sources/tikhub/x-profile-resolver.test.ts`
- `test_files/unit/services/subscription-service.test.ts`
- `test_files/unit/modals/add-source-modal.test.ts`
- `test_files/unit/modals/initial-import-control.test.ts`
- `test_files/unit/scripts/install-local-release.test.ts`

---

### Task 1: Persist a safe first-import policy and progress model

**Files:**
- Create: `src/sources/initial-import-policy.ts`
- Modify: `src/types/types.ts:70-115`
- Modify: `src/utils/settings-loader.ts:254-309`
- Modify: `src/security/public-settings-export.ts:260-340`
- Test: `test_files/unit/sources/initial-import-policy.test.ts`
- Test: `test_files/unit/utils/settings-loader.test.ts`
- Test: `test_files/unit/security/public-settings-export.test.ts`

**Interfaces:**
- Produces: `InitialImportPolicy`, `InitialImportProgress`, `DEFAULT_INITIAL_IMPORT_POLICY`, `normalizeInitialImportPolicy(value)`, `normalizeInitialImportProgress(value)`, `filterItemsForInitialImport(items, policy, now)`.
- Produces on `Feed`: `initialImportPolicy?`, `initialImportProgress?`, `subscriptionStatus?: "active" | "paused"`.

- [ ] **Step 1: Write failing normalization and cutoff tests**

```ts
expect(normalizeInitialImportPolicy(undefined)).toEqual({
  mode: "lookback-days",
  days: 7,
});
expect(normalizeInitialImportPolicy({ mode: "since-date", since: "2026-07-01" }))
  .toEqual({ mode: "since-date", since: "2026-07-01" });
expect(normalizeInitialImportPolicy({ mode: "lookback-days", days: -1 }))
  .toBeUndefined();
expect(filterItemsForInitialImport(items, { mode: "lookback-days", days: 7 }, now))
  .toEqual([items[0]]);
```

Also assert that an existing feed with no import fields remains a completed legacy subscription rather than becoming pending, invalid progress is discarded, and safe public export contains the policy but omits `nextCursor` and `replyCursor`.

- [ ] **Step 2: Run the focused tests and verify red**

Run: `npm run test:unit -- test_files/unit/sources/initial-import-policy.test.ts test_files/unit/utils/settings-loader.test.ts test_files/unit/security/public-settings-export.test.ts`

Expected: FAIL because the types and normalization functions do not exist.

- [ ] **Step 3: Implement the closed unions and validators**

```ts
export type InitialImportPolicy =
  | { mode: "from-now" }
  | { mode: "lookback-days"; days: number }
  | { mode: "since-date"; since: string }
  | { mode: "all-available" };

export interface InitialImportProgress {
  status: "pending" | "running" | "paused-limit" | "stopped" | "completed" | "failed";
  pagesFetched: number;
  itemsImported: number;
  earliestImportedAt?: string;
  nextCursor?: string;
  replyCursor?: string;
}

export const DEFAULT_INITIAL_IMPORT_POLICY: InitialImportPolicy =
  Object.freeze({ mode: "lookback-days", days: 7 });
```

Allow integer lookback days from 1 through 3650 and strict `YYYY-MM-DD` calendar dates. Clone all accepted data, reject inherited/accessor properties, limit cursors to 4096 printable characters, and filter against a single caller-supplied `now`.

- [ ] **Step 4: Normalize settings and public export**

In `migrateSettings`, normalize only fields that already exist. Do not add pending state to legacy feeds. In public export, copy `initialImportPolicy` and `subscriptionStatus`; omit `initialImportProgress` because it can contain provider cursors.

- [ ] **Step 5: Re-run focused tests**

Run: `npm run test:unit -- test_files/unit/sources/initial-import-policy.test.ts test_files/unit/utils/settings-loader.test.ts test_files/unit/security/public-settings-export.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/sources/initial-import-policy.ts src/types/types.ts src/utils/settings-loader.ts src/security/public-settings-export.ts test_files/unit/sources/initial-import-policy.test.ts test_files/unit/utils/settings-loader.test.ts test_files/unit/security/public-settings-export.test.ts
git commit -m "feat: add first import policy model"
```

### Task 2: Normalize the three user-facing source identifiers

**Files:**
- Create: `src/services/source-verification/source-identifier.ts`
- Test: `test_files/unit/services/source-verification/source-identifier.test.ts`

**Interfaces:**
- Produces: `normalizeRssWebsiteInput(input): URL`, `normalizeYouTubeInput(input): YouTubeIdentifier`, `normalizeXAccountInput(input): string`.
- `YouTubeIdentifier` is `{ kind: "handle"; value: string } | { kind: "channel-id"; value: string } | { kind: "channel-url"; value: string }`.

- [ ] **Step 1: Write the input matrix tests**

```ts
expect(normalizeXAccountInput("OpenAI")).toBe("openai");
expect(normalizeXAccountInput("@OpenAI")).toBe("openai");
expect(normalizeXAccountInput("https://x.com/OpenAI")).toBe("openai");
expect(normalizeYouTubeInput("https://www.youtube.com/@OpenAI"))
  .toEqual({ kind: "handle", value: "OpenAI" });
expect(() => normalizeYouTubeInput("https://www.youtube.com/watch?v=abc"))
  .toThrowError("youtube-not-channel");
expect(normalizeRssWebsiteInput("https://example.com/news").href)
  .toBe("https://example.com/news");
```

Add rejection cases for credentials in URLs, X status/search/home routes, invalid handles, whitespace/control characters, YouTube playlist/results URLs, non-HTTP(S) feed schemes, and overlong input.

- [ ] **Step 2: Run the test and verify red**

Run: `npm run test:unit -- test_files/unit/services/source-verification/source-identifier.test.ts`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement host-first normalization**

Use `URL` parsing for URLs, explicit host allowlists for X/YouTube, NFC normalization for identifiers, a 2048-character input ceiling, and the existing ASCII X handle rule. Return stable typed errors whose codes are safe for localization.

- [ ] **Step 4: Run the focused test**

Run: `npm run test:unit -- test_files/unit/services/source-verification/source-identifier.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/source-verification/source-identifier.ts test_files/unit/services/source-verification/source-identifier.test.ts
git commit -m "feat: normalize subscription identifiers"
```

### Task 3: Add direct-feed validation and website feed discovery

**Files:**
- Create: `src/services/source-verification/rss-website-discovery.ts`
- Modify: `src/services/feed-parser/feed-preview.ts:15-101`
- Modify: `src/services/feed-parser/types.ts:50-65`
- Test: `test_files/unit/services/source-verification/rss-website-discovery.test.ts`
- Test: `test_files/unit/services/feed-parser/feed-preview.test.ts`

**Interfaces:**
- Produces: `FeedCandidate { url; title; format: "rss" | "atom" | "json" }`.
- Produces: `RssWebsiteVerification { inputUrl; siteUrl; candidates; selected; latestTitle?; latestPubDate?; hasEntries }`.
- Produces: `discoverRssWebsite(input, { request }): Promise<RssWebsiteVerification>`.

- [ ] **Step 1: Write transport-injected discovery tests**

```ts
const result = await discoverRssWebsite("https://example.com", {
  request: async () => ({
    url: "https://example.com",
    text: `<html><head>
      <link rel="alternate" type="application/rss+xml" title="All" href="/feed.xml">
      <link rel="alternate" type="application/atom+xml" title="Research" href="/research.atom">
    </head></html>`,
  }),
});
expect(result.candidates.map((item) => item.url)).toEqual([
  "https://example.com/feed.xml",
  "https://example.com/research.atom",
]);
```

Cover direct RSS, Atom and JSON Feed; relative discovery links; duplicate declarations; unsafe schemes/credentials; zero candidates; multiple candidates requiring selection; empty feed warning; latest title/date extraction; and a request timeout surfaced as `network-timeout`.

- [ ] **Step 2: Run tests and verify red**

Run: `npm run test:unit -- test_files/unit/services/source-verification/rss-website-discovery.test.ts test_files/unit/services/feed-parser/feed-preview.test.ts`

Expected: FAIL because discovery and latest-title preview fields do not exist.

- [ ] **Step 3: Implement bounded discovery**

Request the entered URL once. If the body parses directly, return one candidate. Otherwise parse only HTML `<link rel="alternate">` elements with supported MIME types, resolve them against the final response URL, dedupe canonical URLs, and validate candidate feeds before success. Try only `/feed`, `/feed.xml`, `/rss`, `/rss.xml`, `/atom.xml`, and `/index.xml` when the page declares none; stop after the first valid common-path candidate.

- [ ] **Step 4: Extend feed preview output**

Add `latestTitle?: string` and `format: "rss" | "atom" | "json"` to preview data. Populate them from the first RSS item/Atom entry/JSON Feed item without fetching article bodies.

- [ ] **Step 5: Run focused tests**

Run: `npm run test:unit -- test_files/unit/services/source-verification/rss-website-discovery.test.ts test_files/unit/services/feed-parser/feed-preview.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/source-verification/rss-website-discovery.ts src/services/feed-parser/feed-preview.ts src/services/feed-parser/types.ts test_files/unit/services/source-verification/rss-website-discovery.test.ts test_files/unit/services/feed-parser/feed-preview.test.ts
git commit -m "feat: discover website feed candidates"
```

### Task 4: Resolve YouTube channels before generic social-profile detection

**Files:**
- Create: `src/services/source-verification/youtube-channel-resolver.ts`
- Modify: `src/services/media-service.ts:88-118,250-425`
- Modify: `src/services/mastodon-service.ts:13-33`
- Modify: `src/modals/feed-manager/feed-preview-loader.ts:145-221`
- Test: `test_files/unit/services/source-verification/youtube-channel-resolver.test.ts`
- Test: `test_files/unit/services/mastodon-service.test.ts`
- Create test: `test_files/unit/modals/feed-preview-loader.test.ts`

**Interfaces:**
- Produces: `YouTubeChannelVerification { channelId; channelName; channelUrl; feedUrl; latestTitle?; latestPubDate?; hasEntries }`.
- Produces: `resolveYouTubeChannel(identifier, { request }): Promise<YouTubeChannelVerification>`.

- [ ] **Step 1: Write the regression first**

```ts
expect(MastodonService.isMastodonProfileUrl("https://www.youtube.com/@OpenAI"))
  .toBe(false);
const result = await resolveAndLoadPreview("https://www.youtube.com/@OpenAI", deps);
expect(result.detectedType).toBe("youtube");
expect(result.isMastodonConversion).toBe(false);
expect(getDefaultFolderForResolvedFeed(result, defaults)).toBe("Videos");
```

Add channel ID, `@handle`, legacy custom URL, missing channel ID, video URL, playlist URL, and successful latest-video metadata cases.

- [ ] **Step 2: Run tests and verify red**

Run: `npm run test:unit -- test_files/unit/services/source-verification/youtube-channel-resolver.test.ts test_files/unit/services/mastodon-service.test.ts test_files/unit/modals/feed-preview-loader.test.ts`

Expected: the YouTube/Mastodon collision assertion FAILS.

- [ ] **Step 3: Implement explicit host exclusion and focused resolver**

Make Mastodon profile recognition reject known non-Mastodon hosts including YouTube, X/Twitter, Nitter, and GitHub. Resolve YouTube HTML to one `UC...` ID, build the official feed URL, load the feed preview, and return a canonical `https://www.youtube.com/channel/<id>` URL.

- [ ] **Step 4: Reorder the existing preview pipeline**

Handle X and YouTube explicit hosts before Mastodon path discovery. A resolved YouTube preview must never retain `isMastodonConversion` and must select the YouTube default folder.

- [ ] **Step 5: Run focused and adjacent media tests**

Run: `npm run test:unit -- test_files/unit/services/source-verification/youtube-channel-resolver.test.ts test_files/unit/services/mastodon-service.test.ts test_files/unit/modals/feed-preview-loader.test.ts test_files/unit/services/media-service.detect-and-process-feed.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/source-verification/youtube-channel-resolver.ts src/services/media-service.ts src/services/mastodon-service.ts src/modals/feed-manager/feed-preview-loader.ts test_files/unit/services/source-verification/youtube-channel-resolver.test.ts test_files/unit/services/mastodon-service.test.ts test_files/unit/modals/feed-preview-loader.test.ts
git commit -m "fix: verify YouTube channels before Mastodon"
```

### Task 5: Verify X account identity through TikHub

**Files:**
- Create: `src/sources/tikhub/x-profile.ts`
- Create: `src/sources/tikhub/x-profile-resolver.ts`
- Modify: `src/sources/tikhub/tikhub-client.ts:45-145`
- Test: `test_files/unit/sources/tikhub/x-profile.test.ts`
- Test: `test_files/unit/sources/tikhub/x-profile-resolver.test.ts`
- Modify test: `test_files/unit/sources/tikhub/tikhub-client.test.ts:72-190`

**Interfaces:**
- Produces: `XProfile { restId; handle; displayName; avatarUrl?; description?; verified }`.
- Produces on client: `fetchUserProfile<T>(input: TikHubUserRequest): Promise<TikHubResult<T>>`.
- Produces: `XProfileResolver.resolve(handle, signal?): Promise<XProfile>`.

- [ ] **Step 1: Write the exact endpoint and defensive parser tests**

```ts
await client.fetchUserProfile({ apiKey: API_KEY, handle: "openai" });
expect(requests[0]?.url).toBe(
  "https://api.tikhub.dev/api/v1/twitter/web/fetch_user_profile?screen_name=openai",
);
expect(parseXProfile(fixture)).toEqual({
  restId: "123",
  handle: "openai",
  displayName: "OpenAI",
  avatarUrl: "https://pbs.twimg.com/profile_images/example.jpg",
  description: "Research and deployment company",
  verified: true,
});
```

The shown request uses a client configured with the Mainland preset. Add a second assertion proving the international preset builds the same path on `https://api.tikhub.io`. Cover missing key, invalid key, disabled TikHub, insufficient balance, malformed provider shape, mismatched returned handle, hostile URL/accessor input, abort, and one successful request counted in the existing ledger.

- [ ] **Step 2: Run focused tests and verify red**

Run: `npm run test:unit -- test_files/unit/sources/tikhub/tikhub-client.test.ts test_files/unit/sources/tikhub/x-profile.test.ts test_files/unit/sources/tikhub/x-profile-resolver.test.ts`

Expected: FAIL because the profile method and resolver are absent.

- [ ] **Step 3: Add the client method and safe projection**

Use only `/api/v1/twitter/web/fetch_user_profile` with `screen_name`, joined onto the user-selected existing TikHub base URL. Keep the official Mainland preset at `https://api.tikhub.dev` and the official international preset at `https://api.tikhub.io`; do not hard-code either host inside the resolver. Reuse the existing Bearer authorization, timeout, budget, request ID, and error mapping. The parser walks only documented own data properties and returns the six-field projection; it never returns or retains raw response data.

- [ ] **Step 4: Implement resolver key lifetime**

Read the key by UUID connection ID immediately before the call, clear the local reference in `finally`, and translate client failures to stable codes: `tikhub-disabled`, `missing-key`, `invalid-key`, `insufficient-balance`, `rate-limited`, `not-found`, `network-timeout`, `provider-failure`.

- [ ] **Step 5: Run focused tests**

Run: `npm run test:unit -- test_files/unit/sources/tikhub/tikhub-client.test.ts test_files/unit/sources/tikhub/x-profile.test.ts test_files/unit/sources/tikhub/x-profile-resolver.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/sources/tikhub/x-profile.ts src/sources/tikhub/x-profile-resolver.ts src/sources/tikhub/tikhub-client.ts test_files/unit/sources/tikhub/tikhub-client.test.ts test_files/unit/sources/tikhub/x-profile.test.ts test_files/unit/sources/tikhub/x-profile-resolver.test.ts
git commit -m "feat: verify X account profiles"
```

### Task 6: Make verification state stale-safe

**Files:**
- Create: `src/services/source-verification/verification-state.ts`
- Test: `test_files/unit/services/source-verification/verification-state.test.ts`

**Interfaces:**
- Produces: `VerificationState<T> = idle | checking | success | warning | failure` as a discriminated union.
- Produces: `VerificationController<T>` with `begin(input)`, `succeed(token, value)`, `warn(token, value, code)`, `fail(token, code)`, and `invalidate()`.

- [ ] **Step 1: Write stale-result tests**

```ts
const first = state.begin("https://a.example/feed");
state.invalidate();
expect(state.succeed(first, verifiedA)).toBe(false);
expect(state.snapshot()).toEqual({ status: "idle" });
const second = state.begin("https://b.example/feed");
expect(state.fail(second, "feed-not-found")).toBe(true);
expect(state.canSubscribe()).toBe(false);
```

Also assert only `success` and explicitly accepted empty-feed `warning` states can subscribe, double clicks share no token, and cancel/close invalidates in-flight completion.

- [ ] **Step 2: Run test and verify red**

Run: `npm run test:unit -- test_files/unit/services/source-verification/verification-state.test.ts`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement the monotonic token controller**

Use a numeric generation token and immutable snapshots. Never store DOM nodes, API keys, raw provider bodies, or thrown `Error` objects in the state.

- [ ] **Step 4: Run the focused test**

Run: `npm run test:unit -- test_files/unit/services/source-verification/verification-state.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/source-verification/verification-state.ts test_files/unit/services/source-verification/verification-state.test.ts
git commit -m "feat: add stale safe source verification state"
```

### Task 7: Add cursor-aware, resumable X first import

**Files:**
- Modify: `src/sources/tikhub/tikhub-parser.ts:1-220`
- Modify: `src/sources/tikhub/x-account-adapter.ts:55-175`
- Modify: `src/sources/tikhub/x-feed-mapper.ts:45-105`
- Modify: `src/sources/source-adapter.ts:1-30`
- Modify: `src/sources/source-registry.ts:240-350`
- Modify: `main.ts:4920-4975`
- Test: `test_files/unit/sources/tikhub/tikhub-parser.test.ts`
- Test: `test_files/unit/sources/tikhub/x-account-adapter.test.ts`
- Test: `test_files/unit/sources/source-registry.test.ts`
- Modify test: `test_files/unit/main/feed-refresh-pipeline.test.ts`

**Interfaces:**
- Extends `TikHubTimelineParseResult` with `nextCursor?: string`.
- `SourceRefreshContext.feed` becomes available to every adapter as a cloned snapshot.
- `SourceRefreshOutput.collectionItems?: FeedItem[]` carries the complete current import batch to the collection layer before cache retention.
- X adapter returns updated `Feed.initialImportProgress`, merged historical cache items, and complete current-run collection items.

- [ ] **Step 1: Write cursor extraction and stop-condition tests**

```ts
expect(parseTikHubTimeline(cursorFixture).nextCursor).toBe("fixture-cursor");
expect(parseTikHubTimeline(hostileCursorFixture).nextCursor).toBeUndefined();
expect(client.fetchUserPosts).toHaveBeenNthCalledWith(2, expect.objectContaining({
  cursor: "page-2",
}));
expect(result.feed.initialImportProgress).toMatchObject({
  status: "completed",
  pagesFetched: 2,
});
expect(result.collectionItems?.map((item) => item.guid)).toEqual(["3", "2", "1"]);
```

Cover reaching the date cutoff, no next cursor, repeated cursor loop, duplicate post IDs across pages, user-stopped state, daily/per-run budget exhaustion producing `paused-limit`, reply pagination counted independently, persisted resume cursor, and normal daily refresh remaining one posts request plus optional one replies request.

- [ ] **Step 2: Run tests and verify red**

Run: `npm run test:unit -- test_files/unit/sources/tikhub/tikhub-parser.test.ts test_files/unit/sources/tikhub/x-account-adapter.test.ts test_files/unit/sources/source-registry.test.ts test_files/unit/main/feed-refresh-pipeline.test.ts`

Expected: FAIL because cursors and first-import progress are not returned.

- [ ] **Step 3: Extract only the bottom cursor**

Accept an own string `content.value` only when `cursorType === "Bottom"` or the entry ID begins `cursor-bottom`. Enforce printable content, maximum length 4096, and one cursor per page; ambiguous or repeated cursors terminate safely with a warning.

- [ ] **Step 4: Implement bounded paging**

For pending/running X first import, request pages sequentially until the policy cutoff is crossed, no cursor remains, the user-stop status is observed, or budget reservation fails. Return a successful partial result with `paused-limit` when a later page cannot be reserved, so already fetched pages are collected and checkpointed instead of discarded. Update the in-memory cursor and counters after each successfully mapped page; persist the returned partial/completed feed through the normal refresh commit before the run ends. Use the existing per-request reservation so every attempted page is counted.

- [ ] **Step 5: Preserve history**

Merge `context.feed.items` with newly mapped items by stable tweet ID before returning. Put only items fetched in the current run into `collectionItems`; `main.ts` passes that list to `CollectionService` while retaining the merged feed cache separately. Apply reply/repost switches after account ownership validation. Keep topic adapter behavior unchanged.

- [ ] **Step 6: Run X regression tests**

Run: `npm run test:unit -- test_files/unit/sources/tikhub/tikhub-parser.test.ts test_files/unit/sources/tikhub/x-account-adapter.test.ts test_files/unit/sources/tikhub/x-topic-adapter.test.ts test_files/unit/sources/tikhub/request-budget.test.ts test_files/unit/sources/tikhub/request-ledger.test.ts test_files/unit/sources/source-registry.test.ts test_files/unit/main/feed-refresh-pipeline.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/sources/tikhub/tikhub-parser.ts src/sources/tikhub/x-account-adapter.ts src/sources/tikhub/x-feed-mapper.ts src/sources/source-adapter.ts src/sources/source-registry.ts main.ts test_files/unit/sources/tikhub/tikhub-parser.test.ts test_files/unit/sources/tikhub/x-account-adapter.test.ts test_files/unit/sources/source-registry.test.ts test_files/unit/main/feed-refresh-pipeline.test.ts
git commit -m "feat: resume bounded X history imports"
```

### Task 8: Centralize subscription add, duplicate, pause, and delete behavior

**Files:**
- Create: `src/services/subscription-service.ts`
- Modify: `main.ts:3755-3890,4520-4610`
- Modify: `src/settings/tabs/sources-settings-tab.ts:1-175`
- Modify: `src/services/collection-service.ts:1-110`
- Modify: `src/collection/collection-repository.ts:1-220`
- Test: `test_files/unit/services/subscription-service.test.ts`
- Modify test: `test_files/unit/main/feed-refresh-pipeline.test.ts`
- Modify test: `test_files/unit/services/collection-service.test.ts`
- Modify test: `test_files/unit/collection/collection-repository.test.ts`

**Interfaces:**
- Produces: `VerifiedFeedSubscriptionRequest`, `VerifiedXSubscriptionRequest`, `VerifiedSubscriptionRequest`.
- Produces: `SubscriptionService.add(request)`, `.update(feedId, request)`, `.setPaused(feedId, paused)`, `.stopInitialImport(feedId)`, `.resumeInitialImport(feedId)`, `.remove(feedId, { purgeCollection })`.
- Produces: `CollectionRepository.removeBySourceId(sourceId)` returning the affected local dates and remaining items needed to regenerate indexes.
- Plugin exposes: `addVerifiedSubscription(request): Promise<boolean>` and `removeSubscription(feedId, options): Promise<boolean>`.

```ts
interface SubscriptionPreferences {
  displayName?: string;
  folder?: string;
  tags: string[];
  initialImportPolicy: InitialImportPolicy;
}

type VerifiedFeedSubscriptionRequest =
  | ({ kind: "rss-website"; verification: RssWebsiteVerification;
      selectedCandidateUrl: string } & SubscriptionPreferences)
  | ({ kind: "youtube"; verification: YouTubeChannelVerification }
      & SubscriptionPreferences);

type VerifiedXSubscriptionRequest = {
  kind: "x-account";
  profile: XProfile;
  includeReplies: boolean;
  includeReposts: boolean;
} & SubscriptionPreferences;

type VerifiedSubscriptionRequest =
  | VerifiedFeedSubscriptionRequest
  | VerifiedXSubscriptionRequest;

interface RemovedCollectionDay {
  localDate: string;
  remainingItems: CollectedItem[];
}
```

- [ ] **Step 1: Write command-level tests**

```ts
await service.add(verifiedRssRequest);
expect(settings.feeds[0]).toMatchObject({
  url: "https://example.com/feed.xml",
  siteUrl: "https://example.com/",
  subscriptionStatus: "active",
  initialImportPolicy: { mode: "lookback-days", days: 7 },
});
await expect(service.add(sameCanonicalFeed)).rejects.toMatchObject({
  code: "duplicate-subscription",
});
await service.remove(feedId, { purgeCollection: false });
expect(collectionService.removeSource).not.toHaveBeenCalled();
```

Cover canonical duplicate keys for feed URL, YouTube channel ID and lowercase X handle; initial RSS/YouTube filtering before first collection write; collection receiving every selected server item before normal cache retention; X feed construction from verified profile; pause excluding refresh without deleting config; stop/resume preserving cursors; rollback when `saveSettings` fails; default delete retaining collection; explicit purge requiring a confirmed capability passed by the modal.

- [ ] **Step 2: Run tests and verify red**

Run: `npm run test:unit -- test_files/unit/services/subscription-service.test.ts test_files/unit/main/feed-refresh-pipeline.test.ts test_files/unit/services/collection-service.test.ts test_files/unit/collection/collection-repository.test.ts`

Expected: FAIL because centralized commands do not exist.

- [ ] **Step 3: Implement canonical commands**

Build all candidate settings in a cloned array, parse/filter before publication, assign stable feed IDs, and ensure folders without an unrelated intermediate save. For RSS/YouTube first import, parse once with retention disabled, apply the selected history cutoff, save the recoverable pending source, write every selected item through `CollectionService`, then apply the configured cache retention and mark the import complete. If collection persistence fails, retain the pending source and untrimmed items with `failed` progress so retry can finish without data loss. For feed verification, revalidate at save time or consume a short-lived verified token tied to the exact canonical identifier; never trust editable title/folder state as proof.

- [ ] **Step 4: Route existing entry points through the service**

Keep `addFeed(...)` as a compatibility wrapper for URI and OPML callers, but have the new modal call only `addVerifiedSubscription`. Add a transactional `CollectionRepository.removeBySourceId` plus `CollectionService.removeSource` that rewrite affected JSONL/index files and daily indexes only after explicit purge confirmation; default removal never calls them. Replace settings-tab X upsert logic with a link/button that activates Dashboard subscription management.

- [ ] **Step 5: Run focused tests**

Run: `npm run test:unit -- test_files/unit/services/subscription-service.test.ts test_files/unit/main/feed-refresh-pipeline.test.ts test_files/unit/settings/sources-settings-tab.test.ts test_files/unit/services/collection-service.test.ts test_files/unit/collection/collection-repository.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/subscription-service.ts main.ts src/settings/tabs/sources-settings-tab.ts src/services/collection-service.ts src/collection/collection-repository.ts test_files/unit/services/subscription-service.test.ts test_files/unit/main/feed-refresh-pipeline.test.ts test_files/unit/settings/sources-settings-tab.test.ts test_files/unit/services/collection-service.test.ts test_files/unit/collection/collection-repository.test.ts
git commit -m "feat: centralize subscription lifecycle"
```

### Task 9: Build the three-card, same-window add flow

**Files:**
- Create: `src/modals/source-onboarding/add-source-modal.ts`
- Create: `src/modals/source-onboarding/initial-import-control.ts`
- Create: `src/modals/source-onboarding/verification-card.ts`
- Create: `src/styles/source-onboarding-modal.css`
- Modify: `src/components/sidebar.ts:2833-2852,3424-3450`
- Modify: `src/modals/feed-manager/feed-manager-modal.ts:30-67`
- Modify: `src/modals/feed-manager-modal.ts:1-12`
- Modify: `main.ts:2045-2095`
- Modify: `src/styles/index.css`
- Modify: `src/i18n/zh-cn.ts`
- Modify: `src/i18n/en.ts`
- Modify: `src/i18n/types.ts`
- Modify generated: `styles.css`
- Test: `test_files/unit/modals/add-source-modal.test.ts`
- Test: `test_files/unit/modals/initial-import-control.test.ts`
- Modify test: `test_files/unit/components/sidebar-core.test.ts`
- Modify test: `test_files/unit/modals/feed-manager-modal.test.ts`

**Interfaces:**
- Produces: `AddSourceModalOptions { initialKind?; initialInput?; verifyRss; verifyYouTube; verifyX; onSubscribe; onOpenSettings }`.
- Consumes: verification services from Tasks 3–6 and `VerifiedSubscriptionRequest` from Task 8.

- [ ] **Step 1: Write DOM tests for the entry and state transitions**

```ts
modal.open();
expect(modal.contentEl.querySelectorAll(".rss-source-kind-card")).toHaveLength(3);
clickCard("youtube");
expect(getHeading()).toBe("添加 YouTube 频道");
setInput("https://www.youtube.com/@OpenAI");
clickDetect();
await flushPromises();
expect(getStatus()).toContain("连接成功");
expect(getConfirmButton().disabled).toBe(false);
setInput("https://www.youtube.com/@Changed");
expect(getConfirmButton().disabled).toBe(true);
expect(modal.contentEl.querySelector(".rss-source-verification-card")).toBeNull();
```

Cover the three card labels, same-modal back behavior, checking state, successful cards, multiple RSS candidates, empty-feed warning, each localized failure, X profile fields, replies/reposts defaults off, all-history second confirmation, advanced settings collapsed, close/cancel invalidation, duplicate prevention, and keyboard/ARIA behavior.

- [ ] **Step 2: Run modal tests and verify red**

Run: `npm run test:unit -- test_files/unit/modals/add-source-modal.test.ts test_files/unit/modals/initial-import-control.test.ts test_files/unit/components/sidebar-core.test.ts test_files/unit/modals/feed-manager-modal.test.ts`

Expected: FAIL because `AddSourceModal` is missing.

- [ ] **Step 3: Implement the same-window renderer**

Render one of `choose`, `identify`, `checking`, or `confirmed` views into the same `contentEl`. Keep exactly one modal lifecycle epoch and one abort controller. The subscribe button reads only the successful immutable verification snapshot and selected import policy; it never reconstructs a request from stale text fields.

- [ ] **Step 4: Implement import selector and warning**

Options are “仅从现在开始、最近 3 天、最近 7 天、最近 14 天、最近 30 天、最近 90 天、自定义、全部可获取历史”. Default to 7 days. Show the source-specific availability explanation next to the control. X all-history opens a second confirmation containing the configured run/day caps before calling `onSubscribe`.

- [ ] **Step 5: Add responsive scoped CSS**

Use `.rss-source-onboarding-modal` as the scope root; cap width at `min(760px, calc(100vw - 32px))`, use a three-column grid above 720px and one column below, keep controls `min-width: 0`, and make the body vertically scroll without moving the footer offscreen. Do not add global `input`, `button`, `.modal`, or `.setting-item` selectors.

- [ ] **Step 6: Replace external add entry points**

Sidebar, feed manager, and URI action open `AddSourceModal`. URI action passes `initialKind: "rss-website"` and the decoded URL. Keep `EditFeedModal` for existing RSS/YouTube edits until Task 10 routes typed editing.

- [ ] **Step 7: Run UI, i18n and CSS checks**

Run: `npm run test:unit -- test_files/unit/modals/add-source-modal.test.ts test_files/unit/modals/initial-import-control.test.ts test_files/unit/components/sidebar-core.test.ts test_files/unit/modals/feed-manager-modal.test.ts && npm run audit:i18n && npm run check:css-scope && npm run check:important && npm run build`

Expected: PASS, with root `styles.css` regenerated from `src/styles/index.css`.

- [ ] **Step 8: Commit**

```bash
git add src/modals/source-onboarding src/styles/source-onboarding-modal.css src/styles/index.css styles.css src/components/sidebar.ts src/modals/feed-manager/feed-manager-modal.ts src/modals/feed-manager-modal.ts main.ts src/i18n test_files/unit/modals/add-source-modal.test.ts test_files/unit/modals/initial-import-control.test.ts test_files/unit/components/sidebar-core.test.ts test_files/unit/modals/feed-manager-modal.test.ts
git commit -m "feat: add verified subscription onboarding"
```

### Task 10: Turn feed management into unified subscription management

**Files:**
- Modify: `src/modals/feed-manager/feed-manager-modal.ts`
- Modify: `src/modals/x-account-source-modal.ts`
- Modify: `src/components/sidebar.ts:1500-1660,3600-3660`
- Modify: `src/views/dashboard-view.ts:3020-3070`
- Modify: `src/i18n/zh-cn.ts`
- Modify: `src/i18n/en.ts`
- Modify: `src/styles/form-modal.css`
- Test: `test_files/unit/modals/feed-manager-modal.test.ts`
- Test: `test_files/unit/modals/x-account-source-modal.test.ts`

**Interfaces:**
- Consumes: `SubscriptionService.update`, `.setPaused`, `.remove`.
- Produces: one list view for active RSS/website, YouTube, Podcast/Mastodon legacy feeds, and X account subscriptions; X topics remain in Theme Discovery.

- [ ] **Step 1: Write unified list and deletion tests**

```ts
modal.open();
expect(rows().map((row) => row.dataset.sourceKind)).toEqual([
  "feed",
  "feed",
  "x-account",
]);
clickDelete("x-account-openai");
expect(confirmText()).toContain("保留已经采集的历史内容");
confirmDelete();
expect(removeSubscription).toHaveBeenCalledWith("x-account-openai", {
  purgeCollection: false,
});
```

Cover type filtering, normal/failed/paused/initial-import-paused status, last success/error, refresh, pause/resume, explicit “停止历史导入” and “继续历史导入” actions, edit routing, address edit forcing re-verification, option-only edit not forcing re-verification, default delete, optional purge checkbox plus second confirmation, and delete-all using the same retention-safe path.

- [ ] **Step 2: Run tests and verify red**

Run: `npm run test:unit -- test_files/unit/modals/feed-manager-modal.test.ts test_files/unit/modals/x-account-source-modal.test.ts`

Expected: FAIL because the manager does not render subscriptions.

- [ ] **Step 3: Render stable keyed rows**

Use `feed.feedId ?? feed.url` as the row key. Show name, localized type, lifecycle status, last updated time, sanitized `lastFetchError`, and first-import progress. Do not display raw cursors, API endpoints, request IDs, handles inside diagnostics, or secret status beyond configured/not configured.

- [ ] **Step 4: Route edit and safe delete**

RSS/YouTube identifier changes reopen the matching onboarding step with the current canonical identity and require a new verification. X handle changes do the same. Folder, tags, retention, replies, reposts, and pause state can update through typed commands without re-verifying identity. `stopInitialImport` retains fetched items and cursors; `resumeInitialImport` changes `stopped` or `paused-limit` back to `pending` and lets the next manual/daily refresh continue from the saved cursor.

- [ ] **Step 5: Run focused and sidebar tests**

Run: `npm run test:unit -- test_files/unit/modals/feed-manager-modal.test.ts test_files/unit/modals/x-account-source-modal.test.ts test_files/unit/components/sidebar-core.test.ts test_files/unit/services/subscription-service.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/modals/feed-manager/feed-manager-modal.ts src/modals/x-account-source-modal.ts src/components/sidebar.ts src/views/dashboard-view.ts src/i18n src/styles/form-modal.css test_files/unit/modals/feed-manager-modal.test.ts test_files/unit/modals/x-account-source-modal.test.ts test_files/unit/components/sidebar-core.test.ts
git commit -m "feat: unify subscription management"
```

### Task 11: Add a non-destructive local update installer

**Files:**
- Create: `scripts/install-local-release.mjs`
- Create: `test_files/unit/scripts/install-local-release.test.ts`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/INSTALL.zh-CN.md`

**Interfaces:**
- Produces command: `npm run install:local -- --target <vault-plugin-directory>`.
- Copies only `main.js`, `manifest.json`, and `styles.css` from `release/`.

- [ ] **Step 1: Write filesystem safety tests**

```ts
await installLocalRelease({ releaseDir, targetDir });
expect(await readFile(join(targetDir, "data.json"), "utf8")).toBe(originalData);
expect(await readFile(join(vaultRoot, ".rss-dashboard-data", "collections", "day.jsonl"), "utf8"))
  .toBe(originalHistory);
expect(await readFile(join(targetDir, "main.js"), "utf8")).toBe(newMain);
```

Cover target outside `.obsidian/plugins` rejected, missing/mismatched manifest rejected, symlink target/artifact rejected, only the three release files copied, atomic temporary-file rename, timestamped backup of overwritten program artifacts plus `data.json`, and pre/post hashes proving `data.json` and `.rss-dashboard-data` are unchanged.

- [ ] **Step 2: Run test and verify red**

Run: `npm run test:unit -- test_files/unit/scripts/install-local-release.test.ts`

Expected: FAIL because the installer does not exist.

- [ ] **Step 3: Implement explicit-target installation**

Require `--target`; do not infer a home directory or hard-code a vault. Resolve and validate real paths, read the target manifest before mutation, create a sibling timestamped backup directory, copy via same-directory temporary files and rename, and abort/restore on verification failure. Never read, copy, print, or relocate the external desktop secret file.

- [ ] **Step 4: Document the update contract**

Document that normal updates replace only three program files; `data.json`, `.rss-dashboard-data`, saved Markdown, and the external secret store remain in place. Include recovery from the timestamped backup and the requirement to reload Obsidian after installation.

- [ ] **Step 5: Run release/install safety checks**

Run: `npm run test:unit -- test_files/unit/scripts/install-local-release.test.ts && npm run check:public && npm run check:version`

Expected: PASS with no personal paths or secrets in tracked files.

- [ ] **Step 6: Commit**

```bash
git add scripts/install-local-release.mjs test_files/unit/scripts/install-local-release.test.ts package.json README.md docs/INSTALL.zh-CN.md
git commit -m "feat: add safe local plugin installer"
```

### Task 12: Complete regression, build, and live Obsidian acceptance

**Files:**
- Modify only when a failing gate identifies a specific defect.
- Create: `docs/verification/2026-07-27-source-subscription-onboarding.md`

**Interfaces:**
- Consumes every prior task.
- Produces a source-backed verification record with no live keys, private handles, personal paths, or raw provider responses.

- [ ] **Step 1: Run the complete automated gate**

Run: `npm run check`

Expected: all unit tests, i18n audit, public-repo checks, workflow/version checks, CSS checks, lint, TypeScript, and production build PASS.

- [ ] **Step 2: Stage release artifacts**

Run: `npm run release:stage && npm run release:check`

Expected: `release/` contains only valid `main.js`, `manifest.json`, and `styles.css`.

- [ ] **Step 3: Install without touching protected state**

Run the explicit-target installer against the user's active plugin directory outside tracked docs. Before and after installation, compare hashes for `data.json` and collection state; verify the external secret status remains configured without printing the key.

Expected: only program artifacts change; configuration, API connections, collection history, and Markdown remain available.

- [ ] **Step 4: Execute the live source matrix without saving test sources**

In Obsidian, verify:

1. “添加订阅” opens three cards in one modal.
2. A direct RSS URL confirms title/latest item.
3. A website with one feed confirms it; a fixture page with two feeds requires selection; a site with none shows a direct error.
4. `https://www.youtube.com/@OpenAI` confirms as YouTube and selects the Videos default, never Mastodon.
5. A malformed YouTube URL cannot subscribe.
6. The configured TikHub account resolves one known public X profile and rejects a nonexistent handle with a safe message.
7. Editing input after success removes the card and disables confirmation.
8. The default first-import choice is 7 days; custom date works; RSS/YouTube all-history wording is bounded.
9. X all-history shows caps and requires a second confirmation; cancel makes no post-history request.
10. Unified management shows source status and default deletion wording preserves history.

Cancel each smoke-test subscription before confirmation, except one disposable RSS fixture used to verify add/pause/delete; remove it with history preservation afterward.

- [ ] **Step 5: Verify daily refresh and data retention**

With a disposable source, run first import and two manual refreshes. Confirm stable IDs prevent duplicates, collection JSONL remains readable, removal leaves collection/daily index/Markdown untouched, and a plugin reload preserves the configured API connection status.

- [ ] **Step 6: Write the verification record**

Record exact automated commands, pass/fail counts, Obsidian version, plugin version, source types tested, and whether the TikHub live smoke gate passed. Use placeholders such as “public test account” rather than writing the actual handle, request ID, endpoint query, key status file path, or vault path.

- [ ] **Step 7: Commit**

```bash
git add docs/verification/2026-07-27-source-subscription-onboarding.md
git commit -m "test: verify subscription onboarding"
```

---

## Self-Review Checklist

- [x] Every design requirement in `docs/superpowers/specs/2026-07-27-source-subscription-onboarding-design.md` maps to Tasks 1–12.
- [x] No plan step contains an unresolved implementation marker or an undefined neighboring interface.
- [x] `InitialImportPolicy`, `InitialImportProgress`, `VerifiedSubscriptionRequest`, `XProfile`, and verification-state names are identical across all consuming tasks.
- [x] RSS/YouTube capability wording never promises full platform history.
- [x] X account verification and X post pagination use the existing TikHub request ledger and external secret store.
- [x] Topic discovery remains separate and its Latest/Top semantics are unchanged.
- [x] Existing API keys, settings, collection JSONL, content cache, AI results, and Markdown survive update and default subscription removal.
- [x] No tracked file includes the user's actual vault/plugin path or any live API material.
