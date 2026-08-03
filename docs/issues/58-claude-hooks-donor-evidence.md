# Issue #58: Claude hooks packaging donor evidence

> Design input for the Claude plugin packaging declaration, not installed
> Claude lifecycle qualification. Checked against worktree HEAD
> `3773837802c1d6ac913a88b6ae2c3c481b581dc3`.

## Problem

A clean local install on Claude Code **2.1.220** enters a plugin load-error
state when the Claude plugin manifest explicitly lists both:

- `./hooks/hooks.json` (shared `SessionStart` + `Stop`)
- `./hooks/claude-hooks.json` (Claude-only `SessionEnd`)

Claude Code auto-loads the conventional plugin path `hooks/hooks.json` once.
Re-registering that same file through the manifest `hooks` array resolves to
an already-loaded file. Installation returns success, but the enabled plugin's
inventory contains the duplicate-file load error.

## `openai/codex-plugin-cc` (pinned donor)

- Repository and revision:
  [`openai/codex-plugin-cc@db52e28f4d9ded852ab3942cea316258ae4ef346`](https://github.com/openai/codex-plugin-cc/tree/db52e28f4d9ded852ab3942cea316258ae4ef346)
- Conventional hooks file present:
  [`plugins/codex/hooks/hooks.json`](https://github.com/openai/codex-plugin-cc/blob/db52e28f4d9ded852ab3942cea316258ae4ef346/plugins/codex/hooks/hooks.json)
- Claude plugin manifest:
  [`plugins/codex/.claude-plugin/plugin.json`](https://github.com/openai/codex-plugin-cc/blob/db52e28f4d9ded852ab3942cea316258ae4ef346/plugins/codex/.claude-plugin/plugin.json)
  has **no** `hooks` property.

Useful invariant: place host-shared events in the conventional
`hooks/hooks.json` path and rely on Claude Code auto-discovery for that file.
Do **not** re-list the conventional path in the Claude manifest `hooks` array.
Register a `hooks` array only for supplemental, non-conventional Claude-only
files (here: `./hooks/claude-hooks.json` with `SessionEnd`).

Rejected pattern: treating the Claude manifest as the complete explicit
inventory of every hook file when the host already auto-loads
`hooks/hooks.json`.

## `xai-org/grok-build` (no relevant pattern)

- Public contract-source audit pin:
  [`xai-org/grok-build@47348d13ec4508dcfe440e34c6d511bb02998fb2`](https://github.com/xai-org/grok-build/tree/47348d13ec4508dcfe440e34c6d511bb02998fb2)
- Current main checked for drift:
  [`xai-org/grok-build@a4221165824e5b1f5c4c10b7459f65e78dd6448d`](https://github.com/xai-org/grok-build/tree/a4221165824e5b1f5c4c10b7459f65e78dd6448d)
- Neither revision has a Claude Code plugin packaging contract (no
  `.claude-plugin/plugin.json`, no Claude `hooks` manifest property, no
  Claude-only supplemental hooks layout).

Rejected pattern: inventing a Grok Build Claude packaging layout or treating
xAI CLI packaging as authority for Claude Code plugin hook discovery.

## Local adaptation

| File | Role after fix |
| --- | --- |
| `plugins/grok/hooks/hooks.json` | Unchanged shared `SessionStart` + `Stop`; auto-discovered by Claude Code and by Codex default discovery |
| `plugins/grok/hooks/claude-hooks.json` | Unchanged Claude-only `SessionEnd` |
| `plugins/grok/.claude-plugin/plugin.json` | `hooks` is exactly `["./hooks/claude-hooks.json"]` |

Repository validation and the packaging regression in
`tests/codex-support.test.mjs` enforce the supplemental-only Claude manifest
and the three intended events (`SessionStart`, `Stop`, `SessionEnd`) without
claiming a live Claude install.

Required acceptance evidence for installed Claude behavior remains a fresh
consumer workspace install on Claude Code after integration. Deterministic
packaging checks support that qualification but cannot replace it.
