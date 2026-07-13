# Changelog

## 0.2.0

- Added native Codex plugin packaging, a repository marketplace, and eight
  `$grok:*` workflow skills matching the Claude Code command surface.
- Added host-aware session ownership, state storage, background workers,
  recursion guards, resume selection, and Codex-specific follow-up guidance.
- Added Codex `SessionStart` transcript capture and the supported `Stop` review
  gate while making Claude explicitly load the shared hook file and its
  Claude Code-only `SessionEnd` cleanup file.
- Added privacy-filtered Codex transcript transfer. The converter keeps only
  user-visible user and assistant messages, excludes developer/system context,
  reasoning and tool traces, and passes the converted stream to `grok import`
  through a private anonymous descriptor.
- Added exact-size descriptor snapshots, secure converted-file disposal,
  fail-closed implicit job selection, visible non-secret SessionStart failures,
  cross-host skill discovery policy, and verdict/finding consistency checks.
- Codex has no documented `SessionEnd` event, so its background jobs remain
  recoverable until completion, explicit cancellation, or stale-worker cleanup.

## 0.1.0

- Implemented community release candidate; hosted cross-platform and publication gates remain open.
- Headless `explore` review, adversarial review, and optional stop review with
  isolated review homes and structured output validation.
- ACP v1 read-only and write-capable rescue tasks with contract-version-2,
  SHA-256 `agentProfileDigest`-bound `toolConfig` profiles and
  `injectDefaultTools: false`. Read exposes
  only `GrokBuild:read_file`, `GrokBuild:list_dir`, and `GrokBuild:grep`; write
  additionally exposes `GrokBuild:run_terminal_cmd`, `GrokBuild:search_replace`,
  `GrokBuild:todo_write`, `GrokBuild:kill_task`, and
  `GrokBuild:get_task_output`. Terminal configuration is
  `enabled_background: true`, `auto_background_on_timeout: false`, and
  `allow_background_operator: false`.
- Added isolated read/write homes, background jobs, resume, status, result,
  cancellation, and lifecycle hooks. Builtin capabilities and isolated
  provider-bundled skills rooted beneath `<isolated GROK_HOME>/skills/` or
  `<isolated GROK_HOME>/bundled/skills/` are allowed; external hooks, skills,
  plugins, MCP servers, and non-builtin agents are rejected.
- Required cached authentication created by `grok login`, rejected
  environment-key-only auth, automatically refreshed cached credentials near
  expiry, removed setup's transient isolated credential copy, and retained only
  sanitized mode-`0600` task-home copies with exact-value redaction.
- Claude transcript transfer through `grok import --json` with an advertised,
  model-qualified resume command, post-open device/inode binding for the directly
  inherited transcript descriptor, asynchronous timeout/cancellation, and no
  plugin-owned transcript copy.
- Added fail-closed active-provider recursion guards, verified process ownership,
  cancellation nonces, worker-crash recovery, verified whole-process-group
  TERM-to-KILL escalation, stop-hook crash recovery, and exact-value credential
  redaction. SessionEnd now verifies complete owned worker/provider groups before
  removing guards or state; unverifiable shutdown records `E_PROCESS_IDENTITY`
  and retains both for manual inspection. Stale recovery still uses
  `E_WORKER_LOST` only when provider cleanup is absent or verified.
- Passed the authenticated 10-case macOS 26.5 arm64 release matrix with Grok
  Build 0.2.99, Grok 4.5 at low effort, on July 13, 2026.
- Enforced Grok Build 0.2.99 compatibility floor for isolated ACP agent profiles.
  Authenticated provider qualification currently covers macOS with 0.2.99; Linux is
  provider-unverified and Windows provider execution/process control is
  unsupported in this release candidate.
