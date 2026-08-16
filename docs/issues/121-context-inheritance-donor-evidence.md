# Issue #121 donor evidence

Spawn-time context inheritance is control-plane admission behavior.
Donor evidence informs the public spawn contract; it does not qualify
a live transcript transfer.

## `openai/codex-plugin-cc`

- Exact revision: `db52e28f4d9ded852ab3942cea316258ae4ef346`.
- Inspected files: `plugins/codex/commands/status.md`.
- Useful invariant: a delegated worker can be isolated or inherit
  bounded host context without exposing raw conversation text.
- Local adaptation: `worker_spawn` keeps the default
  explicit-envelope explorer path. Optional `contextMode`
  (`none`/`all`/`recent`) stores only a host-supplied digest and
  turn bound. Optional `name` and `parentId` appear on list/get.
  Explicit model/effort fail closed because the receipt does not
  advertise those selectors.
- Rejected or missing pattern: accepting raw transcript text on
  `worker_spawn` or adding a new advertised tool name.

## `xai-org/grok-build`

- Exact revisions: contract audit
  `47348d13ec4508dcfe440e34c6d511bb02998fb2`; current-source check
  `e5478eff1e4050558e12e1328b85e6616632efb6`.
- Inspected files:
  `crates/codegen/xai-grok-pager/src/headless.rs` at both revisions.
- Useful invariant: display and spawn metadata are not the same as
  the durable transcript.
- Local adaptation: public handles publish context mode and digest,
  never inherited turns.
- Rejected or missing pattern: the ACP pager is not a spawn-time
  context transporter.
