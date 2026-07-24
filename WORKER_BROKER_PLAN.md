# Native-like Grok Worker Broker execution and evidence plan

Status: Active roadmap; foundations are implemented but unverified in the current working tree and the work is not release-qualified

Roadmap version: `1.0`

Audit snapshot: `2026-07-24`

Canonical issue: [#25 — Make Grok Companion workers native-like through a structured worker broker](https://github.com/xliberty2008x/grok-plugin/issues/25)

Current delivery PR: [#26 — Worker Protocol v1 and read-only MCP broker](https://github.com/xliberty2008x/grok-plugin/pull/26)

Related contracts: [SPEC.md](SPEC.md), [PLAN.md](PLAN.md), and the draft [Native MCP Control Surface enhancement ADR](docs/superpowers/specs/2026-07-16-native-mcp-control-surface-design.md)

## 1. Current truth and document authority

This document is the durable execution, verification, and remediation plan for issue #25. The issue is the concise progress mirror; source, immutable evidence, and successful replay commands are authoritative.

The post-implementation audit found substantial Phase 0–4 foundations and Phase 5 safety tests in the working tree. Phase 0/1 were subsequently regenerated in the current evidence shape for exact source `2b39e13`, and evidence-only commit `426b999` preserved strict replay. Those records remain valid for that superseded source but are stale against the later updater, live-receipt, MCP-client, and reporter source commits. Phase 2–5 records still bind older source/evidence shapes and remain rejected by the hardened strict verifier.

Current conservative phase status:

| Phase | Current state | What exists | Why the phase is not complete |
| --- | --- | --- | --- |
| 0 — Evidence system | `implemented_unverified` | Schema, validator, capture/verify CLI, parser-backed static-import phase closure, fixed serial proof runners, immutable-record and ledger logic, fail-closed tests, pre-publication proof-home cleanup, fixed absolute Python/PTTY binding, provisional live-receipt replay, bounded zero-skip v2 diagnostics, a code-owned installed Worker MCP observation/publisher runner, and a protected signed-review request/attestation/promotion boundary | Exact source `2b39e13` passed Phase 1 324/324 and full 552/552 and produced a strictly valid ledger-current Phase 0 record. Committed Q2 source `4ce2d85` passed the evidence suite 121/121 and the root-owned Docker boundary 1/1 with 14 hostile scenarios, but later source work and the synthetic Docker signer mean exact clean-source replay and replacement records remain required |
| 1 — Worker API | `implemented_unverified` | Protocol/schema projections, durable events/cursors, authority-bound reads, exact context-bound launch authorization, intent-bound private-channel provider bootstrap, exact controller/worker/provider identities, autonomous capability-bound startup recovery, atomic cleanup-safe terminalization, cancellation, root host-claim suppression, a bounded strict MCP STDIO client, stable transaction-time spawn responses, durable private response witnesses, and an atomic externally signed Phase 1 promotion path | Exact source `2b39e13` produced a strictly valid ledger-current, honest `implemented_unverified` Phase 1 record. Q2 implements the signed promotion boundary, but the final source still needs fresh Phase 0/1 proofs, a real protected independent issuer, installed MCP proof, and authenticated-provider proof |
| 2 — Mailbox/context/roles | `implemented_unverified` production path plus protected producer | Provider/session/attempt-bound mailbox capability evidence, an attempt-bound ordered ACP delivery pump, explicit ambiguity states, body-free inflight and communication-chain records, autonomous crash settlement, broker-built canonical ContextPacket, immutable explorer/reviewer/security/test role-profile-tool policies, body-free Context Receipt, exact effective-prompt and provider-lineage binding, restart/tamper rejection, public exact-owner role decisions, grant-bound same-session follow-up through the normal durable launch outbox, and the fixed protected Phase 2 producer/replay surface | The installed authenticated vertical passed on source `e1b03af` and its provisional v2 receipt is committed in `1fa1cd5`; final-source Phase 0 plus protected signed Phase 1 predecessors and a current protected Phase 2 record are still missing |
| 3 — Worktrees/artifacts | `implemented_unverified` foundations only | Control-workspace identity, shared state, clean-parent fingerprinting, managed-worktree and artifact validation helpers | The broker never provisions or launches in a worktree, globally rejects concurrent writers, has no durable artifact/integration lifecycle, and has no Phase 3 proof producer |
| 4 — Host presentation | `implemented_unverified` foundations plus root MCP subset | Raw task-owned Worker Protocol MCP operations, provider-capability-gated explorer-only spawn advertisement, host-claim suppression, presentation/alias/tree helpers, and external-worker labels | Native-shaped presentation, role-specific public spawn, persistent aliases, multi-wait, positive broker-owned host verification, MCP-first skills, installed natural MCP flow, Claude qualification, and a Phase 4 proof producer are missing |
| 5 — Qualification | `implemented_unverified` | Deterministic safety-proof tests only | Paired native/Grok corpus, measurements, live boundaries, aggregate record, and release decision are not complete |

Issue #25 must remain open. This plan records one provisional installed/provider vertical on superseded source, but does not claim final-source installed/provider proof, natural-host proof, aggregate qualification, or release readiness.

The Native MCP Control Surface ADR is a follow-on design, not evidence that all E0-E7 execution slices are delivered. A task-owned MCP list/get/events/wait/result/spawn/decide/follow-up/cancel surface, the production Phase 1 provider-launch adapter, and the installed ordered-mailbox adapter now exist in the working tree. Post-terminal/reconnected follow-up proof, native-shaped presentation and multi-wait, positive broker-owned host-verification operation, skill preference changes, and natural MCP execution-loop proof remain future work. They must enter this plan as separately bounded deliveries with the same exact-source evidence rules before any related checklist item can be marked complete.

### Progress calibration and pre-E2E audit delta

The source-backed audit in [issue comment 5048315213](https://github.com/xliberty2008x/grok-plugin/issues/25#issuecomment-5048315213) is an execution-plan correction pinned to `dc9c9cd`, not qualification evidence. The current working tree is newer, so each finding is reconciled against the current implementation rather than copied as if no work had happened.

These bars are planning estimates, not evidence states or time estimates. They are recalculated from implemented behavior, unresolved safety contracts, and missing installed/live proof; only the phase states and immutable records can support readiness claims.

| View | Current estimate | Interpretation |
| --- | ---: | --- |
| Full roadmap source implementation | `52%` — `██████████░░░░░░░░░░` | Transparent rubric: production-wired plus negative-tested = 1, partial production = 0.5, helper/fail-closed scaffold = 0.25, absent = 0; committed Q2 plus source-complete P2.1–P2.4 and the protected P2.5 producer boundary support 23.75 of 46 non-deferred deliverables (48 total IDs minus P4-D6/P4-D7 deferred) |
| First read-only vertical E2E readiness | `100%` — `████████████████████` | The first installed authenticated vertical completed on exact source `e1b03af`: installation, setup/capability/MCP observations, three ordered prompts, reconnect/replay, completion, cancellation, cleanup, session deletion, and provisional receipt publication all passed. This is not final-source qualification; source-changing P2.5 and later phases require the same vertical to be rerun on the final freeze |
| Actual exact-source qualification evidence | `0%` — `░░░░░░░░░░░░░░░░░░░░` | No immutable current record exists for this source identity; installed/live Codex, authenticated Grok, Claude, paired corpus, and aggregate qualification are also absent; implementation progress and moving-tree tests are not qualification proof |

Reproducible roadmap score after the stationary focused gate:

| Phase | Earned units | Basis |
| --- | ---: | --- |
| Phase 0 | `4.50 / 8` | Evidence machinery plus the protected signed-review boundary are production-wired; final current records and real-issuer/live proof are absent |
| Phase 1 | `6.25 / 8` | Root read API, autonomous outbox recovery, process safety, and cancellation are wired; compatibility/live provider proof remains |
| Phase 2 | `7.75 / 8` | ContextPacket/Receipt, exact public host-action decisions, grant-bound same-session follow-up, ordered same-session ACP mailbox delivery, and the protected fixed producer are production-wired; the provisional installed vertical passed on `e1b03af`, while the final protected prerequisite chain/current record remains |
| Phase 3 | `1.75 / 8` | Identity/worktree/artifact helpers exist without a production write lifecycle |
| Phase 4 | `2.50 / 6` non-deferred | Raw root MCP, capability filtering, and host-claim suppression exist; native presentation/live adapters remain |
| Phase 5 | `1.00 / 8` | Deterministic safety slice only |
| **Total** | **`23.75 / 46`** | The two deferred Phase 4 IDs are excluded |

Per-delivery score ledger (ordered exactly as each phase table; `D` is deferred and excluded):

| Phase | Delivery-unit awards |
| --- | --- |
| P0 | `D1=1, D2=1, D3=1, D4=1, D5=0, D6=0, D7=0, D8=0.5` |
| P1 | `D1=1, D2=1, D3=1, D4=1, D5=1, D6=1, D7=0.25, D8=0` |
| P2 | `D1=1, D2=1, D3=1, D4=1, D5=0.75, D6=1, D7=1, D8=1` |
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
| Code-owned live qualification receipt | `provisional_pass_on_e1b03af` | Receipt v2 digest `e29ccee4…` is committed in `1fa1cd5`; it is source-bound supporting evidence and must be regenerated after final source freeze |
| Installed exact-artifact MCP loop | `provisional_pass_on_e1b03af` | The runner clean-installed byte-identical source, verified the setup/capability receipt and exact ten-tool MCP surface, then passed completion/mailbox/replay/cancellation, cleanup, and session deletion |
| Authenticated provider cancellation and MCP reconnect | `provisional_pass_on_e1b03af` | One real provider process/session completed three ordered prompts with two sends, replay emitted no fourth prompt, cancellation was idempotent, and cleanup passed; this is not worker-crash recovery and not final-source qualification |

Pre-E2E finding alignment:

| Audit finding | Current state in the newer tree | Required placement |
| --- | --- | --- |
| 1. One versioned launch authorization and one production launcher | `root subset implemented_unverified`: broker jobs use exact v2 launch authorization and MCP dispatches only through `launchCommittedWorker`; legacy CLI compatibility remains separate and cannot widen the MCP path | Bind idempotent no-double-launch and legacy migration negatives to the clean Phase 1 record, then replay the installed root loop |
| 2. Durable launch lease/outbox | `implemented_unverified`: attempt-bound dispatch, fencing, pre-spawn intents, exact identities, no-replay recovery, and a bounded startup supervisor autonomously claim a committed capability-bound pending job after restart | Bind restart/concurrent-claim/crash-window proof to the clean Phase 1 record, then repeat through the installed process |
| 3. Exact broker-owned repository context | `root and follow-up subsets implemented_unverified`: admission validates or captures the exact context, binds the canonical envelope to its manifest ID, includes it in request/provider-prompt authorization, and revalidates before execution; grant-bound follow-up freezes the final child-bound completion/verification manifest and rejects context/profile/session drift | Bind the root and follow-up drift regressions to clean Phase 1/2 records; repeat the child flow after terminal state and MCP reconnect against the real installed provider |
| 4. Verified `ExecutionBinding` for writes | `not_started` in production: worktree/fingerprint helpers exist, but `allowWriteSpawn` is still only a boolean gate and runtime executes from the control root | Phase 3 write vertical; no write capability may be advertised before this exits |
| 5. Advertise only installed live capabilities | `root-read, same-session-follow-up, and ordered-mailbox subset implemented_unverified`: a private setup receipt binds plugin/MCP contract/provider binary/version/platform/profiles/expiry; the frozen MCP surface exposes six base tools and exposes the exact ordered ten-tool inventory, including `worker_send`, only for the exact ordered three-capability receipt. Missing, reordered, duplicated, extra, partial, expired, or drifted capabilities fail back to the base six; write remains hidden | Bind the focused negatives to exact-source evidence and prove the same ten-tool set from the installed artifact; write capability remains separate work |
| 6. Separate broker-owned host-verification receipt | `non-forgery subset implemented_unverified`: MCP projections suppress embedded verification/runtime proof and force `hostVerification:not_run` | Bind forged-claim negatives to exact-source evidence. Positive broker-owned verification is still `not_started` and must not be inferred from suppression |
| 7. Bind every root task to its provider lineage | `implemented_unverified`: root and nested follow-up admission persist canonical root lineage, immediate resume parent, root provider-home identity, and transitive retention/cleanup fencing; two-hop and write-parent/read-child isolation regressions pass | Bind the lineage regressions to exact-source Phase 1/2 records and prove the same chain through the installed provider, including uncleared-root blocking and post-terminal reconnect |

The three post-first-vertical improvements are accepted but do not delay the smallest read-only loop. They have stable delivery IDs and must gain code-owned gates and evidence-scope membership before aggregate qualification:

| ID | Post-first-vertical delivery | Required proof target |
| --- | --- | --- |
| P2-D8 | Non-silent Context Receipt bound to the actual prompt context | Persist/publicly project body-free packet digest, mode, provenance, omissions, bounds, truncation markers, and `hiddenRecordsExported:false`; reject semantically unsafe clipping |
| P4-D8 | Durable completion-consumption accounting without unsupported auto-wake claims | Prove wait, explicit result, and optional notification channels produce one durable consumption outcome across restart; timeout/foreign reads do not consume |
| P5-D8 | Observed runtime evidence | Record requested versus ACP-observed protocol/model/effort/provider/host values, use null when unobserved, and invalidate qualification on identity drift |

The local broker subset, bounded MCP client, stable spawn witness, ordered mailbox pump, installed contract, and fixed runner are now present and focused-negative-tested. That runner completed the first exact vertical on `e1b03af`; the remaining qualification milestone is to repeat **installed MCP setup receipt → exact ten-tool list → spawn → real provider start → two ordered sends → wait → last-turn result with `hostVerification:not_run` → replay without a fourth prompt → cancellation/MCP-reconnect cleanup** on the final frozen source/install identity. This is an honest root read-only loop, not a positive host-verification receipt. The follow-up portion must additionally prove exact same-session resume after terminal state and MCP reconnect. Finding 4 gates the separate write-worker vertical.

Vertical evidence procedure and expected deliverables (use once for an early rehearsal and repeat in full after the final source freeze):

1. Create a private temporary `CODEX_HOME`, plugin-data root, and fixture repository; record their bounded inode/owner/device identities and remove them before receipt publication.
2. Install from the exact committed source under test, compare bounded source and installed inventories byte-for-byte, and run installed `grok-codex setup --json`; require `ready`, authenticated provider state, protocol v1, loadable session state, and isolated paths. Exit code alone is insufficient. An early rehearsal receipt becomes stale after any later source change and cannot qualify the final source.
3. Start the installed MCP server through the bounded client from `0cafff7`; validate the negotiated MCP version/server identity and require the exact ordered ten-tool inventory for the combined root-read, same-session-follow-up, and ordered-mailbox receipt. Prove every partial, missing, reordered, duplicated, extra, expired, and drifted receipt exposes only the base six. Call each operation with its own authority `_meta`; prove missing metadata fails with `E_AUTH_REQUIRED`.
4. Completion scenario deliverable: one durable spawn request, one observed provider launch, three ordered prompts on one provider process/session, two accepted/delivered public message receipts identity-bound to the exact private records, terminal wait/result agreement with the sequence-2 final report, replay without a fourth prompt, immutable event identities, and `hostVerification:not_run`; source-tree imports, duplicate provider launch, raw output, retained bodies, and repository mutation are failures.
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
| `qualified` | Aggregate-only release state: current deterministic Phase 0–5 records, signed Phase 1 review, matched installed/provider receipts, paired corpus, required CI, and release evidence passed for one exact source/install/runtime identity. Phase 0–5 records themselves must reject this state. |
| `blocked` | A named authority, safety, or architecture decision prevents safe progress. |
| `deferred` | Intentionally outside the current phase or release scope. |

Rules:

1. Implementation presence is not verification.
2. A test summary, PR statement, issue checkbox, screenshot, worker report, or reviewer opinion is not an evidence record.
3. `skip` and `not_run` cannot satisfy `verified_on_draft` or `qualified`.
4. Historical and invalidated records remain readable and tamper-checked, but can never satisfy current prerequisites or qualification.
5. Every current prerequisite names the exact predecessor record digest and mandatory passed gate IDs.
6. A source, phase-scope, install, host, provider, or runtime identity change invalidates the boundary it affects.
7. Final readiness requires six current `verified_on_draft` Phase 0–5 records plus one separately producer-owned `qualified` aggregate; per-phase records or standalone live receipts alone are insufficient.

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
npm run test:protected-review
npm run validate
npm run worker:verify -- --all --strict
npm run worker:verify -- --all --strict --require-complete
```

`test:protected-review` is an explicit external supporting gate: it must run
without a skip and bind the root-owned runtime, exact Git, Docker
client/Buildx/socket/daemon, immutable image ID, container IDs, restart replay,
and hostile scenarios. It does not by itself promote Phase 1 because its signer
and phase proofs are synthetic. Final Phase 1 promotion must repeat the same
boundary from the frozen exact source with the actual proof chain and a real
protected independent issuer, then persist the signed request, attestation,
receipt, record, and ledger transition for offline replay.

The original audit exposed both stale records and a structurally unsatisfiable
completion model. Q1 corrected the model: numbered phases terminate at
`verified_on_draft`, only the private aggregate may be `qualified`, and
`--require-complete` requires exactly six current numbered records plus that
aggregate. The command remains expected to fail until the final source has a
complete current chain; that red result is missing qualification evidence, not
permission to weaken the model.

`--all --strict` is an integrity/freshness replay. It may pass for an honestly incomplete ledger and therefore is never a completion claim. The corrected release model must make `--require-complete` require current `verified_on_draft` Phase 0–5 records and exactly one producer-owned `qualified` aggregate that composes signed review, matched live receipts, corpus, CI, and release proof. Standalone direct/natural receipts remain provisional supporting evidence and never become ledger-current phase records.

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

Producer v4 runs the fixed direct Phase 0/1 manifests and the protected fixed Phase 2 manifest. It binds a clean stable source and phase-scope file identity before/after every gate and publication, rejects symlinked scope code plus evidence-only executable seeds/dependencies, closes local static ESM imports with Node's non-evaluating module parser, runs each fixed focused inventory serially through a structured zero-skip/TODO reporter, stores only bounded redacted output digests, and performs locked fail-closed cutovers. Phase 0 may publish `verified_on_draft` after its exact gates pass. Public Phase 1 deliberately publishes only `implemented_unverified` with `independentValidation: not_run`; authenticated promotion still requires the separately protected signed-review issuer. Public Phase 2 proof calls return `E_PROOF_ARGUMENT`. Only the protected root-owned runtime may invoke `prove-phase-2 --workspace`, and it requires exact ordered current Phase 0 plus signed current Phase 1 `verified_on_draft` predecessors under `requireFresh:false` replay. Its fixed slice is `2/mailbox-context-roles`; its manifest digest is `a88795f9f48d632451eed5d7dfd1b7fe482638fc83386128d3f70490f33dac22`; only deterministic qualification passes, all live/release boundaries remain `not_run`, and the record contains no live-receipt linkage. `verify-phase-2 --workspace` verifies that exact current Phase 2 record rather than merely replaying the signed ledger. Phase 3–5 still need fixed producers. A private aggregate producer alone may compose exact phase digests with live/corpus/CI evidence and publish `qualified`.

Producer v4's local gate engine is a same-user qualification runner, not a sandbox or verifier for hostile repository code. Deterministic proof assumes every fixed gate and all descendants are quiescent when the direct gate exits, and that no other process running as the publisher UID concurrently mutates the repository, proof home, or evidence tree. Observable identity mismatch, replacement, inaccessible descendants, cleanup errors, static symlink escape, prerequisite drift, and protected-trust failure close before publication. Intentionally surviving same-UID processes, retained open descriptors, witness manipulation, and post-gate mutation require a separately privileged supervisor and are outside this local producer boundary. Successful cleanup proves pathname-level removal of the bound proof-home tree without traversing tested static symlink targets; it does not prove destruction of data retained through an open descriptor by an out-of-contract process. Windows proof production returns typed `E_PROOF_PLATFORM` until an equivalent bound-handle cleanup protocol exists.

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
| P0-D4 | Proof-producing capture/replay workflow | `implemented_unverified` | Producer v4; aggregate-only qualification semantics; fixed direct Phase 0/1 manifests plus protected fixed Phase 2; exact serial runners; zero-skip reporter; scope-file identity, symlink, and executable-evidence-path defense; broker-owned provenance; absolute toolchain binding; private proof environment/promotion authority; immutable signed review request/attestation; root-owned protected Ed25519 trust/runtime/Git boundary; atomic Phase 1 promotion and Phase 2 publication; safe cutover and strict replay. After the P2.5 security remediation, exact source `d360460` passed 127 evidence/protected tests with only the explicit external Docker test skipped, plus the exact Phase 2 runner 292/292 | Run the extended external Docker lifecycle on the final remediation source, obtain a fresh independent review, and continue source-changing phases. On the final roadmap source publish Phase 0/1 proofs, obtain a real protected independent issuer attestation, run protected promotion, publish exact protected Phase 2, and persist the request/attestation/receipt/record/ledger proof. The synthetic Docker signer is supporting evidence only |
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

The code-owned `phase-1-focused-tests` manifest invokes `scripts/test-phase1-focused.mjs`; that script's frozen 27-file list is the authoritative focused inventory. It includes protocol/service/MCP runtime, installed Worker MCP contract/runner, process control, provider/bootstrap, recursion guard, mailbox, cancellation, reconciliation, rotation, recovery-fence, terminal-intent, CLI-authority, mutation, and safety-proof suites. `scripts/lib/deterministic-test-runner.mjs` launches exactly one file at a time and aggregates exact zero-skip summaries, including on Node 18.18 where `--test-concurrency` is unavailable. Do not copy a shorter hand-maintained test list into an evidence claim.

Required scenarios include owner success, foreign/nonexistent equivalence, missing/malformed/spoofed authority, unsupported protocol, cursor gaps, cross-process idempotency, crash before/after durable commit, cancel in the commit-to-launch window, no mutating replay, provider-launch failure preservation, raw-vs-redacted identity separation, null birth-token cleanup witnesses, corrupted PGID rejection, report-repair rotation promotion before guard removal, and terminal/privacy publication only after verified cleanup.

Phase 1 exits only when all public schemas and operations pass on one clean exact commit, current Phase 0 prerequisite digest/gates close, restart/crash behavior is proven, the current record is at least `verified_on_draft`, authenticated signed independent-review proof validates, and `--require-verified` passes. Plain strict integrity success for `implemented_unverified` is not phase exit. Installed/live boundaries remain separately named until run.

## 8. Phase 2 — Mailbox, follow-up, context packets, and roles

Current state: `implemented_unverified`

Phase 2 adds durable communication and lineage-preserving follow-up without inventing mid-turn steering or exactly-once guarantees that ACP cannot prove.

### Phase 2 expected deliverables

| ID | Deliverable | Current state | Artifact or proof | Remaining work |
| --- | --- | --- | --- | --- |
| P2-D1 | ACP acknowledgement/dedup capability record | `implemented_unverified` production path | The setup receipt binds `ordered-turn-boundary-mailbox-v1` to the exact provider/session/attempt authority; only the exact ordered three-capability receipt exposes `worker_send`, and delivered settlement requires the exact successful ACP response | Bind the capability observation to a current Phase 2 record and prove it through the authenticated installed provider; retain explicit ambiguity on every unmatched or uncertain response |
| P2-D2 | Ordered durable mailbox and outcome state machine | `implemented_unverified` production path | Attempt-bound `preparing -> open -> closing -> closed` sidecar; contiguous accepted/claimed/inflight/delivered-or-unknown transitions; body-free inflight state; same-lock send/close ordering; cumulative bounds; autonomous recovery settlement; no retry of unknown; complete body scrub | Produce the fixed Phase 2 record and run the authenticated installed broker-reconnect/cancellation/no-retry lifecycle |
| P2-D3 | Active send and terminal/idle lineage follow-up | `implemented_unverified` production path | One provider process/session drains the primary turn plus two ordered sends, selects only the last completed report, and replays without a fourth prompt; exact-owner grant-bound follow-up separately commits one child through dispatch v2 on the exact parent session with root/immediate lineage and child-bound final context | Prove both same-session paths through the authenticated installed provider and publish the fixed exact-source Phase 2 record |
| P2-D4 | Explicit-envelope Context Packet v1 | `implemented_unverified` production path | Broker-built canonical packet and policy are bound into the durable spawn request and exact effective provider prompt; public output exposes only body-free receipt provenance | Final exact-source Phase 2 record and installed/live replay remain; stronger transcript modes stay disabled |
| P2-D5 | `recent:N` and broader transcript modes | `implemented_unverified` | Capability gates exist | Trusted transcript acquisition remains unproven; keep modes fail-closed |
| P2-D6 | Immutable explorer/implementer/reviewer/security/test roles | `implemented_unverified` read-role production path | RuntimeRolePolicy binds role digest, write bit, exact provider profile/version/agent bytes, and complete allowed/denied provider-tool ID digests; launch preparation rechecks the actual prompt/profile binding; exact reviewer/security/test grants are consumed only by a read-only child follow-up and never mutate the current worker | Keep implementer/write admission hidden until Phase 3 ExecutionBinding exists; bind the read-role path to final exact-source and live evidence |
| P2-D7 | `awaiting_host_action` authority request | `implemented_unverified` production path | The final valid provider report persists one body-free request bound to the exact worker, launch attempt/fence/generation, process/session, context, resume, role, and policy; the public decision tool accepts only `{id, requestId, decision, idempotencyKey}`, derives private digests after exact-owner authorization, durably grants/denies once, and the follow-up tool consumes the exact grant without caller authority fields | Produce final exact-source Phase 2 proof and installed/authenticated decision-to-follow-up evidence |
| P2-D8 | Non-silent Context Receipt | `implemented_unverified` production path | Body-free receipt binds packet, role policy, manifest, lineage, exact prompt, counts/digests, provenance, omissions, and bounds; schema/runtime coupling and hostile downgrade tests pass | Final exact-source Phase 2 producer/record plus installed/authenticated live replay remain |

Delivery states remain `accepted`, `pending`, `delivered`, `delivery_unknown`, and `rejected`. Never automatically retry `delivery_unknown`. Exactly-once delivery may be claimed only with provider acknowledgement or deduplication proof across crash.

### Phase 2 authoritative checks

```sh
node --test \
  tests/worker-mailbox.test.mjs \
  tests/worker-context-roles.test.mjs \
  tests/worker-mutation.test.mjs \
  tests/worker-protocol.test.mjs \
  tests/mcp-worker-runtime.test.mjs
npm run check
git show --check --format= HEAD
npm run worker:verify -- --phase 2 --strict
```

P2.3 source-close proof ledger:

- Observed on the frozen moving tree: the P1-regression batch passed 50/50; the final focused production batch passed 204/204; and the named fake-provider MCP vertical passed 1/1.
- The fake-provider vertical asserts one `session/new`, one exact `session/load` for the parent session, exactly two prompts on that session, no third prompt on replay, exact immediate-parent/root lineage, the granted reviewer role, a child-bound Context Receipt, and cleanup of both parent and child runtimes.
- Capability/authority negatives cover atomic exact-six/exact-nine tool advertisement, missing/reordered/duplicated/extra/drifted capability entries, capability expiry before decision/admission/dispatch, caller-supplied private authority fields, foreign/missing equivalence, exact consumed-launch/dispatch tamper, write-parent/read-child profile isolation, nested retention, and supervisor restart/claim.
- `npm run validate` and `git diff --check` pass on the frozen tree; a fresh native post-implementation review reports no P0/P1. An earlier 121-case evidence run passed 118 cases before three CLI children hit a leaked-workspace 15-second Git-read cutoff; after the orphaned read-only scans were removed, Git status returned to 0.01 seconds and the exact three-case tail passed 3/3.
- Detached clean clone `4bac578` passed `npm run check` with 771/771 and zero failed/cancelled/skipped/TODO, followed by `git show --check --format= HEAD`. P2.3 remains `implemented_unverified` because this deterministic exact-source result is not installed/provider qualification.
- None of these local checks creates lifecycle qualification. Phase 2 still requires the fixed producer/current record plus an installed authenticated ten-tool lifecycle covering ordered mailbox delivery and decision → follow-up, including child terminal state, MCP reconnect, replay, and proof that neither path sends an extra prompt.

P2.4 frozen implementation and verification contract:

1. Add an attempt-bound mailbox sidecar with `preparing -> open -> closing -> closed`. Bind it to worker, dispatch attempt/fence, worker and provider process digests, provider generation, provider-session digest, provider-capability digest, original Context Receipt digest, next sequence, cumulative accepted count/UTF-8 bytes, and the ordered communication-chain digest. `job.status` alone is never mailbox authority.
2. Serialize both send acceptance and the pump's final empty-scan/close transition under the same short workspace transaction. If send wins, the message receives the next contiguous sequence and must drain; if close wins, send is rejected. Never hold a filesystem lock while waiting for ACP.
3. Use durable message transitions `accepted(body) -> claimed(body) -> inflight(body-free, exact numeric RPC id) -> delivered | delivery_unknown`; `accepted/claimed -> rejected` remains valid. Publicly, claimed/inflight stay pending. Once inflight is ambiguous, never retry it, close the pump, reject later unattempted messages as blocked by the unknown turn, and remove every retained body.
4. Harden ACP with reserve-then-dispatch: reserve an exact numeric request ID without writing bytes, durably publish body-free inflight with that ID, then dispatch once. `delivered` requires JSON-RPC `2.0`, the exact numeric ID and response type, no `method`, exactly one valid result/error branch, and a valid successful `PromptResponse`. Wrong/string-colliding IDs, server requests, malformed/duplicate/error/cancelled/timeout/closed responses never become delivered.
5. Bind every completed turn into a body-free ordered communication chain covering the original Context Receipt, role/policy, attempt/fence, provider generation/process/session/capability, sequence, content digest, composed prompt digest, and outcome. Bind the final chain digest into completion evidence and any host-action source binding.
6. Select the final provider report from the last successfully completed mailbox turn only. A later turn without a valid report must enter repair/failure; it may never reuse the primary turn's earlier report marker. Report repair runs only after mailbox closure and cannot reopen acceptance.
7. Enforce cumulative per-attempt limits of 32 accepted messages and 256 KiB of UTF-8 message bytes. Remove caller-defined delivery outcomes and caller-constructed capability booleans from the production service path; only the exact worker/provider pump may settle delivery.
8. Add capability `ordered-turn-boundary-mailbox-v1`. Only the exact ordered three-capability receipt exposes the ten-tool inventory including `worker_send`; every missing, reordered, duplicated, extra, expired, or partial receipt exposes the base six. Write capability remains hidden.
9. Run the smallest fake vertical immediately after the ACP and state core are executable: hold the primary prompt, accept two messages, complete the primary turn, drain message 1 then 2 through one ACP PID/session, close, and publish the last-turn result. Require one initialize/session setup, three ordered prompts, no fourth prompt on replay, exact process/session identity, final chain binding, and complete body cleanup.
10. Run the real-provider happy-path vertical before expanding the fault matrix. Then add broker reconnect between sends, atomic send/close race, crash at every inflight boundary, unknown/no-retry, cancellation, recovery, cumulative-limit, hostile-record, foreign-opacity, report-repair, final-turn-no-report, and capability/API tests. Use durable barriers rather than sleeps; an MCP restart is broker reconnect, not provider reconnect.

Required live proof queues multiple messages during a bounded job, restarts the broker, and accounts for every message as delivered, rejected, or delivery_unknown. Follow-up must bind parent/lineage, reject context/profile/session/capability drift, complete on the exact resumed provider session, and replay after child terminal state plus MCP reconnect without another prompt. The Context Receipt must match the effective prompt context without exporting bodies or hidden records. Evidence excludes raw message bodies, private digests, provider session IDs, and hidden host records.

P2.4 source-close proof ledger:

- The primary Grok construction job `task-2f14a511e669a94edb47f24b` failed terminally with `E_PROTOCOL: Internal error`; the documented native fallback completed the bounded slice. The failed worker lifecycle is preserved as a failure, not converted into verification.
- The fake-provider vertical proves one provider PID/session, three ordered prompts, two delivered sends, last-turn report selection, and no fourth prompt on replay. Focused closing gates passed: ACP/protocol 26/26, provider plus mailbox 45/45, cancellation/state 19/19, exact full MCP runtime 38/38 after the final two cancellation regressions, installed contract/runner 33/33, and live-receipt v2 evidence 7/7; repository validation and diff checks passed.
- A fresh native closeout review found one cancellation race between durable primary-turn admission and consumption. The consume transaction now rechecks the nonce-bound cancellation marker before mutation, and deterministic generation-1 plus report-repair generation-2 barriers pass 2/2 with zero post-cancellation prompt bytes. Fresh rereview is P0/P1-clear and confirms the test seam cannot enter through `trustedWorkerEnvironment`.
- Live receipt v2 keeps v1 immutable, binds exact source/install/provider/capability identity, requires the exact ten-tool surface, identity-cross-binds both public sends to private delivered records, binds the sequence-2 final report independently to the terminal result digest, proves body/process/session cleanup, and preserves strict `O_EXCL`/`O_NOFOLLOW`. Exact source `e1b03af` produced the provisional pass receipt at `tests/e2e-results/worker-broker/live-receipts/v2/synthetic-direct-mcp/ef3aba032bb8c713-e29ccee4a2ca0ad6.json`: manifest digest `179f210223b5bc963fa94295217fa7ed9710c5f7620ac6e2eb4883f28b943b73`, receipt digest `e29ccee4a2ca0ad646d6b1fd9af7ab1a442e1bb16402d8849c5e15fa3192d8ab`. Evidence commit `1fa1cd5` preserves it as supporting history; it is not a final-source record.
- A moving-tree full evidence run reached 100 passed / 21 failed / 1 cancelled; every v2 assertion passed, while failures were in historical Phase 0/1 ledger/CLI paths under the moving shared checkout. This run is non-authoritative. The exact committed detached clean-clone gate must pass before live execution.
- The first detached exact-source gate at `2e0aef9` passed validation and then reported 773 passed / 22 failed / 0 skipped/TODO. Two MCP vertical failures were contention-only: both passed alone and together, and the full exact runtime file passed 38/38 in 162.7 seconds with at least 2x margin against its 30-second per-vertical bounds, so no production or timeout change was made. The other failures exposed one real fixture defect: the Phase 1 evidence fixture coupled ledger `schemaVersion` to live-receipt v2 even though the immutable ledger remains v1; 17 tests failed and three rejection tests were false-green for the wrong reason.
- The ledger/live-receipt fixture coupling is removed in the commit containing this checkpoint. Six representative signed-review/promotion cases pass after the fix. A shared-checkout full evidence replay then reached 116 passed before its concurrent proof-writer case left two task-owned proof children running; five later CLI cases hit exact 15-second cutoffs and the run was stopped. This contaminated moving-tree run is non-authoritative; all task-owned processes were removed, and a fresh detached exact-source full gate is required.
- The post-remediation moving-tree MCP runtime run passed 37/38; its single 30-second host-action wait timed out after 32.6 seconds under the shared checkout, and the exact case then passed alone in 4.9 seconds. Both new cancellation barriers passed inside the combined run. This is classified as a non-product contention observation; the detached exact-source full gate remains authoritative.
- P2.4 is source-complete and its first installed authenticated real-provider completion/mailbox/replay/cancellation vertical passed on exact source `e1b03af`; the provisional v2 receipt is committed in `1fa1cd5`. It remains `implemented_unverified` because later P2.5 source changes supersede that live identity, and the final Phase 0 plus protected signed Phase 1 predecessor chain and current protected Phase 2 record are still absent.

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
| P4-D1 | Structured status/result presentation without shell parsing | `partial production` | Raw task-owned MCP list/get/events/wait/result/spawn/decide/follow-up/cancel returns structured Worker Protocol records; pure presentation helpers also exist | Add native-shaped presentation, multi-wait, persistent aliases, and installed natural MCP proof |
| P4-D2 | Spoof-resistant aliases and parent/lineage tree | `not_started` end to end | Pure alias/tree helpers only | Persist a task-owned alias registry and descriptions; add collision, restart, cycle, and foreign-ID tests |
| P4-D3 | Capability matrix and fail-closed degraded state | `partial production` | Private provider receipt plus atomic exact-six/exact-ten MCP inventory, exact three-capability ordering, drift rejection, and hidden-operation rejection; authority metadata still fails closed | Add write capability records and prove full/degraded routing across installed supported hosts |
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
| A-07 Phase 2 foundation | P2.1–P2.4 production wiring supplies ContextPacket/Receipt, immutable runtime read roles, exact public owner decisions, grant-bound same-session follow-up through dispatch v2, ordered autonomous ACP mailbox delivery, capability revalidation, nested lineage, transitive retention, and fail-closed replay/recovery. P2.5 adds the fixed protected Phase 2 producer/replay boundary and now isolates its privileged operations behind fresh direct-main processes with no public producer/verifier exports | Worker mailbox/context/roles/host-actions/mutation/service/supervisor/MCP files; exact 18-file Phase 2 runner 292/292; exact-source evidence/protected review 127 passed with only the explicit external Docker boundary skipped; source-evolution reproof and hostile-import regressions pass | Complete the extended external Docker prove/verify/restart lifecycle and fresh security review. On the eventual final roadmap source, regenerate Phase 0, obtain protected signed Phase 1 promotion, publish/replay exact Phase 2, and rerun the installed/authenticated vertical because the committed `e1b03af` receipt is provisional |
| A-08 Phase 3 foundation | Strong control identity, worktree, fingerprint, artifact, and cleanup guardrail helpers exist; production write-worker/integration wiring was audited and is absent | Workspace/worktree/state files and tests | Add durable managed-root binding, real concurrent writers, terminal artifacts, explicit integration/verification/retention, and a Phase 3 producer |
| A-09 Phase 4 foundation | Raw task-owned MCP operations, immutable exact-capability-gated spawn/decision/follow-up/send advertisement, external labeling, structured-proof suppression, and normalized host-attested summary/progress/event suppression exist; installed flows still lack the final natural-host qualification path | Provider capability, worker presentation/protocol/service/MCP tests, and host scripts; P2.4 adds exact-six/exact-ten gating and hostile-input regressions | Build native-shaped presentation/multi-wait, persistence, positive broker-owned verification, MCP-first skill routing, installed natural Codex/Claude flows, and a Phase 4 producer |
| A-10 Phase 5 safety slice | Six deterministic Grok-side safety fixtures exist; no paired native adapter, scenario corpus, measurement harness, failure matrix, or aggregate producer exists | `tests/worker-safety-proofs.test.mjs` | Build typed paired corpus and >=5 samples per adapter/scenario, then bind live matrix and aggregate evidence without raw prompts/transcripts |
| A-11 Independent Grok work/review | Earlier review lifecycle ended with `E_STATE`; bounded cleanup job `task-ca1ff775a418d2b044e5f4de` wrote a partial scoped diff but ended `E_PROTOCOL` because the report-repair agent's curated tool registry was empty | No qualifying Grok report was produced; main Codex independently reviewed/extended the diff and recorded four passing host checks while preserving the failed worker status | Fix or route around report-repair provider registration before relying on Grok structured reports; never count either failed lifecycle as independent proof |
| A-12 Plan/issue synchronization | This plan links open issue #25 and now records conservative truth | This file | After commit, update issue with exact commit, commands, outcomes, record paths, and unchecked residuals |
| A-13 Native MCP enhancement | Draft ADR defines the E0-E7 path from durable broker foundations to a production native-shaped MCP control loop; only the Phase 1 provider launch slice is implemented in this tree | `docs/superpowers/specs/2026-07-16-native-mcp-control-surface-design.md` | Execute live delivery, facade/multi-wait, host verification, skill teaching, and natural MCP proof as bounded slices; do not count the ADR as implementation |
| A-14 Independent native safety audit | Fresh Phase 1 reviews found and remediation addressed wait mutation authority, replacement-generation witness loss, terminal-intent loss, unsafe legacy reconciliation, startup cancellation, unsafe cancel terminal hook, evidence-chain supersession, duplicate/foreign provider-bootstrap cleanup, promotion-pipe failure, detached startup crash windows, process-group/PATH hardening, autonomous outbox recovery, live capability revalidation, private bootstrap argv, normalized host-claim suppression, unbound public role advertisement, serial proof execution, static-import grammar/resolution bypasses, and unsigned schema promotion | Final integrated, runtime, and parser/evidence rereviews report no remaining actionable findings; review-only targeted batch was 30/30 and does not promote evidence status | Complete exact-commit gates; reviewer findings do not promote any phase without an authenticated exact-source receipt |
| A-15 Legacy cutover boundary | Immutable snapshot receipts, global quiescence preflight, late terminal import, and divergent-content failure are implemented | `workspace.mjs` and worktree migration regressions | Operate only after old workers finish/stop; retain legacy directories; do not claim live cross-version fencing |
| A-16 Evidence publication concurrency/privacy | Repository-local generation-bound ledger serialization, crash/reclaim transitions, raw publication validation, exact ledger allowlists, concurrent append regressions, private proof promotion, strict producer-current validation, post-ledger rollback, atomic v1 cutover, transitive supersession, absolute toolchain binding, exact scope-file identity, and fixed Phase 0/1 producer manifests are implemented | Source `2b39e13`: Phase 1 324/324, full 552/552, current Phase 0 digest `f7c9779e…`, current honest Phase 1 digest `53bb71c6…`; evidence-only commit `426b999` preserved strict integrity | Rebuild the chain after the installed-cache updater source fix; no implementation-only test result promotes the phase |
| A-17 Cross-version CI remediation | Linux/macOS CI now names the deterministic zero-skip suite; installed-host and authenticated-provider tests are separate qualification jobs; Windows remains an explicit provider-neutral cell | Node 18.18.2 and 22.x supported CI matrix; `npm run check`; GitGuardian; `.github/workflows/ci.yml` | Repeat on the exact remote commit and require supported Linux/macOS deterministic plus secret-scan jobs; do not present Windows provider-neutral tests as a full POSIX/provider qualification |
| A-18 Completion-model contradiction | Final qualification is currently impossible: any live pass/reference forces `implemented_unverified` plus provisional/no-release, while `qualified` requires installed/provider pass and non-provisional; provider/installed pass is limited to Phase 1/4, release pass to aggregate, yet `--require-complete` requires `qualified` for Phase 0–5 and aggregate | Evidence schema/validator, strict prerequisite/readiness logic, Phase 0/1 manifests, and a read-only constructed aggregate that returned the mutually exclusive errors together | Reserve `qualified` for aggregate only; require current deterministic `verified_on_draft` Phase 0–5 records, signed Phase 1 review, and a private code-owned aggregate producer that alone composes matched live receipts, corpus, CI, and release proof |
| A-19 Host/qualification proof surface | Phase 1 scope now explicitly binds MCP broker/server, provider bootstrap/capability, autonomous dispatch supervisor, provider agents, relevant skills, direct gate scripts, and crash/recovery tests; Phase 4/5/aggregate producers still do not bind the full install/natural/Claude/paired-corpus qualification surface | Evidence manifests/scopes, package scripts, CI, and stale historical records | Add code-owned Phase 4/5/aggregate producers and their remaining runtime-surface seeds/drift tests, then derive release qualification from the validated aggregate record |
| A-20 Source-backed pre-E2E audit delta | Issue comment 5048315213 supplied seven commit-pinned blockers and three post-first-vertical improvements; P2.1–P2.4 close the context/lineage/public-decision/same-session-follow-up/ordered-mailbox source subsets while preserving unsupported-tool hiding | Current source, acceptance mapping, P2.3/P2.4 fake-provider verticals, and this plan's progress rubric | Execute authenticated root/mailbox/follow-up and later write verticals separately, then add P4-D8/P5-D8 gates before aggregate qualification; P2-D8 is production-wired but still needs exact-source/live evidence |
| A-21 Independent-review authentication boundary | The reserved receipt is source-bound and tamper-evident but locally forgeable; Codex cannot authenticate a collaboration subagent, fresh independent session, exact remote runtime, or copied output from repository code alone | Evidence schema/library review and fresh native design audit | Add immutable review request, bounded signed-attestation import, pinned production public keys/revocation, separate promotion authority, atomic supersession, and strict offline signature/source/diff/proof replay; until then keep Phase 1 `implemented_unverified` |
| A-22 Proof-runner temporary cleanup | The first Phase 0 producer-v2 attempt on `b30fefd` exited nonzero with raw `ENOTEMPTY`; no evidence file or ledger cutover occurred. Reproduction showed `hooks.test.mjs` passed 26/26 while its wrong-root teardown leaked a mode-`000` fixture. Commit `31244be` resolves the real plugin-data root, makes teardown failure observable, binds the POSIX proof-home inode/owner/device plus an open no-follow handle, rejects copied identities, static symlink escape, and renamed/replaced roots, completes cleanup before publication with structured `E_PROOF_CLEANUP`, and rejects Windows proof production with `E_PROOF_PLATFORM`. The guarantee is explicitly limited to reviewed, quiescent code-owned gates; adversarial same-UID survivors require a privileged sandbox/supervisor. | Exact `31244be`: Phase 1 324/324 and full gate 550/550; moving-tree evidence 78/78; hooks 26/26; Windows-neutral 5/5; eight selected cleanup/platform/Python assertions passed on Node 18/20; fresh native review found no remaining actionable cleanup issue within the declared boundary | Preserve this boundary through the updater-fix source freeze and serial Phase 0/1 producers |
| A-23 Proof-runner Python/PTTY binding | Two Phase 0 producer runs on clean `31244be` failed at `repository-check` with the same bounded digest and no record/ledger publication. Exact raw reproduction returned 548 passed and 2 skipped because sanitized `PATH` resolved `/usr/bin/python3`, an unusable macOS Xcode stub. The remediation captures and hashes a native Python from reviewed Darwin/Linux locations, rejects shebang shims, probes under the final sanitized `PATH`, invokes the canonical absolute path with identical `-I -S -B` flags, scrubs the proof-only selector before Python/target startup, and fails closed with `E_PROOF_TOOLCHAIN` if no candidate works. This is a local quiescent toolchain binding, not hermetic attestation of the Python standard library or dynamic libraries. PATH-only pyenv/asdf installs are intentionally unsupported. | Both failed producer attempts returned `E_PROOF_GATE`/`repository-check` with digest `7ad1dd496f224d64aed5555e92fa76ffac8d9593195619096ed672d9cf0ea0ab`; no publication. Source `2b39e13`: evidence 78/78; PTY 4/4; Phase 1 324/324; full 552/552; successful Phase 0 producer/strict replay; two focused binding/fail-closed assertions 2/2; eight selected assertions passed on Node 18.18.2 and 20.19.4; fresh native security review found no blocker | Preserve this binding through the next source freeze. On `E_PROOF_TOOLCHAIN`, install native Python at a documented fixed location or resolve the macOS Xcode-license installation; do not add caller `PATH` or an unreviewed shim override |
| A-24 Installed-cache updater budget | The first exact-cache refresh after `426b999` stopped before install: `scripts/update-local-codex.mjs` applied its generic 180-second child timeout to the intentionally serial `npm run check`, which now takes about 11 minutes. `spawnSync` returned `ETIMEDOUT`; the script never reached cache mutation. Commit `64a095c` assigns the repository check a bounded 20-minute budget—five minutes of headroom over the proof producer's 15-minute repository gate—while preserving the generic timeout for smaller commands. | Failed command: `npm run codex:update-local`; outcome `spawnSync npm ETIMEDOUT` during step 1/4; no cache mutation. Exact `64a095c` Phase 1 replay subsequently passed 324/324 with zero fail/cancel/skip/TODO; full replay was intentionally deferred after A-25 exposed another source-changing pre-E2E blocker | Finish A-25/A-26-derived source work, run one final exact replay/proof chain, rerun `codex:update-local` through inventory-digest equality, then start a fresh Codex/MCP process because tools/list is frozen per server lifetime |
| A-25 Live qualification provenance | The generic evidence model previously accepted caller-authored live-pass claims. Commit `d5f77da` added the v1 fixed-manifest boundary; P2.4 adds the v2 ordered-mailbox schema/validator/runner, exact public/private send identity binding, last-turn report binding, direct-versus-natural authority separation, generic-writer/ledger rejection, bounded replay, and no exported mint/build/publish/link authority. The fixed installed runner has now exercised the real direct-MCP lifecycle | Exact source `e1b03af` published provisional receipt `ef3aba032bb8c713-e29ccee4a2ca0ad6.json`, digest `e29ccee4a2ca0ad646d6b1fd9af7ab1a442e1bb16402d8849c5e15fa3192d8ab`; evidence commit `1fa1cd5` preserves it and strict replay. It is supporting evidence, not a final phase record | Rerun the fixed runner after the final source/install freeze and keep direct-MCP provider proof separate from natural Codex installed-host proof |
| A-26 Grok evidence-worker failure | The first rescue envelope was rejected before job creation with `E_CONTEXT_INCOMPLETE` because an excluded plan file was also declared as a project marker. Corrected write job `task-5d96c2fd6cdc0fc38b7d0f7a` ran only in the evidence scope but ended `E_PROTOCOL`: no `GROK_WORKER_REPORT`, all ACs unknown, host verification not run, and partial runtime-observed edits in the evidence library/new schema only. | Exact Grok status/result preserved the terminal failure; no worker claim is accepted as completion | Use the permitted native implementation fallback, inspect/rework the partial diff, run authoritative targeted checks, and retain the failed job as non-qualifying incident evidence |
| A-27 Hosted deterministic CI observability/budget | PR run `29978437612` exposed hidden cross-host failures and a 20-minute cancellation while zero-skip v1 emitted counts only. Commit `98e2596` introduces exact zero-skip v2 summaries with the first eight bounded structured non-pass identities plus omitted count, complete/incomplete environment-secret handling, path/token redaction, no getter execution, fixed ordinal parent diagnostics, 1 MiB child capture, strict parser/aggregate arithmetic, and a 30-minute hosted matrix budget enforced by validation. | Final reporter snapshot: targeted 16/16 on native Node and 16/16 on Node 18.18.2; the immediately preceding full snapshot passed 105/105 on both runtimes with zero fail/cancel/skip/TODO, and the final delta was limited to shared path-shape cases/regex; `npm run validate` passed; fresh read-only review approved. Commit `98e2596` contains the final bytes | Push the exact commit and rerun all hosted Linux/macOS matrix cells. Use the now-named bounded violations to fix any real cross-host defect; do not call CI green from local proof alone |
| A-28 Live-receipt provenance rereview | The first native fallback implementation passed its tests but fresh review rejected exported mint/publish authority, caller-supplied observations, host-verification overclaim, one-way schema rules, missing validator registration/isolation, and unbounded traversal. The final `d5f77da` design removes supported mint/publish/link surfaces, keeps replay at the repository-review trust boundary, forces provisional `hostVerification:not_run`, validates schema/runtime parity, and binds bounded directory identities/depth/counts. | First review: two P0, three P1, and two P2 findings. Final snapshot: 94/94 native plus 94/94 Node 18.18.2 and a second fresh approval; no provider launched and no live-qualified record published | Preserve the no-mint boundary until the fixed runner owns real observations. Any future publication API requires a new independent review and negative proof against caller-authored pass claims |
| A-29 Bounded MCP STDIO client | The initial client passed 42 tests but review proved unbounded pre-spawn initialize retention. Subsequent reviews found per-event stdout Buffer amplification, inbound JSON depth/node amplification, and a premature notification-lifecycle transition. Commit `0cafff7` now admits one synchronous initialize claim, rejects pre-init floods before inspection, uses one fixed 4 MiB zeroized accumulator, preflights inbound JSON depth/tokens before parse, enforces strict initialize/acknowledgement ordering, bounds operations/bytes/timers, preserves correlation and structural errors, and terminates only the exact child. | Final frozen bytes: 56/56 on native Node and 56/56 on Node 18.18.2, syntax/whitespace clean; fresh independent review approved after all four blocker classes were closed. No provider, installed server, or Codex task was run | Integrate this client into the opt-in installed runner. Descendant/provider process cleanup remains runner-owned; the client's exact-child boundary is intentional |
| A-30 Installed-runner source map | Read-only source mapping established the exact installed setup/receipt/tool APIs and the private persisted-state checks needed for lifecycle proof. It also corrected two tempting false proofs: active-provider cancellation receipts keep `processGroupGoneAt`/`terminalRecordCommittedAt` null because they are immutable admission receipts, and `isImportedSessionReady()===false` cannot distinguish successful deletion from list failure. The mapped runner was implemented in `fda21c2` and later hardened through A-34–A-37 | The exact installed runner passed against authenticated source `e1b03af`, including setup/capability, exact ten-tool inventory, completion, ordered mailbox, reconnect/replay, cancellation, cleanup, session deletion, provisional receipt publication, and strict replay | Repeat the same runner on the final frozen source/install identity; the provisional pass does not prove natural-host authority or final qualification |
| A-31 Completion-model/producer audit | Producer v4 now has fixed Phase 0/1 manifests plus a fixed protected Phase 2 manifest/serial runner. Public proof remains limited to Phase 0/1; all four protected producer/verifier functions are private to the direct-main evidence runtime, while protected `prove-phase-2`/`verify-phase-2` require exact ordered current Phase 0 plus signed Phase 1 predecessors and verify the exact current Phase 2 record. Phase 3–5 and aggregate producers remain absent | Exact Phase 2 manifest digest `a88795f9f48d632451eed5d7dfd1b7fe482638fc83386128d3f70490f33dac22`; 18-file runner 292/292; protected publication/replay, hostile direct import, trust, race, public-rejection, scope drift, v4 source-evolution recovery, malformed-v4 rejection, and historical v3 supersession tests pass | Complete the external protected Phase 2 lifecycle, then add fixed Phase 3–5 manifests/runners, aggregate full-scope binding, private aggregate publication, historical non-qualification, and dual-host artifact reconciliation. Prove generic writers cannot mint/link aggregate qualification |
| A-32 Stable spawn response and installed runner | Commit `858ceea` returns the exact transaction-time untrusted admission handle and records a private schema-4 response witness instead of replacing the response with a moving post-dispatch reread. Commit `fda21c2` added exact witness/launch-contract/public-private binding; P2.4 updates the runner to exact-six/exact-ten capability gating and ordered completion/mailbox/replay/cancellation proof. | Installed contract/runner 33/33; P2.4 tool-gating, hostile-input, public/private identity, final-report, cleanup, and fake-provider mailbox tests pass. Exact commit `f17be92` passed validation plus 795/795 deterministic tests with zero failed/cancelled/skipped/TODO after the first replay's eight non-reproducible host-contention failures were isolated and cleared. | Freeze the live-failure remediation, rerun the full gate on its exact commit, then rerun the authenticated installed ten-tool runner. Keep the receipt provisional because later Phase 2–5 source work will supersede it |
| A-33 Grok Build restricted-profile compatibility | Current Grok Build rejects an empty curated toolset. Commit `fda21c2` gives setup-probe and report-repair the sole provider-required `GrokBuild:todo_write` plan-state tool, keeps default tools off and `dontAsk`, forbids invocation in both prompts, reports the effective allowlist honestly, and makes validation require the exact canonical frontmatter. Issue #27 records the upstream guard and acceptance contract. | Real authenticated Grok 0.2.106 `session/new` construction passed for both profiles with ACP v1/loadSession, cached auth, zero prompts, and verified process/guard/profile/credential/temp cleanup. Targeted 94/94 passed on current Node and Node 18.18.2; validation passed on both; fresh review approved. | Repeat setup and any real report-repair path through the exact installed artifact during the live rehearsal. The tool is compatibility-only, not literally inert: it can mutate session TODO state but has no workspace, shell, network, MCP, or orchestration authority |
| A-34 First P2.4 authenticated live attempt | Exact source `f17be92` reached the real installed-provider boundary, completed private installation/setup/capability and spawn admission, then failed before provider promotion. The runner incorrectly required a live provider on the first mailbox-open poll even though `worker-started` plus a registered provider intent and no provider process is a valid transient state; emergency cleanup then overrode and hid the originating stage. This is a qualification-harness defect, not evidence that authentication or the production provider failed. | Live command `GROK_E2E=1 GROK_INSTALLED_WORKER_MCP_E2E=1 GROK_E2E_CANCEL=1 npm run test:installed-worker-mcp` exited nonzero with `E_CLEANUP`; no receipt was minted. Retained body-free state records the spawn witness, controller/worker identities, registered generation-1 provider intent, valid cached OIDC load, no provider/session/mailbox, and no surviving task-owned process. Three independent read-only audits localized the earliest failure to `completion-mailbox-open` with high confidence; the old output cannot prove that original stage because it was discarded. | Commit `d8c0ad3` makes pre-provider `queued`/`running` plus absent/preparing mailbox retryable, requires a fresh strict live-provider/guard observation only after mailbox open, fails terminal-before-open, and emits only allowlisted origin code/stage plus a fixed cleanup outcome when cleanup overrides. Its detached clean-clone gate passed validation plus 796/796 with zero failed/cancelled/skipped/TODO, and the identical authenticated rerun cleared this boundary before exposing A-35 |
| A-35 Second P2.4 authenticated live attempt | Exact source `d8c0ad3` passed setup, provider startup, mailbox opening, two accepted sends, replay without a fourth prompt, and terminal wait, then failed `E_PRIVATE_STATE` at `completion-result`; emergency cleanup was fully proven. `worker_wait` terminal is a status boundary, not a final event-history freeze: the single `worker_result` can legitimately contain later durable cleanup checkpoints. The runner compared the wait history for exact equality before observing that append-only suffix, contradicting its own installed contract. | Exact `d8c0ad3`: validation plus deterministic 796/796, `git show --check`, clean tree. The authenticated command exited nonzero at the bounded original stage `completion-result`; no receipt was minted and no temporary root or task-owned process survived. Contract regression `worker and lifecycle chronology is state-aware and keeps later cleanup checkpoints` documents the valid suffix semantics. Two independent read-only traces identified the same compare-before-observe assumption in both completion and cancellation paths. | The commit containing this checkpoint first proves terminal private state, task-runtime cleanup, process closure, guard absence, credential cleanup, and fixture stability while MCP remains connected; it then performs exactly one `worker_result` read, observes the full result history through the strict ordered observer, and only then requires exact equality. Apply identically to completion and cancellation, retain `resultReadCount:1`, pass the focused gate and fresh review, then rerun the clean exact gate and identical authenticated vertical before P2.5 |
| A-36 Third and fourth P2.4 authenticated live attempts | Exact source `56e37e3` implemented A-35 symmetrically and passed validation plus deterministic 797/797, `git show --check`, and clean-tree proof, but its live rerun still failed `E_PRIVATE_STATE` at `completion-result`. Diagnostic source `c5fe559` then passed the same 797/797 exact gate. Its first live invocation ended earlier with a fully cleaned `provider-setup-command` identity-capture race; one clean retry was allowed because no checkout-owned process or temporary root survived. The retry reached terminal result and failed at the new exact stage `completion-result-history-window`. | The fixed stage proves the returned terminal history was a non-empty exact suffix of the longer strictly observed history; no event content, count, ID, path, digest, or provider data was emitted. No receipt was minted. Production intentionally retains the newest 128 events and existing production coverage permits a snapshot to begin at sequence 13, while the runner and installed validator incorrectly required every terminal snapshot to contain sequence-1 admission. | Keep the full cursor stream and `gap:false` proof from sequence 1. Validate public/private terminal snapshots as exactly `min(128,cursor)` contiguous events ending at the cursor and exactly matching the full stream tail; reject arbitrary shorter/stale tails, gaps, mutations, forged admission, public/private drift, or missing terminal markers. Keep production retention and receipt schema unchanged |
| A-37 Retained terminal-window remediation | Live A-36 evidence invalidated the frozen assumption that a normal three-prompt terminal snapshot stays below 128 events. The source boundary is now explicit two-view validation: after private cleanup freezes the target cursor, `worker_wait` drains the complete stream from exact durable read-only admission through that cursor; the single result cannot add events and its public/installed-private projections must be the exact canonical retained tail. Completion requires one complete structured final report across the full history and no cancellation; cancellation requires one receipt-bound request and no final report; only cleanup checkpoints/blocked events may follow | Regression matrix covers 1–127, 1–128, 2–129, and 13–140 valid windows; rejects truncation, stale prefix, cursor drift, duplicate/gap/reorder, changed overlap, forged retained admission, projection drift, forbidden terminal markers, missing final/cancellation markers, and stream gaps. Exact source `e1b03af` then passed deterministic 798/798 and the installed authenticated vertical | Preserve the remediation and provisional receipt as source-bound evidence. Repeat the identical vertical after the final source freeze |
| A-38 First successful P2.4 authenticated vertical | Exact source `e1b03af` passed installation/setup/capability, exact ten-tool MCP inventory, one real provider session with three ordered prompts and two delivered sends, reconnect/replay without a fourth prompt, terminal result, active cancellation, body/process/session cleanup, exact session presence-delete-absence, receipt publication, and strict replay | Source gate 798/798; receipt path `tests/e2e-results/worker-broker/live-receipts/v2/synthetic-direct-mcp/ef3aba032bb8c713-e29ccee4a2ca0ad6.json`; receipt digest `e29ccee4a2ca0ad646d6b1fd9af7ab1a442e1bb16402d8849c5e15fa3192d8ab`; evidence commit `1fa1cd5` | Treat this as the successful first vertical and provisional evidence only. Later source changes require one final-source rerun; this does not prove natural Codex authority, worker-crash recovery, write workers, or aggregate qualification |
| A-39 Protected Phase 2 producer | Grok job `task-1b380885fc6119298543dd44` failed terminally with `E_PROTOCOL`, so the documented native fallback completed the bounded source slice. Producer v4 fixes Phase 2 to `mailbox-context-roles`, requires exact ordered Phase 0 plus protected signed Phase 1 predecessors with `requireFresh:false`, keeps all live/release boundaries `not_run`, publishes atomically, and verifies the exact current Phase 2 record. Public API/CLI Phase 2 proof returns `E_PROOF_ARGUMENT`; historical v3 Phase 0/1 records remain safely supersedable but untrusted | Exact manifest digest `a88795f9f48d632451eed5d7dfd1b7fe482638fc83386128d3f70490f33dac22`; original exact 18-file runner 292/292; original evidence/protected review 125 passed, 0 failed, with only the explicit external root-owned Docker test skipped; protected trust, public rejection, scope drift, prerequisite, race/rollback, exact replay, and v3 cutover regressions passed | A-40 supersedes the original security-closeout claim. A real protected Phase 2 record still waits for final-roadmap-source Phase 0 and a real protected signed Phase 1 promotion; no qualifying record was minted in this source-changing worktree |
| A-40 P2.5 protected-authority and recovery remediation | Fresh native review found two P1 source gaps: protected producers/verifiers were importable after bootstrap process checks, permitting a patched `spawnSync` to forge gate outcomes; and Phase 0 could not demote a valid current v4 signed Phase 1/Phase 2 chain after ordinary tracked-source evolution. It also found that the external positive Docker path never actually executed protected Phase 2. Commits `c437551` and `d360460` remove all four privileged exports, add a clean root-owned bootstrap → main-only CJS → fresh engine-owned ESM `import.meta.main` boundary, align the protected policy/runtime bundle, add historical-only supersedable validation that tolerates source drift but not producer/shape/digest corruption, and extend the Docker path to prove/verify Phase 2 plus restart replay | Exact source `d360460`: three focused security regressions passed; complete evidence/protected suite 127 passed, 0 failed/cancelled/TODO, one explicit external skip; exact 18-file Phase 2 runner 292/292; validation passed. Regressions cover patched `node:child_process` plus `syncBuiltinESMExports`, inert bootstrap/library imports, no privileged exports, source evolution after current v4 Phase 0 + signed Phase 1 + Phase 2, immutable atomic demotion, and malformed-v4 rejection | Treat the source fix as implemented but not externally qualified until the protected Docker positive lifecycle executes `prove-phase-2`, `verify-phase-2`, restarts, and replays the same record digest, followed by a fresh independent review. Then rerun the exact full repository gate and the same installed authenticated vertical on the final source identity |
| A-41 First extended protected Phase 2 Docker attempt | Exact source `bcc7e69` passed validation and the full deterministic gate 803/803, then the extended Docker vertical passed protected baseline verification, signed Phase 1 promotion, convergence replay, and post-promotion replay before `prove-phase-2` failed closed with `E_PROOF_TOOLCHAIN`. No Phase 2 record was published. The protected fixture image installed Git but omitted Python, even though the fixed proof execution context and declared test inventory require a bound Python executable. This is an incomplete synthetic harness, not a production-contract reason to weaken the toolchain | Failure output was the fixed body-free `{ok:false, code:"E_PROOF_TOOLCHAIN"}` before any Phase 2 gate or publication. The smallest correction adds `python3` to the pinned Debian image alongside Git; the production toolchain resolver, manifest, and failure behavior stay unchanged | Rerun the identical protected vertical immediately. Require actual Phase 2 prove and verify success, exact record-digest equality after container restart, no transient evidence files, all hostile scenarios unchanged, and a fresh independent security review before closing P2.5 external qualification |
| A-42 Second extended protected Phase 2 Docker attempt | Exact source `7799326` admitted the full proof toolchain and reached the real fixed `repository-check`, which failed nonzero before publication. A network-disconnected pinned Node 22 diagnostic container identified the first deterministic failure: the slim image omitted `procps`, so process-start tokens were unavailable, one control-plane integration failed, and process-bound tests produced explicit skips that the zero-skip gate correctly rejected. This is another incomplete synthetic image assumption; production process identity requirements remain unchanged | Before `procps`, `tests/control-plane.test.mjs` reported one failure and 13 explicit process-token skips. After installing only `procps` in the same container and keeping the network disconnected, the identical file passed 32/32 with zero skip/TODO. The protected test fixture now installs Git, Python, and `procps`; no production gate, identity rule, or skip policy is relaxed | Rerun the identical protected vertical on the commit containing this checkpoint. Require the internal repository check and Phase 2 focused check to pass zero-skip, publish one protected Phase 2 record, verify it before and after restart with the same digest, preserve cleanup, pass every hostile scenario, and then obtain a fresh independent security review |
| A-43 Third extended protected Phase 2 Docker attempt | Exact source `e87407f` retained Git, Python, and `procps`, but the real fixed `repository-check` still failed nonzero before Phase 2 publication. A single network-disconnected diagnostic run identified `tests/hooks.test.mjs` as the first failing child: the fixture ran `/bin/sleep infinity` as PID 1, so orphaned process-group members remained as unreaped zombies and the hooks cleanup/recovery assertions timed out. Later failures observed while a second diagnostic ran concurrently are not accepted as evidence. | The exact hooks file failed without an init reaper and passed 26/26 with zero skip/TODO under the same pinned image, packages, source, and network isolation after adding Docker `--init`. `tests/plugin-inventory.test.mjs` also passed 11/11 when rerun alone, confirming its earlier concurrent failure was diagnostic interference. The smallest correction adds only `--init` to protected fixture containers; production process cleanup, identity, gate, and skip policies remain unchanged. | Rerun the identical protected vertical without concurrent tests. Require the internal full repository check and fixed Phase 2 check to pass zero-skip, publish and protected-verify one Phase 2 record, restart the container and replay the exact same digest, preserve transient-file cleanup, pass every hostile scenario, and obtain a fresh independent security review before closing P2.5 external qualification. |
| A-44 Fourth extended protected Phase 2 Docker attempt | Exact source `ff87591` still failed the protected `repository-check` before publication. A clean network-disconnected reproduction using the producer's sanitized environment passed the complete deterministic gate 803/803, proving the toolchain, init reaper, and test corpus were sound. A bounded diagnostic inside the actual generated workspace then exposed the real failure: `scripts/validate.mjs` requires two historical repository fixtures that `copySourceInventory()` intentionally excludes as evidence-only, so the minimal Docker workspace omitted them. | The actual validator reported only the missing `tests/e2e-results/macos-0.2.99-2026-07-13.json` and `tests/e2e-results/worker-broker/phase-1-readonly-dcb78b8.json`. The fixture now copies exactly those two regular, non-symlink validation support files in addition to the source inventory. No proof scope, validator rule, production runtime, evidence authority, or qualification status is weakened. | Rerun the identical protected vertical. Require validation plus internal 803/803 and the fixed Phase 2 gate zero-skip, one protected Phase 2 publication, exact protected verify before and after restart with the same digest, complete cleanup, every hostile scenario, and a fresh independent security review. |

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

### Current execution checkpoint — 2026-07-24

- The first installed/authenticated direct-MCP Phase 1 rehearsal passed the full completion → reconnect/replay → active cancellation → cleanup → exact session-deletion lifecycle on source `b533ff6`; cancellation chronology was then tightened through `0fadd62`. The immutable receipt at `tests/e2e-results/worker-broker/live-receipts/v1/synthetic-direct-mcp/9e109ac49369cb53-2babb2f1362e0b7e.json` is intentionally provisional and became stale as soon as later source work began.
- Q1 is complete and preserved by producer v4: `qualified` remains reserved for one aggregate record, `--require-complete` requires six current `verified_on_draft` numbered phases plus that aggregate, aggregate scope binds the complete non-evidence source inventory, and generic aggregate mint/link/prove paths remain rejected. The original focused gate passed 111/111 and repository validation passed.
- Q2 is committed at `4ce2d85`: immutable review requests, Ed25519 attestations, private immutable import, and atomic Phase 1 promotion are implemented behind a root-owned non-writable bootstrap, fixed trust descriptor/runtime bundle/Git identity, empty hooks directory, scrubbed Git configuration, and exact ledger convergence checks. The evidence suite passed 121/121; the protected Docker gate passed 1/1 with restart replay and 14 hostile scenarios; a fresh native security rereview was P0/P1-clear. These results and the synthetic signer do not constitute final Phase 1 qualification.
- P2.1 is source-complete in the commit containing this checkpoint: the broker builds one canonical ContextPacket; binds immutable role/profile/tool policy, a body-free Context Receipt, exact provider prompt, context manifest, and root lineage; and rechecks the actual launch prompt/profile at process preparation, including generation-2 repair. The stable focused gate passed 138/138 with zero skip/TODO, the previously failing legacy delayed-stdin path passed, all five anti-downgrade/repair/error/cancellation verticals passed, the six resource-contention failures passed on isolated replay, and a fresh native validation reported no P0/P1. These are implementation checks, not a Phase 2 record or live qualification.
- The first exact post-commit repository gate on `f306ddd` passed validation but correctly failed the deterministic gate at 723 passed / 18 failed / 0 skipped / 0 TODO. Raw replay separated three genuine launch-outbox compatibility gaps from a process-harness timeout cascade. Follow-up commit `f1f47f1` binds the canonical packet/policy prompt in the path-alias fixture, models the exact pre-P2.1 request and provider-profile shape, rejects every post-v1 context/profile witness, atomically upgrades an exact legacy profile before v2 authorization, raises only bounded test-process budgets, and prevents an earlier readiness failure from leaving an unobserved child-promise rejection. Focused follow-up proof passed launch outbox 26/26, process-boundary batch 47/47, runtime 59/59, mutation 35/35, and the two anti-downgrade cases 2/2; fresh static native validation is P0/P1-clear.
- The Documents/FileProvider checkout was not an authoritative performance surface: its second full attempt reached 733 passed / 8 failed while wrapper startup and nested `git status` calls stalled for tens of seconds to minutes. A detached `git clone --no-local` materialization of exact commit `f1f47f1` under `/private/tmp` replayed all eight residual cases as 11/11 and then passed `npm run check` completely: validation passed and deterministic tests reported 741 passed / 0 failed / 0 cancelled / 0 skipped / 0 TODO. P2.1 is therefore source-closed as `implemented_unverified`; this local exact-source gate is not a Phase 2 record, installed authenticated proof, or qualification.
- P2.2 is source-complete in the commit containing this checkpoint: only the final valid provider report at the exact finalizing boundary may persist one broker-owned, body-free host-action request; the exact broker-branded root owner may idempotently grant or deny it; grants bind the requested read-only target role/policy and apply only to exact future admission, never to the current worker. The declared focused gate passed 70/70, the host-action slice passed 11/11 after its final privacy guard, and a detached full repository gate passed validation plus 754/754 with zero failed/cancelled/skipped/TODO before the final exact-commit replay. A fresh native validation reported no P0/P1; its low-severity transplanted-public-record observation was also closed and regression-tested. The Grok implementation attempt failed with `E_PROTOCOL: Internal error`, so the bounded slice used the documented native fallback. These are source checks, not a Phase 2 record or live qualification.
- P2.3 is source-complete at exact commit `4bac578`, with qualification pending: `worker_decide_host_action` exposes only the bounded exact-owner decision input/output; `worker_followup` consumes one exact grant and commits a reviewer/security/test child through the normal dispatch-v2 outbox with immediate-parent resume, root lineage/provider-home identity, exact same-session load, child-bound final context, capability revalidation, transitive retention, and fail-closed replay/recovery. The final focused gate passed 204/204 and the fake-provider MCP vertical passed 1/1 with one session creation, one exact session load, two prompts, and no replayed third prompt; the detached exact-source repository replay passed 771/771 with zero failed/cancelled/skipped/TODO plus `git show --check`. The Grok implementation job failed terminally with `E_PROTOCOL`, so the documented native fallback completed the bounded slice. These results are not installed authenticated proof.
- P2.4 is source-complete and its first installed authenticated vertical passed on exact source `e1b03af`: the attempt-bound ordered ACP pump provides body-free inflight state, exact acknowledgement settlement, explicit non-retried `delivery_unknown`, atomic send/close behavior, private/public identity binding, last-turn report binding, and the exact three-capability/ten-tool surface. After the A-34–A-37 reality-driven harness corrections, the exact deterministic gate passed 798/798 and the identical live run completed installation, real provider/session, three ordered prompts, two sends, reconnect/replay without a fourth prompt, terminal result, cancellation, cleanup, session deletion, provisional receipt publication, and strict replay. Receipt digest `e29ccee4a2ca0ad646d6b1fd9af7ab1a442e1bb16402d8849c5e15fa3192d8ab` is preserved in evidence commit `1fa1cd5`.
- A-35–A-37 are closed for the first vertical. Private terminal cleanup precedes the single public result read; the strict observer admits only an exact append-only cleanup suffix; and the complete cursor stream independently proves the canonical max-128 public/private retained tail. Completion and cancellation use the same convergence rule. The resulting receipt is intentionally provisional because P2.5 and later source changes require the vertical to be repeated on the final frozen identity.
- P2.5 source is complete through the A-40 remediation: producer v4 adds the fixed protected zero-skip Phase 2 manifest/runner, exact ordered Phase 0 plus protected signed Phase 1 predecessor binding, signed trust across capture/publication/replay, atomic rollback-safe publication, exact-record protected verification, public Phase 2 rejection, historical v3 supersession compatibility, source-evolution recovery for a valid current v4 chain, and a private fresh-process authority boundary. Exact source `d360460` passed the 18-file runner 292/292 and evidence/protected review 127/127 with the single explicit external Docker test skipped. External Docker Phase 2 execution, final-source prerequisite records, and later-roadmap qualification remain pending.
- Final exact-source qualification remains `0%`: there is no final current six-phase chain, matched final live receipts, paired corpus, protected signed Phase 1 promotion, or qualified aggregate.

### Dependency-ordered source completion map

The early read-only rehearsal intentionally precedes this source work so live defects are discovered before the larger implementation. After that rehearsal, complete these slices in order. “Done” below always means production wiring plus the named negative checks on one committed source; it does not mean phase qualification. Final records and live receipts are published only after the last source-changing slice is frozen.

| Slice | Expected deliverable | How the main agent proves the slice is done |
| --- | --- | --- |
| Q1 | Aggregate-only qualification semantics: Phase 0–5 accept `verified_on_draft`; only the aggregate accepts `qualified`; `--require-complete` requires six current phase records plus one current aggregate | Constructed complete-chain acceptance; per-phase `qualified`, stale/incomplete aggregate, generic mint/link, and prerequisite-drift rejection |
| Q2 | **Source-complete, qualification pending:** code-owned immutable review request plus protected Ed25519 attestation import and exact-source Phase 1 promotion. The runtime binds root ownership/non-writability, fixed bundle/Git/policy/trust identity, scrubbed executable Git behavior, immutable attestation publication, exact convergence, and commit-ambiguity recovery | Evidence 121/121; external protected Docker 1/1 with immutable image/container identity, restart replay, complete evidence-tree oracle, and 14 hostile scenarios; validator/diff checks pass; independent rereview is P0/P1-clear. After commit, this remains `implemented_unverified`; real issuer attestation and durable final records wait for final source freeze |
| P2.1 | **Source-complete, qualification pending:** broker-built ContextPacket, immutable role/profile/tool policy, and body-free Context Receipt bound to the exact provider prompt, canonical root lineage, manifest, and launch preparation; exact pre-P2.1 dispatch/profile migration upgrades atomically and rejects mixed-era witnesses | Exact `f1f47f1` materialization passed `npm run check`: 741/741, zero failed/cancelled/skipped/TODO. Supporting gates: stable 138/138 focused; launch-outbox 26/26; process-boundary 47/47; runtime 59/59; mutation 35/35; delayed-stdin legacy compatibility; deleted-binding anti-downgrade before execution and after authorization; generation-2 repair/error/cancellation; 22-case hostile context matrix; schema/runtime parity; clean diff; fresh native P0/P1-clear validation |
| P2.2 | **Source-complete, qualification pending:** immutable runtime role/profile/tool binding plus a final-report-only durable host-action request and exact broker-owner future-role grant/deny decision; the current worker is never rebound | Declared focused gate 70/70; host-action slice 11/11; detached moving-tree full gate 754/754 with zero failed/cancelled/skipped/TODO; exact owner-brand, replay, sidecar-loss/tamper, cross-worker, process/session/resume/context/role/policy drift, read-only target policy, write-source, privacy, and deny tests; clean diff; fresh native P0/P1-clear validation. Final exact-commit replay remains the closing check |
| P2.3 | **Source-complete, qualification pending:** public exact-owner decision plus grant-bound reviewer/security/test follow-up enters the normal dispatch-v2 outbox, resumes exactly one parent provider session, preserves immediate-parent/root lineage, and freezes child-bound final context | Frozen-tree production batch 204/204; P1 regressions 50/50; fake-provider MCP vertical 1/1 proving one `session/new`, one exact `session/load`, two same-session prompts, and no replayed third prompt; capability/authority/context/profile/session/dispatch/retention/recovery/privacy negatives; validation/diff checks pass; fresh native P0/P1-clear review; exact commit `4bac578` clean-clone `npm run check` passed 771/771. Installed authenticated post-terminal/reconnected replay remains required |
| P2.4 | **Source-complete; first vertical passed, final-source qualification pending:** ordered turn-boundary ACP mailbox pump with attempt-bound atomic open/close state, reserve-then-dispatch RPC correlation, body-free communication-chain binding, acknowledgement-bound `delivered`, non-retried `delivery_unknown`, cancellation-safe primary admission/consumption, and exact live-receipt v2 bindings | Exact source `e1b03af` passed deterministic 798/798 and the installed authenticated completion/mailbox/reconnect/replay/cancellation/cleanup/session-deletion lifecycle. Provisional receipt digest `e29ccee4a2ca0ad646d6b1fd9af7ab1a442e1bb16402d8849c5e15fa3192d8ab` is committed in `1fa1cd5`. Repeat the same vertical after final source freeze |
| P2.5 | **Source-complete through security remediation; external gate and record pending:** producer v4 fixed zero-skip protected Phase 2 producer and exact ordered current Phase 0 plus protected signed Phase 1 predecessor binding; public Phase 2 proof remains rejected; protected operations have no public library exports and execute only through fresh direct-main boundaries; Phase 0 can safely recover after source evolution without accepting malformed history | Exact manifest digest `a88795f9f48d632451eed5d7dfd1b7fe482638fc83386128d3f70490f33dac22`; exact source `d360460` Phase 2 runner 292/292; evidence/protected review 127 pass, 0 fail/cancel/TODO, one explicit external Docker skip; hostile-import, static-import/scope drift, skip/TODO, unsigned/missing/wrong-order predecessor, protected trust, public API/CLI rejection, atomic race/rollback, exact strict replay, v4 source-evolution recovery, malformed-v4 rejection, and historical v3 supersession regressions. The extended Docker lifecycle and final protected predecessor chain remain |
| P3.1 | Durable ExecutionBinding plus crash-safe exact detached-worktree provisioning; provider executes only in the bound execution root | Before/after-provision crash recovery, orphan cleanup, symlink/base/control-root mismatch, dirty parent, and zero parent-mutation tests |
| P3.2 | Managed-root writer leases replace global writer exclusivity | Two distinct-root writers succeed; same-root/lineage conflict, read concurrency, restart, and stale-lease reclamation are deterministic |
| P3.3 | Immutable terminal artifact manifest and retrievable patch payload bound to job/base/scope | Content/path/binary/mode/symlink tamper, wrong base, scope violation, restart, and retention tests |
| P3.4 | Explicit host-owned preview/integrate/verify/retain/abandon/cleanup lifecycle; never auto-apply | Conflict, base drift, malicious patch, crash-during-apply rollback, foreign owner, duplicate request, and unsafe-cleanup rejection |
| P3.5 | Fixed zero-skip Phase 3 producer | Full execution-binding/lease/artifact/integration scope closure, predecessor binding, skip/TODO, and strict replay tests |
| P4.1 | Native-shaped MCP facade with persistent task-owned aliases/tree and `wait_any`/`wait_all` for 1–20 workers | Alias parity/collision/restart/cycle, foreign opacity, wait ordering/timing/cursor-gap/auth, and privacy tests |
| P4.2 | One broker-owned host-verification implementation shared by CLI and MCP | CLI/MCP parity, one-time replay, owner/scope/context mismatch, provider-forged success, and restart tests |
| P4.3 | Durable exactly-one completion-consumption outcome across wait/result/optional notification | Channel-race, timeout/non-consumption, foreign read, restart, retention-gap, and replay tests without unsupported wake claims |
| P4.4 | MCP-first Codex skills plus code-owned natural Codex and Claude installed runners/receipts | Skill bypass snapshots, exact source/install/tool identity, no caller `_meta`, session presence-delete-absence, and receipt replay rejection; live host runs remain external gates |
| P4.5 | Fixed zero-skip Phase 4 producer | Broker/presentation/adapters/skills/runners scope closure, predecessor binding, skip/TODO, and strict replay tests |
| P5.1 | Requested versus ACP-observed protocol/model/effort/provider/host identity; unobserved values stay null | Missing/mismatched negotiation, rotation, replay, and exact real-provider observation tests |
| P5.2 | Paired native/Grok corpus and deterministic measurement harness with at least five samples per required adapter/scenario | Corpus schema, equivalent cases, deterministic sampling, redaction, failure classification, p50/p95/max, and missing-observation rejection |
| P5.3 | Fixed zero-skip Phase 5 producer | Safety/corpus/harness scope closure, predecessor binding, skip/TODO, and strict replay tests |
| A1 | Private aggregate producer derives the canonical dual-host qualification artifact from exact phase digests, signed review, matched live receipts, corpus, CI, and release evidence | Missing/mismatched/replayed/stale inputs, forged CI, absent Claude, generic mint/link, concurrent publication, rollback, strict replay, and `--require-complete` |

The main agent owns trust material, publication authority, integration decisions, final live execution, and GitHub closeout. Grok writers may receive bounded implementation/test files but never `tests/e2e-results/worker-broker/**`, signing keys, trust configuration, aggregate publication authority, or issue-close authority.

1. [Complete] Integrate all concurrent Phase 0/1 implementation and remediation edits without overlapping or discarding unrelated work; both writers are stopped and their integrated surfaces have been inspected.
2. [Done at the remediation/review layer] All accepted runtime/evidence findings have source fixes. Fresh integrated, runtime, and parser/evidence rereviews report no remaining actionable findings; their reports are review input, not qualifying evidence.
3. [Superseded exact snapshot] Source commit `b30fefd` passed the authoritative fixed Phase 1 gate 324/324 and full repository gate 543/543 with zero failed/cancelled/skipped/TODO. The later proof-cleanup remediation changed the source identity, so those results remain incident evidence only.
4. [Superseded exact cleanup snapshot] Commit `31244be` passed fixed Phase 1 324/324 and full repository 550/550 with zero failed/cancelled/skipped/TODO. Two subsequent Phase 0 producer runs failed before publication at `repository-check` with the same digest because the sanitized environment reached an unusable `/usr/bin/python3`; the exact raw gate showed 548 passed and 2 skipped. No record or ledger was published.
5. [Complete at the Python source-freeze/remediation layer] The producer now binds a reviewed native Python by canonical absolute identity, rejects shims, uses identical isolated flags, excludes Python from `PATH`, scrubs the selector, and fails closed without publication. Before this outcome was recorded in the plan, the freeze passed evidence 78/78, PTY 4/4, hooks 26/26, Windows-neutral 5/5, fixed Phase 1 324/324, full repository 552/552, and eight selected assertions on both Node 18.18.2 and 20.19.4; fresh native review found no blocker.
6. [Complete for superseded source `2b39e13`] Exact Phase 1 passed 324/324 and full repository passed 552/552; producer v2 published Phase 0 `verified_on_draft` digest `f7c9779e…` and Phase 1 `implemented_unverified` digest `53bb71c6…`; evidence-only commit `426b999` preserved strict Phase 0/1/all-ledger replay while expected readiness gates remained red.
7. [Timeout remediation committed; exact focused replay passed] Commit `64a095c` gives the updater's serial full gate a bounded 20-minute budget. Exact Phase 1 replay passed 324/324; full replay/producers are deliberately delayed until the source-changing live-receipt and runner work below is frozen.
8. [Contract and fixed runner complete; live execution pending] Commits `d5f77da` and `fda21c2` close the generic-authority/offline contract and add the code-owned observation/publisher runner. Keep receipts provisional and `hostVerification:not_run`; no pass receipt exists until the committed runner completes every observation and cleanup check.
9. [Client, stable witness, and installed runner complete; authenticated proof pending] Commits `0cafff7`, `858ceea`, and `fda21c2` supply the bounded strict MCP STDIO client, exact transaction-time spawn witness, and the opt-in installed runner for exact bytes, completion, MCP reconnect without duplicate launch, idempotent cancellation, repository immutability, session deletion, and runner-owned cleanup. P2.3 updates the installed contract from its original seven tools to atomic exact-six/exact-nine capability gating. The next action after source completion is the final authenticated live execution, not more runner design.
10. [Local observability complete; hosted replay pending] Commit `98e2596` supplies bounded zero-skip v2 identities and a 30-minute matrix budget. Push it, rerun the supported hosted matrix, and remediate any newly named cross-host failure before calling CI green.
11. [Complete as a provisional rehearsal] The direct installed/authenticated vertical passed at `b533ff6`, including completion, reconnect/replay, active cancellation, cleanup, and exact session deletion; chronology hardening continued through `0fadd62`. Its immutable receipt is retained as stale rehearsal evidence and cannot qualify later source.
12. [In progress: Q1, Q2, and P2.1–P2.5 source boundaries complete; first P2.4 installed authenticated vertical passed] Complete the remaining source-changing prerequisites: Phase 3–5 runtime/features and deterministic producers, private aggregate producer/publication boundary, aggregate full-scope, and canonical dual-host artifact binding. Q2's synthetic protected Docker gate and native review do not replace a real final-source issuer attestation. The `e1b03af` provisional v2 receipt proves the first direct-MCP vertical but is superseded by later source changes. Generic writers must remain unable to mint or link qualification. Generate no final phase record or aggregate receipt while these source surfaces are still moving.
13. Freeze the final source exactly once after step 12, replay fixed Phase 1 plus the full repository gate, and refresh the exact plugin cache through byte-identical inventory verification. Do not publish final phase or aggregate records before the live and corpus observations below exist.
14. Repeat the full eight-step installed/authenticated direct-MCP completion and reconnect/cancel scenarios on the final source/install identity. For every scenario session, require successful presence → delete → absence proof before its receipt is published. Do not describe MCP-server restart as worker-crash recovery.
15. Run a separate fresh natural-Codex task on that same final source/install/capability identity without caller-supplied `_meta`, and require successful presence → delete → absence proof for its session before receipt publication. The natural receipt proves host authority; only the matched synthetic-provider plus natural-Codex receipt pair may satisfy installed-host qualification.
16. Execute the paired Phase 5 corpus and bounded measurements against the frozen final identity; if the corpus changes source, return to step 12 and invalidate all later records/receipts before refreezing.
17. Only after steps 14–16 succeed, build deterministic final Phase 0–5 `verified_on_draft` records in dependency order with exact predecessor digests and mandatory gate IDs; those phase records must not absorb standalone live receipts. Then invoke the separate private aggregate producer to bind the exact phase digests, signed review, matched live receipts, corpus, CI, release evidence, and canonical dual-host qualification artifact into the only `qualified` record; strict-replay the complete chain.
18. Require both ledger integrity (`npm run worker:verify -- --all --strict`) and release readiness (`npm run worker:verify -- --all --strict --require-complete`) to pass with no skipped mandatory boundary.
19. Obtain fresh independent native validation of the exact final commit and its records/receipts; optional Grok review is additive only.
20. Update issue #25 and PR #26 with exact commit, record/receipt digests and paths, replay commands, outcomes, and remaining unsupported cells.
21. Close issue #25 only if the aggregate exit definition is satisfied; otherwise leave it open with the next concrete gate.

This sequence leaves enough durable evidence for a fresh session to determine what exists, what passed, what remains unqualified, which identity was tested, and exactly how to replay every readiness claim.
