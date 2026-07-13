---
name: adversarial-review
description: Ask Grok to challenge an implementation approach, assumptions, tradeoffs, and second-order failure modes in the current Git changes, using an optional user-supplied focus.
user-invocable: false
---

# Grok Adversarial Review

Use this skill when the user wants a skeptical review, design challenge, assumption check, or focused critique rather than a normal defect scan.

## Invocation contract

1. Take the absolute path of this `SKILL.md` from the active skill catalog. Resolve `../../scripts/grok-codex.mjs` relative to the directory containing this file. Do not resolve it from the workspace, search `PATH`, or use a host-specific plugin-root environment variable.
2. Run exactly one process for this action:

   ```text
   node <resolved-grok-codex.mjs> adversarial-review [--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [focus text]
   ```

3. Forward supported flags as separate literal arguments and preserve the user's focus as one literal argument. Never evaluate user input as shell syntax. If no execution flag was requested, omit both; the runtime selects its foreground default.
4. Return the runtime output unchanged. If it exits unsuccessfully, return its emitted error unchanged and stop.

This action is read-only. Do not inspect the repository before invoking the runtime, weaken or reinterpret the focus, fix findings, retry, or perform a host-side review.
