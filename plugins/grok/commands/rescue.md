---
description: Delegate a bounded task to Grok under a Claude control plane, then verify and integrate it
argument-hint: '[--job-id <id>|--fresh] [--model <id>] [--effort <low|medium|high>] [task ...]'
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

<!-- Adapted and modified from openai/codex-plugin-cc v1.0.6 (Apache-2.0). -->

Invoke the `grok:grok-rescue` subagent through the `Agent` tool, forwarding the user's request and routing flags.

`grok:grok-rescue` is a subagent, not a skill. Do not call `Skill(grok:grok-rescue)` or re-enter `/grok:rescue`.

Raw user request:
`$ARGUMENTS`

Control-plane rules:

- If no task text remains after routing flags are removed, ask what Grok should investigate or implement.
- The rescue subagent performs one native-like workflow: repository preflight, structured envelope, immediate persistent job ID, exact-job monitoring, structured result integration, and host verification.
- Host checks are recorded as bounded command/status/exit-code evidence before continuation. A failed recorded check may trigger a bounded explicit continuation from that exact terminal job ID under the same profile; the subagent re-runs and records host verification after the fix and stops on repetition, blocked work, or required new authority.
- Do not create a second Claude background task; the companion job is already persistent.
- Preserve explicit `--model` and `--effort`. Do not select either unless the user requested it.
- Accepted effort values are `low`, `medium`, and `high`.
- Continue only with an explicit prior `--job-id` from this host task. Do not probe or select an implicit newest session. Use `--fresh` for an explicitly new worker session.
- The subagent chooses write mode only for implementation/modification; diagnosis, review, planning, and research remain read-only.

Invoke `grok:grok-rescue` exactly once with the raw request and routing flags. It may use the runtime task/status/result sequence for the one returned job.

Present its integrated worker/runtime/host-verification result clearly. Preserve job IDs and exact failures. Do not silently retry, broaden permissions, or replace Grok after a failure unless an active higher-level fallback policy explicitly allows it.
