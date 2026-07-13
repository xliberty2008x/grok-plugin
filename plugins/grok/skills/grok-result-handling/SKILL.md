---
name: grok-result-handling
description: Internal guidance for preserving Grok Companion results and failures when presenting them to the user
user-invocable: false
---

<!-- Adapted and modified from openai/codex-plugin-cc v1.0.6 (Apache-2.0). -->

# Grok Result Handling

The companion runtime owns result validation and rendering. Preserve its output rather than producing a second interpretation.

- Return review, rescue, transfer, status, result, and cancellation output verbatim when the command requires verbatim forwarding.
- Keep verdicts, summaries, findings, optional paths, optional line numbers, and follow-up commands exactly as reported.
- Do not reorder findings or convert a validated result into a different schema.
- If a review reports no findings, preserve that outcome without inventing additional concerns.
- Never fix findings during a review command. Stop after presenting the result.
- If a rescue reports edits or tests, preserve those claims as Grok's report; do not independently assert verification that Claude did not perform.
- Treat a background acknowledgement and job ID as the complete immediate response. Do not poll automatically.
- If the runtime reports setup or authentication trouble, direct the user to `/grok:setup` only when that guidance is already part of the result.
- If the runtime fails or returns malformed output, present the actionable error and stop. Do not substitute a Claude implementation, review, or guessed result.
- Never expose private logs, raw ACP events, credentials, or unredacted import output.
