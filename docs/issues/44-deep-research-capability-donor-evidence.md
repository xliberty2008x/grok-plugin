# Issue #44: deep-research capability donor evidence

> Research input, not installed-lifecycle qualification evidence. Checked
> 2026-07-30 against the branch base
> `60ba16d444c6f8d33b941ce9e3963664f1ede7f6`, which includes the forward
> managed-version fix from PR #53.

## Question

[Issue #44](https://github.com/xliberty2008x/grok-plugin/issues/44)
reports that the dedicated deep-research route fails with `E_CAPABILITY` before
launching research, even on a compatible Grok release.

The reproduced isolated session advertised neither the exact `workflow` tool
nor the `deep-research` and `workflow` commands. The plugin also looked for the
workflow tool in the pre-session `initialize` result instead of pairing the
commands and tools advertised by the newly created live session.

## `xai-org/grok-build`

The Grok 0.2.112 source mirror was inspected at
[`5da6962e4adb9c857f3def762542b52b4ec3e522`](https://github.com/xai-org/grok-build/tree/5da6962e4adb9c857f3def762542b52b4ec3e522).
Current source was inspected at
[`500129c714ad1b10e6095481f4a8387a2ec52649`](https://github.com/xai-org/grok-build/tree/500129c714ad1b10e6095481f4a8387a2ec52649).
The relevant production paths are equivalent at those revisions.

Donor evidence:

1. The exact registered tool name is `workflow`
   ([source](https://github.com/xai-org/grok-build/blob/500129c714ad1b10e6095481f4a8387a2ec52649/crates/codegen/xai-grok-tools-api/src/slash_commands.rs#L183-L186)).
2. `deep-research` is advertised only when `WorkflowLaunches` is available;
   `workflow` requires either workflow launch support or an existing workflow
   run
   ([source](https://github.com/xai-org/grok-build/blob/500129c714ad1b10e6095481f4a8387a2ec52649/crates/codegen/xai-grok-shell/src/session/slash_commands.rs#L239-L255),
   [source](https://github.com/xai-org/grok-build/blob/500129c714ad1b10e6095481f4a8387a2ec52649/crates/codegen/xai-grok-shell/src/session/slash_commands.rs#L383-L397)).
3. Workflow-launch availability is derived from the live session's registered
   tool names, using exact equality with `workflow`
   ([source](https://github.com/xai-org/grok-build/blob/500129c714ad1b10e6095481f4a8387a2ec52649/crates/codegen/xai-grok-shell/src/session/acp_session.rs#L1136-L1190)).
4. The same session computes its command list and sends an
   `available_commands_update` carrying both commands and `_meta.tools`
   ([source](https://github.com/xai-org/grok-build/blob/500129c714ad1b10e6095481f4a8387a2ec52649/crates/codegen/xai-grok-shell/src/session/acp_session_impl/session_setup.rs#L205-L239)).
5. The correlated `x.ai/commands/list` response may also carry the same
   live-session tool names. A request with a session ID is routed to that
   session
   ([source](https://github.com/xai-org/grok-build/blob/500129c714ad1b10e6095481f4a8387a2ec52649/crates/codegen/xai-grok-shell/src/extensions/session_admin.rs#L649-L668)),
   where the response is built from its registered tools
   ([source](https://github.com/xai-org/grok-build/blob/500129c714ad1b10e6095481f4a8387a2ec52649/crates/codegen/xai-grok-shell/src/session/acp_session_impl/run_loop.rs#L1785-L1802)).
   The pre-session response explicitly leaves tools unknown
   ([source](https://github.com/xai-org/grok-build/blob/500129c714ad1b10e6095481f4a8387a2ec52649/crates/codegen/xai-grok-shell/src/session/slash_commands.rs#L722-L769)).

Useful invariant: admit deep research only from one paired command-and-tool
advertisement attributable to the exact session that will receive the slash
command.

Rejected patterns:

- treating `initialize`, inspection output, or version compatibility as
  session capability evidence;
- combining commands and tools from different updates or sessions;
- accepting substring or qualified lookalikes;
- falling back to an ordinary prompt when the built-in route is absent.

## `openai/codex-plugin-cc`

The project pin
[`db52e28f4d9ded852ab3942cea316258ae4ef346`](https://github.com/openai/codex-plugin-cc/tree/db52e28f4d9ded852ab3942cea316258ae4ef346)
was inspected through its checked-in command and runtime inventory, including
[`plugins/codex/commands/rescue.md`](https://github.com/openai/codex-plugin-cc/blob/db52e28f4d9ded852ab3942cea316258ae4ef346/plugins/codex/commands/rescue.md)
and
[`plugins/codex/scripts/codex-companion.mjs`](https://github.com/openai/codex-plugin-cc/blob/db52e28f4d9ded852ab3942cea316258ae4ef346/plugins/codex/scripts/codex-companion.mjs).

Useful invariant: keep the public command as a narrow forwarder to one
code-owned runtime route, while private input transport and lifecycle evidence
remain runtime-owned.

Rejected for Issue #44: this donor has no Grok ACP workflow advertisement or
deep-research lifecycle to reuse. Its app-server machinery is not evidence that
Grok's built-in workflow is available.

## Local adaptation

The issue fix:

- includes exact `GrokBuild:workflow` in both immutable research profiles and
  their code-owned bindings;
- registers for session updates before `session/new`;
- accepts only a paired exact-session `available_commands_update`, or the
  correlated exact-session `x.ai/commands/list` response, containing exact
  `deep-research`, `workflow`, and `workflow` tool names;
- bounds buffered updates and every accepted identifier/name before retention;
- records a schema-v2 receipt binding the sorted commands and tools, evidence
  source, executable and profile identity, and a digest of the private session
  binding;
- preserves the exact `/deep-research <query>` dispatch and existing isolated
  no-plugin, no-shell, no-write, and no-MCP profile boundaries.

PR #53 supplies forward managed-version admission. This change therefore adds
no version floor and does not reinterpret version compatibility as lifecycle
qualification.

## Acceptance evidence to produce

- Donor-shaped deterministic cases accept only same-session paired evidence and
  reject initialization-only, split, wrong-session, malformed, oversized, and
  lookalike advertisements before research launch.
- The feature receipt changes when provider bytes, profile identity, commands,
  tools, evidence source, or session binding changes.
- A freshly installed plugin completes one real cited research run.
- A second real run cancels the exact workflow, proves zero active agents and
  process cleanup, and permits a replacement run.
- Crash/restart marks the interrupted run without replay, then a fresh explicit
  run succeeds.
- The exact merged plugin is installed and the real vertical is repeated before
  claiming qualification.
