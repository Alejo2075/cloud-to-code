# Security Policy

## Supported versions

Cloud to Code is pre-1.0. Only the latest released minor version receives security fixes.

## Reporting a vulnerability

**Do not open a public issue.** Report privately through GitHub's
[private vulnerability reporting](https://github.com/OWNER/cloud-to-code/security/advisories/new).
Include affected version, impact, and reproduction steps using synthetic data. Never include real credentials.

We aim to acknowledge reports within 5 business days and to share a remediation plan within 30 days.

## Scope

In scope: sanitization or redaction bypasses, any path that could mutate AWS resources, exposure of credentials or secret values in snapshots/logs/prompts/reports, prompt-injection paths that let model output trigger commands, file writes, network calls, or policy changes, unsafe handling of the local `.c2c/` workspace, MCP tool policy bypasses.

Out of scope: vulnerabilities in AWS services, in third-party model providers, or in a user's own AWS configuration; findings that require already-compromised local credentials.

## Security model (summary)

See [docs/security.md](docs/security.md) for details.

- AWS access is **read-only by default**, enforced by an allowlist of SDK commands at the client boundary.
- Data is **sanitized before** persistence, logs, prompts, MCP responses, diagrams, and reports.
- Secret values, Lambda environment values, database items, S3 objects, and deployment packages are never collected.
- AWS tags, names, descriptions, and model output are **untrusted input**. Model output is never executed.
- No data is sent to an external model without explicit consent and a reviewable preview.
- Telemetry is local-only.
