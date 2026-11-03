# Security and privacy

Cloud to Code reads infrastructure metadata and writes local files. This page is the honest description of what it does and does not protect. Report vulnerabilities as described in [SECURITY.md](../SECURITY.md).

## AWS access is read-only

- Every SDK call is checked against an explicit allowlist (`packages/provider-aws/src/guard/allowlist.ts`) of `List*`/`Get*`/`Describe*` commands. Anything else, including data-reading commands (`GetObject`, `Scan`, `Query`, `ReceiveMessage`), code downloads (`GetFunction`), account-wide crawls (`ListRoles`) and every mutation, throws before it leaves the process.
- A test scans the collector sources and proves every command they construct is allowlisted, and that no allowlisted command is unused. The IAM policy below is **generated from the same list**; a test fails if they drift.
- The tool never creates scan resources, bootstraps, deploys, imports or deletes. The MCP server has no such tool. `cdk synth` (opt-in) is the only thing that executes code, and only generated code whose files match the manifest.
- Credentials come from the standard AWS provider chain (profile, SSO, optional AssumeRole). They are never accepted as arguments, written to `.c2c/`, snapshots or generated code, or sent to a model.

### Least-privilege policy

[`least-privilege-policy.json`](least-privilege-policy.json) (generated):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CloudToCodeReadOnlyDiscovery",
      "Effect": "Allow",
      "Action": [
        "dynamodb:DescribeContinuousBackups",
        "dynamodb:DescribeTable",
        "dynamodb:DescribeTimeToLive",
        "dynamodb:ListTables",
        "dynamodb:ListTagsOfResource",
        "events:ListEventBuses",
        "events:ListRules",
        "events:ListTagsForResource",
        "events:ListTargetsByRule",
        "iam:GetRole",
        "iam:GetRolePolicy",
        "iam:ListAttachedRolePolicies",
        "iam:ListRolePolicies",
        "iam:ListRoleTags",
        "lambda:ListEventSourceMappings",
        "lambda:ListFunctions",
        "lambda:ListTags",
        "s3:GetBucketLocation",
        "s3:GetBucketNotification",
        "s3:GetBucketPublicAccessBlock",
        "s3:GetBucketTagging",
        "s3:GetBucketVersioning",
        "s3:GetEncryptionConfiguration",
        "s3:ListAllMyBuckets",
        "sqs:GetQueueAttributes",
        "sqs:ListQueueTags",
        "sqs:ListQueues"
      ],
      "Resource": "*"
    },
    {
      "Sid": "CloudToCodeReadHttpApis",
      "Effect": "Allow",
      "Action": ["apigateway:GET"],
      "Resource": ["arn:aws:apigateway:*::/apis", "arn:aws:apigateway:*::/apis/*"]
    }
  ]
}
```

Grant only the services you scan (`c2c discover --services ...`), and scope `Resource` further where you can. `sts:GetCallerIdentity` needs no permission.

### Honest caveats about what AWS returns

- `lambda:ListFunctions` returns each function's environment variable **values** inside the response. There is no API option to omit them. Cloud to Code keeps only the variable **names**; the values are dropped in memory immediately after the response is parsed and are never stored, logged or sent anywhere. If that in-memory exposure is unacceptable for your account, do not grant the Lambda permission and scan other services.
- `sqs:GetQueueAttributes` can return the queue policy; it is ignored and not stored. Rule target inputs are replaced with a marker.
- IAM policy documents and trust policies **are** stored in the snapshot (they are needed to preserve permissions). They are metadata, not secrets, but treat snapshots as sensitive: they contain account IDs, ARNs, names and policies.

## Sanitization

Sanitization happens before persistence, prompts, MCP responses, diagrams and reports (`core/sanitize`, `sanitizeSnapshot`): secret-looking values and keys are redacted (AWS key IDs, JWTs, bearer tokens, private keys, `password=...`), control characters stripped, sizes and depth capped. It is defense in depth: collectors also build properties from explicit allowlists. Regression tests seed canary secrets and assert they never reach snapshots, workspaces, prompts, diagrams or generated files.

## Untrusted input and prompt injection

Tags, resource names, descriptions, policies and model output are **untrusted data**. Where text reaches a model it is wrapped in `<untrusted>` markers (delimiter forging is neutralized) and the system prompt says to ignore instructions inside. More importantly, models have **no authority**: they cannot call tools, run commands, write files or change policy. Their output must pass strict schemas and, for plans, the deterministic verifier, which rejects nonexistent resources, invented evidence or decisions, ambiguous ownership, plans that contradict the user's decisions, implicit secrets and unresolved blocking questions. Tests cover hostile tags and names end to end.

## External model privacy

AI is optional. Without it every deterministic workflow works. Before inventory data goes to an external provider:

1. `c2c ai preview` shows exactly what would be sent (destination, bytes, included and excluded categories, digest; `--show-data` prints the payload).
2. Consent is explicit (an interactive prompt that defaults to **no**, or `--allow-external-model`), and is bound to the provider, endpoint, model **and the exact data digest**; changed data needs fresh consent.
3. `privacy.externalModelContext: never` blocks external providers. Local endpoints (Ollama on `localhost`) keep data on your machine and need no consent.
4. Never sent: IAM policy documents (counts only), Lambda environment values, code, secrets, data. API keys are read from environment variables only and never stored.

Agent hosts (Claude Code, Codex, ...) process whatever the conversation contains under their own privacy terms; the MCP tools return sanitized data only.

## Local files

`.c2c/` holds sessions, sanitized snapshots, decisions and plans: directories `0700`, files `0600`, atomic writes, symlinks refused, session IDs validated against path traversal. Generated projects are written only to a new or empty directory unless you pass `--overwrite`. The MCP server confines every path to its workspace and refuses `.c2c`.

## Running generated code

`cdk synth` executes TypeScript. `c2c validate --synth` runs only the project's own `node_modules/.bin/cdk`, only when the files match the generated manifest (or you pass `--trust`), in a process with a throwaway `HOME`, null AWS credential files and no AWS environment variables. This reduces but does not eliminate risk: the code runs as your OS user. Never run it on a repository you do not trust.

## Not guaranteed

- Equivalence between generated infrastructure and the running one. `cdk synth` and the generated tests prove only that the code builds and reproduces the observed properties listed in `coverage.json`.
- Safety of adoption/import. Stateful and shared resources always need manual review.
- That the AWS collectors behave identically against a real account: they are tested against an in-memory fake of the SDK.
