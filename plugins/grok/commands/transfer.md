---
description: Import the current Claude Code transcript into a resumable Grok session
argument-hint: '[--source <claude-jsonl>] [--model <id>] [--effort low|medium|high]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

<!-- Adapted and modified from openai/codex-plugin-cc v1.0.6 (Apache-2.0). -->

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" transfer "$ARGUMENTS"`

Present the command output exactly as returned. Preserve the imported Grok session ID and exact model-qualified `grok --model <id> [--reasoning-effort <effort>] --resume <session-id>` command. Imported legacy-model sessions can otherwise resume with an empty result, so the runtime discovers the model from the same non-isolated Grok home used for import and waits until the exact session ID is listed before returning success.

Do not read, copy, summarize, or quote the transcript. The runtime accepts only a real `.jsonl` file beneath `~/.claude/projects`, freezes its validated current size into an anonymous point-in-time descriptor, and sends that snapshot through Grok's native import command. On failure, report the runtime error without attempting a manual transcript conversion.
