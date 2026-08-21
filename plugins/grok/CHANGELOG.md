# Changelog

## 0.3.0-dev.16

Status: hardening candidate; not release-qualified.

- `worker_spawn` over MCP returns at durable admission (`providerLaunchState`)
  without waiting for provider/controller start. Supervisor and `worker_wait`
  still launch pending dispatches. Git capture uses a bounded
  `extensions.worktreeConfig=false` subprocess.
- Spawn idempotency binds `name`, `parentId`, `contextMode`, `inheritTurns`,
  and `contextDigest`. Advertised spawn schema matches runtime name/digest
  rules. Host transcript modes `none`/`all`/`recent` materialize and
  digest-verify selected Codex turns into provider facts; public events expose
  only mode/digest.
- Interrupted workers project public `status:"interrupted"`. `worker_followup`
  without `grantId` resumes a preserved session without replaying the original
  prompt; same idempotency key replays. Impossible preservation still uses
  `fallback:"cancel"`.
- When the client advertises `grok/worker-change-notifications`, the MCP
  server emits bounded `notifications/grok/worker_changed` events. `worker_wait`
  remains the recovery fallback.

## 0.3.0-dev.15

Status: hardening candidate; not release-qualified.

- `worker_spawn` can select isolated, full, or recent-turn context by digest,
  name the worker, and attach a parent id. Explicit model/effort fail closed
  until the installed receipt advertises them. Default explorer spawn is
  unchanged.

## 0.3.0-dev.14

Status: hardening candidate; not release-qualified.

- `worker_cancel` accepts `mode=interrupt` to stop the current provider
  attempt without terminal cancellation when the provider session can be
  preserved. Missing session preservation falls back to cancel. Cancel
  without a mode stays terminal.

## 0.3.0-dev.13

Status: hardening candidate; not release-qualified.

- `worker_wait` can wait for any of 2–16 owned workers via `ids` without a
  new tool name or provider launch. Timeout is an empty no-change result.
  Single-worker `id` wait stays compatible.

## 0.3.0-dev.12

Status: hardening candidate; not release-qualified.

- A second failed adversarial-review repair still fail-closes with `E_SCHEMA`
  and no pass verdict. Public error details now keep the validation reason
  and any sanitized findings so `status`/`result` are not a dead-end.

## 0.3.0-dev.11

Status: hardening candidate; not release-qualified.

- Deep-research isolation now ignores the real user home and host extension
  roots, and contamination failures name the loaded capability class without
  private paths.

## 0.3.0-dev.10

Status: hardening candidate; not release-qualified.

- Public job summaries no longer stop mid-path. When the 160-character budget
  is exceeded, the host keeps the last complete sentence or identifier
  boundary and appends an ellipsis. If nothing complete fits, the public
  summary is only the ellipsis. The durable worker-report summary is
  unchanged.

## 0.3.0-dev.9

Status: hardening candidate; not release-qualified.

- Advertised MCP `worker_spawn` returns an actionable stale-receipt or
  invalid-receipt error instead of generic `E_CAPABILITY` when the frozen
  broker snapshot no longer matches the live setup receipt.

## 0.3.0-dev.8

Status: hardening candidate; not release-qualified.

- `record-verification` publishes the terminal runtime's observed changed
  paths. An empty completion→verification window no longer looks like the host
  verified no write-job changes.

## 0.3.0-dev.7

Status: hardening candidate; not release-qualified.

- Ordinary `review-v1` no longer publishes `Verdict: pass` from a
  plan/progress-only summary such as `I will inspect…`. Zero-finding pass
  requires a completed rationale that names the observed changed paths.
  One same-session repair is allowed; a second provisional payload fails
  closed with `E_SCHEMA`.

## 0.3.0-dev.6

Status: hardening candidate; not release-qualified.

- Persist no longer crashes when `buildWorkerReport` leaves `outcome: complete`
  but host success is false (unmet acceptance or claimed/observed file
  mismatch). The job publishes `partial` with `providerClaims.success: false`
  and a `classificationReason` instead of `Assignment to constant variable`.

## 0.3.0-dev.5

Status: hardening candidate; not release-qualified.

- Working-tree review now records the dirty target paths in runtime evidence
  instead of the empty read-only mutation set. A dirty repository that binds
  zero changed paths fails closed with `E_REVIEW_TARGET` and cannot emit
  `Verdict: pass`.

## 0.3.0-dev.4

Status: hardening candidate; not release-qualified.

- A structured task report that claims `outcome: complete` while any required
  acceptance criterion is `unknown` is reclassified as `partial` with an
  explicit `classificationReason`. `providerClaims.success: false` cannot
  coexist with a published complete outcome. Host command verification stays
  separate from that semantic classification.

## 0.3.0-dev.3

Status: hardening candidate; not release-qualified.

- Fixed the `--envelope-stdin --stdin-ready` handshake so a TaskEnvelope
  without `userRequest` reports a field-level `E_USAGE` instead of claiming
  `--envelope-stdin` was absent after readiness was emitted. Empty stdin and
  invalid JSON stay distinct controlled errors. A delayed write envelope after
  `GROK_COMPANION_STDIN_READY` still creates exactly one durable job.

## 0.3.0-dev.1

Status: hardening candidate; not release-qualified.

- Fixed linked-worktree task admission so inherited Git location overrides
  (`GIT_COMMON_DIR=.git`, `GIT_DIR`, index/object overrides) cannot make a
  valid checkout look like incomplete `config` and `refs`. Companion Git
  discovery now uses the caller's worktree cwd only. `--path-format=absolute`
  is preferred, but Git < 2.31 falls back to plain `rev-parse --git-dir` /
  `--git-common-dir` so linked worktrees are not misclassified as primary.
  Absent optional `config.worktree` remains a complete empty scope; present
  unreadable, malformed, include-failed, or oversized worktree config still
  fails closed. Shared and worktree-private ref inventories stay fail-closed
  when they disagree or cannot be observed.
- Fixed managed-observed setup for Grok Build 1.0.0, whose exact private
  child process may omit the display-only `[stable]` suffix from `--version`.
  Setup now requires one whole unambiguous `grok VERSION (BUILD)` record,
  rejects an explicit non-stable suffix, and reports a missing build identity
  separately. Missing display text retains the existing managed-observed
  stable admission only after the managed layout, installer, ownership,
  stable-filename, exact-byte copy, and source-stability checks; it does not
  claim remote release membership or the user's configured updater channel.
  The private observation also preserves a custom `GROK_HOME`. A real installed
  setup exposed unrelated top-level Grok-home bookkeeping churn as a false
  source-drift signal. Setup now ignores only that root-directory mtime while
  retaining its canonical inode/ownership/mode identity, managed bin/target
  directory identities, link/config checks, and the second source snapshot;
  it additionally requires the captured file identity to equal the first
  validated target identity so transient target substitution still fails
  closed. No updater/network lookup was added; immutable pinning, launch
  re-attestation, receipt invalidation, and capability probing are unchanged.
  Donor and live-reproduction evidence is recorded in
  `docs/issues/90-stable-version-output-donor-evidence.md`.
- Fixed adversarial review so plan/progress-only zero-finding provider payloads
  cannot become terminal `pass`. Adversarial jobs wrap the shared structural
  `validateReview` with a specialization-only semantic completion gate: empty
  findings require the bounded `No material findings: Challenged: ...
  Assessment: ... Decision: ship.` completion grammar, and bounded plan/progress
  leading forms in either segment are rejected as `E_SCHEMA` without echoing
  provider payload.
  Exactly one same-session repair still uses existing `runStructuredReview`
  behavior; a second semantic failure never publishes pass. Ordinary review,
  schema, transport, structured/stop review, profiles, and cleanup are unchanged.
  Donor evidence records exact pins and rejected machinery under
  `docs/issues/4-adversarial-review-donor-evidence.md`.
- Fixed managed Codex setup so the installed `$grok:setup` skill requests
  approval before its one exact process. The approved action is explicitly a
  one-time, command-scoped unsandboxed setup execution because the host tool
  does not expose a literal exact-path writable grant. It creates no reusable
  `prefix_rule`, disables login/interactive shell semantics and PTY framing,
  makes no sandboxed probe or retry, and never extends approval to status, tasks, reviews,
  providers, retries, or verification. Denial or an unavailable approval
  starts no setup/provider process. The rescue skill may use the same bounded
  action only for the exact missing capability-receipt prerequisite; its
  identical task retry remains un-escalated and `E_STORAGE_READONLY` stays
  terminal. Runtime guidance distinguishes the managed host boundary from
  genuine storage media/mode failures. This does not widen provider
  permissions or claim path-scoped authority.
- Fixed Claude Code plugin installation so the conventional shared
  `hooks/hooks.json` (`SessionStart`, `Stop`) is no longer listed in the Claude
  manifest. Claude Code 2.1.220 already auto-loads that path once; explicit
  registration duplicated the load and failed with an already-loaded file
  error. The manifest now registers only the Claude-only supplemental
  `./hooks/claude-hooks.json` (`SessionEnd`). Standard and Claude-only hook
  file contents are unchanged. Packaging validation and the Codex-support
  regression enforce the supplemental-only contract. This is a packaging
  declaration fix only; it is not installed Claude lifecycle qualification.
- Fixed the installed Codex and Claude deep-research instructions so they
  select exactly one execution mode and exactly one research surface before
  starting a job. Public-web requests still default to `--background` plus
  `--web-only`; explicit foreground or workspace requests replace those
  defaults with `--wait` or `--workspace` instead of combining mutually
  exclusive flags. The runtime's fail-closed argument validation, private
  query ingress, profiles, provider lifecycle, and qualification status are
  unchanged.
- Replaced the stale exact-version setup ceiling with forward admission for
  stable Grok Build 0.2.99 and newer. Recorded release digests remain the
  stronger `known-digest` path; unfamiliar versions are accepted only from the
  active Grok-managed `cli.installer` layout, captured without executing the
  discovery path, copied and rehashed into the private immutable pin, then
  probed from that exact copy. Managed releases use backward-compatible
  executable-attestation schema v2 and report `managed-observed`; this records
  exact bytes and source provenance without fabricating npm integrity or Git
  provenance and does not prove that xAI issued the initial bytes. Arbitrary
  unfamiliar `GROK_BIN`/`PATH` executables fail with `E_GROK_SOURCE`; malformed
  or below-floor versions use `E_GROK_VERSION`; known digest mismatches and
  capture drift use `E_PROCESS_IDENTITY`. Schema-v1 pins, launch binding schema
  1, capability receipt schema 2, historical pins, receipt expiry, and the
  single setup retry contract remain unchanged.
- Added first-class Grok `/deep-research` dispatch as a dedicated companion
  surface (`$grok:deep-research` / `/grok:deep-research`), not an arbitrary
  plugin runner. Jobs use kind `deep-research`, schema v3, and dedicated
  `deep-research-v1` / `deep-research-workspace-v1` ACP profiles with
  public-web defaults (`--background`, `--web-only`), optional read-only
  tracked workspace snapshots (read tools only in workspace mode), private
  32 KiB query stdin staged in a digest-bound one-use private file (never the
  job registry), detached background workers, session-scoped capability
  gating, exact `/deep-research <query>` launch text, workflow-run binding
  with monotonic revisions, exact `/workflow stop <run-id>` cancellation,
  cwd/session/run-bound 512 KiB report collection, provider-byte-bound
  capability receipts, and stable
  pause/incomplete/security/timeout errors without automatic resume or replay.
  WebFetch is denied pending independent proof of `allow_local=false`, and
  reports record the resulting reduced coverage.
  Rescue profiles and Worker Broker spawn contracts are unchanged. The local
  stable Grok 0.2.112 build used for development did not advertise the
  workflow commands in an isolated ACP session, so real completion,
  cancellation, and crash/restart remain unqualified on that build.
- Fixed incomplete Git-context observation being misreported as workspace
  drift after task acceptance. New ContextManifest v2 captures authenticate
  bounded completeness for non-ref metadata, operational state, hooks, config,
  index flags, refs, and configured upstream, cross-bound to the existing
  shared-ref identity. Initial incompleteness now fails before durable direct
  or broker acceptance; execute, resume, replay, managed-write, and terminal
  checks return `E_CONTEXT_INCOMPLETE` with only the bounded phase and component
  names. Comparable identity changes, malformed stored authority, and concrete
  scope violations retain drift/scope precedence. Genuine v1 and complete old
  v2 records remain compatible; incomplete old v2 records use the generic
  `gitMetadata` component. Runtime evidence keeps issue #34's
  `sharedRefObservation` unchanged and adds a separate completeness observation;
  durable public incomplete errors selectively use error schema v2.
- Fixed linked-worktree ContextManifest Git-metadata comparison so provably
  unrelated shared-ref churn (other local branches, unrelated remote-tracking
  refs, and `refs/codex/turn-diffs/**`) no longer surfaces as out-of-scope
  `[GIT_METADATA]` when every task-relevant identity is unchanged. Comparison
  uses semantic ref name→OID/symref identity (loose↔packed equivalent) and
  keeps current branch, configured upstream, `refs/replace/**`, unclassified
  special refs, worktree-local Git controls, shared config/hooks/info,
  shallow/grafts/alternates, and index/`trackedTreeIdentity` fail-closed.
  Legacy manifests stay on full `metadataIdentity`; mixed, malformed, or
  incomplete new identity support cannot downgrade to tolerant behavior.
  Runtime/public evidence exposes a bounded `sharedRefObservation`
  classification that distinguishes tolerated unrelated shared-ref churn from
  task-relevant metadata drift without local paths or private runtime IDs.
- Fixed `record-verification` scope reconciliation so host-created pytest and
  Python cache drift is excluded only for exact `.pytest_cache` and
  `__pycache__` path components. The runtime still stores the full exact
  manifest for continuation and keeps full ignored identity for completion and
  normal resume; malformed or legacy verification identities and meaningful
  ignored drift fail closed.
- Documented and enforced the complete bounded `commandOutcomes` stdin
  contract: one root field, 1 through 64 unique exact declared commands,
  passed/failed status, integer exit code, complete passed/0 coverage for a
  passing record, partial failure support, and no command-output fields.
- Fixed the Codex `runtime_ingress` crash that raised raw `EAGAIN` when unified
  execution created a nonblocking PTY before `write_stdin` supplied the
  TaskEnvelope. Task and verification stdin now use a bounded asynchronous
  stream reader with stable read/timeout errors. PTY input now switches to raw
  no-echo mode, advertises an explicit reader-ready marker, and consumes a
  bounded EOT-terminated private frame instead of synchronously reading fd 0.
- Added deterministic nonblocking, delayed-input regressions for TaskEnvelope
  dispatch and verification records, including the exact issue #2 invocation
  without a reader-ready flag after a one-second host delay. Empty, malformed,
  and over-256-KiB envelopes remain stable `E_USAGE` failures. A clean-
  `CODEX_HOME` marketplace install gate executes the cached plugin snapshot,
  proves exactly one fake-provider launch, and runs the setup probe from the
  installed artifact. This qualifies the reproduced `runtime_ingress` and
  `artifact_install` boundaries; it does not qualify authenticated provider
  behavior or replace installed-Codex natural `host_orchestration` evidence.
- Fixed a second installed-host failure exposed after ingress succeeded: Grok's
  strict sandbox rejected `--agent-profile` paths inside the Codex plugin
  cache. The runtime now verifies the packaged profile digest, copies it to a
  unique mode-`0600` regular file beneath the isolated `GROK_HOME`, passes only
  that path to Grok, and removes it after verified process-group exit. Startup
  cleanup retains the home, profile, and guard when shutdown cannot be proven.
- Fixed a third installed real-provider failure exposed only after a repaired
  worker report completed: the recursive redactor treated shared acyclic arrays
  as cycles, persisted `validationIssues` as a string sentinel, and made
  `result` throw. Redaction now distinguishes ancestry cycles from shared
  values, old malformed records render defensively, and the natural gate
  requires the installed result renderer to succeed.
- Reproduced issue #5 against the installed snapshot with three simultaneous
  structured read jobs and Grok Build 0.2.101. Independent lineages now retain
  unique staged profiles, all three jobs may overlap, and verified terminal
  cleanup removes their transient profiles. The offline suite repeats the
  three-job admission/provider lifecycle and requires bounded, redacted ACP
  stderr on `E_PROVIDER_EXIT` instead of an opaque exit code alone.
- Added boundary-scoped evidence taxonomy for `runtime_ingress`,
  `host_orchestration`, `artifact_install`, `provider_transport`,
  `worker_execution`, and `host_verification`. Evidence may no longer be
  promoted across boundaries; pre-provider ingress failures are plugin failures
  and release-blocking.
- Added a repository-owned `codex:update-local` workflow that checks the full
  repository, requires the clean installed-Codex regression, refreshes the
  configured local marketplace cache, compares path/mode/size/SHA-256 identity,
  and requires qualification from a newly started Codex task.
- Added an opt-in protected CI gate that starts a new natural Codex task against
  the installed snapshot and real Grok provider, then validates the persisted
  job, host-owned Git check, read-only worktree, and transient artifact cleanup.
- Serialized all continuations that share one provider lineage, including
  terminal jobs whose transient cleanup is pending. Cleanup now holds the same
  admission lock, defers while another continuation owns the lineage, retries
  cleanup-blocked verified process termination, and retains task/review homes,
  profiles, guards, and the intended terminal outcome until cleanup succeeds.
- Publish authenticated cancellation markers through a mode-`0600`, fsynced
  temporary file and atomic rename. This closes the launch-window race exposed
  by Ubuntu Node 18 CI, where SessionEnd or a worker could observe an existing
  but still-empty nonce file between destination creation and the write.
- Added a fail-closed RC/stable promotion gate. Evidence binds a deterministic
  source inventory without self-referencing its own record and must contain
  separate installed, authenticated boundary results for both advertised hosts;
  a single Codex run can no longer qualify the dual-host package.

## 0.3.0-dev.0

Status: hardening candidate; not release-qualified.

- **Bounded transfer fix:** imported Claude/Codex sessions are immediately
  resumable like native sessions. Transfer discovers the resume model from the
  same non-isolated Grok CLI home used by import/resume (not the isolated
  setup-probe ACP view), returns a model-qualified
  `grok --model <id> [--reasoning-effort <effort>] --resume <session-id>`
  command (legacy placeholder models otherwise resume empty), and fails closed
  until the exact session is observable in the non-isolated store, with bounded
  polling for import persistence races. Claude and filtered Codex inputs are
  frozen into anonymous point-in-time descriptors, so concurrent host appends
  cannot enter the import; transcript bodies and source paths stay out of argv,
  state, and logs.
- Current branch is an **unqualified hardening candidate**, not a release-ready
  build. Historical macOS July 13, 2026 evidence does not qualify this worktree.
  The current direct-runtime authenticated flow passed on July 14, with
  cancellation exercised separately, but authenticated installed-Codex
  natural-flow E2E for this slice has not yet been rerun or recorded.
- Control-plane rescue: TaskEnvelope v1, ContextManifest v1, schema-3 jobs with
  progress/heartbeat/lifecycle events, public JSON projection, host-scoped
  explicit job IDs, exact completion/recorded-verification-manifest resume, and
  final `GROK_WORKER_REPORT` validation with one same-session format-repair turn
  under a checked-in no-workspace profile with only the provider-required
  plan-state compatibility tool. A completed second invalid report fails
  with `E_SCHEMA`; repair transport/auth/capability failures preserve their
  operational error code. Runtime evidence is separated from provider claims;
  `hostVerification` remains `not_run` until the host records bounded outcomes.
- Write tasks require structured `--envelope-stdin` or private `--envelope-file`
  input. Task-scoped envelopes name exact pre-existing `context.requiredPaths`,
  which the runtime verifies before delegation. Command verification listed in
  `requiredVerification` is host-owned; an in-scope failure can be fed back by
  exact prior job ID for a bounded same-lineage fix-and-reverify cycle. Recorded
  command/status/exit-code outcomes create one scope-checked, host-asserted exact
  post-verification manifest used by that continuation. Empty records, repeated
  reconciliation, out-of-scope drift, and reconciliation during an active writer
  fail closed.
- Profile contract v3 with `rescue-read-v3`, `rescue-write-v3`, and no-workspace
  `rescue-report-v3` under **strict**
  sandbox. Write tools are only `GrokBuild:read_file`, `list_dir`, `grep`,
  `search_replace`, and `todo_write` (no terminal, kill_task, get_task_output,
  workspace sandbox, or bypass permissions).
- Per-lineage task homes under `task-homes/<providerHomeId>/`. Cached credentials
  are staged for session authentication and removed before the task prompt; they
  are not persistent task credentials.
- One active workspace writer at a time. Write mutations are native-like
  in-place; scope violations are detected after mutation (`E_SCOPE_VIOLATION`)
  and are not rolled back. Bounded ignored-worktree identities close the normal
  Git-status blind spot and fail closed when a changed ignored path cannot be
  attributed. Scope checks retain the complete internally attributable path set;
  bounded public evidence marks changed-path overflow without rejecting an
  otherwise in-scope bulk refactor.
- Residual limitations: macOS child-network isolation is not enforced by Grok;
  post-mutation scope detection only; Codex natural-flow E2E for this slice
  outstanding.
- Dual-host packaging: Codex marketplace/manifest, eight `$grok:*` skills, host
  identity, shared SessionStart/Stop hooks, Claude-only SessionEnd, and
  privacy-filtered Codex transcript transfer through a private anonymous
  descriptor.
- Codex has no documented `SessionEnd` event, so its background jobs remain
  recoverable until completion, explicit cancellation, or stale-worker cleanup.

## 0.2.0

- Added native Codex plugin packaging, a repository marketplace, and eight
  `$grok:*` workflow skills matching the Claude Code command surface.
- Added host-aware session ownership, state storage, background workers,
  recursion guards, resume selection, and Codex-specific follow-up guidance.
- Added Codex `SessionStart` transcript capture and the supported `Stop` review
  gate while making Claude explicitly load the shared hook file and its
  Claude Code-only `SessionEnd` cleanup file.
- Added privacy-filtered Codex transcript transfer. The converter keeps only
  user-visible user and assistant messages, excludes developer/system context,
  reasoning and tool traces, and passes the converted stream to `grok import`
  through a private anonymous descriptor.
- Added exact-size descriptor snapshots, secure converted-file disposal,
  fail-closed implicit job selection, visible non-secret SessionStart failures,
  cross-host skill discovery policy, and verdict/finding consistency checks.
- Codex has no documented `SessionEnd` event, so its background jobs remain
  recoverable until completion, explicit cancellation, or stale-worker cleanup.

## 0.1.0

- Community dual-host companion scaffolding and initial runtime toward 0.2.0.
- Headless `explore` review, adversarial review, and optional stop review with
  isolated review homes and structured output validation.
- ACP v1 read-only and write-capable rescue tasks with checked-in
  `agentProfileDigest`-bound `toolConfig` profiles and `injectDefaultTools:
  false`. Later hardening (see 0.3.0-dev.0) replaced shared mode homes, terminal write
  tools, and persistent task credentials with the v3 control-plane contract.
- Background jobs, resume, status, result, cancellation, and lifecycle hooks.
  Builtin capabilities and isolated provider-bundled skills rooted beneath
  `<isolated GROK_HOME>/skills/` or `<isolated GROK_HOME>/bundled/skills/` are
  allowed; external hooks, skills, plugins, MCP servers, and non-builtin agents
  are rejected.
- Required cached authentication created by `grok login`, rejected
  environment-key-only auth, and automatic near-expiry refresh before isolated
  staging.
- Claude transcript transfer through `grok import --json` with an advertised,
  model-qualified resume command, post-open device/inode binding for the
  directly inherited transcript descriptor, asynchronous timeout/cancellation,
  and no plugin-owned transcript copy.
- Fail-closed active-provider recursion guards, verified process ownership,
  cancellation nonces, worker-crash recovery, verified whole-process-group
  TERM-to-KILL escalation, and exact-value credential redaction. SessionEnd
  verifies complete owned worker/provider groups before removing guards or
  state; unverifiable shutdown records `E_PROCESS_IDENTITY` and retains both.
- Historical authenticated 10-case macOS 26.5 arm64 matrix with Grok Build
  0.2.99 on July 13, 2026 is retained under `tests/e2e-results/` as prior
  evidence for an earlier contract and does **not** qualify the current
  hardening worktree.
- Enforced the stable Grok Build 0.2.99 compatibility floor without an upper
  managed-version allowlist. Linux remains
  provider-unverified; Windows provider execution/process control is unsupported
  until authenticated lifecycle evidence exists.
