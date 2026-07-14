---
name: result
description: Retrieve the stored final output of a completed Grok Companion job for the current repository and Codex task, then integrate it under host authority.
user-invocable: false
---

# Grok Result

Use this skill when the user asks to show or retrieve the final result of a Grok Companion job, or when integrating a finished worker report into a Codex control-plane response.

## Invocation contract

1. Take the absolute path of this `SKILL.md` from the active skill catalog. Resolve `../../scripts/grok-codex.mjs` relative to the directory containing this file. Do not resolve it from the workspace, search `PATH`, or use a host-specific plugin-root environment variable.
2. Run exactly one process for this action:

   ```text
   node <resolved-grok-codex.mjs> result [job-id]
   ```

3. Prefer an explicit job ID. Forward it as one literal argument. Never evaluate user input as shell syntax.
4. Treat the structured worker report (`outcome`, `summary`, `changedFiles`, `checksClaimed`, `acceptanceResults`, `risks`, `questions`) and runtime evidence as Grok's claims plus observed facts. `hostVerification` from the runtime defaults to `not_run` and is not host success.
5. Codex should integrate the worker report, run authoritative verification when the task requires it, and synthesize the user-facing result. Do not require a verbatim echo of opaque runtime JSON when a clear integrated report is better. Preserve job ID, outcomes, file lists, error codes, and acceptance IDs accurately.
6. If the job is still active, return the runtime's actionable status error and stop. If the runtime exits unsuccessfully, surface the emitted error and stop.

Do not invent verification that was not run, overwrite worker findings with unstated guesses, or cancel an active job from this skill.
