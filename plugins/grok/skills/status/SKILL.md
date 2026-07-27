---
name: status
description: Show active or recent Grok Companion jobs for the current repository and Codex task, optionally waiting for one specific job.
user-invocable: false
---

# Grok Status

Use this skill when the user asks for Grok job progress, or while a rescue control-plane workflow is following its exact job. Codex monitors; Grok remains the worker.

## Pure preflight vs recovery status

- **Pure preflight:** `status --all --readonly --json` (optional job ID without `--wait`). Strictly non-mutating: no recovery, migration, mkdir, chmod, lock, clean, or marker publication. JSON with `--all` returns `{ "jobs": [...], "migrationRequired": boolean }`. Fail-closed on malformed/unsafe state (`E_STATE`). Does **not** prove plugin-data writability. Cannot combine `--readonly` with `--wait` or `--timeout-ms`.
- **Recovery status (default):** `status [job-id] [--wait] [--timeout-ms <ms>] [--all]`. May recover lost workers, migrate late legacy state, and create/repair private state directories. Use this for normal monitoring after dispatch.
- **Write capability:** Unwritable workspace control state surfaces as `E_STORAGE_READONLY` at state initialization/repair or admission (durable lock or atomic job write) before worker/provider launch—not as a result of pure `--readonly` preflight.

## Invocation contract

1. Take the absolute path of this `SKILL.md` from the active skill catalog. Resolve `../../scripts/grok-codex.mjs` relative to the directory containing this file. Do not resolve it from the workspace, search `PATH`, or use a host-specific plugin-root environment variable.
2. Run exactly one process for this action:

   ```text
   node <resolved-grok-codex.mjs> status [job-id] [--wait] [--timeout-ms <ms>] [--all] [--readonly] [--json]
   ```

3. Prefer an explicit job ID when following a known task. Forward the job ID and supported flags as separate literal arguments. Never evaluate user input as shell syntax.
4. For rescue preflight before dispatch, use only `status --all --readonly --json` (or the rescue skill’s documented preflight step). For post-dispatch monitoring, use default recovery status (optionally `--wait`).
5. Report current phase, latest meaningful progress, timestamps/heartbeat, and job ID. Plans and operational evidence only — never invent or expose hidden chain-of-thought.
6. You may summarize status for the user in plain language. Preserve job ID, status, phase, progress, and error codes accurately. Do not require a verbatim dump of opaque runtime output when a clear monitor update is more useful.
7. If the runtime exits unsuccessfully, surface the emitted error and stop. Treat `E_STORAGE_READONLY` as a storage-capability prerequisite failure from a mutating path (fix plugin data permissions/media), not as malformed state and not as proof that pure `--readonly` preflight checked writes.

Within an active rescue workflow, the originating rescue contract may fetch the result after status becomes terminal. Otherwise do not fetch a result or cancel unless asked. Never retry failures automatically or perform the worker task yourself. Prefer status/wait over process signals.
