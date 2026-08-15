# Issue #119 donor evidence

Multi-worker wait is a control-plane MCP surface change. Donor evidence
informs the wait contract; it does not qualify a live Codex multi-worker
session.

## `openai/codex-plugin-cc`

- Exact revision: `db52e28f4d9ded852ab3942cea316258ae4ef346`.
- Inspected files: `plugins/codex/commands/status.md`.
- Useful invariant: the host can wait for work it already owns without
  starting a new session or replaying a prompt.
- Local adaptation: existing `worker_wait` keeps the single-`id` launch
  drain. `ids` (2–16 owned workers) waits for any new event or terminal
  transition, preserves per-worker cursors, and never dispatches a
  provider. Timeout is an empty no-change result.
- Rejected or missing pattern: adding a second tool name that would
  change the frozen 10-tool live-receipt inventory.

## `xai-org/grok-build`

- Exact revisions: contract audit
  `47348d13ec4508dcfe440e34c6d511bb02998fb2`; current-source check
  `e5478eff1e4050558e12e1328b85e6616632efb6`.
- Inspected files:
  `crates/codegen/xai-grok-pager/src/headless.rs` at both revisions.
- Useful invariant: a wait is not a new agent launch.
- Local adaptation: wait-any reuses `projectWorkerLifecycleCursor` and
  ownership checks; foreign IDs remain `E_JOB_NOT_FOUND`.
- Rejected or missing pattern: the ACP pager is not an MCP wait
  multiplexer.
