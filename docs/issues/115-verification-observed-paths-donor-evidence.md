# Issue #115 donor evidence

`record-verification` path projection is a control-plane evidence change.
Donor evidence informs the published field; it does not qualify a live
write job.

## `openai/codex-plugin-cc`

- Exact revision: `db52e28f4d9ded852ab3942cea316258ae4ef346`.
- Inspected files: `plugins/codex/commands/status.md` and
  `plugins/codex/commands/result.md`.
- Useful invariant: a job result must present one coherent completion
  story. Status/result docs require the full stored payload, including
  paths, not a contradictory empty list beside a successful write.
- Local adaptation: `projectVerificationObservedPaths` publishes the
  terminal runtime observed paths and appends any additional
  completion→verification delta. Scope checks still use the delta
  alone so cache-only host checks stay in-scope.
- Rejected or missing pattern: Codex has no `record-verification`
  command and no empty-array "host verified no changes" contract to
  copy.

## `xai-org/grok-build`

- Exact revisions: contract audit
  `47348d13ec4508dcfe440e34c6d511bb02998fb2`; current-source check
  `e5478eff1e4050558e12e1328b85e6616632efb6`.
- Inspected files:
  `crates/codegen/xai-grok-pager/src/headless.rs` at both revisions.
- Useful invariant: host-asserted evidence must not silently drop the
  work the provider actually performed.
- Local adaptation: the empty verification delta remains the scope
  input; it is no longer the public `result.verification` path list
  when runtime evidence already named changed files.
- Rejected or missing pattern: the ACP pager is not reused as a
  verification ledger.
