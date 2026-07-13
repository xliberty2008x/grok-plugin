---
name: rescue
description: Delegate an investigation, implementation, fix, or follow-up task directly to an isolated Grok Build session from Codex, with optional background, resume, model, and effort routing.
user-invocable: false
---

# Grok Rescue

Use this skill when the user wants Grok to investigate or implement a task. Invoke the companion runtime directly; never spawn a host subagent for this workflow.

## Invocation contract

1. Take the absolute path of this `SKILL.md` from the active skill catalog. Resolve `../../scripts/grok-codex.mjs` relative to the directory containing this file. Do not resolve it from the workspace, search `PATH`, or use a host-specific plugin-root environment variable.
2. Run exactly one process for this action:

   ```text
   node <resolved-grok-codex.mjs> task [--wait|--background] [--write] [--resume|--fresh] [--model <id>] [--effort low|medium|high] <task>
   ```

3. Preserve the user's task as one literal argument. Forward explicit routing flags as separate literal arguments and never evaluate user input as shell syntax.
4. Add `--write` for implementation, modification, or fix requests. Omit it for explicitly read-only review, diagnosis, investigation, planning, or research. Add `--resume` only when the user asks to continue a prior Grok task; otherwise honor an explicit `--fresh` and do not probe for a resume candidate.
5. Return the runtime output unchanged. If it exits unsuccessfully, return its emitted error unchanged and stop.

Do not inspect or modify the repository before the invocation, call a resume-candidate command, monitor a background job, retry, take over the work, or perform fallback work in the host.
