# Native-like Grok Worker Broker execution and evidence plan

Status: Active roadmap; foundations are implemented but unverified in the current working tree and the work is not release-qualified

Roadmap version: `1.0`

Audit snapshot: `2026-07-23`

Canonical issue: [#25 — Make Grok Companion workers native-like through a structured worker broker](https://github.com/xliberty2008x/grok-plugin/issues/25)

Current delivery PR: [#26 — Worker Protocol v1 and read-only MCP broker](https://github.com/xliberty2008x/grok-plugin/pull/26)

Related contracts: [SPEC.md](SPEC.md), [PLAN.md](PLAN.md), and the draft [Native MCP Control Surface enhancement ADR](docs/superpowers/specs/2026-07-16-native-mcp-control-surface-design.md)

## 1. Current truth and document authority

This document is the durable execution, verification, and remediation plan for issue #25. The issue is the concise progress mirror; source, immutable evidence, and successful replay commands are authoritative.

The post-implementation audit found substantial Phase 0–4 foundations and Phase 5 safety tests in the working tree. Phase 0/1 were subsequently regenerated in the current evidence shape for exact source `2b39e13`, and evidence-only commit `426b999` preserved strict replay. Those records remain valid for that superseded source but are stale against the later updater, live-receipt, MCP-client, and reporter source commits. Phase 2–5 records still bind older source/evidence shapes and remain rejected by the hardened strict verifier.

Current conservative phase status:

| Phase | Current state | What exists | Why the phase is not complete |
| --- | --- | --- | --- |
| 0 — Evidence system | `implemented_unverified` | Schema, validator, capture/verify CLI, parser-backed static-import phase closure, fixed serial proof runners, immutable-record and ledger logic, fail-closed tests, pre-publication proof-home cleanup, fixed absolute Python/PTTY binding, provisional live-receipt replay, and bounded zero-skip v2 diagnostics | Exact source `2b39e13` passed Phase 1 324/324 and full 552/552 and produced a strictly valid ledger-current Phase 0 record. Commits `64a095c`, `d5f77da`, `0cafff7`, and `98e2596` supersede that source identity, so one final exact replay/record is required |
| 1 — Worker API | `implemented_unverified` | Protocol/schema projections, durable events/cursors, authority-bound reads, exact context-bound launch authorization, intent-bound private-channel provider bootstrap, exact controller/worker/provider identities, autonomous capability-bound startup recovery, atomic cleanup-safe terminalization, cancellation, root host-claim suppression, and a bounded strict MCP STDIO client | Exact source `2b39e13` produced a strictly valid ledger-current, honest `implemented_unverified` Phase 1 record. The newer source commits require new Phase 0/1 records; signed independent review, installed MCP proof, and authenticated-provider proof also remain |
| 2 — Mailbox/context/roles | `implemented_unverified` foundations only | Idempotent mailbox records, follow-up/ContextPacket/role helpers, explicit ambiguity states | Production send has no ACP consumer; follow-up is not dispatchable; ordering, autonomous crash settlement, runtime ContextPacket/role enforcement, host-action persistence, and a Phase 2 proof producer are missing |
| 3 — Worktrees/artifacts | `implemented_unverified` foundations only | Control-workspace identity, shared state, clean-parent fingerprinting, managed-worktree and artifact validation helpers | The broker never provisions or launches in a worktree, globally rejects concurrent writers, has no durable artifact/integration lifecycle, and has no Phase 3 proof producer |
| 4 — Host presentation | `implemented_unverified` foundations plus root MCP subset | Raw task-owned Worker Protocol MCP operations, provider-capability-gated explorer-only spawn advertisement, host-claim suppression, presentation/alias/tree helpers, and external-worker labels | Native-shaped presentation, role-specific public spawn, persistent aliases, multi-wait, positive broker-owned host verification, MCP-first skills, installed natural MCP flow, Claude qualification, and a Phase 4 proof producer are missing |
| 5 — Qualification | `implemented_unverified` | Deterministic safety-proof tests only | Paired native/Grok corpus, measurements, live boundaries, aggregate record, and release decision are not complete |

Issue #25 must remain open. This plan does not claim live provider proof, installed-host proof, natural-host proof, aggregate qualification, or release readiness.

The Native MCP Control Surface ADR is a follow-on design, not evidence that all E0-E7 execution slices are delivered. A raw task-owned MCP list/get/events/wait/result/spawn/cancel surface and the production Phase 1 provider-launch adapter now exist in the working tree. The live mailbox delivery/follow-up adapter, native-shaped presentation and multi-wait, positive broker-owned host-verification operation, skill preference changes, and natural MCP execution-loop proof remain future work. They must enter this plan as separately bounded deliveries with the same exact-source evidence rules before any related checklist item can be marked complete.

### Progress calibration and pre-E2E audit delta

The source-backed audit in [issue comment 5048315213](https://github.com/xliberty2008x/grok-plugin/issues/25#issuecomment-5048315213) is an execution-plan correction pinned to `dc9c9cd`, not qualification evidence. The current working tree is newer, so each finding is reconciled against the current implementation rather than copied as if no work had happened.

These bars are planning estimates, not evidence states or time estimates. They are recalculated from implemented behavior, unresolved safety contracts, and missing installed/live proof; only the phase states and immutable records can support readiness claims.

| View | Current estimate | Interpretation |
| --- | ---: | --- |
| Full roadmap source implementation | `39%` — `████████░░░░░░░░░░░░` | Transparent rubric: production-wired plus negative-tested = 1, partial production = 0.5, helper/fail-closed scaffold = 0.25, absent = 0; the stationary focused gate supports 18.0 of 46 non-deferred deliverables (48 total IDs minus P4-D6/P4-D7 deferred) |
| First read-only vertical E2E readiness | `67%` — `█████████████░░░░░░░` | Six of nine explicit checkpoints pass locally; the live-receipt contract and bounded MCP client are now implemented, but the fixed code-owned runner, installed exact-artifact loop, and authenticated provider cancellation/reconnect proof remain |
| Actual exact-source qualification evidence | `0%` — `░░░░░░░░░░░░░░░░░░░░` | No immutable current record exists for this source identity; installed/live Codex, authenticated Grok, Claude, paired corpus, and aggregate qualification are also absent; implementation progress and moving-tree tests are not qualification proof |

Reproducible roadmap score after the stationary focused gate:

| Phase | Earned units | Basis |
| --- | ---: | --- |
| Phase 0 | `4.00 / 8` | Evidence machinery is production-wired; current records and installed/provider proof are absent |
| Phase 1 | `6.25 / 8` | Root read API, autonomous outbox recovery, process safety, and cancellation are wired; compatibility/live provider proof remains |
| Phase 2 | `2.50 / 8` | Mailbox/context/role foundations exist without production ACP delivery/follow-up |
| Phase 3 | `1.75 / 8` | Identity/worktree/artifact helpers exist without a production write lifecycle |
| Phase 4 | `2.50 / 6` non-deferred | Raw root MCP, capability filtering, and host-claim suppression exist; native presentation/live adapters remain |
| Phase 5 | `1.00 / 8` | Deterministic safety slice only |
| **Total** | **`18.00 / 46`** | The two deferred Phase 4 IDs are excluded |

Per-delivery score ledger (ordered exactly as each phase table; `D` is deferred and excluded):

| Phase | Delivery-unit awards |
| --- | --- |
| P0 | `D1=1, D2=1, D3=1, D4=0.5, D5=0, D6=0, D7=0, D8=0.5` |
| P1 | `D1=1, D2=1, D3=1, D4=1, D5=1, D6=1, D7=0.25, D8=0` |
| P2 | `D1=0.25, D2=0.5, D3=0.25, D4=0.25, D5=0.25, D6=0.5, D7=0.25, D8=0.25` |
| P3 | `D1=0.5, D2=0.25, D3=0.25, D4=0.25, D4b=0, D5=0.25, D6=0.25, D7=0` |
| P4 | `D1=0.5, D2=0.25, D3=0.5, D4=1, D5=0.25, D6=D, D7=D, D8=0` |
| P5 | `D1=1, D2=0, D3=0, D4=0, D5=0, D6=0, D7=0, D8=0` |

Recalculation rule: change an award only after the corresponding production path and required negative tests change, record the evidence in that delivery row, then sum all non-`D` awards and divide by 46. This score is implementation planning, never qualification evidence.

First read-only vertical checkpoints:

| Checkpoint | State | Required replay/evidence |
| --- | --- | --- |
| Versioned root authorization and one production launcher | `implemented_unverified` | Phase 1 focused manifest plus exact-source record |
| Exact root context and provider-prompt binding | `implemented_unverified` | Context drift/ID mismatch negatives plus exact-source record |
| Autonomous committed-outbox restart | `implemented_unverified` | Supervisor restart/concurrency/cancel/intent/process negatives |
| Bootstrap and process-group crash safety | `implemented_unverified` | Bootstrap/process/rotation/recovery focused gates |
| Provider capability receipt and exact tool filtering | `implemented_unverified` | Setup receipt lifecycle, immutable tools/list, hidden-call negatives |
| Host-claim non-forgery | `implemented_unverified` | MCP list/get/events/wait/result/spawn projections omit positive host-attested wording/authority, suppress embedded proof, and keep `hostVerification:not_run` |
| Code-owned live qualification receipt | `contract_implemented_runner_pending` | Commit `d5f77da` rejects generic publication/qualification authority and validates fixed provisional direct/natural receipts; a high-level runner must still own observations and publication end to end |
| Installed exact-artifact MCP loop | `client_implemented_runner_pending` | Commit `0cafff7` supplies the bounded strict STDIO client; the remaining runner must clean-install, verify byte-identical inventory, require setup receipt, and execute MCP spawn/wait/result without source-tree bypass |
| Authenticated provider cancellation and MCP reconnect | `not_started` | One real provider prompt, MCP-server restart without duplicate provider launch, idempotent cancellation, and terminal cleanup; this is not worker-crash recovery |

Pre-E2E finding alignment:

| Audit finding | Current state in the newer tree | Required placement |
| --- | --- | --- |
| 1. One versioned launch authorization and one production launcher | `root subset implemented_unverified`: broker jobs use exact v2 launch authorization and MCP dispatches only through `launchCommittedWorker`; legacy CLI compatibility remains separate and cannot widen the MCP path | Bind idempotent no-double-launch and legacy migration negatives to the clean Phase 1 record, then replay the installed root loop |
| 2. Durable launch lease/outbox | `implemented_unverified`: attempt-bound dispatch, fencing, pre-spawn intents, exact identities, no-replay recovery, and a bounded startup supervisor autonomously claim a committed capability-bound pending job after restart | Bind restart/concurrent-claim/crash-window proof to the clean Phase 1 record, then repeat through the installed process |
| 3. Exact broker-owned repository context | `root subset implemented_unverified`: admission validates or captures the exact context, binds the canonical envelope to its manifest ID, includes it in request/provider-prompt authorization, and revalidates before execution; follow-up compatibility against exact final context remains incomplete | Bind the root drift/ID-mismatch regressions to the clean Phase 1 record; follow-up supersession belongs before follow-up is advertised |
| 4. Verified `ExecutionBinding` for writes | `not_started` in production: worktree/fingerprint helpers exist, but `allowWriteSpawn` is still only a boolean gate and runtime executes from the control root | Phase 3 write vertical; no write capability may be advertised before this exits |
| 5. Advertise only installed live capabilities | `root-read subset implemented_unverified`: a private setup receipt binds plugin/MCP contract/provider binary/version/platform/profiles/expiry; the frozen MCP surface advertises six control tools and adds explorer-only read spawn only for a valid receipt; send/follow-up/write and unbound read roles remain hidden | Bind the focused negatives to exact-source evidence and prove the same seven-tool set from the installed artifact; role-specific policy, ACP acknowledgement, and write capabilities remain separate work |
| 6. Separate broker-owned host-verification receipt | `non-forgery subset implemented_unverified`: MCP projections suppress embedded verification/runtime proof and force `hostVerification:not_run` | Bind forged-claim negatives to exact-source evidence. Positive broker-owned verification is still `not_started` and must not be inferred from suppression |
| 7. Bind every root task to its provider lineage | `partial`: public projection uses a fallback lineage, but root admission does not persist the canonical lineage used by cleanup fencing | Phase 1/2 before the first follow-up vertical; prove uncleared root runtime blocks continuation. It need not block the minimal root spawn/wait/result vertical while follow-up is hidden |

The three post-first-vertical improvements are accepted but do not delay the smallest read-only loop. They have stable delivery IDs and must gain code-owned gates and evidence-scope membership before aggregate qualification:

| ID | Post-first-vertical delivery | Required proof target |
| --- | --- | --- |
| P2-D8 | Non-silent Context Receipt bound to the actual prompt context | Persist/publicly project body-free packet digest, mode, provenance, omissions, bounds, truncation markers, and `hiddenRecordsExported:false`; reject semantically unsafe clipping |
| P4-D8 | Durable completion-consumption accounting without unsupported auto-wake claims | Prove wait, explicit result, and optional notification channels produce one durable consumption outcome across restart; timeout/foreign reads do not consume |
| P5-D8 | Observed runtime evidence | Record requested versus ACP-observed protocol/model/effort/provider/host values, use null when unobserved, and invalidate qualification on identity drift |

The local broker subset and its bounded MCP client are now present and focused-negative-tested. The remaining proof milestone is **installed MCP setup receipt → exact seven-tool list → spawn → real provider start → wait → result with `hostVerification:not_run` → cancellation/MCP-reconnect cleanup**, on one exact clean source/install identity. This is an honest root read-only loop, not a positive host-verification receipt. Finding 7 and the follow-up subset of finding 3 gate the first follow-up vertical. Finding 4 gates the separate write-worker vertical.

Vertical evidence procedure and expected deliverables (use once for an early rehearsal and repeat in full after the final source freeze):

1. Create a private temporary `CODEX_HOME`, plugin-data root, and fixture repository; record their bounded inode/owner/device identities and remove them before receipt publication.
2. Install from the exact committed source under test, compare bounded source and installed inventories byte-for-byte, and run installed `grok-codex setup --json`; require `ready`, authenticated provider state, protocol v1, loadable session state, and isolated paths. Exit code alone is insufficient. An early rehearsal receipt becomes stale after any later source change and cannot qualify the final source.
3. Start the installed MCP server through the bounded client from `0cafff7`; validate the negotiated MCP version/server identity and require the exact ordered seven-tool inventory. Call each operation with its own authority `_meta`; prove missing metadata fails with `E_AUTH_REQUIRED`.
4. Completion scenario deliverable: one durable spawn request, one observed provider launch, terminal wait/result agreement, immutable event identities, and `hostVerification:not_run`; source-tree imports, duplicate provider launch, raw output, and repository mutation are failures.
5. Reconnect/cancel scenario deliverable: restart only the MCP server, replay spawn without a second provider launch, accept cancellation once, replay cancellation idempotently, and observe one terminal cancelled record with the expected stop reason.
6. Verify cleanup independently of the immutable cancellation admission receipt: validate complete provider/controller process identities before proving groups gone; require guard absence, task-runtime cleanup, no event/key rotation, and no temporary runner artifacts. Null cancellation-receipt timestamps are not proof of cleanup.
7. For every completion, reconnect/cancel, and natural-Codex scenario session, delete that exact imported session only after a successful list proves exact presence; require successful delete and a second successful list proving exact absence before publishing that scenario receipt. A generic `ready:false` result cannot prove deletion.
8. Publish only a provisional direct receipt after every direct-MCP observation succeeds. Then run a separate fresh natural-Codex task without caller-authored `_meta`; its receipt proves natural host authority only. Installed-host qualification requires the matched synthetic provider receipt and natural-Codex receipt to bind the same source, install inventory, and capability identity. Preserve bounded failure receipts and publish no pass receipt on any incomplete observation.

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

It must not promote a phase. Phase 0 and Phase 1 now have code-owned execution-only proof manifests; neither accepts caller-supplied command, argv, outcome, environment, or result input:

```sh
npm run worker:prove -- --phase 0 --slice evidence-system --write
npm run worker:prove -- --phase 1 --slice worker-api --write
```

Producer v2 runs the fixed direct manifests, binds a clean stable source and phase-scope file identity before/after every gate and publication, rejects symlinked scope code plus evidence-only executable seeds/dependencies, closes local static ESM imports with Node's non-evaluating module parser, runs the fixed Phase 1 inventory one file at a time through a structured zero-skip/TODO reporter, stores only bounded redacted output digests, and performs a locked fail-closed baseline cutover. Phase 0 may publish `verified_on_draft` after its exact gates pass. Phase 1 deliberately publishes only `implemented_unverified` with `independentValidation: not_run`: both the runtime validator and published schema reject Phase 1 verified/qualified status until authenticated issuer proof exists. The reserved `independentReviewReceipt` checks historical shape/source binding but is not reviewer authentication. A local caller, copied subagent report, or self-computed digest cannot promote Phase 1. Honest promotion requires a code-owned request/import/promote flow plus a signed attestation from a separately protected reviewer issuer, with strict offline signature and exact source/diff/proof replay. Until that authority exists, Phase 1 cannot satisfy a downstream verified prerequisite. The current qualification command is also capture-only and exits nonzero when live work is skipped:

Producer v2 is a same-user local qualification runner, not a sandbox or verifier for hostile repository code. Deterministic proof assumes every fixed gate and all descendants are quiescent when the direct gate exits, and that no other process running as the publisher UID concurrently mutates the repository, proof home, or evidence tree. Observable identity mismatch, replacement, inaccessible descendants, cleanup errors, and static symlink escape fail closed before publication. Intentionally surviving same-UID processes, retained open descriptors, witness manipulation, and post-gate mutation require a separately privileged supervisor and are outside this local producer boundary. Successful cleanup proves pathname-level removal of the bound proof-home tree without traversing tested static symlink targets; it does not prove destruction of data retained through an open descriptor by an out-of-contract process. Windows proof production returns typed `E_PROOF_PLATFORM` until an equivalent bound-handle cleanup protocol exists.

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
| P0-D3 | Phase scopes, mandatory gates, parser-backed local-static-import closure, and prerequisite digest closure | `implemented_unverified` | Phase manifests plus compact/after-block/division/regex/transitive/evidence-path negative regressions | Supersede all stale phase records with exact prerequisites |
| P0-D4 | Proof-producing capture/replay workflow | `implemented_unverified` | Producer v2; fixed direct Phase 0/1 manifests; exact serial Phase 1 runner; zero-skip reporter; scope-file identity, symlink, and executable-evidence-path defense; broker-owned provenance; absolute toolchain binding; private proof environment/promotion authority; v1 cutover; post-publication source rollback; strict ledger validation; schema/runtime unsigned-promotion prohibition | Freeze and commit the evidence source, rerun the stationary focused/full gates, publish Phase 0, and keep Phase 1 unverified until a signed external reviewer attestation can be requested, imported, and replayed offline |
| P0-D5 | Current immutable records and ledger | `not_started` (supersession pending) | Existing records and ledger are historical migration inputs only | Publish new exact-source Phase 0 then Phase 1 records after the clean source commit; retain old entries as non-qualifying history |
| P0-D6 | Exact-source installed natural Codex proof | `not_started` | Installed inventory and natural-host trace | Install exact artifact and run natural task without source-tree bypass |
| P0-D7 | Current authenticated macOS Grok lifecycle proof | `not_started` | Redacted provider qualification record | Run provider lifecycle against same source/install identity |
| P0-D8 | Honest platform declarations | `implemented_unverified` | Limits in schema/records and OS-specific CI policy | Reconfirm Linux/macOS deterministic cells; Windows remains provider-neutral and cannot claim the POSIX zero-skip full suite |

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
| P1-D1 | WorkerHandle/Event/Snapshot/Result/Error schemas and version policy | `implemented_unverified` | [worker-protocol.schema.json](plugins/grok/schemas/worker-protocol.schema.json) and focused schema/projection regressions | Rerun on the stationary tree, commit it, and bind schema conformance to the current Phase 1 record |
| P1-D2 | Durable monotonic events, bounded retention, worker-bound cursors and gaps | `implemented_unverified` | Worker protocol implementation/tests; reconnect/cursor regressions are included in the expanded focused gate | Commit-bound restart/reconnect evidence and installed-host replay |
| P1-D3 | Authority-bound list/get/events/wait/result reads | `implemented_unverified` | Worker service and MCP broker tests; spoof/privacy negative cases pass | Exact-source current record and installed-host replay |
| P1-D4 | Idempotent atomic read-only spawn plus production launch adapter | `implemented_unverified` | Canonical TaskEnvelope validation, exact context binding, durable commit-before-launch, capability-bound autonomous startup drain, single-use provider spawn intent, intent-bound bootstrap, no-ACP-before-promotion acknowledgement, and no-duplicate launch regressions | Bind the stationary gates to exact-source evidence and execute the installed natural-host flow |
| P1-D5 | Idempotent cancel receipt and one request event | `implemented_unverified` | Pre-claim, commit-to-launch, active-provider, TERM-resistant controller, and exact group-shutdown tests pass | Persist commit-bound timing evidence; run authenticated live cancellation |
| P1-D6 | Trusted reconciler that never replays prompts | `implemented_unverified` | Controller/worker/provider loss, autonomous pre-intent claim recovery, intent revocation, exact bootstrap guard recovery, provider-rotation promotion, cleanup-blocked retry, malformed-PGID, terminal-intent restoration, and no-replay regressions | Publish the exact-source record only after authenticated independent review, then repeat through installed-host restart |
| P1-D7 | CLI/skill/Claude compatibility | `implemented_unverified` | Existing compatibility surface | Golden replay on final integrated source and clean install |
| P1-D8 | Authenticated provider orchestration | `not_started` | Provider-bound record | Run spawn/wait/cancel/result with exact installed artifact |

Write spawn remains gated until Phase 3 isolation and integration authority are proven. Spawn success means the durable job is committed; it is not provider-startup success.

### Phase 1 authoritative checks

```sh
npm run check
git show --check --format= HEAD
npm run worker:prove -- --phase 1 --slice worker-api --write
npm run worker:verify -- --phase 1 --strict
npm run worker:verify -- --phase 1 --strict --require-verified
```

The first verify command checks record integrity, freshness, source identity, and prerequisite structure; it may pass for an honest `implemented_unverified` record. `--require-verified` is the readiness gate and must remain nonzero until the current record is at least `verified_on_draft` with authenticated independent-review proof.

The code-owned `phase-1-focused-tests` manifest invokes `scripts/test-phase1-focused.mjs`; that script's frozen 25-file list is the authoritative focused inventory. It includes protocol/service/MCP runtime, process control, provider/bootstrap, recursion guard, mailbox, cancellation, reconciliation, rotation, recovery-fence, terminal-intent, CLI-authority, mutation, and safety-proof suites. `scripts/lib/deterministic-test-runner.mjs` launches exactly one file at a time and aggregates exact zero-skip summaries, including on Node 18.18 where `--test-concurrency` is unavailable. Do not copy a shorter hand-maintained test list into an evidence claim.

Required scenarios include owner success, foreign/nonexistent equivalence, missing/malformed/spoofed authority, unsupported protocol, cursor gaps, cross-process idempotency, crash before/after durable commit, cancel in the commit-to-launch window, no mutating replay, provider-launch failure preservation, raw-vs-redacted identity separation, null birth-token cleanup witnesses, corrupted PGID rejection, report-repair rotation promotion before guard removal, and terminal/privacy publication only after verified cleanup.

Phase 1 exits only when all public schemas and operations pass on one clean exact commit, current Phase 0 prerequisite digest/gates close, restart/crash behavior is proven, the current record is at least `verified_on_draft`, authenticated signed independent-review proof validates, and `--require-verified` passes. Plain strict integrity success for `implemented_unverified` is not phase exit. Installed/live boundaries remain separately named until run.

## 8. Phase 2 — Mailbox, follow-up, context packets, and roles

Current state: `implemented_unverified`

Phase 2 adds durable communication and lineage-preserving follow-up without inventing mid-turn steering or exactly-once guarantees that ACP cannot prove.

### Phase 2 expected deliverables

| ID | Deliverable | Current state | Artifact or proof | Remaining work |
| --- | --- | --- | --- | --- |
| P2-D1 | ACP acknowledgement/dedup capability record | `not_started` | Caller-constructed conservative helper/fixture only | Replace caller booleans with provider/session/attempt-bound capability evidence; otherwise retain explicit ambiguity |
| P2-D2 | Ordered durable mailbox and outcome state machine | `implemented_unverified` foundation | Idempotent private records, body-free receipts, explicit outcome states, no retry of unknown | Add per-worker sequence, claim/inflight/close barriers, autonomous recovery settlement, and private-body cleanup without caller replay |
| P2-D3 | Active send and terminal/idle lineage follow-up | `not_started` in production | Helper-level send/follow-up tests | Add worker-owned ACP safe-boundary pump; make follow-up a valid dispatch, launch it, and bind same-session resume |
| P2-D4 | Explicit-envelope Context Packet v1 | `implemented_unverified` helper only | Bounded/redacted/deep-frozen ContextPacket library/tests | Broker must build/store it; runtime prompt and public projection must consume only bounded packet provenance, never raw hidden envelope facts |
| P2-D5 | `recent:N` and broader transcript modes | `implemented_unverified` | Capability gates exist | Trusted transcript acquisition remains unproven; keep modes fail-closed |
| P2-D6 | Immutable explorer/implementer/reviewer/security/test roles | `implemented_unverified` internal foundation; only `explorer` is publicly advertised | Durable role digests and dispatch tamper checks; root MCP rejects unbound roles | Add role-bound provider instructions/capability policy and runtime proof before reviewer/security/test or implementer is advertised |
| P2-D7 | `awaiting_host_action` authority request | `not_started` | Ephemeral helper only; public snapshot remains null | Persist request state and add owner-bound idempotent host grant/deny operations and evidence |
| P2-D8 | Non-silent Context Receipt | `not_started` in production | ContextPacket helper only | Bind the actual provider prompt to a body-free receipt with counts/digests, provenance, omissions, bounds, truncation markers, and unsafe-clipping rejection |

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

Required live proof queues multiple messages during a bounded job, restarts the broker, and accounts for every message as delivered, rejected, or delivery_unknown. Follow-up must bind parent/lineage and reject context/profile drift. The Context Receipt must match the effective prompt context without exporting bodies or hidden records. Evidence excludes raw message bodies and hidden host records.

Phase 2 exits only when guarantees match proven ACP capability, every accepted message has an explicit durable outcome, no ambiguity is auto-retried, hidden context and self-escalation tests pass, Phase 0/1 prerequisite digests close, and a current exact-source record validates.

## 9. Phase 3 — Isolated write worktrees and integration artifacts

Current state: `implemented_unverified`

Phase 3 moves write workers out of the parent checkout and keeps integration an explicit host-owned decision.

### Phase 3 expected deliverables

| ID | Deliverable | Current state | Artifact or proof | Remaining work |
| --- | --- | --- | --- | --- |
| P3-D1 | Stable `controlWorkspaceId`, `controlRoot`, and `executionRoot` | `implemented_unverified` foundation | Workspace/control-identity and worktree helper tests | Persist a private job-to-execution-root binding and project only its digest; production runtime still uses the parent root |
| P3-D2 | Shared admission and lineage state across linked worktrees | `not_started` for real writers | Shared state visibility exists, but active-writer admission is globally exclusive | Replace global exclusivity with distinct managed-root leases and prove two concurrent broker workers |
| P3-D3 | Host-owned worktree creation from exact base | `implemented_unverified` helper only | Exact detached-worktree creation tests | Add crash-safe provisioning journal, orphan recovery, launch split between control root and execution root, retention, and cleanup lifecycle |
| P3-D4 | Clean-parent fingerprint and dirty-parent rejection | `implemented_unverified` | Parent fingerprint and negative integration tests | Bind tracked/untracked/ignored/binary/symlink/mode rejection to a clean exact-source record |
| P3-D4b | Dirty-source materialization contract | `not_started` | No implementation; worker worktrees start from an exact commit and integration requires a clean parent | Define and prove an explicit materialization design before claiming dirty-parent support |
| P3-D5 | Tamper-evident artifact manifest and scope checks | `implemented_unverified` helper only | Strong manifest recomputation and scope/tamper tests | Publish immutable job-bound artifact plus retrievable integration payload from the real terminal write path |
| P3-D6 | Preview, conflict, explicit integration, verification, retention, cleanup | `not_started` in production | Validation/readiness helpers only | Add authority-bound idempotent preview/integrate/verify/retain/abandon/cleanup operations with no partial parent mutation |
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
| P4-D1 | Structured status/result presentation without shell parsing | `partial production` | Raw task-owned MCP list/get/events/wait/result/spawn/cancel returns structured Worker Protocol records; pure presentation helpers also exist | Add native-shaped presentation, multi-wait, persistent aliases, and installed natural MCP proof |
| P4-D2 | Spoof-resistant aliases and parent/lineage tree | `not_started` end to end | Pure alias/tree helpers only | Persist a task-owned alias registry and descriptions; add collision, restart, cycle, and foreign-ID tests |
| P4-D3 | Capability matrix and fail-closed degraded state | `partial production` | Private provider receipt plus frozen six/seven-tool MCP inventory and hidden-operation rejection; authority metadata still fails closed | Add ACP acknowledgement/write capability records and prove full/degraded routing across installed supported hosts |
| P4-D4 | Honest external-worker labeling and privacy projection | `implemented_unverified` | External labels plus protocol/MCP forged-host-claim suppression tests | Add installed natural host injection/privacy evidence; positive broker-owned host verification remains separate |
| P4-D5 | Compatibility Claude presentation/fallback | `not_started` qualification | Legacy Markdown/shell command surface only | Freeze an honest MCP-or-command fallback contract and add installed/natural Claude scripts, version binding, and CI |
| P4-D6 | Optional dashboard ADR | `deferred` | None required for issue #25 | Add only after separate value/authority decision |
| P4-D7 | Official native extension adoption | `deferred` | No stable official contract assumed | Revisit only if an official host API exists |
| P4-D8 | Durable completion-consumption accounting | `not_started` | No delivery ledger or channel arbitration | Persist exactly one consumption outcome across wait/result/optional notification and restart; never claim unsupported host auto-wake |

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

Required natural-host scenarios cover list, spawn, wait, message/follow-up, cancel, result, restart, stale cursor, retention gap, inaccessible worker, degraded capability, and completion-consumption arbitration without manual shell intervention. Repository/provider text must not synthesize actions or false success.

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
| P5-D8 | Observed negotiated runtime evidence | `not_started` in evidence | Provider negotiation validates requested values but observations are not persisted into qualification | Record requested and ACP-observed protocol/model/effort/provider/host values separately, null when unobserved, and fail qualification on identity drift |

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
| A-01 Evidence contract | Schema, canonical digest, bounded command outcomes, qualification boundaries, nested allowlists, exact phase scopes, prerequisites, historical compatibility, producer v2, direct deterministic gate, serial zero-skip runners, parser-backed static-import closure, executable-evidence-path rejection, symlink/file-identity defense, pre-publication temporary-home cleanup, fixed Python/PTTY binding, and schema/runtime unsigned Phase 1 promotion prohibition are implemented | Source `2b39e13`: evidence suite 78/78, hooks 26/26, exact Phase 1 324/324, full gate 552/552, and successful Phase 0/1 producer replay | Freeze the updater change, replay exact gates, regenerate the code-owned Phase 0/1 records through locked cutover, and rerun strict replay |
| A-02 Evidence regression | Phase 0/1 regressions cover PATH/toolchain poisoning, fixed-Python absence, exact PTY flags and selector scrubbing, generic-writer authority, parser grammar adversaries, Node-compatible file-URL resolution, encoded-path decoys, unsupported static requests, transitive imports, dynamic-import/non-ESM non-edges, evidence-only seed/dependency rejection, serial fixed Phase 1 gates, scope symlinks, v1 cutover, transitive dependent demotion, prerequisite closure, immutable publication, proof-home static-symlink/inaccessible-descendant/bound-handle/root-replacement/platform rejection, strict replay, drift rejection, schema/runtime parity, and honest unverified Phase 1 publication | Source `2b39e13`: evidence 78/78; PTY ingress 4/4; hooks 26/26; Windows-neutral 5/5; exact Phase 1 324/324; full gate 552/552; eight selected cleanup/platform/Python assertions passed on both Node 18.18.2 and 20.19.4; zero failed/cancelled/skipped/TODO in full runs | Repeat through producer v2 on the updater-fix exact commit and preserve bounded timestamps/output digests in the new Phase 0/1 records |
| A-03 Repository validation | The repository gate enumerates deterministic tests directly, excludes only installed-Codex and authenticated-Grok external boundaries, runs files serially on the Node 18.18 baseline, and fails on every empty/malformed/failed/cancelled/skipped/TODO child summary | Source `2b39e13`: fixed Phase 1 324/324 and full gate 552/552, both zero failed/cancelled/skipped/TODO; the updater timeout change now requires a new source identity and replay | Replay both authoritative gates on the updater-fix exact commit and record its identity in the immutable records and issue #25/PR #26 |
| A-04 Current ledger | Phase 0/1 bind current-schema records to superseded source `2b39e13`; Phase 2–5 bind older source/evidence shapes | Ledger and phase JSON files | Preserve immutable history, supersede Phase 0/1 from the clean updater-fix source, and later replace Phase 2–5 in dependency order |
| A-05 Strict replay | Evidence-only commit `426b999` passed strict Phase 0/1/all-ledger integrity for source `2b39e13`; source drift now correctly makes those records non-current | Strict replay commands and immutable Phase 0/1 records | Require strict replay again after updater-fix supersession; do not weaken the validator or present integrity success as release readiness |
| A-06 Phase 1 foundation | Protocol/read broker, exact context-bound authorization, capability-bound autonomous pending-outbox startup drain, intent-bound provider bootstrap and acknowledgement, exact attempt/process identities, atomic cleanup-safe terminalization, cancellation, provider-intent recovery, and report-repair rotation promotion are implemented in source | Worker protocol/service/runtime/mutation/recovery/supervisor/process-control/bootstrap files and focused process tests; fresh integrated review has no remaining actionable finding | Replay exact-source gates, publish Phase 0 and honest unverified Phase 1 records, implement authenticated review promotion, and run installed/authenticated live flows |
| A-07 Phase 2 foundation | Mailbox, follow-up, ContextPacket, role, and ambiguity helpers/tests exist; production runtime wiring was audited and is absent | Worker mailbox/context/roles files and tests | Implement ordered autonomous mailbox delivery, dispatchable same-session follow-up, runtime context/role contracts, host-action persistence, and a Phase 2 producer before any live claim |
| A-08 Phase 3 foundation | Strong control identity, worktree, fingerprint, artifact, and cleanup guardrail helpers exist; production write-worker/integration wiring was audited and is absent | Workspace/worktree/state files and tests | Add durable managed-root binding, real concurrent writers, terminal artifacts, explicit integration/verification/retention, and a Phase 3 producer |
| A-09 Phase 4 foundation | Raw task-owned MCP operations, immutable receipt-gated explorer-only spawn advertisement, external labeling, structured-proof suppression, and normalized host-attested summary/progress/event suppression exist; installed flows still use legacy CLI/PTY rather than the MCP broker | Provider capability, worker presentation/protocol/service/MCP tests, and host scripts; pre-final-review projection/supervisor batch 40/40 plus post-review focused regressions | Build native-shaped presentation/multi-wait, role-specific runtime policy, persistence, positive broker-owned verification, MCP-first skill routing, installed natural Codex/Claude flows, and a Phase 4 producer |
| A-10 Phase 5 safety slice | Six deterministic Grok-side safety fixtures exist; no paired native adapter, scenario corpus, measurement harness, failure matrix, or aggregate producer exists | `tests/worker-safety-proofs.test.mjs` | Build typed paired corpus and >=5 samples per adapter/scenario, then bind live matrix and aggregate evidence without raw prompts/transcripts |
| A-11 Independent Grok work/review | Earlier review lifecycle ended with `E_STATE`; bounded cleanup job `task-ca1ff775a418d2b044e5f4de` wrote a partial scoped diff but ended `E_PROTOCOL` because the report-repair agent's curated tool registry was empty | No qualifying Grok report was produced; main Codex independently reviewed/extended the diff and recorded four passing host checks while preserving the failed worker status | Fix or route around report-repair provider registration before relying on Grok structured reports; never count either failed lifecycle as independent proof |
| A-12 Plan/issue synchronization | This plan links open issue #25 and now records conservative truth | This file | After commit, update issue with exact commit, commands, outcomes, record paths, and unchecked residuals |
| A-13 Native MCP enhancement | Draft ADR defines the E0-E7 path from durable broker foundations to a production native-shaped MCP control loop; only the Phase 1 provider launch slice is implemented in this tree | `docs/superpowers/specs/2026-07-16-native-mcp-control-surface-design.md` | Execute live delivery, facade/multi-wait, host verification, skill teaching, and natural MCP proof as bounded slices; do not count the ADR as implementation |
| A-14 Independent native safety audit | Fresh Phase 1 reviews found and remediation addressed wait mutation authority, replacement-generation witness loss, terminal-intent loss, unsafe legacy reconciliation, startup cancellation, unsafe cancel terminal hook, evidence-chain supersession, duplicate/foreign provider-bootstrap cleanup, promotion-pipe failure, detached startup crash windows, process-group/PATH hardening, autonomous outbox recovery, live capability revalidation, private bootstrap argv, normalized host-claim suppression, unbound public role advertisement, serial proof execution, static-import grammar/resolution bypasses, and unsigned schema promotion | Final integrated, runtime, and parser/evidence rereviews report no remaining actionable findings; review-only targeted batch was 30/30 and does not promote evidence status | Complete exact-commit gates; reviewer findings do not promote any phase without an authenticated exact-source receipt |
| A-15 Legacy cutover boundary | Immutable snapshot receipts, global quiescence preflight, late terminal import, and divergent-content failure are implemented | `workspace.mjs` and worktree migration regressions | Operate only after old workers finish/stop; retain legacy directories; do not claim live cross-version fencing |
| A-16 Evidence publication concurrency/privacy | Repository-local generation-bound ledger serialization, crash/reclaim transitions, raw publication validation, exact ledger allowlists, concurrent append regressions, private proof promotion, strict producer-current validation, post-ledger rollback, atomic v1 cutover, transitive supersession, absolute toolchain binding, exact scope-file identity, and fixed Phase 0/1 producer manifests are implemented | Source `2b39e13`: Phase 1 324/324, full 552/552, current Phase 0 digest `f7c9779e…`, current honest Phase 1 digest `53bb71c6…`; evidence-only commit `426b999` preserved strict integrity | Rebuild the chain after the installed-cache updater source fix; no implementation-only test result promotes the phase |
| A-17 Cross-version CI remediation | Linux/macOS CI now names the deterministic zero-skip suite; installed-host and authenticated-provider tests are separate qualification jobs; Windows remains an explicit provider-neutral cell | Node 18.18.2 and 22.x supported CI matrix; `npm run check`; GitGuardian; `.github/workflows/ci.yml` | Repeat on the exact remote commit and require supported Linux/macOS deterministic plus secret-scan jobs; do not present Windows provider-neutral tests as a full POSIX/provider qualification |
| A-18 Completion-model contradiction | Current `--require-complete` requires every Phase 0–5 record to be `qualified`, while fixed proof producers can create only deterministic `verified_on_draft` records | Evidence validator and Phase 0/1 proof manifests | Make Phase 0–5 require current deterministic verification and aggregate alone require installed/live/provider/release qualification, or add a separately trusted composable qualification producer; prove both incomplete and complete states |
| A-19 Host/qualification proof surface | Phase 1 scope now explicitly binds MCP broker/server, provider bootstrap/capability, autonomous dispatch supervisor, provider agents, relevant skills, direct gate scripts, and crash/recovery tests; Phase 4/5/aggregate producers still do not bind the full install/natural/Claude/paired-corpus qualification surface | Evidence manifests/scopes, package scripts, CI, and stale historical records | Add code-owned Phase 4/5/aggregate producers and their remaining runtime-surface seeds/drift tests, then derive release qualification from the validated aggregate record |
| A-20 Source-backed pre-E2E audit delta | Issue comment 5048315213 supplied seven commit-pinned blockers and three post-first-vertical improvements; current-tree reconciliation classifies them individually above | Current source, acceptance mapping, and this plan's progress rubric | Close the root vertical subset before live E2E, hide unsupported tools, then execute the separate follow-up and write verticals; add P2-D8/P4-D8/P5-D8 gates before aggregate qualification |
| A-21 Independent-review authentication boundary | The reserved receipt is source-bound and tamper-evident but locally forgeable; Codex cannot authenticate a collaboration subagent, fresh independent session, exact remote runtime, or copied output from repository code alone | Evidence schema/library review and fresh native design audit | Add immutable review request, bounded signed-attestation import, pinned production public keys/revocation, separate promotion authority, atomic supersession, and strict offline signature/source/diff/proof replay; until then keep Phase 1 `implemented_unverified` |
| A-22 Proof-runner temporary cleanup | The first Phase 0 producer-v2 attempt on `b30fefd` exited nonzero with raw `ENOTEMPTY`; no evidence file or ledger cutover occurred. Reproduction showed `hooks.test.mjs` passed 26/26 while its wrong-root teardown leaked a mode-`000` fixture. Commit `31244be` resolves the real plugin-data root, makes teardown failure observable, binds the POSIX proof-home inode/owner/device plus an open no-follow handle, rejects copied identities, static symlink escape, and renamed/replaced roots, completes cleanup before publication with structured `E_PROOF_CLEANUP`, and rejects Windows proof production with `E_PROOF_PLATFORM`. The guarantee is explicitly limited to reviewed, quiescent code-owned gates; adversarial same-UID survivors require a privileged sandbox/supervisor. | Exact `31244be`: Phase 1 324/324 and full gate 550/550; moving-tree evidence 78/78; hooks 26/26; Windows-neutral 5/5; eight selected cleanup/platform/Python assertions passed on Node 18/20; fresh native review found no remaining actionable cleanup issue within the declared boundary | Preserve this boundary through the updater-fix source freeze and serial Phase 0/1 producers |
| A-23 Proof-runner Python/PTTY binding | Two Phase 0 producer runs on clean `31244be` failed at `repository-check` with the same bounded digest and no record/ledger publication. Exact raw reproduction returned 548 passed and 2 skipped because sanitized `PATH` resolved `/usr/bin/python3`, an unusable macOS Xcode stub. The remediation captures and hashes a native Python from reviewed Darwin/Linux locations, rejects shebang shims, probes under the final sanitized `PATH`, invokes the canonical absolute path with identical `-I -S -B` flags, scrubs the proof-only selector before Python/target startup, and fails closed with `E_PROOF_TOOLCHAIN` if no candidate works. This is a local quiescent toolchain binding, not hermetic attestation of the Python standard library or dynamic libraries. PATH-only pyenv/asdf installs are intentionally unsupported. | Both failed producer attempts returned `E_PROOF_GATE`/`repository-check` with digest `7ad1dd496f224d64aed5555e92fa76ffac8d9593195619096ed672d9cf0ea0ab`; no publication. Source `2b39e13`: evidence 78/78; PTY 4/4; Phase 1 324/324; full 552/552; successful Phase 0 producer/strict replay; two focused binding/fail-closed assertions 2/2; eight selected assertions passed on Node 18.18.2 and 20.19.4; fresh native security review found no blocker | Preserve this binding through the next source freeze. On `E_PROOF_TOOLCHAIN`, install native Python at a documented fixed location or resolve the macOS Xcode-license installation; do not add caller `PATH` or an unreviewed shim override |
| A-24 Installed-cache updater budget | The first exact-cache refresh after `426b999` stopped before install: `scripts/update-local-codex.mjs` applied its generic 180-second child timeout to the intentionally serial `npm run check`, which now takes about 11 minutes. `spawnSync` returned `ETIMEDOUT`; the script never reached cache mutation. Commit `64a095c` assigns the repository check a bounded 20-minute budget—five minutes of headroom over the proof producer's 15-minute repository gate—while preserving the generic timeout for smaller commands. | Failed command: `npm run codex:update-local`; outcome `spawnSync npm ETIMEDOUT` during step 1/4; no cache mutation. Exact `64a095c` Phase 1 replay subsequently passed 324/324 with zero fail/cancel/skip/TODO; full replay was intentionally deferred after A-25 exposed another source-changing pre-E2E blocker | Finish A-25/A-26-derived source work, run one final exact replay/proof chain, rerun `codex:update-local` through inventory-digest equality, then start a fresh Codex/MCP process because tools/list is frozen per server lifetime |
| A-25 Live qualification provenance | The generic evidence model previously accepted caller-authored live-pass claims. Commit `d5f77da` adds a separate fixed-manifest live-receipt schema/validator, direct digest/install-method/runtime binding, direct-versus-natural authority separation, bidirectional provisional semantics, generic-writer/ledger rejection, bounded directory replay, and no exported mint/build/publish/link authority. This is an offline structural contract, not proof that a live lifecycle occurred. | Exact `d5f77da`: evidence 94/94 on native Node and 94/94 on Node 18.18.2; `npm run validate` passed with only the declared historical warning; manifest digest `0641afd02156262492b10f52dd71f4ce18aa6b338179324a34d6b2b111b6370b`; second fresh read-only review approved; no provider launched or pass receipt published | Implement one fixed high-level runner that owns setup, inventory, MCP observations, cleanup, and provisional receipt publication end to end. Keep direct MCP provider proof separate from natural Codex installed-host proof |
| A-26 Grok evidence-worker failure | The first rescue envelope was rejected before job creation with `E_CONTEXT_INCOMPLETE` because an excluded plan file was also declared as a project marker. Corrected write job `task-5d96c2fd6cdc0fc38b7d0f7a` ran only in the evidence scope but ended `E_PROTOCOL`: no `GROK_WORKER_REPORT`, all ACs unknown, host verification not run, and partial runtime-observed edits in the evidence library/new schema only. | Exact Grok status/result preserved the terminal failure; no worker claim is accepted as completion | Use the permitted native implementation fallback, inspect/rework the partial diff, run authoritative targeted checks, and retain the failed job as non-qualifying incident evidence |
| A-27 Hosted deterministic CI observability/budget | PR run `29978437612` exposed hidden cross-host failures and a 20-minute cancellation while zero-skip v1 emitted counts only. Commit `98e2596` introduces exact zero-skip v2 summaries with the first eight bounded structured non-pass identities plus omitted count, complete/incomplete environment-secret handling, path/token redaction, no getter execution, fixed ordinal parent diagnostics, 1 MiB child capture, strict parser/aggregate arithmetic, and a 30-minute hosted matrix budget enforced by validation. | Final reporter snapshot: targeted 16/16 on native Node and 16/16 on Node 18.18.2; the immediately preceding full snapshot passed 105/105 on both runtimes with zero fail/cancel/skip/TODO, and the final delta was limited to shared path-shape cases/regex; `npm run validate` passed; fresh read-only review approved. Commit `98e2596` contains the final bytes | Push the exact commit and rerun all hosted Linux/macOS matrix cells. Use the now-named bounded violations to fix any real cross-host defect; do not call CI green from local proof alone |
| A-28 Live-receipt provenance rereview | The first native fallback implementation passed its tests but fresh review rejected exported mint/publish authority, caller-supplied observations, host-verification overclaim, one-way schema rules, missing validator registration/isolation, and unbounded traversal. The final `d5f77da` design removes supported mint/publish/link surfaces, keeps replay at the repository-review trust boundary, forces provisional `hostVerification:not_run`, validates schema/runtime parity, and binds bounded directory identities/depth/counts. | First review: two P0, three P1, and two P2 findings. Final snapshot: 94/94 native plus 94/94 Node 18.18.2 and a second fresh approval; no provider launched and no live-qualified record published | Preserve the no-mint boundary until the fixed runner owns real observations. Any future publication API requires a new independent review and negative proof against caller-authored pass claims |
| A-29 Bounded MCP STDIO client | The initial client passed 42 tests but review proved unbounded pre-spawn initialize retention. Subsequent reviews found per-event stdout Buffer amplification, inbound JSON depth/node amplification, and a premature notification-lifecycle transition. Commit `0cafff7` now admits one synchronous initialize claim, rejects pre-init floods before inspection, uses one fixed 4 MiB zeroized accumulator, preflights inbound JSON depth/tokens before parse, enforces strict initialize/acknowledgement ordering, bounds operations/bytes/timers, preserves correlation and structural errors, and terminates only the exact child. | Final frozen bytes: 56/56 on native Node and 56/56 on Node 18.18.2, syntax/whitespace clean; fresh independent review approved after all four blocker classes were closed. No provider, installed server, or Codex task was run | Integrate this client into the opt-in installed runner. Descendant/provider process cleanup remains runner-owned; the client's exact-child boundary is intentional |
| A-30 Installed-runner source map | Read-only source mapping established the exact installed setup/receipt/tool APIs and the private persisted-state checks needed for lifecycle proof. It also corrected two tempting false proofs: active-provider cancellation receipts keep `processGroupGoneAt`/`terminalRecordCommittedAt` null because they are immutable admission receipts, and `isImportedSessionReady()===false` cannot distinguish successful deletion from list failure. | Installed wrapper/setup, provider-capability receipt, exact tools order, state/mutation/guard/process/session modules, and cancellation/session tests were inspected; no runner code or live provider execution yet | Add bounded shared inventory resolution, complete detached-process identity assertion, explicit session-presence result, installed handshake/tool/result validators, fixed receipt publisher, and the eight-step immediate vertical procedure above before live execution |

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

1. [Complete] Integrate all concurrent Phase 0/1 implementation and remediation edits without overlapping or discarding unrelated work; both writers are stopped and their integrated surfaces have been inspected.
2. [Done at the remediation/review layer] All accepted runtime/evidence findings have source fixes. Fresh integrated, runtime, and parser/evidence rereviews report no remaining actionable findings; their reports are review input, not qualifying evidence.
3. [Superseded exact snapshot] Source commit `b30fefd` passed the authoritative fixed Phase 1 gate 324/324 and full repository gate 543/543 with zero failed/cancelled/skipped/TODO. The later proof-cleanup remediation changed the source identity, so those results remain incident evidence only.
4. [Superseded exact cleanup snapshot] Commit `31244be` passed fixed Phase 1 324/324 and full repository 550/550 with zero failed/cancelled/skipped/TODO. Two subsequent Phase 0 producer runs failed before publication at `repository-check` with the same digest because the sanitized environment reached an unusable `/usr/bin/python3`; the exact raw gate showed 548 passed and 2 skipped. No record or ledger was published.
5. [Complete at the Python source-freeze/remediation layer] The producer now binds a reviewed native Python by canonical absolute identity, rejects shims, uses identical isolated flags, excludes Python from `PATH`, scrubs the selector, and fails closed without publication. Before this outcome was recorded in the plan, the freeze passed evidence 78/78, PTY 4/4, hooks 26/26, Windows-neutral 5/5, fixed Phase 1 324/324, full repository 552/552, and eight selected assertions on both Node 18.18.2 and 20.19.4; fresh native review found no blocker.
6. [Complete for superseded source `2b39e13`] Exact Phase 1 passed 324/324 and full repository passed 552/552; producer v2 published Phase 0 `verified_on_draft` digest `f7c9779e…` and Phase 1 `implemented_unverified` digest `53bb71c6…`; evidence-only commit `426b999` preserved strict Phase 0/1/all-ledger replay while expected readiness gates remained red.
7. [Timeout remediation committed; exact focused replay passed] Commit `64a095c` gives the updater's serial full gate a bounded 20-minute budget. Exact Phase 1 replay passed 324/324; full replay/producers are deliberately delayed until the source-changing live-receipt and runner work below is frozen.
8. [Contract complete; live runner pending] Commit `d5f77da` closes the generic-authority and offline live-receipt contract defects. Keep receipts provisional and `hostVerification:not_run`; the fixed high-level observation/publisher runner is still required before live proof exists.
9. [Client complete; installed runner pending] Commit `0cafff7` supplies the bounded strict MCP STDIO client with 56/56 cross-Node tests and fresh approval. Implement the opt-in installed Worker MCP runner using the eight-step evidence procedure above: exact installed bytes, fixed seven tools, authenticated completion, MCP-server reconnect without duplicate provider launch, idempotent cancellation, repository immutability, session deletion proof, and runner-owned process cleanup.
10. [Local observability complete; hosted replay pending] Commit `98e2596` supplies bounded zero-skip v2 identities and a 30-minute matrix budget. Push it, rerun the supported hosted matrix, and remediate any newly named cross-host failure before calling CI green.
11. [Early rehearsal; non-qualifying] After the installed runner exists, exercise the eight-step direct and natural vertical on one exact committed identity to expose live integration defects early. Mark every resulting receipt provisional/rehearsal-only; any subsequent source change makes it stale, and it cannot qualify the final source.
12. Complete every remaining source-changing prerequisite: the signed independent-review request/import/promote boundary, the completion-model contradiction, the required Phase 2–5 runtime/features, and the Phase 2–5 plus aggregate evidence producers. A local subagent report or structural receipt is non-qualifying. Generate no final record or receipt while these source surfaces are still moving.
13. Freeze the final source exactly once after step 12, replay fixed Phase 1 plus the full repository gate, and refresh the exact plugin cache through byte-identical inventory verification. Do not publish final phase or aggregate records before the live and corpus observations below exist.
14. Repeat the full eight-step installed/authenticated direct-MCP completion and reconnect/cancel scenarios on the final source/install identity. For every scenario session, require successful presence → delete → absence proof before its receipt is published. Do not describe MCP-server restart as worker-crash recovery.
15. Run a separate fresh natural-Codex task on that same final source/install/capability identity without caller-supplied `_meta`, and require successful presence → delete → absence proof for its session before receipt publication. The natural receipt proves host authority; only the matched synthetic-provider plus natural-Codex receipt pair may satisfy installed-host qualification.
16. Execute the paired Phase 5 corpus and bounded measurements against the frozen final identity; if the corpus changes source, return to step 12 and invalidate all later records/receipts before refreezing.
17. Only after steps 14–16 succeed, build final Phase 0–5 records in dependency order with exact predecessor, live-receipt, and corpus references plus mandatory gate IDs; write the aggregate record and strict-replay the complete chain.
18. Require both ledger integrity (`npm run worker:verify -- --all --strict`) and release readiness (`npm run worker:verify -- --all --strict --require-complete`) to pass with no skipped mandatory boundary.
19. Obtain fresh independent native validation of the exact final commit and its records/receipts; optional Grok review is additive only.
20. Update issue #25 and PR #26 with exact commit, record/receipt digests and paths, replay commands, outcomes, and remaining unsupported cells.
21. Close issue #25 only if the aggregate exit definition is satisfied; otherwise leave it open with the next concrete gate.

This sequence leaves enough durable evidence for a fresh session to determine what exists, what passed, what remains unqualified, which identity was tested, and exactly how to replay every readiness claim.
