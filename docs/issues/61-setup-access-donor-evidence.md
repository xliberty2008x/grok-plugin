# Issue #61: managed Codex setup-access donor evidence

## Decision

The installed Codex setup skill requests approval before starting its one exact
setup command. Codex unified execution exposes command-scoped unsandboxed
execution, not a literal writable-root grant, so the public contract states
that limitation directly. The skill creates no reusable approval rule, makes
no sandboxed first attempt, disables login/interactive shell semantics and PTY
framing, and does not extend approval to any task, review, provider, retry,
status, or verification command.

Approval denial or an unavailable approval starts no setup/provider process.
An approved invocation still preserves the runtime's private 0700-directory and
0600-file invariants. A subsequent `E_STORAGE_READONLY` is a real storage
failure, not permission to broaden the task or silently relocate state.

## Pinned Codex plugin donor

- Repository and revision:
  [`openai/codex-plugin-cc@db52e28f4d9ded852ab3942cea316258ae4ef346`](https://github.com/openai/codex-plugin-cc/tree/db52e28f4d9ded852ab3942cea316258ae4ef346)
  (also the current `main` revision checked on 2026-08-03).
- Setup command:
  [`plugins/codex/commands/setup.md`](https://github.com/openai/codex-plugin-cc/blob/db52e28f4d9ded852ab3942cea316258ae4ef346/plugins/codex/commands/setup.md)
  resolves the installed plugin wrapper and runs one authoritative setup
  command. Its optional missing-CLI install and second setup run belong to the
  Claude command host.

Useful invariant: setup uses the installed wrapper as the single authoritative
action. Rejected patterns: adopting the donor's optional install/retry, running
the wrapper from the workspace, or treating a normal sandboxed failure as an
approval probe.

## Grok Build donor

- Public contract-source audit pin:
  [`xai-org/grok-build@47348d13ec4508dcfe440e34c6d511bb02998fb2`](https://github.com/xai-org/grok-build/tree/47348d13ec4508dcfe440e34c6d511bb02998fb2).
  Current source was also checked at
  [`a4221165824e5b1f5c4c10b7459f65e78dd6448d`](https://github.com/xai-org/grok-build/tree/a4221165824e5b1f5c4c10b7459f65e78dd6448d).
- Grok-owned state paths:
  [`crates/codegen/xai-grok-pager/docs/user-guide/18-sandbox.md`, lines 9-46](https://github.com/xai-org/grok-build/blob/47348d13ec4508dcfe440e34c6d511bb02998fb2/crates/codegen/xai-grok-pager/docs/user-guide/18-sandbox.md#L9-L46)
  keeps Grok's own state directory writable even under its workspace,
  read-only, and strict provider profiles.
- Owner-only credential storage:
  [`crates/codegen/xai-grok-shell/src/auth/storage.rs`, lines 50-63](https://github.com/xai-org/grok-build/blob/47348d13ec4508dcfe440e34c6d511bb02998fb2/crates/codegen/xai-grok-shell/src/auth/storage.rs#L50-L63)
  tightens credential permissions, while
  [lines 239-253](https://github.com/xai-org/grok-build/blob/47348d13ec4508dcfe440e34c6d511bb02998fb2/crates/codegen/xai-grok-shell/src/auth/storage.rs#L239-L253)
  use an owner-only file creation path.

Useful invariant: provider-owned state remains writable while credential bytes
stay owner-only. Rejected pattern: importing Grok's inner provider sandbox as
if it granted the outer Codex host access to Companion plugin data. The donor
does not define that outer-host approval boundary.

## Adaptation boundary

The change is intentionally in the Codex setup and exact-receipt rescue skill
contracts, plus sanitized runtime guidance. It does not change plugin-data path
resolution, file modes, provider profiles, task admission, credentials,
process launch, or the fail-closed capability receipt. The host approval is
one-command authority; it is neither a path-scoped grant nor a persistent
capability.
