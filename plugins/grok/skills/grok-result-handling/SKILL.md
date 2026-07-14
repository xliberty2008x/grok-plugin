---
name: grok-result-handling
description: Internal guidance for preserving Grok Companion results and failures when presenting them to the user
user-invocable: false
---

<!-- Adapted and modified from openai/codex-plugin-cc v1.0.6 (Apache-2.0). -->

# Grok Result Handling

The companion runtime validates provider structure; the host owns integration and authoritative verification.

- Keep validated verdicts, summaries, findings, paths, line numbers, job IDs, and error codes accurate.
- Do not reorder findings or convert a validated result into a different schema.
- If a review reports no findings, preserve that outcome without inventing additional concerns.
- Never fix findings during a review command. Stop after presenting the result.
- If a rescue reports edits or tests, label them as Grok claims until the host verifies them.
- A background acknowledgement starts a native-like job workflow. The owning rescue control plane records the job ID, follows it, retrieves its terminal result, and verifies it; unrelated status/result commands do not poll automatically.
- If the runtime reports setup or authentication trouble, direct the user to `/grok:setup` only when that guidance is already part of the result.
- If the runtime fails or returns malformed output, present the actionable error. Follow the active host fallback policy; never silently substitute another worker.
- Never expose private logs, raw ACP events, credentials, or unredacted import output.

## Control-plane integration

- Grok worker reports and `checksClaimed` are claims. The write worker has no terminal; the host runs every required command. Runtime `hostVerification` is `not_run` until the same host task records bounded command/status/exit-code outcomes; command output remains outside job state.
- If host verification fails within the delegated scope, preserve the failing command and a bounded redacted excerpt as evidence for an explicit same-lineage `--job-id` continuation. Do not expose full logs or treat the continuation as a fresh unrelated task.
- Codex or Claude may synthesize a user-facing result from structured fields without dumping opaque JSON verbatim.
- Preserve job IDs, error codes (including `E_CONTEXT_DRIFT`), acceptance IDs, and cancellation safety.
