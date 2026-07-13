# Upstream provenance

This project is a clean-room Grok provider implementation whose public command
contract and selected packaging text are adapted from
[`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc), version
`1.0.6`, commit `db52e28f4d9ded852ab3942cea316258ae4ef346`, under Apache-2.0.

Material changes include replacing the Codex app-server/broker with one Grok
ACP process per job, adding immutable execution profiles, minimal child
environments, ACP-boundary redaction, Grok session import, and Grok-specific
prompts and documentation.

## Adapted-file inventory

The following files use the upstream command or hook layout and contain a
prominent modification notice in a Markdown comment:

- `plugins/grok/commands/*.md`
- `plugins/grok/agents/grok-rescue.md`
- `plugins/grok/hooks/hooks.json` (JSON cannot contain comments; provenance is
  recorded here and in `NOTICE`)

All JavaScript runtime modules in this repository were implemented for the ACP
architecture and are not copies of the Codex app-server implementation.
