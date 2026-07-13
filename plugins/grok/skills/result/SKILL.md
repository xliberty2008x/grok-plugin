---
name: result
description: Retrieve the stored final output of a completed Grok Companion job for the current repository and Codex task.
user-invocable: false
---

# Grok Result

Use this skill when the user asks to show or retrieve the final result of a Grok Companion job.

## Invocation contract

1. Take the absolute path of this `SKILL.md` from the active skill catalog. Resolve `../../scripts/grok-codex.mjs` relative to the directory containing this file. Do not resolve it from the workspace, search `PATH`, or use a host-specific plugin-root environment variable.
2. Run exactly one process for this action:

   ```text
   node <resolved-grok-codex.mjs> result [job-id]
   ```

3. Forward an explicit job ID as one literal argument. Never evaluate user input as shell syntax.
4. Return the full runtime output unchanged. If it exits unsuccessfully, return its emitted error unchanged and stop.

Do not summarize, condense, reorder, retry, wait for an active job, or reproduce the work in the host.
