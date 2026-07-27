# Task 8 Fix Round 3 Report

Date: 2026-07-28
Base HEAD: `cd09e4b`

## Scope

Fixed the X initial-import deletion race only. No Task 9 work, plan or ledger edits, live network access, secrets, or user-data changes were made.

## Root cause

`refreshFeedPipeline` registered the X import controller before `recordAttempt`, but after that awaited write it resolved the source through a helper that always fell back to the caller's stale feed snapshot. A source deleted during the await therefore still reached the paid provider. `SubscriptionService.remove` also entered the lifecycle mutation queue without synchronously aborting the already-active controller.

## Changes

- Default and purge removal now synchronously abort the active initial-import controller before waiting on the lifecycle mutation queue.
- Refresh startup records whether the input matched a currently persisted source.
- After the ledger gate, a source that was persisted and has disappeared terminates without provider or collection work.
- An active X initial-import snapshot that was never persisted also terminates before provider work.
- Explicit legacy/external RSS snapshots remain refreshable.
- Added regression coverage for default deletion during the ledger gate, purge deletion before provider start, queued-removal abort ordering, stale persisted X snapshots, unpersisted active X snapshots, and legacy RSS compatibility.

## TDD evidence

- RED: both deletion-race tests observed one paid-provider call on `cd09e4b`.
- RED: default and purge queued-removal tests observed zero abort calls.
- GREEN: the focused refresh, subscription, and plugin-lifecycle regression set passed `236/236` tests.
- Mutation checks: removing either the disappeared-source branch or the unpersisted-X branch made its dedicated regression test fail while the legacy RSS compatibility test continued to pass.

## Verification

- `CI=1 npm run test:unit`: 271 files passed, 1 skipped; 3192 tests passed, 1 skipped.
- `npm run lint`: exit 0, zero warnings.
- `npx tsc --noEmit --skipLibCheck`: exit 0.
- `git diff --check`: exit 0.
