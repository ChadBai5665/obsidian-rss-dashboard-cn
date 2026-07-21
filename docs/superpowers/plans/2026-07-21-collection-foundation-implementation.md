# RSS Dashboard CN Collection Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the upstream RSS Dashboard into a desktop-first `RSS Dashboard CN` collector that refreshes once per local calendar day when Obsidian opens, records neutral daily observations, preserves source isolation, and saves articles to Markdown without overwriting user work.

**Architecture:** Keep the upstream feed parser and `.rss-dashboard-data/feeds` cache, then add a normalized collection layer beside it. Refresh adapters produce `FeedItem` values; `CollectionService` converts them into stable `CollectedItem` records; `CollectionRepository` writes data before `SourceRefreshLedger` advances state. A marker-delimited renderer owns only the generated section of each daily Markdown index.

**Tech Stack:** TypeScript, Obsidian Plugin API, Vitest/jsdom, esbuild, Node.js 20.19+, JSONL and Markdown files stored through `app.vault.adapter`.

## Global Constraints

- Preserve upstream RSS/Atom/JSON/Podcast, website, and YouTube behavior unless this plan names an intentional change.
- Extend `.rss-dashboard-data`; do not introduce another hidden data root.
- No external daemon and no refresh while Obsidian is closed.
- The default refresh mode is once per local calendar date on Obsidian open. Interval mode remains available only as an explicit setting.
- Complete every write in this order: collection data, daily Markdown index, then refresh ledger.
- One source failure must not prevent other sources from refreshing.
- Never log article contents, API keys, authorization headers, or full third-party response bodies.
- Run focused tests before each implementation step and commit after each completed task.

---

## Task 1: Establish product identity and versioned settings

**Files:**

- Modify: `manifest.json`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/types/types.ts`
- Modify: `src/utils/settings-loader.ts`
- Modify: `test_files/unit/utils/settings-loader.test.ts`
- Modify: `test_files/unit/main/plugin-lifecycle.test.ts`

- [ ] **Step 1: Write failing settings migration tests**

Add cases proving that an old upstream settings payload receives the new defaults without losing feeds, and that explicitly selected interval/off modes survive reload:

```ts
expect(loadSettings({ feeds: existingFeeds })).toMatchObject({
  feeds: existingFeeds,
  refreshMode: "daily-on-open",
  collection: {
    enabled: true,
    dataFolder: ".rss-dashboard-data",
    dailyIndexFolder: "信息收集/每日采集",
    savedNoteFolder: "信息收集/已保存",
  },
});
```

- [ ] **Step 2: Run the focused tests and confirm the new fields are absent**

Run: `npm run test:unit -- test_files/unit/utils/settings-loader.test.ts test_files/unit/main/plugin-lifecycle.test.ts`

Expected: FAIL because `refreshMode` and `collection` do not exist.

- [ ] **Step 3: Add settings types and defaults**

Add these types to `src/types/types.ts` and include them in `RssDashboardSettings`:

```ts
export type RefreshMode = "daily-on-open" | "interval" | "off";

export interface CollectionSettings {
  enabled: boolean;
  dataFolder: string;
  dailyIndexFolder: string;
  savedNoteFolder: string;
}
```

Set the exact defaults shown in Step 1. Retain `refreshInterval` for the explicit `interval` mode and retain `startupRefreshDelaySeconds` for both automatic modes.

- [ ] **Step 4: Update plugin identity**

Set:

```json
{
  "id": "rss-dashboard-cn",
  "name": "RSS Dashboard CN",
  "isDesktopOnly": true
}
```

Change the package name to `obsidian-rss-dashboard-cn` in both `package.json` and the root package metadata in `package-lock.json`. Do not change the semantic version in this task.

- [ ] **Step 5: Make the settings loader perform an additive migration**

Merge nested `collection` defaults independently so partial user settings are retained. Never replace an existing `feeds` array, folder list, display setting, or rule.

- [ ] **Step 6: Re-run tests**

Run: `npm run test:unit -- test_files/unit/utils/settings-loader.test.ts test_files/unit/main/plugin-lifecycle.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add manifest.json package.json package-lock.json src/types/types.ts src/utils/settings-loader.ts test_files/unit/utils/settings-loader.test.ts test_files/unit/main/plugin-lifecycle.test.ts
git commit -m "feat: establish RSS Dashboard CN settings"
```

## Task 2: Define normalized collection records and stable identities

**Files:**

- Create: `src/collection/collected-item.ts`
- Create: `src/collection/item-identity.ts`
- Create: `src/collection/feed-normalizer.ts`
- Create: `test_files/unit/collection/item-identity.test.ts`
- Create: `test_files/unit/collection/feed-normalizer.test.ts`

- [ ] **Step 1: Write identity tests first**

Cover these exact rules:

1. A canonicalized item URL determines the ID before source-local identifiers, so the same article observed through two feeds deduplicates globally.
2. Tracking parameters `utm_*`, `fbclid`, and `gclid` do not change the ID.
3. Without a usable URL, the same source and non-empty GUID always produce the same ID.
4. Without GUID or URL, use source ID, normalized title, author, and publication time.
5. Two different sources with the same title do not collide.
6. The returned ID is a lowercase 64-character SHA-256 hex string.

Use Node's `createHash("sha256")`; do not add a hashing dependency.

- [ ] **Step 2: Run the new tests and confirm imports fail**

Run: `npm run test:unit -- test_files/unit/collection/item-identity.test.ts test_files/unit/collection/feed-normalizer.test.ts`

Expected: FAIL because the collection modules do not exist.

- [ ] **Step 3: Add the collection schema**

Define this contract in `src/collection/collected-item.ts`:

```ts
export type SourceType = "rss" | "atom" | "json" | "podcast" | "website" | "youtube" | "x-account" | "x-topic";
export type ObservationType = "new" | "updated" | "rediscovered";
export type ContentBasis = "feed" | "full-text" | "title-description" | "x-post" | "linked-page";
export type CollectionStatus = "collected" | "partial" | "parse-error";

export interface CollectedItem {
  schemaVersion: 1;
  id: string;
  sourceType: SourceType;
  sourceId: string;
  sourceName: string;
  sourceBucket: string;
  title: string;
  author?: string;
  publishedAt?: string;
  fetchedAt: string;
  firstSeenAt: string;
  lastSeenAt: string;
  url?: string;
  guid?: string;
  observationType: ObservationType;
  topics: string[];
  language?: string;
  excerpt?: string;
  contentPath?: string;
  contentBasis: ContentBasis;
  metrics?: Record<string, number>;
  read: boolean;
  starred: boolean;
  saved: boolean;
  savedNotePath?: string;
  collectionStatus: CollectionStatus;
}
```

- [ ] **Step 4: Implement canonical identity input**

Implement and export:

```ts
export function canonicalizeUrl(rawUrl: string): string;
export function createCollectedItemId(input: {
  sourceId: string;
  guid?: string;
  url?: string;
  title: string;
  author?: string;
  publishedAt?: string;
}): string;
```

Normalize host casing, remove fragments and default ports, sort remaining query parameters, and remove only the tracking parameters named in Step 1. Use a successfully parsed canonical URL as the global identity input before GUID. If `new URL()` fails, treat the raw value as unavailable for global URL identity rather than merging malformed strings from unrelated sources.

- [ ] **Step 5: Normalize `FeedItem` without changing upstream parsers**

Implement `normalizeFeedItem(feed, item, now)` in `feed-normalizer.ts`. Determine source type from the feed media/source metadata; default to `rss`. YouTube records must use `contentBasis: "title-description"`. Standard feed records use `contentBasis: "feed"`. Do not fetch full text here.

- [ ] **Step 6: Re-run tests**

Run: `npm run test:unit -- test_files/unit/collection/item-identity.test.ts test_files/unit/collection/feed-normalizer.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/collection test_files/unit/collection
git commit -m "feat: add normalized collection records"
```

## Task 3: Add idempotent JSONL collection storage

**Files:**

- Create: `src/collection/collection-repository.ts`
- Create: `src/collection/collection-merge.ts`
- Create: `test_files/unit/collection/collection-repository.test.ts`
- Create: `test_files/unit/collection/collection-merge.test.ts`

- [ ] **Step 1: Write repository tests with an in-memory adapter**

Test the exact paths and semantics:

- `collections/2026-07-21.jsonl` contains at most one line for an ID on that date.
- A second observation on the same date merges newer metrics, flags, excerpt, and `lastSeenAt`.
- The earliest `firstSeenAt` survives.
- Seeing an existing global ID on a later date writes `observationType: "rediscovered"`.
- Malformed existing JSONL lines are preserved in a `.corrupt` sidecar and do not erase valid lines.
- A failed adapter write rejects and never reports success.

- [ ] **Step 2: Run the tests and confirm failure**

Run: `npm run test:unit -- test_files/unit/collection/collection-merge.test.ts test_files/unit/collection/collection-repository.test.ts`

Expected: FAIL because the repository does not exist.

- [ ] **Step 3: Implement merge behavior as a pure function**

Implement:

```ts
export function mergeCollectedItems(previous: CollectedItem, incoming: CollectedItem): CollectedItem;
```

Never replace a non-empty `savedNotePath`, `contentPath`, or `excerpt` with an empty value. Boolean state uses logical OR for `saved` and `starred`; `read` takes the latest explicit value. Merge `topics` uniquely and metrics by key using the latest observed value.

- [ ] **Step 4: Implement repository layout**

The constructor receives `Vault`, the data root, and a clock. It must create only these subdirectories as needed:

```text
.rss-dashboard-data/
  collections/
  content/
  analysis/
  state/
```

Expose:

```ts
upsertDaily(items: CollectedItem[], localDate: string): Promise<CollectedItem[]>;
findById(id: string): Promise<CollectedItem | null>;
listByDate(localDate: string): Promise<CollectedItem[]>;
updateFlags(id: string, patch: Pick<CollectedItem, "read" | "starred" | "saved" | "savedNotePath">): Promise<void>;
```

Use a temporary sibling file followed by adapter rename for each JSONL rewrite. If rename is unavailable in a test adapter, use write-after-successful-temp-write and remove the temp file only after the final write completes.

- [ ] **Step 5: Add an ID index under `state/item-index.json`**

The index maps ID to its earliest date and latest date. Rebuild it from collection files if it is missing or invalid. Write the index only after the corresponding daily JSONL write succeeds.

- [ ] **Step 6: Re-run tests**

Run: `npm run test:unit -- test_files/unit/collection/collection-merge.test.ts test_files/unit/collection/collection-repository.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/collection/collection-repository.ts src/collection/collection-merge.ts test_files/unit/collection
git commit -m "feat: persist daily collection snapshots"
```

## Task 4: Render neutral daily Markdown indexes without erasing user edits

**Files:**

- Create: `src/collection/daily-index-renderer.ts`
- Create: `src/collection/daily-index-service.ts`
- Create: `test_files/unit/collection/daily-index-renderer.test.ts`
- Create: `test_files/unit/collection/daily-index-service.test.ts`

- [ ] **Step 1: Write renderer tests**

Assert:

- The filename is `信息收集/每日采集/2026-07-21.md`.
- Items are grouped by `sourceBucket`, then ordered by `publishedAt` descending and title ascending as a deterministic tie-breaker.
- The index contains no `Top 10`, score, recommendation, or value judgment.
- Each item shows source, time, title, original URL, and objective observation type.
- Content outside generated markers survives byte-for-byte.
- Re-rendering identical data is byte-for-byte idempotent.

Use these exact ownership markers:

```md
<!-- RSS-DASHBOARD-CN:AUTO:START -->
<!-- RSS-DASHBOARD-CN:AUTO:END -->
```

- [ ] **Step 2: Run the tests and confirm failure**

Run: `npm run test:unit -- test_files/unit/collection/daily-index-renderer.test.ts test_files/unit/collection/daily-index-service.test.ts`

Expected: FAIL because the renderer and service do not exist.

- [ ] **Step 3: Implement the pure renderer**

Expose:

```ts
export function renderDailyIndex(input: {
  localDate: string;
  items: CollectedItem[];
  existingMarkdown?: string;
}): string;
```

The generated frontmatter contains only `date`, `type: rss-collection`, and `generatedBy: rss-dashboard-cn`. Escape Markdown link brackets and line breaks in external titles.

- [ ] **Step 4: Implement the vault service**

Create the parent folders if missing. If the file already exists without markers, append one generated block after the existing content; never assume the whole file belongs to the plugin.

- [ ] **Step 5: Re-run tests**

Run: `npm run test:unit -- test_files/unit/collection/daily-index-renderer.test.ts test_files/unit/collection/daily-index-service.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/collection/daily-index-renderer.ts src/collection/daily-index-service.ts test_files/unit/collection/daily-index-renderer.test.ts test_files/unit/collection/daily-index-service.test.ts
git commit -m "feat: render neutral daily collection indexes"
```

## Task 5: Replace elapsed-time startup refresh with local-calendar refresh

**Files:**

- Create: `src/refresh/local-calendar-day.ts`
- Create: `src/refresh/source-refresh-ledger.ts`
- Create: `test_files/unit/refresh/local-calendar-day.test.ts`
- Create: `test_files/unit/refresh/source-refresh-ledger.test.ts`
- Modify: `main.ts`
- Modify: `test_files/unit/main/plugin-lifecycle.test.ts`

- [ ] **Step 1: Write date and lifecycle tests**

Cover:

- Two timestamps on the same Asia/Shanghai calendar date do not trigger a second daily refresh.
- Crossing local midnight triggers a refresh even if fewer than 24 hours elapsed.
- `off` never schedules startup or interval refresh.
- `interval` retains upstream timer behavior.
- An unsuccessful daily refresh is eligible for retry on the next Obsidian open that same day.
- Startup delay is honored without blocking plugin load.

- [ ] **Step 2: Run the tests and confirm old elapsed-time behavior fails them**

Run: `npm run test:unit -- test_files/unit/refresh/local-calendar-day.test.ts test_files/unit/refresh/source-refresh-ledger.test.ts test_files/unit/main/plugin-lifecycle.test.ts`

Expected: FAIL on calendar-date and retry assertions.

- [ ] **Step 3: Implement local date formatting without a date library**

Expose:

```ts
export function toLocalCalendarDate(date: Date): string;
export function shouldRunDailyRefresh(lastSuccessDate: string | undefined, now: Date): boolean;
```

Use local `getFullYear()`, `getMonth() + 1`, and `getDate()`, padded to `YYYY-MM-DD`. Do not use UTC slicing.

- [ ] **Step 4: Implement per-source ledger storage**

Store `.rss-dashboard-data/state/source-refresh.json` with:

```ts
interface SourceRefreshState {
  sourceId: string;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastSuccessDate?: string;
  status: "idle" | "success" | "error";
  errorCode?: string;
  errorMessage?: string;
}
```

Sanitize `errorMessage` to a maximum of 300 characters and remove URL query strings and header-like secrets.

- [ ] **Step 5: Update `main.ts` scheduling**

Move scheduling into named methods:

```ts
private scheduleAutomaticRefresh(): void;
private async refreshOnOpenIfNeeded(): Promise<void>;
```

Daily mode uses the ledger's successful calendar date. Interval mode alone registers `window.setInterval`. Do not update the ledger inside the scheduler; the refresh pipeline owns it after durable writes.

- [ ] **Step 6: Re-run tests**

Run: `npm run test:unit -- test_files/unit/refresh/local-calendar-day.test.ts test_files/unit/refresh/source-refresh-ledger.test.ts test_files/unit/main/plugin-lifecycle.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/refresh main.ts test_files/unit/refresh test_files/unit/main/plugin-lifecycle.test.ts
git commit -m "feat: refresh once per local calendar day"
```

## Task 6: Integrate collection writes into the source-isolated refresh pipeline

**Files:**

- Create: `src/services/collection-service.ts`
- Create: `test_files/unit/services/collection-service.test.ts`
- Modify: `main.ts`
- Modify: `test_files/unit/main/feed-refresh-pipeline.test.ts`

- [ ] **Step 1: Write orchestration tests**

Use spies to assert this exact success sequence for each source:

```text
parser refresh -> normalize -> JSONL upsert -> daily Markdown render -> ledger success
```

Also assert:

- A parser failure writes an error ledger entry but does not call the collection repository.
- A JSONL or Markdown failure writes an error ledger entry and never advances `lastSuccessDate`.
- One source failure does not stop a later source.
- Manual refresh-all, refresh-failed, and refresh-single use the same pipeline.
- Offline errors leave prior collection files untouched.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `npm run test:unit -- test_files/unit/services/collection-service.test.ts test_files/unit/main/feed-refresh-pipeline.test.ts`

Expected: FAIL because refresh does not write collection records or per-source state.

- [ ] **Step 3: Implement `CollectionService`**

Expose one method:

```ts
collectFeedRefresh(input: {
  feed: Feed;
  previousItems: FeedItem[];
  refreshedItems: FeedItem[];
  fetchedAt: Date;
}): Promise<CollectedItem[]>;
```

On the first bootstrap, collect all current items. On later feed refreshes, collect new stable IDs plus materially changed existing records. A material change is a changed title, excerpt/content hash, publication time, or metrics; read/starred UI state alone is not a new observation.

- [ ] **Step 4: Make `refreshFeedDirect` return a structured result**

Use:

```ts
interface FeedRefreshResult {
  feed: Feed;
  previousItems: FeedItem[];
  refreshedItems: FeedItem[];
  fetchedAt: Date;
}
```

Do not duplicate parsing between automatic and manual refresh paths.

- [ ] **Step 5: Add `refreshFailedSources()`**

Read source IDs with ledger status `error`, resolve them against current subscriptions, and send only those sources through the standard pipeline. Ignore ledger entries for deleted sources.

- [ ] **Step 6: Re-run tests**

Run: `npm run test:unit -- test_files/unit/services/collection-service.test.ts test_files/unit/main/feed-refresh-pipeline.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/services/collection-service.ts test_files/unit/services/collection-service.test.ts main.ts test_files/unit/main/feed-refresh-pipeline.test.ts
git commit -m "feat: collect refreshed feed observations"
```

## Task 7: Cache explicitly fetched full text under the shared data root

**Files:**

- Create: `src/collection/content-repository.ts`
- Create: `test_files/unit/collection/content-repository.test.ts`
- Modify: `src/utils/full-article-fetch.ts`
- Modify: `src/views/reader-view.ts`
- Create: `test_files/unit/views/reader-view-content-cache.test.ts`

- [ ] **Step 1: Write failing content-cache tests**

Prove:

- Feed refresh and daily collection never trigger a full-article fetch.
- Opening a normal article in the reader may fetch full text and writes `.rss-dashboard-data/content/{stable-id}.md` only after extraction succeeds.
- A failed/restricted extraction leaves no empty content file and the reader uses feed content.
- A later save or manual AI action can reuse cached full text without another network request.
- YouTube content is never promoted from `title-description` to `full-text` and no transcript/media request occurs.
- Rewriting a plugin-owned cached content file is atomic and never exposes a partial final file.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `npm run test:unit -- test_files/unit/collection/content-repository.test.ts test_files/unit/views/reader-view-content-cache.test.ts`

Expected: FAIL because the content repository does not exist.

- [ ] **Step 3: Implement the cached-content contract**

Use:

```ts
export interface CachedItemContent {
  schemaVersion: 1;
  itemId: string;
  sourceUrl?: string;
  fetchedAt: string;
  contentBasis: "full-text";
  text: string;
}
```

Expose `read(itemId)`, `write(content)`, and `remove(itemId)`. Filenames use the validated 64-character stable ID only. Store provenance in frontmatter and extracted Markdown/text in the body; reject empty or whitespace-only content.

- [ ] **Step 4: Integrate only with explicit full-text fetch paths**

The reader calls the repository after a successful explicit full-text extraction. `full-article-fetch.ts` remains a fetch/extract utility and does not scan the vault. The repository path is provided from collection settings rather than hard-coded in the reader.

- [ ] **Step 5: Update the collected item after the content write**

Set `contentPath` and `contentBasis: "full-text"` through `CollectionRepository` only after the cached content file is durable. A metadata update failure must not delete the valid cached file; record a safe warning for repair on next access.

- [ ] **Step 6: Re-run tests**

Run: `npm run test:unit -- test_files/unit/collection/content-repository.test.ts test_files/unit/views/reader-view-content-cache.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/collection/content-repository.ts src/utils/full-article-fetch.ts src/views/reader-view.ts test_files/unit/collection/content-repository.test.ts test_files/unit/views/reader-view-content-cache.test.ts
git commit -m "feat: cache explicitly fetched article content"
```

## Task 8: Make Markdown saving idempotent and collision-safe

**Files:**

- Modify: `src/services/article-saver.ts`
- Modify: `src/types/types.ts`
- Modify: `test_files/unit/services/article-saver.test.ts`
- Modify: `src/collection/content-repository.ts`
- Modify: `src/collection/collection-repository.ts`
- Modify: `test_files/unit/collection/collection-repository.test.ts`

- [ ] **Step 1: Add failing save behavior tests**

Prove:

- Saving the same stable item twice returns and opens the existing note.
- The existing file body is not rewritten on the second save.
- Cached full text is reused without another website request.
- Two different IDs with the same title produce `Title.md` and `Title-{first-8-id-characters}.md`.
- No file is moved to trash and no unrelated same-title note is overwritten.
- The saved note frontmatter contains `rssDashboardId`, `source`, `sourceUrl`, `publishedAt`, and `savedAt`.
- Repository flags update only after the Markdown file write succeeds.

- [ ] **Step 2: Run the focused tests and confirm current trash/replace behavior fails**

Run: `npm run test:unit -- test_files/unit/services/article-saver.test.ts test_files/unit/collection/collection-repository.test.ts`

Expected: FAIL on duplicate and collision cases.

- [ ] **Step 3: Replace title-only lookup with stable-ID lookup**

Search frontmatter in the configured saved-note folder for `rssDashboardId`. If it exists, return that path and open it. Do not re-fetch full text and do not rewrite the file.

- [ ] **Step 4: Use a deterministic filename collision rule**

Attempt the sanitized title first. If the path exists but belongs to another ID, append the first eight characters of the stable ID. If that path also exists for another ID, append the first twelve characters. Reject with a clear error rather than overwrite if a collision still exists.

- [ ] **Step 5: Keep full-text fallback semantics**

On explicit save, read the cached full text first; if absent, attempt Readability extraction and cache it after success. If extraction fails, save feed content and set frontmatter `contentBasis: feed`. For YouTube, save title and description only with `contentBasis: title-description`. Do not download media or subtitles.

- [ ] **Step 6: Re-run tests**

Run: `npm run test:unit -- test_files/unit/services/article-saver.test.ts test_files/unit/collection/collection-repository.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/services/article-saver.ts src/types/types.ts src/collection/content-repository.ts src/collection/collection-repository.ts test_files/unit/services/article-saver.test.ts test_files/unit/collection/collection-repository.test.ts
git commit -m "fix: save articles without overwriting notes"
```

## Task 9: Expose neutral collection views and manual refresh actions

**Files:**

- Create: `src/collection/collection-query-service.ts`
- Create: `test_files/unit/collection/collection-query-service.test.ts`
- Modify: `src/views/dashboard-view.ts`
- Create: `test_files/unit/views/dashboard-collection-sections.test.ts`
- Modify: `main.ts`

- [ ] **Step 1: Write query and dashboard tests**

Cover these filters without translating labels yet:

- Today's collection.
- My subscriptions.
- Starred.
- Saved.
- Text search over title, author, source, excerpt, and topics.
- Source/type/topic/read-state filters compose with search.
- Manual actions call refresh all, failed, or a selected source.
- The view does not rank items or produce a Top 10.

- [ ] **Step 2: Run tests and confirm failure**

Run: `npm run test:unit -- test_files/unit/collection/collection-query-service.test.ts test_files/unit/views/dashboard-collection-sections.test.ts`

Expected: FAIL because the query service and collection sections do not exist.

- [ ] **Step 3: Implement the query service as pure filtering and deterministic sorting**

Expose:

```ts
query(input: {
  items: CollectedItem[];
  text?: string;
  sourceTypes?: SourceType[];
  topics?: string[];
  read?: boolean;
  starred?: boolean;
  saved?: boolean;
}): CollectedItem[];
```

Sort by `publishedAt ?? fetchedAt` descending, then title, then ID. No quality score is permitted.

- [ ] **Step 4: Add dashboard sections and refresh commands**

Wire the new sections to collection data and keep the upstream feed view accessible. Register command-palette actions for refresh all and refresh failed. A source row action handles refresh-single.

- [ ] **Step 5: Re-run tests**

Run: `npm run test:unit -- test_files/unit/collection/collection-query-service.test.ts test_files/unit/views/dashboard-collection-sections.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/collection/collection-query-service.ts test_files/unit/collection/collection-query-service.test.ts src/views/dashboard-view.ts test_files/unit/views/dashboard-collection-sections.test.ts main.ts
git commit -m "feat: expose daily collection dashboard"
```

## Task 10: Run foundation regression and build checks

**Files:**

- Modify only if a check reveals a foundation regression.

- [ ] **Step 1: Run all unit tests**

Run: `npm run test:unit`

Expected: all tests PASS.

- [ ] **Step 2: Run lint**

Run: `npm run lint`

Expected: exit code 0 with no lint errors.

- [ ] **Step 3: Build the plugin**

Run: `npm run build`

Expected: exit code 0 and root `main.js` produced.

- [ ] **Step 4: Inspect generated artifacts**

Run: `git status --short && test -f main.js && node -e 'const m=require("./manifest.json"); if(m.id!=="rss-dashboard-cn"||m.name!=="RSS Dashboard CN"||m.isDesktopOnly!==true) process.exit(1)'`

Expected: only intentionally tracked source/test changes are present; manifest assertion exits 0.

- [ ] **Step 5: Commit any check-driven corrections**

If no correction was required, do not create an empty commit. If corrections were required:

```bash
git add -u
git commit -m "test: complete collection foundation verification"
```

## Acceptance Checklist

- [ ] A clean upstream settings payload defaults to once-per-local-date refresh.
- [ ] Manual refresh all, failed, and single source share one source-isolated pipeline.
- [ ] RSS/website/YouTube observations enter the stable JSONL schema.
- [ ] A daily index can be regenerated without erasing user-authored Markdown.
- [ ] Source success state advances only after collection and Markdown writes succeed.
- [ ] Full text is fetched/cached only on explicit reader/save/AI paths and never during daily collection.
- [ ] Saving the same item is idempotent and same-title collisions never overwrite files.
- [ ] No automatic summary, translation, ranking, or external background service was added.
- [ ] Unit tests, lint, and build pass.
