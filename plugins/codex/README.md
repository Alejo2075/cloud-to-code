# Cloud to Code for Codex and other Agent Plugin hosts

A portable Agent Plugin (`plugin.json`, `mcp.json`, `skills/`) that lets Codex or any compatible host reverse-engineer a running AWS application into a reviewable AWS CDK (TypeScript) project. It starts the **local** `@cloud-to-code/mcp` server over stdio and ships two skills: `reconstruct` and `inspect`. The host's own model does the conversation; Cloud to Code never calls another model and needs no account.

- Read-only on AWS, with no deploy/import/delete tool.
- Questions come from real uncertainty in your infrastructure; the host must ask you and relay your actual answers.
- Output is deterministic and evidence-linked.

## Install

> `mcp.json` launches `npx -y @cloud-to-code/mcp`. To run from a clone instead, build the repository and change it to `"command": "node", "args": ["<repo>/packages/mcp/dist/bin.js"]`.

Use your host's plugin installation flow with this folder. Hosts that only support MCP can use the server directly; see `docs/plugins.md` in the repository.

Manifest layout follows the Agent Plugins specification as documented by OpenAI. Re-verify it against the current specification before publishing.
