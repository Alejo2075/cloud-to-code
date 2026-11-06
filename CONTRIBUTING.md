# Contributing to Cloud to Code

Thanks for helping. Cloud to Code is an open-source, local-first tool that turns running AWS infrastructure into maintainable AWS CDK code. Please read [CLAUDE.md](CLAUDE.md) (product and engineering principles) and [docs/roadmap.md](docs/roadmap.md) first: they say what is in scope and what is intentionally not built yet.

## Ground rules

1. **AWS is read-only.** No change may add a code path that mutates AWS resources, deploys, bootstraps, imports, or deletes anything.
2. **Facts are not guesses.** Keep observed, derived, AI-proposed, and user-confirmed data distinct in the model.
3. **No secrets, no private data.** Fixtures and tests use synthetic or sanitized data only. Never commit credentials, real account IDs, or unsanitized snapshots.
4. **No unsupported claims.** If it is not implemented and tested, docs must label it as planned.
5. **One engine.** Plugins and adapters call shared operations; they never copy AWS collectors, generators, or question state.

## Development setup

Requirements: Node.js 22+ and pnpm 9.

```bash
pnpm install
pnpm check        # lint + typecheck (builds first) + tests
pnpm test         # unit and workflow tests only
pnpm format       # prettier
```

No AWS account, AI key, or network access is needed to run the test suite.

## Making a change

1. Open or find an issue; for large changes, discuss in an issue or Discussion first.
2. Create a short-lived branch: `<type>/<scope>-<desc>` (e.g. `feat/aws-sqs-collector`).
3. Keep commits atomic and use Conventional Commits (`type(scope): subject`), which commitlint enforces in CI.
4. **Sign every commit** (Developer Certificate of Origin): `git commit -s`. By signing you certify you wrote the change or have the right to submit it under Apache-2.0. See <https://developercertificate.org/>.
5. Open a PR using the template. Keep it small (about 400 changed lines excluding fixtures).

### Definition of done

- Implementation, tests **including a negative case**, docs, diagnostics, and a useful fixture.
- `pnpm check` passes.
- Public schema change: bump `schemaVersion`, add a migration and a compatibility fixture.
- README status and `docs/resource-support.md` match real behavior.

## Where contributions help most

| Area                      | How to start                                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| New AWS service collector | Read `docs/resource-support.md` and `packages/provider-aws/src/collectors/`. Add the read-only commands to the allowlist, a collector, a sanitized fixture, tests, and a matrix row. |
| Relationship resolvers    | `packages/provider-aws/src/resolvers/`. New edges must carry a confidence level and evidence.                                                                                        |
| Fixtures                  | `packages/testing/`. Must be synthetic and include an intentional ambiguity when useful.                                                                                             |
| CDK mapping rules         | `packages/generator-cdk/src/rules/`. Prefer L1 when L2 behavior cannot be preserved.                                                                                                 |
| Agent skills              | `plugins/`. Keep them thin; they call MCP tools.                                                                                                                                     |
| Docs                      | Anything under `docs/`. Fix unclear explanations or stale claims.                                                                                                                    |

Look for issues labeled `good first issue` and `help wanted`.

## Security

Do not open public issues for vulnerabilities. Follow [SECURITY.md](SECURITY.md).

## Code of conduct

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).
