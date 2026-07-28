---
name: rescue
description: Delegate an investigation, implementation, fix, or follow-up task to an isolated Grok Build worker under a Codex control plane, with optional background, explicit resume-by-job-ID, model, and effort routing.
user-invocable: false
---

# Grok Rescue

Use this skill when Grok should investigate or implement a bounded task. Grok is the primary worker; Codex remains the control plane and owns context, integration, and authoritative success.

## Control-plane roles

- **Codex (host):** inspect the repository and Git state, preserve the literal request, build the task contract, monitor the exact job, integrate the result, run authoritative verification, and synthesize the user-facing result.
- **Grok (worker):** bounded execution or investigation inside the companion runtime. Treat provider success, checks claimed, and summaries as worker claims only until Codex verifies them.
- **Cancellation:** prefer `$grok:cancel` / `cancel <job-id>` for in-flight jobs; do not force-kill opaque process trees from the host skill path.

## Preflight and TaskEnvelope

Before dispatch, inspect only enough repository state to make delegation safe: canonical checkout, branch/HEAD, dirty paths, sparse/shallow/worktree state, expected project markers, relevant repository instructions, and whether another writer is active. For whole-project work, verify the checked-out HEAD against the intended upstream ref through the configured remote or connected repository before setting `workspaceState: complete` and `upstreamFreshness: verified`; a local tracking ref alone is not freshness evidence. If remote verification is unavailable, stop instead of guessing. Use `task_scoped` only when every path and project marker needed by the bounded task is actually present.

Also run the pure companion status preflight (zero filesystem mutations; no recovery/migration) before starting a task:

```text
node <resolved-grok-codex.mjs> status --all --readonly --json
```

Use this surface only for pure read preflight observability. It returns `{ "jobs": [...public projections...], "migrationRequired": boolean }` when the control store is readable, keeps existing control jobs visible, and reports whether valid legacy state still requires migration—without migrating, recovering workers, creating directories, chmod, locking, cleaning, or publishing markers. It does **not** prove plugin-data writability and must not be treated as a storage-capability check. Do not use default `status` (recovery/migration) for this preflight step. If pure preflight fails with `E_STATE`, treat authoritative state as unsafe and stop. Write capability is enforced later at job admission (`admitJob` / durable lock and atomic state write) **before** worker/provider launch; unwritable storage surfaces there as sanitized `E_STORAGE_READONLY` (prerequisite)—stop and remediate plugin-data permissions/media, then retry dispatch.

Build one JSON object with exactly these TaskEnvelope v1 input fields:

```json
{
  "schemaVersion": 1,
  "userRequest": "literal user request",
  "objective": "bounded objective",
  "mode": "read or write",
  "scope": { "include": ["glob"], "exclude": ["glob"] },
  "context": {
    "facts": ["selected facts needed by the worker"],
    "constraints": ["trusted host/repository constraints"],
    "expectedProjectMarkers": ["package.json"],
    "requiredPaths": ["src", "package.json"],
    "workspaceState": "complete or task_scoped",
    "upstreamFreshness": "verified or not_checked"
  },
  "nonGoals": ["explicit exclusions"],
  "acceptanceCriteria": [{ "id": "AC-1", "text": "observable criterion" }],
  "requiredVerification": ["commands/evidence the host must run after the worker returns"],
  "expectedReturnFormat": "GROK_WORKER_REPORT JSON plus concise human summary"
}
```

`requiredPaths` contains exact repository-relative files or directories that must already exist; use it to prove that a task-scoped checkout contains the implementation slice, not only documentation. Do not use globs or paths the task is expected to create. Do not include credentials, raw transcripts, unrelated conversation history, or guessed repository facts.

## Native-like job workflow

1. Resolve `../../scripts/grok-codex.mjs` from this `SKILL.md` exactly. Do not search `PATH` or resolve from the workspace.
2. Run pure status preflight once: `node <resolved-grok-codex.mjs> status --all --readonly --json`. Confirm observable control jobs / migrationRequired and that authoritative state is readable and safe. This is not a writability probe. Do not recover or migrate via default status here.
3. Start exactly one process-backed persistent Grok job with:

   ```text
   node <resolved-grok-codex.mjs> task --background --envelope-stdin --stdin-ready [--write] [--fresh] [--job-id <id>] [--model <id>] [--effort low|medium|high]
   ```

   Codex unified execution does not accept stdin bytes in the process-start call. Launch the command with `tty: true`, a short yield, and no task text in argv. The runtime switches its private PTY input to raw mode, which disables PTY echo, attaches the asynchronous reader, and writes the exact readiness line `GROK_COMPANION_STDIN_READY` to stderr. Retain the returned process session ID and wait for that marker. Then make exactly one `write_stdin` call on that same session whose characters are the compact TaskEnvelope JSON followed by `\n\u0004`. The literal EOT byte terminates the raw PTY frame; do not omit it, send it in a separate call, or send any bytes after it. If the user aborts before a job ID exists, send one literal `\u0003` on that session; the runtime restores the PTY and returns `E_CANCELLED`. Never start a second process to deliver input, interpolate the envelope into shell syntax, expose it through terminal echo, or treat the initial lack of output as failure. `mode: write` must match `--write`; omit `--write` for read mode. If the runtime fails with `E_STORAGE_READONLY` at this step, admission could not durably write job state (before worker/provider launch); fix plugin-data writability and retry—do not treat it as malformed `E_STATE` or a provider failure. If admission fails with the exact missing/invalid provider capability receipt error, follow [Recoverable setup prerequisite (capability receipt only)](#recoverable-setup-prerequisite-capability-receipt-only)—do not auto-setup for any other `E_CAPABILITY`.
4. Record the returned job ID immediately. If the host execution tool yields a live process/session handle, retain and continue that exact handle; never discard it or start a duplicate job.
5. Follow the exact job with default recovery `status <job-id> --wait --timeout-ms <bounded-ms>` or bounded status calls (not `--readonly`). Surface phase, meaningful plan/activity, and heartbeat without exposing private logs or hidden reasoning.
6. When terminal, call `result <job-id>` and integrate the structured worker report. For continuation, use the explicit parent `--job-id`; never select an implicit latest job for new workflows.
7. Inspect the resulting diff and runtime-observed paths, enforce scope, and run the declared `requiredVerification` commands from the host. The Grok write profile deliberately has no terminal, so provider `checksClaimed`, changed-file claims, and `outcome` are not host verification; runtime `hostVerification` begins as `not_run`. Immediately record at least one bounded command/status/exit-code outcome with `node <resolved-grok-codex.mjs> record-verification <job-id> --verification-stdin --stdin-ready --json`. Use the same PTY -> readiness marker -> one `write_stdin` containing compact JSON plus `\n\u0004` sequence for `{"commandOutcomes":[...]}` and never include command output. This one-shot operation is accepted only for a terminal task, with no active writer and no checkout drift outside the original scope. It captures a `host_asserted` exact checkpoint for continuation; it does not prove that the command caused intervening file changes.
8. If a recorded host check fails and the failure is within the original authority and scope, create one concise continuation envelope containing the failing command, bounded redacted output, and a new observable acceptance criterion. Start the continuation with `--job-id <terminal-job-id>` and the same mode/profile, then repeat exact-job monitoring and host verification. This is the native-like fix-and-reverify loop; never silently widen scope, replay the original job, or continue from an unrelated latest session. Stop when checks pass, the worker reports blocked, the same failure repeats, or user authority is required.
9. Report a synthesized outcome containing every job ID in the logical chain, worker claims, runtime evidence, host verification, unresolved risks/questions, and any exact error code.

Use the companion cancel command for cancellation. Do not widen Grok's profile merely to perform host checks, silently replay a failed task, signal opaque process trees yourself, or substitute a different worker unless the active fallback policy permits it after a concrete failure.

## Recoverable setup prerequisite (capability receipt only)

The runtime keeps a **fail-closed pre-launch provider capability receipt gate** before admitting a Codex task. Pure `status --readonly` is neither a capability check nor a writability check; missing receipts surface only at admission.

**Recoverable exact match only.** Treat admission failure as a recoverable setup prerequisite **only** when the runtime emits `E_CAPABILITY` with the exact message form:

```text
Valid provider capability receipt is missing or invalid; run $grok:setup before admitting a Codex task.
```

(The setup command token may be the host-local form such as `$grok:setup`; the rest of the sentence must match exactly.) Do **not** auto-setup for arbitrary `E_CAPABILITY` (unsupported model, effort, platform, executable identity, provider capability drift, isolation/external extensions, or any other non-receipt capability failure).

**One setup, one identical retry, no duplicate launch:**

1. Invoke the authoritative setup action **at most once**:

   ```text
   node <resolved-grok-codex.mjs> setup
   ```

2. **Setup failure:** surface the setup failure unchanged and **stop**. Do not retry the task, do not run setup again, and do not conceal the failure via worker fallback.
3. **Setup success:** retry the **identical** bounded task launch **exactly once**. Preserve the original TaskEnvelope (same user request, objective, scope, mode, freshness facts, model, effort, acceptance criteria, required verification, process/PTY framing, and write profile). Do not start a concurrent second process, do not change argv flags that define mode/model/effort/fresh/job-id, and do not re-run setup before or after this single retry.
4. **Persistent receipt error after that one retry**, or **any non-receipt `E_CAPABILITY`** at any step: remain **terminal** and eligible for the documented fallback policy. Do not auto-setup again; do not auto-retry again; do not mask the error as success.

## `record-verification` input contract

The stdin frame is one JSON object of at most 64 KiB whose only root field is `commandOutcomes`. That array must contain 1 through 64 outcomes with unique `command` values. Every outcome must contain exactly `command`, `status`, and `exitCode`: `command` must exactly match one declared `requiredVerification` string, `status` must be `passed|failed`, and `exitCode` must be an integer. Do not add `stdout`, `stderr`, `output`, summaries, excerpts, or any other fields.

A passing record must include every distinct declared `requiredVerification` command exactly once with `status: "passed"` and `exitCode: 0`. A failing record may be partial, but at least one submitted outcome must have `status: "failed"` or a nonzero `exitCode`. Given `requiredVerification: ["node --test tests/control-plane.test.mjs", "npm run lint"]`, this is a valid complete passing frame:

```json
{
  "commandOutcomes": [
    { "command": "node --test tests/control-plane.test.mjs", "status": "passed", "exitCode": 0 },
    { "command": "npm run lint", "status": "passed", "exitCode": 0 }
  ]
}
```
