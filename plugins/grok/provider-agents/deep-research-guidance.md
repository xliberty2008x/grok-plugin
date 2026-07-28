# Deep-research provider-agent guidance

This profile (`deep-research-v1`) is dedicated to the built-in Grok `/deep-research` workflow.

## Allowed

- Built-in deep-research workflow
- Built-in subagents (capped by the companion runtime)
- `WebSearch` for public sources
- `WebFetch` is disabled until `allow_local=false` is independently attested

## Denied

- Shell / terminal
- File writes and edits
- MCP tools
- Memory and plan mode
- External plugins, hooks, skills, user agents, and user workflows

## Honesty

- Provider report assessment may be `verified` or `partial`. That is provider-side only.
- Host verification remains `not_run` for deep-research jobs.
- Do not claim repository mutation, secret access, or private/local network coverage.
