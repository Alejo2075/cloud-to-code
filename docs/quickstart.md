# Quickstart

Requirements: Node.js 22+ and pnpm 9. Install from a clone:

```bash
git clone https://github.com/Alejo2075/cloud-to-code && cd cloud-to-code
pnpm install && pnpm build
alias c2c="node $PWD/apps/cli/dist/bin.js"
```

## 1. Try it offline (no AWS, no AI, no network)

```bash
c2c demo
c2c reconstruct orders-api --demo        # answer the questions in the terminal
```

Non-interactively, with a prepared answers file:

```bash
c2c reconstruct orders-api --demo --answers examples/serverless-orders/answers.json --output ./orders-api
cd orders-api && npm install && npm test && npx cdk synth
```

Read `reports/migration-plan.md` and `reports/coverage.json` before trusting anything.

## 2. Your own account (read-only)

```bash
aws sso login --profile dev                      # or any normal credentials
c2c init --profile dev --regions us-east-1
c2c discover --account 123456789012 --services lambda,apigatewayv2,dynamodb,sqs,eventbridge,s3,iam
c2c reconstruct <application> --snapshot c2c-snapshot.json --output ./app-cdk
```

Grant only the permissions in [least-privilege-policy.json](least-privilege-policy.json). The snapshot contains account IDs, ARNs and IAM policies: treat it as sensitive and do not commit it.

## 3. CI / automation

`--json --non-interactive` never prompts. A blocking question yields exit code 10 and the questions as JSON; answer with `--answers` and run again (or `c2c answer` then `c2c resume`).

## 4. From an AI agent

See [plugins.md](plugins.md) for Claude Code, Codex and MCP-only setups.
