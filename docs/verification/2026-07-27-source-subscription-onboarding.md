# Source subscription onboarding verification

Date: 2026-07-28 (Asia/Shanghai)

Plugin: RSS Dashboard CN 0.1.0

Host: Obsidian 1.12.7 on macOS

## Automated gates

- `npm run check`: PASS.
  - Vitest: 274 files passed, 1 skipped; 3342 tests passed, 1 skipped.
  - i18n audit, public-repository scan, workflow policy, version consistency, CSS scope, platform compatibility, `!important` audit, commit-message policy, ESLint, TypeScript, and production build all passed.
- `npm run release:stage && npm run release:check`: PASS.
  - The staged release contained only `main.js`, `manifest.json`, and `styles.css`.
  - The release checker reported `release-artifacts-valid`.

## Safe installation

- The existing legacy plugin directory was identified from its manifest and normalized once to the manifest id while Obsidian was closed. No conflicting canonical directory existed.
- `npm run install:local -- --target <verified-plugin-directory>` completed with `install-local-success` and created one timestamped sibling backup inside the plugin directory area.
- The installed hashes for all three program artifacts matched the staged release.
- The `data.json` hash and size were unchanged across installation.
- The twelve pre-existing collection/history/state files had the same aggregate hash across installation.
- All 1570 pre-existing Markdown files had the same aggregate hash across installation.
- The external secret status was configured before installation and remained configured after installation and after a later Obsidian restart. No key value or secret-store location was read into this record.

## Live source matrix

| Check | Result | Evidence |
| --- | --- | --- |
| One add modal with three source cards | PASS | The dashboard entry opened RSS / website, YouTube, and X account cards in one modal. |
| Direct RSS | PASS | A local disposable feed confirmed its title, canonical URL, latest item, and publication time. |
| Website with one feed | PASS | The website resolved directly to its single declared RSS feed. |
| Website with two feeds | PASS | The modal displayed two radio-button candidates and required a choice. |
| Website with no feed | PASS | A separate-origin fixture returned a direct connection error and exposed no subscribe action. |
| Verification invalidation | PASS | Editing a successfully verified input removed the success card and confirmation action until re-verification. |
| YouTube public channel | PASS | A public test channel resolved as YouTube to a channel URL, displayed its latest video, and was not classified as Mastodon. |
| Malformed YouTube URL | PASS | A watch-page URL was rejected with channel-input guidance and no subscribe action. |
| Default and bounded history choices | PASS | The default was 7 days; now, 3, 7, 14, 30, and 90 days, custom date, and all-available choices were present. RSS and YouTube displayed bounded-history wording. |
| Custom date | PARTIAL | Selecting custom date exposed a required date control and disabled confirmation while empty. The macOS accessibility bridge could not assign the segmented HTML date value; valid/invalid custom-date behavior remains covered by the passing unit suite. |
| TikHub public X profile | PENDING DIAGNOSTIC RETEST | The corrected onboarding build was safely installed and one authorized `@OpenAI` verification was attempted. The local paid-request ledger recorded exactly one attempt, but the modal returned the generic `provider-failure` message and TikHub's refreshed usage log did not yet show a request for the local date. Both documented TikHub origins were reachable over HTTPS, and the configured origin, key status, timeout, and caps were valid. The installed resolver collapsed network failure, malformed provider envelopes, and unsupported profile payloads into the same generic result, so this run cannot honestly identify the failing boundary. A new candidate now exposes only three fixed, non-secret diagnostic classes for those cases; its focused tests, full gate, and independent review pass. It still requires safe installation and a separately authorized live retry. |
| X all-history second confirmation | PENDING LIVE | The passing unit suite covers the cap wording, required second confirmation, and cancel-without-post-request behavior. Live confirmation remains pending because profile verification did not succeed; no source was saved and no history request was sent. |
| Unified management | PASS | The manager showed source type, normal/paused status, last success, first-import progress, refresh, pause, resume, edit, address-change, and delete actions. |
| Default delete wording | PASS | Delete defaulted to preserving collected history; permanent history deletion was an unchecked opt-in. |

## Disposable-source retention check

1. Added one local RSS fixture with the default 7-day initial import.
2. The first import collected two items.
3. Ran two manual source refreshes. The dashboard still showed one source and two items.
4. The collection JSONL remained readable with two rows and two unique stable IDs.
5. Paused and resumed the source in the unified manager; refresh was disabled while paused and normal status returned after resume.
6. Removed the source using the default history-preserving action.
7. The saved subscription count returned to zero. The collection JSONL still contained two readable, uniquely identified rows, and the daily Markdown aggregate hash was unchanged by removal.
8. Restarted Obsidian. The plugin loaded normally and the configured external API connection status remained available.

The disposable subscription configuration was removed. Its two retained collection records and daily-index Markdown were intentionally left in place to verify the documented preservation contract. No purge action was used. Both local HTTP fixture servers were stopped after the run.

## Release decision

Automated gates, release staging, the previous safe installation, RSS/website/YouTube onboarding, manager lifecycle, deduplication, and default history preservation pass. X input normalization and the new safe diagnostic split are covered by regression tests and independent review. Empty-source policy is also enforced at both UI and service boundaries: only a structurally valid empty RSS may proceed after explicit warning acceptance; an empty YouTube source is rejected even if a caller forges the acceptance flag, without settings or collection persistence. Final release acceptance still requires installing the diagnostic candidate while Obsidian is closed, obtaining explicit authorization for one additional public TikHub profile verification, and—only after successful profile verification—cancelling the X all-history confirmation without saving a source. The Mac locked again before the diagnostic candidate could be installed, so this record does not claim TikHub or X all-history live acceptance and does not authorize merge yet.
