# YouTube Transcript and Playback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user open YouTube in the system browser, optionally use an inline preview, and explicitly fetch, cache, display, refresh, and analyze real public manual or auto-generated subtitles.

**Architecture:** Add a dependency-injected transcript service with an InnerTube-first provider and one optional shell-free `yt-dlp` metadata fallback. Normalize public caption tracks into one provider-neutral transcript, persist it as a versioned `ContentRepository` artifact, and expose it through the existing ReaderView and AI content selector. Playback and transcript retrieval remain separate explicit actions.

**Tech Stack:** TypeScript 5.9, Obsidian desktop API, Node `http`/`https` and `child_process.execFile`, YouTube InnerTube/timed-text endpoints, optional local `yt-dlp`, Vitest 4, existing CSS bundle.

## Global Constraints

- Do not read, copy, export, or request Chrome/YouTube cookies. Do not add an Obsidian YouTube login flow.
- Do not download video/audio and do not add Whisper, ASR, speech-to-text, FFmpeg, Python, Bun, or a caption SaaS dependency.
- Public repository users must not need `yt-dlp`; it is one optional desktop fallback only.
- Never auto-install or update `yt-dlp`.
- Invoke `yt-dlp` with `execFile`, a validated 11-character video ID, a fixed argument list, `shell: false`, timeout/output ceilings, and no cookie arguments. Never execute user-provided command text.
- Try one InnerTube transcript flow first. Invoke `yt-dlp` at most once for a fallback-eligible failure or an empty transcript; do not create retry loops.
- Prefer manual original-language tracks, then auto-generated original-language tracks. Do not silently request machine translation from YouTube.
- A title/description is not a transcript. “No captions” and “temporarily unavailable/unparseable” remain distinct user states.
- Reading a cached transcript creates no network request. Only “重新获取字幕” replaces it, atomically.
- Preserve existing schemaVersion 1 full-text cache files exactly as readable inputs. Do not rewrite them during migration.
- Every task follows red-green-refactor, runs focused tests, and commits independently.

---

## File Map

### New production files

- `src/youtube-transcript/transcript-types.ts` — stable track/result/error contracts and video-ID validation.
- `src/youtube-transcript/transcript-parser.ts` — bounded JSON3, XML/SRV, and WebVTT caption parsing and text normalization.
- `src/youtube-transcript/innertube-transcript-provider.ts` — public watch-page session discovery, InnerTube player request, track projection, and timed-text fetch.
- `src/youtube-transcript/yt-dlp-transcript-provider.ts` — optional executable discovery, fixed-argument metadata request, and subtitle-track projection.
- `src/youtube-transcript/youtube-transcript-service.ts` — one-shot provider coordination, track selection, cache orchestration, and stable errors.
- `src/components/youtube-transcript-panel.ts` — compact reader status/result/actions for cached and freshly fetched subtitles.
- `src/styles/youtube-transcript.css` — scoped transcript panel and external/inline playback controls.

### Existing production files to modify

- `src/collection/collected-item.ts` — add `youtube-transcript` to `ContentBasis`.
- `src/collection/content-basis-display.ts` — localized label for transcript input.
- `src/collection/content-repository.ts` — backward-compatible schemaVersion 1/2 content union and transcript metadata.
- `src/collection/collection-repository.ts` — persist the matching transcript content basis/path on collected observations.
- `src/collection/explicit-content-coordinator.ts` — continue returning only full-text cache entries to ordinary article retrieval.
- `src/ai/content/ai-content-selector.ts` — prefer a cached YouTube transcript over title/description.
- `src/views/video-player.ts` — external browser becomes primary; iframe is created only after “内嵌预览”.
- `src/views/reader-view.ts` — transcript button/panel, cache restore, refresh, cleanup, and AI integration.
- `src/components/article-renderer.ts` — match external-first playback in the inline reader.
- `src/services/media-service.ts` — retain strict video-ID normalization and canonical watch/embed URLs.
- `src/styles/index.css` — import transcript styles.
- `src/i18n/zh-cn.ts`, `src/i18n/en.ts` — transcript/playback labels and stable errors.
- `main.ts` — construct and inject the transcript providers/service without reading browser state.
- `README.md`, `docs/INSTALL.zh-CN.md`, `docs/PRIVACY.zh-CN.md`, `docs/SECURITY.md`, `docs/TROUBLESHOOTING.zh-CN.md` — capabilities, optional local fallback, process boundary, privacy, and no-caption boundary.

### Focused tests to create or modify

- `test_files/unit/youtube-transcript/transcript-types.test.ts`
- `test_files/unit/youtube-transcript/transcript-parser.test.ts`
- `test_files/unit/youtube-transcript/innertube-transcript-provider.test.ts`
- `test_files/unit/youtube-transcript/yt-dlp-transcript-provider.test.ts`
- `test_files/unit/youtube-transcript/youtube-transcript-service.test.ts`
- `test_files/unit/components/youtube-transcript-panel.test.ts`
- `test_files/unit/collection/content-repository.test.ts`
- `test_files/unit/collection/collection-repository.test.ts`
- `test_files/unit/collection/explicit-content-coordinator.test.ts`
- `test_files/unit/collection/content-basis-display.test.ts`
- `test_files/unit/ai/content/ai-content-selector.test.ts`
- `test_files/unit/views/video-player.test.ts`
- `test_files/unit/views/reader-view-content-cache.test.ts`
- `test_files/unit/components/article-renderer-content-cache.test.ts`

---

### Task 1: Define safe transcript contracts and parsers

**Files:**

- Create: `src/youtube-transcript/transcript-types.ts`
- Create: `src/youtube-transcript/transcript-parser.ts`
- Create: `test_files/unit/youtube-transcript/transcript-types.test.ts`
- Create: `test_files/unit/youtube-transcript/transcript-parser.test.ts`

**Interfaces:**

```ts
export type YouTubeTranscriptErrorCode =
  | "invalid-video-id"
  | "video-unavailable"
  | "login-required"
  | "no-captions"
  | "temporarily-unavailable"
  | "timeout"
  | "aborted";

export interface YouTubeCaptionTrack {
  languageCode: string;
  languageName: string;
  isGenerated: boolean;
  source: "innertube" | "yt-dlp";
  url: string;
  format: "json3" | "srv3" | "vtt";
}

export interface YouTubeTranscript {
  videoId: string;
  languageCode: string;
  languageName: string;
  isGenerated: boolean;
  provider: "innertube" | "yt-dlp";
  text: string;
}
```

- [ ] **Step 1: Write video-ID and parser tests**

Accept only `/^[A-Za-z0-9_-]{11}$/`. Test JSON3 `events[].segs[].utf8`, WebVTT cues/settings/tags, and SRV/XML `<text>` nodes. Cover HTML entities, duplicate rolling captions, newlines, empty events, invalid timestamps, unsafe controls, huge payloads, excessive event/node counts, and malformed markup.

- [ ] **Step 2: Run tests and verify red**

Run: `npm run test:unit -- test_files/unit/youtube-transcript/transcript-types.test.ts test_files/unit/youtube-transcript/transcript-parser.test.ts`

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement bounded parsing**

Set explicit ceilings for raw payload bytes, caption events, segment count, segment length, and final normalized characters. Normalize Unicode and whitespace, strip timing/format tags, collapse adjacent duplicate rolling lines, and return plain transcript text without timestamps. Reject an empty normalized result as `temporarily-unavailable`.

- [ ] **Step 4: Run focused tests**

Run: `npm run test:unit -- test_files/unit/youtube-transcript/transcript-types.test.ts test_files/unit/youtube-transcript/transcript-parser.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/youtube-transcript/transcript-types.ts src/youtube-transcript/transcript-parser.ts test_files/unit/youtube-transcript/transcript-types.test.ts test_files/unit/youtube-transcript/transcript-parser.test.ts
git commit -m "feat: add safe YouTube transcript parsing"
```

### Task 2: Discover and fetch public captions through InnerTube

**Files:**

- Create: `src/youtube-transcript/innertube-transcript-provider.ts`
- Create: `test_files/unit/youtube-transcript/innertube-transcript-provider.test.ts`

**Interfaces:**

```ts
export interface TranscriptHttpRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export type TranscriptHttpTransport = (
  request: TranscriptHttpRequest,
) => Promise<{ status: number; headers: Record<string, string>; text: string }>;

export class InnerTubeTranscriptProvider {
  listTracks(videoId: string, signal?: AbortSignal): Promise<YouTubeCaptionTrack[]>;
  fetchTrack(track: YouTubeCaptionTrack, signal?: AbortSignal): Promise<YouTubeTranscript>;
}
```

- [ ] **Step 1: Write transport-injected protocol tests**

Assert the provider:

1. GETs `https://www.youtube.com/watch?v=<id>&hl=en&persist_hl=1&has_verified=1&bpctr=9999999999`.
2. Extracts only `INNERTUBE_API_KEY`, web client version, and visitor data from bounded HTML.
3. POSTs one player request to `https://www.youtube.com/youtubei/v1/player?key=<key>&prettyPrint=false` with the validated video ID and fixed client context.
4. Projects `captions.playerCaptionsTracklistRenderer.captionTracks` without returning the player response.
5. Fetches the chosen timed-text URL once and delegates to the bounded parser.

Cover manual/auto tracks, missing captions, video unavailable, login required, bot/429, malformed page/session/player JSON, unsafe caption URLs, redirect to a non-YouTube host, timeout, abort, and oversized bodies.

- [ ] **Step 2: Run tests and verify red**

Run: `npm run test:unit -- test_files/unit/youtube-transcript/innertube-transcript-provider.test.ts`

Expected: FAIL because the provider does not exist.

- [ ] **Step 3: Implement one bounded InnerTube flow**

Adapt the verified client/session strategy from the local transcript tool into repository-owned TypeScript. Use fixed Android, then web, then iOS client descriptors only when the preceding response is structurally unsupported; these are alternative contexts inside the same explicit transcript action, not paid APIs. Stop immediately on login-required, invalid video, abort, and authoritative no-caption status.

- [ ] **Step 4: Validate every outbound URL**

Watch/player requests must remain HTTPS under `youtube.com`; timed-text tracks may use HTTPS YouTube/Googlevideo caption hosts returned by the provider. Strip fragments, reject credentials, cap redirects, and never forward provider headers to a different origin.

- [ ] **Step 5: Run focused tests**

Run: `npm run test:unit -- test_files/unit/youtube-transcript/innertube-transcript-provider.test.ts test_files/unit/youtube-transcript/transcript-parser.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/youtube-transcript/innertube-transcript-provider.ts test_files/unit/youtube-transcript/innertube-transcript-provider.test.ts
git commit -m "feat: fetch public YouTube captions"
```

### Task 3: Add one optional shell-free yt-dlp fallback

**Files:**

- Create: `src/youtube-transcript/yt-dlp-transcript-provider.ts`
- Create: `test_files/unit/youtube-transcript/yt-dlp-transcript-provider.test.ts`

**Interfaces:**

```ts
export interface ExecutableRunner {
  execFile(
    file: string,
    args: readonly string[],
    options: { timeout: number; maxBuffer: number; signal?: AbortSignal },
  ): Promise<{ stdout: string; stderr: string }>;
}

export class YtDlpTranscriptProvider {
  isAvailable(): Promise<boolean>;
  listTracks(videoId: string, signal?: AbortSignal): Promise<YouTubeCaptionTrack[]>;
  fetchTrack(track: YouTubeCaptionTrack, signal?: AbortSignal): Promise<YouTubeTranscript>;
}
```

- [ ] **Step 1: Write command-boundary tests before code**

Assert the runner receives an executable resolved from `PATH`, `/opt/homebrew/bin/yt-dlp`, `/usr/local/bin/yt-dlp`, or `path.join(os.homedir(), ".local/bin/yt-dlp")`, and only this fixed argument shape:

```ts
[
  "--dump-single-json",
  "--skip-download",
  "--no-warnings",
  "--no-playlist",
  "--socket-timeout", "15",
  "--",
  `https://www.youtube.com/watch?v=${videoId}`,
]
```

Assert `shell` is never enabled, no cookie/browser/auth/output/download flags occur, invalid IDs cannot reach the runner, ENOENT means unavailable, stderr is never surfaced, stdout is capped, timeout/abort kills the child, and the executable is called at most once per service action.

- [ ] **Step 2: Write metadata projection tests**

From `subtitles` and `automatic_captions`, choose supported `json3`, then `srv3`, then `vtt` URLs; keep manual and generated flags; reject unsafe/oversized metadata, URLs with credentials, and unexpected protocols. Do not retain the full yt-dlp JSON object.

- [ ] **Step 3: Run tests and verify red**

Run: `npm run test:unit -- test_files/unit/youtube-transcript/yt-dlp-transcript-provider.test.ts`

Expected: FAIL because the provider does not exist.

- [ ] **Step 4: Implement executable discovery and fixed execution**

Use `node:fs/promises.access` with `X_OK`, `node:os.homedir`, `node:path`, and promisified `node:child_process.execFile`. Do not invoke a shell, `which`, `uvx`, `npx`, or the local Codex skill. Parse plain data properties defensively and clear large buffers/references after projection.

- [ ] **Step 5: Fetch the selected public subtitle URL**

Use the same bounded caption HTTP/parser boundary as InnerTube. The local tool discovers URLs; it does not write output files into the vault or plugin directory.

- [ ] **Step 6: Run focused tests**

Run: `npm run test:unit -- test_files/unit/youtube-transcript/yt-dlp-transcript-provider.test.ts test_files/unit/youtube-transcript/transcript-parser.test.ts test_files/unit/check-platform-compat.test.ts`

Expected: PASS and the platform check continues to accept desktop-only Node built-ins.

- [ ] **Step 7: Commit**

```bash
git add src/youtube-transcript/yt-dlp-transcript-provider.ts test_files/unit/youtube-transcript/yt-dlp-transcript-provider.test.ts
git commit -m "feat: add optional yt-dlp caption fallback"
```

### Task 4: Coordinate track selection and versioned content caching

**Files:**

- Create: `src/youtube-transcript/youtube-transcript-service.ts`
- Create: `test_files/unit/youtube-transcript/youtube-transcript-service.test.ts`
- Modify: `src/collection/collected-item.ts`
- Modify: `src/collection/content-basis-display.ts`
- Modify: `src/collection/content-repository.ts`
- Modify: `src/collection/collection-repository.ts`
- Modify: `src/collection/explicit-content-coordinator.ts`
- Modify: `test_files/unit/collection/content-basis-display.test.ts`
- Modify: `test_files/unit/collection/content-repository.test.ts`
- Modify: `test_files/unit/collection/collection-repository.test.ts`
- Create: `test_files/unit/collection/explicit-content-coordinator.test.ts`

**Interfaces:**

```ts
export interface FullTextCachedItemContent {
  schemaVersion: 1;
  contentBasis: "full-text";
  itemId: string;
  sourceUrl?: string;
  fetchedAt: string;
  text: string;
}

export interface YouTubeTranscriptCachedItemContent {
  schemaVersion: 2;
  contentBasis: "youtube-transcript";
  itemId: string;
  sourceUrl?: string;
  fetchedAt: string;
  videoId: string;
  languageCode: string;
  languageName: string;
  isGenerated: boolean;
  provider: "innertube" | "yt-dlp";
  text: string;
}

export type CachedItemContent =
  | FullTextCachedItemContent
  | YouTubeTranscriptCachedItemContent;
```

Extend collected-metadata synchronization as:

```ts
updateContentMetadata(
  id: string,
  contentPath: string,
  contentBasis: "full-text" | "youtube-transcript" = "full-text",
): Promise<void>;
```

- [ ] **Step 1: Write repository compatibility tests**

Assert existing schemaVersion 1 Markdown reads byte-for-byte as before. Assert schemaVersion 2 transcript metadata round-trips, validates video ID/language/provider/type, uses the same stable item path, rejects unknown fields/types, preserves atomic recovery, and never rewrites v1 on read. Assert ordinary full-text coordination ignores a transcript artifact instead of presenting it as an article body.

- [ ] **Step 2: Write service orchestration tests**

Cover cache hit with zero provider calls; explicit refresh; manual-before-auto selection; preferred language matching; multiple equal tracks returned for compact user selection; InnerTube success with no yt-dlp call; one fallback after eligible failure/empty payload; no fallback after abort/invalid ID/login-required; missing yt-dlp; no captions from both providers; and no cache write on failure.

- [ ] **Step 3: Run tests and verify red**

Run: `npm run test:unit -- test_files/unit/youtube-transcript/youtube-transcript-service.test.ts test_files/unit/collection/content-repository.test.ts test_files/unit/collection/collection-repository.test.ts test_files/unit/collection/explicit-content-coordinator.test.ts test_files/unit/collection/content-basis-display.test.ts`

Expected: FAIL because transcript cache/service contracts do not exist.

- [ ] **Step 4: Implement the v1/v2 repository union**

Keep the existing atomic-write/recovery/locking path. Serialize only the documented frontmatter. Parse by `schemaVersion` first and call the matching strict assertion. Add `youtube-transcript` to `ContentBasis`, collection validation, and localized basis labels. Make metadata synchronization accept the explicit basis while preserving `full-text` as the default for existing callers. The ordinary explicit-content coordinator must use only a `full-text` cache entry.

- [ ] **Step 5: Implement one in-flight service key**

Deduplicate concurrent `itemId + videoId` transcript requests with a shared promise. `get({ refresh: false })` returns valid cache. `get({ refresh: true })` runs providers and atomically replaces the cache only after a complete non-empty transcript is validated. After that write, synchronize collected observations with `contentBasis: "youtube-transcript"`; a metadata-sync failure does not discard the already validated cache and is repaired on the next read.

- [ ] **Step 6: Re-run focused tests**

Run: `npm run test:unit -- test_files/unit/youtube-transcript/youtube-transcript-service.test.ts test_files/unit/collection/content-repository.test.ts test_files/unit/collection/collection-repository.test.ts test_files/unit/collection/explicit-content-coordinator.test.ts test_files/unit/collection/content-basis-display.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/youtube-transcript/youtube-transcript-service.ts src/collection/collected-item.ts src/collection/content-basis-display.ts src/collection/content-repository.ts src/collection/collection-repository.ts src/collection/explicit-content-coordinator.ts test_files/unit/youtube-transcript/youtube-transcript-service.test.ts test_files/unit/collection/content-repository.test.ts test_files/unit/collection/collection-repository.test.ts test_files/unit/collection/explicit-content-coordinator.test.ts test_files/unit/collection/content-basis-display.test.ts
git commit -m "feat: cache YouTube transcripts safely"
```

### Task 5: Make cached transcripts the YouTube AI input

**Files:**

- Modify: `src/ai/content/ai-content-selector.ts`
- Modify: `test_files/unit/ai/content/ai-content-selector.test.ts`

**Interfaces:**

- YouTube selection priority becomes cached `youtube-transcript`, then `title-description`.
- `fetchFullText` never causes transcript retrieval; transcript acquisition remains the separate explicit “获取字幕” action.

- [ ] **Step 1: Add failing selector tests**

Assert a matching schemaVersion 2 cache produces basis `youtube-transcript`, normalized transcript text, and normal input truncation. Wrong item ID, v1 full text attached to YouTube, malformed transcript, or no cache falls back to title/description. Assert no transcript network dependency exists on the selector.

- [ ] **Step 2: Run the test and verify red**

Run: `npm run test:unit -- test_files/unit/ai/content/ai-content-selector.test.ts`

Expected: the selector currently returns title/description before reading cache.

- [ ] **Step 3: Implement transcript-first YouTube selection**

Read the current item's cache before the YouTube fallback. Accept only `contentBasis === "youtube-transcript"` with the same item ID. Reuse existing normalization and `maxInputCharacters` truncation.

- [ ] **Step 4: Run focused tests**

Run: `npm run test:unit -- test_files/unit/ai/content/ai-content-selector.test.ts test_files/unit/collection/content-repository.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ai/content/ai-content-selector.ts test_files/unit/ai/content/ai-content-selector.test.ts
git commit -m "feat: analyze cached YouTube transcripts"
```

### Task 6: Replace login-prone playback with external-first controls

**Files:**

- Modify: `src/views/video-player.ts`
- Modify: `src/components/article-renderer.ts`
- Modify: `src/services/media-service.ts`
- Modify: `src/styles/video.css`
- Modify: `src/i18n/zh-cn.ts`
- Modify: `src/i18n/en.ts`
- Modify: `test_files/unit/views/video-player.test.ts`
- Modify: `test_files/unit/components/article-renderer-content-cache.test.ts`
- Modify: `test_files/unit/utils/youtube-embed-config.test.ts`

**Interfaces:**

- `VideoPlayer.loadVideo` initially renders metadata and buttons without creating an iframe.
- Primary anchor/button opens canonical `watchUrl` with the system external URL handler.
- Secondary “内嵌预览” creates the existing privacy-enhanced iframe on demand; “收起预览” destroys it.

- [ ] **Step 1: Write failing external-first tests**

Assert initial render contains no iframe, the primary action points to `https://www.youtube.com/watch?v=<id>` with safe external attributes/handler, and only a secondary click constructs `youtube-nocookie.com/embed/...`. Assert repeated preview toggles do not leak message listeners or progress timers.

- [ ] **Step 2: Run tests and verify red**

Run: `npm run test:unit -- test_files/unit/views/video-player.test.ts test_files/unit/utils/youtube-embed-config.test.ts`

Expected: FAIL because the iframe is currently created immediately.

- [ ] **Step 3: Separate chrome from iframe lifecycle**

Render title/channel/date/description once. Move iframe construction, `initPlayer`, progress tracking, and related postMessage state into `openInlinePreview`; move teardown into `closeInlinePreview`. Keep the external button visible even when the iframe fails.

- [ ] **Step 4: Apply the same control order to inline article rendering**

The large reader and inline reader must both show “在浏览器中播放” as primary and “内嵌预览” as secondary. Do not claim the browser is Chrome; the OS chooses the default browser.

- [ ] **Step 5: Run focused tests**

Run: `npm run test:unit -- test_files/unit/views/video-player.test.ts test_files/unit/components/article-renderer-content-cache.test.ts test_files/unit/utils/youtube-embed-config.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/views/video-player.ts src/components/article-renderer.ts src/services/media-service.ts src/styles/video.css src/i18n/zh-cn.ts src/i18n/en.ts test_files/unit/views/video-player.test.ts test_files/unit/components/article-renderer-content-cache.test.ts test_files/unit/utils/youtube-embed-config.test.ts
git commit -m "fix: open YouTube in the system browser"
```

### Task 7: Add the compact transcript panel to ReaderView

**Files:**

- Create: `src/components/youtube-transcript-panel.ts`
- Create: `src/styles/youtube-transcript.css`
- Create: `test_files/unit/components/youtube-transcript-panel.test.ts`
- Modify: `main.ts`
- Modify: `src/views/reader-view.ts`
- Modify: `src/styles/index.css`
- Modify: `src/i18n/zh-cn.ts`
- Modify: `src/i18n/en.ts`
- Modify: `test_files/unit/views/reader-view-content-cache.test.ts`
- Modify: `test_files/unit/views/reader-view-onclose-cleanup.test.ts`

**Interfaces:**

```ts
export interface YouTubeTranscriptPanelController {
  showCached(): Promise<void>;
  fetch(): Promise<void>;
  refresh(): Promise<void>;
  selectTrack(trackId: string): Promise<void>;
  abort(): void;
  destroy(): void;
}
```

- [ ] **Step 1: Write component state tests**

Cover idle, cached, checking, language-choice, fetching, complete-manual, complete-auto, no-captions, unavailable, timeout, aborted, and destroyed. Assert compact language choice appears only for equal-priority tracks and no large modal opens.

- [ ] **Step 2: Write ReaderView integration tests**

Assert YouTube displays “获取字幕”; opening an item restores cache without network; clicking fetch streams status then shows transcript; “重新获取” is the only forced provider call; switching items/closing the view aborts active work and detaches listeners; success updates the visible content-basis label.

- [ ] **Step 3: Run tests and verify red**

Run: `npm run test:unit -- test_files/unit/components/youtube-transcript-panel.test.ts test_files/unit/views/reader-view-content-cache.test.ts test_files/unit/views/reader-view-onclose-cleanup.test.ts`

Expected: FAIL because the panel and wiring do not exist.

- [ ] **Step 4: Implement the scoped panel**

Place it after the article action/header area and before the video description/content. Show language, “人工字幕/自动字幕”, fetched time, transcript body, collapse/expand, refresh, and external playback. Errors stay inside this panel.

- [ ] **Step 5: Wire one service instance through plugin composition**

Construct providers/service in `main.ts` using the existing `ContentRepository` data root and inject it into ReaderView. Do not expose provider internals to the component. Bind AI action availability to the newly cached transcript on the next selector read.

- [ ] **Step 6: Import responsive styles**

Use a single-column panel below 700px, wrap action buttons, constrain long text/URLs, and scope every selector below the plugin root to satisfy CSS policy.

- [ ] **Step 7: Run focused and CSS tests**

Run: `npm run test:unit -- test_files/unit/components/youtube-transcript-panel.test.ts test_files/unit/views/reader-view-content-cache.test.ts test_files/unit/views/reader-view-onclose-cleanup.test.ts && npm run check:css-scope && npm run check:important`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/components/youtube-transcript-panel.ts src/styles/youtube-transcript.css src/styles/index.css src/views/reader-view.ts main.ts src/i18n/zh-cn.ts src/i18n/en.ts test_files/unit/components/youtube-transcript-panel.test.ts test_files/unit/views/reader-view-content-cache.test.ts test_files/unit/views/reader-view-onclose-cleanup.test.ts
git commit -m "feat: add inline YouTube transcripts"
```

### Task 8: Document and verify the transcript boundary

**Files:**

- Modify: `README.md`
- Modify: `docs/INSTALL.zh-CN.md`
- Modify: `docs/PRIVACY.zh-CN.md`
- Modify: `docs/SECURITY.md`
- Modify: `docs/TROUBLESHOOTING.zh-CN.md`
- Modify: `test_files/unit/docs/public-release-documentation.test.ts`

- [ ] **Step 1: Add failing documentation assertions**

Require public docs to state: manual/auto public captions, no description substitution, optional `yt-dlp`, no auto-install, fixed `execFile`/no-shell process boundary, no cookies, no video/audio download, no Whisper/ASR, external-browser login separation, cache location, and explicit refresh behavior.

- [ ] **Step 2: Run the docs test and verify red**

Run: `npm run test:unit -- test_files/unit/docs/public-release-documentation.test.ts`

Expected: FAIL until documentation is updated.

- [ ] **Step 3: Update user-facing documentation**

Give a short macOS optional check (`yt-dlp --version`) but keep the built-in InnerTube path primary. Explain that videos with no YouTube caption track cannot produce a transcript in this release.

- [ ] **Step 4: Run the complete YouTube slice**

Run: `npm run test:unit -- test_files/unit/youtube-transcript test_files/unit/collection/content-repository.test.ts test_files/unit/ai/content/ai-content-selector.test.ts test_files/unit/views/video-player.test.ts test_files/unit/views/reader-view-content-cache.test.ts test_files/unit/docs/public-release-documentation.test.ts`

Expected: PASS without network, cookies, or local yt-dlp dependency.

- [ ] **Step 5: Run repository policy checks**

Run: `npm run audit:i18n && npm run check:platform && npm run check:public && git diff --check`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add README.md docs test_files/unit/docs/public-release-documentation.test.ts
git commit -m "docs: explain YouTube transcript limits"
```
