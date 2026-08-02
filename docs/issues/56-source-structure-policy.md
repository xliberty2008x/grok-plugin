# Issue #56: staged source simplification and executable policy

Issue: <https://github.com/xliberty2008x/grok-plugin/issues/56>

Baseline: `7301afbbbf29afc3690c9d1d4458b8c394bed2bc` (`github/main`,
captured 2026-08-01).

## Decision

Eight-thousand-line handwritten modules are not an acceptable steady state for
this project. Some large modules are temporarily safer than a rushed rewrite,
but their size obscures domain ownership, creates long functions, encourages
reverse imports through public facades, and makes reviews and deterministic
sharding harder.

The first tranche adds an executable policy without pretending that the debt is
already gone. `scripts/source-structure-policy.json` stays in `observe` mode.
It records 45 exact files where either the file or a function is over budget,
the existing six-module static ESM cycle, 14 ordinal test fragments, and a
disposition for every handwritten file above 5,000 lines. Immutable initial
debt/topology is separated from reducible caps and bound by a repository-pinned
SHA-256 digest, so raising both an initial value and its cap cannot bless growth.

## Enforced model

| Category | File budget | Function budget |
| --- | ---: | ---: |
| Product runtime and app source | 1,500 | 250 |
| Tooling scripts | 2,000 | 350 |
| Tests | 2,000 | 400 |
| Registered facade or entrypoint | 300 | 250 |

The checker uses physical LOC, normalizing LF, CRLF, bare CR, U+2028, and
U+2029 without counting a phantom line after a trailing terminator. Acorn
8.15.0 is exact-pinned and measures function declarations, expressions,
arrows, object and class methods, getters, setters, async functions, and
generators. Static dependency edges include `import` and re-export sources;
query strings, fragments, and safe percent encoding follow Node file-URL
semantics before graph matching. Dynamic import and `require` do not masquerade
as static edges.

The scan walks the filesystem rather than Git's tracked inventory so new and
untracked source cannot escape. Paths are sorted and rendered with `/` on every
platform. A source-root symlink, unreadable path, parser failure, or malformed
configuration is a hard error even in `observe` mode.

The four scan roots and three JavaScript extensions are exact canonical sets.
Every root must remain a real directory. Nested `build`, `coverage`, `dist`,
and `vendor` directories are scanned as project source; only `.git` and
`node_modules` are skipped, and relative static edges into either are policy
findings. Files larger than 2 MiB and physical source lines above 4 KiB fail
before Acorn parsing, so minification cannot disguise complexity or exhaust the
parser.

### Observe mode

Current file/function debt, cap drift, cycles, ordinal fragments, and reverse
facade imports are warnings. This makes the baseline visible on every normal
`npm run validate` without making the first policy PR impossible to merge.

### Ratchet mode

The tested ratchet engine fails:

- a new over-budget file or function;
- growth above an exact legacy file or per-function cap;
- a stale cap after code shrinks, so the cap must be reduced in the same PR;
- a new or enlarged static ESM cycle;
- an unclassified handwritten source above 5,000 lines;
- a new ordinal fragment such as `domain_part3.mjs`;
- a stale, missing, or category-drifted exception.
- a product/tooling dependency routed backward through a registered facade.

Legacy debt itself remains visible as warnings. An exception cannot be a
wildcard and cannot reserve spare capacity. `initialDebt`, `initialCycles`, and
`initialOrdinalFragments` are immutable digest inputs. Separate active file,
function, cycle-component, and ordinal-fragment caps may only shrink or split
within those initial sets. A resolved file uses `lineCap: null`; a resolved
function disappears from the active function vector while its initial key/span
remains in `initialDebt`. Regressions against resolved caps fail in ratchet
mode. Each active debt record also carries its issue, rationale, and observable
removal criterion.

A separate repository-pinned current-policy digest binds the active caps,
cycle/fragment caps, dispositions, facade registry, canonical scan boundary,
resource ceilings, mode, and baseline provenance. Lowering or resolving debt
therefore requires an explicit digest update; silently reopening a previously
lowered cap fails validation.

## Anti-gaming rules

- There is no minimum module size and no target module count. Split by domain,
  not merely to make the counter green.
- Numbered production or test fragments are prohibited after the baseline.
  Existing `_partN` test loaders are temporary debt, not a recommended shape.
- A facade must stay a small public boundary. Product implementation should
  import domain modules, not route dependencies back through a facade.
- Moving code into one giant function does not help because function spans are
  independently budgeted.
- Packing code onto one giant physical line does not help because the 4 KiB
  line ceiling is independent of LOC and function spans.
- Entrypoints and orchestrators own argument handling and sequencing only;
  validation, protocol, identity, persistence, atomic mutation, and cleanup
  authority belong in named domain modules without a duplicate store or
  lifecycle authority.
- Adding a generated-file comment or moving code below a directory named
  `build`, `coverage`, `dist`, or `vendor` does not exempt it. Canonical source
  roots remain fail closed.
- A cohesive exception is possible only as an exact, reviewed entry with a
  concrete removal condition. `worker-owner-lifecycle.mjs` is the current
  example that may justify a temporary cohesive disposition, but it still has
  no right to grow.

## Staged refactor

1. **Policy in observe mode.** Land the checker, baseline, focused tests,
   contribution rule, and validation wiring.
2. **Task-context pilot.** Extract scope/context/Git-observation domains behind
   the exact `task-contract.mjs` named-export facade. Redirect
   `worker-worktree.mjs` to the domain module and remove the current six-node
   cycle. Preserve validation, serialization, digests, error text, and privacy.
3. **Installed runner.** Split fixtures, lifecycle helpers, scenarios, and
   cleanup behind the one installed-runner entrypoint. Run the smallest real
   installed vertical after each lifecycle-sensitive change.
4. **Provider and control plane.** Separate provider environment, transport,
   command execution, companion command domains, and runtime/control-plane
   tests. Preserve fail-closed capabilities and public facade exports.
5. **Worker mutation.** Split admission, provisioning, dispatch, cancellation,
   and terminal-transition domains. `WorkerService` and durable worker records
   remain the sole lifecycle and state authority.
6. **Evidence last.** Separate evidence validation, signing, promotion, and
   qualification only after runtime boundaries are stable. Source-bound digests
   may change because files move; canonical algorithms and same-input outputs
   must not.

Final acceptance is: no handwritten JavaScript file above 5,000 lines, no
ordinal aggregate wrappers, zero static ESM cycles, checked-in `ratchet` mode,
and focused, full deterministic, and relevant installed lifecycle gates green.

## Implementation result

The structural extraction is complete on the issue branch. The former giga
modules are now stable boundaries over named domains:

| Boundary | Current lines | Preserved role |
| --- | ---: | --- |
| `task-contract.mjs` | 39 | exact named-export facade |
| `grok-provider.mjs` | 97 | exact provider API facade |
| `grok-companion.mjs` | 31 | executable command entrypoint |
| `test-installed-worker-mcp.mjs` | 131 | inert installed-lifecycle orchestrator |
| `worker-mutation.mjs` | 85 | exact mutation API facade |
| `worker-broker-evidence.mjs` | 159 | public evidence facade without protected authority |
| `worker-broker-evidence.test.mjs` | 9 | proof-compatible semantic test entrypoint |

The test entrypoint retains the Phase 0 command and producer-v5 manifest digest
while importing nine named semantic suites in their original registration
order. The former `_part1` through `_part9` files are gone; the structure suite
remains a separate ordinary deterministic test.

The ratchet engine now scans 314 files with zero errors, zero dependency
cycles, zero ordinal fragments, and 35 explicitly capped legacy warnings. No
handwritten JavaScript file exceeds 5,000 lines; the largest remaining file is
`tests/worker-protocol.test.mjs` at 4,635 lines. Immutable initial debt, cycle,
and ordinal history remains digest-pinned even though the targeted giga-file,
cycle, and ordinal caps have been retired.

Checked-in mode intentionally remains `observe`. Promotion to `ratchet` still
requires the two consecutive `main` CI runs below across the supported Node and
OS matrix; a local issue branch cannot honestly satisfy that host condition.

## Promotion from observe to ratchet

Change the checked-in mode only after all of these are true:

1. Every handwritten file above 5,000 lines has an explicit disposition and
   linked issue.
2. The checker is green in two consecutive `main` CI runs across Node 18 and 22
   on Linux, macOS, and Windows, with no new or unclassified warning and no
   parser/platform false positive.
3. The task-context pilot has landed, the cycle is removed, and its focused,
   full deterministic, and relevant installed checks pass.
4. Review confirms that caps only moved downward and every remaining exception
   still has an observable removal condition.

## Donor evidence

### `openai/codex-plugin-cc`

- Exact project pin: [`db52e28f4d9ded852ab3942cea316258ae4ef346`](https://github.com/openai/codex-plugin-cc/tree/db52e28f4d9ded852ab3942cea316258ae4ef346), matching `UPSTREAM.md`.
- Relevant files:
  [`plugins/codex/scripts/codex-companion.mjs`](https://github.com/openai/codex-plugin-cc/blob/db52e28f4d9ded852ab3942cea316258ae4ef346/plugins/codex/scripts/codex-companion.mjs)
  and
  [`plugins/codex/scripts/lib/codex.mjs`](https://github.com/openai/codex-plugin-cc/blob/db52e28f4d9ded852ab3942cea316258ae4ef346/plugins/codex/scripts/lib/codex.mjs).
- Useful invariant: keep the public command/package surface distinct from
  provider and process helpers, and preserve attribution when adapting public
  contracts.
- Rejected pattern: the donor's simpler app-server/process lifecycle cannot
  replace this repository's ACP, durable-record, and `WorkerService` authority.

### `xai-org/grok-build`

- Current source inspection pin:
  [`a4221165824e5b1f5c4c10b7459f65e78dd6448d`](https://github.com/xai-org/grok-build/tree/a4221165824e5b1f5c4c10b7459f65e78dd6448d),
  with embedded source revision
  `8d69c91f02bcacf01e98d5aebbf2f92547c45738`.
- Structural precedent:
  [`dd04f397b1d02f2272b092555669dfba1f01bc85`](https://github.com/xai-org/grok-build/commit/dd04f397b1d02f2272b092555669dfba1f01bc85)
  explicitly records “Split headless pager module for clearer structure.” The
  relevant split keeps
  [`headless.rs`](https://github.com/xai-org/grok-build/blob/dd04f397b1d02f2272b092555669dfba1f01bc85/crates/codegen/xai-grok-pager/src/headless.rs)
  over named `headless/cli.rs`, `headless/ext_protocol.rs`, and
  `headless/reducer/*` domains.
- Useful invariant: split by stable protocol and reducer domains behind the
  existing entrypoint while preserving the public headless/ACP lifecycle.
- Rejected pattern: do not copy Rust pager machinery or change local provider,
  cancellation, worktree, or evidence contracts merely to match the donor's
  file layout.

Donor evidence guides boundaries; local tests and the smallest real installed
lifecycle remain the authority for the adapted behavior.
