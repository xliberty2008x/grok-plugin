# Native-like Grok Worker Broker execution and evidence plan

Status: Active roadmap; implementation is partial and not release-qualified

Roadmap version: `1.0`

Canonical issue: [#25 — Make Grok Companion workers native-like through a structured worker broker](https://github.com/xliberty2008x/grok-plugin/issues/25)

Current delivery PR: [#26 — Worker Protocol v1 and read-only MCP broker](https://github.com/xliberty2008x/grok-plugin/pull/26)

Release-hardening plan: [PLAN.md](PLAN.md)

Companion contract: [SPEC.md](SPEC.md)

## 1. Outcome

Build a provider-neutral Worker Broker that lets Codex and Claude control Grok Companion workers through durable structured operations while preserving Grok's independent-model value and the host's authority over architecture, permissions, integration, verification, and readiness.

The target is **control-loop parity**, not a claim that Grok jobs are native Codex agent threads. The completed system should support:

- durable spawn, inspect, wait, result, message, follow-up, and cancellation operations;
- exact worker lineage, bounded context provenance, workspace identity, and security-profile identity;
- reconnectable events and crash behavior that never silently replays a mutating prompt;
- isolated write worktrees with explicit host-owned integration;
- compact host presentation built from structured records rather than parsed shell text;
- side-by-side native and Grok qualification with honest remaining-gap reporting.

This plan is the source of truth for scope, phase deliverables, gates, and evidence. GitHub issue #25 is the human-readable progress mirror. Neither a checked issue box nor a worker summary is proof by itself.

## 2. Scope boundaries

### In scope

- Worker Protocol schemas and durable lifecycle events.
- A plugin-bundled, task-authorized local MCP surface.
- Safe mutation operations after their authority and recovery semantics are frozen.
- Durable mailbox, follow-up, context packets, and immutable roles.
- Host-owned worktree isolation, artifact manifests, integration, and cleanup.
- Codex and compatibility Claude adapters.
- Evidence capture, validation, invalidation, and side-by-side qualification.

### Non-goals

- Claiming that an external Grok worker is a genuine native host subagent.
- Forwarding hidden system or developer instructions, reasoning, credentials, private process identity, raw transcripts, or internal tool records.
- Letting a worker expand its own tools, scope, permissions, or data-processing authority.
- Letting provider completion set host verification to passed.
- Automatically retrying or replaying work whose provider-delivery outcome is ambiguous.
- Enabling recursive Grok delegation merely for parity.
- Replacing main Codex as planner, integrator, final validator, or readiness authority.
- Making a dashboard mandatory unless a separate design decision freezes its value, scope, and authorization model.

## 3. Status and proof vocabulary

Every phase and deliverable uses one of these states:

| State | Meaning |
| --- | --- |
| `not_started` | A contract may be described, but implementation has not begun. |
| `implemented_unverified` | Code or documentation exists, but the prescribed deterministic gates are missing, stale, or failing. |
| `verified_on_draft` | The implementation and prescribed deterministic checks passed on an exact unmerged commit. |
| `qualified` | Required installed-host and live-provider boundaries passed for the exact source, installed artifact, and runtime recorded in evidence. |
| `blocked` | A named capability, architecture, authority, or safety decision must be resolved before implementation can proceed safely. |
| `deferred` | The item is intentionally outside the current phase or release scope. |

An issue checkbox means that the referenced implementation exists and its prescribed deterministic verification passed on the referenced commit. A top-level phase remains open until all mandatory deliverables and exit gates are current. `Qualified` is stronger than a checked box: it also requires exact-source installed/live evidence at every boundary claimed.

Historical evidence remains useful history but cannot qualify newer source, a different installed artifact, another host, or another provider/runtime version.

## 4. Ownership and execution model

Main Codex owns requirements, architecture, task boundaries, integration, authoritative verification, evidence inspection, issue synchronization, and the final readiness decision.

Native Codex subagents are used for independent investigation, architecture challenge, security and failure-mode review, and fresh validation of important integrated work. Planning and validation agents are read-only by default.

Grok Companion is the primary delegated implementation worker for bounded, separable code slices after the main thread has frozen the contract. Every implementation request must specify objective, scope, write boundaries, constraints, non-goals, acceptance criteria, required verification, and concise return format. A Grok report is input to integration, never final proof.

The main thread retains tightly coupled changes, credential handling, destructive actions, cross-slice integration, and actions requiring new user authority. If Grok fails concretely, the fallback and reason must be recorded rather than hidden.

## 5. Completion protocol for every delivery slice

The agent closing a slice must perform this sequence and preserve the results:

1. Freeze the contract and acceptance gates in this plan before construction.
2. Record repository, upstream, branch, base commit, and intended write boundaries.
3. Implement on a bounded branch or isolated worktree; do not overlap writers on the same files or state.
4. Inspect the integrated diff, privacy surfaces, migrations, failure paths, and compatibility boundaries.
5. Commit the implementation, confirm `git status --porcelain` is empty, and record full commit and tree IDs.
6. Run `git diff --check`, focused tests, and `npm run check`; record exact commands, exit codes, counts, and timestamps.
7. Run phase-specific negative, crash, authorization, and live scenarios at the boundary actually being claimed.
8. Install the exact tested artifact when the phase crosses a packaging or host boundary; record source and installed inventory digests.
9. Obtain fresh independent native validation against the exact commit for security-sensitive or phase-completing work.
10. Write an immutable, bounded evidence record. Store assertions and output digests, not secret-bearing raw logs.
11. Run the evidence validator. A skipped mandatory gate is `not verified`, never `passed`.
12. Update this plan's evidence registry and issue #25 in the same PR, listing the exact commit, PR, evidence path, replay command, outcomes, and residual gaps.

No phase is complete merely because its implementation exists, a worker says it succeeded, unrelated CI is green, or the issue checkbox was edited.

## 6. Evidence system

### 6.1 Authority separation

Evidence must keep these authorities separate:

1. **Worker/provider claims:** what Grok reports it did.
2. **Runtime observations:** process, filesystem, lifecycle, and structured protocol facts observed by the plugin.
3. **Host verification:** checks run and interpreted by the host after the worker result or integration.
4. **Independent validation:** a fresh reviewer inspecting the exact integrated commit.
5. **CI and qualification:** declared matrix and installed/live scenarios bound to the exact source and runtime.

Provider success cannot promote runtime evidence or host verification. Screenshots, issue comments, agent summaries, and PR prose may point to evidence but are not substitutes for it.

### 6.2 Durable paths

Phase evidence will live under:

```text
tests/e2e-results/worker-broker/
  ledger.json
  phase-0/<source-digest>.json
  phase-1/<source-digest>.json
  phase-2/<source-digest>.json
  phase-3/<source-digest>.json
  phase-4/<source-digest>.json
  phase-5/<source-digest>.json
```

The first current snapshot predates the schema and validator and is stored as:

```text
tests/e2e-results/worker-broker/phase-1-readonly-dcb78b8.json
```

Phase 0 must add a machine-readable schema, immutable per-phase records, a current-head ledger, and replay commands. Until then, this checked-in JSON record is a provisional durable snapshot: it sets `provisionalSupportingRecord: true` and `evidenceSystemQualification: false`, may omit future schema fields, and is not evidence-system qualification.

Planned commands are:

```text
npm run worker:evidence -- status --strict
npm run worker:verify -- --phase <N>
npm run worker:qualify -- --phase <N> --host <codex|claude-code> --record
npm run worker:verify -- --all
```

These are planned interfaces, not runnable commands, until Phase 0 implements them.

### 6.3 Required evidence fields

Every schema-conformant immutable record produced after Phase 0 installs the schema and validator must capture at least:

| Category | Required fields |
| --- | --- |
| Identity | schema version, roadmap version, issue, phase, slice, status, recorded timestamp |
| Source | full commit, tree, source inventory digest, phase-scope digest, clean-tree status, plugin version |
| Install | source plugin digest, installed artifact digest, file count, installation method |
| Runtime | OS, architecture, Node, Git, host versions, Grok version/revision, MCP protocol version |
| Prerequisites | evidence-record digests and mandatory gate IDs inherited by this phase |
| Commands | exact command, boundary, start/end time, exit code, assertion counts, bounded output digest |
| Scenarios | stable scenario ID, expected outcome, actual outcome, measurements, negative/adversarial result |
| CI | workflow URL, exact run/attempt, job names, result, and explicit skipped jobs |
| Authorities | separate worker claims, runtime observations, host verification, and independent review references |
| Limits | residual risks, unsupported hosts/platforms, invalidation triggers, superseded record if any |

Do not store raw prompts, private transcripts, credentials, provider session IDs, process IDs/tokens, usernames, home paths, or unredacted logs.

### 6.4 Freshness and invalidation

- Immutable records are never overwritten. The ledger states whether each is current, historical, or invalidated.
- Any source change inside a phase scope invalidates that phase's deterministic proof unless the scope manifest explicitly excludes evidence-only files.
- Worker schema, state, or broker changes invalidate Phase 1 and downstream cursor, restart, and compatibility gates.
- MCP manifest, authority code, installed digest, or Codex version changes invalidate Phase 1 and Phase 4 live identity/install gates.
- Mailbox, context, role, ACP, or Grok version changes invalidate Phase 2 and downstream provider gates.
- Git, worktree, artifact, or integration changes invalidate Phase 3 and downstream isolation gates.
- Adapter or UI changes invalidate Phase 4 presentation gates.
- Node major, lockfile, packaging, host, provider, or platform changes invalidate the affected matrix cells.
- Any non-evidence source change invalidates the aggregate Phase 5 qualification.
- Evidence-record-only commits may be excluded from the source digest; evidence schema, validator, and harness code may not.
- A review is valid only for the exact commit inspected.
- After merge, rerun mandatory gates on the merge commit if its tree differs from the qualified PR head.

A phase may remain historically delivered while its current qualification becomes stale. Final readiness always requires current aggregate qualification.

## 7. Phase registry

| Phase | Current state | Current deliverable | Blocking gap |
| --- | --- | --- | --- |
| 0 — Baseline and evidence | `verified_on_draft` | Evidence schema, ledger, capture/verify CLI, invalidation tests | Live installed natural Codex + authenticated Grok qualification residual |
| 1A — Worker Protocol | `verified_on_draft` | Public schemas + handle/snapshot/cursor foundation | Live host qualification residual |
| 1B — Read-only broker | `verified_on_draft` | Owned reads + MCP protocol pin + capability matrix | Live host qualification residual |
| 1C — Spawn/cancel/reconcile | `verified_on_draft` | Idempotent read-only spawn, cancel receipts, trusted reconciler | Live provider orchestration residual; write spawn still gated |
| 2 — Mailbox/context/roles | `verified_on_draft` | Mailbox send/followup, explicit-envelope context, immutable roles | Strong exactly-once / recent:N blocked on ACP+transcript proof (honest residual) |
| 3 — Worktrees/artifacts | `verified_on_draft` | controlWorkspaceId/controlRoot, worktrees, artifact manifests, isolation gates | Broker write spawn remains default-disabled pending host integration productization |
| 4 — Host presentation | `verified_on_draft` | Structured presentation, aliases, capability fallbacks, external-worker labeling | Natural-host end-to-end residual |
| 5 — Side-by-side qualification | `implemented_unverified` | Deterministic safety proofs + aggregate evidence records | Live side-by-side natural/Grok qualification residual; do not close #25 yet |

## 8. Phase 0 — Baseline and evidence system

### Goal

Establish a reproducible regression baseline and a validator that can reject missing, stale, dirty-tree, wrong-install, wrong-runtime, or historically promoted proof. Phase 0 establishes the harness; exact final qualification is repeated on the final Phase 5 source.

### Expected deliverables

| ID | Deliverable | Current state | Expected artifact |
| --- | --- | --- | --- |
| P0-D1 | Baseline capability and platform matrix | `implemented_unverified` | Plan registry plus validator fixture |
| P0-D2 | Machine-readable evidence schema | `not_started` | `plugins/grok/schemas/worker-broker-evidence.schema.json` |
| P0-D3 | Evidence capture, replay, and strict validator | `not_started` | `scripts/worker-broker-evidence.mjs` and package commands |
| P0-D4 | Immutable phase records and current-head ledger | `not_started` | `tests/e2e-results/worker-broker/ledger.json` plus phase records |
| P0-D5 | Exact-source provider-neutral baseline | `verified_on_draft` | CI run and local command records for PR #26 |
| P0-D6 | Exact-source installed natural Codex flow | `not_started` | Installed artifact record plus natural task trace |
| P0-D7 | Current macOS authenticated Grok lifecycle | `not_started` | Redacted provider qualification record |
| P0-D8 | Honest platform declarations | `verified_on_draft` | Linux unqualified and Windows unsupported assertions |

### Work and gates

- [x] Identify validation, fake-provider, PTY-ingress, installed-Codex, and natural-Codex harnesses as the regression baseline.
- [x] Mark the July 13 macOS provider record as historical and non-qualifying for the current contract.
- [x] Keep Linux provider execution explicitly unqualified.
- [x] Keep Windows provider execution and process control unsupported; run provider-neutral tests only.
- [ ] Add the evidence JSON schema, ledger schema, capture utility, and strict verifier.
- [ ] Bind records to full source commit/tree/digest, clean-tree state, installed digest, runtime versions, commands, assertions, and residual gaps.
- [ ] Prove an evidence-only record can be committed without invalidating its own source digest and any later relevant source change does invalidate it.
- [ ] Produce a clean installed snapshot from the exact tested source and prove source/install inventory equality.
- [ ] Run authenticated installed-Codex natural orchestration without manual shell interaction.
- [ ] Record current macOS provider lifecycle evidence for the same source/install boundary.

### Verification procedure

```sh
npm ci
npm run check
npm run test:pty-ingress
npm run test:installed-codex
npm run test:natural-codex
GROK_E2E=1 GROK_E2E_CANCEL=1 npm run test:e2e
git diff --check
```

Also run fake-provider read/write, resume, cancellation, recursion denial, credential cleanup, secret-sentinel, and crash-recovery negatives. Install into a clean marketplace/cache location, start a fresh host task, and prove no source-tree bypass. Record exact source and installed inventory digests.

### Required evidence

- Full command outcomes and CI matrix, including skipped jobs.
- Exact source, tree, clean status, source digest, installed digest, and runtime versions.
- Installed natural Codex structured trace with no manual shell step.
- Current authenticated macOS lifecycle scenarios.
- Explicit unqualified/unsupported platform cells.

### Exit definition

The strict verifier rejects stale, missing, dirty, mismatched-install, or historical evidence; all baseline commands pass; exact-source installed natural Codex and authenticated macOS lifecycle records exist. Downstream work may continue before provider qualification, but it may not inherit or claim the missing boundary.

## 9. Phase 1 — Structured Worker API and durable events

Phase 1 is intentionally split so completed read-only slices remain visible without falsely marking mutation and recovery complete.

### Phase 1A — Worker Protocol foundation

Current state: `verified_on_draft`

Implementation commit: [`bbae194`](https://github.com/xliberty2008x/grok-plugin/commit/bbae1948e91829ffe1b95e114072ec7bf78661f3)

#### Expected deliverables

| ID | Deliverable | Current state |
| --- | --- | --- |
| P1A-D1 | Provider-neutral WorkerHandle and WorkerSnapshot v1 projections | `verified_on_draft` |
| P1A-D2 | Durable monotonic retained lifecycle sequences | `verified_on_draft` |
| P1A-D3 | Worker-bound reconnect cursors with gap reporting | `verified_on_draft` |
| P1A-D4 | Opaque host-task correlation, lineage, context, workspace, and profile metadata | `verified_on_draft` |
| P1A-D5 | Recursive privacy filtering of runtime, process, prompt, session, and secret fields | `verified_on_draft` |
| P1A-D6 | Published WorkerHandle/Event/Snapshot/Result/Error schemas | `not_started` |
| P1A-D7 | Schema conformance fixtures and compatibility policy | `not_started` |

#### Remaining gates

- Publish machine-readable schemas for WorkerHandle, WorkerEvent, WorkerSnapshot, WorkerResult, cursor, and public WorkerError.
- Define additive versus breaking changes and reject unsupported schema versions.
- Add fixtures that deserialize the oldest supported record and reject malformed/future-incompatible inputs.
- Preserve `hostTaskBinding` as opaque correlation; never represent it as the raw host task ID.

### Phase 1B — Read-only broker

Current state: `verified_on_draft`

Implementation commit: [`dcb78b8`](https://github.com/xliberty2008x/grok-plugin/commit/dcb78b87e61969f99fb2c9cb0f1452aaa454ede0)

#### Expected deliverables

| ID | Deliverable | Current state |
| --- | --- | --- |
| P1B-D1 | Owned list, get, events-after, wait, and result operations | `verified_on_draft` |
| P1B-D2 | Authority resolution before identifiers, arguments, or cursors | `verified_on_draft` |
| P1B-D3 | Exact Codex-thread and canonical Git-workspace binding | `verified_on_draft` |
| P1B-D4 | Foreign/nonexistent observational equivalence | `verified_on_draft` |
| P1B-D5 | Side-effect-free reads and monotonic wait reauthorization | `verified_on_draft` |
| P1B-D6 | Plugin-bundled private STDIO MCP server | `verified_on_draft` |
| P1B-D7 | Supported MCP protocol pinning | `not_started` |
| P1B-D8 | Capability/version fallback matrix | `not_started` |

The private task-scoped STDIO MCP process is this phase's structured adapter. It is not the shared long-lived broker excluded from the v0.3 release contract.

Current live MCP probes prove packaging, task identity, workspace discovery, read isolation, and current Codex compatibility. They do **not** prove authenticated Grok orchestration or a stable public Codex metadata contract.

#### Remaining gates

- Pin and validate supported MCP protocol versions instead of echoing unknown future versions.
- Prove fail-closed behavior when required Codex metadata disappears, changes, conflicts, or is spoofed.
- Freeze plugin-ID requirements before exposing mutation-capable tools.
- Preserve CLI/skill/Claude command compatibility with golden tests.

### Phase 1C — Spawn, cancellation, and reconciliation

Current state: `not_started`

Expected deliverable: a safe initial mutation API. Broker-spawned write workers remain disabled until Phase 3; existing CLI write rescue remains available.

#### Expected deliverables

| ID | Deliverable | Current state |
| --- | --- | --- |
| P1C-D1 | Frozen exact-thread versus parent/subagent ownership semantics | `not_started` |
| P1C-D2 | Idempotent atomic spawn-request records | `not_started` |
| P1C-D3 | Idempotently requested spawn of a read-only worker using TaskEnvelope and ContextManifest | `not_started` |
| P1C-D4 | Idempotent cancellation receipt and single request event | `not_started` |
| P1C-D5 | Separately trusted reconciler that never replays prompts | `not_started` |
| P1C-D6 | Crash-point, restart, and compatibility tests | `not_started` |
| P1C-D7 | Exact-source Phase 1 evidence and fresh validation | `not_started` |

#### Architecture decisions before implementation

1. Decide whether ownership is exact-host-thread only or whether an explicit host-attested parent/subagent relationship can delegate access. Never infer ancestry from caller arguments.
2. Define spawn success as “durable job committed,” distinct from provider startup.
3. Require idempotency keys so a retried spawn cannot duplicate a job.
4. Use `cancel`, not `interrupt`, until pause/resume semantics exist and are honest.
5. Keep broker requests side-effect-free with respect to unrelated recovery. A separately trusted reconciler may clean verified owned processes or mark jobs lost, but it may never replay a prompt.
6. Freeze the cancellation metric: request accepted, process group gone, and terminal record committed are different timestamps. Do not claim the ten-second target until the selected definition is measured.

#### Verification procedure

```sh
node --test \
  tests/worker-protocol.test.mjs \
  tests/worker-service.test.mjs \
  tests/mcp-worker-broker.test.mjs \
  tests/codex-support.test.mjs
npm run check
git diff --check
```

Add scenarios for:

- owner success and foreign-task/nonexistent equivalence with a known worker ID;
- missing, malformed, mismatched, and spoofed authority metadata;
- symlinked roots/state, malformed MCP, unsupported protocol, redaction, and secret sentinels;
- broker/process restart with no committed event loss or duplication;
- crash before commit, after commit/before launch, during launch, during execution, and during terminal persistence;
- no replay after possibly mutating provider dispatch;
- spawn retry idempotency and cancellation retry idempotency;
- one cancellation-request event and verified owned-process targeting;
- all existing CLI, skills, and Claude compatibility commands.

### Phase 1 exit definition

All v1 public schemas, idempotent spawn of read-only workers, owned list/get/events/wait/result/cancel, protocol negotiation, restart/reconcile rules, compatibility tests, exact-source evidence, and fresh independent validation pass. Phase 1 remains open while spawn, cancel, restart proof, or full schemas are absent.

## 10. Phase 2 — Mailbox, follow-up, context packets, and roles

Current state: `not_started`

### Goal

Add durable, authority-bound communication and lineage-preserving follow-up without inventing mid-turn steering, hidden context access, or exactly-once delivery guarantees that ACP cannot support.

### Expected deliverables

| ID | Deliverable | Current state |
| --- | --- | --- |
| P2-D1 | ACP safe-boundary acknowledgement/dedup feasibility record | `not_started` |
| P2-D2 | Mailbox Protocol v1 with ordered durable message records | `not_started` |
| P2-D3 | Delivery state machine and immutable receipts | `not_started` |
| P2-D4 | Active `send` and terminal/idle lineage `followup` | `not_started` |
| P2-D5 | Context Packet v1 with explicit provenance and omissions | `not_started` |
| P2-D6 | Immutable explorer/implementer/reviewer/security/test roles | `not_started` |
| P2-D7 | `awaiting_host_action` capability-request state | `not_started` |
| P2-D8 | Crash, ordering, privacy, drift, and escalation tests | `not_started` |

### Architecture gates

- Spike ACP boundary delivery and determine whether provider acknowledgement or a provider deduplication key exists.
- Until that proof exists, use delivery states `accepted`, `pending`, `delivered`, `delivery_unknown`, and `rejected`. Never automatically retry `delivery_unknown`.
- Claim exactly-once delivery only if acknowledgement/dedup makes it provable across crash. Otherwise promise durable acceptance plus explicit ambiguity.
- MCP metadata does not supply conversation content. Implement `explicit-envelope` first. Enable `recent:N` and `all-user-visible` only after a trusted, privacy-filtered transcript acquisition path is proven. `none` is always safe.
- Record source, precedence, omissions, bounds, and digest for every context packet without exporting hidden host records.
- A worker may request authority through `awaiting_host_action`; only the host may grant a new profile.

### Verification scenarios

- Duplicate submission and retry before/after persistence.
- Crash before provider delivery, after delivery but before receipt, and after acknowledgement.
- Concurrent message ordering and bounded queue behavior.
- Active versus terminal misuse and foreign-lineage access.
- Follow-up with exact parent/lineage plus context/profile drift rejection.
- Hidden system/developer/tool sentinel exclusion and allowed user-visible sentinel inclusion.
- Repository prompt injection attempting to change instruction precedence.
- Role digest mismatch and worker self-approval attempts.
- Provider lacking safe-boundary delivery, acknowledgement, or dedup capability.

### Required evidence

One live scenario must queue multiple messages during a bounded long-running job, restart the broker, and account for each message exactly once as `delivered`, `rejected`, or `delivery_unknown`. A terminal follow-up must prove parent/lineage and context/profile identity. Raw message bodies are excluded from evidence.

### Exit definition

Mailbox guarantees match proven ACP capability; every accepted message has an explicit durable outcome; no ambiguous message is automatically retried; follow-up lineage and context/profile drift are enforced; hidden context and capability escalation tests pass; exact-source evidence and fresh validation exist.

## 11. Phase 3 — Isolated write worktrees and integration artifacts

Current state: `blocked`

### Goal

Move write workers out of the parent checkout, support safe parallel separable writers, and make integration an explicit host-owned decision backed by tamper-evident artifacts.

### Blocking architecture decision

Current state and admission are keyed from the canonical checkout path. Linked worktrees would receive separate job stores and locks, making child jobs invisible to the parent and allowing unsafe parallel admission. Before creating worktrees, introduce distinct identities:

- `controlWorkspaceId`: stable identity shared by all linked worktrees of one repository control plane;
- `controlRoot`: host-owned root for state, lineage, admission, and integration decisions;
- `executionRoot`: the specific isolated worktree used by one worker.

Locks must be shared through the Git common directory or an equally stable control-plane identity. Migration must preserve access to existing records without widening authority.

### Expected deliverables

| ID | Deliverable | Current state |
| --- | --- | --- |
| P3-D1 | Control-workspace identity and compatible state migration | `not_started` |
| P3-D2 | Shared admission/lineage locks across linked worktrees | `not_started` |
| P3-D3 | Host-owned worktree manager from exact base commits | `not_started` |
| P3-D4 | Explicit dirty-source materialization contract | `not_started` |
| P3-D5 | Artifact Manifest v1 with hashes and scope results | `not_started` |
| P3-D6 | Preview, conflict, integration, verification, retention, and cleanup workflow | `not_started` |
| P3-D7 | Fault-injection and adversarial path tests | `not_started` |

### Work and gates

- Create collision-free branches and worktree paths from exact base commits.
- Define materialization for staged, unstaged, untracked, binary, symlink, mode, submodule, ignored, and LFS state.
- Keep parent files and index unchanged before explicit integration; document expected shared Git metadata changes.
- Permit parallel writers only in distinct worktrees with non-overlapping contracts.
- Produce a hashed manifest containing worker, lineage, control identity, base, source overlay, resulting head/tree, patch digest, changed paths/types, scope result, and worker verification.
- Validate path traversal, symlinks, binary changes, ignored paths, scope, manifest tampering, base drift, and conflicts before integration.
- Never automatically cherry-pick or apply changes into the parent checkout.
- Re-run host verification after explicit integration; worker-tree checks do not qualify the integrated parent.
- Retain worktrees and artifacts until verified integration or explicit safe cleanup.

### Verification scenarios

- Two separable real writers run concurrently in distinct worktrees while parent status/tree/index remain unchanged.
- Overlapping contracts are rejected by shared admission.
- Wrong base, patch tampering, malicious path, symlink escape, ignored-path change, and out-of-scope write are blocked.
- Integration conflict and base drift prevent readiness.
- Checks that pass in the worker tree but fail after integration keep host verification failed.
- Crash during create, provider execution, artifact capture, integration, and cleanup leaves recoverable, non-replayed state.
- Cleanup while active or before retained evidence is rejected.

### Exit definition

Stable control identity and shared admission are proven; parent content is unchanged before explicit integration; artifact identity and scope are validated; conflicts and malicious paths block readiness; host checks rerun after integration; exact-source evidence and fresh validation exist.

## 12. Phase 4 — Native-feeling host adapters and presentation

Current state: `implemented_unverified`

The Phase 1 cursor/long-poll primitive arrived early and is checked as a completed slice. The phase remains open because no native-feeling adapter, aliases/tree, dashboard decision, or natural-host qualification exists.

### Expected deliverables

| ID | Deliverable | Current state |
| --- | --- | --- |
| P4-D1 | Structured Codex adapter with no shell-text parsing | `not_started` |
| P4-D2 | Spoof-resistant aliases and parent/lineage task tree | `not_started` |
| P4-D3 | Structured phase, plan, heartbeat, cursor, status, and result presentation | `not_started` |
| P4-D4 | Bounded cursor/long-poll call semantics | `verified_on_draft` |
| P4-D5 | Compatibility Claude presentation and fallback policy | `not_started` |
| P4-D6 | Honest external-worker labeling | `not_started` |
| P4-D7 | Optional dashboard ADR and separately gated implementation | `not_started` |
| P4-D8 | Official native extension adoption, if an API exists | `deferred` |

### Work and gates

- Render only structured public schemas; never infer status or actions from provider prose or shell output.
- Persist aliases with collision and spoofing protection.
- Keep model-visible data task-authorized and privacy filtered.
- Label Grok workers distinctly from genuine native host agents.
- Keep Claude on compatibility commands until an equally trustworthy structured identity surface is proven.
- Define capability guards and fallbacks for changes to currently undocumented Codex MCP metadata.
- Treat a dashboard as optional unless an ADR freezes its exact MVP and authorization model.
- Adopt a native subagent provider extension only after an official host contract exists and is independently reviewed.

### Verification scenarios

- Brand-new installed natural Codex task performs list, spawn, wait, message/follow-up, cancel, and result without manual shell interaction.
- Each advertised Claude adapter flow runs naturally through a clean installed plugin.
- Restart, stale cursor, retention gap, inaccessible worker, and degraded capability render bounded honest state.
- Raw prompts, private paths, credentials, process identity, and secret sentinels never appear.
- Repository/provider output injection cannot create actions or false success.
- If a dashboard ships, add authorization, accessibility, keyboard, compact-state, and visual regression checks; screenshots supplement structured traces only.

### Exit definition

Natural installed host flows operate through structured adapters without shell parsing; degraded capability fails closed or uses a documented compatibility fallback; Grok workers remain honestly labeled; privacy and injection tests pass; exact-source evidence and fresh validation exist.

## 13. Phase 5 — Side-by-side qualification and closeout

Current state: `not_started`

### Goal

Compare equivalent native and Grok control loops, measure the promised behavior, inject failures, and publish one aggregate qualification record for the final source/install/runtime identity.

### Expected deliverables

| ID | Deliverable | Current state |
| --- | --- | --- |
| P5-D1 | Paired native/Grok scenario corpus | `not_started` |
| P5-D2 | Metric and bounded-sample harness | `not_started` |
| P5-D3 | Context fidelity and failure-injection fixtures | `not_started` |
| P5-D4 | Exact-source aggregate qualification record | `not_started` |
| P5-D5 | Native parity scorecard and remaining-gap report | `not_started` |
| P5-D6 | Final evidence replay and issue closeout | `not_started` |

### Scenario corpus

Create equivalent bounded fixtures for:

- repository investigation;
- read-only implementation planning;
- bounded code implementation and host integration;
- active message delivery and terminal follow-up;
- cancellation during startup and execution;
- broker/provider crash recovery;
- independent review;
- parallel isolated writers;
- integration conflict and scope violation.

### Measurements

Run at least five bounded samples per timing scenario and retain redacted measurements plus p50, p95, and maximum for:

- spawn request to durable-handle commit;
- committed event to waiter visibility;
- independent broker heartbeat interval;
- cancellation request, verified process-group cleanup, and terminal-record commit;
- mailbox acceptance and explicit delivery outcome;
- context fidelity and hidden-sentinel exclusion;
- retries, duplicates, conflicts, and scope rejection.

### Mandatory safety proofs

- A possibly mutating prompt is never automatically replayed after crash.
- Provider success cannot set host verification to passed.
- Two isolated writers cannot mutate the parent checkout before explicit integration.
- Foreign tasks/workspaces cannot distinguish known inaccessible IDs from nonexistent IDs.
- Model, provider, authentication, schema, lifecycle, and unsupported-capability failures remain explicit and typed.
- Installed natural Codex orchestration requires no manual shell interaction.
- Compatibility commands and the declared OS/Node matrix remain green.
- Final source, source digest, installed artifact digest, runtime versions, scenarios, and outcomes are bound in validated evidence.

### Exit definition

Every mandatory Phase 0–4 gate is current for the final tree; the aggregate evidence verifier passes; required installed/live boundaries pass on the same source/install identity; unsupported platforms and remaining native gaps are explicit; issue #25 links the final evidence and can be closed without relying on historical proof.

## 14. Acceptance-target definitions

Targets are not met until their measurement definitions and evidence exist:

| Target | Measurement definition |
| --- | --- |
| Durable spawn under 1 second | Broker accepts request to atomic durable job record/handle commit; provider startup excluded. |
| No event loss or duplication | Restart from persisted state, replay from last acknowledged cursor, compare stable event IDs/sequences, and account for retention gaps. |
| Heartbeat within 15 seconds | Broker-owned heartbeat generated independently of provider chatter while the job is active. |
| Terminal visibility within 2 seconds | Terminal record commit to active waiter's structured terminal event receipt. |
| Message outcome | Every accepted ID ends as delivered, rejected, or delivery_unknown; exactly-once is claimed only with proven acknowledgement/dedup. |
| Cancellation within 10 seconds | Record request accepted, process group gone, and terminal record committed separately; freeze which timestamp is the contractual target before qualification. |
| No mutating replay | Fault injection after possible provider dispatch proves recovery never resubmits the prompt. |
| Parent checkout isolation | Parent files, index, and tree remain unchanged until explicit integration; expected shared Git metadata is separately recorded. |
| Conflict/scope detection | Wrong base, conflict, malicious path, and out-of-scope artifact block readiness before integration. |
| Host verification authority | No provider/runtime path can write `hostVerification: passed`; only host-owned post-result/integration checks can. |

## 15. Current implementation evidence

### Phase 1A/1B snapshot

- Worker Protocol foundation: `bbae1948e91829ffe1b95e114072ec7bf78661f3`.
- Read-only MCP broker: `dcb78b87e61969f99fb2c9cb0f1452aaa454ede0`.
- Source tree: `99547ef79ecbfb9efe1c91327f5778122c94c13c`.
- Plugin version: `0.3.0-dev.1`.
- Evidence record: [tests/e2e-results/worker-broker/phase-1-readonly-dcb78b8.json](tests/e2e-results/worker-broker/phase-1-readonly-dcb78b8.json).
- PR: [#26](https://github.com/xliberty2008x/grok-plugin/pull/26).
- CI: [run 29431061793](https://github.com/xliberty2008x/grok-plugin/actions/runs/29431061793).

Verified on the draft:

- `npm run check`: 227 passed, 1 expected authenticated-provider skip, 0 failed.
- Focused Worker Protocol/service/broker/Codex suite: 24 passed, 0 failed.
- `git diff --check`: passed.
- `npm run codex:update-local`: full check, installed-Codex PTY gate, cache refresh, and source/cache inventory equality passed.
- Installed snapshot: 71 files; digest `55c1e08be8faeddf98d1d8edb77e833ad0c7f9727c7c5c79f87e6f83efd32f46`.
- Standalone Codex CLI 0.143.0, Codex Desktop bundled CLI 0.144.2, and a fresh installed-plugin task discovered and called the read-only broker.
- A known worker read from a foreign fresh task returned the same public `E_JOB_NOT_FOUND` class used for missing workers.
- Fresh native review recorded GO with no P0–P2 findings; protocol-version pinning remained a deferred P3 concern for this read-only slice.

GitHub CI independently passed Ubuntu and macOS Node 18/22, Windows provider-neutral Node 18/22, and Ubuntu/macOS PTY ingress. The protected Installed Codex and Natural Codex jobs were **skipped**. Therefore the current record is strong provider-neutral implementation evidence, not full Phase 1 or release qualification.

### Open proof gaps

- Full event/result/error schemas and compatibility fixtures.
- Supported MCP protocol pinning and capability drift matrix.
- Parent/subagent ownership semantics.
- Spawn, cancel, and separately trusted reconciliation.
- Two-process broker restart/reconnect proof.
- Authenticated natural host orchestration for the exact source/install identity.
- Phase 2 mailbox/context feasibility, Phase 3 isolation, Phase 4 adapter, and Phase 5 comparison.

## 16. Issue and PR synchronization

Issue #25 must link this plan near the top and use stable deliverable IDs. The issue is a concise human mirror; this plan and immutable evidence are authoritative.

For every delivery:

1. Keep the top-level phase unchecked until its exit definition is met.
2. Check only nested slices with exact commit, PR, and evidence references.
3. Label partial work explicitly; never collapse `verified_on_draft` into `qualified`.
4. Add an issue comment recording the status delta, plan/evidence commit, replay commands, outcomes, and residual gaps so history remains append-only.
5. Update the PR body with the current plan/evidence links when the PR carries the work.
6. Use `Refs #25`, not `Closes #25`, until all mandatory Phase 5 closeout gates pass.
7. Do not close #25 from a worker report, skipped mandatory CI job, historical record, or source/install mismatch.

## 17. Next execution order

1. Complete Phase 0's evidence schema, validator, ledger, and invalidation tests.
2. Freeze Phase 1C ownership, idempotency, cancellation metric, and trusted reconciliation decisions.
3. Finish Phase 1 schemas/protocol pinning, then implement idempotent spawn of read-only workers and idempotent cancel as separate bounded slices.
4. Run the Phase 2 ACP acknowledgement/dedup and transcript-acquisition spikes before promising mailbox or context guarantees.
5. Redesign control-workspace identity before any Phase 3 worktree implementation.
6. Build the Phase 4 structured host adapter only on the stable Phase 1–3 contracts.
7. Run Phase 5 aggregate qualification on the final exact source and installed artifact.

This order is intentionally evidence-first: later execution should leave enough durable identity, commands, negative scenarios, and boundary-specific proof for a fresh main Codex session to determine what is implemented, what is verified, what is qualified, and exactly what must be rerun.
