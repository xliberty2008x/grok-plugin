---
name: grok-cli-runtime
description: Internal contract for invoking the Grok Companion runtime from the grok-rescue subagent
user-invocable: false
---

<!-- Adapted and modified from openai/codex-plugin-cc v1.0.6 (Apache-2.0). -->

# Grok Companion Runtime

Use this skill only inside `grok:grok-rescue`.

Primary invocation:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" task [routing flags] [--write] "<safely quoted task>"
```

The rescue subagent is a forwarder, not an orchestrator:

- Make exactly one `task` invocation.
- Never invoke Grok directly or call another runtime subcommand.
- Do not inspect the repository before forwarding.
- Do not monitor, poll, fetch, cancel, or continue the job afterward.
- Return runtime output unchanged.

Routing flags:

- `--background`: the runtime detaches a persistent worker and returns a job ID.
- `--wait`: run in the foreground.
- `--resume`: continue the newest compatible task session in this Claude session.
- `--fresh`: force a new Grok session.
- `--model <id>`: pass only when explicitly requested.
- `--effort low|medium|high`: pass only when explicitly requested.
- `--write`: select the workspace-write rescue profile.

Security-profile rules:

- Add `--write` by default for implementation or explicit fix requests.
- Omit `--write` for explicit read-only work and for review, diagnosis, investigation, planning, or research without edits.
- Resume never changes the stored security profile. An incompatible resume request fails and must not be retried with broader permissions.
- ACP runs in a private Grok home with a plugin-owned agent profile. Read-only work exposes only read, list, and grep tools; write work exposes only the documented workspace implementation tools. Web, MCP, external extension, subagent, memory, LSP, image, and user-interaction capabilities are disabled.
- Never bypass the runtime's setup, model, effort, sandbox, or policy errors.

Argument safety:

- Remove routing flags from the natural-language task text and pass them as separate CLI arguments.
- Pass the remaining task as one shell-quoted argument.
- Escape quotes safely; never concatenate user text into executable shell syntax.
- Do not add a standalone `--` token.
- Do not use `eval`, command substitution, a generated script, or an intermediate file.

If invocation fails, return the runtime error and stop. Never perform a Claude-side fallback.
