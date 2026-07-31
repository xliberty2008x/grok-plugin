# Worktree metadata cache donor evidence

Date: 2026-07-31

## Scope

This note records the donor review for the bounded test-temp cleanup optimization
that avoids one full `git worktree list --porcelain` process per candidate while
preserving the existing fail-closed deletion boundary.

The resulting cache is intentionally process-local and cleanup-invocation-local.
It is not a durable cache, a replacement for Git's authoritative registered-path
output, or permission to weaken the post-quarantine worktree check.

## `openai/codex-plugin-cc`

- Exact pin: [`db52e28f4d9ded852ab3942cea316258ae4ef346`](https://github.com/openai/codex-plugin-cc/tree/db52e28f4d9ded852ab3942cea316258ae4ef346), matching `UPSTREAM.md`.
- Relevant file: [`plugins/codex/scripts/lib/codex.mjs`](https://github.com/openai/codex-plugin-cc/blob/db52e28f4d9ded852ab3942cea316258ae4ef346/plugins/codex/scripts/lib/codex.mjs#L657-L678).
- Useful invariant: a reusable result must be bound to a canonical source
  identity and a SHA-256 content digest, rather than to a path or timestamp
  alone.
- Rejected pattern: the donor cache is not a worktree-registration cache and
  does not provide no-follow metadata traversal, stable-read checks, repository
  registration semantics, or deletion-race protection. Its machinery cannot be
  copied as the cleanup authority.

## Grok Build audit pin

- Exact contract-source audit pin:
  [`47348d13ec4508dcfe440e34c6d511bb02998fb2`](https://github.com/xai-org/grok-build/tree/47348d13ec4508dcfe440e34c6d511bb02998fb2),
  with embedded source revision
  `d02693a856a54f1030695b36b91d276e96b30b23`, matching
  `WORKER_BROKER_PLAN.md`.
- Relevant files:
  - [`xai-fast-worktree/src/discovery.rs`](https://github.com/xai-org/grok-build/blob/47348d13ec4508dcfe440e34c6d511bb02998fb2/xai-fast-worktree/src/discovery.rs#L95-L207)
  - [`xai-fast-worktree/src/api.rs`](https://github.com/xai-org/grok-build/blob/47348d13ec4508dcfe440e34c6d511bb02998fb2/xai-fast-worktree/src/api.rs#L1586-L1924)
  - [`xai-fast-worktree/src/auto_gc.rs`](https://github.com/xai-org/grok-build/blob/47348d13ec4508dcfe440e34c6d511bb02998fb2/xai-fast-worktree/src/auto_gc.rs#L377-L487)
- Useful invariants: canonicalize managed roots; reject escapes and ambiguous
  identities; fail closed when process visibility is unavailable; refresh
  safety evidence immediately before deletion; publish amortized state only
  after the authoritative operation succeeds.
- Rejected pattern: blanket `git worktree prune` is not a cleanup safety
  mechanism. It can mutate registrations outside the verified candidate and is
  outside this command's authority.

## Current Grok Build

- Exact reviewed source:
  [`dd04f397b1d02f2272b092555669dfba1f01bc85`](https://github.com/xai-org/grok-build/tree/dd04f397b1d02f2272b092555669dfba1f01bc85),
  with embedded source revision
  `2a28b4a86cfc4a4c133c35b7fc2a6a9964387c39`.
- Relevant files:
  - [`xai-fast-worktree/src/git/worktree.rs`](https://github.com/xai-org/grok-build/blob/dd04f397b1d02f2272b092555669dfba1f01bc85/xai-fast-worktree/src/git/worktree.rs#L32-L183)
  - Preservation tests in the same file:
    [`xai-fast-worktree/src/git/worktree.rs`](https://github.com/xai-org/grok-build/blob/dd04f397b1d02f2272b092555669dfba1f01bc85/xai-fast-worktree/src/git/worktree.rs#L271-L359)
  - [`xai-fast-worktree/src/managed_cache.rs`](https://github.com/xai-org/grok-build/blob/dd04f397b1d02f2272b092555669dfba1f01bc85/xai-fast-worktree/src/managed_cache.rs#L1-L7)
- Useful invariants: resolve the Git common directory; enumerate only direct
  registration children; resolve relative `gitdir` values from their
  registration directory; preserve locked, unreadable, live, and foreign
  registrations.
- Rejected patterns: do not delete Git registration entries, do not treat an
  unsigned cache marker as tamper evidence, and do not derive registered
  worktree paths by hand instead of consuming Git's authoritative porcelain
  output.

## Local decision

The local cleanup will:

1. Capture a bounded, no-follow, internally stable metadata proof for the active
   repository, Git common directory, relevant configuration, direct worktree
   registration entries, and selected Git executable.
2. Reject non-normal porcelain paths, then compute a versioned SHA-256 binding
   over semantic metadata and the sorted raw paths returned by Git.
3. Reuse only a copy-protected raw-path snapshot when a new metadata proof has
   the same digest, re-materializing canonical and platform aliases on every
   use.
4. On any metadata change, bracket one authoritative
   `git worktree list --porcelain` call with matching before/after proofs; retry
   once on concurrent churn, then fail closed.
5. Never fall back to stale paths after an unreadable, unsupported, oversized,
   symlinked, owner-mismatched, locked, or unstable metadata state.
6. Scan every already allowlisted legacy or manifest-backed candidate for
   nested `.git` links without following symlinks; unreadable or truncated
   descendant scans fail closed rather than relying on a hand-maintained subset
   of worktree-bearing prefixes.
7. Require candidate and descendant device identity to match the canonical temp
   root, recognize case variants and structured Git common/worktree metadata,
   and repeat those device/Git-marker guards inside the quarantined recursive
   remover.
8. Represent filesystem device/inode identities as exact decimal strings from
   BigInt stats, so large macOS or Node 18 identities cannot alias after Number
   rounding.
9. Permit manifest-backed roots with linked worktrees only when a bounded,
   stable content proof shows every marker, common directory, registration, and
   backpointer remains inside that same owned root. Recreate the proof after
   quarantine, cryptographically compare it with the inventory proof, and make
   the recursive remover enforce the proven control-file identities. Any
   external, dangling, symlinked, mixed, or changed endpoint preserves the
   entire root.
10. Bind strict Git configuration semantics as part of that proof: includes are
    unsupported, and every `core.worktree` must resolve physically inside the
    same managed root. Treat Linux mount-table boundaries and per-directory filesystem types
    as containment boundaries in addition to device IDs.
11. Record unreadable managed descendants as exact restricted-directory
    identities. On Linux only, the remover may pin one such inode with
    no-follow `O_PATH`, repair its mode, prove the newly readable subtree, and
    then delete it; any proof failure restores the original mode and root.
    Platforms without an equivalent pinned repair preserve and report the
    residual.

Timestamps may help detect an in-progress read, but they are not the semantic
cache key: routine Git activity touches registration metadata. Content hashes
must detect same-size rewrites even when a timestamp is restored.

The existing inventory, pre-delete identity check, timed process/worktree
refresh, rename quarantine, and post-quarantine registration check remain
authoritative. The cache reduces process launches; it does not make the final
filesystem deletion atomic with Git registration changes.
