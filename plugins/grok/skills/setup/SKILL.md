---
name: setup
description: Check whether Grok Build is installed, authenticated, compatible, and ready for Grok Companion tasks from Codex; also enable or disable the review gate when explicitly requested.
user-invocable: false
---

# Grok Setup

Use this skill when the user asks to set up, configure, diagnose, or verify the Grok Companion integration.

## Invocation contract

1. Take the absolute path of this `SKILL.md` from the active skill catalog. Resolve `../../scripts/grok-codex.mjs` relative to the directory containing this file. Do not resolve it from the workspace, search `PATH`, or use a host-specific plugin-root environment variable.
2. Run exactly one process for this action:

   ```text
   node <resolved-grok-codex.mjs> setup [--enable-review-gate|--disable-review-gate]
   ```

3. Forward only the setup flag the user explicitly requested. The two gate flags are mutually exclusive.
4. Return the runtime output unchanged. If it exits unsuccessfully, return its emitted error unchanged and stop.

Do not install Grok, request or display credentials, retry the command, run a review, or perform a fallback readiness check. The runtime owns setup validation and remediation guidance.
