# Issue #114 donor evidence

Public job-summary projection is a control-plane display change. Donor
evidence informs the bound; it does not qualify a live job.

## `openai/codex-plugin-cc`

- Exact revision: `db52e28f4d9ded852ab3942cea316258ae4ef346`.
- Inspected files: `plugins/codex/commands/status.md` and
  `plugins/codex/commands/result.md`.
- Useful invariant: status/result surfaces stay concise and must not
  present a corrupted or mid-token completion message as the product.
- Local adaptation: `projectPublicJobSummary` bounds the stored public
  `job.summary` at 160 characters on a sentence or identifier boundary
  and appends `…`. If retreat from a mid-token cut reaches 0, the public
  summary is only `…` rather than a last-resort hard slice. 
  `result.workerReport.summary` remains the full durable text. No new
  Worker Protocol snapshot field is added because `WORKER_SNAPSHOT_KEYS`
  is an exact-key set.
- Rejected or missing pattern: Codex command docs do not define a
  160-character public-summary budget or an ellipsis contract to copy.

## `xai-org/grok-build`

- Exact revisions: contract audit
  `47348d13ec4508dcfe440e34c6d511bb02998fb2`; current-source check
  `e5478eff1e4050558e12e1328b85e6616632efb6`.
- Inspected files:
  `crates/codegen/xai-grok-pager/src/headless.rs` at both revisions.
- Useful invariant: display truncation is not a completed product; a
  hard cut must remain recognizable as a projection.
- Local adaptation: the host applies the bound when finalizing the
  public job record, including after a valid same-session report-format
  repair, instead of `String.prototype.slice(0, 160)`.
- Rejected or missing pattern: the ACP pager is not a Codex
  marketplace installer and is not reused as summary-transport
  machinery.
