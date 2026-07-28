# Task 4 report — safely forward AI text deltas

## Scope

- Added the optional `onTextDelta` callback to both `AiOperationRunInput` and
  `AiPreparedOperationRunInput`.
- Snapshots only an own data property containing a function. Accessors,
  inherited values, explicit `undefined`, and other callback shapes fail as
  `invalid-request` before provider creation or content selection.
- Creates the service-owned forwarding callback only after content selection
  and prompt construction. It forwards ordered non-empty chunks, preserves
  repeated identical chunks, enforces the provider output character ceiling,
  and isolates caller callback exceptions.
- Stops forwarding on abort, provider completion, or any forwarding failure.
  Provider-retained callbacks are inert after success or failure.
- When the provider emits one or more deltas, their exact concatenation must
  equal the normalized final `result.text`; otherwise the operation fails with
  the static `malformed-response` code. The invariant is enforced even when the
  caller did not supply a callback.
- Preserved the existing selection, prompt, connection/key, provider error,
  abort, and no-retry boundaries. No persistence or saving behavior was added.

## TDD evidence

- RED: `npm run test:unit -- test_files/unit/ai/ai-operation-service.test.ts`
  ran 34 tests and failed 12 against the prior service. The failures covered
  callback forwarding/snapshotting, callback-shape validation, abort/terminal
  handling, chunk bounds, final-text mismatch, and prepared-run forwarding.
- GREEN: the same focused operation suite passed 34 of 34 tests.
- The expanded operation/privacy slice passed 121 of 121 tests.
- The SSE/transport/provider compatibility slice passed 126 of 126 tests.

The new tests cover preparation before the first delta, ordered and repeated
chunks exactly once, no-delta JSON-compatible completion, callback mutation and
exception isolation, accessor/inherited/invalid callback rejection, abort
before/during/after generation, provider-retained callbacks after terminal
results, empty/non-string/single-oversized/cumulatively oversized deltas,
delta/final mismatch and error secrecy, operation calls without a caller
callback, provider error-code preservation, and prepared-run compatibility.

## Verification

- `npm run lint` — PASS
- `npx tsc --noEmit --skipLibCheck` — PASS
- operation/privacy focused slice — PASS (121 tests)
- SSE/transport/provider compatibility slice — PASS (126 tests)
- guarded `npm run check` — PASS:
  - unit suite: 285 files passed, 1 skipped; 3,798 tests passed, 1 skipped
  - i18n audit, public repository scan, workflow policy, version consistency,
    CSS scope, platform compatibility, CSS `!important`, lint, and build passed
- `git diff --check` — PASS

The full check loaded
`.superpowers/sdd/2026-07-28-inline-streaming-ai-implementation/block-external-network.cjs`,
which blocks every non-loopback socket. Tests use injected providers and
synthetic fixtures only; no real provider, paid API, user API key, user content,
or public network endpoint was used.

The public repository scan produced no new finding, so no allowlist or scanner
change was required.

## FixRound1 — consume asynchronous callback failures

Review found that synchronous caller callback exceptions were isolated, but a
callback returning a rejected Promise could still produce an unhandled
rejection. Returned custom thenables were ignored rather than safely consumed.

- RED: the expanded operation suite ran 38 tests and failed 1. The resolving
  custom thenable was never consumed (`then` call count 0 instead of 1); the
  same regression test also exercised rejected Promises, rejecting thenables,
  and a throwing `then` getter.
- GREEN: the service still keeps the public callback type `void`, invokes it
  through `Reflect.apply`, captures the runtime result as `unknown`, and
  attaches a rejection-only sink through native Promise assimilation.
- The callback result is never awaited. A permanently pending result neither
  delays provider completion nor reorders later deltas.
- A custom resolving or rejecting `then` is called exactly once. A throwing
  `then` getter becomes a consumed rejection, synchronous callback throws remain
  isolated, and no callback failure or synthetic credential/provider canary
  reaches `unhandledRejection`.

### FixRound1 verification

- Focused operation suite — PASS (38 tests).
- Guarded operation/privacy/SSE/transport/provider slice — PASS: 7 files,
  249 tests.
- Guarded full `npm run check` — PASS: 285 files passed, 1 skipped; 3,800 tests
  passed, 1 skipped.
- `npm run lint` and `npx tsc --noEmit --skipLibCheck` — PASS.
- Build, i18n audit, public repository scan, workflow policy, version
  consistency, CSS scope, platform compatibility, and CSS `!important` checks
  — PASS.
- `git diff --check` — PASS.

The guarded runs blocked every non-loopback socket. No real provider, paid API,
user credential/content, or public endpoint was used. The synthetic
`external-secret raw-provider-error` regression canary produced no new public
scan finding, so no allowlist or scanner change was needed.
