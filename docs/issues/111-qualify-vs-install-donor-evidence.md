# Issue #111 donor evidence

Install/qualification is a process and lifecycle change. Donor evidence
informs the split; it does not qualify a live Codex cache refresh.

## `openai/codex-plugin-cc`

- Exact revision: `db52e28f4d9ded852ab3942cea316258ae4ef346`.
- Inspected files: `plugins/codex/.claude-plugin/plugin.json`,
  `plugins/codex/commands/review.md`,
  `plugins/codex/scripts/lib/broker-lifecycle.mjs`, and
  `plugins/codex/scripts/session-lifecycle-hook.mjs`.
- Useful invariant: the public install/integration stays thin; runtime-owned
  code holds durable identity and does not hide in-flight work without a
  recorded end.
- Local adaptation: consumer `codex:update-local` / `codex:install` only
  verifies a qualification receipt and refreshes the Codex cache. The
  expensive repository suite is an explicit `qualify` command that writes
  durable receipt evidence before any cache swap.
- Rejected or missing pattern: the donor has no hosted 45-minute install
  wrapper and is not an authority for embedding release qualification in
  marketplace install.

## `xai-org/grok-build`

- Exact revisions: contract audit
  `47348d13ec4508dcfe440e34c6d511bb02998fb2`; current-source check
  `afbc0fb710320c7add294c2106d447ecc3e3af2e`.
- Inspected files:
  `crates/codegen/xai-grok-shell/src/session/acp_session_impl/tasks_cancel.rs`
  and `crates/codegen/xai-grok-shell/src/leader/lock.rs`.
- Useful invariant: cancellation is owner-scoped; exclusive identity is
  established before the external side effect; bounded termination reaps
  children instead of leaving them overlapping a retry.
- Local adaptation: `qualify` streams the repository check, records the
  active phase, and signals the child process group on timeout so a later
  retry cannot overlap a live suite. The lock stores parent and child
  pids, treats `EPERM` as live, and steals only with an atomic rename.
  The bound wait is cleared when the owner-scoped check ends so leftover
  timeout cannot keep the CLI alive. Install refuses to mutate the cache
  until the receipt matches the exact source inventory.
- Rejected or missing pattern: embedded ACP cancel and leader flock are not
  a Codex marketplace installer. Do not keep `spawnSync npm run check` on
  the consumer install path.
