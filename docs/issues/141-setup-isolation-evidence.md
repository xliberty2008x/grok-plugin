# Issue 141: setup isolation and failure contract

Base: `f64f9c76fb8fa69a408d9086cfa471f25a66010e`.

## Donor evidence

- Codex donor `db52e28f4d9ded852ab3942cea316258ae4ef346`,
  `plugins/codex/commands/setup.md`: the installed wrapper owns setup and the
  host forwards its final output. Preserve that boundary.
- Grok audit donor `47348d13ec4508dcfe440e34c6d511bb02998fb2`,
  `crates/codegen/xai-grok-agent/src/prompt/skills.rs`: native `.grok` and
  `.agents` directories are discovered along cwd through the Git root;
  `[skills].ignore` filters canonical path prefixes, not globs.
- Current Grok donor `37949780c144e37df692e3d669051a21fec24f20`,
  `crates/codegen/xai-grok-agent/src/prompt/skills.rs` and `src/repo.rs`:
  the same filter remains; canonical cwd avoids historical lexical ancestor
  stopping problems. Private bundled roots outside the project remain eligible.
- Current donor `crates/codegen/xai-grok-shell/src/inspect/mod.rs` discovers
  vendor inventory with default compatibility then marks disabled entries.
  Cross-client environment switches alone do not remove the inspect inventory.

Rejected patterns: treating disabled inventory as safe; accepting arbitrary
bundled labels; deleting inspection; ignoring the filesystem root; suppressing
process identity failures. Donor behavior is design evidence, not local runtime
qualification.

## Implementation

Setup and headless review now write a private skill-ignore configuration for
the canonical project root. Inspection still rejects escaping symlinks, external
plugins/hooks/MCP servers/agents, and skills outside permitted bundled roots.
Inspection failures emit a stable probe identifier without raw provider output.
Setup returns nonzero for `ready: false` and reports a validated pinned version
when pin validation completed. Earlier readiness receipts remain revoked on
failure. The plugin-byte change advances the synchronized development version
from dev.17 to dev.18.

## Evidence and limits

The installed dev.15 command was run once on 2026-09-14. It returned status 0,
`not ready`, and a different earlier blocker:

```text
macOS spawned a different Grok text mapping than the durable intent (missing,inode,size,path).
```

Thus the incorrect exit contract was reproduced, but the original installed
external-skill failure could not be reached in that invocation. No isolation
or executable-identity gate was bypassed. Real successful setup and a real
bounded delegated task remain required; do not close issue 141 or claim
implementation-lifecycle qualification from this patch.

The new regression first failed with `loaded external skills` in the controlled
provider fixture, then passed after the private ignore configuration was added.
The fixture models the donor path-prefix filter. Native .agents/.grok success,
external inventory rejection, escaping symlink rejection, private-home cleanup,
readiness exit status and sanitized diagnostics have focused coverage. These
are supporting deterministic/installed-wrapper fixture results, not a real
Grok provider lifecycle.

OCR was initially unavailable. After the user authorized installation, official
OCR v1.12.1 was installed and its delegation preview/rule commands ran against
`b69775de007949ff741c39d6fd3d782067d06a69`. All 19 reviewable files were reviewed,
with zero skipped and no actionable findings; four excluded Markdown files
were additionally inspected. That review applies to that earlier head only.
Cursor subsequently requested the follow-up changes recorded in PR #142.
OCR delegation then reviewed `0db0f2bfd4216ff027e92aa8c47fa01d43724af0`:
24 of 24 reviewable files, zero skipped, no actionable findings; seven excluded
Markdown files were additionally inspected. These are historical review records,
not approval of later commits. PR #142 records subsequent reviews with their
exact commit IDs; merge readiness requires a fresh review of the final head.

## Local validation

- `npm run validate`: passed (existing repository legacy warnings remain).
- `node --test tests/setup-isolation.test.mjs tests/setup-diagnostics.test.mjs tests/provider.test.mjs tests/installed-codex.test.mjs`: 60/60 passed, zero skips.
- `node --test --test-name-pattern='setup|receipt recovery' tests/runtime.test.mjs`: 5/5 passed.
- `node --test tests/deterministic-sharding.test.mjs tests/version-policy.test.mjs`: 17/17 passed.
- Fresh native Codex review: no actionable introduced correctness/security findings in all ten scoped runtime/test files; its independent new-suite run passed 8/8.
- Full deterministic repository qualification and hosted CI were not run.

## Cursor follow-up

Cursor requested changes on `b69775de` after that local review. The follow-up
clarifies stdout forwarding on nonzero setup exits in both host facades,
synchronizes the owner-controller ACP version and adds it to bump/validation
coverage, and aligns review-home subagent/LSP configuration with task homes.
The bundled-skill regression now checks the actual fixture inspection inventory.
The changelog qualification status and the version-policy pointer were corrected.

Both hosted shard-3 failures on the earlier head came from the exact legacy
temp-prefix inventory test. New fixtures now use the existing default temp
namespace; cleanup allowlists and safety checks were not relaxed. The exact
failing test passes locally after this change. New-head hosted checks and Cursor
review are required before merging; real installed qualification remains pending.
