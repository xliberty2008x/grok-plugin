# Issue #56: staged source simplification and executable policy

Issue: <https://github.com/xliberty2008x/grok-plugin/issues/56>

Baseline: `ffa84d4ce22252777d887e8ab6616c7155b40da7` (`github/main`,
captured 2026-08-03).

That revision remains the numeric debt snapshot. Before freezing its digest,
the policy slice gave each over-budget anonymous callback a same-line function
name. The identity-only migration preserved every file and function span; the
exact old-to-new key mapping is recorded below.

## Decision

Eight-thousand-line handwritten modules are not an acceptable steady state for
this project. Some large modules are temporarily safer than a rushed rewrite,
but their size obscures domain ownership, creates long functions, encourages
reverse imports through public facades, and makes reviews and deterministic
sharding harder.

The policy initially landed in `observe` mode without pretending that the debt
was already gone. This prepared promotion will switch the checked-in policy to
`ratchet` mode when the required host gates below are satisfied. Immutable
history records 45 initially over-budget files, the former six-module static
ESM cycle, and 14 initial ordinal test fragments. Active caps cover 44 files on
the prepared task-contract pilot head because that pilot resolves its own debt.
Initial debt/topology remains separate from reducible caps and bound by a
repository-pinned SHA-256 digest, so raising both an initial value and its cap
cannot bless growth.

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

### Stable function-debt identities

Persisted function debt uses a unique language-level name, never encounter
order. A key is accepted only when its `(kind, name)` pair occurs exactly once
in the file, so every immutable and active function key ends in `#1`.
Anonymous, dynamic-computed, reserved `anonymous`, and colliding long-function
identities fail even in observe mode and cannot consume a cap. Short anonymous
callbacks remain allowed because no identity for them is persisted. Adding or
removing one therefore cannot rename an existing long-function cap.

The baseline migration was:

| File | Old key | Stable key |
| --- | --- | --- |
| `apps/grok-review-app/src/actions/exact-head-repository.mjs` | `arrow:anonymous#6` | `function:handleProxyRequest#1` |
| `apps/grok-review-app/src/actions/exact-head-repository.mjs` | `arrow:anonymous#7` | `function:runProxyRequestTask#1` |
| `plugins/grok/scripts/lib/worker-mutation.mjs` | `arrow:anonymous#32` | `function:transitionDispatchTransaction#1` |
| `plugins/grok/scripts/lib/worker-mutation.mjs` | `arrow:anonymous#78` | `function:prepareProvisioningReissueTransaction#1` |
| `plugins/grok/scripts/lib/worker-mutation.mjs` | `arrow:anonymous#95` | `function:admitWritePlanTransaction#1` |
| `plugins/grok/scripts/lib/worker-mutation.mjs` | `arrow:anonymous#105` | `function:cancelWorkerTransaction#1` |
| `tests/installed-worker-mcp-runner.test.mjs` | `arrow:anonymous#15` | `function:installedWorkerMcpRunnerOwnershipTest#1` |
| `tests/recursion-guard.test.mjs` | `arrow:anonymous#38` | `function:worktreeProvisioningGuardAuthenticationTest#1` |
| `tests/runtime.test.mjs` | `arrow:anonymous#79` | `function:humanCliDiagnosticProjectionTest#1` |
| `tests/runtime.test.mjs` | `arrow:anonymous#142` | `function:cleanupBlockedRecoveryContextDriftTest#1` |
| `tests/worker-broker-protected-review.test.mjs` | `arrow:anonymous#8` | `function:protectedReviewPromotionReplayTest#1` |
| `tests/worker-mutation.test.mjs` | `arrow:anonymous#183` | `function:absenceProvenReissueTest#1` |
| `tests/worker-mutation.test.mjs` | `arrow:anonymous#212` | `function:officialWorktreeReceiptPromotionTest#1` |
| `tests/worker-mutation.test.mjs` | `arrow:anonymous#264` | `function:exactWriteSpawnReplayTest#1` |

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

Observe mode reports file/function debt, cap drift, cycles, ordinal fragments,
and reverse facade imports as warnings. It remains available as an explicit
diagnostic mode, but it is no longer the checked-in repository gate.

### Ratchet mode

The checked-in ratchet engine fails:

- a new over-budget file or function;
- growth above an exact legacy file or per-function cap;
- a stale cap after code shrinks, so the cap must be reduced in the same PR;
- a new or enlarged static ESM cycle;
- an unclassified handwritten source above 5,000 lines;
- a new ordinal fragment such as `domain_part3.mjs`;
- a stale, missing, or category-drifted exception.
- a product/tooling dependency routed backward through a registered facade.
- an anonymous or colliding identity for an over-budget function.

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
- Comments and positional aliases cannot create function-debt identities; a
  long function needs one unique syntactic name in its file.
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

## Ratchet promotion record

The promotion is based on task-context pilot head
`2fef2e0513bce270bad0c747cfa011dbe5ba256d`. Within
`scripts/source-structure-policy.json`, it changes only the checked-in mode and
the current-policy digest. The immutable numeric baseline remains
`ffa84d4ce22252777d887e8ab6616c7155b40da7`, and the initial digest remains
`6cd632e75601aad00a3872546281f1794960eb86f278fa0d7f5340898315396b`.
The current-policy digest advances from
`bd896fa859fdfb805f067f1bd67e0fbf95b29d8451df3985393dea601678faf6` to
`9d743712335f82e91fc2d85d032326ec27b5fc34f603df01f07c869a5aec2d4a`.
No cap, budget, source root, extension, or resource ceiling changes.

Merge this prepared promotion only after all of these are true; attach the
exact host run URLs to the Issue #56 closeout evidence:

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
