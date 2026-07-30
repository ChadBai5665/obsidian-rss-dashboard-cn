# Final Review Fix Report — Durable Free Continuation and Failure Billing Evidence

## Conclusion

The single authorized final-review fix wave is complete on top of reviewed
baseline `9365c0ecafc6109be9b8ad72b4d379b8fc7fa229`. All three findings were
fixed together:

1. a durable TikHub content job is now discovered locally by exact
   `{ itemId, videoId }` identity and continued through a dedicated free-poll
   operation, so the UI's “继续查询” action cannot relist captions or create a
   new paid request;
2. every panel failure snapshot preserves confirmed `0 | 1 | 2` request usage
   and the independent sanitized possibly-sent flag, including generic errors
   and localization rerenders;
3. abort normalization and shared-work cancellation preserve an already
   attempted paid transport without inventing a confirmed charge.

No live Obsidian, vault, TikHub endpoint, API key, real paid ledger, AI model,
installation, push, or merge was used. All behavior was exercised with fake
clients, repositories, settings, DOM, and content storage.

## Root causes and architecture

### Durable continuation

The prior content job key included the selected language, while the panel lost
that in-memory choice after `tikhub-processing`. Its Continue button called the
ordinary fetch path, whose first TikHub operation was a paid track-list request.

The repository now exposes one locked, validated local lookup for a unique
`stage: "content"` record matching `{ itemId, videoId }`. Corrupt storage,
malformed records, multiple matches, disabled/mismatched settings, and identity
mismatches fail closed. No language is guessed. Normal paid listing first checks
for this durable content job and returns `tikhub-processing` before a key read or
client construction.

The provider's dedicated continuation operation:

- locates the exact durable content job locally;
- verifies current settings and connection identity;
- performs only the existing free result poll;
- returns a strict operation envelope with zero paid-request evidence and the
  existing opaque CAS cleanup token.

The service gives continuation a separate deduplicated work identity. It
validates the provider result, writes through the existing content transaction
and metadata repair path, and invokes `onPersisted` with the exact CAS token only
after persistence succeeds. The panel calls only this operation for Continue;
there is no ordinary-fetch fallback.

### Failure evidence

The panel now retains two independent values in both TikHub-specific and generic
failure snapshots:

- confirmed usage (`0 | 1 | 2`), rendered as `$0.008` or `$0.016` only when
  confirmed;
- `tikhubPaidRequestPossiblySent`, rendered as the sanitized warning regardless
  of error code or confirmed usage.

Same-session free continuation retains the already shown confirmed usage. A
recreated panel begins at zero because historical per-operation usage is not in
durable job state. Cache reopen remains usage-free.

### Abort ordering

Provider failure normalization now derives `TikHubClientError` transport-attempt
evidence before applying the sanitized `aborted` code. Service provider-stage
catches consume that evidence before their local abort handling. When the last
subscriber aborts shared work, it waits for the abort-aware provider operation
to settle so an attempted transport flag is not replaced by a zero-evidence
local abort. Other subscribers remain isolated and the underlying operation is
not cancelled while still shared.

## TDD evidence

Production changes followed focused RED then GREEN tests.

| Boundary | RED evidence before implementation | GREEN coverage |
| --- | --- | --- |
| Repository | 2 expected failures: `findPendingContentJob` absent | unique exact match and multiple-match fail-closed |
| Provider | 7 expected failures: no passive/continuation APIs, ordinary listing still paid, abort evidence erased | local detection/blocking, exact free continuation, invalid-job fail-closed, attempted-abort evidence |
| Service | 4 expected failures: no continuation contract/dedup and abort ambiguity erased | passive probe, persistence/CAS cleanup, repeated-click dedup, error evidence |
| Panel | 8 expected failures: passive state idle and confirmed/ambiguous evidence missing | continuation-only action, 1/2 usage, generic/TikHub failures, localization |

Final focused command covered repository, provider, types, service, panel,
cross-layer integration, and main wiring:

- **7/7 test files passed**;
- **383/383 tests passed**.

The adjacent YouTube/TikHub/security/public run passed **32/32 files** and
**1164/1164 tests**. The final full gate superseded it and remained green after
all test additions.

## Cross-layer and passive-path proof

The new real-provider integration uses the actual panel, service, and TikHub
provider with fake jobs/client/content storage.

- Paid track listing occurs once.
- Paid content start occurs once and remains processing.
- The panel displays 2 requests / `$0.016`.
- Continue invokes the free result endpoint and never relists; the fake paid
  transport count remains exactly 2.
- Completed content is persisted, then the exact durable job is CAS-removed.
- Destroying the panel/service and recreating them over the same job repository
  renders Continue through a passive local check with **0 key reads, 0 new
  transports, and 0 new paid attempts**.
- Explicit continuation after recreation free-polls and completes while the paid
  count remains 2. The recreated UI does not fabricate the historical `$0.016`.
- Repeated continuation requests coalesce into the same shared free poll and do
  not create a modal or paid request.

Missing, malformed, connection-mismatched, ambiguous/multiple, and expired
content jobs are covered by provider/repository regressions and fail closed
without a paid/list call. A genuinely fresh request retains the established
cache → InnerTube → TikHub → yt-dlp provider order.

## Paid-evidence truth table

| Outcome | Confirmed usage | Possibly-sent warning | UI / continuation behavior |
| --- | ---: | --- | --- |
| Failure before paid transport | 0 | no | no charge inferred |
| Client error with `paidRequestAttempted=false` | 0 | no | remains free |
| Client error with non-writable `paidRequestAttempted=true` | 0 | yes | sanitized warning, including aborted/generic errors |
| Valid paid track-list response | +1 | no | exact confirmed count |
| Valid paid content response | +1 | no | exact confirmed count |
| Processing after first paid response | 1 / `$0.008` | independent | Continue offered only for a durable content job |
| Processing after list plus content response | 2 / `$0.016` | independent | same-session Continue preserves display |
| Free continuation poll | +0 | no new ambiguity | no relist; same-session history retained |
| Recreated panel over pending job | 0 displayed | no | no historical charge fabricated |
| Cache reopen | 0 displayed | no | cache-only |

A successful paid response still increments confirmed usage exactly once; an
ambiguous attempt never enters confirmed usage.

## Backward compatibility and data safety

- `youtube-caption-jobs.json` remains `schemaVersion: 1`; no schema field or
  serialized shape changed, so no migration or bulk rewrite is needed.
- Existing cache schema readers/writers and metadata paths are unchanged.
- Provider continuation hooks and panel service hooks are optional, preserving
  source compatibility for existing providers and test/runtime adapters.
- Job state continues to contain only the existing minimal safe identity and
  polling fields. It adds no API key, credential URL, request ID, provider
  payload, transcript text, or error text.
- Public-scan policy was not changed. Seven existing exact allowlist entries
  received line-only maintenance after staged test/source insertions moved their
  unchanged synthetic fixtures; paths, rules, fingerprints, and reasons remain
  unchanged, with no wildcard or rule expansion.
- Main runtime construction and fresh-provider ordering were not changed.
- Release staging regenerated only the approved ignored release artifacts;
  `main.js`, `manifest.json`, and `styles.css` have no tracked diff.

## Final verification

All commands ran from the implementation worktree on the final production and
test tree:

- focused Vitest: **7 files passed, 383 tests passed**;
- adjacent Vitest: **32 files passed, 1164 tests passed**;
- `npm run check`: exit 0;
  - unit: **294 files passed, 1 skipped (295 total)**;
  - tests: **4211 passed, 1 skipped (4212 total)**;
  - i18n audit, public scan, workflow policy, version consistency, compliance,
    ESLint, TypeScript, and production build all passed;
  - CSS scope: 39 files; platform compatibility: 248 files; `!important`: 39
    files;
- `npm run release:stage`: exit 0,
  `release-staged:main.js,manifest.json,styles.css`;
- `npm run release:check`: exit 0, `release-artifacts-valid`;
- `git diff --check`: exit 0.

## Scope review and residual concern

The change is limited to the repository/provider/type/service/panel continuation
and evidence contracts, focused regressions, seven exact public-scan line-number
refreshes, and this report. No scan rule/wildcard, settings schema, job schema,
cache schema, provider ordering, startup collection path, or live installation
was changed.

No known residual correctness or safety concern remains within the authorized
scope. As designed, the last-subscriber abort path relies on transcript
providers honoring the supplied abort signal; all current providers are covered
by the full suite and the TikHub regression proves the evidence-preserving race.
