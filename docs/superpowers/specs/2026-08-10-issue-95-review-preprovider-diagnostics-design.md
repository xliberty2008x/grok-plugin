# Issue #95: Review pre-provider loss — Design (extended)

**Status:** Draft for review (extended after RCA 2026-08-10)
**Date:** 2026-08-10
**Issue:** [#95](https://github.com/xliberty2008x/grok-plugin/issues/95)
**Type:** Bug fix (root causes + diagnostics)
**Scope:** Legacy review launch only (not task dispatch-v2, not deep-research full rewrite)

---

## 0. RCA summary (evidence)

Local reproduction (outside Grok ancestry) and code trace established three layers:

| Layer | Status | Finding |
| --- | --- | --- |
| **P0 Diagnostic loss** | **Confirmed / always** | Child throws typed `E_RECURSION` (auth) with stderr; job stays non-terminal with **no** `pendingTerminal`; recovery publishes generic `E_WORKER_LOST`. |
| **P1 Auth vs publish race** | **Credible / structural** | Parent: `spawn` → `captureSpawnIdentity` (≤750 ms) → first `workerProcess` write. Child starts at spawn and can only fully authorize on matching `workerProcess` (40×25 ms sleeps ≈1 s + overhead ≈1.8 s wall). Review lacks deep-research’s provisional `workerAuthorization` admit. Lock delay after capture can still lose the window. |
| **P2 Orphan queued** | **Confirmed secondary** | Aged `queued` review with `workerProcess: null` is **never** terminalized by recovery (loop continues past gates without a dead-worker signal). |

The original field incident (`workerProcess` set, `startedAt` null, fail ~5 s later) is consistent with P0 + either late publish of a dead PID or exit before `execute` sets `startedAt`. The incident alone cannot prove which exit reason; **P0 makes future incidents attributable**.

No-automatic-replay remains correct and fail-closed.

---

## 1. Problem (operator-visible)

A review job can fail before provider start and surface only:

```text
E_WORKER_LOST: The background worker disappeared; the prompt was not replayed.
```

Operators cannot tell auth refusal, early crash, external kill, or launch never bound. Sometimes a job can also remain stuck `queued` with no worker identity at all.

---

## 2. Goals and non-goals

### Goals

**P0 — Diagnostics**

- Durable, scrubbed pre-provider failure intent (`pendingTerminal`) from the review worker.
- Typed primary code when known; generic `E_WORKER_LOST` only when unknown.
- One concrete next action on published messages.
- Foreground and background share the same durable contract.
- No prompt/credential/unbounded-stderr leakage; no automatic replay.

**P1 — Race / handshake**

- Legacy review worker can complete self-authorization without waiting for the parent’s post-`captureSpawnIdentity` `workerProcess` write, using the same **provisional authorization** pattern already used by deep-research workers.
- Parent still records full owned identity (pid + startToken + nonce + commandMarker) before treating the worker as fully bound for signal/cleanup purposes.
- Deterministic test: delay `workerProcess` publication past the old pure-poll window; worker still admits **or** leaves a typed durable failure (not silent opaque loss after a successful late publish of a dead PID).

**P2 — Orphan recovery**

- Aged non-terminal review with no live controller and **no** `workerProcess` (launch never bound) terminalizes with an actionable pre-provider loss error after the existing queued grace.
- Does not steal jobs still inside the launch grace window.

### Non-goals

- Full migration of review onto dispatch-v2 / outbox controller (follow-up).
- Changing task or deep-research launch beyond borrowing the provisional-auth **pattern**.
- Capturing detached-worker stderr as the primary diagnostic channel (`stdio: "ignore"` may stay).
- New public error codes unless unavoidable; prefer existing `E_RECURSION`, `E_WORKER_LOST`, `E_PROVIDER_EXIT`, `E_PROCESS_IDENTITY`.
- Weakening process-identity checks before kill/signal of recorded groups.
- Claiming the single production incident’s exact exit cause without durable evidence.

---

## 3. Constraints

| Decision | Choice |
| --- | --- |
| Job scope | **Review only** (legacy `--launch-worker` / `--worker`) |
| Error shape | Typed primary when known |
| Durability | Child writes `pendingTerminal` before exit (P0) |
| Race strategy | **Provisional auth** (deep-research pattern), not dispatch-v2 |
| Orphan strategy | Recovery terminalization after grace when unbound |
| Delivery | One design; implement as ordered slices P0 → P1 → P2 |

---

## 4. Architecture

### 4.1 P0 — `recordReviewPreProviderFailure`

New leaf helper (e.g. `plugins/grok/scripts/lib/review-preprovider-failure.mjs`):

- Input: `{ root, jobId, error, env? }`
- Maps error → scrubbed `{ code, message }` (+ optional tiny `details.stage = "pre-provider"`).
- Writes under `updateJob`:
  - `pendingTerminal: { status: "failed", phase: "failed", completedAt, error, summary }`
  - lifecycle `blocked` event
  - non-terminal job (recovery owns cleanup + final publish)
- No-op if already terminal; do not replace a **different** existing `pendingTerminal`.
- Never stores prompt, credentials, or stderr blobs.

**Wire sites (review `--worker` only):**

1. Auth failure (`!authorized`) before throw.
2. Catch around `execute` when still pre-provider (`startedAt == null` && `!providerProcess`).

**Recovery:** already prefers `pendingTerminal.error` for non-task jobs; harden generic path with `reviewLostWorkerError(job)` (pre-provider vs mid-run wording + next action).

### 4.2 P1 — Provisional authorization (race close)

**Donor-in-tree pattern** (deep-research worker, current tree ~L5208–5213):

```text
if nonce matches workerAuthorization (or bound identity.nonce)
  and (no workerProcess.pid OR workerProcess.pid === self)
  → authorize provisionally
```

**Apply to legacy review `--worker` (non-broker only):**

Provisional authorize when **all** hold:

1. `GROK_COMPANION_WORKER_NONCE` is non-empty and equals `record.workerAuthorization`, **or** equals already-bound `workerProcess.nonce` for this job;
2. Job is review (or this branch is only reached for legacy non-broker review);
3. `workerProcess` is missing **or** `workerProcess.pid === process.pid` (never steal a foreign PID);
4. Job is not terminal;
5. Optional hardening: `commandMarker` absent or equals job id when present.

After provisional auth, enter `execute` as today. The first durable bind inside `execute` / existing re-stamp path must still attach full identity (`startToken`, `processGroupId`, nonce, commandMarker) before provider launch.

**Parent path (optional small harden, same slice):**

- Keep `captureSpawnIdentity` + full `workerProcess` publish.
- Do **not** clear `workerAuthorization` until full identity is written (today parent nulls it in the same update as `workerProcess` — fine once provisional auth keys off either field).
- If capture fails and kills the child, existing launcher failure path terminalizes the job (keep); ensure message remains actionable (P0 helper or existing launcher diagnostic).

**Why not only “widen poll to 5s”:** masks lock delay without fixing the handshake; provisional auth matches an already-shipped local pattern and removes ordering dependence.

**Why not dispatch-v2 in this design:** larger surface; not required once provisional auth + diagnostics land.

### 4.3 P2 — Orphan unbound review recovery

In `recoverActiveJobs` active loop (after existing `queued` age &lt; 5 s skip):

If job is review (legacy), non-terminal, not `providerLaunchCleanupBlocked`, controller not live, and **`workerProcess` is null/incomplete** (no pid), then:

- Treat as launch-failed / unbound worker (not “still starting” — starting grace requires a matching live token).
- Cleanup review home if any.
- Terminalize with error from `reviewLostWorkerError` **or** a slightly more specific message: launch never bound a worker identity; re-run review; no replay.
- Code: `E_WORKER_LOST` is acceptable (unknown bound process); do not invent a new code unless docs already want one.

Must **not** terminalize:

- `queued` younger than 5 s (existing gate).
- Jobs with live matching `workerProcess`.
- Broker/dispatch-v1 candidates (already filtered).

### 4.4 Data flow (combined)

```
parent: admit (workerAuthorization=nonce)
     → spawn --worker (stdio ignore)
     → captureSpawnIdentity → updateJob(workerProcess, clear auth)   [may lag]
child:  provisional auth on workerAuthorization+self  OR full workerProcess match
     → execute (startedAt, provider…)
     → on pre-provider fail: recordReviewPreProviderFailure → pendingTerminal → exit
recovery:
     → prefer pendingTerminal.error
     → else if unbound aged review: terminalize orphan
     → else if dead worker: E_WORKER_LOST stage-aware
     → cleanup home; replay: false
```

### 4.5 Durable shapes

**pendingTerminal** (unchanged from prior approval):

```js
pendingTerminal: {
  status: "failed",
  phase: "failed",
  completedAt: "<iso>",
  error: { code, message },  // message includes one next action
  summary: "<same short text>"
}
```

No new top-level fields required for P1/P2.

---

## 5. Error handling

| Situation | Code | Notes |
| --- | --- | --- |
| Auth never established after full poll | `E_RECURSION` | Message: authenticate-before-execution + next action |
| Other `CompanionError` pre-provider | keep code | Scrubbed |
| Untyped pre-provider throw | `E_PROVIDER_EXIT` | Same default as `asErrorPayload` |
| Dead worker, no pending, pre-provider | `E_WORKER_LOST` | “before provider start” + next action |
| Mid-run loss, no pending | `E_WORKER_LOST` | Must **not** say “before provider start” |
| Orphan unbound after grace | `E_WORKER_LOST` | Message: launch never bound worker / re-run |

---

## 6. Testing

### P0

1. Auth failure → durable `pendingTerminal` / recovered typed `E_RECURSION` + next action; no provider; no replay; home cleaned.
2. Pre-`execute` failure via helper → sanitized cause visible.
3. Mid-run lost-worker regression still green.
4. Helper unit: no-op terminal, no replace different pending, redaction.

### P1

5. **Delayed identity publication:** spawn real `--worker` with valid `workerAuthorization`; withhold `workerProcess` write for &gt; old pure-poll window (≥1.2 s); assert worker reaches `execute` / `startedAt` **or** (if fixture stops provider) does not die with silent loss—prefer assert provisional auth succeeds and sets `startedAt` with fake provider.
6. **Foreign PID rejection:** job has `workerProcess.pid` for another process; provisional auth must **not** admit.
7. Full identity still required before any kill/cleanup of the worker group (existing identity tests stay green).

### P2

8. Seed review `queued`, `createdAt` aged &gt;5 s, `workerProcess: null` → `status` recovery → `failed` + actionable `E_WORKER_LOST`; no hang.
9. Seed review `queued`, age &lt;5 s, unbound → recovery leaves non-terminal (grace).

### Verification

- `node --check` on touched modules
- Focused `node --test` for new unit + runtime cases
- `git diff --check`
- No authenticated live Grok run required for these slices

---

## 7. Implementation order

1. **P0** — helper + wire + recovery messages + tests (unblocks attribution).
2. **P1** — provisional auth for legacy review + delayed-publish test.
3. **P2** — orphan unbound recovery + grace tests.
4. Update plan doc to match this extended design; implement slice-by-slice.

Do not ship P1 without P0: a fixed race that still throws without durable intent re-creates opacity on other failures.

---

## 8. Risks

| Risk | Mitigation |
| --- | --- |
| Provisional auth too loose | Require nonce match; reject foreign pid; review/legacy-only branch |
| Provisional auth without startToken | Do not signal/kill until full identity recorded; execute bind path unchanged for provider |
| P2 races live launcher | Keep 5 s queued grace; only unbound (null workerProcess) |
| `E_RECURSION` confusion with nested Grok | Message text names authentication-before-execution |
| Scope creep to dispatch-v2 | Explicit non-goal |

---

## 9. Local pattern mapping

| Need | Local precedent |
| --- | --- |
| Provisional worker admit | Deep-research `--deep-research-worker` auth window |
| `pendingTerminal` + recovery prefer | Task/research unsettled paths; non-task recovery already reads pending |
| No-replay lost worker | `SPEC.md` §12 |
| Fail-closed identity before signal | `process-control` / `captureSpawnIdentity` |

No new donor pin required beyond patterns already in this repository. Prior diagnostics-only design is **superseded** by this extended document for implementation planning.

---

## 10. Acceptance checklist

- [ ] Known pre-provider failure → typed code + next action (P0)
- [ ] Unknown silent death → stage-aware `E_WORKER_LOST` (P0)
- [ ] Delayed `workerProcess` publish still allows healthy auth (P1)
- [ ] Foreign `workerProcess` cannot be stolen (P1)
- [ ] Aged unbound queued review terminalizes (P2)
- [ ] Young unbound queued review keeps grace (P2)
- [ ] No prompt/credential leakage; no automatic replay
- [ ] Mid-run lost-worker test green

## 11. Donor pins (lifecycle / process)

Repository policy requires recording both donors for lifecycle and process-control changes:

| Donor | Pin / path | Useful invariant | Rejected pattern |
| --- | --- | --- | --- |
| `openai/codex-plugin-cc` | `db52e28` — session lifecycle cleanup | Terminate recorded process tree before deleting job/session state | Unconditional record removal while processes may still be live |
| `xai-org/grok-build` | audit pin in `WORKER_BROKER_PLAN.md` / current cancel+terminal sources | Attach children to an owned process group; terminate and reap before cleanup/finalization | Cleaning homes/guards before proving owned group absence |

Local adaptation: review recovery reuses `terminateProviderCleanupTarget` / guard resolution before `cleanupReviewEnvironment`, and provisional worker bind consumes `workerAuthorization` only with no recorded PID while attaching full self identity.
