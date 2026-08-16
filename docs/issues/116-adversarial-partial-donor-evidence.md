# Issue #116 donor evidence

Adversarial `E_SCHEMA` after one repair is a lifecycle fail-closed
boundary. Donor evidence informs what is preserved; it does not
qualify a live complex-diff review.

## `openai/codex-plugin-cc`

- Exact revision: `db52e28f4d9ded852ab3942cea316258ae4ef346`.
- Inspected files: `plugins/codex/commands/adversarial-review.md`.
- Useful invariant: a review that cannot complete its contract is not
  a pass. The host still owes the caller a diagnosable product.
- Local adaptation: one same-session repair remains. If the second
  payload is still invalid, the job stays `E_SCHEMA` with no `verdict:
  pass`, and public error details keep the validation `reason` plus a
  sanitized findings partial. The projector lives in
  `public-schema-error.mjs` so `worker-protocol.mjs` stays at its exact
  2097-line cap. Raw plan/progress summaries are not echoed.
- Rejected or missing pattern: loosening empty-findings ship grammar
  so a placeholder can become pass.

## `xai-org/grok-build`

- Exact revisions: contract audit
  `47348d13ec4508dcfe440e34c6d511bb02998fb2`; current-source check
  `e5478eff1e4050558e12e1328b85e6616632efb6`.
- Inspected files:
  `crates/codegen/xai-grok-pager/src/headless.rs` at both revisions.
- Useful invariant: incomplete structured output is not a successful
  terminal product; one bounded repair then fail closed.
- Local adaptation: the second failure now carries stable diagnostics
  and sanitized findings so `status`/`result` are not a dead-end.
- Rejected or missing pattern: the ACP pager is not reused as a
  second review session.
