# Superpowers-style CI review engine — Design

**Date:** 2026-07-15  
**Status:** Approved for implementation (user: proceed e2e)  
**Repo:** grok-plugin  
**Depends on:** `docs/superpowers/specs/2026-07-15-grok-pr-review-ci-design.md` (shipped)

## Problem

CI already runs Grok Companion headless `explore` review and posts `COMMENT` reviews. That path does **not** use Superpowers `requesting-code-review` / Claude `pr-review-toolkit`, and interactive Grok `/review` (PENDING, subagents, `gh` from the agent) is unsafe and unsuitable for Actions.

Users still want Superpowers-grade review quality bars (plan alignment, severity calibration, strengths + issues, production readiness) on every PR without installing Claude or running interactive skills on the runner.

## Goals

1. Bake **Superpowers code-reviewer methodology** into the CI review contract (prompt) used by the trusted companion path.
2. Keep the **existing security and post model** (trusted runtime, staged `GROK_AUTH_JSON`, host-side `COMMENT`, findings never fail the job).
3. Attribute reviews so humans know the engine is Superpowers-style Companion review.
4. Document why interactive Superpowers / Claude PR-review plugins are **not** installed on the runner, and how local Grok can still use them.

## Non-goals

- Running Superpowers skills via skill tools / `spawn_subagent` inside Actions
- Installing Claude Code or `pr-review-toolkit` agents on the runner
- Grok bundled `/review` PR mode (PENDING + agent-held `gh`)
- Multi-agent parallel review aspects (comments/tests/types agents)
- Changing auth, fork/draft policy, or fail-on-findings policy
- Replacing `explore` transport with a full-tool agent (reopens sandbox surface; future option)

## Product decisions

| Topic | Decision |
| --- | --- |
| Engine | Same Companion headless `explore` + JSON schema |
| Methodology | Vendored Superpowers `code-reviewer` checklist in `plugins/grok/prompts/review.md` |
| Severity | Map Superpowers Critical→`critical`, Important→`high` (or `medium` when non-blocking), Minor→`low`/`info` |
| Post | Unchanged host-side formal `COMMENT` |
| Runner install | Do **not** clone Superpowers plugin onto the runner |
| Local Grok | CONTRIBUTING notes: optional Superpowers plugin for interactive workflows |

## Why not install Superpowers on the runner?

| Approach | Why rejected for v1 CI |
| --- | --- |
| Install Superpowers plugin + run skill | Skills expect interactive orchestration, subagents, and user submit of PENDING reviews |
| Claude `pr-review-toolkit` | Claude Code Task agents; not available under `@xai-official/grok` headless |
| Grok bundled `/review --pr` | Posts PENDING with agent `gh`; violates host-post + token split |
| Full-tool headless agent + Superpowers prompt | Higher sandbox risk; larger e2e surface; defer |

Vendoring the **prompt methodology** keeps trust boundaries identical to the green CI path while raising review quality bars.

## Architecture (delta only)

```text
pull_request (same-repo, non-draft)
        │
        ▼
  trusted companion review  ──prompt──►  review.md
                                         (v1 contract + Superpowers checklist)
        │
        ▼
  review-job.json  →  post-grok-review.mjs  →  COMMENT
  (footer: Superpowers-style Companion review)
```

### Files

| Path | Change |
| --- | --- |
| `plugins/grok/prompts/review.md` | Add Superpowers-style checklist + severity mapping; keep JSON schema |
| `scripts/ci/lib/build-pr-review-payload.mjs` | Footer attribution string |
| `docs/superpowers/plans/2026-07-15-ci-superpowers-review-engine.md` | Implementation plan |
| `CONTRIBUTING.md` | Local Superpowers vs CI methodology note |
| `tests/ci-post-grok-review.test.mjs` | Assert footer text |

## Severity mapping

| Superpowers label | Companion JSON `severity` | When |
| --- | --- | --- |
| Critical (Must Fix) | `critical` | Bugs, security, data loss, broken functionality |
| Important (Should Fix) | `high` | Blocking architecture/test gaps; use `medium` if should-fix but not merge-blocking |
| Minor (Nice to Have) | `low` or `info` | Style, polish, optional docs |

Summary field should briefly note strengths and overall readiness (Superpowers “Assessment”), still as free-text `summary` (no new schema fields).

## Security

Unchanged from v1 CI design: no `pull_request_target`, trusted scripts from `main` (or `GROK_PR_REVIEW_TRUSTED_REF`), PR head is git target only, `GROK_AUTH_*` never coexists with `GITHUB_TOKEN` in the poster process, prompt treats repo content as untrusted evidence.

## E2E acceptance

1. Offline tests pass.
2. PR with prompt/footer change merges to `main` (trusted runtime picks it up).
3. Smoke same-repo non-draft PR runs **Grok PR Review** green and posts a review body containing Superpowers-style attribution (when findings exist) or completes with skip on empty findings without job failure.

## Future options (out of scope)

- Optional second job: full-tool headless agent with read-only tools + Superpowers template
- Optional install of Superpowers skills under isolated `GROK_HOME` for interactive self-hosted runners only
