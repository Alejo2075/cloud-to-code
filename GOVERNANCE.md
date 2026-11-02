# Governance

Cloud to Code is a community open-source project under the Apache-2.0 license.

## Roles

- **Maintainers** review and merge PRs, cut releases, and enforce the Code of Conduct. Listed in `.github/CODEOWNERS`.
- **Contributors** are anyone who submits issues, docs, or code under the DCO.

## Decisions

- Day-to-day decisions use lazy consensus in PRs and issues.
- Changes to **public schemas**, the **read-only AWS allowlist**, **consent flows**, or **security policy** need approval from a maintainer who is not the author.
- Significant architectural decisions are recorded as ADRs in `docs/adr/`.

## Becoming a maintainer

Sustained, high-quality contributions plus an invitation from existing maintainers.

## Scope control

The product scope is defined in [CLAUDE.md](CLAUDE.md). Proposals that violate its non-negotiable principles (read-only AWS, no secret extraction, developer control) are declined regardless of other merits.
