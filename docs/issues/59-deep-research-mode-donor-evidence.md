# Issue #59: deep-research mode-selection donor evidence

> Design input, not installed-lifecycle qualification evidence. Checked
> 2026-08-02 against repository base
> `7301afbbbf29afc3690c9d1d4458b8c394bed2bc`.

## `openai/codex-plugin-cc`

The project donor pin
[`db52e28f4d9ded852ab3942cea316258ae4ef346`](https://github.com/openai/codex-plugin-cc/tree/db52e28f4d9ded852ab3942cea316258ae4ef346)
was inspected in
[`plugins/codex/commands/rescue.md`](https://github.com/openai/codex-plugin-cc/blob/db52e28f4d9ded852ab3942cea316258ae4ef346/plugins/codex/commands/rescue.md)
and
[`plugins/codex/scripts/codex-companion.mjs`](https://github.com/openai/codex-plugin-cc/blob/db52e28f4d9ded852ab3942cea316258ae4ef346/plugins/codex/scripts/codex-companion.mjs).

Useful invariant: the public command selects mutually exclusive routing flags
before forwarding one bounded process invocation, while the code-owned runtime
owns private input and lifecycle behavior.

Rejected pattern: importing the donor's Codex app-server machinery or treating
it as deep-research evidence. The donor has no Grok ACP deep-research route.

## `xai-org/grok-build`

The public contract-source audit pin
[`47348d13ec4508dcfe440e34c6d511bb02998fb2`](https://github.com/xai-org/grok-build/tree/47348d13ec4508dcfe440e34c6d511bb02998fb2)
and current source
[`a4221165824e5b1f5c4c10b7459f65e78dd6448d`](https://github.com/xai-org/grok-build/tree/a4221165824e5b1f5c4c10b7459f65e78dd6448d)
were inspected in
[`crates/codegen/xai-grok-shell/src/session/slash_commands.rs`](https://github.com/xai-org/grok-build/blob/a4221165824e5b1f5c4c10b7459f65e78dd6448d/crates/codegen/xai-grok-shell/src/session/slash_commands.rs)
and
[`crates/codegen/xai-grok-shell/src/session/acp_session_impl/slash_exec.rs`](https://github.com/xai-org/grok-build/blob/a4221165824e5b1f5c4c10b7459f65e78dd6448d/crates/codegen/xai-grok-shell/src/session/acp_session_impl/slash_exec.rs#L801-L865).
The audit and current `slash_exec.rs` blobs are identical for this path
(`9d372cf0669e59c41d5e15acd2f07e67b30ac9c9`).

Useful invariant: Grok registers and executes `/deep-research <query>`; the
native workflow receives the query only. Companion's `--web-only` and
`--workspace` flags are host-side isolation choices and must never be forwarded
as native slash-command arguments.

Rejected patterns: changing the native query text, weakening Companion's
fail-closed rejection of ambiguous wrapper flags, or modifying provider/ACP
lifecycle code to compensate for a contradictory public instruction.

## Local adaptation

The installed Codex skill and Claude command now choose exactly one execution
mode (`--background` or `--wait`) and exactly one research surface
(`--web-only` or `--workspace`) before starting their single private-stdin
process. The runtime parser, capability gate, security profiles, snapshot
implementation, provider lifecycle, cancellation, and cleanup remain
unchanged.

Required acceptance evidence remains a fresh installed-consumer workspace run
plus a public-web negative control. Deterministic packaging tests support that
qualification but cannot replace it.
