# Issue #90: stable managed version-output donor evidence

## Decision

For a `managed-observed` executable, `--version` is authoritative for the
filename-matching semantic version and the observed build identity, but its
bracketed channel suffix is optional display text. Setup accepts a missing
suffix only after the canonical managed layout, bounded installer config,
stable SemVer filename, ownership and permissions, source stability, and exact
private copy/hash checks have passed. Those checks are the existing bounded
Companion admission policy for the active managed artifact. Any explicit
non-stable output contradicts that policy and fails closed.

This does not establish remote stable-release membership or infer the user's
configured updater channel. It preserves the existing `managed-observed`
policy, which accepts the initial managed-install supply-chain risk and then
binds the exact privately pinned bytes.

## Reproduction

The current managed target is named `grok-1.0.0-macos-aarch64`. During the
initial reproduction, two observations around a mutable update-cache change
produced both supported display shapes:

```text
$ grok --version
grok 1.0.0 (3cd0d0cbcebe) [stable]

$ GROK_COMPANION_CHILD=1 grok --version
grok 1.0.0 (3cd0d0cbcebe)
```

Later probes returned the suffixless form in both environments after
`version.json.stable_version` became null. Grok Build source contains no
`GROK_COMPANION_CHILD` channel-format branch; the marker remains required for
recursion safety but does not cause the omitted suffix. The old finalizer found
the matching `1.0.0` and build identity, then rejected the null channel match
with `E_GROK_VERSION` before authentication or ACP capability probing.

## Live vertical-derived source-stability precision

The first exact installed candidate setup admitted the candidate plugin bytes
but stopped before receipt publication with:

```text
The active managed Grok source changed while it was captured.
```

Read-only host evidence showed three unrelated Grok processes active at the
same time. Their `worktrees.db-shm` and `worktrees.db-wal` bookkeeping renamed
entries under the top-level `~/.grok` directory while the managed `bin` and
`downloads` directories, `config.toml`, active link, and selected 1.0.0 target
remained stable. The pre/post observation had treated the mutable root
directory mtime as executable-source identity and therefore rejected ordinary
concurrent Grok use.

The bounded adaptation ignores only the top-level managed-home mtime while
retaining its canonical device, inode, mode, and ownership identity plus the
managed bin/target-directory identities. It also strengthens the trust
boundary: the file captured between snapshots must equal the first validated
target's canonical path, device, inode, mode, size, and normalized mtime. The
second full critical-source observation remains. Deterministic regressions
prove that unrelated root bookkeeping succeeds while transient managed
directory, target, active-link, and dangling-target substitutions still fail
closed. Stopping the unrelated Grok sessions would only hide the real-user
condition and is not qualification evidence.

## Installed candidate vertical

The exact candidate plugin payload was refreshed into the installed Codex
cache before qualification: all 139 source and cache files matched with
inventory digest
`36f6104caa74f0cb292b40c04349f78034323e285f122a9862192b025863c3f1`.
An independent clean consumer clone at candidate commit
`7eb7c2bcb78e40bcd83a1fb7a7283f8001799301` then exercised the installed
wrapper end to end:

- setup reported `Grok Companion: ready`, `Grok 1.0.0; ACP v1`, and model
  `grok-4.5`;
- read job `task-9ffe345f5c034cfd3be42129` was admitted through the capability
  receipt, launched provider version 1.0.0, created a real Grok session, and
  read only the two declared paths;
- the structured report completed both acceptance criteria with no changed
  files, runtime cleanup completed, and the host's exact
  `git status --short` verification passed with exit code 0.

This qualifies the candidate plugin payload's installed
setup-to-receipt-to-gated-task path; deterministic and installed-PTY tests
remain separate supporting evidence.

## Grok Build donor

- Audit pin:
  [`xai-org/grok-build@47348d13ec4508dcfe440e34c6d511bb02998fb2`](https://github.com/xai-org/grok-build/tree/47348d13ec4508dcfe440e34c6d511bb02998fb2),
  with embedded source revision `d02693a856a54f1030695b36b91d276e96b30b23`.
- Current source inspected:
  [`xai-org/grok-build@afbc0fb710320c7add294c2106d447ecc3e3af2e`](https://github.com/xai-org/grok-build/tree/afbc0fb710320c7add294c2106d447ecc3e3af2e).
  The relevant version/channel implementation is identical at the audit pin
  and this revision.
- [`xai-grok-update/src/version.rs`, current lines 419-567](https://github.com/xai-org/grok-build/blob/afbc0fb710320c7add294c2106d447ecc3e3af2e/crates/codegen/xai-grok-update/src/version.rs#L419-L567)
  parses the managed symlink filename without executing it and derives the
  optional channel label from `version.json.stable_version`. Missing, stale,
  or unparseable cache state returns no label; the source describes that
  pointer as best-effort display data rather than a correctness requirement.
- [`xai-grok-pager-bin/src/main.rs`, current lines 1790-1806](https://github.com/xai-org/grok-build/blob/afbc0fb710320c7add294c2106d447ecc3e3af2e/crates/codegen/xai-grok-pager-bin/src/main.rs#L1790-L1806)
  formats `grok VERSION (BUILD)` plus the optional label.
- [`xai-grok-pager-bin/src/main.rs`, current lines 2582-2595](https://github.com/xai-org/grok-build/blob/afbc0fb710320c7add294c2106d447ecc3e3af2e/crates/codegen/xai-grok-pager-bin/src/main.rs#L2582-L2595)
  tests both the empty-label and bracketed-label forms.
- [`xai-grok-update/src/auto_update.rs`, current lines 102-181](https://github.com/xai-org/grok-build/blob/afbc0fb710320c7add294c2106d447ecc3e3af2e/crates/codegen/xai-grok-update/src/auto_update.rs#L102-L181)
  shows that `update --check` reports the updater's effective channel and calls
  the latest-version lookup.
- [`xai-grok-update/src/version.rs`, current lines 345-401](https://github.com/xai-org/grok-build/blob/afbc0fb710320c7add294c2106d447ecc3e3af2e/crates/codegen/xai-grok-update/src/version.rs#L345-L401)
  shows that lookup is network-backed and writes `version.json`.

Useful invariant: parse version text only for one exact version/build record;
missing presentation metadata cannot override independently established
managed provenance. Rejected patterns: trusting `version.json` as provenance,
adding a network/update-state mutation to setup, executing arbitrary
`GROK_BIN` or `PATH` candidates, or claiming the public mirror commit built the
distributed executable byte for byte.

## Pinned Codex plugin donor

- Repository and revision:
  [`openai/codex-plugin-cc@db52e28f4d9ded852ab3942cea316258ae4ef346`](https://github.com/openai/codex-plugin-cc/tree/db52e28f4d9ded852ab3942cea316258ae4ef346).
- [`plugins/codex/scripts/lib/process.mjs`, lines 38-50](https://github.com/openai/codex-plugin-cc/blob/db52e28f4d9ded852ab3942cea316258ae4ef346/plugins/codex/scripts/lib/process.mjs#L38-L50)
  treats zero-exit `--version` output as a liveness/display result rather than
  a channel contract.
- [`plugins/codex/scripts/lib/codex.mjs`, lines 833-849](https://github.com/openai/codex-plugin-cc/blob/db52e28f4d9ded852ab3942cea316258ae4ef346/plugins/codex/scripts/lib/codex.mjs#L833-L849)
  follows that with a separate required-runtime capability probe.

Useful invariant: presentation text does not replace behavioral capability
checks. Rejected patterns: the donor's broad global/PATH executable trust and
its lighter availability probe; Grok Companion retains managed provenance,
exact-byte private pinning, ACP/isolation/session probes, capability receipts,
and launch-time process re-attestation.

## Adaptation boundary

The implementation does not transplant either donor's updater or process
machinery. It adds only an anchored private `--version` grammar and preserves a
custom admitted `GROK_HOME` for that observation. The live vertical also
narrowed managed-source stability to ignore unrelated root bookkeeping while
explicitly binding captured bytes to the first selected-target identity.
Known-digest schema v1, arbitrary-binary rejection, receipt invalidation,
historical pins, immutable private copies, kernel mapping proof, and provider
capability probing remain unchanged. Deterministic fixtures prove the parser,
cleanup, root-churn, and transient-substitution behavior; the installed
candidate vertical above proves setup-to-receipt-to-gated-task execution.
