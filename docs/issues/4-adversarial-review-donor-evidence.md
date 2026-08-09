# Issue #4: adversarial review plan/progress-only pass — donor evidence

> Design evidence for adversarial-only semantic completion validation. Donor
> behavior is not local or installed-plugin qualification.

## Problem

Live issue #4 reproduced plan/progress-only zero-finding adversarial payloads
that structurally satisfied the shared review schema. `validateReview` derived
`verdict: pass` from empty `findings`, so incomplete “I will review…” summaries
became terminal pass after `EndTurn`. Ordinary reviews in the same campaign
were substantive negative controls. Shared structural validation, schema,
provider transport, structured review, stop review, and security profiles must stay
unchanged.

## Decision

Specialize only at the companion `runStructuredReview` call where `job.kind` is
available:

- Ordinary review passes the original common options unchanged (generic
  `validateReview`, `DEFAULT_REVIEW_REPAIR_PROMPT`, one-provider-call success).
- Adversarial review wraps `validateReview` with
  `validateAdversarialReview` and a dedicated repair prompt.
- Zero findings require the explicit completed grammar
  `No material findings: Challenged: ... Assessment: ... Decision: ship.`
  with exact punctuation and substantive challenge and assessment segments.
- Each segment has bounded length and lexical-diversity floors; reserved markers,
  repeated placeholders, explicit future/incomplete work, and conflicting
  decisions fail closed.
- Bounded plan/progress-leading forms (`I will` / `I'll` / `I need to` /
  `I am reviewing` / `Inspecting` / `Reviewing` / `Searching` / `Locating`)
  are rejected as `E_SCHEMA` without echoing provider or repository content.
- Exactly one same-session repair uses existing `runStructuredReview` behavior.
  A second semantic failure remains `E_SCHEMA` and never publishes terminal pass.
- Findings-bearing adversarial payloads keep the canonical
  `needs_changes` path without the no-findings prefix.
- Foreground and background/status-result paths share the same selector;
  workspace mutation, security profile, and session cleanup guarantees are
  unchanged.

## `openai/codex-plugin-cc` donor

- Repository and pinned revision:
  [`openai/codex-plugin-cc@db52e28f4d9ded852ab3942cea316258ae4ef346`](https://github.com/openai/codex-plugin-cc/tree/db52e28f4d9ded852ab3942cea316258ae4ef346)
- Exact files inspected at that revision:
  [`plugins/codex/commands/adversarial-review.md`](https://github.com/openai/codex-plugin-cc/blob/db52e28f4d9ded852ab3942cea316258ae4ef346/plugins/codex/commands/adversarial-review.md),
  [`plugins/codex/prompts/adversarial-review.md`](https://github.com/openai/codex-plugin-cc/blob/db52e28f4d9ded852ab3942cea316258ae4ef346/plugins/codex/prompts/adversarial-review.md), and
  [`plugins/codex/commands/review.md`](https://github.com/openai/codex-plugin-cc/blob/db52e28f4d9ded852ab3942cea316258ae4ef346/plugins/codex/commands/review.md).
- Adversarial skill / routing keeps normal and adversarial surfaces separate and
  requires a ship/no-ship style assessment rather than a progress note as the
  terminal product of an adversarial pass.

Useful invariants reused:

- Keep normal-review and adversarial-review routes separate.
- Require an explicit completed adversarial assessment (ship / no-ship /
  material findings), not only structured JSON shape.
- Do not weaken the shared findings-derived pass/needs_changes rule for
  ordinary review.

Rejected incompatible patterns:

- Model-controlled `verdict` fields.
- Parsing raw free-form prose outside the structured `summary`/`findings`
  contract.
- Merging adversarial semantics into the shared ordinary validator or schema.
- Widening repair beyond one same-session turn.

## `xai-org/grok-build` donor

- Public protocol audit revision:
  [`xai-org/grok-build@47348d13ec4508dcfe440e34c6d511bb02998fb2`](https://github.com/xai-org/grok-build/tree/47348d13ec4508dcfe440e34c6d511bb02998fb2)
- Current main checked for drift:
  [`xai-org/grok-build@e5478eff1e4050558e12e1328b85e6616632efb6`](https://github.com/xai-org/grok-build/tree/e5478eff1e4050558e12e1328b85e6616632efb6)
- Exact headless transport file inspected at both revisions:
  [`crates/codegen/xai-grok-pager/src/headless.rs` at the audit pin](https://github.com/xai-org/grok-build/blob/47348d13ec4508dcfe440e34c6d511bb02998fb2/crates/codegen/xai-grok-pager/src/headless.rs) and
  [`headless.rs` at current main](https://github.com/xai-org/grok-build/blob/e5478eff1e4050558e12e1328b85e6616632efb6/crates/codegen/xai-grok-pager/src/headless.rs).

Useful invariants reused:

- Semantic completion belongs above structured headless transport.
- `EndTurn` (or equivalent stop reason) alone is not proof that the product
  contract completed.
- Transport and stop-reason handling stay provider-owned; product validators
  decide acceptance after structured output is available.

Rejected incompatible patterns:

- Treating headless `EndTurn` as adversarial completion proof.
- Adding ACP fallback for review transport.
- Changing provider transport, session cleanup, or profile enforcement to
  compensate for incomplete product payloads.

## Local adaptation

| File | Role after fix |
| --- | --- |
| `plugins/grok/scripts/lib/adversarial-review.mjs` | `validateAdversarialReview` wraps exported `validateReview`; `structuredReviewOptionsFor` selects options by kind |
| `plugins/grok/scripts/grok-companion.mjs` | Compact import + `structuredReviewOptionsFor(job.kind, common)` at the existing `runStructuredReview` seam (no net line growth vs legacy cap) |
| `plugins/grok/prompts/adversarial-review.md` | Exact completed no-findings assessment grammar |
| `plugins/grok/scripts/lib/grok-provider.mjs` | Unchanged (capped); shared structural validator and one-repair loop remain authoritative |
| `tests/adversarial-review.test.mjs` | Focused AC coverage; assigned to deterministic shard 1 only |
| `tests/fake-grok.mjs` | Default zero-finding summary satisfies the completion grammar; optional `reviewSequence` for repair paths |

Deterministic checks prove rejection of plan/progress-only empty findings,
one same-session repair success, double-failure `E_SCHEMA` without pass,
exact completion grammar, findings-bearing needs_changes, ordinary-review
unchanged options and full companion negative control, and adversarial companion
foreground/background paths. Installed real
provider qualification remains a separate host-owned step: qualify the
installed candidate from a separate consumer before merge, then repeat against
the merged installed tree. The deterministic gate proves conformance to the
completion grammar, not the truth of the provider's assessment prose.
