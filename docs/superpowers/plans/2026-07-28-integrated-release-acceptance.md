# Inline AI, YouTube Transcript, and X Compatibility Release Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate the X compatibility, YouTube transcript/playback, and inline streaming AI work into one non-destructive Obsidian desktop release, prove protected user data is unchanged, and leave GitHub PR #5 mergeable only after real user acceptance.

**Architecture:** Implement the three focused plans sequentially on the existing feature worktree, resolve shared ReaderView/main/i18n changes in one composition pass, run the full repository gates, stage a three-file release, install through the guarded local installer while Obsidian is fully closed, then perform bounded manual acceptance. GitHub merge remains a final explicit decision after local and CI evidence.

**Tech Stack:** Existing npm/Vitest/TypeScript/esbuild pipeline, guarded local release installer, Obsidian desktop, GitHub CLI/Actions.

## Global Constraints

- Work only in the current repository worktree on `codex/source-subscription-onboarding-design` unless the user explicitly selects another branch.
- Execute the focused plans in this order: X compatibility; YouTube transcript/playback; inline streaming AI. The later AI plan must preserve the transcript controls already added to ReaderView/main/i18n.
- Do not run independent overlapping implementations of `main.ts`, `src/views/reader-view.ts`, `src/components/article-renderer.ts`, or i18n files in parallel.
- Never run a live TikHub request without a new explicit one-request authorization. Automated X acceptance uses fixtures only.
- Real AI acceptance is initiated by the user clicking one named action; do not spend model credit automatically.
- Do not install while Obsidian is running. Confirm the process is closed immediately before installation.
- Installation may replace only `main.js`, `manifest.json`, and `styles.css` in the plugin directory.
- Preserve `data.json`, the external secrets file, `.rss-dashboard-data`, subscriptions, collection history, content cache, AI analyses, and all user Markdown. Do not “clean” these paths.
- Use the existing guarded installer and retain its timestamped backup. Never use recursive deletion/reset commands.
- Do not merge PR #5 until local acceptance and GitHub CI pass and the user explicitly approves merge.
- Every task records exact pass/fail evidence; a failed gate blocks release rather than being summarized away.

---

## Inputs

- X plan: `docs/superpowers/plans/2026-07-28-x-profile-compatibility-implementation.md`
- YouTube plan: `docs/superpowers/plans/2026-07-28-youtube-transcript-playback-implementation.md`
- AI plan: `docs/superpowers/plans/2026-07-28-inline-streaming-ai-implementation.md`
- Confirmed design: `docs/superpowers/specs/2026-07-28-inline-ai-youtube-transcript-x-compat-design.md`
- Local plugin target: the validated absolute `rss-dashboard-cn` plugin directory supplied at execution time as `RSS_DASHBOARD_INSTALL_TARGET` (never commit the personal vault path).
- External secrets: the platform path returned by the existing secret-path module (never hard-code or commit a user directory).
- Pull request: `https://github.com/ChadBai5665/obsidian-rss-dashboard-cn/pull/5`

---

### Task 1: Execute the three focused implementation plans in dependency order

**Files:**

- Modify only the files enumerated by the three focused plans.
- Track checklist completion inside each plan as implementation proceeds.

- [ ] **Step 1: Prove the starting branch and protected tree state**

Run: `git status --short && git branch --show-current && git log -5 --oneline`

Expected: branch is `codex/source-subscription-onboarding-design`; only the approved plan/spec documentation is uncommitted before implementation begins.

- [ ] **Step 2: Execute the X plan completely**

Follow `2026-07-28-x-profile-compatibility-implementation.md` task-by-task. Stop at its live acceptance gate; do not call TikHub.

- [ ] **Step 3: Execute the YouTube plan completely**

Follow `2026-07-28-youtube-transcript-playback-implementation.md`. Tests must pass without network and without `yt-dlp`; the injected optional-runner tests prove fallback behavior.

- [ ] **Step 4: Execute the inline AI plan completely**

Follow `2026-07-28-inline-streaming-ai-implementation.md`. While resolving shared files, retain both transcript and AI panels in this order: article actions, inline AI panel when selected, transcript panel for YouTube, source/video content.

- [ ] **Step 5: Audit shared-file integration**

Run: `git diff origin/main...HEAD -- main.ts src/views/reader-view.ts src/components/article-renderer.ts src/styles/index.css src/i18n/zh-cn.ts src/i18n/en.ts`

Expected: no later task removed external-first playback, transcript controls/cache wiring, inline AI panel/task wiring, or any prior source-onboarding entry point.

- [ ] **Step 6: Commit integration-only conflict resolution if needed**

```bash
git add main.ts src/views/reader-view.ts src/components/article-renderer.ts src/styles/index.css src/i18n/zh-cn.ts src/i18n/en.ts
git commit -m "fix: integrate reader transcript and AI controls"
```

Skip this commit when the focused task commits already leave no integration diff.

### Task 2: Run the complete automated release gate

**Files:**

- Verify only; fix failures in the narrow owning subsystem and add regression tests there.

- [ ] **Step 1: Run focused cross-feature regression tests**

Run: `npm run test:unit -- test_files/unit/sources/tikhub/x-profile.test.ts test_files/unit/sources/tikhub/x-profile-shape-diagnostic.test.ts test_files/unit/sources/tikhub/x-profile-resolver.test.ts test_files/unit/youtube-transcript test_files/unit/collection/content-repository.test.ts test_files/unit/ai test_files/unit/components/inline-ai-panel.test.ts test_files/unit/components/youtube-transcript-panel.test.ts test_files/unit/views/video-player.test.ts test_files/unit/views/reader-view-ai-actions.test.ts test_files/unit/views/reader-view-content-cache.test.ts test_files/unit/main/ai-operation-wiring.test.ts`

Expected: PASS with no live TikHub, YouTube, AI, or local-process dependency.

- [ ] **Step 2: Run the repository-wide gate**

Run: `npm run check`

Expected: all unit tests, i18n audit, public-repository scan, workflow/version/compliance checks, lint, typecheck, and production build pass.

- [ ] **Step 3: Inspect generated artifact policy**

Run: `npm run release:stage && npm run release:check`

Expected: staged release contains only the declared plugin artifacts and their verified hashes; generated `main.js`/`styles.css` match current source.

- [ ] **Step 4: Inspect the final diff and repository status**

Run: `git diff --check && git status --short && git diff --stat origin/main...HEAD`

Expected: no whitespace error, secret, personal path in public files, unexpected generated cache, or untracked test artifact.

- [ ] **Step 5: Commit release-stage source metadata only if the release tool requires it**

Do not commit transient backups/logs. If the repository contract tracks release artifacts, stage only files required by `release:check` and commit:

```bash
git add main.js manifest.json styles.css versions.json package.json package-lock.json
git commit -m "build: stage RSS Dashboard release"
```

Skip absent/unchanged files and do not bump version unless repository version checks and the intended release policy require it.

### Task 3: Install without changing keys, configuration, history, or Markdown

**Files:**

- Release source: `release/main.js`, `release/manifest.json`, `release/styles.css`
- Target program files: `$RSS_DASHBOARD_INSTALL_TARGET/{main.js,manifest.json,styles.css}`.
- Protected target data: plugin `data.json`, the external file resolved by the secret-path module, `.rss-dashboard-data`, and vault Markdown.

- [ ] **Step 1: Ask the user to fully quit Obsidian**

Wait until the user confirms. Then perform a read-only process check immediately before installation. If any Obsidian process remains, stop; do not install.

- [ ] **Step 2: Record pre-install fingerprints without printing secrets**

Use the existing installer/test helpers or a read-only hash command to record SHA-256 for `data.json` and the external secret file, plus count/hash manifests for `.rss-dashboard-data` and user Markdown. Store evidence outside the public repository or only in the terminal; never print file contents.

- [ ] **Step 3: Run the guarded installer**

Set `RSS_DASHBOARD_INSTALL_TARGET` in the local terminal to the already validated absolute plugin directory without writing that personal path into the repository. Then run:

```bash
npm run install:local -- --target "$RSS_DASHBOARD_INSTALL_TARGET"
```

Expected output includes `install-local-success`, a backup-directory name, and `preserved-data-verified`.

- [ ] **Step 4: Verify program and protected-state fingerprints**

Run `npm run release:check`, compare installed artifact hashes to staged release hashes, and compare every protected pre/post fingerprint. Expected: only the three program files changed; all protected hashes/counts are identical.

- [ ] **Step 5: Report the recoverable backup**

Record the exact timestamped backup directory returned by the installer. Do not delete it during this release.

### Task 4: Perform bounded manual Obsidian acceptance

**Files:**

- User data may be read by the plugin normally; no direct mutation outside normal tested actions.

- [ ] **Step 1: Reopen Obsidian and confirm plugin startup**

Open the vault, confirm RSS 信息台 loads, existing subscriptions/history remain, and settings still show the saved MiniMax/TikHub connection metadata without requiring key re-entry.

- [ ] **Step 2: Test YouTube playback and transcript cache**

With one public captioned video, verify primary play opens the system browser, secondary inline preview remains optional, “获取字幕” shows real manual/auto metadata and transcript, closing/reopening restores cache without another request, and “重新获取” is the only forced refresh. With one known no-caption video, verify the explicit no-caption state and no description substitution.

- [ ] **Step 3: Test one user-authorized AI operation**

The user clicks one named action on the captioned video. Verify direct inline generation without confirmation modal, visible incremental final text, collapse/reopen continuity, completed Markdown under `.rss-dashboard-data/analysis/...`, zero duplicate request on repeated click, and explicit regenerate creates a second file while retaining the first.

- [ ] **Step 4: Test error presentation without deleting data**

Temporarily select a connection with no key or use a non-billable mocked/local failure if available. Verify inline configuration/error guidance and no empty analysis file. Restore settings without replacing saved keys.

- [ ] **Step 5: Hold the live X verification until separately authorized**

Ask for a new explicit one-request TikHub authorization. After authorization, click “识别并检验” once for `@naval`, verify the resolved display name/handle card, and do not start historical import unless the user separately confirms it. If unsupported again, capture only the value-free local diagnostic category.

- [ ] **Step 6: Recheck protected data after manual acceptance**

Expected changes are only user-triggered new transcript/analysis cache files and normal read/status metadata. Existing keys/config/subscriptions/history/Markdown must still exist; no old artifact may disappear.

### Task 5: Push, verify CI, and stop before merge

**Files:**

- Git/GitHub state only.

- [ ] **Step 1: Ensure all intended work is committed**

Run: `git status --short && git log --oneline --decorate origin/codex/source-subscription-onboarding-design..HEAD`

Expected: clean tree and a reviewable sequence of focused commits.

- [ ] **Step 2: Push the existing branch**

Run: `git push origin codex/source-subscription-onboarding-design`

Expected: push succeeds without force.

- [ ] **Step 3: Inspect PR #5 and wait for checks**

Run: `gh pr view 5 --json state,mergeStateStatus,statusCheckRollup,url,headRefName,baseRefName`

Expected: PR is open against the intended base and every required check passes. If CI fails, follow `github:gh-fix-ci`; do not merge around a failing check.

- [ ] **Step 4: Summarize acceptance evidence for the user**

Report automated gates, local installer preservation, YouTube/AI outcomes, whether the single X paid check was authorized/performed, backup location, and any remaining release blocker.

- [ ] **Step 5: Request explicit merge approval**

Do not merge from this plan automatically. Merge PR #5 only after the user explicitly approves based on the evidence above.
