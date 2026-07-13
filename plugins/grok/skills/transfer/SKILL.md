---
name: transfer
description: Import the current Codex task transcript, or an explicitly supported transcript source, into a resumable Grok Build session without reading or reproducing transcript contents.
user-invocable: false
---

# Grok Transfer

Use this skill when the user wants to continue the current Codex conversation in Grok or import supported session context into Grok Build.

## Invocation contract

1. Take the absolute path of this `SKILL.md` from the active skill catalog. Resolve `../../scripts/grok-codex.mjs` relative to the directory containing this file. Do not resolve it from the workspace, search `PATH`, or use a host-specific plugin-root environment variable.
2. Run exactly one process for this action:

   ```text
   node <resolved-grok-codex.mjs> transfer [--source <transcript-jsonl>] [--model <id>] [--effort low|medium|high]
   ```

3. Forward only the user's explicit supported flags as separate literal arguments. Never evaluate a source path or other input as shell syntax.
4. Return the runtime output unchanged. If it exits unsuccessfully, return its emitted error unchanged and stop.

Do not open, read, summarize, copy, transform, or quote the transcript yourself. Do not attempt a manual import, retry, or substitute a host-generated summary.
