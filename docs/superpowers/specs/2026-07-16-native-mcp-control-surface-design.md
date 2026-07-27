# Native MCP Control Surface — Design

**Status:** Draft for review  
**Date:** 2026-07-16  
**Type:** Enhancement ADR on top of issue #25 / `WORKER_BROKER_PLAN.md`  
**Primary host:** Codex via plugin-bundled STDIO MCP  
**Research basis:** Deep read of this repository plus open-source [xai-org/grok-build](https://github.com/xai-org/grok-build) (local clone research 2026-07-16)

---

## 1. Problem

Issue #25 aims for **control-loop parity**: Codex (and later Claude) should spawn, wait on, message, cancel, and collect results from Grok Companion workers through durable structured operations, without claiming that those workers are native host subagents.

A Worker Protocol and MCP broker already exist in-tree. Deep research shows a critical gap:

| Surface | What it actually does today |
| --- | --- |
| Skill / CLI (`$grok:rescue` → `grok-codex.mjs`) | Full production loop: TaskEnvelope → ACP/provider launch → status/result → host `record-verification` |
| MCP broker (`grok_workers` → `worker_*` tools) | Structured, authority-bound tools; **spawn durable-commits only** (`providerLaunched: false`); no production provider launch; mailbox lacks a live deliver adapter; no MCP verification tool |
| Skills | Teach shell/PTY only; never prefer MCP |
| Natural Codex proof | Exercises the skill path, not MCP |

Meanwhile, Grok Build’s own native subagent loop (in open source) feels “native” because of **tool ergonomics and lifecycle semantics**, not because third parties share its process address space:

- async-first spawn with an immediate handle,
- one poll/wait tool (snapshot vs bounded wait; multi-id wait-all),
- completion push with delivery exclusivity,
- `initializing` ≠ not found,
- turn-scoped cancel,
- eager validation before fire-and-forget,
- honest resume handles and stable status vocabulary.

**Renaming MCP tools alone would be ergonomic theater.** A future native-feeling surface must first close the MCP execution loop, then align tool shape and host teaching with that loop.

---

## 2. Goals and non-goals

### Goals

1. Make **Codex MCP** a complete, honest control plane for Grok workers: spawn → (async) run → wait/get → result → host verification → cancel/follow-up as needed.
2. Give the model a **native-shaped tool surface** (`grok_*` preferred names, multi-wait, dual-mode wait) while keeping `worker_*` aliases.
3. Teach **one primary path** when host identity metadata is full (MCP); keep CLI/PTY as degraded/compat fallback.
4. Borrow **control-loop contracts** from Grok Build without copying in-process coordinator, shared terminal reparenting, or fake nativeness.
5. Preserve every security invariant from #25 and `SPEC.md`.

### Non-goals

- Claiming Grok jobs are genuine native Codex (or Claude) subagent threads.
- Auto-merging isolated worktrees into the parent checkout.
- Letting provider completion set `hostVerification: passed`.
- Auto-retrying `delivery_unknown` mailbox outcomes.
- Claude MCP identity surface in this ADR (Claude stays command/skill façade until a separate design freezes trusted identity injection).
- Closing issue #25 Phase 5 qualification by itself (this ADR unblocks usable broker parity; release qualification remains #25).
- Mapping full Grok Build `capability_mode` / worktree snapshot_ref productization (deferred; may reference #25 Phase 3).

---

## 3. Research summary (implementation-level)

### 3.1 Grok Build — copy the contract, not the machinery

Primary sources under `grok-build`:

- Task tool / spawn defaults: `xai-tool-types` Task input; `xai-grok-tools` task implementation (background default `true`, UUID v7 ids, depth 1).
- Poll/wait: `get_task_output` — omit/`timeout_ms=0` snapshot; positive timeout waits (multi-id = wait-all, max 20 ids, hard wait cap ~10 minutes because completion also wakes the model).
- Kill: bash SIGTERM/SIGKILL vs subagent Cancel+Shutdown; already-exited is success.
- Coordinator: `parent_prompt_id` scopes turn cancel (background flag does **not** exempt current-turn workers); earlier-turn background workers survive.
- Auto-wake + block-wait exclusivity: result already delivered by blocking wait or explicit kill must not also auto-wake.
- Worktree isolation: snapshot for **resume**, not automatic parent apply.
- Tool renames for the model: `task` → `spawn_subagent`, `get_task_output` → `get_command_or_subagent_output` (behavior matters more than exact names for a third-party broker).

**Do not copy:** in-process `SubagentBackend` channels, shared TerminalBackend reparenting, harness-only `surface_completion: false`, or claiming the same session identity as the host.

### 3.2 Grok Build as a child process (provider adapter)

Companion already does the right process shape for isolation:

```text
grok … agent --no-leader --leader-socket <unique> --agent-profile <materialized> stdio
```

plus private `GROK_HOME`, sandbox, `--deny`, and profile `toolConfig`.

Highest-ROI adapter improvements (supporting pillars, not the main façade):

- Split ACP timeouts (short initialize/session, long cancelable prompt).
- Handle turn-terminal rails: `x.ai/session/prompt_complete` / durable `TurnCompleted`, not only generic `session/update` chunks.
- Optional `_meta.agentProfile` JSON object on `session/new` (highest priority resolution path in shell).
- Export `GROK_LEADER_SOCKET` env as well as the CLI flag.
- Do not treat headless `--tools` as ACP enforcement; ACP relies on profile + deny.

### 3.3 This plugin — dual path and incomplete MCP loop

| Layer | Status |
| --- | --- |
| Worker Protocol v1 projections, cursors, privacy strip | Implemented |
| Codex `_meta` authority (`threadId`, turn metadata, `codex/sandbox-state-meta`, plugin_id for mutations) | Implemented, fail-closed |
| Durable idempotent spawn/cancel | Implemented (commit ≠ launch) |
| Production `providerLaunch` from MCP spawn | **Missing** |
| Mailbox durable states | Implemented; live deliver adapter **missing** |
| `presentWorker` on MCP results | **Not wired** |
| MCP host verification | **Missing** |
| Skill teaching of MCP | **Missing** |
| Natural MCP proof | **Missing** (natural gate = skill only) |

---

## 4. Architecture

```text
Codex model
    │
    ├─ preferred (identity=full, mutationAllowed):
    │     MCP tools  grok_*  (aliases: worker_*)
    │           │
    │           ▼
    │     MCP façade (broker.mjs)
    │       • name normalize
    │       • argument validation
    │       • presentWorker projection
    │           │
    │           ▼
    │     WorkerService (existing)
    │       • authority-bound list/get/wait/result
    │       • durable spawn/cancel/send/followup
    │       • providerLaunch adapter  ◄── NEW trusted glue
    │           │
    │           ▼
    │     Same provider lifecycle as CLI
    │       grok-provider / ACP / process-control / job store
    │
    └─ fallback (degraded identity or no MCP):
          $grok:* skills → grok-codex.mjs CLI / PTY envelope
```

**Single implementation rule:** façade and CLI share the job store, protocol projections, and provider launch path. No second lifecycle.

**Honesty rule:** initialize instructions and tool titles continue to label workers as **external Grok workers**. Presentation rejects `isNativeHostAgent: true`.

---

## 5. Pillars and delivery slices

Slices are ordered for dependency safety. Each slice is reviewable and testable alone.

### E0 — Honesty baseline (docs / skill notes)

- Document that MCP today is incomplete until E1 lands.
- Issue #25 / plan: broker “foundations” are library-level; host-operable MCP requires launch coupling.
- Do not advertise MCP as the production control plane in user-facing docs until E1+E4+E5 smoke green.

### E1 — Trusted provider launch on broker spawn (mandatory)

**Problem:** `worker_spawn` returns success after durable commit; nothing starts Grok in production.

**Design:**

1. After atomic durable job commit (existing success definition), invoke a **trusted** `providerLaunch` adapter that reuses the CLI/task start path (`startJob` / ACP open), not a new provider stack.
2. Launch is **async relative to the tool return** when possible: tool may return handle with  
   - `spawnSuccessDefinition: "durable_commit"` (unchanged meaning),  
   - `providerLaunchState: "pending" | "started" | "failed"`,  
   - `providerLaunched: boolean` consistent with state.
3. Cancel in the commit→launch window must never double-start (existing cancel-before-fork / idempotency tests extended).
4. Crash recovery / reconcile remain **non-replaying**: never auto-replay a possibly mutating prompt (existing reconciler policy).
5. Follow-up child jobs (E6) use the same launch adapter after durable child commit.

**Acceptance:**

- Fake provider: MCP spawn → provider start exactly once; idempotent retry does not relaunch; cancel in window never starts.
- Real or fake provider: wait eventually observes running/terminal without shell skill.

### E2 — Native-shaped façade names + presentation

| Preferred | Alias | Service |
| --- | --- | --- |
| `grok_list` | `worker_list_owned` | `listOwned` |
| `grok_spawn` | `worker_spawn` | `spawn` |
| `grok_get` | `worker_get` | `get` |
| `grok_events` | `worker_events_after` | `eventsAfter` |
| `grok_wait` | `worker_wait` | `wait` (+ multi) |
| `grok_result` | `worker_result` | `result` |
| `grok_cancel` | `worker_cancel` | `cancel` |
| `grok_send` | `worker_send` | `send` |
| `grok_followup` | `worker_followup` | `followup` |
| `grok_record_verification` | — | host verification (E4) |

Rules:

- Dual registration; one dispatch path.
- Tool titles/descriptions: “external Grok worker”; teach the poll shape in descriptions (Grok Build pattern).
- Optional spawn field `description` (3–5 words): presentation/alias only, not security.
- Apply `presentWorker` (external label, safe aliases) to MCP structured results.
- Keep `worker_*` indefinitely in this ADR; deprecation language only.

### E3 — Wait ergonomics (Grok Build dual-mode + multi-id)

**`grok_wait` inputs:**

| Field | Rule |
| --- | --- |
| `id` xor `ids` | Single id (compat) or 1–20 owned ids |
| `cursor` / `cursors` | Optional; map for multi |
| `timeoutMs` | 0 = non-blocking snapshot; >0 wait; retain a hard per-call upper bound (default keep 30s unless raised with explicit justification and tests) |
| `mode` | Multi only: `wait_any` (default) \| `wait_all` |

**Behaviors:**

- Re-authorize every poll (existing).
- Single-id positive wait: preserve legacy flat response shape for alias clients.
- Multi-id: envelope `{ mode, timedOut, workers: [{ id, events, terminal, cursor, changed }] }`.
- Foreign/missing ids: same observational opacity as single get (no oracle).
- Document multi-call wait for long jobs (Grok Build relies on completion push for long caps; until E7/host push exists, models re-issue wait).

**Lifecycle status clarity:**

- Ensure jobs are listable/gettable as soon as durable commit exists (`queued` / starting), so immediate poll never looks like pure not-found for the owner (Grok Build `initializing` pattern).

### E4 — MCP host verification

Add `grok_record_verification`:

- Same schema constraints as CLI: root `commandOutcomes` array only; command, status (`passed`|`failed`), integer exitCode; size bounds; no stdout/stderr blobs.
- Authority: same mutation principal rules as other mutations.
- Provider claims cannot set `hostVerification: passed`.

Closes the structured loop: spawn → wait → result → **host verification** without shell.

### E5 — Single taught control surface (skills)

Update Codex skills (`rescue`, `status`, `result`, `cancel`, runtime skill):

```text
IF capability matrix identity=full AND mutationAllowed
  → prefer grok_* MCP tools; do not also shell-status the same job
ELSE
  → CLI / PTY path (compat)
```

Natural proof:

- Keep existing skill natural Codex gate.
- Add **MCP-only** natural (or installed) scenario once E1+E4 green: no skill shell recipe for the control loop.

### E6 — Follow-up launch; mailbox policy

- **Follow-up:** after durable child commit, call provider launch with lineage and profile identity checks (type/role match; no silent profile widen).
- **Send / mailbox:** either wire a real ACP deliver adapter with ack/dedup evidence, **or** remove/hide `grok_send` from tools/list until proven. Do not leave a model-callable send that always returns `delivery_unknown` without documentation that it is non-functional for live chat.

### E7 — Provider progress hardening (parallelizable)

- ACP: independent long timeout / cancel for `session/prompt`.
- Subscribe to turn-complete extension rails for terminal detection.
- Optional progress fields on snapshots derived from ACP tool events (no raw reasoning export).
- Env pin for leader socket.

### E8 — Deferred (explicitly out of this ADR’s implementation commitment)

- Broker write spawn + worktree integrate tools (#25 Phase 3).
- Grok Build `capability_mode` / `isolation` parameter surface as first-class MCP fields (may map later onto roles + worktrees).
- Claude structured MCP authority.
- Host auto-wake push into Codex (requires host capability; until then multi-call wait is the contract).
- Official native host extension API.

---

## 6. Security invariants (must not weaken)

1. Authority from host MCP `_meta` only — never tool args for thread, cwd, owner, or root.
2. Exact-thread ownership for reads; foreign ≡ nonexistent.
3. Mutations require valid `plugin_id` matching `grok(@…)?`.
4. Public projections strip host/session/process/prompt/raw provider secrets.
5. Spawn durable success ≠ provider success ≠ host verification passed.
6. No automatic mutating prompt replay on crash/reconcile.
7. `delivery_unknown` never auto-retried.
8. Workers cannot self-escalate roles or widen tools.
9. Write spawn remains gated until isolation gates pass (#25 Phase 3).
10. External labeling enforced; native-host presentation spoof rejected.
11. Evidence promotion remains blocked without a proof-producing runner.

---

## 7. Compatibility

| Surface | Guarantee |
| --- | --- |
| `worker_*` tools | Remain; single-id paths behavior-compatible |
| Worker Protocol v1 | No forced breaking version bump for handles/snapshots/cursors; additive fields only with defaults |
| CLI / Claude commands | Unchanged behavior; not removed |
| Write spawn via MCP | Still rejected until Phase 3 |
| Issue #25 phases | This ADR layers on top; does not rewrite phase numbering |

---

## 8. Testing matrix

| Proof | Assertion |
| --- | --- |
| Launch coupling | MCP spawn starts provider once; idempotent; cancel window safe |
| Closed MCP loop | spawn → wait → result → record_verification without shell |
| Alias parity | Every `grok_*` / `worker_*` pair hits same op |
| Multi-wait | wait_any / wait_all / timeout / ≤20 ids / re-auth |
| Privacy / authority | Missing meta, wrong thread, foreign id, mutation without plugin_id fail closed |
| Presentation | Results labeled external; native spoof rejected |
| Skill policy | Static skill text prefers MCP when full identity (snapshot test) |
| CLI non-regression | Existing companion and natural skill paths remain green |
| Natural MCP | Installed/natural Codex MCP-only scenario after E1+E4+E5 |
| Mailbox | If send exposed: delivered/unknown semantics with no auto-retry |

---

## 9. Success criteria

1. With full Codex MCP identity, a model can run the full worker control loop using **only** `grok_*` tools and obtain host-asserted verification.
2. Skills prefer that path; CLI remains correct fallback when identity is degraded.
3. `worker_*` and CLI tests remain green.
4. Tool surface and status vocabulary feel like Grok Build’s loop (async handle, wait dual-mode, multi-wait, clear terminal/result) without claiming host nativeness.
5. #25 remains open until its own Phase 5 aggregate qualification; this ADR is a dependency enabler, not a close-out claim.

---

## 10. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Double path (MCP + shell) | Skill policy; descriptions; optional guardrails in docs |
| Tool list noise (aliases) | Prefer `grok_*` titles; alias noted in description |
| Launch races | Reuse proven CLI race tests; extend for MCP entry |
| Long jobs vs 30s wait | Multi-call wait documented; optional bound raise only with tests |
| Scope creep into worktrees/Claude | E8 deferred list is binding for this ADR |
| Overclaiming readiness | E0 honesty; no `qualified` evidence without proof runner |

---

## 11. Relationship to prior brainstorming

Earlier draft sections proposed a **façade-only** Approach A (rename tools + multi-wait + skill prefer MCP). That remains **necessary but not sufficient**.

This design **supersedes** façade-only scope with:

1. **Pillar E1** (provider launch) as the mandatory first product cut after honesty docs.  
2. Façade + multi-wait as E2–E3.  
3. Verification + teaching + follow-up/mailbox as E4–E6.  
4. Provider ACP depth as E7.

---

## 12. Open decisions (resolved defaults)

| Decision | Default in this design |
| --- | --- |
| Host priority | Codex MCP first |
| Tool naming | `grok_*` preferred, `worker_*` aliases (not Grok Build’s `spawn_subagent` names) |
| Wait bound | Keep 30s per call unless a later slice justifies raise |
| Mailbox send | Hide or document-nonfunctional until deliver proven |
| Claude | Out of implementation scope for this ADR |
| Write workers via MCP | Still Phase 3 gated |

---

## 13. Implementation plan handoff

After this design is approved, the next step is `writing-plans`: a phased implementation plan that maps E0–E7 to concrete files (`broker.mjs`, `worker-service.mjs`, `worker-mutation.mjs`, `grok-provider.mjs`, skills, tests) with acceptance commands per slice.

Do not implement code until the plan is written and approved for execution.
