---
name: grok-cli-runtime
description: Internal contract for invoking the Grok Companion runtime from the grok-rescue subagent
user-invocable: false
---

<!-- Adapted and modified from openai/codex-plugin-cc v1.0.6 (Apache-2.0). -->

# Grok Companion Runtime

Use this skill only inside `grok:grok-rescue`.

Primary start invocation:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" task --background --envelope-file <private-path> [routing flags] [--write]
```

The rescue subagent is a bounded control-plane adapter:

- Make exactly one `task` start invocation, then follow the returned job ID with `status` and `result`.
- Never invoke Grok directly; use only runtime `task`, `status`, `result`, `record-verification`, and user-authorized `cancel` for this workflow.
- Preflight the repository and create the TaskEnvelope before dispatch. Whole-project context requires a HEAD verified through the configured remote or connected repository, not merely a local tracking ref; task-scoped context requires every needed path and marker to be present.
- Monitor only the exact returned job; never select an implicit latest job or start a duplicate.
- Integrate the structured result and run independent host verification. Record at least one declared command/status/exit-code outcome through bounded stdin with the one-shot `record-verification <job-id> --verification-stdin`; never pass command output. Treat the resulting scope-checked checkpoint as `host_asserted`, not as proof of command-to-diff causality.
- A failed recorded host check may be returned through one explicit `--job-id` continuation at a time, using the same profile and a concise redacted failure excerpt; each continuation is monitored and verified as its own persistent job in the same logical lineage.

Routing flags:

- `--background`: required for native-like start/handle semantics.
- `--job-id <id>`: explicitly continue a prior same-host task; it implies resume.
- `--fresh`: force a new Grok session.
- `--model <id>`: pass only when explicitly requested.
- `--effort low|medium|high`: pass only when explicitly requested.
- `--write`: select the workspace-write rescue profile.

Security-profile rules:

- Add `--write` by default for implementation or explicit fix requests.
- Omit `--write` for explicit read-only work and for review, diagnosis, investigation, planning, or research without edits.
- Resume never changes the stored security profile. An incompatible resume request fails and must not be retried with broader permissions.
- ACP runs in a private per-lineage Grok home with a plugin-owned agent profile. Read-only work exposes only read, list, and grep tools; write work exposes only read, list, grep, search/replace, and todo tools. Terminal commands are deliberately unavailable and all required command verification is host-owned. Web, MCP, external extension, subagent, memory, LSP, image, and user-interaction capabilities are disabled.
- Never bypass the runtime's setup, model, effort, sandbox, or policy errors.

Envelope and argument safety:

- Put the literal request and structured contract in a mode-0600 temporary file beneath `${CLAUDE_PLUGIN_DATA}`. Create the path separately, write JSON with the Write tool, and pass only the path through `--envelope-file`; the runtime deletes it after a no-follow read.
- Never include task/envelope content in Bash text, process argv, environment variables, filenames, or logs.
- Keep routing flags as separate literal arguments. `mode: write` must exactly match `--write`.
- Do not use `eval`, command substitution on user content, or a file outside the private plugin-data root.

If start/follow/result fails, return the runtime error and stop the Grok path. Apply only an explicitly authorized higher-level fallback policy.
