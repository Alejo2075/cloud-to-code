# Roadmap and status

Source of truth for scope is [CLAUDE.md](../CLAUDE.md); this table says what is **actually built and tested** versus planned.

| Phase               | Scope                                                                                                                         | Status                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 0 Foundation        | Monorepo, versioned schemas, evidence graph, question engine, sessions, offline CLI, Mermaid, sanitization, fixture           | **done**                                                                                                     |
| 1 End-to-end        | Read-only collectors (Lambda, HTTP API, DynamoDB), optional AI adapters, plan verifier, `balanced` CDK generation, validation | **done**, with limitations below                                                                             |
| 2 MCP + plugins     | Local stdio MCP server, Claude Code plugin, Codex/portable plugin, CLI/MCP parity                                             | **done**, with limitations below                                                                             |
| 3 Coverage + launch | SQS, EventBridge, IAM, S3                                                                                                     | **collectors and generators done**; richer grouping, `faithful`, publishing, recorded real demos **planned** |
| 4 Advanced          | Git integration, drift, multi-account, source linking, more agents, UI                                                        | **not started** (deliberately)                                                                               |

## Known limitations

- **Collector verification.** Collectors are tested against an in-memory fake that returns SDK-shaped responses; reports from real accounts are very welcome.
- **AI adapters** (Bedrock, Anthropic, OpenAI, Ollama) are tested with fake transports only. AI is advisory: it never changes the plan or the generated code.
- **Distribution.** Install from a clone today; the plugin manifests reference the npm package `@cloud-to-code/mcp`.
- The Codex plugin layout follows OpenAI's documentation at the time of writing and should be re-verified.
- `faithful`/`modernized` strategies, container-image Lambdas, REST/WebSocket APIs, VPC-attached Lambdas, authorizers, KMS-encrypted queues, SNS/Kinesis and non-Lambda API targets are not supported (reported as unresolved, never dropped silently).
- Not exercised on Windows. CI covers Node 22 and 24 on Linux.

## Where help is welcome

New service collectors, relationship resolvers, fixtures, CDK mapping rules, Cursor/other-host skills and real-account bug reports. See [CONTRIBUTING.md](../CONTRIBUTING.md).
