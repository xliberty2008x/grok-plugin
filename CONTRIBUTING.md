# Contributing

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

Documentation, tests, and internal refactors do not independently require a
version bump unless they alter shipped behavior, packaging, or compatibility.
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
npm run codex:update-local
```

The command runs the complete repository check, requires the clean-profile
installed-Codex PTY regression, verifies that the configured
`grok-companion` marketplace resolves to this checkout, refreshes
`grok@grok-companion`, and compares every installed file with the source plugin
by path, size, and SHA-256. It fails instead of claiming success if Codex is
missing, the marketplace points elsewhere, the version differs, or the cached
snapshot is stale. Start a new Codex task after it passes; the current task does
not provide trustworthy evidence for the refreshed build.

Default GitHub CI exposes three different claims:

- `PTY ingress` recreates the production EAGAIN ordering on a genuinely
  nonblocking PTY on hosted Linux and macOS runners, without claiming install
  coverage.
- The operating-system/Node matrix validates the full provider-neutral source
  suite.
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

## Optional Grok PR review (GitHub Actions)

Same-repository, non-draft pull requests can run the plugin's headless Grok
review and post an informational GitHub review (`COMMENT`) with inline findings
when mappable. Findings never fail the check; only auth, CLI, schema, or API
errors fail the job.

### Enable

1. Create a dedicated SuperGrok / `grok login` session (prefer a bot identity).
2. Copy the session file contents into a repository secret named `GROK_AUTH_JSON`
   (the full `auth.json` body).
3. Merge the workflow `.github/workflows/grok-pr-review.yml` (already in tree when
   this section applies).
4. Optional repository variables:
   - `GROK_PR_REVIEW_TRUSTED_REF` — git ref for the review runtime (default `main`)
   - `GROK_CLI_VERSION` — `@xai-official/grok` version (default `0.2.99`)

### Policy

- **Forks** are skipped (secrets are unavailable and `pull_request_target` is not used).
- **Drafts** are skipped until `ready_for_review`.
- Runtime scripts and the companion binary path come from the **trusted ref**, not
  from the PR tip. The PR head is only the git tree under review.
- Rotate `GROK_AUTH_JSON` when jobs fail with authentication errors.

### Local dry-run of the poster

```bash
node scripts/ci/post-grok-review.mjs \
  --job-json /path/to/review-job.json \
  --diff /path/to/pr.diff \
  --owner OWNER --repo REPO --pr N --head-sha SHA \
  --dry-run
```
