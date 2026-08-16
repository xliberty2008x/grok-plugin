# Issue #120 donor evidence

Resumable interrupt is lifecycle mutation behavior. Donor evidence
informs the interrupt/cancel split; it does not qualify a live
provider-session reuse.

## `openai/codex-plugin-cc`

- Exact revision: `db52e28f4d9ded852ab3942cea316258ae4ef346`.
- Inspected files: `plugins/codex/commands/status.md`.
- Useful invariant: stopping a turn is not the same product as
  discarding the worker. The host still needs a later follow-up path.
- Local adaptation: `worker_cancel` stays the advertised tool
  (frozen 10-tool inventory). `mode=interrupt` stops the current
  attempt, keeps `grokSessionId`, and leaves the job `interrupted`.
  Missing session preservation falls back to terminal cancel.
- Rejected or missing pattern: adding `worker_interrupt` as an
  eleventh advertised tool name.

## `xai-org/grok-build`

- Exact revisions: contract audit
  `47348d13ec4508dcfe440e34c6d511bb02998fb2`; current-source check
  `e5478eff1e4050558e12e1328b85e6616632efb6`.
- Inspected files:
  `crates/codegen/xai-grok-pager/src/headless.rs` at both revisions.
- Useful invariant: an interrupted attempt is not a completed
  terminal product; later work can resume the same session when the
  provider identity is still bound.
- Local adaptation: one interrupt receipt per idempotency key, one
  `interruption.requested` event, and follow-up admission accepts an
  interrupted parent whose session was preserved.
- Rejected or missing pattern: the ACP pager is not reused as an
  interrupt transport.
