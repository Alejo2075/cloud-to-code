# ADR 0002: AWS is read-only by construction

Status: accepted

Trust in a reverse-engineering tool depends on it being unable to harm the account. Instead of promising not to mutate, every SDK send goes through an allowlist of List/Get/Describe commands; the IAM policy is generated from that list; tests prove the collectors cannot reach anything else; and the MCP surface has no deploy/import/delete tool. Data-bearing reads (S3 objects, DynamoDB items, queue messages, function code) are excluded even though they are "reads". Known unavoidable exposure (Lambda environment values returned by `ListFunctions`) is documented in `security.md`.
