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
