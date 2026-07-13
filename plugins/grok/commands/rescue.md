---
description: Delegate investigation, implementation, or follow-up work to the Grok rescue subagent
argument-hint: '[--background|--wait] [--resume|--fresh] [--model <id>] [--effort <low|medium|high>] [task ...]'
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

<!-- Adapted and modified from openai/codex-plugin-cc v1.0.6 (Apache-2.0). -->

Invoke the `grok:grok-rescue` subagent through the `Agent` tool, forwarding the user's request and routing flags.

`grok:grok-rescue` is a subagent, not a skill. Do not call `Skill(grok:grok-rescue)` or re-enter `/grok:rescue`.

Raw user request:
`$ARGUMENTS`

Rules:

- If no task text remains after routing flags are removed, ask what Grok should investigate or implement.
- `--background` asks the plugin runtime to detach a persistent job and return its job ID. Invoke the rescue subagent inline so its acknowledgement can be returned immediately; do not create a second Claude background task.
- `--wait` runs the Grok job in the foreground.
- If neither execution flag is supplied, default to foreground.
- Preserve explicit `--model` and `--effort`. Do not select either unless the user requested it.
- Accepted effort values are `low`, `medium`, and `high`.
- If `--resume` or `--fresh` is explicit, do not ask a continuation question.
- Before looking for a resume candidate, infer the same security profile the rescue subagent will use: write-capable by default, except for an explicitly read-only request or a request limited to review, diagnosis, investigation, planning, or research without edits.
- Otherwise run exactly one of:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" task-resume-candidate --write --json
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" task-resume-candidate --json
```

Use the first form for the inferred write profile and the second for the inferred read-only profile. Never select a candidate from the other profile.

- If a compatible candidate is available, use `AskUserQuestion` exactly once:
  - For a clear follow-up such as "continue", "keep going", "apply the fix", or "dig deeper", put `Continue current Grok session (Recommended)` first.
  - Otherwise put `Start a new Grok session (Recommended)` first.
  - The other option is the non-recommended alternative.
- Add `--resume` for continue or `--fresh` for a new session.
- If no compatible candidate is available, route the request without asking.

Invoke `grok:grok-rescue` exactly once. The subagent may only shape the forwarded prompt, make one runtime `task` call, and return that command's output.

Return the subagent output verbatim. Do not inspect the repository, solve the task, monitor a background job, or take over after Grok fails. Direct the user to `/grok:setup` only when the runtime reports a setup or authentication prerequisite.
