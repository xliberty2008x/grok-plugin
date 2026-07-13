---
description: Run a read-only Grok code review against local Git state
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

<!-- Adapted and modified from openai/codex-plugin-cc v1.0.6 (Apache-2.0). -->

Run a normal Grok review through the plugin runtime.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraints:

- This command is review-only. Do not fix findings or modify files.
- Do not add custom review instructions. Use `/grok:adversarial-review` when focus text is needed.
- Return the runtime output verbatim. Do not paraphrase, summarize, reorder findings, or add commentary.

Execution-mode rules:

- If the raw arguments contain `--wait`, run immediately in the foreground.
- If they contain `--background`, run immediately. The runtime detaches its own worker and returns a job ID; do not launch a second Claude background task.
- `--wait` and `--background` are mutually exclusive.
- If neither flag is present, estimate the scoped change size before asking:
  - For auto or working-tree scope, inspect `git status --short --untracked-files=all`, `git diff --shortstat --cached`, and `git diff --shortstat`.
  - For branch scope, inspect the safely quoted base comparison when an explicit base is available.
  - Treat untracked files or directories as reviewable work even when Git shortstat is empty.
  - Recommend waiting only for a clearly tiny review, roughly one or two files with no broader directory-sized change.
  - Recommend background for every larger or uncertain target.
- Use `AskUserQuestion` exactly once with the recommended option first and `(Recommended)` in its label:
  - `Wait for results`
  - `Run in background`
- Add the selected execution flag to the forwarded runtime arguments.

Run exactly one review invocation:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" review "$ARGUMENTS"
```

If there are no arguments, omit the final empty argument. If an execution flag was selected interactively, forward the original arguments plus that flag as one safely quoted raw argument. Never evaluate user arguments as shell syntax.

Return stdout exactly as produced. On failure, report the runtime error and stop; do not perform a Claude-side review.
