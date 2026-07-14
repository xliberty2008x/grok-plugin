---
description: Check whether the local Grok Build CLI is ready and optionally configure the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), Bash(npm:*), AskUserQuestion
---

<!-- Adapted and modified from openai/codex-plugin-cc v1.0.6 (Apache-2.0). -->

Run the Grok Companion setup check and present its result without inventing readiness.

Raw slash-command arguments:
`$ARGUMENTS`

First run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" setup "--json $ARGUMENTS"
```

Rules:

- Preserve `--enable-review-gate` or `--disable-review-gate` exactly. They are mutually exclusive.
- Never print or request authentication credentials. Preserve the runtime disclosure that reviews use an ephemeral private credential copy, while resumable ACP tasks stage a refreshed sanitized credential inside their private, extension-free lineage home only for authentication and remove it before `session/prompt` exposes workspace tools.
- Preserve the runtime's data-boundary disclosure and actionable next steps.
- If Grok is installed but authentication is unavailable, direct the user to run `grok login`, then `/grok:setup` again.
- If the result reports that Grok is missing, check whether npm is available. If npm is unavailable, present the original setup result and stop.
- If Grok is missing and npm is available, use `AskUserQuestion` exactly once. Put the install option first and suffix it with `(Recommended)`:
  - `Install Grok (Recommended)` — runs `npm install -g @xai-official/grok`.
  - `Skip for now` — makes no system changes.
- Run the installation only after the user selects it. Then rerun the same setup command and present the new result.
- Do not run the curl installer automatically. It may be mentioned only as a manual alternative from official Grok documentation.
- Do not perform a review or rescue task from setup.

Present the final setup output clearly. Do not claim that the plugin is ready when the returned `ready` value is false.
