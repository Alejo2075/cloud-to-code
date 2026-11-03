# Agent plugins and MCP

Cloud to Code runs as a **local stdio MCP server** (`@cloud-to-code/mcp`, binary `c2c-mcp`). The host agent supplies the conversation and its own model; the server supplies deterministic evidence, state and validation. It never calls a model, never blocks waiting for a human, and exposes no tool that deploys, imports, deletes, bootstraps or runs shell commands.

> Status: the repository is pre-release. `@cloud-to-code/mcp` is **not yet published to npm**, so the plugin manifests reference `npx -y @cloud-to-code/mcp`; until publication, point them at `node <repo>/packages/mcp/dist/bin.js` after `pnpm build`.

## Tools

| Tool                         | Purpose                                                                 | Side effects                            |
| ---------------------------- | ----------------------------------------------------------------------- | --------------------------------------- |
| `aws_discover`               | Read scoped metadata; store a sanitized snapshot (returns `snapshotId`) | AWS read APIs only; local snapshot file |
| `inspect_application`        | Graph, candidates, confidence, diagnostics, limitations (paginated)     | none                                    |
| `start_reconstruction`       | Create a resumable session for one application                          | local session files                     |
| `get_pending_questions`      | Structured pending questions                                            | none                                    |
| `submit_decisions`           | Validate and record **the user's** answers                              | local session files                     |
| `submit_reconstruction_plan` | Verify an agent plan (or build the deterministic one)                   | local session files                     |
| `generate_cdk`               | Generate the CDK project into a new directory in the workspace          | local files; explicit `overwrite`       |
| `validate_cdk`               | Offline checks; optional typecheck/synth                                | local process                           |
| `get_migration_plan`         | Advisory recreate/reference/adopt analysis                              | none                                    |

Resources: `c2c://snapshots/{id}`, `c2c://sessions/{id}/plan`, `c2c://sessions/{id}/decisions`.

Policy is enforced by the server, not by the skill: arguments are schema-validated, file paths are confined to the workspace (and never `.c2c`), overwriting needs `overwrite: true`, plans must pass the verifier and may not claim to be deterministic, and credentials are not tool arguments.

## Claude Code

`plugins/claude-code/` follows the current Claude Code plugin layout: `.claude-plugin/plugin.json`, `.mcp.json` and `skills/{reconstruct,inspect}/SKILL.md`. `claude plugin validate plugins/claude-code` passes. Try it locally with `claude --plugin-dir ./plugins/claude-code`.

## Codex and other Agent Plugin hosts

`plugins/codex/` uses the portable Agent Plugins layout (root `plugin.json`, `mcp.json`, `skills/`). The two formats are **not interchangeable**, so each has its own manifest; the skills are generated from one source (`plugins/shared`, `pnpm plugins:sync`) and a test enforces they are identical. The Codex layout was checked against the documentation current at the time of writing; re-verify it before publishing.

## MCP-only clients

Any client that can launch a stdio server can use the tools without a plugin:

```json
{ "mcpServers": { "cloud-to-code": { "command": "npx", "args": ["-y", "@cloud-to-code/mcp"] } } }
```

(or `node /path/to/packages/mcp/dist/bin.js --dir <workspace>`). Without the skill, tell the host to follow the workflow in `plugins/shared/reconstruct.md`.

## Workflow the skills enforce

Scope (ask the user) → `aws_discover` → `inspect_application` → `start_reconstruction` → `get_pending_questions` (ask in chat) → `submit_decisions` (only real answers) → `submit_reconstruction_plan` → `generate_cdk` → `validate_cdk` → summarize gaps and next manual steps. Cursor and other hosts can follow by reusing the same server and skills.
