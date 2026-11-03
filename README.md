# Cloud to Code

[![CI](https://github.com/Alejo2075/cloud-to-code/actions/workflows/ci.yml/badge.svg)](https://github.com/Alejo2075/cloud-to-code/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![Node 22+](https://img.shields.io/badge/node-22%2B-brightgreen)
![Status: alpha](https://img.shields.io/badge/status-alpha-orange)

**Turn running AWS infrastructure into code you can understand, review and own.**

Cloud to Code reverse-engineers an existing AWS application into a maintainable **AWS CDK v2 (TypeScript)** project. It reads your infrastructure **read-only**, works out how the pieces fit together, **asks you the questions it cannot answer from evidence**, and generates reviewable code with a report of everything it could not recover. It runs locally: no hosted service, no account, no deployment.

> **Status: alpha, pre-release.** Everything below is implemented and tested, but the AWS collectors have only been tested against an in-memory fake (not a real account yet), nothing is published to npm, and the AI features are advisory. Read [what is and is not done](docs/roadmap.md) before relying on it.

## Why not just `cdk migrate` or the CloudFormation IaC Generator?

Those tools turn a list of resources into a template. Cloud to Code goes further:

|                                                                                   | Resource-list tools              | Cloud to Code                                                                     |
| --------------------------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------- |
| Understands the **application** (boundaries, shared resources, who triggers whom) | no                               | yes, with confidence per relationship                                             |
| Output                                                                            | template or mostly L1 constructs | stacks and **L2 constructs** organized by role, with tests                        |
| When something is ambiguous                                                       | guesses                          | **asks you**, with evidence, options and consequences                             |
| Explains itself                                                                   | no                               | every resource links to AWS evidence, a rule and your decisions                   |
| Safety                                                                            | --                               | read-only by construction; "synth passed" is never presented as "safe to migrate" |
| Works with your AI agent                                                          | no                               | local MCP server + Claude Code and Codex plugins                                  |

## Try it in two minutes (no AWS, no AI, no network)

```bash
git clone https://github.com/Alejo2075/cloud-to-code && cd cloud-to-code
pnpm install && pnpm build
alias c2c="node $PWD/apps/cli/dist/bin.js"      # not on npm yet

c2c demo
c2c reconstruct orders-api --demo --answers examples/serverless-orders/answers.json --output ./orders-api
```

Without the answers file it asks you, in the terminal:

```text
[1/3] BLOCKING  Who should own 'shared-events'?
  Found:          'shared-events' (AWS::Events::EventBus) is connected to 2 application candidates
                  (orders-api, billing-handler) through: billing-invoice, orders-created.
  Uncertain:      AWS does not record which application owns a shared resource.
  Why it matters: The generated stack either manages this resource (and may collide with the existing
                  one) or only references it.
  If skipped:     Generation is blocked: an unanswered or "I don't know" answer stops the session.
  Options:        reference [recommended] | include in orders-api | include in billing-handler | exclude
```

and finishes with a verified plan, 20 generated files and honest local checks:

```text
Generated 20 files in ./orders-api
Unresolved items needing manual work: 5 (see reports/coverage.json)
  [PASS] Manifest integrity: 19 files match the generated hashes.
  [WARN] Coverage: 95 preserved, 2 approximated, 13 intentionally omitted, 0 not mapped; 5 manual item(s).
Synthesis does not prove the template is equivalent to your running infrastructure or safe to import.
```

See the committed result in [`examples/serverless-orders/expected`](examples/serverless-orders/expected/orders-api) (verified byte for byte by a test).

## Use it on your own account (read-only)

```bash
c2c init --profile dev --regions us-east-1
c2c discover --account 123456789012          # verifies the STS identity matches; reads metadata only
c2c reconstruct <application> --snapshot c2c-snapshot.json --output ./app-cdk
```

Grant only the [generated least-privilege policy](docs/least-privilege-policy.json). More in the [quickstart](docs/quickstart.md) and [CLI reference](docs/cli.md).

## Principles

- **AWS is read-only by construction.** A fixed allowlist of List/Get/Describe calls; no code, data, secrets or environment values are stored; no deploy, import or delete anywhere, including the MCP server.
- **You stay in control.** Blocking questions stop the workflow; "I don't know" is never turned into a guess. Generated code goes to a new directory; nothing is overwritten without `--overwrite`.
- **Facts are not guesses.** Observed, derived, hypothesis and user-decided data are kept apart. An IAM permission is not treated as proof a function uses a resource.
- **No fictional completeness.** Unsupported resources, missing permissions and unrecoverable properties are listed prominently, never dropped.
- **Models propose, code decides.** AI is optional and advisory; plans from a model or agent must pass a deterministic verifier. External models get data only after consent bound to the exact previewed payload.

Details: [security and privacy](docs/security.md), [interaction model](docs/interaction-model.md), [migration semantics](docs/migration-semantics.md).

## With Claude Code, Codex and other agents

A local stdio MCP server (`@cloud-to-code/mcp`, nine tools) and thin plugins let your agent drive the same engine and ask you the questions in its own chat. See [docs/plugins.md](docs/plugins.md); the plugins live in [`plugins/`](plugins).

## What is supported

Lambda, API Gateway HTTP APIs, DynamoDB, SQS, EventBridge, S3 and IAM roles, with L2 generation and explicit gaps. Full matrix and limits: [docs/resource-support.md](docs/resource-support.md).

## Documentation

[Quickstart](docs/quickstart.md) · [CLI](docs/cli.md) · [Architecture](docs/architecture.md) · [Interaction model](docs/interaction-model.md) · [Security](docs/security.md) · [Migration semantics](docs/migration-semantics.md) · [Plugins and MCP](docs/plugins.md) · [Roadmap](docs/roadmap.md) · [Development plan](docs/development-plan.md)

## Contributing

Contributions are welcome and the project is built to make them easy: new service collectors, relationship resolvers, fixtures and CDK mapping rules are small, well-bounded pieces. Start with [CONTRIBUTING.md](CONTRIBUTING.md) (DCO sign-off, Conventional Commits) and the `good first issue` label. Please read the [Code of Conduct](CODE_OF_CONDUCT.md); report vulnerabilities privately per [SECURITY.md](SECURITY.md).

```bash
pnpm install && pnpm check     # lint + typecheck + tests; no AWS account or AI key needed
```

## License

[Apache-2.0](LICENSE)
