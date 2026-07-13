---
name: cancel
description: Cancel one active Grok Companion job in the current repository and Codex task, using an explicit job ID when supplied.
user-invocable: false
---

# Grok Cancel

Use this skill when the user asks to stop or cancel a Grok Companion background or foreground job.

## Invocation contract

1. Take the absolute path of this `SKILL.md` from the active skill catalog. Resolve `../../scripts/grok-codex.mjs` relative to the directory containing this file. Do not resolve it from the workspace, search `PATH`, or use a host-specific plugin-root environment variable.
2. Run exactly one process for this action:

   ```text
   node <resolved-grok-codex.mjs> cancel [job-id]
   ```

3. Forward an explicit job ID as one literal argument. Never evaluate user input as shell syntax.
4. Return the complete runtime output unchanged. If it exits unsuccessfully, return its emitted error unchanged and stop.

Do not cancel an additional job, retry or resume the task, continue the cancelled work, or perform fallback work in the host.
