# Grok Companion for Claude Code

`grok-plugin` is a planned Claude Code marketplace plugin that delegates coding work to the official Grok Build CLI. Its public contract is modeled on OpenAI's [`codex-plugin-cc` v1.0.6](https://github.com/openai/codex-plugin-cc/tree/db52e28f4d9ded852ab3942cea316258ae4ef346), while its provider integration is designed around Grok's ACP interface.

> [!IMPORTANT]
> This repository is currently in the specification phase. It does not yet contain an installable plugin.

## Planned capabilities

- Read-only working-tree and branch reviews.
- Structured adversarial reviews.
- Write-capable rescue tasks delegated through a thin Claude subagent.
- Foreground and background jobs with status, result, and cancellation commands.
- Persistent Grok sessions and same-session resume behavior.
- Claude transcript import into a resumable Grok session.
- Claude lifecycle hooks and an optional stop-time review gate.

The planned command namespace is:

```text
/grok:setup
/grok:review
/grok:adversarial-review
/grok:rescue
/grok:transfer
/grok:status
/grok:result
/grok:cancel
```

## Source-of-truth documents

- [Technical specification](SPEC.md)
- [Implementation plan](PLAN.md)

The specification defines required behavior and safety invariants. The plan defines work packages, dependencies, release gates, tests, and risks.

## Project status

The next milestone is the protocol and sandbox feasibility gate. Implementation must not proceed past that gate until ACP session lifecycle, cancellation, read-only enforcement, transcript import, and recursion prevention are demonstrated against the candidate Grok CLI versions proposed for support.

## Attribution

This is a community project and is not affiliated with, endorsed by, or sponsored by OpenAI or xAI. The future implementation is expected to adapt Apache-2.0-licensed portions of OpenAI's reference plugin while retaining the required license and NOTICE attribution.

## Planned data boundary

The planned integration runs the Grok CLI locally, but Grok model requests are processed through Grok/xAI services. Task prompts, repository content selected by tools, command output, and imported Claude context may be transmitted under the user's Grok account and enterprise policy. The implementation must disclose and test this boundary before release.

## License

Apache License 2.0. See [LICENSE](LICENSE).
