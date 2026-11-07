# CLI reference (`c2c`)

Global flags: `--json` (machine-readable stdout; implies non-interactive; hints go to stderr), `--non-interactive` (never prompt), `--session <id>` (default: latest in the workspace), `--dir <path>` (project directory holding `.c2c`). Exit codes are listed in [interaction-model.md](interaction-model.md).

| Command                                                                                                               | What it does                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `c2c demo`                                                                                                            | Inspect the bundled synthetic example. No AWS, AI or network.                                                                                            |
| `c2c init [--profile --role-arn --regions --external-model-context]`                                                  | Save non-secret defaults (YAML, `0600`) under `~/.config/cloud-to-code/`. No credentials are stored.                                                     |
| `c2c config show`                                                                                                     | Show settings (never credentials).                                                                                                                       |
| `c2c discover --account <id> --regions a,b [--services ...] [--profile --role-arn --output]`                          | Read-only discovery of an explicit scope into a sanitized snapshot. The STS identity must match `--account`. Refuses to overwrite without `--overwrite`. |
| `c2c inspect [application] [--snapshot f \| --demo] [--format mermaid\|dot]`                                          | Topology, evidence, uncertainty, open questions; optional Mermaid or Graphviz DOT diagram.                                                               |
| `c2c reconstruct [application] [--snapshot f \| --demo] [--answers f] [--output dir] [--ai] [--allow-external-model]` | Create or continue a session, ask (or accept) the questions, build a verified plan, optionally generate.                                                 |
| `c2c questions [--all]`                                                                                               | Pending questions with evidence and consequences.                                                                                                        |
| `c2c answer <questionId> <option> [--note t] \| --unknown \| --answers f`                                             | Record validated answers.                                                                                                                                |
| `c2c resume [--answers f]`                                                                                            | Continue without repeating answered questions.                                                                                                           |
| `c2c decisions [--history]`                                                                                           | Current decisions or the full audit history.                                                                                                             |
| `c2c generate --output dir [--overwrite]`                                                                             | Generate the CDK project for a session whose blocking questions are answered.                                                                            |
| `c2c validate <dir> [--synth] [--trust] [--no-typecheck]`                                                             | Offline checks. `--synth` runs the project's own `cdk` with credentials withheld.                                                                        |
| `c2c adoption plan <dir>`                                                                                             | Advisory adoption analysis. Never applies anything.                                                                                                      |
| `c2c ai connect --provider P --model M` / `ai test` / `ai preview [--show-data]`                                      | Optional AI setup, connectivity check (no inventory data) and a preview of exactly what would be sent.                                                   |

`faithful` and `modernized` strategies are not implemented; `--strategy` rejects them explicitly.

## Answers file

```json
{ "q-shared-shared-events": "reference", "q-lambda-source-orders-api": "infra-only" }
```

Also accepted: `{ "answers": [{ "questionId": "...", "answer": { "kind": "choice", "optionId": "...", "note": "..." } }] }`. Unknown IDs and invalid options are rejected, never ignored.

## JSON envelope

Every `--json` result has `status` (`OK`, `NEEDS_INPUT`, `BLOCKED`, `FAILED`), `exitCode`, and command-specific fields (`session`, `questions`, `plan`, `files`, `validation`, ...). Errors: `{ "status": "FAILED", "error": { "code", "message", "hint?" } }`.
