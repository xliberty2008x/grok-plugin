---
name: setup
description: Check whether Grok Build is installed, authenticated, compatible, and ready for Grok Companion tasks from Codex; also enable or disable the review gate when explicitly requested.
user-invocable: false
---

# Grok Setup

Use this skill when the user asks to set up, configure, diagnose, or verify the Grok Companion integration.

## Invocation contract

1. Take the absolute path of this `SKILL.md` from the active skill catalog. Resolve `../../scripts/grok-codex.mjs` relative to the directory containing this file. Do not resolve it from the workspace, search `PATH`, or use a host-specific plugin-root environment variable.
2. After resolving that installed wrapper, run exactly one process through exactly one approval-coupled unified execution call for this action. Its command must be exactly:

   ```text
   node <resolved-grok-codex.mjs> setup [--enable-review-gate|--disable-review-gate]
   ```

   Use `sandbox_permissions: "require_escalated"`, `login: false`, `tty: false`, and the narrow justification `Allow this one Grok setup command to access Grok Companion's private plugin data outside the managed workspace so it can validate readiness and write owner-only state.` This disables the tool's login/interactive shell semantics and PTY framing so those host defaults do not add work around the requested command. This is one-time, command-scoped unsandboxed execution. It is not a literal exact-path grant. Omit `prefix_rule`; do not create a persistent approval rule. Do not make a sandboxed first attempt.
3. Forward only the setup flag the user explicitly requested. The two gate flags are mutually exclusive; omit both unless the user requested exactly one.
4. The approval request must complete before process execution. If approval is denied or unavailable, no setup or provider process has started. Report that Grok setup reached a managed Codex capability boundary and can be retried only where one-time command approval is available, then stop.
5. If approved, run the exact command once. Return the runtime output unchanged. If it exits unsuccessfully, return its emitted error unchanged and stop.

Do not install Grok, request or display credentials, retry the command, run a review, or perform a fallback readiness check. The runtime owns setup validation and remediation guidance.
