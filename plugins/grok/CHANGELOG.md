# Changelog

## 0.3.0-dev.1

Status: hardening candidate; not release-qualified.

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
  under a checked-in zero-tool profile. A completed second invalid report fails
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
- Profile contract v3 with `rescue-read-v3`, `rescue-write-v3`, and zero-tool
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
- Enforced Grok Build 0.2.99 compatibility floor. Linux remains
  provider-unverified; Windows provider execution/process control is unsupported
  until authenticated lifecycle evidence exists.
