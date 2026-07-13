---
description: Show the stored final output for a finished Grok Companion job
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

<!-- Adapted and modified from openai/codex-plugin-cc v1.0.6 (Apache-2.0). -->

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" result "$ARGUMENTS"`

Present the full command output exactly as returned. Do not summarize, condense, reorder, or add commentary.

Preserve the job ID, status, complete result payload, findings, paths, error details, Grok session ID, resume command, and follow-up commands when present. If the job is still active, return the runtime's actionable status error and stop.
