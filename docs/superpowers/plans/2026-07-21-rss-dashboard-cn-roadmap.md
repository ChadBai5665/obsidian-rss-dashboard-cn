# RSS Dashboard CN Implementation Roadmap

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute the approved RSS Dashboard CN design through five independently testable implementation plans and reach a verified self-installable release without publishing externally.

**Architecture:** Build in dependency order: local collection first, localization second, TikHub/X and the shared secret store third, optional AI fourth, and release hardening last. Each phase must finish its acceptance checklist and leave a clean git state before the next phase starts.

**Tech Stack:** TypeScript, Obsidian Plugin API, Vitest/jsdom, Node.js 20.19+, esbuild, Markdown/JSONL local storage, TikHub Twitter Web API, OpenAI-compatible and Anthropic-compatible model APIs, GitHub Actions.

## Global Constraints

- The approved specification at `docs/superpowers/specs/2026-07-21-rss-dashboard-cn-design.md` remains the product truth source.
- Implement plans in the order listed below; later plans may modify files created by earlier plans.
- Use test-driven steps and the commit boundaries written in each detailed plan.
- Do not add automatic AI analysis, external background daemons, X write operations, media downloads, or destructive note replacement.
- Do not publish a repository, push a branch, create a release, or submit to the Obsidian directory without separate user authorization.
- If a live TikHub or AI key is unavailable, continue all offline implementation/tests but mark the associated live smoke gate incomplete rather than claiming release readiness.
- Before phase handoff run `git status --short`; resolve only changes created by the current implementation work and preserve unrelated user changes.

---

## Dependency Order

| Phase | Detailed plan | Depends on | Exit gate |
|---|---|---|---|
| 1 | `2026-07-21-collection-foundation-implementation.md` | Approved specification | Stable JSONL/Markdown collection, daily-on-open refresh, collision-safe save |
| 2 | `2026-07-21-chinese-localization-implementation.md` | Phase 1 settings/dashboard surfaces | Chinese default, English fallback, literal audit |
| 3 | `2026-07-21-tikhub-x-sources-implementation.md` | Phases 1–2 | External secret store, bounded account/topic X collection, sanitized fixtures |
| 4 | `2026-07-21-on-demand-ai-implementation.md` | Phases 1–3, especially shared secret store | Four manual AI actions, multi-provider connections, separate provenance artifacts |
| 5 | `2026-07-21-public-release-implementation.md` | Phases 1–4 | Clean self-install, privacy/version/artifact gates, local release-readiness report |

## Task 1: Establish an execution baseline

**Files:**

- Read: `docs/superpowers/specs/2026-07-21-rss-dashboard-cn-design.md`
- Read: all five detailed plans in `docs/superpowers/plans/`
- Modify: none

- [ ] **Step 1: Verify repository and branch**

Run: `git status --short --branch && git remote -v`

Expected: current branch is an implementation branch derived from `codex/design-spec`; upstream remote is named `upstream`; no unexplained local changes exist.

- [ ] **Step 2: Verify runtime baseline**

Run: `node --version && npm --version && npm ci`

Expected: Node satisfies `>=20.19.0`; dependency installation exits 0.

- [ ] **Step 3: Run the unmodified upstream baseline**

Run: `npm run test:unit && npm run lint && npm run build`

Expected: all commands pass before feature work. If an upstream baseline failure exists, record it separately and resolve/approve its treatment before attributing later failures to new work.

## Task 2: Execute the collection foundation plan

**Files:**

- Follow: `docs/superpowers/plans/2026-07-21-collection-foundation-implementation.md`

- [ ] **Step 1: Complete Tasks 1–10 in the detailed plan in order**

Use each Red-Green-Refactor cycle and commit boundary exactly as written.

- [ ] **Step 2: Verify the phase acceptance checklist**

Run: `npm run test:unit && npm run lint && npm run build`

Expected: stable collection schema, data-before-state writes, once-per-local-date startup refresh, source-isolated manual refresh, and idempotent Markdown save all pass.

- [ ] **Step 3: Verify phase handoff state**

Run: `git status --short`

Expected: clean.

## Task 3: Execute the Chinese localization plan

**Files:**

- Follow: `docs/superpowers/plans/2026-07-21-chinese-localization-implementation.md`

- [ ] **Step 1: Complete Tasks 1–7 in the detailed plan in order**

Localize by stable translation keys and retain source-authored content unchanged.

- [ ] **Step 2: Verify the phase acceptance checklist**

Run: `npm run audit:i18n && npm run test:unit && npm run lint && npm run build`

Expected: Chinese default, English selection, catalog parity, and no unreviewed UI literals.

- [ ] **Step 3: Verify phase handoff state**

Run: `git status --short`

Expected: clean.

## Task 4: Execute the TikHub and X sources plan

**Files:**

- Follow: `docs/superpowers/plans/2026-07-21-tikhub-x-sources-implementation.md`

- [ ] **Step 1: Complete offline Tasks 1–3**

Finish secret storage, source contracts, request budgets, and mocked-client tests before any paid API call.

- [ ] **Step 2: Complete Task 4 fixture capture with an explicit key when available**

Make no more than the three calls specified in the detailed plan and sanitize before commit. If the key is unavailable, mark only the live-fixture gate incomplete.

- [ ] **Step 3: Complete Tasks 5–9**

Implement account originals/reply/repost controls, topic Latest/Top separation, settings, daily integration, and privacy/cost verification.

- [ ] **Step 4: Verify the phase acceptance checklist**

Run: `npm run audit:i18n && npm run test:unit && npm run lint && npm run build`

Expected: optional TikHub failure never blocks RSS; caps and request estimates are enforced; no secret appears in tracked files.

- [ ] **Step 5: Verify phase handoff state**

Run: `git status --short`

Expected: clean.

## Task 5: Execute the on-demand AI plan

**Files:**

- Follow: `docs/superpowers/plans/2026-07-21-on-demand-ai-implementation.md`

- [ ] **Step 1: Complete Tasks 1–8 in the detailed plan in order**

Reuse the external secret store, require explicit confirmation, and persist only successful standalone results.

- [ ] **Step 2: Verify the phase acceptance checklist**

Run: `npm run audit:i18n && npm run test:unit && npm run lint && npm run build`

Expected: collection works with no AI connection; each operation makes at most one selected-provider request; privacy-boundary test proves only selected content is sent.

- [ ] **Step 3: Verify phase handoff state**

Run: `git status --short`

Expected: clean.

## Task 6: Execute the public-release hardening plan

**Files:**

- Follow: `docs/superpowers/plans/2026-07-21-public-release-implementation.md`

- [ ] **Step 1: Complete required Tasks 1–7**

Prepare documentation, safe exports/diagnostics, release validators, CI, disposable-vault smoke test, upstream governance, and local readiness report.

- [ ] **Step 2: Do not execute Optional Task 8 without new approval**

The local project can be complete and self-installable while repository publication and Obsidian-directory submission remain unexecuted.

- [ ] **Step 3: Run final release gate**

Run: `npm run check && npm run release:stage && npm run release:check && git status --short`

Expected: all checks pass; tracked source tree is clean; ignored release directory contains only the three permitted plugin artifacts.

## Specification Coverage Matrix

| Approved requirement | Owning plan/task |
|---|---|
| RSS/Atom/JSON/Podcast and website behavior | Foundation Tasks 2, 6–8 |
| YouTube channel RSS, metadata-only AI basis, no downloads | Foundation Tasks 2, 7–8; AI Task 3 |
| Once per local calendar day on Obsidian open | Foundation Task 5 |
| Manual refresh all/failed/single and source isolation | Foundation Task 6 |
| Stable IDs, daily JSONL, rediscovery, neutral daily Markdown | Foundation Tasks 2–4 |
| Save once, never overwrite, same-title suffix | Foundation Task 8 |
| Chinese default plus English | Localization Tasks 1–7 |
| X watched accounts | TikHub Tasks 2, 5, 8 |
| X topic Latest/platform Top, bilingual terms, windows | TikHub Tasks 6–8 |
| TikHub costs/caps and external keys | TikHub Tasks 1, 3, 7, 9 |
| Kimi/DeepSeek/Qwen/GLM/OpenAI/Claude/relay connections | AI Tasks 1–2, 6 |
| Manual summary/translation/core points/deep analysis | AI Tasks 4, 7 |
| Selected-content-only model transmission | AI Tasks 3, 8 |
| Separate provenance artifacts and explicit note insertion | AI Tasks 5, 7 |
| MIT/upstream attribution, manual install, public readiness | Release Tasks 1, 3–7 |
| No external publication without approval | Release Global Constraints and Optional Task 8 |

## Final Acceptance Checklist

- [ ] Every detailed-plan acceptance checklist is complete or explicitly identifies a live-key/OS coverage gap.
- [ ] No product requirement is implemented by automatic model judgment.
- [ ] No collection or user note is destroyed or overwritten during refresh/save/re-render.
- [ ] The vault contains readable Markdown/JSONL outputs usable by Codex or other local tools without the plugin's AI features.
- [ ] Self-install release assets are verified in a disposable vault.
- [ ] Public publication remains a separate user-authorized action.
