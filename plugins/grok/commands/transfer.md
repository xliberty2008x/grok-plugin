---
description: Import the current Claude Code transcript into a resumable Grok session
argument-hint: '[--source <claude-jsonl>] [--model <id>] [--effort low|medium|high]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

<!-- Adapted and modified from openai/codex-plugin-cc v1.0.6 (Apache-2.0). -->

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" transfer "$ARGUMENTS"`

Present the command output exactly as returned. Preserve the imported Grok session ID and the exact model-qualified `grok --model <id> --resume <session-id>` command. Imported Claude sessions use a legacy placeholder model in Grok Build 0.2.99, so omitting the selected available model can make direct resume return an empty result.

Do not read, copy, summarize, or quote the transcript. The runtime accepts only a real `.jsonl` file beneath `~/.claude/projects` and sends it through Grok's native import command. On failure, report the runtime error without attempting a manual transcript conversion.
