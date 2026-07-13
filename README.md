# Grok Companion for Claude Code and Codex

Grok Companion is a dual-host Claude Code and Codex plugin that delegates code review, investigation, and implementation work to the official Grok Build CLI. Its command contract is modeled on OpenAI's [`codex-plugin-cc` v1.0.6](https://github.com/openai/codex-plugin-cc/tree/db52e28f4d9ded852ab3942cea316258ae4ef346). Reviews use Grok's headless `explore` agent; resumable rescue tasks use ACP v1 over `grok agent stdio`.

Version `0.2.0` adds a native Codex plugin package, Codex command skills, host-scoped jobs, Codex lifecycle hooks, and privacy-filtered Codex transcript transfer. It remains an implemented community release candidate, not a generally supported stable release. The authenticated macOS release matrix passed 10/10 cases with Grok Build 0.2.99 on July 13, 2026; Linux remains provider-unverified and Windows provider execution is unsupported. Authenticate with `grok login`, then run `/grok:setup` in Claude Code or `$grok:setup` in Codex.

## Requirements

- Claude Code or Codex with plugin marketplace support.
- Node.js 18.18 or later.
- Git for repository review and workspace discovery.
- The official Grok Build CLI 0.2.99 or later. Version 0.2.99 is the enforced and authenticated compatibility floor for the isolated ACP agent-profile contract.
- A cached Grok login created by `grok login`. Environment-key-only authentication such as `XAI_API_KEY` is not supported for tool-using jobs in this release.

Install the official CLI with npm if it is not already present:

```bash
npm install -g @xai-official/grok
grok login
```

## Install the plugin

### Claude Code

In Claude Code:

```text
/plugin marketplace add xliberty2008x/grok-plugin
/plugin install grok@grok-companion
/reload-plugins
/grok:setup
```

To update a source checkout during development, reload or reinstall the plugin after pulling changes, then run `/grok:setup` again.

### Codex

From a local checkout, replace the example path with the checkout's absolute path:

```bash
codex plugin marketplace add /absolute/path/to/grok-plugin --json
codex plugin add grok@grok-companion --json
```

Start a new Codex task, open `/hooks`, review and trust the plugin hooks, then run `$grok:setup`. Codex installs a versioned snapshot, so update or reinstall the plugin after changing the source checkout.

## Commands

| Claude Code | Codex | Purpose |
|---|---|---|
| `/grok:setup` | `$grok:setup` | Check the CLI, version, cached authentication, required headless and isolated ACP flags, external-extension isolation, ACP session loading, advertised models/efforts, and review-gate setting. Provider-bundled skills rooted beneath either `<isolated GROK_HOME>/skills/` or `<isolated GROK_HOME>/bundled/skills/` are permitted; external hooks, skills, plugins, MCP servers, and non-builtin agents are rejected. This is not an authenticated review execution or platform qualification. |
| `/grok:review` | `$grok:review` | Run a schema-validated, read-only review of working-tree or branch changes. |
| `/grok:adversarial-review` | `$grok:adversarial-review` | Challenge the implementation direction, assumptions, tradeoffs, and failure modes. |
| `/grok:rescue` | `$grok:rescue` | Delegate a read-only investigation or write-capable implementation task. |
| `/grok:transfer` | `$grok:transfer` | Import the current host transcript into a resumable Grok session. |
| `/grok:status` | `$grok:status` | Show active and recent jobs, or wait for a specific job. |
| `/grok:result` | `$grok:result` | Return the complete stored result for a finished job. |
| `/grok:cancel` | `$grok:cancel` | Request cancellation of an active job. |

## Common workflows

The examples below use Claude Code syntax. In Codex, use the command from the Codex column above and keep the same arguments—for example, `$grok:review --wait`.

Run a small review in the foreground:

```text
/grok:review --wait
```

Review the current branch relative to a base in the background:

```text
/grok:review --background --base main --scope branch
/grok:status
/grok:result <job-id>
```

Challenge a design decision with explicit focus:

```text
/grok:adversarial-review --wait Focus on retry semantics and crash recovery
```

Delegate implementation work:

```text
/grok:rescue --wait Fix the failing session cleanup tests and verify the fix
```

Resume a compatible task session or force a new one:

```text
/grok:rescue --resume Continue from the previous result and apply the remaining fix
/grok:rescue --fresh Investigate this independently without prior session context
```

Manage a background task:

```text
/grok:status <job-id> --wait
/grok:result <job-id>
/grok:cancel <job-id>
```

Import the current host transcript:

```text
/grok:transfer
```

The command selects an available model and returns `grok --model <id> [--reasoning-effort <effort>] --resume <session-id>` when import succeeds. You may choose the model and effort explicitly with `/grok:transfer --model <id> --effort low|medium|high` or `$grok:transfer --model <id> --effort low|medium|high`.

Enable or disable the optional stop-time review gate per workspace:

```text
/grok:setup --enable-review-gate
/grok:setup --disable-review-gate
```

When the gate is disabled, active companion jobs produce a warning only. When it is enabled, the gate still warns about active jobs but proceeds directly to the stop review without waiting for them to finish.

## Execution and security model

- Every job runs in its own Grok process and receives a unique leader-socket path. The plugin does not use a shared Grok leader.
- Normal, adversarial, and stop-time reviews run through headless Grok with the `explore` agent, plugin-owned prompts, isolated review homes, and editing, shell, repository-read, web-search, MCP, and subagent tools disabled. Normal and adversarial reviews validate a JSON-Schema result. The runtime compares repository snapshots and fails a normal or adversarial review if it detects mutation.
- Rescue tasks run through ACP v1 over `grok agent stdio`, with checked-in Grok `toolConfig` profiles, `injectDefaultTools: false`, security-contract version 2, and a persisted SHA-256 `agentProfileDigest`; resume requires the same digest and security contract. Read-only exposes exactly `GrokBuild:read_file`, `GrokBuild:list_dir`, and `GrokBuild:grep`. Write exposes exactly `GrokBuild:run_terminal_cmd`, `GrokBuild:read_file`, `GrokBuild:list_dir`, `GrokBuild:grep`, `GrokBuild:search_replace`, `GrokBuild:todo_write`, `GrokBuild:kill_task`, and `GrokBuild:get_task_output`; terminal configuration is `enabled_background: true`, `auto_background_on_timeout: false`, and `allow_background_operator: false`, while the agent instruction forbids background commands. Root `--tools` flags are intentionally not used for ACP because Grok 0.2.99 documents them as headless-only.
- Review session data and a mode-`0600`, sanitized cached-access credential are written beneath an isolated per-review home in plugin state. The runtime automatically asks the normal CLI to refresh cached authentication that expires within 45 minutes before creating an isolated copy. Review homes—including the transient setup-probe credential copy—are removed after setup, normal completion, forced cancellation, or verified crash recovery; a cleanup failure is retained as a privacy warning. Rescue sessions and their atomically refreshed sanitized credential live in separate mode-private `rescue-read-v2` and `rescue-write-v2` task homes under plugin state. Environment-key-only authentication is unsupported. Imported sessions use Grok's normal store.
- Rescue implementation requests default to a write-capable `workspace` profile with unattended approval inside the Grok sandbox. Explicit review, diagnosis, planning, research, or other no-edit requests use an OS-level `read-only` sandbox plus a profile allowlist containing only `read_file`, `list_dir`, and `grep`; shell, edit, write, web, MCP, subagent, memory, LSP, image, and user-interaction tools are removed or denied.
- Grok may still maintain provider-owned session, cache, and temporary data under locations allowed by its sandbox, including the isolated task home and system temporary directories.
- Provider child processes receive a restricted environment rather than the host agent's complete environment. Isolation is checked before each task: builtin capabilities and provider-bundled skills whose real paths remain beneath either `<isolated GROK_HOME>/skills/` or `<isolated GROK_HOME>/bundled/skills/` are permitted, while external Grok, Claude, Cursor, and Codex hooks, skills, plugins, MCP servers, and non-builtin agents are rejected. Credentials are never written to plugin job records or raw user output; copied opaque credential values are registered as exact redaction sentinels in memory.
- Web-search and Grok subagent features are disabled by the current runtime profiles. Operating-system child-network enforcement still differs by platform; in particular, macOS may not enforce the same child-process network boundary as Linux.
- Managed Grok or enterprise policy remains authoritative. Denied operations fail instead of falling back to a broader profile.
- Child Grok processes are marked to prevent recursive companion invocation through either host. A private, workspace-scoped active-provider guard also fails closed when Grok's terminal runner strips those markers or breaks direct process ancestry.

Write-capable rescue is intentionally powerful. Review the task and repository before authorizing it, and use explicit read-only wording when no edits are wanted.

## Jobs, sessions, and local data

Plugin job metadata, redacted diagnostics, results, locks, transient import plumbing, isolated review homes, and the separate read/write rescue homes are partitioned by canonical workspace beneath the host's plugin-data directory:

- Claude Code: `CLAUDE_PLUGIN_DATA/state/<workspace-slug>-<workspace-hash>/`, with fallback `~/.claude/plugins/data/grok/state/`.
- Codex: `PLUGIN_DATA/state/<workspace-slug>-<workspace-hash>/`, with fallback `~/.codex/plugins/data/grok-grok-companion/state/`.

While a provider is active, the runtime also keeps a mode-private, non-secret guard beneath the operating system temporary directory. It contains only hashed ownership, a random job marker, and process identity—not prompts, results, repository paths, or credentials. Normal completion and verified crash recovery remove it only after the complete owned process groups are gone. Claude Code also performs scoped cleanup at `SessionEnd`; Codex currently has no equivalent plugin hook, so unfinished Codex jobs remain recoverable until they finish, are cancelled, or are recovered on the next command. If ownership or shutdown cannot be verified, the runtime records `E_PROCESS_IDENTITY` and retains the guard and job state for manual inspection.

To remove plugin-owned state, first cancel or wait for active jobs, close any host tasks using the plugin, and then remove the affected workspace directory beneath the applicable state root. This also deletes that workspace's resumable rescue sessions and isolated credential copies. After uninstalling the plugin and confirming that no Grok Companion job is active, the applicable fallback directory may be removed.

Imported transcript sessions remain in Grok's normal `~/.grok/sessions` store. Inspect them with `grok sessions list` and remove an unwanted imported session with `grok sessions delete <session-id>`. Rescue sessions are deliberately isolated under plugin state so user or repository hooks, plugins, skills, MCP servers, and configuration cannot enter the ACP process; provider-bundled skills are allowed only when their real paths remain beneath either `<isolated GROK_HOME>/skills/` or `<isolated GROK_HOME>/bundled/skills/`. Continue rescue sessions through `/grok:rescue --resume` or `$grok:rescue --resume`.

Background commands return a job ID immediately. Use the host's status, result, or cancel command with that ID rather than asking the host agent to reproduce Grok's work.

Transcript transfer accepts only a real `.jsonl` path in the active host's transcript root. Claude Code sources must be beneath `~/.claude/projects`; Codex sources must be beneath `${CODEX_HOME:-~/.codex}/sessions`. After canonical-path and no-follow validation, Claude transcripts pass through a short-lived descriptor alias. Codex rollouts are converted in memory to a minimal Claude-shaped stream containing only user-visible user and assistant messages; developer/system instructions, reasoning, tool calls, tool results, and other internal records are excluded. The filtered bytes are written to an immediately unlinked mode-`0600` file descriptor and are never stored in plugin job state. Unsupported or ambiguous Codex rollout formats fail closed. Import runs asynchronously with bounded output, timeout/cancellation handling, and verified whole-process-group shutdown.

## Data boundary

The CLI runs locally, but model requests are processed through Grok/xAI services. Task prompts, review context collected by the plugin, repository content selected by Grok task tools, command output, imported Claude context, and the user-visible subset of imported Codex context may be processed under the user's Grok account, organization policy, and applicable xAI terms. Do not delegate material that should not cross that boundary.

## Current limitations

- Grok exposes no documented native review RPC equivalent to the pinned Codex reviewer, so both review commands use plugin-owned prompts and a validated JSON result schema.
- Reviews are context-only in this release candidate. The plugin embeds the selected branch diff or complete staged, unstaged, and untracked working-tree evidence up to an 8 MiB prompt limit; an oversized target fails explicitly instead of silently omitting diffs. Individual untracked text files above 1 MiB also fail explicitly, while binary files are represented by size and full SHA-256.
- The optional stop gate receives the previous host-assistant message plus the same plugin-collected current Git evidence and verifies that Grok did not mutate the repository during the check. It remains advisory because it cannot cryptographically attribute current changes to one historical host turn; use the host's foreground review command for the full structured verdict.
- Version 0.2.99 is the compatibility floor because it advertises the `--agent-profile`, `--no-leader`, and isolated leader-socket features used to make ACP tool restrictions enforceable. Newer versions remain capability-probed at setup.
- macOS passed the authenticated 10-case release matrix with Grok Build 0.2.99 on July 13, 2026; the non-secret result is recorded in `tests/e2e-results/`. Linux provider execution remains authenticated-provider-unverified. Windows runs provider-neutral CI only: Grok provider execution and process ownership/control are unsupported and must not be treated as release-qualified in 0.2.0.
- `/grok:setup` and `$grok:setup` check cached authentication, required headless flags, isolated extension loading, and ACP capabilities. Their transient isolated credential copy is removed when the probe finishes. Provider-bundled skills inside the isolated home are allowed, but external extensions are rejected. Setup does not spend model quota to execute a review or prove that operating-system process controls and write confinement are release-qualified.
- Codex default hooks require explicit trust in `/hooks`. Until the `SessionStart` hook runs in a new task, `$grok:transfer` requires an explicit validated source path. Codex exposes no `SessionEnd` plugin event, so Codex background cleanup is command-driven rather than task-close-driven.
- `grok import --json` is parsed defensively because its public NDJSON result shape is not yet a stable plugin contract.
- Reviews and write tasks rely on Grok's platform sandbox. Platform-specific restrictions are not treated as identical; in particular, macOS does not enforce Grok's Linux child-network boundary.
- The plugin does not call the xAI REST API directly and never falls back to Claude to complete a failed Grok task.

## Development

```bash
npm test
npm run validate
npm run check
```

The [technical specification](SPEC.md) defines required behavior and safety invariants. The [implementation plan](PLAN.md) records the staged gates and release criteria. Upstream provenance and modifications are recorded in [UPSTREAM.md](UPSTREAM.md).

## Attribution and license

This is an independent community project and is not affiliated with, endorsed by, or sponsored by OpenAI or xAI. It adapts Apache-2.0-licensed portions of OpenAI's reference plugin while retaining the required attribution and modification notices.

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
