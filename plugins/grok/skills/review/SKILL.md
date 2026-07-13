---
name: review
description: Run an isolated, read-only Grok review of the current Git working tree or branch from Codex. Use for independent defect-oriented code review without custom focus instructions.
user-invocable: false
---

# Grok Review

Use this skill for a normal Grok code review. Use `$grok:adversarial-review` instead when the user supplies a custom challenge or focus.

## Invocation contract

1. Take the absolute path of this `SKILL.md` from the active skill catalog. Resolve `../../scripts/grok-codex.mjs` relative to the directory containing this file. Do not resolve it from the workspace, search `PATH`, or use a host-specific plugin-root environment variable.
2. Run exactly one process for this action:

   ```text
   node <resolved-grok-codex.mjs> review [--wait|--background] [--base <ref>] [--scope auto|working-tree|branch]
   ```

3. Forward the user's supported flags as separate literal arguments. Never evaluate user input as shell syntax. If no execution flag was requested, omit both; the runtime selects its foreground default.
4. Return the runtime output unchanged. If it exits unsuccessfully, return its emitted error unchanged and stop.

This action is read-only. Do not inspect the repository before invoking the runtime, add review focus, fix findings, retry, or perform a host-side review.
