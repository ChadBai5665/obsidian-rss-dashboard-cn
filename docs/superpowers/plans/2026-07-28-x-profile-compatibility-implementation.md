# X Profile Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one explicitly requested TikHub X-account verification accept safe current profile shapes, display the resolved identity for confirmation, and provide value-free diagnostics when an unknown shape is rejected.

**Architecture:** Keep the existing one-request resolver and opaque verification proof. Relax only the defensive profile projection boundary: normalize legacy/core candidates, merge equivalent identities, reject real conflicts, and return a small structural diagnostic that contains types and counts rather than provider values. The modal remains a consumer of stable error codes and never receives a raw TikHub response.

**Tech Stack:** TypeScript 5.9, Obsidian 1.8 API, existing TikHub client and external secret store, Vitest 4.

## Global Constraints

- Every click on “识别并检验” may issue at most one paid TikHub request; never probe, retry, or repeat automatically.
- Do not run a live TikHub request during automated tests or implementation unless the user gives a new explicit one-request authorization.
- Preserve the existing official `screen_name` endpoint, request budget, external API-key location, and proof reservation/commit behavior.
- Required identity fields remain `restId`, normalized handle, and non-empty display name.
- Avatar, description, and verified status are optional; missing, empty-string, or `null` optional values are not parse failures.
- Multiple wrappers for the same stable identity are deduplicated; conflicting identities fail closed.
- Diagnostics may contain field-presence booleans, primitive/container type names, candidate counts, and conflict categories only. They must not contain field values, URLs, handles, names, descriptions, API keys, headers, request IDs, or raw payload fragments.
- Do not persist raw TikHub profile payloads or diagnostics in user settings, collection JSONL, or Markdown.
- Every task follows red-green-refactor, runs focused tests, and commits independently.

---

## File Map

### New production file

- `src/sources/tikhub/x-profile-shape-diagnostic.ts` — bounded, value-free description of rejected payload structure.

### Existing production files to modify

- `src/sources/tikhub/x-profile.ts` — nullable optional fields, legacy/core reconciliation, and stable identity deduplication.
- `src/sources/tikhub/x-profile-resolver.ts` — attach a safe diagnostic category to local unsupported-shape errors without exposing payloads.
- `src/services/source-verification/verification-state.ts` — carry an optional safe diagnostic code for the one profile-shape failure.
- `src/modals/source-onboarding/add-source-modal.ts` — render a concise local troubleshooting detail while keeping save disabled.
- `src/i18n/zh-cn.ts`, `src/i18n/en.ts` — localized conflict/shape troubleshooting copy.

### Focused tests to modify or create

- `test_files/unit/sources/tikhub/x-profile.test.ts`
- `test_files/unit/sources/tikhub/x-profile-shape-diagnostic.test.ts`
- `test_files/unit/sources/tikhub/x-profile-resolver.test.ts`
- `test_files/unit/services/source-verification/verification-state.test.ts`
- `test_files/unit/modals/add-source-modal.test.ts`

---

### Task 1: Accept nullable optional profile fields

**Files:**

- Modify: `src/sources/tikhub/x-profile.ts`
- Modify: `test_files/unit/sources/tikhub/x-profile.test.ts`

**Interfaces:**

- Keeps: `parseXProfile(payload: unknown): XProfile`.
- Changes optional readers so `undefined`, `null`, and `""` normalize to absent for avatar, description, verification containers, and optional booleans.

- [ ] **Step 1: Add failing tests for legal missing values**

Add table-driven fixtures for legacy and core profiles where `description`, `profile_image_url_https`, `profile_bio`, `avatar`, `verification`, and nested optional values are absent, `null`, or empty. Assert all produce the same minimal profile:

```ts
expect(parseXProfile(payload)).toEqual({
  restId: "123",
  handle: "naval",
  displayName: "Naval",
  verified: false,
});
```

Keep rejection tests for wrong non-null types, unsafe controls, non-HTTPS avatar URLs, missing required identity, oversized values, accessors, exotic prototypes, and traversal limits.

- [ ] **Step 2: Run the parser test and verify red**

Run: `npm run test:unit -- test_files/unit/sources/tikhub/x-profile.test.ts`

Expected: nullable optional fixtures fail with `malformed-profile`.

- [ ] **Step 3: Implement narrow nullable handling**

Change only optional accessors. `optionalText`, `optionalHttpsUrl`, `nestedPropertyValue`, and optional verification readers treat `null` like an omitted value. Do not weaken required `rest_id`, handle, or name validation.

- [ ] **Step 4: Re-run focused tests**

Run: `npm run test:unit -- test_files/unit/sources/tikhub/x-profile.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sources/tikhub/x-profile.ts test_files/unit/sources/tikhub/x-profile.test.ts
git commit -m "fix: accept optional X profile fields"
```

### Task 2: Reconcile equivalent legacy and core candidates

**Files:**

- Modify: `src/sources/tikhub/x-profile.ts`
- Modify: `test_files/unit/sources/tikhub/x-profile.test.ts`

**Interfaces:**

- Add internal `NormalizedProfileCandidate` and `profileIdentity(candidate): string`.
- Reconciliation key is `${restId}\0${normalizeXHandle(handle)}`.
- Equivalent candidates merge optional fields only when present values agree; conflicting required or non-empty optional values fail closed.

- [ ] **Step 1: Write failing reconciliation tests**

Cover:

- one object containing matching `legacy` and `core` identity pairs;
- the same account repeated under `data`, `result`, and nested wrappers as distinct object instances;
- one wrapper missing avatar while another provides it;
- handle case differences that normalize to the same X handle;
- conflicting rest IDs, handles, display names, avatars, descriptions, or verified states.

Assert equivalent candidates return exactly one profile and every real conflict throws `malformed-profile`.

- [ ] **Step 2: Run the parser test and verify red**

Run: `npm run test:unit -- test_files/unit/sources/tikhub/x-profile.test.ts`

Expected: matching legacy/core and duplicate wrappers currently fail because the parser counts object occurrences.

- [ ] **Step 3: Split candidate extraction from reconciliation**

Have `profileCandidate` emit zero, one, or two normalized candidates. Collect candidates during the bounded walk, group by stable identity, and merge within a group. Return only when exactly one non-conflicting identity remains and no authoritative not-found record exists.

- [ ] **Step 4: Preserve fail-closed boundaries**

Keep `MAX_WALK_DEPTH`, `MAX_WALK_NODES`, array/property limits, data-property-only reads, control-character checks, URL validation, and not-found precedence. A payload containing both a usable profile and a not-found marker remains malformed rather than guessed.

- [ ] **Step 5: Re-run focused tests**

Run: `npm run test:unit -- test_files/unit/sources/tikhub/x-profile.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/sources/tikhub/x-profile.ts test_files/unit/sources/tikhub/x-profile.test.ts
git commit -m "fix: reconcile equivalent X profile shapes"
```

### Task 3: Produce a value-free unsupported-shape diagnostic

**Files:**

- Create: `src/sources/tikhub/x-profile-shape-diagnostic.ts`
- Create: `test_files/unit/sources/tikhub/x-profile-shape-diagnostic.test.ts`
- Modify: `src/sources/tikhub/x-profile-resolver.ts`
- Modify: `test_files/unit/sources/tikhub/x-profile-resolver.test.ts`

**Interfaces:**

```ts
export type XProfileShapeIssue =
  | "no-candidate"
  | "required-field-invalid"
  | "identity-conflict"
  | "optional-field-conflict"
  | "unsafe-structure"
  | "unknown-shape";

export interface XProfileShapeDiagnostic {
  issue: XProfileShapeIssue;
  visitedContainers: number;
  candidateCount: number;
  hasLegacyContainer: boolean;
  hasCoreContainer: boolean;
}

export function diagnoseXProfileShape(payload: unknown): XProfileShapeDiagnostic;
```

- [ ] **Step 1: Write adversarial redaction tests**

Build payloads whose every value contains a sentinel such as `SECRET_NAVAL_VALUE`. Assert `JSON.stringify(diagnostic)` never contains the sentinel, URLs, or payload keys outside the documented boolean/count projection. Cover accessors, proxies throwing during reflection, cycles, deep arrays, and oversized objects.

- [ ] **Step 2: Run the diagnostic test and verify red**

Run: `npm run test:unit -- test_files/unit/sources/tikhub/x-profile-shape-diagnostic.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement bounded structural projection**

Reuse the parser's numeric safety limits through exported constants or a shared internal helper. Inspect only property names needed to set presence flags, record only `typeof`/container categories internally, and collapse all reflective failures to `unsafe-structure`.

- [ ] **Step 4: Keep the resolver public error stable**

Extend `XProfileResolverError` with an optional frozen `diagnostic?: XProfileShapeDiagnostic`. On a parse failure, create the diagnostic locally, discard `payload` in the existing `finally`, and still expose code `profile-shape-unsupported`. Do not attach diagnostics to provider/network/key failures.

- [ ] **Step 5: Test resolver secrecy and one-request behavior**

Assert the resolver calls `fetchUserProfile` once, the thrown error contains only the safe diagnostic, and neither the error message nor serialized diagnostic contains the API key or provider sentinel values.

- [ ] **Step 6: Run focused tests**

Run: `npm run test:unit -- test_files/unit/sources/tikhub/x-profile-shape-diagnostic.test.ts test_files/unit/sources/tikhub/x-profile-resolver.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/sources/tikhub/x-profile-shape-diagnostic.ts src/sources/tikhub/x-profile-resolver.ts test_files/unit/sources/tikhub/x-profile-shape-diagnostic.test.ts test_files/unit/sources/tikhub/x-profile-resolver.test.ts
git commit -m "feat: add safe X profile diagnostics"
```

### Task 4: Render actionable verification feedback without enabling save

**Files:**

- Modify: `src/services/source-verification/verification-state.ts`
- Modify: `src/modals/source-onboarding/add-source-modal.ts`
- Modify: `src/i18n/zh-cn.ts`
- Modify: `src/i18n/en.ts`
- Modify: `test_files/unit/services/source-verification/verification-state.test.ts`
- Modify: `test_files/unit/modals/add-source-modal.test.ts`

**Interfaces:**

- Extend the failure state to `Readonly<{ status: "failure"; code: VerificationFailureCode; detail?: XProfileShapeIssue }>`.
- Change `VerificationController.fail(token, code, detail?)` to accept only a validated `XProfileShapeIssue` when `code === "profile-shape-unsupported"`.

- [ ] **Step 1: Add failing state-machine tests**

Assert valid safe details survive freezing, arbitrary strings are discarded, detail cannot appear for other failure codes, stale tokens cannot replace the current state, and `canSubscribe()` remains false.

- [ ] **Step 2: Add failing modal tests**

For every shape issue, assert the modal displays the generic unsupported message plus one concise troubleshooting sentence, never displays provider values, and leaves the subscribe button disabled. Editing the handle must clear the detail and must not call TikHub automatically.

- [ ] **Step 3: Run tests and verify red**

Run: `npm run test:unit -- test_files/unit/services/source-verification/verification-state.test.ts test_files/unit/modals/add-source-modal.test.ts`

Expected: FAIL because failure details are not represented.

- [ ] **Step 4: Implement state and localized rendering**

Map diagnostic issue categories to fixed translation keys. Do not render raw JSON. Preserve the existing success confirmation card showing avatar/name/`@handle` and existing proof-gated save path.

- [ ] **Step 5: Run focused and adjacent tests**

Run: `npm run test:unit -- test_files/unit/services/source-verification/verification-state.test.ts test_files/unit/modals/add-source-modal.test.ts test_files/unit/modals/x-account-source-modal.test.ts test_files/unit/sources/tikhub/x-profile-resolver.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/source-verification/verification-state.ts src/modals/source-onboarding/add-source-modal.ts src/i18n/zh-cn.ts src/i18n/en.ts test_files/unit/services/source-verification/verification-state.test.ts test_files/unit/modals/add-source-modal.test.ts
git commit -m "fix: explain unsupported X profiles safely"
```

### Task 5: Verify the X slice without another paid call

**Files:**

- Verify only; no production changes expected.

- [ ] **Step 1: Run all X/profile and onboarding unit tests**

Run: `npm run test:unit -- test_files/unit/sources/tikhub/x-profile.test.ts test_files/unit/sources/tikhub/x-profile-shape-diagnostic.test.ts test_files/unit/sources/tikhub/x-profile-resolver.test.ts test_files/unit/sources/tikhub/tikhub-client.test.ts test_files/unit/services/source-verification/verification-state.test.ts test_files/unit/modals/add-source-modal.test.ts`

Expected: PASS with no network access.

- [ ] **Step 2: Run policy checks**

Run: `npm run audit:i18n && npm run check:public && npm run check:platform`

Expected: PASS; public scan finds no live payload, credential, handle fixture tied to private data, or filesystem path.

- [ ] **Step 3: Inspect the diff for accidental provider data**

Run: `git diff --check && git diff -- src/sources/tikhub src/services/source-verification src/modals/source-onboarding src/i18n test_files/unit/sources/tikhub test_files/unit/modals/add-source-modal.test.ts`

Expected: only parser, diagnostic, state, localization, and tests changed.

- [ ] **Step 4: Commit any test-only cleanup**

If verification required deterministic test cleanup, commit only that cleanup:

```bash
git add test_files
git commit -m "test: harden X profile compatibility coverage"
```

Otherwise leave the tree unchanged.

- [ ] **Step 5: Record the live acceptance gate**

Do not click TikHub. Record in the release checklist that one final `@naval` verification requires a new explicit paid-call authorization after the release build is installed.
