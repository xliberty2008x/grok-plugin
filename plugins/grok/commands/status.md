---
description: Show active and recent Grok Companion jobs for this repository
argument-hint: '[job-id] [--wait] [--timeout-ms <ms>] [--all]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

<!-- Adapted and modified from openai/codex-plugin-cc v1.0.6 (Apache-2.0). -->

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" status "$ARGUMENTS"`

Present the complete command output unchanged.

- Without a job ID, preserve the compact Markdown table exactly as returned.
- With a job ID, preserve all status, phase, summary, session, and follow-up details.
- Do not poll again unless the user supplied `--wait` or asks for a later update.
- Do not fetch the result, cancel the job, or summarize progress on the user's behalf.
