# Issue #52: forward managed-version donor evidence

## Decision

The exact release table is recognition and integrity evidence, not an
upper-version admission list. Stable Grok versions at or above 0.2.99 may use
the `managed-observed` path only when they are the active Grok-managed
installation. Setup privately copies and hashes the candidate before executing
it, then runs current behavior and protocol probes against that copy.

This policy intentionally accepts the supply-chain risk of the initial managed
installation. It does not accept arbitrary unfamiliar executables and does not
turn setup readiness into lifecycle qualification.

## Grok Build donor

- Repository and revision:
  [`xai-org/grok-build@500129c714ad1b10e6095481f4a8387a2ec52649`](https://github.com/xai-org/grok-build/tree/500129c714ad1b10e6095481f4a8387a2ec52649)
- Managed-version detection:
  [`crates/codegen/xai-grok-update/src/version.rs`, lines 419–477](https://github.com/xai-org/grok-build/blob/500129c714ad1b10e6095481f4a8387a2ec52649/crates/codegen/xai-grok-update/src/version.rs#L419-L477)
  reads the active `~/.grok/bin/grok` symlink target without executing it,
  rejects dangling links, distinguishes installer ownership, and parses both
  versioned internal (`downloads`) and npm (`bin`) names as SemVer.
- Atomic updater layout:
  [`crates/codegen/xai-grok-update/src/auto_update.rs`, lines 1266–1337](https://github.com/xai-org/grok-build/blob/500129c714ad1b10e6095481f4a8387a2ec52649/crates/codegen/xai-grok-update/src/auto_update.rs#L1266-L1337)
  downloads a platform-versioned binary below `$GROK_HOME/downloads`,
  smoke-tests it, and atomically swaps `$GROK_HOME/bin/grok` to that verified
  target.
- Rapid release movement is the reproduced compatibility pressure:
  [issue #52](https://github.com/xliberty2008x/grok-plugin/issues/52) records
  this repository's 0.2.112 digest table while the active managed installation
  had already advanced to stable 0.2.114.

Useful invariant: the active installer-consistent versioned target is the
bounded managed source to capture. Rejected pattern: executing an arbitrary
`GROK_BIN` or `PATH` candidate to trust its self-reported version.

## Pinned Codex plugin donor

- Repository and revision:
  [`openai/codex-plugin-cc@db52e28f4d9ded852ab3942cea316258ae4ef346`](https://github.com/openai/codex-plugin-cc/tree/db52e28f4d9ded852ab3942cea316258ae4ef346)
- Availability probe:
  [`plugins/codex/scripts/lib/codex.mjs`, lines 886–903](https://github.com/openai/codex-plugin-cc/blob/db52e28f4d9ded852ab3942cea316258ae4ef346/plugins/codex/scripts/lib/codex.mjs#L886-L903)
  checks that the CLI answers `--version` and that the required advanced
  runtime answers `app-server --help`; it does not reject unfamiliar versions
  through an exact version table.

Useful invariant: a floor plus required behavior/protocol checks is a more
durable compatibility gate than exact-version enumeration. Rejected pattern:
claiming that a successful availability probe qualifies every downstream
lifecycle.

## Adaptation boundary

The plugin reuses the donor layout and probe invariants, not donor updater
machinery. Grok Companion does not download or activate Grok. It validates the
already active managed source, records `managed-observed` provenance, copies
exact bytes into its own immutable private pin, and keeps broker-owned
re-attestation, receipt invalidation, historical-pin retention, kernel mapping
proof, recovery, and Windows execution blocks.
