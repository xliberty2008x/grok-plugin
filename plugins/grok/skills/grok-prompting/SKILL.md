---
name: grok-prompting
description: Internal guidance for shaping concise, grounded Grok coding and investigation requests without changing user intent
user-invocable: false
---

<!-- Adapted and modified from openai/codex-plugin-cc v1.0.6 (Apache-2.0). -->

# Grok Prompting

Use this skill only to make a rescue request easier for Grok to execute. Prompt shaping is not permission to inspect the repository or solve the task in Claude.

Core rules:

- Preserve the user's goal, scope, constraints, and requested output.
- Prefer one coherent task per Grok run.
- State what completion means and which verification is expected.
- Separate observed facts supplied by the user from hypotheses Grok should test.
- Do not invent file names, failures, architecture, or repository state.
- Do not include routing flags, model selection, or effort selection in the natural-language task.
- Do not ask Grok to use web search or subagents; the runtime disables them.
- Avoid pasting credentials, tokens, unrelated environment details, or a full Claude transcript.

A compact task may use these blocks when they add clarity:

```text
<task>
The concrete investigation or implementation request.
</task>

<constraints>
Scope boundaries, compatibility requirements, and actions to avoid.
</constraints>

<completion_contract>
The expected finished state and result summary.
</completion_contract>

<verification>
Tests, checks, or evidence Grok should use before finishing.
</verification>
```

For implementation or debugging, ask Grok to follow the issue through to a verified outcome and report changed files and checks run. For read-only investigation, explicitly say not to edit files. For a follow-up resume request, send the delta instruction instead of restating the entire prior task.

Remove redundant instructions before forwarding. If the user's request is already precise, preserve it as-is.
