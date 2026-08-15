# Grok Companion for Claude Code and Codex

Grok Companion is a dual-host marketplace plugin that delegates code review, investigation, and implementation work from **Claude Code** or **OpenAI Codex** to the locally installed [official Grok Build CLI](https://docs.x.ai/build/overview). Host facades never solve the task themselves: they forward to a shared Node runtime that owns job identity, isolation policy, durable evidence, and Grok process lifecycle. For the issue #25 write-worker path, official Grok ACP executes worktree mechanics while the broker independently binds and verifies them.

| | |
|---|---|
| **Version** | `0.3.0-dev.9` |
| **Status** | Development hardening prerelease; unqualified and not release-ready or stable |
| **Repository** | `xliberty2008x/grok-plugin` |
| **Marketplace name** | `grok-companion` |
| **Plugin name** | `grok` |
| **Claude namespace** | `/grok:*` slash commands |
| **Codex namespace** | `$grok:*` skills |
| **Grok CLI admission** | Stable Grok Build **0.2.99+**, with no upper version allowlist; Worker Broker operational qualification remains exact-version evidence for **0.2.112** |
| **License** | Apache-2.0 |

Command shape is modeled on OpenAI's [`codex-plugin-cc` v1.0.6](https://github.com/openai/codex-plugin-cc/tree/db52e28f4d9ded852ab3942cea316258ae4ef346). Reviews use headless Grok with the `explore` agent; resumable rescue tasks use ACP v1 over `grok agent stdio`; transcript import uses `grok import --json`.

**Qualification status:** the historical July 13 profile-v2 matrix does not qualify the current v3 hardening worktree. Separately, issue [#25](https://github.com/xliberty2008x/grok-plugin/issues/25) reached `operational_e2e_complete` on exact source `e89272f` and evidence head `ef2dd03`. The proof used official Grok Build 0.2.112 for completion, active cancellation/restart, and simultaneous isolated writers with drift rejection; it also includes a natural installed-Codex invocation, strict receipt replay, cleanup/absence checks, independent review, and hosted CI run [30225725682](https://github.com/xliberty2008x/grok-plugin/actions/runs/30225725682). Deterministic tests are supporting evidence, not a substitute for those live lifecycles. This qualification is scoped to the documented macOS/Codex path: the dual-host prerelease remains release-unqualified until independent Claude Code and remaining platform gates pass, and Windows provider execution/process control remain unsupported.

### Worker Broker delivery in numbers

These figures describe the issue #25 implementation tranche from `main` through evidence head `ef2dd03`. Runtime and token provenance is recorded in the [post-closeout delivery accounting comment](https://github.com/xliberty2008x/grok-plugin/issues/25#issuecomment-5087869339).

| Measure | Recorded value |
|---|---:|
| Calendar window | 2026-07-15 17:38 to 2026-07-27 02:10 (11 days, 8 hours, 31 minutes) |
| Tracked active execution | 57 hours, 6 minutes, 23 seconds |
| Codex goal accounting | 25,626,812 model tokens |
| Git history | 172 commits |
| Diff against `main` | 160 files; 137,166 insertions; 916 deletions |
| Hosted deterministic gates | 1,027 tests in each of 4 full Unix lanes, plus 2 Windows and 2 PTY lanes |
| Live lifecycle jobs | 4 official-provider jobs plus 1 natural installed-Codex job |

The diff totals include generated schemas, fixtures, receipts, and other evidence artifacts; they are not a hand-written source-line estimate.

This metrics update is post-qualification documentation and is not part of the exact `e89272f`/`ef2dd03` evidence identity. It changes no plugin/runtime bytes and does not requalify the documentation head; the scoped operational claim remains bound to the exact source and receipt above.

> **External processing:** The CLI runs locally, but model requests are processed through Grok/xAI services. Task prompts, review context collected by the plugin, repository content selected by Grok task tools, command output, imported Claude context, and the user-visible subset of imported Codex context may be processed under your Grok account, organization policy, and applicable xAI terms. Do not delegate material that should not cross that boundary. See [Data boundary](#data-boundary) and [Security model](#execution-and-security-model).

---

## Table of contents

1. [What this project does](#what-this-project-does)
2. [Architecture](#architecture)
3. [Prerequisites](#prerequisites)
4. [Install Grok Build and authenticate](#install-grok-build-and-authenticate)
5. [Install the plugin](#install-the-plugin)
6. [Safe smoke test](#safe-smoke-test)
7. [Commands and skills](#commands-and-skills)
8. [Common workflows](#common-workflows)
9. [Jobs, sessions, and local data](#jobs-sessions-and-local-data)
10. [Execution and security model](#execution-and-security-model)
11. [Data boundary](#data-boundary)
12. [Troubleshooting](#troubleshooting)
13. [Development and tests](#development-and-tests)
14. [Repository layout](#repository-layout)
15. [Current limitations](#current-limitations)
16. [Attribution and license](#attribution-and-license)

---

## What this project does

Use Grok Companion when you want either host to:

- Run **read-only, schema-validated** reviews of working-tree or branch changes.
- Run an **adversarial** design challenge against the same Git evidence.
- **Delegate investigation or implementation** to an isolated Grok ACP session (foreground or background).
- Run **first-class Grok `/deep-research`** (background + public-web defaults, optional read-only workspace snapshot).
- **Resume**, **status-check**, **fetch results for**, or **cancel** companion jobs.
- **Import** the current host transcript into a resumable Grok session (Claude as-is; Codex privacy-filtered).
- Optionally gate host stop with a **stop-time review** (disabled by default).

It does **not**:

- Call the xAI REST API directly.
- Fall back to Claude or Codex to finish a failed Grok task.
- Support environment-key-only auth such as `XAI_API_KEY` for tool-using jobs.
- Claim affiliation with or endorsement by OpenAI or xAI.

---

## Architecture

```text
Claude Code  /grok:*  ──┐
                        ├──► host facade ──► grok-companion runtime ──► job store
Codex        $grok:*  ──┘                              │
                                                       ├── headless explore (reviews)
                                                       ├── ACP v1 stdio (rescue tasks)
                                                       ├── ACP v1 stdio (deep-research workflow)
                                                       └── grok import (transfer)
SessionStart / Stop hooks ─────────────────────────────┘
Claude SessionEnd (cleanup) ───────────────────────────┘
```

| Layer | Role |
|---|---|
| Claude slash commands (`plugins/grok/commands/`) | Forward to `grok-companion.mjs`; review/result/status/cancel/transfer keep stdout verbatim |
| Claude `grok:grok-rescue` subagent | Host control plane: preflight, TaskEnvelope, persistent start, exact-job status/result, host checks, and verification record |
| Codex skills (`plugins/grok/skills/*/`) | Same control plane using a reader-ready, no-echo PTY frame for private TaskEnvelope and verification input |
| Shared runtime | `TaskEnvelope`/`ContextManifest` validation, admission, jobs, lifecycle, redaction, cancellation, scoped continuation, and verification reconciliation |
| Grok provider adapter | Binary discovery, headless review, ACP lifecycle, auth probe, isolation |
| Hooks | Shared `SessionStart` + `Stop`; Claude-only `SessionEnd` |

**Host packaging (verified manifests):**

| Host | Marketplace manifest | Plugin manifest | Install model in-tree |
|---|---|---|---|
| Claude Code | [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json) | [`plugins/grok/.claude-plugin/plugin.json`](plugins/grok/.claude-plugin/plugin.json) | Marketplace `grok-companion`, plugin source `./plugins/grok`; documented install via GitHub marketplace add |
| Codex | [`.agents/plugins/marketplace.json`](.agents/plugins/marketplace.json) | [`plugins/grok/.codex-plugin/plugin.json`](plugins/grok/.codex-plugin/plugin.json) | Marketplace `grok-companion` with **local** source `./plugins/grok` (`installation: AVAILABLE`, `authentication: ON_INSTALL`) |

Codex packaging in this repository is a **local marketplace / local plugin** contract. The documented Codex install path is from a checkout absolute path, not a remote GitHub marketplace string. Claude's documented path uses `/plugin marketplace add xliberty2008x/grok-plugin` followed by `/plugin install grok@grok-companion`.

---

## Prerequisites

Install and confirm these on a fresh machine before the plugin:

| Requirement | Notes |
|---|---|
| **Claude Code** or **Codex** | Host with marketplace/plugin support |
| **Node.js ≥ 18.18** | Declared in `package.json` `engines` |
| **Git** | Required for review targets and workspace discovery |
| **Official Grok Build CLI ≥ 0.2.99** | Package `@xai-official/grok`; floor enforced because 0.2.99 advertises isolated ACP `--agent-profile`, `agent --no-leader`, and `--leader-socket` |
| **Cached Grok login** | Created by `grok login`. Environment-key-only auth (`XAI_API_KEY`, etc.) is not supported for tool-using jobs |
| **npm** | Optional; used only when you explicitly approve CLI installation |

Grok binary discovery order:

1. `GROK_BIN` when set
2. `grok` on `PATH`
3. Documented per-user location such as `~/.grok/bin/grok`

The static release table is recognition evidence, not a version ceiling. Exact
bytes that match a recorded release use the stronger `known-digest` path.
Unfamiliar stable versions are admitted only when they are the active
Grok-managed target selected by `$GROK_HOME/bin/grok` and its bounded
`cli.installer` layout. Setup copies that candidate into the plugin's private
immutable pin, rehashes it, and runs every version, authentication, isolation,
ACP, session-loading, and capability probe against the private copy. An
arbitrary unfamiliar `GROK_BIN` or `PATH` executable is rejected with
`E_GROK_SOURCE`.

`managed-observed` intentionally accepts the supply-chain risk of the initial
managed installation. It proves which exact bytes setup observed and pinned; it
does **not** prove that xAI issued those initial bytes. Replacement or drift
after setup still invalidates the pin and its capability receipt.

Provider qualification reminder: current Worker Broker evidence qualifies the exact v3 macOS/Codex path with official Grok Build 0.2.112. The dual-host prerelease remains release-unqualified; this evidence does not qualify Linux provider execution, independent Claude Code orchestration, or Windows provider execution/process control.

---

## Install Grok Build and authenticate

From a shell (any supported host OS where you intend to run the CLI):

```bash
# 1. Node check
node -v   # must report v18.18.0 or newer

# 2. Install the official Grok Build CLI
npm install -g @xai-official/grok

# 3. Confirm the binary and version floor
grok --version   # must be 0.2.99 or newer

# 4. Create a cached login (interactive; not environment-key-only)
grok login
```

Notes:

- Do not rely on `XAI_API_KEY` alone for companion tool-using jobs.
- Cached credentials that expire within **45 minutes** are refreshed through the normal CLI before the plugin creates an isolated copy.
- The Claude setup command may offer `npm install -g @xai-official/grok` once if Grok is missing and npm is available. The Codex setup skill does **not** install Grok; install the CLI yourself first.
- A curl installer may exist in official Grok documentation as a **manual** alternative; the plugin must not run it automatically.

---

## Install the plugin

### Claude Code (marketplace)

In Claude Code, from a session that can manage plugins:

```text
/plugin marketplace add xliberty2008x/grok-plugin
/plugin install grok@grok-companion
/reload-plugins
/grok:setup
```

Expected outcome of `/grok:setup`: a readiness report (CLI path/version, auth, headless/ACP flags, isolation probe, models/efforts, stop-gate setting). `ready: true` means prerequisites for companion work look satisfied; it is **not** a full platform or authenticated-review certification.

To work from a local clone during development, install or reload from your checkout after pulling, then run `/grok:setup` again. Exact Claude local-path marketplace syntax is host-dependent; the repository's Claude marketplace source is always `./plugins/grok`.

### Codex (local marketplace from a checkout)

Codex packaging uses a **local** marketplace source. From a fresh environment:

```bash
# 1. Clone this repository
git clone https://github.com/xliberty2008x/grok-plugin.git
cd grok-plugin

# 2. Register this clone as the local marketplace
codex plugin marketplace add "$(pwd -P)" --json

# 3. Install the plugin from that marketplace
codex plugin add grok@grok-companion --json
```

Then in Codex:

1. Start a **new** task so `SessionStart` can run.
2. Open `/hooks`, review the Grok Companion hooks, and **trust** them (default hooks require explicit trust).
3. Run:

```text
$grok:setup
```

Codex installs a **versioned snapshot**. After you change the source checkout, update or reinstall the plugin, then run `$grok:setup` again.

In managed Codex, `$grok:setup` asks for approval before starting one exact
setup command. Approval gives that command one-time, command-scoped
unsandboxed execution so the installed wrapper can reach Grok Companion's
user-owned private plugin data outside the workspace. The host API does not
provide a literal exact-path writable grant, so this approval is deliberately
not described as one. The skill does not create a reusable `prefix_rule`, uses
neither login/interactive shell semantics nor PTY framing, does not make a
failing sandboxed probe first, and does not extend this approval to status,
task, review, provider, retry, or verification commands. If approval is denied
or unavailable, no setup or provider process starts.

### What setup checks

Both `/grok:setup` and `$grok:setup` probe:

- Grok executable source, exact-byte identity, and stable version (≥ 0.2.99,
  with no upper allowlist)
- Cached authentication (no credential printing)
- Required headless review flags
- ACP `--agent-profile` / `--no-leader` / leader-socket support
- Isolated `grok inspect --json` (builtin + provider-bundled skills under `<isolated GROK_HOME>/skills/` or `<isolated GROK_HOME>/bundled/skills/` allowed; external hooks/skills/plugins/MCP/non-builtin agents rejected)
- Session-loading and model/effort menus used by rescue/transfer
- Per-workspace stop-review-gate config

Successful JSON output includes `grok.releaseRecognition` as `known-digest` or
`managed-observed`. `ready: true` means the exact private pinned binary passed
the current readiness probes. It does not transfer qualification from 0.2.112
to another version or prove a complete provider lifecycle.

Setup may create a transient mode-`0600` sanitized credential copy inside a private review home and **removes** that home when the probe finishes. It does not spend model quota on a real review or prove OS process-control release qualification.

Enable or disable the optional stop-time review gate per workspace:

```text
# Claude Code
/grok:setup --enable-review-gate
/grok:setup --disable-review-gate

# Codex
$grok:setup --enable-review-gate
$grok:setup --disable-review-gate
```

When the gate is **disabled** (default), active companion jobs produce a warning only. When **enabled**, the gate still warns about active jobs but proceeds to the stop review without waiting for them; it is advisory (see [Current limitations](#current-limitations)).

---

## Safe smoke test

Use a disposable Git repository so the smoke test invokes a real **read-only** review and its immutability is easy to verify. In a terminal:

```bash
SMOKE_DIR="$(mktemp -d)"
cd "$SMOKE_DIR"
git init
printf 'export const answer = 41;\n' > answer.js
BEFORE="$(git hash-object answer.js)"
git status --short
```

The status command should print `?? answer.js`. Start the host in that directory, then run the matching setup and review commands. The review sends the untracked file and review prompt to Grok/xAI and consumes Grok quota.

### Claude Code

```text
/grok:setup
/grok:review --wait
```

### Codex

```text
$grok:setup
$grok:review --wait
```

Interpretation:

| Result | Meaning |
|---|---|
| Setup reports ready | CLI, auth cache, isolation, and ACP probes succeeded for this machine |
| Review returns a structured verdict | Read-only headless review completed; repository must remain unchanged |
| Auth / version / isolation error | Fix with `grok login`, upgrade Grok Build, or remove external Grok extensions from the isolated path, then re-run setup |

Back in the original terminal, prove the review left the fixture untouched:

```bash
test "$BEFORE" = "$(git hash-object answer.js)"
test "$(git status --short)" = "?? answer.js"
```

If you instead review a clean repository, an empty target returns a successful no-reviewable-changes result without invoking Grok.

Optional background lifecycle smoke (still review-only):

```text
# Claude
/grok:review --background --scope working-tree
/grok:status
/grok:result <job-id>

# Codex
$grok:review --background --scope working-tree
$grok:status
$grok:result <job-id>
```

To exercise the write route, remain in the disposable repository and optionally run one of:

```text
# Claude
/grok:rescue --fresh Create grok-smoke.txt containing exactly: Grok companion smoke test

# Codex
Use $grok:rescue with a fresh write task to create grok-smoke.txt containing exactly: Grok companion smoke test
```

Then verify `test "$(cat grok-smoke.txt)" = "Grok companion smoke test"`. Do **not** use a write-capable rescue as a smoke test in a shared or valuable repository.

---

## Commands and skills

Claude uses **slash commands**. Codex uses **skills** with the `$grok:` namespace. Arguments are the same public flags unless noted. Internal runtime `--json` is for facades/tests and is **not** public host syntax.

| Claude Code | Codex | Purpose | Public syntax |
|---|---|---|---|
| `/grok:setup` | `$grok:setup` | Readiness + optional stop-gate toggle | `[--enable-review-gate\|--disable-review-gate]` |
| `/grok:review` | `$grok:review` | Read-only defect-oriented review | `[--wait\|--background] [--base <ref>] [--scope auto\|working-tree\|branch]` |
| `/grok:adversarial-review` | `$grok:adversarial-review` | Read-only design challenge | `[--wait\|--background] [--base <ref>] [--scope auto\|working-tree\|branch] [focus ...]` |
| `/grok:rescue` | `$grok:rescue` | Native-like persistent worker workflow | `[--job-id <prior-id>\|--fresh] [--model <id>] [--effort low\|medium\|high] [task ...]` |
| `/grok:deep-research` | `$grok:deep-research` | First-class Grok `/deep-research` (public web by default) | `[--wait\|--background] [--web-only\|--workspace] [--model <id>] [--effort low\|medium\|high]` + private query stdin |
| `/grok:transfer` | `$grok:transfer` | Import host transcript into Grok | `[--source <jsonl>] [--model <id>] [--effort low\|medium\|high]` |
| `/grok:status` | `$grok:status` | List or wait on jobs; pure preflight with `--readonly` | `[job-id] [--wait] [--timeout-ms <ms>] [--all] [--readonly] [--json]` |
| `/grok:result` | `$grok:result` | Full stored result for a finished job | `[job-id]` |
| `/grok:cancel` | `$grok:cancel` | Cancel an active job | `[job-id]` |

### Host differences that matter

| Topic | Claude Code | Codex |
|---|---|---|
| Invocation | `/grok:name` | `$grok:name` |
| Rescue path | `grok:grok-rescue` owns TaskEnvelope preflight, start/status/result, host checks, and `record-verification` | Skill owns the same workflow and sends private frames only after `GROK_COMPANION_STDIN_READY` |
| Missing Grok binary | Setup may offer `npm install -g @xai-official/grok` once | Setup never installs; install the CLI yourself |
| Review without `--wait`/`--background` | Command may ask wait vs background based on change size | Runtime default is foreground when flags are omitted |
| Continuation | Requires an explicit prior `--job-id`; the control plane never guesses the latest job | Same explicit prior-ID rule; the prior job must belong to this Codex task |
| Write vs read rescue | Subagent defaults to write (`--write`) unless the request is explicitly read-only / review / diagnosis / planning / research without edits | Skill adds `--write` for implementation/fix requests; omits it for explicit read-only investigation-style work |
| Transfer source root | Real `.jsonl` under `~/.claude/projects` | Real `.jsonl` under `${CODEX_HOME:-~/.codex}/sessions` |
| Transfer privacy | Claude JSONL passed via validated fd (no plugin-owned copy) | Codex rollout reduced to user-visible user/assistant messages only |
| SessionEnd cleanup | Claude-only hook cancels/cleans jobs for that Claude session when process groups verify | No SessionEnd; jobs remain until completion, cancel, or stale recovery on a later command |
| Hooks trust | Per Claude Code plugin model | Default hooks need explicit trust in `/hooks` |
| Implicit transfer source | SessionStart exports transcript path into the environment | Until SessionStart runs in a new task, `$grok:transfer` needs an explicit validated `--source` |

Internal helper skills (`grok-cli-runtime`, `grok-prompting`, `grok-result-handling`) support the host control plane and are not user workflows.

### Deep-research data and verification boundaries

- Defaults are **background** and **web-only** (empty private cwd, public web only). Explicit `--workspace` mounts a temporary **tracked-files-only read-only snapshot**; untracked/ignored files, symlinks, and `.git`/`.grok`/`.agents`/`.claude`/`.cursor`/`.codex` are excluded. The real checkout is never mutated.
- Query text is private stdin only (max 32 KiB, no NUL). It is not placed on argv.
- Capability gating happens **after** session creation from session-scoped command advertisement (`available_commands_update` or `x.ai/commands/list`) plus workflow capability; missing `/deep-research` fails `E_CAPABILITY` and never sends the slash.
- Upstream prompt text is exactly `/deep-research <query>` (companion wrapper flags are not forwarded).
- Progress is workflow-bound under the bound ACP session (`sessions/<percent-encoded-provider-cwd>/<session-id>/workflows/<run-id>/...`); session/prompt completion is launch acknowledgement only.
- `--background` returns after a detached owned research worker is recorded; `--wait` emits bounded phase changes while polling the durable job.
- Report status `verified` or `partial` is **provider-side only**. Companion `hostVerification` remains `not_run`. There is no automatic resume/replay after pause, budget limits, failure, interruption, timeout, or crash.
- WebFetch requires independent `allow_local=false` attestation. It is disabled in the current profile, with explicit reduced coverage, because that proof is not yet available. Unexpected ACP permission requests fail closed (`E_SECURITY_PROFILE`).
- Deep-research is **not** arbitrary Grok plugin execution and does not use TaskEnvelope, mailbox, report repair, or rescue resume.
- Runtime support is capability-gated rather than version-gated. The local stable Grok 0.2.112 probe used during this implementation did not advertise `deep-research` or `workflow` in an isolated ACP session, so the real completion/cancellation/crash verticals remain unqualified on that build even though deterministic and fake-ACP lifecycle tests pass.

---

## Common workflows

Examples below use Claude syntax. On Codex, switch the prefix to `$grok:` and keep the same arguments (for example `$grok:review --wait`).

### Background public-web deep research

```text
/grok:deep-research
```

Supply the query through the skill/command private-stdin contract. Defaults are background + web-only. Optional flags: `--wait`, `--workspace`, `--model`, `--effort`.

### Foreground review

```text
/grok:review --wait
```

Branch review against a base:

```text
/grok:review --wait --base main --scope branch
```

Scope rules (shared by both review commands):

- `--scope working-tree` — staged, unstaged, and untracked changes
- `--scope branch` — branch comparison (merge-base with `HEAD`)
- `--scope auto` — working tree when dirty, otherwise branch
- `--base <ref>` — forces branch review against that ref
- Empty target → successful "no reviewable changes" without calling Grok
- Context is inlined up to **8 MiB**; individual untracked text files over **1 MiB** fail with `E_REVIEW_TOO_LARGE`

### Adversarial review with focus

```text
/grok:adversarial-review --wait Focus on retry semantics and crash recovery
```

Normal `/grok:review` does **not** accept custom focus text; use adversarial review for that.

### Background review lifecycle

```text
/grok:review --background --base main --scope branch
/grok:status
/grok:status <job-id> --wait
/grok:result <job-id>
/grok:cancel <job-id>
```

- Background returns a job ID immediately; the runtime detaches its own worker (do not create a second host background task).
- Without a job ID, `status` shows a compact table for the **current host session** in this repository; `--all` includes all host sessions in the repository.
- **Default `status`** may recover lost workers and migrate late legacy state. Use it for normal monitoring after dispatch.
- **`status --readonly`** is a pure preflight/read path: no recovery, migration, mkdir, chmod, lock, clean, or marker publication. `status --readonly` is neither a capability check nor a writability check. Rescue preflight MUST use `status --all --readonly --json`, which returns `{ "jobs": [...], "migrationRequired": boolean }`. Do not combine `--readonly` with `--wait` or `--timeout-ms`.
- `--wait` on status requires an explicit job ID and is recovery status only. Default wait timeout is **240000 ms**; maximum requested timeout is **900000 ms**.
- Without a job ID, `result` selects the newest finished job for the exact current host session; `cancel` selects the newest active job in that session.
- Explicit job IDs remain scoped to the exact host task that created them; another task cannot use an ID to read, cancel, verify, or continue that job.
- Unwritable workspace control state (EPERM/EACCES/EROFS during state initialization/repair, migration, durable lock, or atomic admission write) surfaces as **`E_STORAGE_READONLY`** (prerequisite) before worker/provider launch, not generic `E_STATE`.
- Codex task admission keeps a **fail-closed pre-launch provider capability receipt gate**. A missing or invalid setup-owned receipt fails closed as **`E_CAPABILITY`** with message `Valid provider capability receipt is missing or invalid; run $grok:setup before admitting a Codex task.` The rescue control plane may request one-time, command-scoped unsandboxed execution for authoritative `$grok:setup` **once** for that exact message only, then retry the **identical** task **once** on setup success. It never creates a persistent approval rule or escalates the task retry. Approval denial starts no setup/provider process and stops; setup failure is surfaced unchanged and stops; `E_STORAGE_READONLY` or a persistent receipt error after the one retry, or any other `E_CAPABILITY`, remains terminal and fallback-eligible. The runtime receipt gate itself is not weakened.

### Rescue (investigation vs implementation)

Implementation (write-capable by default on Claude; add explicit implementation wording on Codex):

```text
/grok:rescue Fix the failing session cleanup tests and verify the fix
```

Explicit read-only investigation:

```text
/grok:rescue Read-only: diagnose why the stop gate times out; do not edit files
```

The control plane always starts one persistent background runtime job, captures its ID, monitors that exact job, retrieves the result, runs host checks, and records command/status/exit-code verification before reporting. If the host task is interrupted, use the returned ID in that same task:

```text
/grok:status <job-id> --wait
/grok:result <job-id>
```

### Resume and fresh sessions

```text
/grok:rescue --job-id <prior-job-id> Continue from the previous result and apply the remaining fix
/grok:rescue --fresh Investigate this independently without prior session context
```

Resume rules:

- `--job-id` and `--fresh` are mutually exclusive.
- Continuation requires a finished task with a stored Grok session ID in the same workspace, host kind, exact host task, security profile, and verified completion/context state.
- An incompatible profile (for example write after a read-only session) fails; use `--fresh` rather than widening permissions.
- Missing or ineligible explicit jobs fail with `E_JOB_NOT_FOUND`, `E_JOB_ACTIVE`, `E_CONTEXT_DRIFT`, or `E_NO_RESUME_CANDIDATE`; no implicit newest job is selected by the host workflow.

Optional model/effort (must be advertised by Grok; no silent substitution):

```text
/grok:rescue --model <id> --effort low|medium|high <task>
```

### Transcript transfer

```text
/grok:transfer
/grok:transfer --model <id> --effort medium
/grok:transfer --source /absolute/path/to/allowed.jsonl
```

On success the runtime returns an imported Grok session ID and a model-qualified resume command of the form:

```text
grok --model <id> [--reasoning-effort <effort>] --resume <session-id>
```

Grok Build 0.2.99 can import Claude transcripts under a legacy placeholder model; resuming without an available explicit model may return empty results—prefer the returned model-qualified command.

### Stop-time review gate

```text
/grok:setup --enable-review-gate
```

The gate receives the previous host-assistant message plus plugin-collected current Git evidence, detects mutation during the check, and remains advisory because it cannot cryptographically attribute current changes to one historical host turn. Prefer `/grok:review --wait` for a full structured verdict.

---

## Jobs, sessions, and local data

### Plugin state roots

State is partitioned by canonical workspace under the host plugin-data root:

1. Explicit `GROK_COMPANION_PLUGIN_DATA`, else
2. Codex `PLUGIN_DATA` or Claude `CLAUDE_PLUGIN_DATA`, else
3. Host fallback:
   - Claude Code: `~/.claude/plugins/data/grok/`
   - Codex: `~/.codex/plugins/data/grok-grok-companion/` (respects `CODEX_HOME`)

Workspace layout:

```text
state/<workspace-slug>-<workspace-hash>/
├── config.json
├── jobs/
│   ├── <job-id>.json
│   ├── <job-id>.log
│   └── <job-id>.cancel
├── locks/
├── review-homes/          # ephemeral headless review homes
├── task-homes/
│   └── <lineage-job-id>/  # per-lineage v3 ACP home; auth is transient
├── imports/               # transient import plumbing only
└── leader-*.sock          # per-job leader sockets
```

Job IDs use prefixes `review-`, `adversarial-review-`, `task-`, or `stop-review-`. At most **50** jobs are retained per workspace; active jobs are never removed by retention.

While a provider is active, a mode-private non-secret guard may live under the OS temporary directory (hashed ownership + random job marker + process identity only—never prompts, results, paths, or credentials).

Codex `SessionStart` also writes mode-private metadata under `PLUGIN_DATA/host-sessions/` (host kind, session ID, validated transcript path, timestamp—not transcript content).

### Three different session stores

| Store | Contents | How to continue / remove |
|---|---|---|
| Ephemeral review homes under plugin state | Headless normal/adversarial/stop reviews | Removed after completion, cancel, or verified crash recovery; no user resume contract |
| Isolated rescue homes under plugin state | Per-lineage ACP state; a digest-pinned agent profile is staged only for each provider process, and cached auth is removed before the prompt | Continue with explicit `/grok:rescue --job-id <id>` or `$grok:rescue` plus the prior ID; remove by deleting that workspace plugin state after jobs stop |
| Grok normal store `~/.grok/sessions` | Imported transcripts | `grok sessions list` / `grok sessions delete <session-id>`; not deleted by removing plugin state |

### Removing local data safely

1. Cancel or wait for active jobs (`/grok:cancel` / `$grok:cancel` or status wait).
2. Close host tasks that use the plugin.
3. Remove the workspace directory under the applicable `state/` root (also deletes that workspace's resumable rescue sessions).
4. After uninstall and confirming no companion job is active, you may remove the host fallback plugin-data directory.
5. Delete imported sessions separately with `grok sessions delete <session-id>`.

---

## Execution and security model

- **One Grok process per job.** No shared Grok leader. Every process gets a unique `--leader-socket` under workspace state; ACP also passes advertised `agent --no-leader`.
- **Reviews** run headless with the `explore` agent, plugin-owned prompts, isolated review homes, and editing/shell/repository-read/web/MCP/subagent tools disabled. Normal and adversarial reviews validate a JSON Schema result and fail with `E_REVIEW_MUTATED_WORKSPACE` if a before/after snapshot detects mutation.
- **Rescue** runs ACP v1 over `grok agent stdio` with checked-in `toolConfig` profiles, `injectDefaultTools: false`, security-contract version **3**, and a persisted SHA-256 `agentProfileDigest` (continuation requires the same digest and contract). Before each process starts, the verified profile is copied to a unique mode-`0600` file inside isolated `GROK_HOME`; it is removed only after the owned process group is verified gone. Provider argv never points back into a Codex/Claude plugin cache.
  - **Read-only** tools: exactly `GrokBuild:read_file`, `GrokBuild:list_dir`, and `GrokBuild:grep` under a strict derived sandbox.
  - **Write** tools: those three plus `GrokBuild:search_replace` and `GrokBuild:todo_write`. There is no terminal, background process, task-manager, kill, or output-retrieval tool, and no bypass-permissions expansion.
  - **Report repair** uses a separate no-workspace `rescue-report-v3` profile in the same lineage. It exposes only the provider-required plan-state `GrokBuild:todo_write` compatibility tool, and the prompt forbids invoking it.
  - Root `--tools` flags are not used for ACP enforcement (Grok 0.2.99 documents them as headless-only).
- **Credentials:** tool-using jobs require cached `grok login` material. Reviews use a transient private credential copy removed with the review home. Rescue stages an atomically refreshed sanitized mode-`0600` copy for session authentication, removes it before `session/prompt`, and retries removal on every terminal/error path. It is not a persistent task credential. Opaque values are exact redaction sentinels in memory and never enter job JSON or raw user output.
- **Isolation inspect:** before tasks, external hooks/skills/plugins/MCP/non-builtin agents are rejected; provider-bundled skills may load only when real paths stay under `<isolated GROK_HOME>/skills/` or `<isolated GROK_HOME>/bundled/skills/`.
- **Child environment:** restricted allowlist (not the host agent's full environment). `GROK_COMPANION_CHILD=1` marks children so nested companion invocation fails with `E_RECURSION`. A workspace-scoped active-provider guard fails closed if markers are stripped or ancestry breaks.
- **Web search and Grok subagents** are disabled by current profiles. OS child-network enforcement differs by platform; macOS may not enforce the same child-process network boundary as Linux.
- **Managed Grok / enterprise policy** remains authoritative; denied operations fail instead of silently widening the profile.
- **Write-capable rescue is powerful.** Review the task and repository before authorizing it; use explicit read-only wording when no edits are wanted.

---

## Data boundary

Although the CLI is local, **provider execution is not local-only**. Under your Grok account and applicable xAI terms, the following may leave the machine:

- Task prompts and free-form rescue instructions
- Plugin-collected Git review evidence
- Repository content Grok reads or edits through allowed tools
- Bounded command output only when the host explicitly includes it in an authorized continuation prompt; the Grok worker itself has no terminal
- Imported Claude transcript context
- User-visible user/assistant messages from imported Codex rollouts (developer/system text, reasoning, tool calls/results, and other internal Codex records are excluded before import)

Do not delegate secrets, regulated data, or third-party material that must not be processed by that service.

---

## Troubleshooting

| Symptom | Likely cause | What to do |
|---|---|---|
| Setup: Grok not found (`E_GROK_NOT_FOUND`) | CLI missing from discovery paths | Install or activate the normal Grok-managed `$GROK_HOME/bin/grok`; use `GROK_BIN` only for bytes that already match a known release digest |
| Setup: untrusted source (`E_GROK_SOURCE`) | An unfamiliar executable was found, but it is not the active Grok-managed target | Use the active `$GROK_HOME/bin/grok` installation; arbitrary unfamiliar `GROK_BIN` and `PATH` binaries are not admitted |
| Setup: unsupported version (`E_GROK_VERSION`) | Version is older than 0.2.99, malformed, or prerelease | Activate a stable Grok Build 0.2.99+ |
| Setup: executable identity failure (`E_PROCESS_IDENTITY`) | Known-release bytes differ, or the managed source/private pin changed during capture or launch | Restore a stable active managed link and executable, inspect for unexpected replacement, then retry setup |
| Auth required (`E_AUTH_REQUIRED`) | No/expired cached login; env-key-only mode | Run `grok login`, then `/grok:setup` or `$grok:setup` again |
| Isolation / capability failure (any other `E_CAPABILITY` message) | External extensions in Grok home, missing ACP flags, unsupported model/effort/platform, executable identity drift, or Windows provider path | Remove external hooks/skills/plugins/MCP from the isolated profile; confirm 0.2.99+; on Windows treat provider execution as unsupported. Do **not** auto-setup for arbitrary / non-receipt `E_CAPABILITY` |
| Missing/invalid provider capability receipt (`E_CAPABILITY`, exact setup-recoverable message only) | Codex pre-launch receipt gate: setup-owned provider capability receipt is missing or invalid | **Sole setup-recoverable path:** request one-time command approval and run `$grok:setup` once; on success, retry the identical un-escalated rescue task once. Approval denial starts no setup/provider process. Surface setup failure unchanged and stop. `E_STORAGE_READONLY` or a persistent receipt error after that one retry remains terminal |
| Codex transfer needs `--source` | SessionStart has not run or hooks untrusted | New Codex task, trust hooks in `/hooks`, or pass a real `.jsonl` under `${CODEX_HOME:-~/.codex}/sessions` |
| Claude transfer rejected | Source outside `~/.claude/projects`, symlink, or non-`.jsonl` | Use a real regular `.jsonl` under the Claude projects root |
| `E_NO_RESUME_CANDIDATE` | Explicit prior job lacks a resumable same-profile Grok session | Use `--fresh` or pass an eligible finished job ID from this exact host task |
| `E_REVIEW_TOO_LARGE` | Diff/untracked evidence exceeds limits | Narrow scope/base, or shrink untracked files |
| `E_REVIEW_MUTATED_WORKSPACE` | Review process changed the repo | Treat as hard failure; do not trust a verdict; inspect Git status |
| `E_WORKER_LOST` | Background worker disappeared | Inspect job status/result; do not expect automatic replay (prompts are not re-run) |
| `E_STORAGE_READONLY` | Workspace control state or the user-owned plugin-data root is not writable (EPERM/EACCES/EROFS) | For `$grok:setup` in managed Codex, use its one-time command approval; this is command-scoped unsandboxed execution, not an exact-path grant. If the approved setup or an un-escalated task still fails, inspect ownership and writable media outside the plugin flow and preserve private 0700 directories / 0600 files; do not widen task authority or create a reusable approval rule |
| `E_PROCESS_IDENTITY` | Could not verify process-group ownership/shutdown | Leave guards/state for manual inspection; do not force-kill arbitrary PIDs |
| Raw `EAGAIN` while dispatching from Codex | An older cached runtime or an already-open task is still active | From this checkout run `npm run codex:update-local`, then test from a newly started Codex task |
| Grok reports `Operation not permitted` for `--agent-profile` | The installed snapshot still points Grok at a host plugin-cache path | Update to `0.3.0-dev.1` or newer with `npm run codex:update-local`, start a new task, and rerun `$grok:setup` |
| `result` reports `validationIssues.map is not a function` | An earlier development snapshot persisted a shared-array redaction sentinel | Refresh with `npm run codex:update-local`; the current renderer also reads the malformed historical record defensively |
| `E_RECURSION` | Nested companion call from inside Grok | Expected refuse; do not invoke `/grok:*` or `$grok:*` from provider tasks |
| Host paraphrased a review | Facade/skill contract violated | Runtime output for review/result/transfer/status must be shown verbatim |
| Codex skills missing after install | Snapshot stale or marketplace not local path | Re-add marketplace with absolute path, `codex plugin add grok@grok-companion --json`, new task |

Stable error codes also include `E_USAGE`, `E_GIT_REQUIRED`, `E_POLICY`, `E_PROTOCOL`, `E_PROVIDER_EXIT`, `E_SCHEMA`, `E_TIMEOUT`, `E_CANCELLED`, `E_JOB_NOT_FOUND`, `E_JOB_ACTIVE`, `E_IMPORT_SOURCE`, `E_IMPORT_RESULT`, `E_STATE`, `E_STORAGE_READONLY`, and `E_SECURITY_PROFILE` (see [SPEC.md](SPEC.md) §16).

---

## Development and tests

Contributor commands match `package.json` and [`.github/workflows/ci.yml`](.github/workflows/ci.yml):

```bash
npm ci --ignore-scripts   # as in CI
npm run validate          # structure, versions, manifests, contracts
npm test                  # full offline suite, including three concurrent read jobs
npm run check             # validate + deterministic offline tests; skip/TODO fails; installed/authenticated boundaries run separately
npm run test:temp:cleanup # dry-run manifest-backed temp cleanup; add -- --legacy to inventory exact source-proven legacy families
npm run test:temp:cleanup -- --apply --older-than 1h # remove only revalidated inactive candidates
npm run test:pty-ingress  # issue #2 real nonblocking PTY + negative-input gate
npm run test:installed-codex # clean CODEX_HOME install and cached-wrapper gate
npm run qualify            # stream npm run check and write a byte-bound receipt
npm run codex:update-local # verify that receipt, reinstall, compare source/cache
npm run test:natural-codex # quota-using installed Codex -> real Grok -> host-check gate
npm run version:check     # versions only
npm run version:bump      # coordinated version bump helper
```

Deterministic tests isolate each file in a private temp root and impose a
ten-minute per-file timeout. Linux containment additionally requires
`/usr/bin/python3` with `os.pidfd_open` and `signal.pidfd_send_signal`; the
runner fails closed before launching tests when that identity-bound signaling
boundary is unavailable.

CI matrix:

| OS | Node | Tests |
|---|---|---|
| ubuntu-latest | 18.18.2, 22.x | PR required: `npm run validate` + full `npm test` |
| macos-latest | 18.18.2, 22.x | main/dispatch only: same suite (does not block PRs) |
| ubuntu-latest | 22.x | PR required: dedicated `npm run test:pty-ingress` gate |
| macos-latest | 22.x | main/dispatch only: PTY ingress (does not block PRs) |
| windows-latest | 18.18.2, 22.x | PR required: `npm run validate` + `node --test tests/windows-neutral.test.mjs` only |

A trusted, Codex-equipped self-hosted macOS runner may additionally run `npm run test:installed-codex` on `main` pushes or explicit workflow dispatch when `CODEX_PLUGIN_RUNNER_ENABLED=true`. With an authenticated Grok/Codex runner and `CODEX_GROK_NATURAL_E2E_ENABLED=true`, a separate protected job updates the installed snapshot and runs `npm run test:natural-codex`: a new natural Codex task must invoke the installed `$grok:rescue`, complete a real Grok job, persist a passed host check, preserve the worktree, and remove transient auth/profile artifacts. Neither trusted job executes pull-request code. CI validates commits; it does not deploy them into your desktop Codex cache. Run `npm run codex:update-local`, then start a **new Codex task** so the app loads the refreshed skill text and runtime snapshot.

Release promotion is fail-closed. `release-plan.json` declares the change class,
target, stage, and both supported hosts. RC/stable validation requires one
machine-readable `qualification-<target>.json` whose deterministic source
digest still matches the complete checkout and whose separate Codex and Claude
Code records pass the boundaries required for that stage. Adding the evidence
file does not change its own source digest; changing any other non-ignored
source afterward does. A Codex-only natural task therefore cannot mark this
dual-host package stable.

Opt-in authenticated live suite (quota-consuming; not for untrusted PR CI):

```bash
GROK_E2E=1 GROK_E2E_CANCEL=1 GROK_E2E_MODEL=<advertised-id> GROK_E2E_EFFORT=low npm run test:e2e
```

The recorded macOS pass used `GROK_E2E=1 GROK_E2E_CANCEL=1 GROK_E2E_MODEL=grok-4.5 GROK_E2E_EFFORT=low npm run test:e2e` against Grok Build 0.2.99 on 2026-07-13.

Deeper design and release gates:

- [SPEC.md](SPEC.md) — normative behavior and safety invariants
- [PLAN.md](PLAN.md) — staged gates and release criteria
- [UPSTREAM.md](UPSTREAM.md) — provenance and adapted-file inventory
- [plugins/grok/CHANGELOG.md](plugins/grok/CHANGELOG.md) — release notes

---

## Repository layout

```text
.
├── .agents/plugins/marketplace.json     # Codex marketplace (local source)
├── .claude-plugin/marketplace.json      # Claude Code marketplace
├── .github/workflows/ci.yml             # validate + OS/Node test matrix
├── package.json                         # scripts, engines, private package
├── SPEC.md  PLAN.md  UPSTREAM.md  README.md  CONTRIBUTING.md
├── release-plan.json                     # version taxonomy and active tranche
├── LICENSE  NOTICE
├── scripts/
│   ├── validate.mjs
│   ├── bump-version.mjs
│   ├── update-local-codex.mjs
│   └── lib/                               # frontmatter + version policy
├── tests/                               # offline + optional live + e2e-results
└── plugins/grok/
    ├── .claude-plugin/plugin.json
    ├── .codex-plugin/plugin.json
    ├── CHANGELOG.md
    ├── agents/grok-rescue.md            # Claude rescue subagent
    ├── commands/*.md                    # Claude /grok:* facades
    ├── skills/*/SKILL.md                # Codex $grok:* facades (+ helpers)
    ├── hooks/hooks.json                 # SessionStart + Stop (both hosts)
    ├── hooks/claude-hooks.json          # Claude SessionEnd
    ├── prompts/                         # review / adversarial / stop-gate
    ├── provider-agents/                 # ACP agent profiles (read/write/setup)
    ├── schemas/review-output.schema.json
    └── scripts/
        ├── grok-companion.mjs           # shared runtime entry
        ├── grok-codex.mjs               # Codex host wrapper
        ├── session-lifecycle-hook.mjs
        ├── stop-review-gate-hook.mjs
        └── lib/                         # provider, state, ACP, security helpers
```

---

## Current limitations

- No documented native Grok review RPC equivalent to the pinned Codex reviewer; reviews use plugin-owned prompts and a validated JSON schema.
- Reviews are **context-only**: the plugin embeds selected Git evidence up to 8 MiB (and rejects oversized targets) rather than granting repository tools to the review agent.
- Stop gate is **advisory**; use a foreground review for a full structured verdict.
- Grok Build **0.2.99** is the stable compatibility floor and there is no upper
  admission allowlist. Future active managed versions are exact-byte pinned and
  capability-probed, but are not automatically qualified. Worker Broker
  operational qualification remains bound to exact official version
  **0.2.112** and its recorded source.
- The v3 Worker Broker is operationally qualified for the recorded macOS/Codex path only; the dual-host prerelease remains release-unqualified. **Linux** and independent Claude Code provider execution remain unqualified; **Windows** provider execution and process control remain unsupported.
- Setup readiness is not authenticated review execution or OS process-control certification.
- Codex default hooks require explicit trust; no Codex `SessionEnd`; unfinished Codex jobs are command-driven for cleanup.
- `grok import --json` NDJSON is parsed defensively; public shape is not treated as a stable plugin contract.
- Platform sandboxes differ; macOS does not enforce Grok's Linux child-network boundary.
- No direct xAI REST API usage and no host fallback when Grok fails.
- Remaining release work (per [PLAN.md](PLAN.md)): independently qualify Claude Code and the remaining supported platform boundaries, then decide whether to tag `v0.3.0`.

---

## Attribution and license

This is an independent community project and is **not** affiliated with, endorsed by, or sponsored by OpenAI or xAI.

It adapts Apache-2.0-licensed portions of OpenAI's [`codex-plugin-cc` v1.0.6](https://github.com/openai/codex-plugin-cc/tree/db52e28f4d9ded852ab3942cea316258ae4ef346) (commit `db52e28f4d9ded852ab3942cea316258ae4ef346`) while retaining required attribution and modification notices. See [UPSTREAM.md](UPSTREAM.md), [LICENSE](LICENSE), and [NOTICE](NOTICE).

Apache License 2.0.
