# Grok Companion Implementation Plan

Status: Implementation and macOS qualification complete; cross-platform CI and release publication pending

Target release: `0.1.0`

Companion specification: [SPEC.md](SPEC.md)

## 1. Objective

Harden and qualify `grok-plugin` as a Claude Code marketplace plugin that exposes the official Grok Build CLI as a companion coding agent. The implemented target is user-visible parity with [`openai/codex-plugin-cc` v1.0.6](https://github.com/openai/codex-plugin-cc/tree/db52e28f4d9ded852ab3942cea316258ae4ef346), while using Grok-supported runtime interfaces.

Parity means:

- The same eight command families, arguments, foreground/background modes, and output discipline.
- Equivalent review, adversarial review, rescue, transcript transfer, resume, status, result, cancellation, session cleanup, and stop-gate behavior.
- Equivalent read-only and write-capable safety boundaries.
- Equivalent failure transparency: Claude must not silently substitute its own work when Grok fails.
- Provider internals differ intentionally: reviews use headless Grok, resumable tasks use ACP v1, and transfer uses `grok import --json`.

## 2. Verified current state

- The repository now contains the marketplace, plugin, runtime, hooks, prompts, schema, tests, validation scripts, provenance, and release documentation.
- The upstream reference is pinned to v1.0.6, commit `db52e28f4d9ded852ab3942cea316258ae4ef346`.
- The pinned upstream repository passes all 91 tests and its build locally.
- The runtime enforces Grok Build 0.2.99 as the compatibility floor because the hardened ACP path depends on `--agent-profile`, `agent --no-leader`, and `--leader-socket`.
- The authenticated macOS release matrix passed 10/10 cases with Grok Build 0.2.99 on July 13, 2026, covering setup, review, read/write ACP, resume, recursion, transfer, stop gate, and cancellation.
- ACP initialization on 0.2.99 advertised protocol v1, session loading, models, and reasoning efforts.
- ACP read and write jobs use checked-in `rescue-read.md` and `rescue-write.md` `toolConfig` profiles with `injectDefaultTools: false`, security-contract version 2, a persisted SHA-256 `agentProfileDigest`, separate mode-private task homes, sanitized cached credentials, and exact-value credential redaction. Read grants only `GrokBuild:read_file`, `GrokBuild:list_dir`, and `GrokBuild:grep`; write grants only `GrokBuild:run_terminal_cmd`, those three read tools, `GrokBuild:search_replace`, `GrokBuild:todo_write`, `GrokBuild:kill_task`, and `GrokBuild:get_task_output`.
- Headless reviews receive their prompt through an anonymous, immediately unlinked file descriptor inherited as fd 3; no named prompt remains on disk.
- Transcript transfer streams the validated source directly through inherited fd 3 after post-open device/inode binding, with bounded output, cancellation, and whole-process-group cleanup.
- Normal, adversarial, and stop reviews are implemented through headless `explore`; read/write rescue tasks are implemented through ACP; transfer uses `grok import --json`.
- No documented Grok native review RPC equivalent to Codex `review/start` was found.
- The public `grok import --json` NDJSON shape is parsed defensively and covered with contract fixtures.
- Grok can discover Claude-compatible plugins, making recursive plugin invocation a release-critical risk.
- Tool-using jobs require cached authentication created by `grok login`; environment-key-only authentication is unsupported. Cached authentication expiring within 45 minutes is refreshed through the normal CLI before an isolated copy is made, and setup removes its transient copy before returning.
- SessionEnd verifies complete owned worker/provider process groups before removing records or guards; unverifiable cleanup records `E_PROCESS_IDENTITY` and retains state for inspection.
- Linux provider execution remains authenticated-provider-unverified. Windows runs provider-neutral tests only; provider execution and process control are unsupported in v0.1 pending trustworthy process ownership and authenticated lifecycle evidence.

The remaining release work is external qualification and publication: obtain provider-neutral CI results on the declared OS/Node matrix, keep Linux provider-unverified and Windows provider-unsupported, perform a clean-profile marketplace install, and decide whether to tag `v0.1.0`.

## 3. Planning assumptions

| ID | Assumption |
|---|---|
| A1 | Claude Code is the host and the official local Grok Build CLI is the delegated agent. |
| A2 | Headless `explore` is the review transport; ACP over `grok agent --no-leader --leader-socket <path> --agent-profile <profile> stdio` is the resumable task transport. |
| A3 | Transport is profile-fixed before execution; there is no automatic headless/ACP fallback. |
| A4 | Node.js 18.18 is the intended minimum unless testing forces a higher version. |
| A5 | This is a community derivative and must not claim OpenAI or xAI endorsement. |
| A6 | Behavioral and safety parity are required; identical internal architecture is not. |
| A7 | Users authenticate with a cached `grok login`; environment-key-only authentication is unsupported and the plugin never bundles credentials. |
| A8 | One Grok process per job, `agent --no-leader`, and a unique `--leader-socket` preserve profile isolation. |
| A9 | The first release is `0.1.0`. |
| A10 | Names are repository `grok-plugin`, marketplace `grok-companion`, plugin `grok`, and namespace `/grok:*`. |

If an assumption changes, update both SPEC.md and PLAN.md before implementation continues.

## 4. Architectural decisions

| Decision | Choice | Rationale |
|---|---|---|
| Host packaging | Claude Code marketplace and plugin manifests | Matches the reference host and installation model. |
| Review transport | Headless `explore`, anonymous fd 3 prompt input, JSON/JSON-Schema output | Grok has no documented native review RPC; the immediately unlinked descriptor avoids leaving a named prompt on disk. |
| Task transport | ACP v1 over `grok agent --no-leader --leader-socket <path> --agent-profile <profile> stdio` | Provides streamed progress and session loading while binding each rescue mode to a checked-in profile and isolated process. |
| Transport fallback | None | Retrying through another transport could duplicate side effects or weaken a security contract. |
| Process model | One Grok process per job | Sandboxes are selected at process start and must not cross privilege profiles. |
| Leader isolation | `agent --no-leader` plus a unique `--leader-socket` per ACP process | Prevents jobs from joining a shared Grok leader and keeps leader IPC paths job-scoped. |
| Normal review | Versioned plugin-owned prompt and collected Git context | Grok has no documented native review RPC equivalent. |
| Background lifecycle | Plugin-owned persistent job registry | Provider sessions alone do not provide Claude-scoped status/result/cancel behavior. |
| Task identity | Contract-version-2 checked-in read/write `toolConfig` profiles, persisted `agentProfileDigest`, separate mode-private homes, and sanitized cached credentials | Makes the exact tool boundary auditable, binds resume to unchanged profile contents, and prevents cross-mode configuration or credential-state reuse. |
| Transcript transfer | Canonical, post-open device/inode-bound `grok import --json` source read through inherited fd 3 and a short-lived `.jsonl` descriptor alias | Uses Grok's native Claude-session import route without copying the transcript body to a plugin-owned file or accepting a path-swap race. |
| Direct xAI API | Excluded from v0.1 | It would require rebuilding the Grok Build tool loop, sandbox, and persistence. |
| Shared broker | Excluded from v0.1 | It adds complexity without removing process-level sandbox boundaries. |
| Upstream incorporation | Copy and adapt selected pinned files into this repository | Keeps this repository's history while preserving Apache provenance explicitly. |

## 5. Delivery sequence

```mermaid
flowchart LR
    W0["WP0 Baseline"] --> W1["WP1 Feasibility spike"]
    W0 --> W2["WP2 Scaffold"]
    W1 --> W3["WP3 Grok provider adapter"]
    W2 --> W3
    W2 --> W4["WP4 Job runtime"]
    W3 --> W4
    W4 --> W5["WP5 Commands and prompts"]
    W4 --> W6["WP6 Setup transfer hooks"]
    W5 --> W7["WP7 Hardening and CI"]
    W6 --> W7
    W7 --> W8["WP8 Release"]
```

| Work package | Depends on | Original estimate | Current status | Exit gate |
|---|---|---:|---|---|
| WP0 — Baseline and provenance | None | 0.5 day | Complete | G0 |
| WP1 — ACP, sandbox, import, and recursion spike | WP0 | 1–1.5 days | Complete for macOS 0.2.99 | G1 |
| WP2 — Plugin scaffold and mechanical rebrand | WP0 | 0.5–1 day | Complete | G2 |
| WP3 — Grok provider adapter | G1, WP2 | 2–2.5 days | Complete | G3 |
| WP4 — Job orchestration and persistence | WP2, WP3 | 1.5–2 days | Complete | G4 |
| WP5 — Commands, prompts, and rescue subagent | WP3, WP4 | 1.5–2 days | Implemented | G5 |
| WP6 — Setup, transfer, lifecycle, and stop gate | WP3, WP4 | 1–1.5 days | Implemented; release qualification open | G6 |
| WP7 — Security, compatibility, and CI hardening | WP5, WP6 | 2–2.5 days | Complete locally; hosted OS/Node CI pending | G7 |
| WP8 — Documentation and release | G7 | 0.5–1 day | Documentation complete; clean-profile install and tagging pending | G8 |

The original planning estimate was **10–14 focused engineer-days** for one engineer. Remaining effort is driven by release blockers and authenticated platform evidence rather than the original scaffold estimate.

WP3 and the provider-neutral part of WP4 can overlap after the provider interface is frozen. WP5 and WP6 can run in parallel after G4.

## 6. WP0 — Freeze baseline and provenance

### Tasks

- Record upstream v1.0.6 and commit `db52e28f4d9ded852ab3942cea316258ae4ef346`.
- Add the OpenAI repository as an `openai-upstream` read-only reference remote.
- Re-run the pinned upstream build and 91 tests in a reproducible environment.
- Create `UPSTREAM.md` documenting:
  - Source repository, version, and commit.
  - Copied and materially adapted files.
  - Apache-2.0 provenance.
  - Material changes and non-affiliation.
- Preserve upstream LICENSE and applicable NOTICE content when source is introduced.
- Require a prominent modification notice in every copied-and-modified upstream file and maintain a machine-checkable file inventory in `UPSTREAM.md`.
- Create a parity matrix covering every command, flag, output rule, state transition, hook, and failure mode.
- Centralize package, marketplace, plugin, and version identifiers.
- Decide the implementation commit series before source is copied.

### G0 — Baseline gate

- Upstream tests and build pass.
- Every public reference behavior maps to a target behavior or an explicit divergence.
- License and trademark handling are documented.
- No parity row remains "unknown."

## 7. WP1 — Protocol, sandbox, import, and recursion spike

Build a disposable harness before porting production runtime code.

### ACP tasks

- Spawn Grok directly with an argument array and `shell: false`.
- Initialize ACP and record protocol version, auth methods, model/effort options, session capabilities, and prompt capabilities.
- Verify ACP with `grok agent --no-leader --leader-socket <unique-path> --agent-profile <checked-in-profile> stdio` and prove that each job is isolated from any shared Grok leader.
- Verify contract version 2 records and rechecks the checked-in profile's SHA-256 `agentProfileDigest`, and that resume rejects any digest change.
- Verify the exact `injectDefaultTools: false` profiles: read exposes only `GrokBuild:read_file`, `GrokBuild:list_dir`, and `GrokBuild:grep`; write additionally exposes `GrokBuild:run_terminal_cmd`, `GrokBuild:search_replace`, `GrokBuild:todo_write`, `GrokBuild:kill_task`, and `GrokBuild:get_task_output`. Verify terminal parameters `enabled_background: true`, `auto_background_on_timeout: false`, and `allow_background_operator: false`.
- Exercise session creation, session loading, prompt streaming, stop reasons, cancellation, and unexpected process exit.
- Capture representative agent-message, plan, tool-call, tool-update, usage, error, and unknown events.
- Keep 0.2.99 as the enforced compatibility floor and distinguish it from authenticated platform evidence.
- Retain the July 13, 2026 authenticated macOS 0.2.99 10/10 release result; add authenticated endpoint tests before claiming a supported version range.

### Sandbox tasks

- Prove a read-only process cannot change worktree content, executable modes, symlink targets, staged-tree content, or refs.
- Prove a write process can change the workspace and documented Grok-owned runtime paths but not arbitrary sibling, parent, or home-directory canaries.
- Prove the child receives only the explicit environment allowlist; seed unrelated parent variables and verify they are absent from Grok tools and command subprocesses.
- Require cached `grok login` authentication and prove environment-key-only authentication is absent from Grok and tool subprocesses.
- Record platform differences, especially macOS child-process network behavior.
- Verify managed-policy denials are detectable and actionable.
- Verify a resumed session cannot change to a less restrictive profile.

### Import tasks

- Run `grok import --json` against controlled Claude transcript fixtures.
- Capture and version synthetic, credential-free NDJSON contract fixtures.
- Determine the reliable imported session ID and resume command.
- Test malformed, missing, duplicate, oversized, and symlinked inputs.
- Establish idempotency behavior, adding a local path-and-content-hash ledger if required.

### Recursion tasks

- Determine which Claude commands, agents, skills, hooks, and marketplaces a child Grok process discovers.
- Permit builtin capabilities and provider-bundled skills only when their real paths remain beneath either `<isolated GROK_HOME>/skills/` or `<isolated GROK_HOME>/bundled/skills/`; reject external hooks, skills, plugins, MCP servers, and non-builtin agents.
- Set `GROK_COMPANION_CHILD=1` on every provider process.
- Make runtime entry points refuse nested companion execution.
- Make lifecycle hooks no-op in a child.
- Disable subagents for review and stop-gate profiles.
- Add an explicit prompt rule against invoking `/grok:*` or `grok-rescue`.
- Demonstrate that a child cannot create a recursive companion job.

### Headless review tasks

- Exercise headless `explore` with an anonymous, immediately unlinked prompt descriptor inherited as fd 3, JSON/JSON-Schema output, explicit session IDs, one same-session repair, cancellation, and isolated-home cleanup.
- Verify that normal, adversarial, and stop reviews never fall back to ACP.
- Verify that ACP write tasks are never replayed through headless mode.

### G1 — Feasibility gate

All of the following must be demonstrated:

- ACP initializes, creates a session, streams a result, cancels, and loads a saved session.
- Review execution leaves the fixture repository unchanged.
- Write execution remains inside the workspace boundary.
- Cancellation leaves no provider or grandchild process.
- Import yields a reliable resumable session ID.
- The recursion guard works end to end.
- The 0.2.99 compatibility floor, exact authenticated version evidence, and no-fallback policy are recorded separately.

Failure of review immutability, write confinement, or recursion prevention blocks implementation.

## 8. WP2 — Plugin scaffold and rebrand

### Target tree

```text
.
├── .claude-plugin/marketplace.json
├── .github/workflows/
├── README.md
├── LICENSE
├── NOTICE
├── UPSTREAM.md
├── SPEC.md
├── PLAN.md
├── package.json
├── package-lock.json
├── scripts/validate.mjs
├── scripts/bump-version.mjs
├── tests/
└── plugins/grok/
    ├── .claude-plugin/plugin.json
    ├── CHANGELOG.md
    ├── LICENSE
    ├── NOTICE
    ├── commands/
    ├── agents/grok-rescue.md
    ├── provider-agents/
    │   ├── rescue-read.md
    │   └── rescue-write.md
    ├── skills/
    │   ├── grok-cli-runtime/SKILL.md
    │   ├── grok-result-handling/SKILL.md
    │   └── grok-prompting/SKILL.md
    ├── hooks/hooks.json
    ├── prompts/
    ├── schemas/review-output.schema.json
    └── scripts/
        ├── grok-companion.mjs
        ├── session-lifecycle-hook.mjs
        ├── stop-review-gate-hook.mjs
        └── lib/
```

### Tasks

- Copy only required provider-neutral upstream files.
- Rename command namespaces, environment variables, state identifiers, headings, and follow-up commands.
- Remove Codex app-server and broker assumptions.
- Keep provider calls behind an initially unimplemented interface.
- Add one version source and synchronization checks for all manifests and lockfiles.
- Add community and non-affiliation language.
- Add the Apache-2.0 section 4(b) change notice to every modified upstream-derived file.
- Avoid official-looking `@xai`, `xai-*`, OpenAI namespaces, and logos.

### G2 — Scaffold gate

- Claude validates the marketplace and plugin manifests.
- The plugin installs in a clean Claude profile.
- All eight commands and the rescue agent are discoverable.
- Unimplemented provider operations fail explicitly.
- A stale-brand scan finds no unintended user-facing Codex, OpenAI, or GPT identifiers.

## 9. WP3 — Grok provider adapter

### Components

- `acp-client.mjs` — framing, IDs, pending requests, notifications, timeouts, and teardown.
- `grok-provider.mjs` — CLI discovery, version checks, isolated headless reviews, ACP tasks, authentication, spawning, schema validation, and lifecycle.
- `profiles.mjs` — review, stop, read-only rescue, and write rescue contracts.
- `provider-agents/rescue-read.md` and `provider-agents/rescue-write.md` — checked-in ACP tool and permission profiles.
- `process-control.mjs` and `recursion-guard.mjs` — bounded whole-process-group teardown and nested-invocation prevention.
- `redact.mjs` and `errors.mjs` — redaction and stable error taxonomy.
- `grok-companion.mjs` — task orchestration, transcript import, and model-qualified resume formatting.
- `tests/fake-grok.mjs` — scripted headless, ACP, models, sessions, and import scenarios.

### Tasks

- Implement the provider interface defined by SPEC.md.
- Separate protocol stdout from diagnostic stderr.
- Launch every ACP provider process with `agent --no-leader`, a unique `--leader-socket`, the matching checked-in `--agent-profile`, and the startup-only sandbox, permission, web, MCP, memory, planning, and subagent flags selected by the execution profile. Use contract version 2, persist the profile's SHA-256 `agentProfileDigest`, and verify it immediately before spawn.
- Keep `injectDefaultTools: false` and the exact `GrokBuild:*` `toolConfig` allowlists. The write terminal tool uses `enabled_background: true`, `auto_background_on_timeout: false`, and `allow_background_operator: false`; `kill_task` and `get_task_output` are the only task-manager tools.
- Use headless `explore` plus JSON/JSON-Schema output for reviews and ACP v1 for rescue tasks; pass headless prompts only through an anonymous, immediately unlinked fd 3 descriptor.
- Discover model and effort choices from ACP configuration options.
- Record session IDs immediately.
- Isolate review sessions beneath per-job homes and ACP tasks beneath separate read/write mode-private homes; remove ephemeral review homes recursively instead of deleting from the user's normal Grok session store.
- Require cached `grok login` authentication and reject environment-key-only auth. When a finite cached expiry is under 45 minutes, invoke the normal CLI to refresh and revalidate it before copying. Copy only a sanitized credential into each isolated task home with mode `0600`, omit identity and refresh-token fields, and register the retained opaque credential value for exact redaction.
- Permit builtin capabilities and provider-bundled skills rooted beneath either `<isolated GROK_HOME>/skills/` or `<isolated GROK_HOME>/bundled/skills/`; reject external hooks, skills, plugins, MCP servers, and non-builtin agents during every isolated inspection.
- Preserve unknown protocol events only after recursive key-based and exact-value redaction.
- Redact keys, authorization values, and auth payloads.
- Construct the Grok child environment from the normative allowlist instead of inheriting `process.env`.
- Apply distinct initialization, authentication, prompt, cancellation, and shutdown timeouts.
- Enforce bounded child output and terminate the entire detached provider process group with `SIGTERM` followed by `SIGKILL` when cancellation or timeout does not complete promptly.
- Map failures into stable actionable error codes.
- Validate structured output client-side.
- Allow one same-session schema repair attempt.
- Reject resume when the requested execution profile or `agentProfileDigest` differs from the stored contract-version-2 profile.
- Prohibit cross-transport fallback after transport selection.

### G3 — Provider gate

Using the fake provider and an opt-in real CLI test:

- Cover headless review and ACP task initialization, authentication, session creation/load, prompt, cancellation, and shutdown.
- Cover every normalized event type.
- Handle malformed frames, unknown events, auth expiry, timeout, and abrupt exit.
- Prove schema repair succeeds once and then fails deterministically.
- Prove no plugin-managed authentication fixture or seeded secret sentinel appears in logs or snapshots.
- Prove the read and write ACP jobs load only their exact checked-in `toolConfig` and isolated mode home, reject profile-digest drift, allow only isolated provider-bundled skills, and redact the exact cached credential value from every event and diagnostic path.
- Prove resume cannot weaken privileges.

## 10. WP4 — Job orchestration and persistence

### Tasks

- Port provider-neutral argument, Git, filesystem, rendering, process, state, and workspace modules.
- Implement the state schema and path from SPEC.md.
- Use atomic writes and a bounded lock with stale-lock recovery.
- Use `0700` directories and `0600` sensitive files where supported.
- Retain at most 50 jobs without evicting active jobs.
- Implement `queued`, `running`, `completed`, `failed`, and `cancelled` transitions.
- Persist workspace, Claude session, Grok session, the complete effective security profile, model, effort, verified process identities, timestamps, result, and stable error.
- Convert stale active records to `E_WORKER_LOST` only after provider cleanup is absent or verified; record `E_PROCESS_IDENTITY` and retain the guard/state when a leader is gone with a live group or ownership cannot be verified.
- Implement current-session implicit lookup and repository-scoped explicit IDs.
- Detach background workers safely.
- Clear full prompts from persisted requests after the worker claims them; never replay a lost worker automatically.
- Implement cancellation marker, ACP cancellation, bounded wait, and process-tree termination.
- Bind worker and provider PIDs to start tokens, a 128-bit nonce, and a job-specific command marker; never signal an unverified reused PID.
- Verify review immutability using complete before/after repository fingerprints rather than provider-reported touched files.

### G4 — Runtime gate

- Foreground and background jobs reach correct terminal states.
- Concurrent writers do not corrupt or lose jobs.
- Status, result, wait, and cancel work from a new command process.
- Implicit lookup never selects another Claude session's job.
- Crash recovery leaves no phantom running job.
- Cancellation kills a provider's spawned grandchild.
- A simulated PID-reuse mismatch produces `E_PROCESS_IDENTITY` and never signals the unrelated process.
- Retention remains bounded without deleting active work.

## 11. WP5 — Commands, prompts, and rescue subagent

### Tasks

- Implement all eight command Markdown files.
- Preserve the reference syntax and argument meanings.
- Keep command wrappers deterministic and thin.
- Route `/grok:rescue` through `grok:grok-rescue`.
- Restrict the rescue subagent to one companion invocation and verbatim forwarding.
- Prevent Claude from completing a task itself after Grok fails.
- Port working-tree, branch, and auto review target selection.
- Handle staged, unstaged, untracked, binary, renamed, large, symlinked, and hostile-path cases.
- Implement deterministic `--resume` and `--fresh` selection.
- Replace GPT-specific guidance with a Grok-specific prompting skill.
- Add versioned normal-review, adversarial-review, and stop-gate prompts.
- Implement the structured review schema and deterministic renderer.
- Add prompt-injection resistance language treating repository content as evidence.

### G5 — Command parity gate

- Every parity-matrix row has a passing contract test.
- All eight commands follow their stdout, stderr, and exit rules.
- Foreground/background and resume/fresh modes are covered.
- Review target selection matches the reference.
- Routing cannot cause a second provider invocation.
- Grok failure is surfaced without a Claude fallback.

## 12. WP6 — Setup, transfer, lifecycle, and stop gate

### Setup tasks

- Check Grok binary discovery and the 0.2.99 compatibility floor, including the required agent-profile, no-leader, and leader-socket capabilities.
- Run `grok models`, initialize ACP, and inspect authentication, protocol version, session loading, models, and effort options.
- Distinguish missing CLI, unsupported version, expired authentication, and ACP capability loss.
- Describe setup readiness narrowly: it validates required headless flags and isolated inspection without spending model quota, permits only builtin capabilities and provider-bundled skills rooted beneath either `<isolated GROK_HOME>/skills/` or `<isolated GROK_HOME>/bundled/skills/`, and rejects external extensions. It does not execute or qualify model-backed review behavior, write confinement, or operating-system process control.
- Offer the exact `npm install -g @xai-official/grok` command only after explicit approval; document the official curl installer as a manual alternative.
- Require a cached `grok login`, reject environment-key-only authentication, refresh cached authentication whose finite expiry is under 45 minutes, and provide official login guidance without requesting or printing a key.
- Remove the setup probe's transient sanitized credential copy and isolated review home on every completion or failure path.

### Transfer tasks

- Default to the SessionStart transcript path and allow `--source` override.
- Require a real regular `.jsonl` beneath the real `~/.claude/projects` directory.
- Reject traversal, symlink escape, non-file input, and unexpected extensions.
- Open the canonical source with no-follow semantics, compare the descriptor's post-open device and inode with a fresh stat of that path, and invoke `grok import --json` asynchronously with the transcript inherited as fd 3.
- Give Grok a short-lived `.jsonl` symlink alias to `/proc/self/fd/3` on Linux or `/dev/fd/3` on macOS, and remove the alias without ever copying the transcript body.
- Cap combined import output at 8 MiB, retain at most a 64 KiB stderr tail, enforce a 120-second timeout, and propagate `SIGINT`/`SIGTERM` through an `AbortController`.
- Run the importer in its own process group, register it with the recursion/process guard, and on cancellation or failure perform `SIGTERM`-then-`SIGKILL`, wait for complete group exit, unregister it, and close every descriptor.
- Parse conservatively and retain only redacted NDJSON diagnostics.
- Accept optional `--model` and `--effort low|medium|high`, select an advertised model, and reject a requested effort that conflicts with advertised efforts.
- Return `grok --model <id> [--reasoning-effort <effort>] --resume <session-id>` so Grok Build 0.2.99 does not resume the imported legacy placeholder model silently.
- Fail explicitly if no reliable session ID exists.

### Lifecycle tasks

- SessionStart exports the Claude session ID, transcript path, and plugin data path.
- SessionEnd cancels only jobs owned by that Claude session, verifies their worker/provider identities, and terminates complete owned process groups with bounded `SIGTERM`-to-`SIGKILL` escalation.
- SessionEnd removes guards, records, and artifacts only after every owned group is verified gone, without touching other sessions. Unverifiable ownership or shutdown records `E_PROCESS_IDENTITY` and retains the guard and job state for manual inspection.
- Hooks no-op when `GROK_COMPANION_CHILD=1`.

### Stop-gate tasks

- Keep the gate disabled by default.
- Scope the prompt with the Stop hook's immediately preceding assistant message and the plugin-collected current Git evidence, then compare complete before/after repository snapshots. Document that the gate still lacks a historical pre-turn snapshot, so it cannot attribute current changes to one Claude turn. Treat it as advisory; direct evidence-sensitive users to `/grok:review --wait`.
- Use a separate read-only Grok process.
- Enforce the 15-minute timeout.
- Require first-line `ALLOW:` or `BLOCK:`.
- Preserve fail-open behavior for completely unavailable Grok, with setup guidance.
- Block malformed output, runtime failure, and timeout when Grok is available and the gate is enabled.
- Preserve the active-job warning when the gate is disabled; the implemented enabled gate proceeds directly to review.

### G6 — Lifecycle gate

- Setup diagnoses each supported failure category.
- Transfer returns a session loadable in a new Grok process.
- Transfer leaves no transcript copy, descriptor alias, importer, or importer grandchild behind after success, failure, timeout, or cancellation.
- Invalid, escaped, and post-open device/inode-mismatched transcript paths are rejected.
- SessionEnd kills only current-session complete process groups and leaves no orphan; an unverifiable group retains its guard/state with `E_PROCESS_IDENTITY`.
- All stop-gate allow, block, malformed, timeout, missing-runtime, and active-job cases match the contract.
- Child Grok processes cannot trigger lifecycle recursion.

## 13. WP7 — Test, security, and compatibility hardening

### Unit coverage

- Arguments, version comparison, model/effort validation.
- Git target and diff-context selection.
- Workspace canonicalization and hashing.
- State transitions, migration, rendering, retention, and locking.
- ACP framing and request correlation.
- Event normalization and auth selection.
- Import parsing and schema validation.
- Anonymous fd 3 review input, post-open device/inode-bound direct fd 3 transfer, descriptor-alias cleanup, output bounds, and timeout/cancellation behavior.
- Version synchronization.

### Fake-provider integration coverage

- Initialize/authenticate/session-new/session-load/prompt.
- Message, plan, tool, usage, and unknown events.
- Partial and malformed protocol data.
- Authentication expiry, timeout, and crash.
- ACP cancellation completion or cancelled stop reason, followed by forced process-tree termination when neither arrives.
- Structured-output repair.
- Read/write profile arguments.
- Checked-in read/write agent-profile selection, `agent --no-leader`, unique leader sockets, isolated task homes, and sanitized credential staging.
- Resume profile mismatch.
- Spawned grandchildren and cleanup.
- Transfer output overflow, timeout, signal cancellation, and complete detached-process-group cleanup.

### Command contract coverage

- Every command and supported flag combination.
- Human slash-command output and corresponding internal runtime `--json` payloads; `--json` is not a public slash-command flag in v0.1.
- Exact hook-consumed first lines and exit behavior.
- Background start, status, wait, result, and cancel.
- Resume candidate selection and ambiguity.
- Failure rendering without accidental fallback.

### Security coverage

- Read-only ref, semantic index tree, staged/unstaged binary diff, mode, symlink, and untracked-content fingerprints, plus ignored-file canaries.
- Write confinement using sibling, parent, and home canaries outside documented Grok-owned runtime paths.
- Shell metacharacters in paths, refs, prompts, and IDs.
- Transcript and state path traversal.
- Concurrent state corruption.
- Cross-Claude-session access.
- PID reuse and forged process-identity records.
- Authentication fixtures, exact opaque cached credential values, and seeded secret sentinels absent from job records, logs, stdout, stderr, and snapshots; environment-key-only authentication is rejected, near-expiry cached authentication is refreshed, isolated review/task credentials are sanitized, and transient setup/review authentication is removed after setup, success, cancellation, crash recovery, and SessionEnd.
- Contract-version-2 profile digests and exact read/write `toolConfig` allowlists, including terminal parameters and task-manager tools; isolated provider-bundled skills are accepted while external extensions are rejected.
- Repository prompt injection cannot obtain write tools during review.
- Recursion guard across runtime, agents, skills, and hooks.

### Platform and CI matrix

- Ubuntu: Node 18.18 and Node 22, including the full POSIX fake-provider suite.
- macOS: Node 18.18 and Node 22, including the full POSIX fake-provider suite.
- Windows: Node 18.18 and Node 22, provider-neutral tests only.
- `npm ci`.
- Unit and fake-provider tests.
- Build and type checks.
- Claude plugin validation.
- License and NOTICE validation.
- Upstream-derived file inventory and per-file modification-notice validation.
- Version synchronization and stale-brand checks.
- Secret scanning.
- Optional manually dispatched real-Grok workflow.

Real Grok tests MUST NOT run on normal pull requests because they consume credentials and quota.

Before release, run the protected `GROK_E2E=1` headless review, sandbox, cancellation, resume, transfer, recursion, and stop-gate subset on every platform claimed as provider-supported. Commit non-secret result metadata containing OS, Grok version, date, and outcome. macOS 26.5 on arm64 passed all 10 cases with Grok Build 0.2.99 on July 13, 2026. Linux remains provider-unverified, and Windows provider execution/process control remains unsupported in v0.1 until safe process identity and authenticated evidence exist.

### G7 — Release-candidate gate

- All mapped upstream tests pass or have documented replacements.
- Every parity row and security invariant has a passing test.
- Provider-neutral Linux, macOS, and Windows CI is green, and Linux/macOS fake-provider CI is green.
- Real release-candidate isolation evidence exists for every platform claimed as supported.
- Immutability, confinement, cleanup, recursion prevention, and redaction pass.
- Regular CI requires no paid-provider credential.
- No unexplained provider-specific skip remains.

## 14. WP8 — Documentation and release

### Documentation tasks

- Complete installation and authentication instructions.
- Document every command and flag.
- Add foreground/background, resume, transfer, and cancellation examples.
- Document state and log locations plus cleanup.
- Document `CLAUDE_PLUGIN_DATA/state/<workspace>/`, the fallback `~/.claude/plugins/data/grok/state/`, safe workspace/all-plugin state removal, and isolated review homes.
- Document Grok's independent `~/.grok/sessions` store and the `grok sessions list` / `grok sessions delete <session-id>` cleanup flow for imported sessions; document that rescue sessions live only in the plugin-owned isolated task homes and are continued through `/grok:rescue --resume`.
- Disclose that prompts, plugin-collected review context, repository content selected by task tools, command output, and imported Claude context may be processed through Grok/xAI services despite the local CLI transport.
- Explain read-only versus write profiles and managed-policy limitations.
- Document the macOS child-network caveat.
- Document stable error codes and troubleshooting.
- Publish the 0.2.99 compatibility floor separately from exact authenticated test evidence; do not imply an established cross-platform supported range.
- Classify Linux as provider-unverified and Windows provider execution/process control as unsupported until their release evidence exists.
- Explain that normal review is plugin-prompt-based, not a native review RPC.
- Add Apache provenance, modification notices, and non-affiliation language.
- Add upgrade and rollback instructions.

### Release tasks

- Validate from a clean Claude profile.
- Install from `xliberty2008x/grok-plugin` and run `/grok:setup`.
- Run the opt-in live smoke suite.
- Synchronize all versions to `0.1.0`.
- Check package contents for secrets, local state, and temporary fixtures.
- Update `CHANGELOG.md`.
- Tag `v0.1.0` only after every release gate passes.
- Record exact Node, Claude Code, and Grok versions used for validation.
- Record OS, date, transport cases, and pass/fail outcome without credentials for every authenticated release run.

### G8 — Release gate

- Clean-profile install and setup succeed.
- All eight commands are discoverable.
- Read-only review, write rescue, background lifecycle, cancellation, resume, transfer, and stop-gate smoke tests pass.
- Attribution and non-affiliation notices are present.
- Every modified upstream-derived file has its required prominent change notice.
- Versions are synchronized.
- Known limitations are documented.
- External processing and both plugin/provider data-retention boundaries are disclosed before first use.
- No release-blocking risk remains open.

## 15. Commit strategy

Keep implementation reviewable and bisectable:

1. `docs: add Grok companion specification and implementation plan`
2. `test: add Grok ACP and sandbox contract spike`
3. `chore: scaffold Claude Code Grok plugin`
4. `feat: add Grok ACP provider adapter`
5. `feat: port persistent companion job runtime`
6. `feat: add Grok commands prompts and rescue agent`
7. `feat: add setup transfer and lifecycle hooks`
8. `test: harden security lifecycle and platform coverage`
9. `docs: prepare Grok companion v0.1.0 release`

Implementation SHOULD occur on `codex/grok-port` and merge into `main` only after G7. Each commit must keep tests passing or isolate an explicitly non-production spike.

## 16. Risk register

| ID | Risk | Likelihood | Impact | Mitigation | Gate |
|---|---|---:|---:|---|---|
| R1 | ACP or CLI schema changes after the Grok 0.2.99 floor | High | High | Capability negotiation, required-flag checks, redacted unknown-event preservation, and current-version contract tests | G1, G3, G7 |
| R2 | Prompt-based review is weaker than native Codex review | Medium | High | Versioned prompts, structured findings, fixed evaluation repositories, golden expected findings | G5, G7 |
| R3 | Child Grok discovers and recursively invokes the plugin | High | Critical | Child marker, runtime refusal, hook no-op, prompt rule, disabled review subagents | G1 |
| R4 | Sandbox behavior differs by platform | Medium | Critical | Process profiles, tool denial, workspace fingerprints, canaries, documented caveats | G1, G7 |
| R5 | `grok import --json` changes, cannot consume the descriptor alias, accepts a path-swap race, or omits a usable session ID | High | High | Credential-free fixtures, post-open device/inode binding, conservative parser, direct-fd integration tests, explicit ID requirement, and version tests | G1, G6 |
| R6 | Managed policy prevents unattended write tasks | Medium | Medium | Setup detection, policy-respecting failure, read-only alternative | G6 |
| R7 | Cancelled, crashed, or SessionEnd-cleaned jobs leave orphan processes | Medium | High | ACP cancel, bounded output/wait, detached process groups, `SIGTERM`-then-`SIGKILL`, verified whole-group exit, and retained guard/state with `E_PROCESS_IDENTITY` when verification fails | G4, G7 |
| R8 | Concurrent commands corrupt persistent state | Medium | High | Atomic writes, locks, stale recovery, idempotent terminal transitions | G4 |
| R9 | Secrets leak through isolated homes, environment, or provider events | Medium | Critical | Cached-login-only auth, automatic near-expiry refresh, sanitized mode-`0600` credential copies, transient setup-copy removal, exact-value and key-based redaction, no raw persistence by default, fake secret fixtures, secret scan | G3, G7 |
| R10 | Copied source loses attribution or implies endorsement | Low | High | Preserve Apache LICENSE/NOTICE, UPSTREAM.md, modification markers, disclaimer | G0, G8 |
| R11 | Windows lacks trustworthy provider process-start identity and authenticated lifecycle evidence | High | Critical | Keep provider execution unsupported, run provider-neutral CI only, add native process identity and real provider lifecycle tests before support | G7 |
| R12 | Real-provider tests are costly or flaky | High | Medium | Fake ACP suite in PR CI; minimal opt-in live smoke tests | G7 |
| R13 | Structured review output is malformed | Medium | Medium | JSON Schema, one repair turn, deterministic failure | G3, G5 |
| R14 | Repository prompt-injects the reviewer | Medium | High | Read-only boundary, tool denial, no review subagents/web, untrusted-content instruction | G7 |
| R15 | Resume attempts to change privilege profile or use modified profile contents | Medium | High | Contract version 2, persisted `agentProfileDigest`, exact `toolConfig`, reject mismatch, require fresh session | G3, G5 |
| R16 | Per-job startup is too slow | Medium | Low | Benchmark in WP1; consider profile-separated pooling only after v0.1 | G1 |
| R17 | Version fields drift across manifests | Medium | Medium | One source, bump script, CI synchronization test | G2, G8 |

## 17. Explicit non-goals for v0.1

- Reimplementing Grok Build over the direct xAI API.
- A long-lived shared Grok broker.
- Automatic privilege escalation or managed-policy bypass.
- Silent fallback from Grok to Claude.
- Cross-workspace implicit resume.
- Automatic installation of credentials.
- Publishing under an xAI- or OpenAI-owned namespace.
- Guaranteeing identical review wording or hidden reasoning; parity covers behavior, safety, and result contracts.

## 18. Definition of done

The first release is complete only when:

- All eight `/grok:*` commands work with documented flags.
- Review jobs leave the repository unchanged.
- User-project changes from rescue jobs remain inside the intended workspace; only documented Grok-owned runtime writes are allowed outside it.
- Background status, result, wait, cancellation, and crash recovery work across command processes.
- Resume selects only an eligible Grok session for the canonical repository and Claude session.
- Transfer yields a valid resumable Grok session.
- Stop-gate output and failure behavior match the reference.
- Requested task models and transfer model/effort qualification follow the documented capability rules.
- Child Grok processes cannot recursively invoke the plugin.
- Authentication material, including the exact opaque cached credential value, and seeded secret sentinels never enter job records, logs, results, or snapshots; cached login is required, environment-key-only auth is unsupported, near-expiry authentication is refreshed, task credentials are sanitized, and transient setup/review authentication is deleted on every lifecycle path.
- Headless prompts and imported transcript bodies are passed by anonymous/direct descriptors rather than persisted plugin-owned copies; transcript descriptors are bound post-open by device and inode.
- Cancellation and timeout leave no provider, importer, or descendant process after bounded whole-process-group cleanup.
- Contract-version-2 read/write ACP profiles retain the exact tool IDs, terminal parameters, task-manager tools, and `agentProfileDigest`; only isolated provider-bundled skills may coexist with builtin capabilities.
- SessionEnd cleans only the current Claude session's complete process groups and retains guard/state with `E_PROCESS_IDENTITY` whenever ownership or shutdown cannot be verified.
- Installation and validation succeed from a clean profile.
- Versions and attribution are synchronized.
- Provider-neutral Linux, macOS, and Windows CI is green; the full fake-provider suite is green on Linux and macOS; every provider-supported OS has authenticated release evidence.
