# Superpowers-style CI review engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise CI Grok PR review quality to Superpowers code-reviewer standards by vendoring the checklist into the companion review prompt, while keeping the trusted headless explore engine and host-side COMMENT post.

**Architecture:** Extend `plugins/grok/prompts/review.md` with Superpowers methodology (what to check, severity calibration, strengths + assessment). Update GitHub review footer attribution. Document local Superpowers vs CI. No runner plugin install.

**Tech Stack:** Existing Companion headless explore, GitHub Actions, Node tests.

**Spec:** `docs/superpowers/specs/2026-07-15-ci-superpowers-review-engine-design.md`

---

## File map

| Path | Responsibility |
| --- | --- |
| `plugins/grok/prompts/review.md` | Superpowers-style review contract + JSON schema |
| `scripts/ci/lib/build-pr-review-payload.mjs` | Footer: Superpowers-style Companion review |
| `tests/ci-post-grok-review.test.mjs` | Footer assertion |
| `CONTRIBUTING.md` | Local Superpowers vs CI note |
| `docs/superpowers/specs/2026-07-15-ci-superpowers-review-engine-design.md` | Design (already written) |

---

### Task 1: Failing test for review footer attribution

**Files:**
- Modify: `tests/ci-post-grok-review.test.mjs`

- [ ] **Step 1: Add assertion that payload body mentions Superpowers-style Companion**

```js
test("buildPrReviewPayload footer attributes Superpowers-style Companion review", () => {
  const right = new Set(["src/a.js:1"]);
  const r = buildPrReviewPayload({
    job: sampleJob([
      {
        severity: "high",
        title: "Missing check",
        body: "Add a guard.",
        file: "src/a.js",
        line: 1
      }
    ]),
    headSha: "abc123",
    rightSideLines: right
  });
  assert.equal(r.skip, false);
  assert.match(r.payload.body, /Superpowers-style/i);
  assert.match(r.payload.body, /Companion/i);
});
```

- [ ] **Step 2: Run test — expect FAIL until footer updated**

```bash
node --test tests/ci-post-grok-review.test.mjs
```

---

### Task 2: Footer + Superpowers prompt contract

**Files:**
- Modify: `scripts/ci/lib/build-pr-review-payload.mjs`
- Modify: `plugins/grok/prompts/review.md`

- [ ] **Step 1: Change footer string**

From:

```js
"_Automated Grok Companion review (informational; does not block merge)._"
```

To:

```js
"_Automated Superpowers-style Grok Companion review (informational; does not block merge)._"
```

- [ ] **Step 2: Extend `plugins/grok/prompts/review.md` with Superpowers checklist** (keep JSON schema and untrusted-evidence rules; add What to Check, Calibration, summary must include strengths + readiness)

- [ ] **Step 3: Re-run tests — expect PASS**

```bash
node --test tests/ci-post-grok-review.test.mjs
```

---

### Task 3: CONTRIBUTING note

**Files:**
- Modify: `CONTRIBUTING.md` (Grok PR Review section)

- [ ] Document:
  - CI uses Superpowers **methodology** via companion prompt (not Superpowers plugin install on runner)
  - Local interactive Superpowers / Grok `/review` is optional and separate

---

### Task 4: Verify, PR, merge, smoke e2e

- [ ] `node --test tests/ci-post-grok-review.test.mjs` and broader offline suite if cheap
- [ ] Commit, push, open PR
- [ ] Merge so trusted `main` has new prompt (workflow trusts main for companion + prompts)
- [ ] Open tiny smoke PR; confirm **Grok PR Review** job succeeds and review post or skip works

---

## Self-review

| Spec requirement | Task |
| --- | --- |
| Superpowers checklist in prompt | Task 2 |
| Host COMMENT + security unchanged | No workflow/auth changes |
| Footer attribution | Tasks 1–2 |
| Local vs CI docs | Task 3 |
| E2E smoke | Task 4 |
| No Superpowers install on runner | Explicit non-goal; no install step |
