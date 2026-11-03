# Starter issues to file

Each is small, bounded and has a test pattern to copy. Label them `good first issue` and `help wanted`.

1. **SNS topic collector + `triggers` edges** (resource-support row, allowlist entries, fake-AWS test; SNS topics are already a shared hub type).
2. **API Gateway HTTP API JWT authorizers**: collect `GetAuthorizers`, generate `HttpJwtAuthorizer` routes instead of listing them unresolved.
3. **Lambda reserved concurrency and DLQ**: `GetFunctionConcurrency`, map `deadLetterConfig` to `deadLetterQueue`.
4. **SQS KMS encryption**: map `kmsMasterKeyId` to a key reference instead of marking it unresolved.
5. **EventBridge target input transformers**: collect and generate `RuleTargetInput`.
6. **Second synthetic fixture**: a Python Lambda + SQS + DynamoDB app with a different ambiguity (two tables, one shared). Include a hostile-tag variant.
7. **Cursor skills**: adapt `plugins/shared/*.md` for Cursor's rules/MCP format and add a manifest test.
8. **`c2c inspect --format mermaid|json|dot`** improvements: colorize by confidence, add `dot` output.
9. **Windows CI job** for the CLI and path-handling tests.
10. **Docs: "How to write a collector"** walkthrough using the DynamoDB collector as the example.
