---
name: status
description: Show active or recent Grok Companion jobs for the current repository and Codex task, optionally waiting for one specific job.
user-invocable: false
---

# Grok Status

Use this skill when the user asks for Grok job progress, or while a rescue control-plane workflow is following its exact job. Codex monitors; Grok remains the worker.

## Invocation contract

1. Take the absolute path of this `SKILL.md` from the active skill catalog. Resolve `../../scripts/grok-codex.mjs` relative to the directory containing this file. Do not resolve it from the workspace, search `PATH`, or use a host-specific plugin-root environment variable.
2. Run exactly one process for this action:

   ```text
   node <resolved-grok-codex.mjs> status [job-id] [--wait] [--timeout-ms <ms>] [--all]
   ```

3. Prefer an explicit job ID when following a known task. Forward the job ID and supported flags as separate literal arguments. Never evaluate user input as shell syntax.
4. Report current phase, latest meaningful progress, timestamps/heartbeat, and job ID. Plans and operational evidence only — never invent or expose hidden chain-of-thought.
5. You may summarize status for the user in plain language. Preserve job ID, status, phase, progress, and error codes accurately. Do not require a verbatim dump of opaque runtime output when a clear monitor update is more useful.
6. If the runtime exits unsuccessfully, surface the emitted error and stop.

Within an active rescue workflow, the originating rescue contract may fetch the result after status becomes terminal. Otherwise do not fetch a result or cancel unless asked. Never retry failures automatically or perform the worker task yourself. Prefer status/wait over process signals.
