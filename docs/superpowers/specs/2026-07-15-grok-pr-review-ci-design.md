# Grok PR Review CI — Design

**Date:** 2026-07-15  
**Status:** Approved for implementation planning  
**Repo:** grok-plugin (Grok Companion)

## Problem

Pull requests in this repository only get offline CI (validate + fake-provider tests). There is no automated, same-quality Grok review on each PR. Local hosts can run `/grok:review` / `$grok:review` via the plugin runtime, but findings never land on GitHub.

## Goals

1. On each **same-repo, non-draft** PR, run the **plugin’s headless explore review** (not a free-form agent).
2. Post results as a **formal GitHub PR review** with **inline comments** where possible.
3. Keep the existing security model of the plugin: isolated review, schema validation, immutability checks.
4. Never block merge on finding severity; fail the job only when automation is broken.

## Non-goals (v1)

- `XAI_API_KEY` / env-key-only auth path (plugin continues to use staged cached login only)
- Fork PR auto-review or `pull_request_target`
- Draft PR reviews
- Fail job / `REQUEST_CHANGES` on critical/high findings
- PENDING-only reviews (bundled interactive skill UX)
- Marketplace / composite Action packaging
- Self-hosted `grok-authenticated` runner requirement
- Sticky “reviewing…” status comments
- CI `adversarial-review`
- Required status checks for merge (callers may enable later)

## Product decisions (locked)

| Topic | Decision |
| --- | --- |
| Review engine | Plugin headless `explore` + host-side GitHub post |
| Auth | Stage `secrets.GROK_AUTH_JSON` → file + `GROK_AUTH_PATH` |
| Triggers | `pull_request` same-repo only; forks skipped |
| Drafts | Skip; run on ready_for_review and non-draft opened/synchronize/reopened |
| Runner | GitHub-hosted `ubuntu-latest` |
| Trust | Trusted runtime ref (default `main`); PR head is code under review only |
| Posting | Formal review, `event: COMMENT`, inline + body promotion |
| Check outcome | Findings never fail; infra/auth/schema/post errors fail |

## Architecture

```text
pull_request (same-repo, non-draft)
        │
        ▼
┌───────────────────────────┐
│ Job: grok-pr-review       │  ubuntu-latest
│ permissions:              │
│   contents: read          │
│   pull-requests: write    │
└───────────┬───────────────┘
            │
            ├─ 1. Checkout PR head (code under review, fetch-depth 0)
            ├─ 2. Checkout trusted ref → $RUNNER_TEMP/grok-trusted
            ├─ 3. Install Node + pinned Grok CLI
            ├─ 4. Stage GROK_AUTH_JSON → 0600 file under $RUNNER_TEMP
            ├─ 5. run-trusted-review.mjs (trusted tree)
            │       → grok-companion review --wait --json
            │         --scope branch --base origin/<base>
            │       → review-job.json
            ├─ 6. post-grok-review.mjs (trusted tree)
            │       → GitHub Reviews API (GITHUB_TOKEN only)
            └─ 7. always: wipe auth file; artifact on post/review failure
```

### Component boundaries

| Unit | Responsibility | Must not |
| --- | --- | --- |
| Workflow YAML | Triggers, concurrency, permissions, install, env | Parse findings or invoke Grok binary policy |
| Trusted plugin review | Diff collect, headless explore, schema, immutability | Call GitHub APIs |
| `post-grok-review.mjs` | Map validated review JSON → Reviews API | Hold Grok credentials or run Grok |
| Default `ci.yml` | Unchanged offline gates | Live Grok or `pull-requests: write` |

### New files

- `.github/workflows/grok-pr-review.yml`
- `scripts/ci/run-trusted-review.mjs` — stage auth (or sibling), invoke companion from trusted tree against PR workspace
- `scripts/ci/post-grok-review.mjs` — map findings → review payload + `gh api` / Octokit via `gh`
- `tests/ci-post-grok-review.test.mjs` — offline fixtures for mapper + line filter

Auth staging may live inside `run-trusted-review.mjs` or a tiny `stage-grok-auth.mjs`; keep secrets handling in one place.

## Data flow and contracts

### Inputs

| Source | Use |
| --- | --- |
| `github.event.pull_request` | number, base/head SHAs & refs, draft, same-repo check |
| `secrets.GROK_AUTH_JSON` | Full contents of a usable `grok login` session file |
| `vars.GROK_PR_REVIEW_TRUSTED_REF` | Optional; default `main` |
| `vars.GROK_CLI_VERSION` | npm dist-tag or version for `@xai-official/grok`; **default `0.2.99`** (plugin floor) if unset |

### Trusted runtime layout

1. Checkout **PR head** at `GITHUB_WORKSPACE` (review target, full history).
2. Checkout **trusted ref** into `$RUNNER_TEMP/grok-trusted` (at least `plugins/grok` + `scripts/ci`).
3. Execute companion and CI scripts **only** from the trusted tree.
4. Git root for `git-review` / branch scope is **`$GITHUB_WORKSPACE`** (PR code).

### Review invocation

```bash
node "$TRUSTED/plugins/grok/scripts/grok-companion.mjs" review \
  --wait --json \
  --scope branch \
  --base "origin/${BASE_REF}"
```

- Fetch `origin/<base_ref>` before review.
- `GROK_AUTH_PATH` points at staged file under `$RUNNER_TEMP` (not the workspace).
- Capture stdout JSON to `review-job.json`.
- Companion public JSON includes `result.review` with `verdict`, `summary`, `findings[]` (and skip markers when empty target).

### Finding schema (plugin)

Model/runtime findings use:

- `severity`: `critical` | `high` | `medium` | `low` | `info`
- `title`, `body`
- optional `file` (repo-relative), `line` (1-based)

Runtime derives `verdict`: `pass` iff zero findings, else `needs_changes`.

### Post mapper

- `commit_id` = PR **head** SHA.
- `event` = `"COMMENT"` always.
- `body` = summary + severity counts + findings that cannot be placed inline.
- `comments[]` = findings whose `(file, line)` exist on the **RIGHT** side of the PR head diff (added or context lines). Out-of-diff findings go to body only.
- **Zero findings:** do not create an empty review; exit 0.
- **Empty target / skipped:** do not post; exit 0.
- On API failure: exit non-zero; upload `review-job.json` as artifact; do not retry loops.

### Tokens

| Secret/token | Steps | Notes |
| --- | --- | --- |
| Grok auth file | Review step only | Never pass raw JSON into logs; wipe in `always()` |
| `GITHUB_TOKEN` | Post step only | Not present in Grok child environment |

### Concurrency

```yaml
concurrency:
  group: grok-pr-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true
```

## Security

| Risk | Mitigation |
| --- | --- |
| PR edits steal session secret | Trusted runtime only; PR tree is input, not executor |
| Fork + secrets | Same-repo `if:`; no `pull_request_target` |
| Token mashup | Split review vs post env |
| Prompt injection | Tool-denied headless explore + host posts only schema-valid findings |
| Oversized diff | Existing `E_REVIEW_TOO_LARGE`; fail job, no spam post |
| CLI supply chain | Install `@xai-official/grok@${GROK_CLI_VERSION:-0.2.99}` via npm (no unpinned curl) |
| Data exfil to xAI | Inherent to product; document for operators |

Prefer a **dedicated bot SuperGrok identity** for the session secret, not a personal daily login.

## Error handling (job outcomes)

| Situation | Job | Review posted |
| --- | --- | --- |
| Missing `GROK_AUTH_JSON` | fail | no |
| Grok CLI missing / bad version | fail | no |
| `E_AUTH_REQUIRED` | fail | no |
| `E_REVIEW_TOO_LARGE` | fail | no |
| Schema failure after repair | fail | no |
| `E_REVIEW_MUTATED_WORKSPACE` | fail | no |
| Empty / skipped target | success | no |
| Zero findings | success | no |
| Findings present | success | yes (`COMMENT`) |
| GitHub post 4xx/5xx | fail | no (+ artifact) |

**Principle:** Review quality never turns the check red; automation breakage does.

## Workflow sketch

```yaml
name: Grok PR Review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: grok-pr-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  grok-pr-review:
    if: >-
      github.event.pull_request.head.repo.full_name == github.repository
      && github.event.pull_request.draft == false
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      # checkout PR head, trusted ref, setup-node, install grok CLI,
      # stage auth, run-trusted-review, post-grok-review, cleanup always
```

Exact step names and paths are implementation details; behavior above is normative.

## Testing

### Offline (default CI)

- Mapper: fixture job JSON → expected review payload.
- Diff line filter: synthetic unified diffs → commentable `(file, line)` set.
- Env builders: Grok spawn env lacks `GITHUB_TOKEN`; auth not echoed.
- Optional pure helpers for same-repo / draft predicates if extracted from YAML.

### Manual smoke (after secret is configured)

1. Same-repo non-draft PR with a small intentional issue → green job + visible review.
2. Clean/trivial PR → green job, no empty review spam.
3. Expired/missing secret → red job, clear message, no partial post.
4. Confirm auth file absent from artifacts; failed post retains `review-job.json` only.

Live Grok must **not** be required for default `ci.yml` / `npm test`.

## Documentation

- **CONTRIBUTING.md:** enable PR review (`GROK_AUTH_JSON`, optional vars, rotation, fork/draft policy, trusted-ref note).
- **README:** short pointer to optional same-repo PR Grok review.
- **Workflow header comments:** security invariants.

## Implementation notes (for planning)

1. Confirm companion `--json` stdout shape for completed review jobs (`result.review`, skip fields) against current code; lock fixtures to that shape.
2. Prefer `gh api repos/.../pulls/.../reviews` with JSON file input (escape-safe) over hand-built review strings.
3. Reuse mental model from Grok Build bundled review skill for RIGHT-side line validation, but implement in deterministic Node (not agent orchestration).
4. Do not change default `ci.yml` permissions.
5. Do not add env-key auth without a separate design revision.
6. **Bootstrap:** the first PR that lands this feature cannot fetch CI scripts from an older `main` that lacks them. Landing order: merge scripts + workflow on `main` first (or temporarily allow trusted tree = PR head only for the bootstrapping PR behind a short-lived `vars` flag), then enforce trusted-ref-from-main thereafter. The design end-state remains “trusted ref only.”
7. Job should no-op with a clear log line (success) when `GROK_AUTH_JSON` is unset **only if** product wants “optional until secret configured”; **v1 normative behavior is fail** when the workflow runs without the secret so misconfiguration is visible. Repos that have not enabled review simply leave the workflow file unmerged or disable the workflow.

## Open follow-ups (explicitly deferred)

- API-key CI auth exception in plugin SPEC
- Fail-on-severity / `REQUEST_CHANGES`
- Fork maintainer `workflow_dispatch` review
- Composite Action extraction
- Linux authenticated provider qualification matrix (smoke may surface issues; track as ops, not design change unless Linux is broken)

## Success criteria

- Same-repo non-draft PR triggers one review job on hosted Ubuntu.
- Review code path uses plugin headless explore from a trusted ref.
- Findings appear as a team-visible `COMMENT` review with inline comments when mappable.
- Findings never fail the check; missing/expired auth fails clearly.
- Offline tests cover posting mapper without network or Grok.
- CONTRIBUTING documents secret setup and rotation.
