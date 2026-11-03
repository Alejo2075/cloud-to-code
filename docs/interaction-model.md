# Interaction model

Reconstruction is a collaboration, not a one-shot prompt. Questions come from the evidence graph, are validated by the core, and are asked by whoever talks to the human.

## When a question is raised

A question exists only when the answer changes the result and the evidence cannot settle it:

| Detector                    | Priority     | Raised when                                                                            |
| --------------------------- | ------------ | -------------------------------------------------------------------------------------- |
| `shared-resource-ownership` | **blocking** | An event bus, topic or IAM role is connected to two or more application candidates.    |
| `unlinked-lambda-source`    | important    | An application has Lambda functions (code is never downloaded, so no source is known). |
| `stateful-resources`        | important    | The application has tables, queues or buckets (recreate with retain vs reference).     |
| `possible-access`           | important    | An IAM role allows access to a resource that nothing corroborates at runtime.          |
| `out-of-scope-reference`    | optional     | A confirmed link points outside the discovered scope.                                  |

Cosmetic names and trivial preferences are never asked; safe documented defaults apply. At most three questions are shown per batch.

Every question states **what was found, what is uncertain, why it matters, the options with consequences, the safe recommendation (if demonstrably safe), and the effect of skipping**. "I don't know" is always offered; on a _blocking_ question it moves the session to `BLOCKED` instead of choosing for you.

## Lifecycle and states

`DISCOVERING → ANALYZING → AWAITING_INPUT → PLANNING → READY_FOR_REVIEW → GENERATING → VALIDATING → COMPLETED`, plus `BLOCKED` and `FAILED`. Illegal transitions are rejected. Sessions live in `.c2c/` (directories 0700, files 0600, atomic writes, no credentials) and resume without repeating answered questions. If a later scan changes the evidence a decision depended on, the question is **reopened** with an explanation. Revisions append a superseding decision, so the history is auditable (`c2c decisions --history`).

## Who asks

- **Standalone CLI:** the terminal renders the validated question objects (`@clack/prompts`). In non-interactive mode it never prompts: it returns `NEEDS_INPUT` (exit 10) with the pending questions as JSON, or accepts `--answers <file>`.
- **Claude Code / Codex / any MCP host:** `get_pending_questions` returns the structured questions; the host asks them in its own chat and relays the _user's_ answers through `submit_decisions`. The skill forbids answering on the user's behalf. The server never blocks waiting for a human and never assumes the client supports elicitation.

## Exit codes (CLI)

| Code | Meaning                                                     |
| ---- | ----------------------------------------------------------- |
| 0    | OK                                                          |
| 1    | Failed (for example plan verification or validation failed) |
| 2    | Usage error (bad flag, unknown application, invalid answer) |
| 10   | `NEEDS_INPUT`: blocking questions are pending               |
| 11   | `BLOCKED`: a blocking question was answered "I don't know"  |
| 12   | A required consent or sign-in is missing                    |

## Answer provenance

Each decision records its source: `interactive-user`, `answers-file` or `agent-host-user`. Free-text answers and notes are scanned for secrets and redacted _before_ they are saved.
