# RSS Dashboard CN Public Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the self-use plugin safe and understandable to install manually, then prepare a clean, attributable, reproducible public repository and GitHub release without publishing or submitting anything until the user explicitly authorizes it.

**Architecture:** Treat documentation, privacy boundaries, version metadata, clean build artifacts, and release validation as tested product surfaces. CI builds from a clean checkout and publishes only Obsidian's required standalone files. Public-release readiness is a local gate; GitHub repository creation, push, release publication, and Obsidian community-directory submission remain separate authorized actions.

**Tech Stack:** Markdown, Node.js validation scripts, npm, GitHub Actions, Obsidian manual plugin installation, existing MIT license and upstream git remote.

## Global Constraints

- Preserve the upstream MIT license notice for Aditya Amatya and visibly attribute `amatya-aditya/obsidian-rss-dashboard` in README and NOTICE.
- Do not include private vault paths, personal account lists, feed exports, X keywords, API keys, secret-file contents, local logs, fixture capture inputs, or generated collection data.
- The release contains individual `main.js`, `manifest.json`, and optional `styles.css`; source archives added automatically by GitHub do not replace them.
- The Git tag/release name must exactly match `manifest.json` version and must not add a leading `v`.
- `manifest.json` ID stays `rss-dashboard-cn`, name stays `RSS Dashboard CN`, and `isDesktopOnly` stays `true`.
- Manual installation is the first supported distribution path. Community-directory submission is optional and later.
- Never create a GitHub repository, push, publish a release, or open an Obsidian submission PR during this plan unless the user separately and explicitly asks.
- Run focused tests before implementation and commit after each completed task.

---

## Task 1: Replace upstream-facing documentation with an honest Chinese-first product guide

**Files:**

- Rewrite: `README.md`
- Create: `docs/INSTALL.zh-CN.md`
- Create: `docs/PRIVACY.zh-CN.md`
- Create: `docs/TROUBLESHOOTING.zh-CN.md`
- Create: `NOTICE.md`
- Modify: `CONTRIBUTING.MD`
- Preserve: `LICENSE`
- Modify: `manifest.json`
- Modify: `package.json`

- [ ] **Step 1: Write a documentation acceptance checklist before rewriting**

The README must contain these exact sections:

```text
RSS 信息台
它做什么
它不做什么
支持的信息源
每天打开时刷新
安装
第一次使用
数据存在哪里
TikHub 与费用边界
按需 AI 与隐私边界
备份与删除
已知限制
上游项目与许可证
开发与验证
```

- [ ] **Step 2: Set release metadata for the new plugin line**

Set package and manifest version to `0.1.0` only when the preceding four implementation plans have passed their acceptance checks. Add `"author": "Chad"` only if the user confirms that public author name; otherwise use the user's confirmed GitHub display name at execution time and stop this task until that single identity is known. Do not reuse the upstream author as the derivative plugin author.

- [ ] **Step 3: Rewrite README with explicit product boundaries**

State clearly:

- Collection works locally without AI.
- Obsidian must be open for refresh; there is no daemon.
- RSS/websites/YouTube follow the upstream collection approach.
- YouTube analysis uses only title/description, not transcript/audio/video.
- X uses optional paid TikHub calls with user-controlled caps.
- TikHub `Top` is a platform category, not a quality recommendation.
- AI actions are manual and send only the selected item's content to the configured provider.
- No automatic summary, translation, ranking, or failover exists.
- The plugin is desktop-only because it uses external OS-level secret storage.

- [ ] **Step 4: Write exact manual installation instructions**

Document:

```text
{vault-root}/.obsidian/plugins/rss-dashboard-cn/
  main.js
  manifest.json
  styles.css
```

Tell users to create that exact folder, copy individual release files, restart/reload Obsidian, then enable `RSS Dashboard CN` under Community plugins. Include update and uninstall steps; uninstalling the plugin does not automatically delete collected Markdown/data or the external secret file.

- [ ] **Step 5: Write privacy and troubleshooting docs**

Privacy docs enumerate every local folder and external request category. State that Unix secret files are permission-restricted, while Windows relies on OS-account filesystem protection and is not an encrypted credential vault. Provide exact deletion paths for vault data and OS secret files.

- [ ] **Step 6: Add upstream attribution**

Keep `LICENSE` byte-for-byte unless legal review requires an additive derivative notice. `NOTICE.md` and README must link to `https://github.com/amatya-aditya/obsidian-rss-dashboard`, name Aditya Amatya, state the fork began from upstream `2.5.0`, and state both projects use the MIT license.

- [ ] **Step 7: Update contribution guidance**

Replace upstream-only branch/release assumptions with the actual `main` plus `codex/*` workflow, required `npm run check`, privacy requirements, fixture sanitization rules, and the rule that no key-bearing reproduction data enters issues.

- [ ] **Step 8: Review links and claims locally**

Run: `rg -n 'TO[D]O|TB[D]|your-name|your-repo|example\.com|amatya-aditya|2\.5\.0|rss-dashboard-cn' README.md NOTICE.md docs CONTRIBUTING.MD manifest.json package.json`

Expected: no unfinished planning markers or sample identities; upstream attribution and plugin ID/version appear in the correct sections.

- [ ] **Step 9: Commit**

```bash
git add README.md docs/INSTALL.zh-CN.md docs/PRIVACY.zh-CN.md docs/TROUBLESHOOTING.zh-CN.md NOTICE.md CONTRIBUTING.MD manifest.json package.json LICENSE
git commit -m "docs: prepare RSS Dashboard CN for self-install"
```

## Task 2: Prevent secrets and private collection state from entering exports or diagnostics

**Files:**

- Create: `src/security/public-settings-export.ts`
- Create: `src/security/safe-diagnostics.ts`
- Create: `test_files/unit/security/public-settings-export.test.ts`
- Create: `test_files/unit/security/safe-diagnostics.test.ts`
- Modify: `src/services/import-export-service.ts`
- Modify: `test_files/unit/services/import-export-service.test.ts`
- Modify: `.gitignore`

- [ ] **Step 1: Write failing export and diagnostics tests**

Assert exported settings may include feed/source definitions, folders, non-secret provider connection metadata, and request caps, but must exclude:

```text
apiKey / token / authorization / secret file path / request history /
collected item bodies / AI results / saved notes / per-source errors containing URLs
```

Diagnostics may include plugin/Obsidian version, OS name, source counts by kind, safe status codes, and timestamps; no handles, feed URLs, titles, keywords, filesystem paths, or model prompts.

- [ ] **Step 2: Run tests and confirm current export behavior is too broad**

Run: `npm run test:unit -- test_files/unit/security/public-settings-export.test.ts test_files/unit/security/safe-diagnostics.test.ts test_files/unit/services/import-export-service.test.ts`

Expected: FAIL.

- [ ] **Step 3: Add an explicit export allowlist**

Build a fresh serializable object field-by-field. Do not clone settings and delete known secret fields, because future fields would leak by default. Preserve connection IDs only if needed to reconnect imported metadata; imported connections always show `未配置密钥`.

- [ ] **Step 4: Add safe diagnostics construction**

Use structured codes instead of raw error strings. Give users a separate opt-in `复制诊断信息` action whose preview is shown before clipboard copy.

- [ ] **Step 5: Extend `.gitignore`**

Ignore:

```text
.rss-dashboard-data/
信息收集/
secrets.json
*.local.json
*.diagnostics.json
test_files/fixtures/tikhub/raw/
```

Do not ignore sanitized tracked fixtures or required release assets.

- [ ] **Step 6: Re-run tests**

Run: `npm run test:unit -- test_files/unit/security/public-settings-export.test.ts test_files/unit/security/safe-diagnostics.test.ts test_files/unit/services/import-export-service.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/security/public-settings-export.ts src/security/safe-diagnostics.ts src/services/import-export-service.ts test_files/unit/security test_files/unit/services/import-export-service.test.ts .gitignore
git commit -m "fix: keep private state out of exports"
```

## Task 3: Add repository privacy, artifact, and version validators

**Files:**

- Create: `scripts/check-public-repo.mjs`
- Create: `scripts/check-release-artifacts.mjs`
- Create: `scripts/check-version-consistency.mjs`
- Create: `scripts/public-scan-allowlist.json`
- Create: `test_files/unit/scripts/check-public-repo.test.ts`
- Create: `test_files/unit/scripts/check-release-artifacts.test.ts`
- Create: `test_files/unit/scripts/check-version-consistency.test.ts`
- Modify: `package.json`
- Modify: `version-bump.mjs`
- Modify: `versions.json`

- [ ] **Step 1: Write validator tests with temporary fixture repositories**

The public scan must reject:

- Absolute macOS/Windows/Linux home paths.
- Key-like tokens and authorization headers.
- Tracked `.rss-dashboard-data`, `信息收集`, `secrets.json`, raw fixtures, diagnostics, or `.env` files.
- Personal X handles/keywords listed in a deliberately private test fixture.
- Unfinished planning markers and sample repository/author text in release documentation.

It must permit clearly synthetic credentials only inside redaction unit tests through exact allowlist entries with reasons.

- [ ] **Step 2: Write release artifact tests**

Assert:

- `release/main.js` and `release/manifest.json` exist and are non-empty.
- `release/styles.css` is included when root `styles.css` exists.
- No other file appears in `release/`.
- Release manifest matches root manifest byte-for-byte.
- Bundled `main.js` does not contain absolute local paths or obvious keys.

- [ ] **Step 3: Write version consistency tests**

Package version, manifest version, and `versions.json` entry must match. Validate semantic version syntax and require a release tag argument to equal the version without a leading `v`.

- [ ] **Step 4: Run tests and confirm scripts are absent**

Run: `npm run test:unit -- test_files/unit/scripts/check-public-repo.test.ts test_files/unit/scripts/check-release-artifacts.test.ts test_files/unit/scripts/check-version-consistency.test.ts`

Expected: FAIL.

- [ ] **Step 5: Implement validators using Node standard library**

Inspect tracked files via `git ls-files -z`, not the entire working directory, so `node_modules` and private ignored local data do not create noise. Scan text files and inspect filenames separately. Never print a matched secret in full; print path, line, rule ID, and a redacted prefix only.

- [ ] **Step 6: Make version bump deterministic**

Update `version-bump.mjs` to validate `npm_package_version`, write two-space JSON with trailing newline, and refuse to run with a dirty `manifest.json`/`versions.json` unless invoked by `npm version`. Preserve all historical upstream entries and add `0.1.0` with the current `minAppVersion`.

- [ ] **Step 7: Add package scripts**

Merge these with existing scripts:

```json
{
  "scripts": {
    "check:public": "node scripts/check-public-repo.mjs",
    "check:version": "node scripts/check-version-consistency.mjs",
    "release:stage": "npm run build && node scripts/check-release-artifacts.mjs --stage",
    "release:check": "node scripts/check-release-artifacts.mjs --check",
    "check": "npm run test:unit && npm run audit:i18n && npm run check:public && npm run check:version && npm run lint && npm run build"
  }
}
```

- [ ] **Step 8: Re-run tests and validators**

Run: `npm run test:unit -- test_files/unit/scripts/check-public-repo.test.ts test_files/unit/scripts/check-release-artifacts.test.ts test_files/unit/scripts/check-version-consistency.test.ts && npm run check:public && npm run check:version`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add scripts/check-public-repo.mjs scripts/check-release-artifacts.mjs scripts/check-version-consistency.mjs scripts/public-scan-allowlist.json test_files/unit/scripts package.json version-bump.mjs versions.json
git commit -m "test: add public release safety gates"
```

## Task 4: Harden CI and draft-release workflows

**Files:**

- Modify: `.github/workflows/test.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `.github/PULL_REQUEST_TEMPLATE.md`
- Remove: `.github/funding.yml`

- [ ] **Step 1: Check out sparse-missing workflow files if needed**

Run: `git sparse-checkout add .github`

Expected: tracked workflow/template files appear locally without changing their content.

- [ ] **Step 2: Update CI to run one canonical check**

Use Node 22 and `npm ci`, then run `npm run check`. Keep coverage optional/non-blocking only if Codecov is not configured for the future public repository; a missing third-party token must not block correctness checks.

- [ ] **Step 3: Make release workflow validate before publishing**

On a numeric tag:

1. Checkout.
2. `npm ci`.
3. `node scripts/check-version-consistency.mjs "$GITHUB_REF_NAME"`.
4. `npm run check`.
5. `npm run release:stage`.
6. Attest `release/main.js`, `release/manifest.json`, and `release/styles.css` when present.
7. Create a draft release whose name is exactly the tag and attach the three individual files.

Stable releases remain drafts until manually reviewed. Prerelease tags such as `0.1.0-beta.1` may be marked prerelease but must still start as drafts unless the user later changes policy.

- [ ] **Step 4: Remove upstream funding metadata**

The fork must not present the upstream author's funding button as its own. Preserve upstream support links only in the attribution section if helpful.

- [ ] **Step 5: Update PR checklist**

Require privacy scan, localization audit, unit tests, build, release-note decision, fixture sanitization, and upstream attribution review. Base-branch text must match the actual repository policy.

- [ ] **Step 6: Validate workflow syntax and diff**

Run: `git diff --check && npm run check:public`

Expected: no whitespace errors and no public scan failures.

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/test.yml .github/workflows/release.yml .github/PULL_REQUEST_TEMPLATE.md .github/funding.yml
git commit -m "ci: harden checks and draft releases"
```

## Task 5: Verify a clean manual installation in a disposable vault

**Files:**

- Create: `docs/release/0.1.0-smoke-test.md`
- Modify only other files if verification exposes a defect.

- [ ] **Step 1: Run the full clean gate**

Run: `npm ci && npm run check && npm run release:stage && npm run release:check`

Expected: all commands exit 0 and `release/` contains only `main.js`, `manifest.json`, and `styles.css`.

- [ ] **Step 2: Create a disposable vault outside the repository**

Use a temporary directory created with `mktemp -d`, then create `.obsidian/plugins/rss-dashboard-cn`. Copy only the staged release files. Do not use the user's real vault for first verification.

- [ ] **Step 3: Perform the manual smoke matrix**

Record pass/fail for:

```text
plugin loads in Simplified Chinese
English switch works
RSS feed refresh and daily index
website save with fallback
YouTube channel/video metadata and youtube-nocookie embed
same-day restart makes no second automatic refresh
manual refresh all/failed/single
duplicate save opens existing note
same-title collision creates ID suffix
TikHub disabled path
TikHub missing/invalid key path
AI unconfigured path
AI successful manual action when a disposable key is available
uninstall leaves data and explains cleanup
```

Never put real feed URLs, handles, keywords, keys, home paths, or item titles in the smoke report; use source kinds and pass/fail evidence only.

- [ ] **Step 4: Inspect plugin storage boundaries**

Confirm the disposable vault contains only expected `.rss-dashboard-data` and `信息收集` paths, and the secret file is outside it with correct Unix permissions. Confirm disabling/uninstalling the plugin makes no external request.

- [ ] **Step 5: Write the sanitized smoke report**

Include Obsidian version, OS, plugin version, checks performed, result, and known limitations. Do not claim Windows/Linux runtime verification unless actually performed; mark them unverified instead.

- [ ] **Step 6: Remove the disposable vault recoverably**

Move it to the system Trash after verification rather than recursively deleting it. Do not remove any real vault or external secret file.

- [ ] **Step 7: Commit the report and any verified fixes**

```bash
git add docs/release/0.1.0-smoke-test.md
git add -u
git commit -m "test: verify clean Obsidian self-install"
```

## Task 6: Prepare upstream sync and public repository metadata

**Files:**

- Create: `docs/UPSTREAM.md`
- Create: `SECURITY.md`
- Create: `.github/ISSUE_TEMPLATE/config.yml`
- Modify: `.github/ISSUE_TEMPLATE/bug_report.md`
- Modify: `.github/ISSUE_TEMPLATE/feature_request.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Verify git remote truth**

Run: `git remote -v`

Expected: the original repository is named `upstream` and points to `https://github.com/amatya-aditya/obsidian-rss-dashboard.git`. No public `origin` is required yet.

- [ ] **Step 2: Document upstream sync policy**

`docs/UPSTREAM.md` must record the fork base commit/version, how to fetch `upstream`, how to review upstream changes, and which fork invariants must be re-tested: plugin ID, desktop secret storage, Chinese catalogs, daily refresh, collection schema, non-overwrite saving, and manual-only AI.

- [ ] **Step 3: Add safe issue/security guidance**

Tell reporters never to paste keys, full `data.json`, raw TikHub responses, feed exports, personal handles/keywords, or vault paths. Provide a sanitized diagnostics workflow. `SECURITY.md` uses GitHub private vulnerability reporting once a public repository exists; until then it says to contact the repository owner through the future repository's private reporting channel, without inventing an email.

- [ ] **Step 4: Add a fork changelog section**

Preserve upstream history under an `Upstream history` heading and add a new `RSS Dashboard CN 0.1.0` section summarizing collection, localization, X/TikHub, manual AI, privacy, and desktop-only scope.

- [ ] **Step 5: Run public scan**

Run: `npm run check:public`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add docs/UPSTREAM.md SECURITY.md .github/ISSUE_TEMPLATE CHANGELOG.md
git commit -m "docs: prepare public repository governance"
```

## Task 7: Create a local release-readiness report without publishing

**Files:**

- Create: `docs/release/0.1.0-readiness.md`

- [ ] **Step 1: Verify clean source and build state**

Run: `git status --short && npm run check && npm run release:stage && npm run release:check`

Expected: clean source tree before build; all checks pass; only ignored `release/` artifacts appear afterward.

- [ ] **Step 2: Verify release metadata**

Run: `node scripts/check-version-consistency.mjs 0.1.0 && node -e 'const m=require("./manifest.json"); if(m.id!=="rss-dashboard-cn"||m.name!=="RSS Dashboard CN"||m.isDesktopOnly!==true) process.exit(1)'`

Expected: exit code 0.

- [ ] **Step 3: Verify repository history and attribution**

Run: `git log --oneline --decorate -20 && rg -n 'amatya-aditya/obsidian-rss-dashboard|Aditya Amatya|MIT' README.md NOTICE.md LICENSE docs/UPSTREAM.md`

Expected: implementation commits are reviewable and attribution appears in all required locations.

- [ ] **Step 4: Write the readiness report**

Record exact command results, smoke-test status, live TikHub/provider checks completed or missing, OS coverage, known limitations, and these authorization-gated next actions:

```text
create/select public GitHub repository
add origin
push main and tags
publish GitHub release
optionally submit to obsidianmd/obsidian-releases
```

No unchecked external action may be described as complete.

- [ ] **Step 5: Commit**

```bash
git add docs/release/0.1.0-readiness.md
git commit -m "docs: record 0.1.0 release readiness"
```

## Optional Task 8: Submit to the Obsidian community directory after separate approval

**Files:**

- No changes in this repository unless review requests fixes.
- External repository after authorization: `obsidianmd/obsidian-releases`

- [ ] **Step 1: Stop and obtain explicit authorization**

The user must approve public repository creation/push, a public GitHub release, and community-directory submission separately. Do not infer this from approval of the design or implementation plans.

- [ ] **Step 2: Verify current Obsidian policies at submission time**

Re-read the current Developer policies, Plugin guidelines, and submission template because requirements can change. The current expected checks include exact manifest/release name parity, required individual assets, README usage instructions, license, and upstream attribution.

- [ ] **Step 3: Publish an exact-version GitHub release only after approval**

Confirm release `0.1.0` contains individual `main.js`, `manifest.json`, and `styles.css` and that the manifest matches the repository.

- [ ] **Step 4: Prepare the directory entry**

Construct the entry by copying `id`, `name`, `author`, and `description` byte-for-byte from the released `manifest.json`; set `repo` from the public GitHub repository that the user explicitly approved. Validate that the entry and released manifest match before opening the external PR. Do not invent an author identity or repository owner in advance.

- [ ] **Step 5: Submit and respond to review without weakening privacy boundaries**

Any reviewer-requested code change returns through focused tests, full `npm run check`, a new exact-version release, and manifest/release parity verification.

## Acceptance Checklist

- [ ] Manual install/update/uninstall instructions work from individual release files.
- [ ] README truthfully explains daily-on-open refresh, source limits, TikHub costs, manual AI, privacy, and desktop-only scope.
- [ ] Upstream MIT license and attribution are preserved.
- [ ] Exports/diagnostics cannot leak keys, private source details, or collection bodies.
- [ ] Public scan, version check, full tests, localization audit, lint, build, and artifact validation pass.
- [ ] A disposable-vault smoke test is documented without personal data.
- [ ] GitHub release assets are reproducible from a clean checkout.
- [ ] No repository, push, release, or community submission occurs without a new explicit authorization.
