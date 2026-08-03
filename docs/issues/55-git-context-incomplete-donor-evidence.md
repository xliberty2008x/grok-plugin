# Issue #55: incomplete Git-context donor evidence

> Design evidence for separating an incomplete Git observation from proven
> task-relevant drift. Donor behavior is not local or installed-plugin
> qualification.

## Decision

Grok Companion continues to fail closed, but now preserves the observed
failure class. A complete comparable identity change is
`E_CONTEXT_DRIFT`; an inventory that cannot be observed completely is
`E_CONTEXT_INCOMPLETE`. Initial incompleteness is rejected before durable
acceptance, and later execute, resume, and terminal checks retain the phase and
bounded component names without publishing paths or raw Git metadata.

The change reuses the existing bounded inventory results. It does not add a
filesystem walker, increase an existing cap, or weaken issue #34's attribution
requirements.

## `openai/codex-plugin-cc` donor

- Repository and pinned revision:
  [`openai/codex-plugin-cc@db52e28f4d9ded852ab3942cea316258ae4ef346`](https://github.com/openai/codex-plugin-cc/tree/db52e28f4d9ded852ab3942cea316258ae4ef346)
- [`plugins/codex/scripts/lib/git.mjs`](https://github.com/openai/codex-plugin-cc/blob/db52e28f4d9ded852ab3942cea316258ae4ef346/plugins/codex/scripts/lib/git.mjs)
  runs repository-derived arguments without a shell, requires
  `rev-parse --show-toplevel` for Git-only operations, and uses checked Git
  commands for staged, unstaged, and untracked state. A failed observation is
  propagated instead of being fabricated as a clean result.
- [`plugins/codex/scripts/lib/workspace.mjs`](https://github.com/openai/codex-plugin-cc/blob/db52e28f4d9ded852ab3942cea316258ae4ef346/plugins/codex/scripts/lib/workspace.mjs)
  intentionally falls back to the caller's directory when Git discovery
  fails, which is appropriate for its broader workspace resolution surface.

Useful invariant: Git-dependent safety decisions require positively observed
Git results; command failure is not evidence of an unchanged checkout.

Rejected patterns: treating `resolveWorkspaceRoot()`'s non-Git fallback as
verified task authority, or treating the donor's basic working-tree file lists
as complete evidence for hooks, config, operational state, index flags, refs,
and upstream identity.

## `xai-org/grok-build` donor

- Repository and public protocol audit revision:
  [`xai-org/grok-build@47348d13ec4508dcfe440e34c6d511bb02998fb2`](https://github.com/xai-org/grok-build/tree/47348d13ec4508dcfe440e34c6d511bb02998fb2)
- [`crates/codegen/xai-fast-worktree/src/git/discovery.rs`](https://github.com/xai-org/grok-build/blob/47348d13ec4508dcfe440e34c6d511bb02998fb2/crates/codegen/xai-fast-worktree/src/git/discovery.rs)
  distinguishes a regular `.git` directory from a linked-worktree `.git`
  pointer, resolves relative pointers against the worktree, and errors when no
  Git authority or work directory exists.
- [`crates/codegen/xai-fast-worktree/src/git/status.rs`](https://github.com/xai-org/grok-build/blob/47348d13ec4508dcfe440e34c6d511bb02998fb2/crates/codegen/xai-fast-worktree/src/git/status.rs)
  propagates repository discovery and status-iteration errors while retaining
  separate modified, untracked, and deleted observations.

Useful invariant: regular and linked worktrees require explicit discovery and
canonical Git-directory handling; observation failures should remain
distinguishable from observed state.

Rejected patterns: copying the status donor's empty-or-missing-index workaround
as a clean task-context result, exposing donor path-bearing diagnostics across
the public worker boundary, or importing its worktree-copy machinery into the
ContextManifest observer.

## Local adaptation

New ContextManifest v2 captures add one authenticated, exact-key
`git.taskRelevantMetadataObservation`:

```text
nonRef operational hooks config indexFlags refs: complete | incomplete
upstream: not_configured | resolved | unresolved
complete: all six inventories complete and upstream is not unresolved
```

`complete` is cross-bound to `sharedRefIdentity.complete`. Malformed or
cross-bound stored claims remain manifest-integrity `E_CONTEXT_DRIFT`.
Genuine v1 manifests retain strict legacy comparison. Older valid v2 manifests
without the new observation remain comparable only when their retained shared
inventory is complete; otherwise they report bounded `gitMetadata`
incompleteness.

Runtime evidence uses a separate `metadataCompletenessObservation` and leaves
the issue #34 `sharedRefObservation` schema unchanged. Public durable
`E_CONTEXT_INCOMPLETE` errors use selective error schema v2 with only
`contextPhase` and unique bounded `metadataComponents`. Proven manifest
integrity failure, comparable drift, and concrete scope violations retain
precedence over incompleteness; incompleteness retains precedence over process
uncertainty and prior provider outcome.

Deterministic checks prove direct and broker admission, same-key and orphan
replay immutability, execute/resume/terminal classification, legacy readers,
public schema projection, and privacy bounds. Installed-plugin qualification
still requires a separate consumer checkout and a real invocation proving
zero provider launches.
