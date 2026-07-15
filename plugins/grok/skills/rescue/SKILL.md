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
2. Start exactly one process-backed persistent Grok job with:

   ```text
   node <resolved-grok-codex.mjs> task --background --envelope-stdin --stdin-ready [--write] [--fresh] [--job-id <id>] [--model <id>] [--effort low|medium|high]
   ```

   Codex unified execution does not accept stdin bytes in the process-start call. Launch the command with `tty: true`, a short yield, and no task text in argv. The runtime switches its private PTY input to raw mode, which disables PTY echo, attaches the asynchronous reader, and writes the exact readiness line `GROK_COMPANION_STDIN_READY` to stderr. Retain the returned process session ID and wait for that marker. Then make exactly one `write_stdin` call on that same session whose characters are the compact TaskEnvelope JSON followed by `\n\u0004`. The literal EOT byte terminates the raw PTY frame; do not omit it, send it in a separate call, or send any bytes after it. If the user aborts before a job ID exists, send one literal `\u0003` on that session; the runtime restores the PTY and returns `E_CANCELLED`. Never start a second process to deliver input, interpolate the envelope into shell syntax, expose it through terminal echo, or treat the initial lack of output as failure. `mode: write` must match `--write`; omit `--write` for read mode.
3. Record the returned job ID immediately. If the host execution tool yields a live process/session handle, retain and continue that exact handle; never discard it or start a duplicate job.
4. Follow the exact job with `status <job-id> --wait --timeout-ms <bounded-ms>` or bounded status calls. Surface phase, meaningful plan/activity, and heartbeat without exposing private logs or hidden reasoning.
5. When terminal, call `result <job-id>` and integrate the structured worker report. For continuation, use the explicit parent `--job-id`; never select an implicit latest job for new workflows.
6. Inspect the resulting diff and runtime-observed paths, enforce scope, and run the declared `requiredVerification` commands from the host. The Grok write profile deliberately has no terminal, so provider `checksClaimed`, changed-file claims, and `outcome` are not host verification; runtime `hostVerification` begins as `not_run`. Immediately record at least one bounded command/status/exit-code outcome with `node <resolved-grok-codex.mjs> record-verification <job-id> --verification-stdin --stdin-ready --json`. Use the same PTY -> readiness marker -> one `write_stdin` containing compact JSON plus `\n\u0004` sequence for `{"commandOutcomes":[...]}` and never include command output. This one-shot operation is accepted only for a terminal task, with no active writer and no checkout drift outside the original scope. It captures a `host_asserted` exact checkpoint for continuation; it does not prove that the command caused intervening file changes.
7. If a recorded host check fails and the failure is within the original authority and scope, create one concise continuation envelope containing the failing command, bounded redacted output, and a new observable acceptance criterion. Start the continuation with `--job-id <terminal-job-id>` and the same mode/profile, then repeat exact-job monitoring and host verification. This is the native-like fix-and-reverify loop; never silently widen scope, replay the original job, or continue from an unrelated latest session. Stop when checks pass, the worker reports blocked, the same failure repeats, or user authority is required.
8. Report a synthesized outcome containing every job ID in the logical chain, worker claims, runtime evidence, host verification, unresolved risks/questions, and any exact error code.

Use the companion cancel command for cancellation. Do not widen Grok's profile merely to perform host checks, silently replay a failed task, signal opaque process trees yourself, or substitute a different worker unless the active fallback policy permits it after a concrete failure.

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
