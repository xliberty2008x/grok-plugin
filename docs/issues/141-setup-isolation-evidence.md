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

The requested open-code-review-delegate skill is available, but `ocr` was not
found in PATH or checked local binary locations. Its preview/rule workflow
requires the CLI before it can be reported as completed.

## Local validation

- `npm run validate`: passed (existing repository legacy warnings remain).
- `node --test tests/setup-isolation.test.mjs tests/setup-diagnostics.test.mjs tests/provider.test.mjs tests/installed-codex.test.mjs`: 60/60 passed, zero skips.
- `node --test --test-name-pattern='setup|receipt recovery' tests/runtime.test.mjs`: 5/5 passed.
- `node --test tests/deterministic-sharding.test.mjs tests/version-policy.test.mjs`: 17/17 passed.
- Fresh native Codex review: no actionable introduced correctness/security findings in all ten scoped runtime/test files; its independent new-suite run passed 8/8.
- Full deterministic repository qualification and hosted CI were not run.
