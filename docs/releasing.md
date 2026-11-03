# Sharing and releasing checklist

Nothing here is automated on purpose: publishing, tagging and pushing need a maintainer's explicit decision.

## Before the first push

1. Create the GitHub repository, then replace the `OWNER` placeholder everywhere: `node scripts/set-owner.mjs <your-github-name>` and review `git diff`.
2. `pnpm install && pnpm check`. Also run `pnpm build && pnpm examples:generate` and confirm `git status` is clean (the example must match the tools).
3. Enable on GitHub: Discussions, private vulnerability reporting, secret scanning and push protection, branch protection on `main` (PR required, CI + DCO + Conventional Commits checks, linear history), Dependabot.
4. Add topics for discovery: `aws`, `aws-cdk`, `cdk`, `infrastructure-as-code`, `iac`, `reverse-engineering`, `cloudformation`, `typescript`, `mcp`, `model-context-protocol`, `claude-code`, `codex`, `serverless`. Add a social preview image.
5. File the starter issues in [good-first-issues.md](good-first-issues.md) with the labels `good first issue` / `help wanted`.

## Before publishing to npm

1. Real-account validation: run `c2c discover` against a sandbox account with the [least-privilege policy](least-privilege-policy.json) and fix whatever differs from the fake-AWS tests. **This has not been done.** Record any anonymized response shapes as new tests.
2. Re-verify the plugin manifests against the current Claude Code and OpenAI/Agent Plugins documentation, and run `claude plugin validate plugins/claude-code`.
3. Decide changelog tooling (Changesets or Conventional-Commit-derived) and set versions. Package scope `@cloud-to-code` must be owned on npm.
4. Publish in dependency order: `core`, `reconstruction`, `diagram-mermaid`, `testing`, `provider-aws`, `generator-cdk`, `validator`, `ai`, `mcp`, `cli`. Use `pnpm publish --provenance` from CI with a trusted-publishing or scoped token; never from a laptop with a broad token.
5. Tag `v0.1.0`, publish a GitHub release from the changelog, and then replace the "not on npm yet" notes in the README, `docs/plugins.md`, the plugin READMEs and `docs/quickstart.md`.

## Recording a demo

Record a real terminal session of `c2c reconstruct` (for example with asciinema) against the bundled example and, once validated, a sandbox account. Do not stage output: the project's credibility is that every claim is verifiable.
