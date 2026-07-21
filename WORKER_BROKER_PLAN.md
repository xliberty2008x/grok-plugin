# Native-like Grok Worker Broker execution and evidence plan

Status: Active roadmap; foundations are implemented but unverified in the current working tree and the work is not release-qualified

Roadmap version: `1.0`

Audit snapshot: `2026-07-21`

Canonical issue: [#25 — Make Grok Companion workers native-like through a structured worker broker](https://github.com/xliberty2008x/grok-plugin/issues/25)

Current delivery PR: [#26 — Worker Protocol v1 and read-only MCP broker](https://github.com/xliberty2008x/grok-plugin/pull/26)

Related contracts: [SPEC.md](SPEC.md), [PLAN.md](PLAN.md), and the draft [Native MCP Control Surface enhancement ADR](docs/superpowers/specs/2026-07-16-native-mcp-control-surface-design.md)

## 1. Current truth and document authority

This document is the durable execution, verification, and remediation plan for issue #25. The issue is the concise progress mirror; source, immutable evidence, and successful replay commands are authoritative.

The post-implementation audit found substantial Phase 0–4 foundations and Phase 5 safety tests in the working tree. It also found that the current ledger records were produced for an older source identity and older evidence shape. The hardened strict verifier rejects those records. Therefore this plan does not inherit their `verified_on_draft` labels.

Current conservative phase status:

| Phase | Current state | What exists | Why the phase is not complete |
| --- | --- | --- | --- |
| 0 — Evidence system | `implemented_unverified` | Schema, validator, capture/verify CLI, phase scopes, immutable-record and ledger logic, fail-closed tests | Current records must be superseded from a clean integrated commit with complete gate metadata and prerequisite closure |
| 1 — Worker API | `implemented_unverified` | Protocol/schema projections, durable events/cursors, authority-bound reads, spawn/cancel/reconcile foundations | No current exact-source evidence; complete restart, compatibility, installed-host, and live orchestration exit criteria are not proven |
| 2 — Mailbox/context/roles | `implemented_unverified` | Durable mailbox/follow-up, explicit-envelope context, immutable roles, ambiguity handling | No current exact-source record or live ACP acknowledgement/dedup proof; strong transcript modes remain capability-gated |
| 3 — Worktrees/artifacts | `implemented_unverified` | Control-workspace identity, shared state, clean-parent rejection/fingerprinting, worktree and artifact validation foundations | No current exact-source record or natural-host proof of concurrent real writers and explicit parent integration; dirty-source materialization is not implemented |
| 4 — Host presentation | `implemented_unverified` | Structured presentation, aliases/tree, capability fallbacks, external-worker labeling | No current exact-source record or installed natural Codex/Claude end-to-end proof |
| 5 — Qualification | `implemented_unverified` | Deterministic safety-proof tests only | Paired native/Grok corpus, measurements, live boundaries, aggregate record, and release decision are not complete |

Issue #25 must remain open. This plan does not claim live provider proof, installed-host proof, natural-host proof, aggregate qualification, or release readiness.

The Native MCP Control Surface ADR is a follow-on design, not evidence that its E0-E7 execution slices are delivered. In particular, the production provider-launch adapter, live mailbox delivery/follow-up adapter, native-shaped MCP facade and multi-wait, host-verification operation, skill preference changes, and natural MCP execution-loop proof remain future work. They must enter this plan as separately bounded deliveries with the same exact-source evidence rules before any related checklist item can be marked complete.

## 2. Outcome and scope boundaries

The outcome is a provider-neutral Worker Broker that lets Codex and compatible Claude hosts control Grok Companion workers through durable structured operations while the host retains authority over architecture, permissions, integration, verification, and readiness.

The target is control-loop parity, not a claim that Grok jobs are native Codex agent threads. The completed system should support:

- durable spawn, inspect, wait, result, message, follow-up, and cancellation operations;
- exact lineage, bounded context provenance, workspace identity, and security-profile identity;
- reconnectable events and crash behavior that never silently replays a possibly mutating prompt;
- isolated write worktrees with explicit host-owned integration;
- compact host presentation built from structured records rather than shell-text parsing;
- side-by-side native and Grok qualification with honest remaining-gap reporting.

In scope:

- Worker Protocol schemas and durable lifecycle events.
- A plugin-bundled, task-authorized local MCP surface.
- Safe mutations with explicit authority, idempotency, and recovery semantics.
- Durable mailbox, follow-up, context packets, and immutable roles.
- Host-owned worktree isolation, artifact manifests, integration, and cleanup.
- Codex and compatibility Claude presentation paths.
- Evidence capture, validation, invalidation, supersession, and side-by-side qualification.

Non-goals:

- Representing an external Grok worker as a genuine native host subagent.
- Exporting hidden system/developer instructions, reasoning, credentials, raw transcripts, process identity, or private tool records.
- Letting a worker expand its scope, tools, permissions, role, or data authority.
- Letting provider completion set host verification to passed.
- Automatically retrying work whose provider-delivery outcome is ambiguous.
- Making recursive Grok delegation or a dashboard mandatory for parity.
- Replacing main Codex as planner, integrator, authoritative verifier, or readiness owner.

## 3. Status and proof vocabulary

| State | Meaning |
| --- | --- |
| `not_started` | The contract may be described, but no usable implementation exists. |
| `implemented_unverified` | Code or documentation exists, but required proof is missing, stale, dirty-tree-bound, or failing. |
| `verified_on_draft` | All mandatory deterministic gates passed on one exact clean unmerged commit and a strict current evidence record validates. |
| `qualified` | Deterministic, installed-host, provider, and release boundaries required by the phase passed for the same source/install/runtime identity. |
| `blocked` | A named authority, safety, or architecture decision prevents safe progress. |
| `deferred` | Intentionally outside the current phase or release scope. |

Rules:

1. Implementation presence is not verification.
2. A test summary, PR statement, issue checkbox, screenshot, worker report, or reviewer opinion is not an evidence record.
3. `skip` and `not_run` cannot satisfy `verified_on_draft` or `qualified`.
4. Historical and invalidated records remain readable and tamper-checked, but can never satisfy current prerequisites or qualification.
5. Every current prerequisite names the exact predecessor record digest and mandatory passed gate IDs.
6. A source, phase-scope, install, host, provider, or runtime identity change invalidates the boundary it affects.
7. Final readiness requires one current aggregate Phase 5 record; per-phase records alone are insufficient.

## 4. Ownership, delegation, and review failures

Main Codex owns requirements, architecture, task decomposition, integration, evidence inspection, authoritative verification, issue synchronization, and the final readiness decision.

Native Codex subagents provide independent investigation, architecture/security challenge, and fresh validation. Grok Companion is the primary bounded implementation worker after the main thread freezes objective, scope, write boundaries, constraints, non-goals, acceptance criteria, and required checks. Worker output is input to integration, never authoritative proof.

During this audit a Grok review lifecycle returned an explicit `E_STATE` failure. The fallback was native/manual inspection and remediation. That fallback preserves progress, but neither the failed Grok lifecycle nor the fallback review qualifies any phase. If independent Grok review is desired, retry it only after the lifecycle state is healthy and bind the result to the exact clean commit; still treat it as an additional review lens, not verification.

Do not hide concrete provider, authentication, schema, timeout, lifecycle, or unsupported-capability failures. Record the error class and use the authorized fallback without converting the failed attempt into a passed gate.

## 5. Evidence and authoritative verification protocol

### Evidence boundaries

Evidence must separate four qualification boundaries:

| Boundary | Required meaning |
| --- | --- |
| `deterministic` | Source-bound repository checks, focused tests, negative scenarios, clean tree, and phase-scope digest passed. |
| `installedHost` | The exact tested plugin was installed; source/install inventory identity and natural host behavior passed. |
| `provider` | Authenticated Grok lifecycle scenarios passed on the recorded provider version/revision. |
| `release` | Required CI jobs and aggregate Phase 5 checks passed for the final source/install/runtime identity. |

Each passed command record must include a stable gate ID, exact command or argv, boundary, start/end timestamps, exit code, bounded output digest, and outcome. Evidence stores assertions and digests, not secret-bearing raw logs.

### Completion protocol

For every phase or bounded delivery slice:

1. Freeze objective, scope, non-goals, write boundary, acceptance criteria, and required gate IDs.
2. Record repository, upstream, branch, base commit, and intended phase-scope paths.
3. Implement without overlapping writers on shared files or state.
4. Inspect the integrated diff, privacy surfaces, migrations, failure paths, and compatibility boundaries.
5. Commit the integrated source and require a clean non-evidence working tree.
6. Run focused tests, `npm run check`, and commit-bound `git show --check --format= HEAD` on that exact commit.
7. Run phase-specific negative, crash, authorization, and concurrency scenarios.
8. If claiming an installed or provider boundary, test the exact installed artifact and record runtime versions and inventory equality.
9. Obtain fresh independent native validation for phase-completing or security-sensitive work.
10. Write a new immutable record with canonical `recordDigest`; never edit an existing record in place.
11. Supersede the previous ledger entry, preserve it as historical, and verify prerequisite digest closure.
12. Run strict replay. Update this plan and issue #25 only from the result.

### Durable artifacts

- Schema: [plugins/grok/schemas/worker-broker-evidence.schema.json](plugins/grok/schemas/worker-broker-evidence.schema.json)
- Validator/library: [scripts/lib/worker-broker-evidence.mjs](scripts/lib/worker-broker-evidence.mjs)
- CLI: [scripts/worker-broker-evidence.mjs](scripts/worker-broker-evidence.mjs)
- Ledger: [tests/e2e-results/worker-broker/ledger.json](tests/e2e-results/worker-broker/ledger.json)
- Immutable records: `tests/e2e-results/worker-broker/phase-<N>/<source-prefix>-<record-prefix>.json`
- Aggregate records: `tests/e2e-results/worker-broker/aggregate/<source-prefix>-<record-prefix>.json`

The current ledger records are legacy/stale for the integrated work. They must remain immutable and be superseded, not rewritten. Historical compatibility requires safe paths, readable JSON, canonical digest, and ledger identity consistency, while deliberately excluding history from current prerequisite resolution.

### Exact replay commands

Current audit replay:

```sh
node --test tests/worker-broker-evidence.test.mjs
npm run validate
npm run worker:verify -- --all --strict
npm run worker:verify -- --all --strict --require-complete
```

At this audit snapshot, the focused evidence tests and validator pass, while both strict all-phase commands return nonzero because the current ledger records are stale and predate the hardened gate/qualification/prerequisite contract. `--require-complete` additionally reports that current qualified records for Phases 0–5 and `aggregate` are missing. Those failures are expected migration evidence, not phase completion.

`--all --strict` is an integrity/freshness replay. It may pass for an honestly incomplete `implemented_unverified` ledger and therefore is never a completion claim. Release readiness additionally requires `--require-complete`, which fails unless current qualified records exist for Phases 0–5 and `aggregate`, with aggregate release/CI proof.

Deterministic integrated replay after all code is committed:

```sh
npm ci
npm run check
git show --check --format= HEAD
npm run worker:evidence -- status --strict
npm run worker:verify -- --all --strict
```

Installed and live commands, run only in an authorized clean environment with credentials excluded from logs:

```sh
npm run codex:update-local
npm run test:installed-codex
npm run test:natural-codex
GROK_E2E=1 GROK_E2E_CANCEL=1 npm run test:e2e
```

The current capture command records identity and an honest `implemented_unverified` result only:

```sh
npm run worker:evidence -- capture --phase <N> --slice <slice-id> --write
```

It must not promote a phase. Phase 0 now has a code-owned execution-only proof producer; it accepts no caller-supplied command, argv, outcome, environment, or result input:

```sh
npm run worker:prove -- --phase 0 --slice evidence-system --write
```

The producer runs the fixed Phase 0 manifest, binds a clean stable source identity before/after execution and publication, stores only bounded redacted output digests, and performs a locked fail-closed baseline cutover. Its implementation remains `implemented_unverified` until committed and used to publish a current exact-source immutable record. The current qualification command is also capture-only and exits nonzero when live work is skipped:

```sh
npm run worker:qualify -- --phase <N> --host <codex|claude-code> --record
```

No generic result-ingestion path is trusted. Later phase/live producers must add separately reviewed code-owned manifests or authenticated receipts rather than accepting caller-authored proof JSON.

## 6. Phase 0 — Baseline and evidence system

Current state: `implemented_unverified`

Phase 0 establishes the fail-closed evidence machinery used by every downstream phase.

### Phase 0 expected deliverables

| ID | Deliverable | Current state | Artifact or proof | Remaining work |
| --- | --- | --- | --- | --- |
| P0-D1 | Machine-readable evidence schema and nested allowlists | `implemented_unverified` | Evidence schema and validator | Bind to clean integrated commit and record passing schema tests |
| P0-D2 | Canonical digest, immutable write, safe ledger identity, historical compatibility | `implemented_unverified` | Evidence library and focused regression tests | Rerun after integration and preserve command outcome digest |
| P0-D3 | Phase scopes, mandatory gates, and prerequisite digest closure | `implemented_unverified` | Phase manifests in evidence library | Supersede all stale phase records with exact prerequisites |
| P0-D4 | Proof-producing capture/replay workflow | `implemented_unverified` | Fixed Phase 0 manifest, broker-owned producer provenance, bounded sanitized execution, private promotion authority, post-publication source recheck/rollback, strict resulting-ledger validation, and locked legacy-current cutover in evidence library/CLI; focused suite passes 50/50 | Commit this source slice; generalize the code-owned producer before final qualification, then publish Phase 0 only after all evidence-source changes are frozen |
| P0-D5 | Current immutable records and ledger | `implemented_unverified` | Existing records and ledger are migration inputs | Create new current records after clean commit; keep old entries historical |
| P0-D6 | Exact-source installed natural Codex proof | `not_started` | Installed inventory and natural-host trace | Install exact artifact and run natural task without source-tree bypass |
| P0-D7 | Current authenticated macOS Grok lifecycle proof | `not_started` | Redacted provider qualification record | Run provider lifecycle against same source/install identity |
| P0-D8 | Honest platform declarations | `implemented_unverified` | Limits in schema/records | Reconfirm Linux and Windows cells in final evidence |

### Phase 0 authoritative checks

```sh
node --test tests/worker-broker-evidence.test.mjs
npm run validate
npm run check
git show --check --format= HEAD
npm run worker:verify -- --phase 0 --strict
npm run worker:verify -- --all --strict
```

Required negative proof includes missing gate IDs, skipped mandatory gates, stale source/scope digests, dirty-tree claims, unknown/private nested fields, bad command outcomes, forged qualification, unsafe paths, duplicate current entries, stale prerequisites, historical tampering, and ledger identity mismatch.

Ledger mutation proof must also include concurrent distinct- and same-phase appends, crash recovery before publication and after transition publication, ownerless construction grace, live-owner non-stealing, malformed/unbound/symlink lock rejection, generation-safe successor survival, and raw/private publication rejection before filesystem creation. Unknown or PID-reuse liveness intentionally times out instead of stealing a possibly live evidence lock.

Phase 0 exits only when a clean exact-source current record passes strict verification and the superseded history remains readable but non-qualifying. Installed/provider qualification may remain a declared downstream gap, but it cannot be claimed or inherited.

## 7. Phase 1 — Structured Worker API and durable lifecycle

Current state: `implemented_unverified`

Phase 1 covers the public protocol, authority-bound read surface, safe initial mutations, cancellation, and recovery rules.

### Phase 1 expected deliverables

| ID | Deliverable | Current state | Artifact or proof | Remaining work |
| --- | --- | --- | --- | --- |
| P1-D1 | WorkerHandle/Event/Snapshot/Result/Error schemas and version policy | `implemented_unverified` | [worker-protocol.schema.json](plugins/grok/schemas/worker-protocol.schema.json), protocol tests | Exact-source schema conformance and oldest/future version fixtures in current record |
| P1-D2 | Durable monotonic events, bounded retention, worker-bound cursors and gaps | `implemented_unverified` | Worker protocol implementation/tests | Current restart/reconnect proof and evidence |
| P1-D3 | Authority-bound list/get/events/wait/result reads | `implemented_unverified` | Worker service and MCP broker tests | Exact-source spoof/conflict/privacy proof and installed-host replay |
| P1-D4 | Idempotent atomic read-only spawn | `implemented_unverified` | Worker mutation implementation/tests | Current crash/concurrency result, durable commit-before-launch proof, natural host flow |
| P1-D5 | Idempotent cancel receipt and one request event | `implemented_unverified` | Worker mutation implementation/tests | Measure request/process/terminal timestamps separately; live process-group proof |
| P1-D6 | Trusted reconciler that never replays prompts | `implemented_unverified` | Worker reconcile and safety tests | Two-process restart/crash replay on exact commit |
| P1-D7 | CLI/skill/Claude compatibility | `implemented_unverified` | Existing compatibility surface | Golden replay on final integrated source and clean install |
| P1-D8 | Authenticated provider orchestration | `not_started` | Provider-bound record | Run spawn/wait/cancel/result with exact installed artifact |

Write spawn remains gated until Phase 3 isolation and integration authority are proven. Spawn success means the durable job is committed; it is not provider-startup success.

### Phase 1 authoritative checks

```sh
node --test \
  tests/worker-protocol.test.mjs \
  tests/worker-service.test.mjs \
  tests/mcp-worker-broker.test.mjs \
  tests/worker-mutation.test.mjs \
  tests/worker-safety-proofs.test.mjs
npm run check
git show --check --format= HEAD
npm run worker:verify -- --phase 1 --strict
```

Required scenarios include owner success, foreign/nonexistent equivalence, missing/malformed/spoofed authority, unsupported protocol, cursor gaps, cross-process idempotency, crash before/after durable commit, cancel in the commit-to-launch window, no mutating replay, provider-launch failure preservation, and privacy sentinels.

Phase 1 exits only when all public schemas and operations pass on one clean exact commit, current Phase 0 prerequisite digest/gates close, restart/crash behavior is proven, and the current record validates. Installed/live boundaries remain separately named until run.

## 8. Phase 2 — Mailbox, follow-up, context packets, and roles

Current state: `implemented_unverified`

Phase 2 adds durable communication and lineage-preserving follow-up without inventing mid-turn steering or exactly-once guarantees that ACP cannot prove.

### Phase 2 expected deliverables

| ID | Deliverable | Current state | Artifact or proof | Remaining work |
| --- | --- | --- | --- | --- |
| P2-D1 | ACP acknowledgement/dedup capability record | `implemented_unverified` | Conservative spike fixture/test | Prove capability live; otherwise retain explicit ambiguity |
| P2-D2 | Ordered durable mailbox and outcome state machine | `implemented_unverified` | Worker mailbox implementation/tests | Current exact-source crash and multi-message record |
| P2-D3 | Active send and terminal/idle lineage follow-up | `implemented_unverified` | Mailbox/follow-up tests | Natural provider delivery/follow-up proof |
| P2-D4 | Explicit-envelope Context Packet v1 | `implemented_unverified` | Worker context implementation/tests | Exact-source privacy and provenance evidence |
| P2-D5 | `recent:N` and broader transcript modes | `implemented_unverified` | Capability gates exist | Trusted transcript acquisition remains unproven; keep modes fail-closed |
| P2-D6 | Immutable explorer/implementer/reviewer/security/test roles | `implemented_unverified` | Worker roles implementation/tests | Current role-digest and self-escalation proof |
| P2-D7 | `awaiting_host_action` authority request | `implemented_unverified` | Mailbox/role state model | Natural host grant/deny flow and evidence |

Delivery states remain `accepted`, `pending`, `delivered`, `delivery_unknown`, and `rejected`. Never automatically retry `delivery_unknown`. Exactly-once delivery may be claimed only with provider acknowledgement or deduplication proof across crash.

### Phase 2 authoritative checks

```sh
node --test \
  tests/worker-mailbox.test.mjs \
  tests/worker-context-roles.test.mjs
npm run check
git show --check --format= HEAD
npm run worker:verify -- --phase 2 --strict
```

Required live proof queues multiple messages during a bounded job, restarts the broker, and accounts for every message as delivered, rejected, or delivery_unknown. Follow-up must bind parent/lineage and reject context/profile drift. Evidence excludes raw message bodies and hidden host records.

Phase 2 exits only when guarantees match proven ACP capability, every accepted message has an explicit durable outcome, no ambiguity is auto-retried, hidden context and self-escalation tests pass, Phase 0/1 prerequisite digests close, and a current exact-source record validates.

## 9. Phase 3 — Isolated write worktrees and integration artifacts

Current state: `implemented_unverified`

Phase 3 moves write workers out of the parent checkout and keeps integration an explicit host-owned decision.

### Phase 3 expected deliverables

| ID | Deliverable | Current state | Artifact or proof | Remaining work |
| --- | --- | --- | --- | --- |
| P3-D1 | Stable `controlWorkspaceId`, `controlRoot`, and `executionRoot` | `implemented_unverified` | Workspace/worktree implementation/tests | Current exact-source migration and linked-root record |
| P3-D2 | Shared admission and lineage state across linked worktrees | `implemented_unverified` | State/worktree tests | Real concurrent admission proof |
| P3-D3 | Host-owned worktree creation from exact base | `implemented_unverified` | Worktree manager tests | Natural host create/run/retain/cleanup trace |
| P3-D4 | Clean-parent fingerprint and dirty-parent rejection | `implemented_unverified` | Parent fingerprint and negative integration tests | Bind tracked/untracked/ignored/binary/symlink/mode rejection to a clean exact-source record |
| P3-D4b | Dirty-source materialization contract | `not_started` | No implementation; worker worktrees start from an exact commit and integration requires a clean parent | Define and prove an explicit materialization design before claiming dirty-parent support |
| P3-D5 | Tamper-evident artifact manifest and scope checks | `implemented_unverified` | Artifact validation tests | Bind final patch/tree/content hashes in current record |
| P3-D6 | Preview, conflict, explicit integration, verification, retention, cleanup | `implemented_unverified` | Worktree integration primitives/tests | End-to-end parent integration and post-integration host checks |
| P3-D7 | Two separable real writers | `not_started` | Concurrent natural-host trace | Prove parent content/index stays unchanged before explicit integration |

Never automatically cherry-pick or apply worker output into the parent checkout. Worker-tree checks do not qualify the integrated parent; host checks must rerun after explicit integration.

### Phase 3 authoritative checks

```sh
node --test tests/worker-worktree.test.mjs
node --test tests/worker-mutation.test.mjs
node --test tests/worker-safety-proofs.test.mjs
npm run check
git show --check --format= HEAD
npm run worker:verify -- --phase 3 --strict
```

Required scenarios include shared identity across linked roots; quiescent legacy cutover; parent fingerprint coverage of tracked, untracked, ignored, symlink, mode, and content state; malicious paths; escaping symlinks; unresolved/non-stage-zero index entries; artifact content tampering; wrong base; scope violations; integration conflict; base drift; crash recovery; and rejected unsafe cleanup. Initialized submodules, populated gitlinks, and opaque embedded repositories remain unsupported unless a separately approved content-identity contract is implemented and proven.

Operational cutover boundary:

- The compatibility path is a quiescent cutover with ongoing legacy read-through, not seamless cross-version live fencing.
- Before any control-state publication, every discovered legacy source must be preflighted. `queued`, `running`, malformed, or unknown-status legacy jobs block the whole cutover; only `completed`, `failed`, and `cancelled` records may migrate.
- Immutable source/snapshot receipts bind every imported file generation. Late terminal files import on a later snapshot without overwrite; divergent same-path content fails repeatedly with generic `E_STATE`.
- Pre-upgrade workers must finish or stop before cutover. Legacy state directories must remain available until operators intentionally retire them.
- The parent checkout must be clean, including ignored files, when captured and immediately before readiness. Dirty-source materialization and integration are unavailable and fail closed.

Phase 3 exits only when two bounded real writers operate in distinct worktrees, the parent remains unchanged until explicit integration, artifact and scope identity validate, conflicts block readiness, post-integration host checks pass, prerequisites close, and a current exact-source record validates.

## 10. Phase 4 — Native-feeling host adapters and presentation

Current state: `implemented_unverified`

Phase 4 presents only structured public records and labels Grok workers honestly as external workers.

### Phase 4 expected deliverables

| ID | Deliverable | Current state | Artifact or proof | Remaining work |
| --- | --- | --- | --- | --- |
| P4-D1 | Structured status/result presentation without shell parsing | `implemented_unverified` | Worker presentation implementation/tests | Installed natural host proof |
| P4-D2 | Spoof-resistant aliases and parent/lineage tree | `implemented_unverified` | Presentation tests | Exact-source persistence/restart proof |
| P4-D3 | Capability matrix and fail-closed degraded state | `implemented_unverified` | Presentation and MCP tests | Replay against supported Codex versions and missing metadata |
| P4-D4 | Honest external-worker labeling and privacy projection | `implemented_unverified` | Presentation/protocol tests | Natural host injection/privacy evidence |
| P4-D5 | Compatibility Claude presentation/fallback | `implemented_unverified` | Compatibility command surface | Clean installed Claude flow and drift policy proof |
| P4-D6 | Optional dashboard ADR | `deferred` | None required for issue #25 | Add only after separate value/authority decision |
| P4-D7 | Official native extension adoption | `deferred` | No stable official contract assumed | Revisit only if an official host API exists |

### Phase 4 authoritative checks

```sh
node --test \
  tests/worker-presentation.test.mjs \
  tests/worker-protocol.test.mjs \
  tests/mcp-worker-broker.test.mjs
npm run test:installed-codex
npm run test:natural-codex
npm run check
git show --check --format= HEAD
npm run worker:verify -- --phase 4 --strict
```

Required natural-host scenarios cover list, spawn, wait, message/follow-up, cancel, result, restart, stale cursor, retention gap, inaccessible worker, and degraded capability without manual shell intervention. Repository/provider text must not synthesize actions or false success.

There is no dedicated natural Claude replay command in the current package scripts. Add and document one before claiming P4-D5; compatibility prose or unit fixtures alone are not natural-host proof.

Phase 4 exits only when installed natural host flows operate through structured adapters, degraded capability fails closed or uses a documented fallback, external labeling and privacy tests pass, prerequisites close, and a current exact-source record validates.

## 11. Phase 5 — Side-by-side qualification and closeout

Current state: `implemented_unverified` for deterministic safety fixtures; aggregate qualification is `not_started`

Phase 5 compares equivalent native and Grok control loops and publishes the only aggregate release qualification for the final source/install/runtime identity.

### Phase 5 expected deliverables

| ID | Deliverable | Current state | Artifact or proof | Remaining work |
| --- | --- | --- | --- | --- |
| P5-D1 | Mandatory deterministic safety proofs | `implemented_unverified` | [worker-safety-proofs.test.mjs](tests/worker-safety-proofs.test.mjs) | Run on clean final source and record bounded outcomes |
| P5-D2 | Paired native/Grok scenario corpus | `not_started` | Scenario fixtures and result schema | Build equivalent bounded cases for all control-loop operations |
| P5-D3 | Bounded metric harness and at least five timing samples | `not_started` | Redacted measurements with p50/p95/max | Freeze definitions and run same identity |
| P5-D4 | Failure-injection and context-fidelity corpus | `not_started` | Crash, auth, schema, lifecycle, privacy results | Run native and Grok variants |
| P5-D5 | Exact-source aggregate qualification record | `not_started` | `phase-5` plus aggregate immutable record | Require current Phase 0–4 prerequisite digests and all boundaries |
| P5-D6 | Parity scorecard and remaining-gap report | `not_started` | Issue/PR-linked report | Separate achieved control-loop parity from irreducible native gaps |
| P5-D7 | Issue closeout | `not_started` | Final #25 update | Close only after strict aggregate and required live boundaries pass |

### Phase 5 authoritative checks

```sh
node --test tests/worker-safety-proofs.test.mjs
npm run check
git show --check --format= HEAD
npm run test:installed-codex
npm run test:natural-codex
GROK_E2E=1 GROK_E2E_CANCEL=1 npm run test:e2e
npm run worker:verify -- --all --strict
npm run worker:verify -- --all --strict --require-complete
```

Mandatory safety assertions:

- A possibly mutating prompt is never automatically replayed after crash.
- Provider success cannot set host verification to passed.
- Two isolated writers cannot mutate the parent checkout before explicit integration.
- Foreign tasks/workspaces cannot distinguish inaccessible known IDs from nonexistent IDs.
- Model, provider, authentication, schema, lifecycle, and unsupported-capability failures stay explicit and typed.
- Installed natural host orchestration requires no manual shell intervention.
- Final source, install, host/provider versions, scenarios, CI outcomes, and prerequisite digests bind into the aggregate record.

Phase 5 exits only when every mandatory Phase 0–4 record is current for the final tree, deterministic and required installed/live boundaries pass, the aggregate verifier passes, residual unsupported cells are explicit, and issue #25 links the replayable proof.

## 12. Audit and remediation ledger

This ledger distinguishes implementation found in the working tree from proof still required.

| Audit item | Observed/done | Authoritative check or artifact | Remaining remediation |
| --- | --- | --- | --- |
| A-01 Evidence contract | Schema, canonical digest, bounded command outcomes, qualification boundaries, nested allowlists, phase scopes, prerequisites, historical compatibility, and the fixed Phase 0 proof producer are implemented | Evidence schema/library/CLI; `node --test tests/worker-broker-evidence.test.mjs` | Commit integrated source, run the code-owned producer, supersede stale current claims through its locked cutover, and run strict replay |
| A-02 Evidence regression | Focused suite passed 50/50 in the proof-runner working tree | `node --test tests/worker-broker-evidence.test.mjs` | Repeat through the producer on the exact clean commit and preserve its bounded timestamps/output digests in the new Phase 0 record |
| A-03 Repository validation | Phase 0 stationary pre-commit run passed 377 tests with 0 failures and 1 expected authenticated-live skip; validation emitted only the historical profile-v2 warning | `npm run validate`; `npm run check` | Repeat on the exact clean commit and again after every later integrated source slice; record the final commit-bound count in issue #25/PR #26 |
| A-04 Current ledger | Entries exist for Phases 0–5 but bind older source and evidence shape | Ledger and phase JSON files | Keep immutable, supersede from clean final source, prove identity/prerequisite closure |
| A-05 Strict replay | Hardened strict replay fails closed on stale records | `npm run worker:verify -- --all --strict` returns nonzero | This becomes a required pass only after supersession; do not weaken validator |
| A-06 Phase 1 foundation | Protocol, read broker, mutation, cancellation, and reconcile code/tests exist | Worker protocol/service/mutation files and focused test files | Run focused/full gates, restart/crash and installed/live flows, write current record |
| A-07 Phase 2 foundation | Mailbox, follow-up, explicit context, role and ambiguity logic/tests exist | Worker mailbox/context/roles files and tests | Run exact-source proof and live ACP/provider scenarios; retain honest weak guarantees |
| A-08 Phase 3 foundation | Control identity, worktree, parent fingerprint, artifact and cleanup code/tests exist | Workspace/worktree/state files and tests | Run real concurrent writers plus explicit natural-host integration and current evidence |
| A-09 Phase 4 foundation | Structured presentation, alias/tree, capability and labeling tests exist | Worker presentation/protocol/MCP tests | Run clean installed natural Codex and Claude compatibility flows |
| A-10 Phase 5 safety slice | Deterministic safety fixtures exist | `tests/worker-safety-proofs.test.mjs` | Run on clean final source; build paired corpus, metrics, live matrix, aggregate evidence |
| A-11 Independent Grok review | Review lifecycle ended with explicit `E_STATE`; native/manual audit continued | No qualifying repository artifact was produced; preserve the typed failure in task history | Optional fresh Grok review after lifecycle recovery; never count failed/fallback review as proof |
| A-12 Plan/issue synchronization | This plan links open issue #25 and now records conservative truth | This file | After commit, update issue with exact commit, commands, outcomes, record paths, and unchecked residuals |
| A-13 Native MCP enhancement | Draft ADR defines the E0-E7 path from durable broker foundations to a production native-shaped MCP control loop | `docs/superpowers/specs/2026-07-16-native-mcp-control-surface-design.md` | Do not count the ADR as implementation; contract and execute provider launch, live delivery, facade/multi-wait, host verification, skill teaching, and natural MCP proof as future bounded slices |
| A-14 Independent native safety audit | Multiple stationary read-only reviews reproduced and remediated state-lock, cancellation, reconciliation, mailbox, evidence privacy/publication, ledger lost-update, legacy cutover/class normalization, dirty-parent, authoritative-record corruption, CLI/SessionEnd launch-window, unmerged-index, publication-drift, and producer-presence failures | Prior integrated audit passed focused 195/195 and full 366 plus 1 expected live-auth skip; the fresh Phase 0 review passed focused 50/50 and the full tree passed 377 plus 1 expected live-auth skip, with no remaining P0/P1/P2 defect in this slice | Repeat fresh independent validation on the final integrated commit; reviewer findings do not promote any phase without exact-source records |
| A-15 Legacy cutover boundary | Immutable snapshot receipts, global quiescence preflight, late terminal import, and divergent-content failure are implemented | `workspace.mjs` and worktree migration regressions | Operate only after old workers finish/stop; retain legacy directories; do not claim live cross-version fencing |
| A-16 Evidence publication concurrency/privacy | Repository-local generation-bound ledger serialization, crash/reclaim transitions, raw publication validation, exact ledger allowlists, concurrent append regressions, private proof promotion, property-presence producer validation, strict producer-current validation, post-ledger source rollback, and atomic pre-runner baseline cutover are implemented | Evidence library/CLI and 50 focused evidence tests | Bind to the exact clean commit and publish the current Phase 0 record; no implementation-only test result promotes the phase |
| A-17 Cross-version CI remediation | Secret-shaped test canaries are composed only at runtime; the legacy cache probe observes the exact retained payload instead of Node internals; foreground crash recovery is verified by one bounded recovery actor with a cleared timer and persisted terminal assertions | Node 18.18.2 focused/full worktree and runtime suites; `npm run check`; GitGuardian and GitHub Actions OS/Node matrix | Repeat on the exact remote commit, require the supported deterministic matrix and secret scan to pass, and continue treating skipped live-host/provider jobs as absent proof |

## 13. Acceptance target definitions

Targets are not met until the measurement definition and replayable evidence exist:

| Target | Measurement and proof definition |
| --- | --- |
| Durable spawn under 1 second | Broker request acceptance to atomic durable job/handle commit; provider startup excluded; at least five bounded samples. |
| No event loss or duplication | Restart from persisted state, resume after last acknowledged cursor, compare stable event IDs/sequences, and account for retention gaps. |
| Heartbeat within 15 seconds | Broker-owned heartbeat independent of provider chatter while active. |
| Terminal visibility within 2 seconds | Terminal record commit to active waiter's structured terminal event receipt. |
| Message outcome | Every accepted ID ends delivered, rejected, or delivery_unknown; exactly-once only with proven acknowledgement/dedup. |
| Cancellation within 10 seconds | Measure request accepted, process group gone, and terminal record committed separately; freeze the contractual timestamp before qualification. |
| No mutating replay | Fault injection after possible provider dispatch proves recovery never resubmits the prompt. |
| Parent checkout isolation | Parent files, index, and content fingerprint remain unchanged until explicit integration; expected shared Git metadata is recorded separately. |
| Conflict/scope detection | Wrong base, conflict, malicious path, symlink escape, tampering, and out-of-scope artifact block readiness. |
| Host verification authority | No worker/provider/runtime path can set host verification to passed; only host-owned post-result/integration checks can. |

## 14. Issue and PR synchronization

Issue #25 must link this plan near the top and mirror stable deliverable IDs. For every delivery:

1. Keep the top-level phase unchecked until its exit definition is met.
2. Check a nested item only when its exact commit, PR, immutable evidence path, and replay commands are linked.
3. Label implementation-only work `implemented_unverified`; never collapse it into `verified_on_draft` or `qualified`.
4. Post the status delta, commands, exit codes, bounded outcomes, evidence record digests, and residual gaps.
5. Use `Refs #25`, not `Closes #25`, until Phase 5 aggregate qualification passes.
6. Do not close from a worker report, reviewer opinion, skipped mandatory gate, historical record, source/install mismatch, or failed Grok review lifecycle.
7. If the PR carries this plan, update its body with the plan and evidence links after the final commit identity exists.

## 15. Execution order and final closeout checklist

1. [Done for this delivery] Integrate all concurrent implementation and remediation edits without overlapping or discarding unrelated work.
2. [Done for pre-commit remediation] Run phase-focused deterministic suites, independent negative review, and fix every P0/P1/P2 finding accepted into scope.
3. [Done for Phase 0 source slice; repeat on final stationary tree] Run `npm run check`, `git diff --check`, and `git diff --cached --check` on the complete pre-commit integrated tree.
4. [Pending final commit] Commit the source, then run `git show --check --format= HEAD` and `npm run check` so proof binds to that exact commit/tree and stable phase-scope digests.
5. [Pending final evidence-source freeze] Generalize the code-owned producer, then run `npm run worker:prove -- --phase 0 --slice evidence-system --write` on the final clean source and require Phase 0 and all-ledger strict integrity replay to pass while `--require-complete` remains honestly red.
6. Generate Phase 1–4 current records in dependency order, each referencing current predecessor digests and mandatory gate IDs.
7. Run clean installed natural Codex and compatibility Claude scenarios for the exact installed artifact.
8. Run authenticated Grok lifecycle scenarios without exposing credentials or private runtime data.
9. Execute the paired Phase 5 corpus and bounded measurements; write the aggregate record.
10. Require both ledger integrity (`npm run worker:verify -- --all --strict`) and release readiness (`npm run worker:verify -- --all --strict --require-complete`) to pass with no skipped mandatory boundary.
11. Obtain fresh independent native validation of the exact final commit; optional Grok review is additive only.
12. Update issue #25 and PR #26 with exact commit, record digests/paths, replay commands, outcomes, and remaining unsupported cells.
13. Close issue #25 only if the aggregate exit definition is satisfied; otherwise leave it open with the next concrete gate.

This sequence leaves enough durable evidence for a fresh session to determine what exists, what passed, what remains unqualified, which identity was tested, and exactly how to replay every readiness claim.
