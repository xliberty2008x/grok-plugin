---
name: deep-research
description: Dispatch first-class Grok /deep-research through a dedicated ACP runner with background and public-web defaults, optional read-only workspace snapshot, and durable research jobs.
user-invocable: false
---

# Grok Deep Research

Use this skill when the user wants Grok's built-in `/deep-research` workflow. This is **not** rescue, not TaskEnvelope, and not an arbitrary plugin runner.

## Defaults and options

| Option | Default | Notes |
|---|---|---|
| Mode | `--background` | Use `--wait` only when the user wants foreground completion |
| Research surface | `--web-only` | Public web only; empty private cwd |
| Workspace | off | Explicit `--workspace` creates a temporary tracked-files-only read-only snapshot |
| Model / effort | unset | Forward only when the user requested them; effort is `low\|medium\|high` |

## Boundaries

- Query ingress is **private stdin** only (`--query-stdin`), max **32 KiB**, no NUL bytes.
- Dedicated `deep-research-v1` profile: built-in workflow/subagents/WebSearch only; shell, writes, MCP, memory, plan, external plugins/hooks/skills/agents denied.
- WebFetch is disabled in this build because `allow_local=false` has not yet been independently attested; reports carry explicit reduced-coverage evidence.
- One unbound deep-research workflow run is correlated; revisions must increase monotonically.
- Report path is exactly `sessions/<percent-encoded-provider-cwd>/<session-id>/workflows/<run-id>/scratch/report.md` under the isolated provider home (bound cwd + ACP session only); max **512 KiB** UTF-8 regular file; `hostVerification` stays `not_run`.
- Cancellation sends `/workflow stop <exact-run-id>`, waits for settled zero-active-agents cleanup, then verified process cleanup.
- No automatic resume/replay after pause, budget limits, failure, interruption, timeout, or crash.
- Does **not** use TaskEnvelope, WorkerReport repair, mailbox, rescue resume, or `record-verification`.

## Invocation contract

1. Resolve `../../scripts/grok-codex.mjs` from this `SKILL.md`. Do not search `PATH`.
2. Select exactly one execution mode and one research surface before starting:
   - use `--background` by default, or replace it with `--wait` when the user explicitly requests foreground completion;
   - use `--web-only` by default; explicit `--workspace` replaces `--web-only` when the user requests the tracked-files snapshot.
   Never combine the two flags in either pair.
3. Start exactly one process with private query stdin using the selected complete form:

   Default public-web form:
   ```text
   node <resolved-grok-codex.mjs> deep-research --background --web-only --query-stdin --stdin-ready [--model <id>] [--effort low|medium|high]
   ```

   Explicit workspace form:
   ```text
   node <resolved-grok-codex.mjs> deep-research --background --workspace --query-stdin --stdin-ready [--model <id>] [--effort low|medium|high]
   ```

   In either form, explicit `--wait` replaces `--background`; it never supplements it.
4. Codex unified execution: launch with `tty: true`, wait for `GROK_COMPANION_STDIN_READY` on stderr, then one `write_stdin` of the UTF-8 query plus `\n\u0004`.
5. Record the job ID (`deep-research-*`). Follow with:

   ```text
   node <resolved-grok-codex.mjs> status <job-id> [--wait] [--timeout-ms <ms>]
   node <resolved-grok-codex.mjs> result <job-id>
   node <resolved-grok-codex.mjs> cancel <job-id>
   ```

6. Surface phase, workflow run ID/revision/status, provider report status (`verified`|`partial`), source count, coverage notes, and exact stable errors. Provider status is not host verification.

## Honest limits

- Public-web research processes the query and selected public pages under the user's Grok account/organization policy.
- Workspace mode never mutates the real checkout; only a temporary tracked snapshot is visible to Grok.
- Cost and latency can be high; default background mode avoids blocking the host turn.
- Do not claim host verification passed; `hostVerification` remains `not_run` for research jobs.
