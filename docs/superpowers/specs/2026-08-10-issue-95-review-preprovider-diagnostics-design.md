# Issue #95: Review pre-provider diagnostics — Design

**Status:** Approved for implementation planning  
**Date:** 2026-08-10  
**Issue:** [#95](https://github.com/xliberty2008x/grok-plugin/issues/95)  
**Type:** Bug fix (diagnostics / error attribution)  
**Approach:** Shared review pre-provider intent helper (Approach 2)

---

## 1. Problem

A real installed `review` job can admit successfully, record a detached worker PID, then lose the worker **before** `startedAt`, provider process creation, or Grok launch. About five seconds later recovery publishes:

```text
E_WORKER_LOST: The background worker disappeared; the prompt was not replayed.
```

No-automatic-replay is correct and must remain fail-closed. The defect is that the **pre-provider exit cause is discarded**, so operators cannot distinguish:

- worker authorization / startup refusal;
- early runtime failure before `execute()`;
- external kill or silent death with no child write.

The generic message also lacks a concrete next action, contrary to the project’s actionable-error expectations.

### Confirmed mechanism (legacy review launch)

1. Parent spawns the detached review worker with `stdio: "ignore"`.
2. Parent may spend up to ~750 ms in `captureSpawnIdentity` before publishing `workerProcess`.
3. Child polls durable state up to 40 × 25 ms, then throws `E_RECURSION` if it cannot authenticate.
4. Pre-execute errors never reach durable state (ignored stdio; no `pendingTerminal` write).
5. Recovery hardcodes generic `E_WORKER_LOST` when no usable pending intent exists.

A startup race is a **credible** cause of some incidents; this design does **not** close that race. It ensures that when the child can observe a failure, the cause is durable and typed.

### Existing recovery nuance

For non-task jobs, recovery already prefers `pendingTerminal.error` when present. Review simply never writes that field on pre-provider failure. Mid-run loss after provider start correctly remains generic `E_WORKER_LOST` when no pre-provider intent was recorded.

---

## 2. Goals and non-goals

### Goals

- Preserve a bounded, privacy-safe pre-provider launch diagnostic as durable job state.
- Prefer a **typed primary error code** when the child recorded one.
- Reserve generic `E_WORKER_LOST` for true unknown loss (no valid pending intent).
- Always include **one concrete operator next action** in the published message.
- Keep no-automatic-replay behavior.
- Share one durable diagnostic contract for foreground and background review.
- Prove behavior with deterministic tests matching issue #95 acceptance criteria.

### Non-goals / out of scope

- Fixing the identity-publication vs authorization-window race (timeouts, reordering, handshake).
- Migrating review onto dispatch-v2 / outbox controller launch.
- Task, deep-research, or other non-review launch paths (except reuse of existing shared primitives).
- Capturing parent/child stderr (`stdio: "ignore"` stays for the detached worker).
- Inventing new public error codes (`E_WORKER_LAUNCH`, etc.) unless strictly required; prefer existing codes.
- Changing process-identity kill rules, cleanup fences, or mid-run lost-worker semantics beyond message quality when no pending intent exists.

---

## 3. Constraints (locked during brainstorming)

| Decision | Choice |
| --- | --- |
| Fix priority | Diagnostics only |
| Error shape | Typed primary code when known |
| Durability mechanism | Child writes bounded terminal intent before exit |
| Path scope | Review only |
| Architecture | Shared helper + recovery preference (Approach 2) |

---

## 4. Architecture

### 4.1 Components

1. **`recordReviewPreProviderFailure({ root, jobId, error })`** (new helper)  
   - Builds a scrubbed, bounded intended terminal from a thrown / `CompanionError`-like value.  
   - Writes `pendingTerminal` (and matching summary / lifecycle event) under the job lock.  
   - Does **not** kill processes, delete review homes, or publish final terminal status.  
   - Location: leaf module already used by companion review lifecycle, or a small adjacent helper imported by `grok-companion.mjs`—prefer existing patterns over a new top-level facade.

2. **Review `--worker` entry** (existing)  
   - On auth failure (`!authorized`) and on fail-before-successful-`execute()` paths that exit the worker, call the helper, then exit/rethrow as today.  
   - Worker still does not “own” full recovery terminalization of a still-live process beyond leaving intent.

3. **`recoverActiveJobs` review loss path** (existing)  
   - After process-gone and cleanup proof (unchanged fences):  
     - if valid `pendingTerminal.error` → publish it as primary;  
     - else → `E_WORKER_LOST` with improved message + next action, wording chosen from whether provider/`startedAt` evidence shows pre-provider vs mid-run loss.  
   - Progress/summary derive from the same selected error after cleanup.

### 4.2 Data flow

```
parent: spawn review worker (stdio ignore) → publish workerProcess  [unchanged]
child:  poll auth → fail or early throw
child:  recordReviewPreProviderFailure → pendingTerminal
child:  exit (no prompt replay)
controller/status: recoverActiveJobs
  → worker gone; cleanup review home per existing rules
  → promote pendingTerminal.error if present
  → else E_WORKER_LOST
  → scrub; publish terminal failed; replay: false
```

### 4.3 Durable shape

Reuse existing `pendingTerminal` (no new top-level job fields, no stderr buffer field):

```js
pendingTerminal: {
  status: "failed",
  phase: "failed",
  completedAt: "<iso>",
  error: { code: "<stable code>", message: "<cause + one next action>" },
  summary: "<same short text>"
}
```

Do not invent a new public phase unless an existing pre-provider phase is already required by local conventions; default `failed` is sufficient for this diagnostics fix.

---

## 5. Error handling

### 5.1 Code selection

| Situation | Primary `error.code` |
| --- | --- |
| Auth never established after poll | `E_RECURSION` (existing throw code; improved message) |
| Other `CompanionError` before successful `execute()` settlement | preserve `error.code` after scrub |
| Non-`CompanionError` pre-provider throw | `E_PROVIDER_EXIT` (same default as `asErrorPayload` when `error.code` is absent; do not invent a new code) |
| Worker gone, no valid `pendingTerminal`, provider never started | `E_WORKER_LOST` with pre-provider-oriented next-action message |
| Mid-run loss after provider start, no pre-provider intent | `E_WORKER_LOST` with mid-run message (existing tests; may add next action without changing code) |

### 5.2 Message contract

Every published pre-provider or generic-loss message must be:

1. **Redacted** via existing `redact` / `sanitizeDisplayText` / `scrubStoredJob` paths.  
2. **Bounded** (same order as existing error message limits; no multi-KB blobs).  
3. **Actionable**: short cause + **one** concrete next action.

Illustrative wording (implementation may tighten; intent is fixed):

- Auth:  
  `Worker could not authenticate before execution. Check job status for this review ID; do not expect automatic replay — re-run the review command if needed.`
- Unknown loss before provider start (`startedAt` null / `providerProcess` null):  
  `The background worker disappeared before provider start; the prompt was not replayed. Inspect this job’s status/result, then re-run the review if the failure persists.`
- Unknown mid-run loss (provider had started; no pending intent): keep code `E_WORKER_LOST`; message may add a next action but must not claim “before provider start.”

Optional small `details` only if consistent with `asErrorPayload` (e.g. `stage: "pre-provider"`). Never store raw stderr dumps, credentials, full environment, or prompt text.

### 5.3 Write rules for `recordReviewPreProviderFailure`

- No-op if the job is already terminal.  
- Do not overwrite a **different** existing `pendingTerminal` (first durable intent wins; identical payload may re-apply).  
- Write under `updateJob` lock.  
- Leave the job **non-terminal** so recovery owns review-home cleanup and final publication.  
- Keep stored-job scrubbing consistent; never reintroduce a scrubbed prompt.

### 5.4 Recovery precedence (review)

1. Prefer valid `pendingTerminal.error` when present (already partially implemented for non-task jobs).  
2. Else use improved generic `E_WORKER_LOST`.  
3. After cleanup proven: progress/summary match final error; `replay: false`; scrub; apply review privacy/cleanup results as today.

---

## 6. Testing

### 6.1 Required tests

1. **Auth / pre-authorization failure is typed**  
   Deterministic fixture where the review worker cannot self-authorize (e.g. no matching `workerProcess` / blocked identity publication).  
   Assert: typed code (`E_RECURSION` for auth), next action in message, no provider process / `startedAt` null, no replay, prompt scrubbed if present, review home cleaned when cleanup succeeds.

2. **Child fails before `execute()` with durable cause**  
   Force a pre-execute failure that exercises the helper; after recovery, sanitized cause/code is visible; no provider launch; no replay.

3. **Regression: mid-run lost worker**  
   Existing `lost-worker recovery terminates headless review...` remains green (`E_WORKER_LOST` after provider up; home removed).

4. **Foreground and background**  
   Same durable error contract via job projection / `status --json` regardless of wait vs `--background` entry.

### 6.2 Optional unit coverage

- Helper no-ops when already terminal.  
- Helper refuses to replace conflicting `pendingTerminal`.  
- Message redaction/bounds hold for synthetic secret-like strings.

### 6.3 Verification (implementation)

- Focused Node test run for the files that receive new coverage.  
- `git diff --check`  
- No authenticated live Grok qualification required for this diagnostics-only change.

### 6.4 Acceptance checklist

- [ ] Known pre-provider failure → typed code + next action  
- [ ] Unknown silent death → `E_WORKER_LOST` + next action  
- [ ] No prompt/credential leakage  
- [ ] No automatic replay  
- [ ] Provider not started in pre-provider fixtures  
- [ ] Existing provider-stage lost-worker test passes  

---

## 7. Implementation sketch (for writing-plans)

Order of work (not a full plan):

1. Add `recordReviewPreProviderFailure` with scrubbing, conflict rules, and unit-level tests.  
2. Wire review `--worker` auth failure and pre-`execute()` failure paths to the helper.  
3. Harden generic review `E_WORKER_LOST` message when no pending intent.  
4. Add deterministic runtime/integration tests from §6.  
5. Confirm mid-run regression still green; no dispatch-v2 or race-timeout changes.

---

## 8. Risks and follow-ups

| Risk | Mitigation |
| --- | --- |
| Child dies before any write (SIGKILL) | Still `E_WORKER_LOST`; message improved; race fix deferred |
| Concurrent recovery vs child write | Job lock + “do not replace different pending”; recovery re-reads under lock |
| Operators confuse auth `E_RECURSION` with nested-Grok recursion | Message explicitly says authentication-before-execution; docs/README can note review pre-provider sense later if needed |
| Scope creep into race fix or dispatch-v2 | Explicit non-goals; separate issues |

**Deferred follow-ups (not this design):** close identity-publication race; prefer dispatch-v2 for review; unify deep-research diagnostics.

---

## 9. Donor / local mapping note

Issue #95 is local lifecycle diagnostics. No donor code is required to invent a new cache or protocol. Local invariants to preserve:

- Fail-closed no-replay for lost workers (`SPEC.md` §12).  
- Scrubbed durable job records.  
- Recovery as the owner of final terminalization when the worker cannot prove cleanup.  
- Reuse of `pendingTerminal` already used by task/research unsettled paths.
