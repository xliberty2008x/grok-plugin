---
name: status
description: Show active or recent Grok Companion jobs for the current repository and Codex task, optionally waiting for one specific job.
user-invocable: false
---

# Grok Status

Use this skill when the user asks for Grok job progress, state, or a list of recent companion jobs.

## Invocation contract

1. Take the absolute path of this `SKILL.md` from the active skill catalog. Resolve `../../scripts/grok-codex.mjs` relative to the directory containing this file. Do not resolve it from the workspace, search `PATH`, or use a host-specific plugin-root environment variable.
2. Run exactly one process for this action:

   ```text
   node <resolved-grok-codex.mjs> status [job-id] [--wait] [--timeout-ms <ms>] [--all]
   ```

3. Forward the job ID and supported flags as separate literal arguments. Never evaluate user input as shell syntax.
4. Return the complete runtime output unchanged. If it exits unsuccessfully, return its emitted error unchanged and stop.

Do not poll again unless a later user request asks you to, fetch a completed result, cancel a job, summarize progress, retry, or perform the job yourself.
