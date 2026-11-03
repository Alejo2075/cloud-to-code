# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/). Serialized models always ship migrations.

## [0.1.0]

### Added

- Versioned domain models, evidence graph with confidence levels, application candidates and shared-resource detection.
- Question engine, resumable sessions with decision provenance and a `.c2c` workspace.
- Read-only AWS discovery (Lambda, HTTP APIs, DynamoDB, SQS, EventBridge, S3, IAM) behind an SDK command allowlist, with a generated least-privilege policy.
- Deterministic `balanced` CDK v2 generation, coverage/decision/architecture/migration reports and a provenance manifest.
- Offline validator, controlled synth and advisory adoption plan.
- `c2c` CLI, local stdio MCP server, Claude Code and Codex/portable plugins.
- Optional, consent-gated AI providers (advisory only).
- Synthetic `serverless-orders` example with byte-for-byte verified expected output.

### Known limitations

See [docs/roadmap.md](docs/roadmap.md#caveats-read-these).
