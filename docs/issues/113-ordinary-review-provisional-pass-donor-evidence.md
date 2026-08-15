# Issue #113 donor evidence

Ordinary `review-v1` terminal validation is a lifecycle change. Donor
evidence informs the gate; it does not qualify a live review.

## `openai/codex-plugin-cc`

- Exact revision: `db52e28f4d9ded852ab3942cea316258ae4ef346`.
- Inspected files: `plugins/codex/commands/review.md` and
  `plugins/codex/commands/adversarial-review.md`.
- Useful invariant: normal review and adversarial review stay separate
  routes; a completed assessment is the product, not a progress note.
- Local adaptation: `review-v1` wraps `validateReview` with
  `validateOrdinaryReview`, which rejects plan/progress-only summaries
  and requires a completed zero-finding rationale that names observed
  changed paths. The adversarial ship/no-ship grammar is unchanged.
- Rejected or missing pattern: merging ordinary review into the
  adversarial validator, or treating empty findings as `pass` without
  a completed assessment.

## `xai-org/grok-build`

- Exact revisions: contract audit
  `47348d13ec4508dcfe440e34c6d511bb02998fb2`; current-source check
  `e5478eff1e4050558e12e1328b85e6616632efb6`.
- Inspected files:
  `crates/codegen/xai-grok-pager/src/headless.rs` at both revisions.
- Useful invariant: incomplete structured output is not a successful
  terminal product; one bounded repair then fail closed.
- Local adaptation: ordinary review uses one same-session repair
  (`ORDINARY_REVIEW_REPAIR_PROMPT`) and remains `E_SCHEMA` if the
  second payload is still provisional.
- Rejected or missing pattern: ACP pager repair is not a Codex
  marketplace installer and is not reused as transport machinery.
