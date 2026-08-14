# Agent development process — design

**Status:** Approved for implementation (approach 2)
**Date:** 2026-08-14
**Type:** Process / version governance
**Scope:** Agent-facing ship contract, plugin-byte version gate, burned `0.3.0-dev.2`, post-merge branch deletion, local Codex snapshot hygiene

---

## 1. Problem

Agents and humans could not answer three operational questions from the repo:

1. Where do merged plugin fixes go? CI does not emit a desktop binary and does
   not install into Codex. Hosts snapshot `plugins/grok/` by version string.
2. Why did Codex show `0.3.0-dev.2` while `main` was `0.3.0-dev.1`? A dirty
   local marketplace checkout plus a versioned cache of older bytes reused a
   legal next label that GitHub never shipped.
3. What may an agent do after merge? Merged feature branches were left on
   origin. `AGENTS.md` did not exist on `main`.

The audience is agents. The contract has to be short, fail-closed where a
machine can check it, and explicit about local Codex cache.

## 2. Goals and non-goals

### Goals

- Commit `AGENTS.md` as the agent-facing contract: plugin-byte bumps, burned
  labels, branch deletion after MERGED, Codex refresh from clean `main`.
- `validate` fails a change under `plugins/grok/` that does not advance the
  synchronized active version versus the PR base.
- `0.3.0-dev.2` cannot become the active version again.
- Docs/tests/tooling-only PRs do not bump. This governance PR stays
  `0.3.0-dev.1`.
- After MERGED, any agent may delete the feature branch on origin and locally.
- Remove the stale local Codex `0.3.0-dev.2` snapshot and reinstall from clean
  `main` (`0.3.0-dev.1` until the next plugin-byte PR).

### Non-goals

- Remote Codex marketplace publish. `validate` still requires a local Codex
  marketplace path.
- Auto-bump in CI. Agents still edit `release-plan.json` and run
  `npm run version:bump`.
- A bot that deletes branches. The contract authorizes agents; it does not add
  a new workflow.
- Changing plugin runtime behavior, donors, or the dual-host qualification
  evidence rules.

## 3. Donor evidence

Searched for a ship/cache contract before inventing one:

| Donor | Pin / start | Finding | Reuse |
|---|---|---|---|
| `openai/codex-plugin-cc` | [UPSTREAM.md](../../../UPSTREAM.md) `1.0.6` / `db52e28` | Packaging and command/hook layout. No burned-label skip, no Codex versioned local snapshot gate. | Keep donor-first workflow. Do not import incompatible release machinery. |
| `xai-org/grok-build` | Audit pin in [WORKER_BROKER_PLAN.md](../../../WORKER_BROKER_PLAN.md) | Native protocol and lifecycle. No desktop plugin version cache. | None for this process. |

This is local process. Donor evidence is input, not verification.

## 4. Approach

**Approach 2 (approved):** `AGENTS.md` plus a `validate` / `version-policy`
gate. Rejected: docs-only (agents ignore it) and a dedicated ship bot (YAGNI).

Rejected labels: do not reuse `0.3.0-dev.2`. The next plugin-byte ship is
`0.3.0-dev.3`.

## 5. Architecture

### Plugin bytes

Installable bytes are `plugins/grok/**` only. Root manifests
(`package.json`, marketplaces, `release-plan.json`, `README.md`) stay
synchronized by the existing version-equality checks. They are not an
independent bump trigger. A marketplace-description or `AGENTS.md` PR does not
bump.

### Version move

On `validate` (including `--versions-only`):

1. Resolve base ref: `GROK_VERSION_BASE_REF`, else `origin/${GITHUB_BASE_REF}`,
   else `origin/main`.
2. If the base commit is missing, skip the bump-required check (still reject a
   burned active version).
3. Collect paths from `git diff --name-only <base>...HEAD`,
   `git diff --name-only HEAD`, and untracked files.
4. If any path is under `plugins/grok/` and `package.json` version equals the
   base `package.json` version, fail.
5. If the active version is in `BURNED_ACTIVE_VERSIONS`, fail even without a
   plugin-byte diff.

`nextDevelopmentPreRelease("dev.1", { targetVersion: "0.3.0" })` returns
`dev.3` because `0.3.0-dev.2` is burned.

### Agent contract

`AGENTS.md` states the same rules in operator language and names the Codex
paths. `CONTRIBUTING.md` keeps human version governance and adds branch
hygiene. `validate` requires `AGENTS.md` and a short phrase check so the
contract cannot be emptied.

### Branch deletion

After GitHub reports MERGED, any agent may:

```text
git push origin --delete <feature-branch>
git branch -d <feature-branch>
```

Never delete `main`. This contract is the authority for that cleanup. Pushing
new work still needs explicit authority.

### Local Codex mismatch

Observed: marketplace source
`~/.codex/local-marketplaces/grok-companion-src` at `af22b39` with a dirty
`0.3.0-dev.2` label; cache
`~/.codex/plugins/cache/grok-companion/grok/0.3.0-dev.2` without the #102
`gitSubprocessEnv` bytes. Restore the source to `origin/main`, delete the
burned cache directory, reinstall `0.3.0-dev.1` from that clean tree.

## 6. Error handling

| Case | Result |
|---|---|
| Plugin-byte PR, version unchanged | `validate` fails: bump required from the base version |
| Any tree using `0.3.0-dev.2` | `validate` fails: burned |
| Docs-only PR at `0.3.0-dev.1` | Pass |
| Plugin-byte PR at `0.3.0-dev.3` | Pass (subject to existing synchronized-manifest checks) |
| Base ref missing | Skip bump-required; still reject burned |
| Merged feature branch still on origin | Any agent deletes it |

## 7. Testing

`tests/version-policy.test.mjs`:

- `plugins/grok/**` is a plugin-byte path; `AGENTS.md`, `scripts/`, `tests/`,
  `package.json` are not.
- Plugin-byte + same version fails; docs-only + same version passes;
  plugin-byte + `0.3.0-dev.3` passes.
- `0.3.0-dev.2` is burned; `nextDevelopmentPreRelease` skips it;
  `validateReleasePlan` rejects `preRelease: "dev.2"`.

`npm run version:check` on this branch must stay green at `0.3.0-dev.1`.

## 8. Implementation files

- Create: `AGENTS.md`
- Create: `docs/superpowers/specs/2026-08-14-agent-dev-process-design.md`
- Modify: `scripts/lib/version-policy.mjs`
- Modify: `scripts/validate.mjs`
- Modify: `tests/version-policy.test.mjs`
- Modify: `CONTRIBUTING.md`

Do not touch `plugins/grok/**` in this PR.

## 9. Out of scope follow-ups

- Remote marketplace publish policy.
- Teaching `version:bump` to pick the next unused `dev.N` without a plan edit.
- Automating branch deletion in GitHub Actions.
