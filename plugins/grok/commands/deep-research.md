---
description: Run first-class Grok /deep-research (background + public web by default)
argument-hint: '[--wait|--background] [--web-only|--workspace] [--model <id>] [--effort <low|medium|high>] <query...>'
allowed-tools: Bash(node:*), AskUserQuestion
---

<!-- First-class Grok Companion deep-research surface (not adapted from openai/codex-plugin-cc). -->

Run Grok's built-in `/deep-research` workflow through the companion runtime. Defaults are **background** and **web-only** (public web). Use `--workspace` only when the user explicitly wants a temporary read-only tracked-files snapshot of the current checkout. The real workspace is never mutated.

Raw user request:
`$ARGUMENTS`

Control-plane rules:

- Parse routing flags: `--wait` / `--background` (default background), `--web-only` / `--workspace` (default web-only), optional `--model` and `--effort` (`low|medium|high` only when the user requested them).
- Remaining text after flags is the research query. If no query remains, ask what to research.
- Resolve `"${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs"`.
- Start exactly one process:

  ```text
  node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" deep-research --background --web-only --query-stdin --stdin-ready [--model <id>] [--effort <low|medium|high>] [--workspace]
  ```

  Prefer the user-selected mode flags over the defaults above when they were explicit. Launch with a private stdin path for the query (never put the query on argv). After the runtime writes `GROK_COMPANION_STDIN_READY` on stderr, write the UTF-8 query followed by a terminating frame as the host's stdin contract requires. Reject empty queries and never include NUL bytes.
- Record the returned job ID immediately. Follow with `status <job-id> --wait` / `result <job-id>` / `cancel <job-id>` as needed.
- Do **not** use TaskEnvelope, rescue resume, report repair, mailbox follow-ups, or `record-verification` for deep-research.
- Provider report status `verified` / `partial` is not host verification; `hostVerification` remains `not_run`.
- Do not auto-resume, replay, or silently substitute another worker after failure, pause, budget limits, or cancellation.
- Cancellation uses companion `cancel <job-id>` so the runtime can send `/workflow stop <exact-run-id>` and wait for settled cleanup.

Present job ID, status/phase, workflow metadata, provider report status, source count, coverage notes, and exact error codes clearly. Preserve honest data/cost boundaries: public-web research may process the query and selected public pages under the user's Grok account.
