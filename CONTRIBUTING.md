# Contributing

## Pull requests and protected `main`

External contributors open pull requests **from a fork** into `main`. Direct
pushes to `main` are not the contribution path.

Before merge, wait for all of:

- Hosted CI (`CI required`)
- GitGuardian
- Grok review
- Resolved discussion threads
- Owner review

Release versioning, qualification evidence, and host-boundary rules below still
apply to any release-bearing change; this section only documents the fork-PR
merge gates for protected `main`.

## Source-structure policy

Run the executable structure policy directly when adding or moving JavaScript:

```text
npm run check:source-structure
```

The checked-in policy scans handwritten `.js`, `.mjs`, and `.cjs` under the
plugin, script, and test roots. It measures physical lines and
Acorn function spans, static ESM cycles, facade direction, and ordinal
fragments. The budgets are 1,500/250 lines for product files/functions,
2,000/350 for tooling, 2,000/400 for tests, and 300 lines for registered
facades and entrypoints with a 250-line function budget. Canonical roots and
extensions are fixed; nested `build`, `coverage`, `dist`, and `vendor`
directories do not create an exemption. Relative static imports into `.git`
or `node_modules` fail the ratchet.

Each source is capped at 2 MiB before parsing, and a handwritten physical line
may not exceed 4 KiB. This rejects single-line source blobs and bounds parser
input; it is not permission to compress ordinary declarations to preserve a
legacy cap. Reviewers should require a named extraction when a cohesive data or
behavior domain would otherwise make a capped file grow.

The checked-in policy runs in `ratchet` mode. Existing bounded debt remains
visible as warnings, while new debt, cap growth, stale caps, new cycles, new
ordinal fragments, and reverse facade imports fail the gate. Malformed policy,
parser failure, unreadable source, or a symlink inside a source root also fails
closed. The promotion conditions and digest history are recorded in
`docs/issues/56-source-structure-policy.md`.

Legacy allowances are exact paths, not patterns. Their original line count is
immutable and protected by the repository-pinned baseline digest; the separate
current cap cannot grow, and a reduction must lower or resolve the cap in the
same change. The complete current policy boundary has its own repository-pinned
digest so active caps, facade registration, provenance, scan coverage, and
resource limits cannot be silently weakened. A resolved file cap is `null`;
resolved function caps are removed from the active vector while their
immutable history remains. Long-function
allowances are sorted per-function vectors. Every allowance needs an issue,
rationale, and observable removal criterion.
Do not add spare capacity, wildcard exceptions, fake `part1`/`part2` modules,
empty facade indirection, or generated-file headers to evade the policy.

Entrypoints and orchestrators own argument handling and sequencing only.
Validation, protocol, identity, persistence, atomic mutation, and cleanup
authority belong in named domain modules. A structural extraction MUST NOT
create a second lifecycle authority, durable store, or hidden implementation
dependency routed back through a public facade.

## Versioning convention and change taxonomy

The repository follows Semantic Versioning, with an explicit rule for the
unstable `0.x` phase. A version already present on the base branch is historical
and MUST NOT be reused for a new release-bearing implementation tranche.

Classify the complete change set by its highest-impact product change:

| Change class | Meaning | Version effect |
|---|---|---|
| `patch` | Backward-compatible defect, performance, or security correction with no public contract change | Increment patch |
| `feature` | New backward-compatible user-facing capability | Increment minor |
| `breaking` | Public command, manifest, state schema, execution profile, security boundary, or compatibility contract changes | Increment minor while the base major is `0`; increment major from `1.0.0` onward |

Any change under `plugins/grok/` is a plugin-byte change and MUST bump the
synchronized active development version. Documentation, tests, and tooling
outside that tree do not independently require a version bump.
`0.3.0-dev.2` is burned and MUST NOT be reused; the next plugin-byte ship is
`0.3.0-dev.3`.
When a tranche contains multiple classes, the highest-impact class wins.

Each release-bearing branch MUST update `release-plan.json` before product
implementation is merged. The plan records the stable base, change class,
target version, stage, and reasons. Development uses `<target>-dev.N`;
qualification uses `<target>-rc.N`; the final release removes the prerelease
suffix without changing the target core.

The version helper refuses a version that disagrees with the release plan:

```text
npm run version:bump -- <version>
npm run version:check
```

The changelog's first version heading MUST match the active package version.
Previously merged stable sections are immutable history; new work goes above
them under the new development version.

Promotion to `release_candidate` or `release` also requires
`tests/e2e-results/qualification-<target>.json`. The aggregate record binds the
exact working-tree payload with a deterministic `sourceDigest`; qualification
records themselves are excluded from that digest so committing the evidence is
not self-referential, while any later tracked or untracked source change
invalidates it. Because this package advertises both hosts, the record MUST
contain separate `codex` and `claude-code` evidence, including each installed
artifact digest, environment versions, authenticated/natural-flow flags, and
boundary outcomes. RC promotion requires both hosts to pass
`runtime_ingress`, `artifact_install`, `provider_transport`, and
`worker_execution`; stable promotion additionally requires natural installed
host flow plus `host_orchestration` and `host_verification` for both hosts.

Commit prefixes follow the same taxonomy: `fix:` normally maps to `patch`,
`feat:` maps to `feature`, and `!` or a `BREAKING CHANGE` footer maps to
`breaking`. The release plan, not the prefix alone, is authoritative for a
mixed tranche.

## Branch hygiene

After GitHub reports a feature-branch pull request as MERGED, any agent may
delete the remote and local feature branch. Do not leave merged topic branches
as repository clutter. Protected branches such as `main` are never deleted.

## Verification boundary taxonomy and conviction rules

Test evidence is valid only for the boundary it actually crosses. Use these
names consistently in issues, pull requests, changelogs, and release records:

| Boundary | What the evidence must exercise |
|---|---|
| `runtime_ingress` | The installed wrapper's argv, nonblocking PTY behavior, delayed or split stdin delivery, private framing/no-echo guarantee, and public exit/error behavior before a job exists |
| `host_orchestration` | The real Codex or Claude process/session lifecycle, skill/tool sequencing, handle retention, monitoring, and user-visible behavior |
| `artifact_install` | Marketplace discovery, installation into a clean host profile, installed cache contents, and execution from that installed snapshot |
| `provider_transport` | Runtime-to-provider launch, ACP framing, authentication classification, model/effort routing, and cancellation |
| `worker_execution` | The delegated worker profile, tools, workspace effects, structured report, and scope enforcement |
| `host_verification` | Host-owned checks, recorded outcomes, continuation checkpoints, and final integration judgment |

Do not promote evidence across boundaries. In particular, an in-tree fake ACP
test that bypasses installation does not prove `runtime_ingress`,
`artifact_install`, or `host_orchestration`. A clean marketplace install that
executes the cached wrapper with a fake provider can prove `artifact_install`
and deterministic `runtime_ingress`, but not authenticated provider behavior or
natural `host_orchestration`. A direct authenticated runtime test likewise does
not prove natural host orchestration or plugin installation.

Changes to `runtime_ingress` MUST include adversarial scheduling coverage for the
relevant stream contract (start before data, delayed and split writes, explicit
framing, PTY echo suppression, and nonblocking descriptors where supported).
Changes to shipped runtime or packaging MUST pass an installed-snapshot test
from a clean host profile.
The installed-snapshot command is:

```text
npm run test:installed-codex
```

### Applying a development build to Codex

Editing this checkout is not a supported Codex hot-reload workflow. An already
open Codex task may retain skill text loaded at task start while a same-version
development reinstall refreshes files behind its runtime paths. That mixed
state must not be used to test or qualify a build.

Use the repository-owned update command from the repository root:

```text
npm run qualify
npm run codex:update-local
```

`npm run qualify` is the expensive developer/release command. It streams
`npm run check`, then writes a receipt bound to the exact plugin inventory,
package metadata, and marketplace digest.

`npm run codex:update-local` (alias `npm run codex:install`) does not run the
repository suite. It verifies that receipt, refreshes `grok@grok-companion`,
and compares every installed file with the source plugin by path, size, and
SHA-256. Missing, stale, or mismatched receipts fail in seconds with guidance
to requalify. It also fails if Codex is missing, the marketplace points
elsewhere, or the version differs. Start a new Codex task after it passes; the
current task does not provide trustworthy evidence for the refreshed build.

Default GitHub CI exposes three different claims:

- `PTY ingress` recreates the production EAGAIN ordering on a genuinely
  nonblocking PTY on hosted Linux (pull-request required) and hosted macOS
  (main/dispatch only), without claiming install coverage.
- The operating-system/Node matrix validates the full provider-neutral source
  suite. Ubuntu cells are pull-request required; hosted macOS cells run on
  `main` and `workflow_dispatch` only.
- `Installed Codex snapshot` uses a self-hosted macOS runner with the
  `codex-plugin` label when the repository Actions variable
  `CODEX_PLUGIN_RUNNER_ENABLED` is `true`. It runs only for trusted `main`
  pushes or explicit workflow dispatch, never for pull requests. It installs
  from a clean `CODEX_HOME` and executes the cached snapshot. Until that runner
  is configured, this check is skipped and `artifact_install` remains a local
  release gate rather than a hosted-CI claim.
- `Natural Codex + real Grok` is a second protected, opt-in main/workflow job
  enabled by `CODEX_GROK_NATURAL_E2E_ENABLED=true` on a runner labeled
  `grok-authenticated`. It installs the tested snapshot, starts a new natural
  Codex task, requires the installed `$grok:rescue` skill to complete against
  the real provider, validates the persisted job and host-verification record,
  checks worktree immutability, and proves transient credential/profile cleanup.
  This is the only default workflow job that crosses provider transport,
  worker execution, and natural Codex host orchestration together.

A production incident MUST gain a regression that recreates the failing event
ordering and artifact boundary, not merely the final error string. A failure
before provider launch is a plugin/runtime-ingress or host-orchestration failure
and MUST NOT be reported as a Grok provider failure. Any untested boundary
remains explicitly unqualified; `runtime_ingress`, `host_orchestration`, or
`artifact_install` failures block release.
