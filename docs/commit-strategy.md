# Commit and Branching Strategy

Applies to the whole project lifetime. Companion to [development-plan.md](development-plan.md).

## 1. Principles

1. **One logical change per commit.** A commit builds, passes lint/typecheck/tests on its own, and can be reverted alone.
2. **Tests travel with code.** A feature commit includes its tests (including a negative case). Never "add tests later".
3. **Contracts first.** Schema commits land before the code that consumes them.
4. **History is documentation.** Commit bodies explain _why_, especially for safety, schema, and AWS-permission decisions.
5. **No secrets, ever.** Fixtures are synthetic or sanitized. A leaked credential means rotate first, then rewrite history.
6. **Nothing is pushed, tagged, or published without explicit maintainer approval.**

## 2. Commit message format (Conventional Commits 1.0)

```text
<type>(<scope>): <imperative summary, <= 72 chars, no trailing period>

<body: why this change, what was considered, trade-offs; wrapped at 80>

<footers>
```

### Types

| Type       | Use                                                           |
| ---------- | ------------------------------------------------------------- |
| `feat`     | New user-visible or API capability                            |
| `fix`      | Bug fix                                                       |
| `schema`   | Change to a versioned public model (also use `!` if breaking) |
| `docs`     | Documentation only                                            |
| `test`     | Tests/fixtures only                                           |
| `refactor` | Behavior-preserving restructuring                             |
| `perf`     | Performance improvement                                       |
| `build`    | Build system, pnpm, TypeScript config, dependencies           |
| `ci`       | GitHub Actions and automation                                 |
| `chore`    | Repo maintenance with no product effect                       |
| `security` | Hardening, sanitization, allowlist changes                    |
| `revert`   | Reverts a previous commit                                     |

### Scopes (match the package/area)

`core`, `reconstruction`, `aws`, `ai`, `generator`, `validator`, `diagram`, `mcp`, `cli`, `testing`, `plugin-claude`, `plugin-codex`, `plugin-cursor`, `examples`, `docs`, `repo`, `deps`, `release`.

Use no scope for changes that span the whole repo.

### Footers (in this order)

```text
BREAKING CHANGE: <what breaks and the migration path>
Refs: #123
Signed-off-by: Name <email>
Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
```

- `Signed-off-by` is **mandatory** (DCO). Use `git commit -s`. CI rejects commits without it.
- The `Co-Authored-By` line is added only to commits Claude Code helped author.

### Examples

```text
schema(core)!: rename Relationship.kind 'iam-access' to 'possible-access'

IAM permission proves potential authorization, not runtime access
(CLAUDE.md section 10). The old name implied a confirmed edge.
Adds migration v1 -> v2 and a compatibility test.

BREAKING CHANGE: snapshots at schemaVersion 1 must be migrated with
`migrateSnapshot()`; unmigrated reads now fail validation.
Signed-off-by: Jane Dev <jane@example.com>
```

```text
security(aws): reject non-allowlisted SDK commands at the client boundary

Adds a middleware that throws on any command not in READ_ONLY_COMMANDS.
Negative test proves PutItemCommand and InvokeCommand are unreachable.
Signed-off-by: Jane Dev <jane@example.com>
```

### Rules

- Summary is imperative ("add", not "added"); lowercase after the colon.
- Never commit generated output, `.c2c/` workspaces, `node_modules`, `.env`, or real account IDs.
- `WIP` commits are allowed only on personal branches and must be squashed before review.
- Do not mix formatting-only changes with logic changes.

## 3. Branching model: trunk-based with short-lived branches

- `main` is always releasable and protected: PR required, CI green, DCO check, linear history, no force-push.
- Branch names: `<type>/<scope>-<short-desc>`, e.g. `feat/aws-dynamodb-collector`, `fix/core-arn-normalization`, `docs/architecture`.
- Branches live at most about 3 working days. Larger work is split into stacked PRs, each independently mergeable.
- Release branches (`release/x.y`) are created only when a maintenance backport is needed.
- Milestone work uses a label (`M4`, `M8`, ...), not a long-lived branch.

## 4. Pull requests

- **Size:** target under 400 changed lines excluding fixtures and lockfiles. Larger PRs need a justification in the description.
- **Merge method:** _squash_ for single-purpose PRs (the PR title becomes the commit and must follow the format above); _rebase-merge_ when each commit is already clean and meaningful (milestone PRs).
- **Title** follows Conventional Commits; **description** states: what, why, evidence of testing, negative case, docs updated, AWS permissions or dependencies introduced.
- **Checklist (PR template):** tests added incl. negative case; docs and `resource-support.md` synced; no unsupported capability claims; schema change has migration; DCO signed.
- Schema, security-allowlist, and consent-flow changes require a second reviewer (CODEOWNERS).

## 5. Atomic commit recipes

| Change                          | Commits (in order)                                                                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New schema                      | `schema` (types + tests) -> `docs` (interaction-model/architecture)                                                                                                             |
| New AWS collector               | `schema`/`feat(core)` if new relationship kinds -> `security(aws)` allowlist entries -> `feat(aws)` collector + mocks -> `test(testing)` fixture -> `docs(docs)` support matrix |
| New CLI command                 | `feat(reconstruction)` use case + tests -> `feat(cli)` command wiring + JSON contract tests -> `docs`                                                                           |
| New generated construct mapping | `feat(generator)` mapping + unit tests -> `test(generator)` snapshot/CDK assertions -> `docs` coverage notes                                                                    |
| Dependency addition             | `build(deps)` with rationale and security implications in the body (CLAUDE.md section 18.14)                                                                                    |
| Bug fix                         | `test` reproducing failure (may be same commit) + `fix`                                                                                                                         |

## 6. Phase 0 commit plan (concrete)

Target: roughly 35 commits on `main` through squash/rebase merges. Each line is one commit.

**Repo bootstrap**

1. `chore(repo): initialize repository with Apache-2.0 license and NOTICE`
2. `build(repo): add pnpm workspace, tsconfig.base strict ESM, .nvmrc, .editorconfig`
3. `build(repo): add eslint flat config, prettier, and shared vitest config`
4. `ci(repo): add CI workflow (lint, typecheck, test, build; Node 22 and 24)`
5. `ci(repo): add DCO check, CodeQL, and dependency review`
6. `docs(repo): add README skeleton with explicit Status section`
7. `docs(repo): add CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, GOVERNANCE`
8. `chore(repo): add issue forms, PR template, CODEOWNERS, dependabot`
9. `docs(docs): add architecture.md, roadmap.md, ADR 0001 and 0002`

**M0: contracts** (`packages/core`) 10. `build(core): scaffold @cloud-to-code/core package` 11. `schema(core): add Evidence, Diagnostic, and ID/ARN primitives` 12. `schema(core): add CloudResource, Relationship, CloudSnapshot` 13. `schema(core): add Question, Decision, Session, and state machine types` 14. `schema(core): specify StackPlan, ConstructPlan, Assumption, UnresolvedProperty, ReconstructionPlan` 15. `feat(core): add schemaVersion registry and migration framework` 16. `test(core): add round-trip, rejection, and compatibility tests`

**M1: fixture + graph** 17. `build(testing): scaffold @cloud-to-code/testing package` 18. `test(testing): add sanitized serverless-orders snapshot fixture` 19. `feat(core): add graph builder with deduplication and edge direction` 20. `feat(core): model IAM-derived edges as possible-access` 21. `test(core): graph tests (ARN variants, unresolved refs, global resources)`

**M2: questions + sessions** 22. `build(reconstruction): scaffold @cloud-to-code/reconstruction package` 23. `feat(reconstruction): add ambiguity detectors (shared resource, unlinked source, possible-access)` 24. `feat(reconstruction): generate questions with evidence, options, and consequences` 25. `feat(reconstruction): add session state machine and .c2c workspace store` 26. `security(reconstruction): redact secrets in free-text answers before persistence` 27. `feat(reconstruction): record decisions with provenance and revision history` 28. `feat(reconstruction): invalidate decisions when evidence changes` 29. `test(testing): add fake AI adapter` 30. `test(reconstruction): blocking-question, resume, unknown-answer, and fake-decision rejection tests`

**M3: CLI** 31. `build(cli): scaffold @cloud-to-code/cli with c2c bin` 32. `feat(cli): add inspect command with human and --json output` 33. `feat(cli): add questions, answer, resume, decisions commands` 34. `feat(cli): add non-interactive NEEDS_INPUT contract and --answers` 35. `feat(diagram): deterministic Mermaid output from graph` (internal module until `diagram-mermaid` is justified as a package) 36. `test(cli): end-to-end inspect -> answer -> resume workflow` 37. `test(core): prompt-injection and sanitization regression tests` 38. `docs(docs): sync README Status, interaction-model.md, and resource-support.md`

Exit of Phase 0: tag `v0.1.0-alpha.0` (maintainer decision).

## 7. Commit plans for later phases (outline)

**Phase 1** (one PR per bullet, 3-8 commits each): `aws` client factory + allowlist; Lambda collector; API Gateway v2 collector; DynamoDB collector; diagnostics for denied/skipped; relationship resolvers; `ai` provider interface; Bedrock adapter; consent + data preview; plan proposal schema in `ai`; plan verifier; `reconstruct` command; generator skeleton; Lambda/API/DynamoDB mappings; reports (`coverage.json`, `migration-plan.md`); generated tests; validator (typecheck, synth); repair loop.

**Phase 2**: `mcp` server skeleton; one commit per tool with schema + tests; resources + pagination; Claude Code plugin manifest + skills; Codex plugin + compatibility adapter; parity test.

**Phase 3**: one PR per service (`feat(aws): add SQS collector` ... each with fixture and matrix update); grouping; `faithful`/`reference`; packaging; docs.

## 8. Releases and versioning

- **SemVer per package** once 1.0; before 1.0, `0.y.z` with breaking changes allowed but always documented and migrated for serialized models.
- Public schema versions are independent of package versions (`schemaVersion`), with migrations kept forever for supported versions.
- Tags: `v<version>` for the CLI (primary), `<package>@<version>` for others if versioned independently. Changesets or an equivalent tool is a later decision, taken before the first npm publish.
- `CHANGELOG.md` is generated from Conventional Commits; `schema`, `security`, and `BREAKING CHANGE` entries are always surfaced.
- Publishing to npm, tagging, and pushing require explicit maintainer authorization each time.

## 9. Enforcement (automated)

- `commitlint` (conventional config + scope enum) in CI on PR titles and commits.
- DCO app/action verifying `Signed-off-by`.
- `lint-staged` + a local `commit-msg` hook are _optional_ developer conveniences; CI is the source of truth. Persistent hooks are never installed without the owner's approval.
- Secret scanning (GitHub push protection) enabled on the repository.

## 10. Reverts and history hygiene

- Prefer `revert` commits on `main`; never rewrite shared history.
- If sensitive data is committed: rotate the credential, notify via SECURITY.md process, then purge with maintainers' coordination.
