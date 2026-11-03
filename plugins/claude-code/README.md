# Cloud to Code for Claude Code

Turn a running AWS application into a reviewable AWS CDK (TypeScript) project, with Claude asking you the questions that actually matter. The plugin bundles two skills (`reconstruct`, `inspect`) and a **local** MCP server (`@cloud-to-code/mcp`). There is no hosted service and no Cloud to Code account.

- **Read-only on AWS.** Only a fixed list of List/Get/Describe calls; never code, data, secrets or environment values. There is no deploy, import or delete tool.
- **You stay in control.** Claude relays your answers; it does not make ownership decisions for you.
- **Honest output.** Every generated resource links to evidence or a decision, and the reports say what could not be recovered.

## Install

> The manifest launches the server with `npx -y @cloud-to-code/mcp`. To run it from a clone of this repository instead, see _Run from a clone_ below.

From a marketplace that lists this plugin: `/plugin install cloud-to-code@<marketplace>`.

## Run from a clone

No marketplace needed:

```bash
pnpm install && pnpm build          # in the repository root
claude --plugin-dir ./plugins/claude-code
```

Then replace the `args` in `.mcp.json` with `["<repo>/packages/mcp/dist/bin.js"]` and `command` with `node`.

## Use

Ask Claude: "Reconstruct my `orders-api` application on AWS into CDK" and answer its questions. Your AWS credentials come from your normal profile (`AWS_PROFILE`, SSO); they are never passed as tool arguments.

Run `claude plugin validate .` in this folder to check the manifest.
