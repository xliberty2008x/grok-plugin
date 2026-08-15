# Grok Companion contributor guide

> Scope: this repository. Global Codex instructions still apply.

This file is the agent-facing development contract. Read it before changing
plugin bytes, versions, branches, or a local Codex install.

## Donor-first rule

Before designing provider, ACP, lifecycle, process, worktree, or control-plane
behavior, inspect both donors:

- [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc)
  (`codex-cc`): code, packaging, command, and hook donor. Use the pinned revision
  in [UPSTREAM.md](UPSTREAM.md).
- [`xai-org/grok-build`](https://github.com/xai-org/grok-build): native Grok
  protocol and lifecycle donor. Start from the audit pin in
  [WORKER_BROKER_PLAN.md](WORKER_BROKER_PLAN.md), then check current source.

## Workflow

1. Search both donors before inventing a solution.
2. Record the exact commit, files, useful invariant, and any rejected pattern.
3. Reuse contracts and invariants, not incompatible machinery; preserve
   attribution and licensing.
4. Treat donor evidence as design input, never as local verification.
5. Prove the adapted behavior with focused tests and the smallest real installed
   lifecycle. Local safety and public protocol rules always win.

## Ship contract

CI does not build a desktop binary and does not install into Codex. Hosts
snapshot the installable tree `plugins/grok/` under the synchronized active
version from `release-plan.json`. Codex then keeps that snapshot at
`~/.codex/plugins/cache/grok-companion/grok/<version>`. A later merge does not
reach Codex until someone refreshes that snapshot.

- **Plugin-byte path:** `plugins/grok/**` only. That is what Codex and Claude
  snapshot.
- **Every pull request that changes plugin bytes MUST bump** the synchronized
  active development version (`release-plan.json` `preRelease`, then
  `npm run version:bump -- <version>`). `validate` fails a plugin-byte diff
  against `origin/main` (or `GROK_VERSION_BASE_REF` / `GITHUB_BASE_REF`) that
  keeps the base version.
- **Docs, tests, and tooling outside `plugins/grok/` do not bump.** This
  governance change stays on `0.3.0-dev.1`.
- **`0.3.0-dev.2` is burned** and MUST NOT be reused. It was a local Codex
  cache of old bytes, not a GitHub release. While `main` is `0.3.0-dev.8`, the
  next plugin-byte ship is `0.3.0-dev.9` (use `nextDevelopmentPreRelease` in
  `scripts/lib/version-policy.mjs` so later burned labels are skipped).
- **Do not leave a dirty version label** in
  `~/.codex/local-marketplaces/grok-companion-src`. That checkout must match
  `origin/main` before a local refresh.
- **Refresh Codex from clean `main`:** restore the marketplace source, delete
  any burned or wrong version directory under
  `~/.codex/plugins/cache/grok-companion/grok/`, then from that source run
  `npm run qualify` once for the exact bytes and `npm run codex:update-local`
  (or `npm run codex:install`) to verify the receipt and refresh the cache.
  Start a new Codex task after the refresh. Do not use `codex:update-local`
  as a 45-minute repository test wrapper.

## Branch hygiene

One writer per worktree. One branch per task. Do not edit a dirty shared
checkout when an isolated clone or worktree exists.

After GitHub reports the pull request as MERGED, any agent may delete the
remote and local feature branch:

```text
git push origin --delete <feature-branch>
git branch -d <feature-branch>
```

Do not delete `main` or other protected branches. Do not leave merged topic
branches as clutter.

## Commits, pull requests & stacking

Use Conventional Commits. Each PR must be small: one coherent, independently
reviewable change with its required tests and docs. Separate unrelated fixes,
refactors, generated artifacts, and governance changes into their own PRs.

For features with two or more dependent reviewable layers, plan bottom-up and
use official `gh stack`: `gh stack init`, `gh stack add`, and `gh stack submit`.
Update with `gh stack rebase --upstack` and `gh stack push`. Review and merge
bottom-up without bypassing checks, approvals, or repository rules. Independent
changes use ordinary PRs, not artificial stacks. If `gh stack` is unavailable,
dependencies are not linear, or it fails, use ordinary PRs and document why.

Do not install, authenticate, push, submit, rebase, merge, or otherwise change
remote state without explicit authority. Deleting a feature branch after MERGED
is authorized by this contract.

Source adapted from q-masters small-PR governance
(`docs/superpowers/specs/2026-08-08-small-pr-governance-design.md`).

## Issue evidence

- [Agent development process design](docs/superpowers/specs/2026-08-14-agent-dev-process-design.md)
