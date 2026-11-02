# Development Plan

Detailed delivery plan for Cloud to Code. Source of truth for scope is [CLAUDE.md](../CLAUDE.md); commit conventions are in [commit-strategy.md](commit-strategy.md).

Sizing: **S** 1-3 days, **M** ~1 week, **L** 2-3 weeks, **XL** 4+ weeks (one engineer, relative effort, not dates).

Every milestone ends with the **Definition of Done**: implementation, tests including a negative case, docs, diagnostics, a useful fixture, and no unsupported capability claims.

---

## 0. Global conventions

### 0.1 Package dependency rules

- `core` imports no AWS SDK, MCP SDK, or model SDK.
- Adapters (`cli`, `mcp`, plugins) -> `reconstruction` -> `core` interfaces. `provider-aws`, `ai`, `generator-cdk`, `validator` implement interfaces.
- Plugins never call AWS directly and never duplicate collectors, generation, or question state.
- Enforce with an ESLint import-boundary rule and a CI check that fails on forbidden imports.

### 0.2 Error and result model

- Operations return a typed `Result` (ok | needs-input | blocked | failed) with diagnostics, not thrown strings.
- CLI exit codes: `0` ok, `1` failed, `2` usage error, `10` NEEDS_INPUT, `11` BLOCKED, `12` permission/consent missing.

### 0.3 Determinism

- Stable ordering of resources, relationships, and JSON keys; no timestamps inside generated code (timestamps live only in snapshot metadata).
- Snapshot-based tests (golden files) reviewed in PRs.

### 0.4 Test layers

| Layer           | Tooling                                                      | Runs in CI                        |
| --------------- | ------------------------------------------------------------ | --------------------------------- |
| Unit            | Vitest                                                       | yes                               |
| Contract/schema | Vitest + Zod, compatibility fixtures per `schemaVersion`     | yes                               |
| AWS collector   | SDK client mocks, recorded sanitized responses               | yes (no AWS account)              |
| Workflow/E2E    | CLI spawned against fixtures                                 | yes                               |
| Generated CDK   | typecheck + CDK assertions + `cdk synth` on generated sample | yes (trusted generated code only) |
| Real AWS smoke  | manual, opt-in, read-only profile                            | no                                |

### 0.5 Sanitization pipeline (central, used everywhere)

Single `sanitize()` module: property allowlists per resource type, secret pattern detection, ARN/account handling policy, size caps. Called **before** persistence, logs, prompts, MCP responses, diagrams, and reports. Any new data path must go through it (enforced by tests that scan outputs for seeded canary secrets).

---

# PHASE 0: Foundation and shared contracts

Goal: contracts and the question/decision loop work offline, with no AWS account and no AI key.

## M0. Repository and contracts (L)

### M0.1 Repo bootstrap (S)

- Files: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.nvmrc` (22), `.editorconfig`, `.gitignore`, `.gitattributes`, `eslint.config.js`, `.prettierrc`, `vitest.workspace.ts`, `LICENSE`, `NOTICE`.
- CI: lint, typecheck, test, build matrix (Node 22/24); DCO; CodeQL; dependency review.
- Acceptance: `pnpm install && pnpm -r build && pnpm -r test` green on a clean clone.

### M0.2 Primitives (S)

- `Evidence`, `Diagnostic` (severity, code, message, optional resource, remediation), ID builder (`account/region/type/physicalId`), ARN parser/normalizer (partitions, global services, variants).
- Tests: ARN edge cases (cross-region, no-region S3/IAM, GovCloud/China partitions rejected or explicitly handled), ID stability.

### M0.3 Snapshot model (M)

- `CloudResource`, `Relationship` (kind enum, `confidence`, `evidenceIds`), `CloudSnapshot`.
- Relationship kinds (initial): `invokes`, `routes-to`, `reads-from-stream`, `dead-letters-to`, `assumes-role`, `possible-access`, `shared-by`.
- Invariants checked in a `validateSnapshot()`: every `evidenceId` resolves, every relationship endpoint exists or is flagged `unresolved`, no duplicate IDs.

### M0.4 Interaction model (M)

- `ReconstructionQuestion`, `DeveloperDecision`, `Session`, session state machine (`DISCOVERING`...`FAILED`) with an explicit transition table and tests for illegal transitions.
- Answer validation: option IDs must exist, type must match, `unknown` only if `allowUnknown`.

### M0.5 Plan model (M)

- Concretely specify the types CLAUDE.md leaves open:
  - `StackPlan { id, name, constructIds, rationale, evidenceIds }`
  - `ConstructPlan { id, resourceIds, level: 'L1' | 'L2' | 'custom', mappingRuleId, properties[], evidenceIds, decisionIds }`
  - `Assumption { id, statement, kind: 'ai-hypothesis' | 'default', accepted: boolean, evidenceIds }`
  - `UnresolvedProperty { resourceId, property, reason, requiredFor }`
- `ReconstructionPlan` with `generation.strategy` and `ownership` per resource (`recreate | reference | adopt`).

### M0.6 Versioning (S)

- `schemaVersion` registry, `migrate()` pipeline, compatibility fixtures committed per version.
- Acceptance: loading a v(N-1) fixture migrates to v(N) and validates.

## M1. Fixture and evidence graph (L)

### M1.1 `serverless-orders` fixture (M)

Synthetic, fully sanitized. Contents:

- HTTP API `orders-api` with routes `POST /orders`, `GET /orders/{id}`.
- Lambda `orders-handler` (role, runtime, memory, timeout; **no env values**).
- DynamoDB `orders-table` (key schema, GSI, stream on, SSE).
- SQS `orders-dlq` with redrive from `orders-queue`.
- EventBridge bus `shared-events` referenced by two app candidates (Orders and Billing).
- IAM role with a policy that allows access to `orders-table` but with no confirmed runtime integration (intentional ambiguity), and one unlinked Lambda source.
- Plus `expected/` outputs and a **canary-secret variant** to prove redaction.

### M1.2 Graph builder (M)

- Deduplicate, resolve ARN variants, orient edges, attach confidence, expose queries (`neighbors`, `components`, `sharedResources`).
- IAM-derived edges are `possible-access` / `hypothesis`, never `confirmed`.
- Output: deterministic graph JSON.

### M1.3 Candidate boundaries (S)

- Connected-components + shared-resource detection producing `applicationCandidates` with ambiguity flags.

Tests: direction, dedupe, unresolved refs, global resource, shared dependency, IAM-not-confirmed, determinism (two runs byte-equal).

## M2. Question engine and sessions (L)

### M2.1 Ambiguity detectors (M)

Pluggable detectors, each pure `(graph, decisions) -> Finding[]`:

1. Shared resource ownership.
2. Unlinked Lambda source.
3. `possible-access` needing confirmation.
4. Stateful resource handling (table/queue) intent.
5. Scope expansion consent (new region).

### M2.2 Question builder (M)

- Maps findings to `ReconstructionQuestion` with: what was found, uncertainty, why it matters, options with consequences, safe suggested option (only when demonstrably safe), effect of skipping, `requiredFor`.
- Batching: max 3 per batch, ordered `blocking` > `important` > `optional`.
- Never asks for facts the graph already contains.

### M2.3 Workspace and persistence (M)

- `.c2c/` layout: `sessions/<id>/{session.json,snapshot.json,decisions.jsonl,plan.json}`; dirs `0700`, files `0600`.
- Atomic writes (temp + rename), schema-validated reads, corruption diagnostics.
- Credentials are never written; secret detection redacts free-text answers before save.

### M2.4 Decisions and history (S)

- Append-only decision log, revision creates a new record with `supersedes`.
- Invalidation: a content hash of the evidence each decision depends on; on mismatch the question reopens with an explanation of what changed.

### M2.5 Fake AI adapter (S)

- Scripted adapter used by tests to drive the interview loop deterministically.

Tests: blocking question with evidence and choices; answer persists and does not reappear on resume; `unknown` on blocking prevents generation; invalid option ID rejected; fabricated decision (wrong session/question) rejected; secret in answer redacted; evidence change reopens question.

## M3. CLI offline and diagrams (M)

- Framework: `commander` + `@clack/prompts` (decision pending; see section "Open decisions").
- Commands: `inspect`, `questions`, `answer`, `resume`, `decisions`, `demo`. Others print "unavailable in this version".
- `--json` guarantees stdout contains only JSON; progress goes to stderr.
- `--non-interactive`: never prompts; returns `NEEDS_INPUT` (exit 10) with the pending questions JSON.
- `--answers <file>`: schema-validated; unknown IDs rejected.
- Mermaid: deterministic ordering, escaped labels (injection-safe), generated from the graph.
- Tests: E2E workflow, CI mode never hangs (timeout test), JSON purity test, Mermaid golden files, injection payloads in names/tags rendered inert.

**Phase 0 exit:** fixture inspection, question creation, decision persistence, and tests work with no AWS account or AI key. Docs and README Status reflect exactly this.

---

# PHASE 1: One real end-to-end AWS use case

Goal: scoped real or sanitized snapshot -> meaningful questions -> reviewable, synthesizable CDK project with explicit unresolved items.

## M4. `provider-aws`: read-only discovery (XL)

### M4.1 Client factory and guardrails (M)

- Credential provider chain (profile, SSO, explicit AssumeRole). STS `GetCallerIdentity` printed and confirmed before discovery.
- **Read-only allowlist** (`READ_ONLY_COMMANDS`): SDK middleware throws on any non-listed command. Negative test enumerates mutating commands (Put/Create/Delete/Update/Invoke/Start/...) and proves they are unreachable.
- Bounded concurrency, adaptive retries with jitter, per-call timeouts, `AbortSignal` cancellation.

### M4.2 Scope (S)

- Explicit `accountIds`, `regions`, `services`; unknown scope entries rejected; new account/region requires recorded consent.

### M4.3 Collectors (L total)

| Service   | Calls (read-only)                                                                   | Notes                                                           |
| --------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Lambda    | `ListFunctions`, `GetFunctionConfiguration`, `ListEventSourceMappings`, `GetPolicy` | Strip env values; never `GetFunction` code location or `Invoke` |
| API GW v2 | `GetApis`, `GetRoutes`, `GetIntegrations`, `GetStages`                              | Authorizers recorded as metadata only                           |
| DynamoDB  | `ListTables`, `DescribeTable`, `DescribeTimeToLive`, `DescribeContinuousBackups`    | No `Scan/Query/GetItem`                                         |

- Each collector: pagination, per-resource diagnostics, access-denied -> diagnostic (not failure), sanitized allowlisted properties, evidence records pointing to the AWS operation/field.

### M4.4 Docs (S)

- Least-privilege IAM policy JSON in `docs/security.md`, verified to equal the allowlist by a test.

Tests: pagination, throttling retry, partial denial, empty region, cancellation, allowlist negative test, canary secret never appears in snapshot.

## M5. `ai`: provider abstraction and consent (L)

### M5.1 Interface (S)

`AiProvider { propose(task, input, schema, signal) -> Result<T> }` plus token/cost accounting. Model code stays in `packages/ai`.

### M5.2 First adapter (M)

- Bedrock (proposed), model/inference-profile discovered and validated, not hardcoded.
- Structured output validated against Zod, bounded retries with feedback, context-window budgeting, cancellation.

### M5.3 Configuration (M)

- `c2c init`, `aws connect`, `ai connect`, `ai test`, `config show` (never prints credentials). Per-user config dir; secrets via credential chain / OS store / env vars.

### M5.4 Consent and data preview (M)

- Preview of exactly what would leave the machine (categories, provider, destination) viewable offline.
- Consent recorded per provider and per session; absent consent -> no external call (tested with a network-spy adapter).

Tests: no call before consent; provider failure keeps snapshot, decisions, and previous valid plan; malformed output rejected and retried within bound.

## M6. Relationship resolvers (L)

- Confirmed: API integration -> Lambda, event source mappings, DynamoDB streams -> Lambda, SQS redrive.
- Derived: role -> resource policy facts.
- Hypothesis: IAM allow, naming conventions, shared tags (`possible-access`, never confirmed).
- Application candidate scoring documented and tested.

## M7. Interpretation, interview, plan verification (L)

### M7.1 Architecture interpretation (M)

- Prompt builder uses only sanitized allowlisted data; untrusted fields wrapped and labeled as data. Output: groupings, purposes, ambiguities referencing graph IDs.

### M7.2 Interview loop (M)

- AI proposes questions -> validated against the shared question schema -> rendered by the CLI. No unmanaged prompts without machine-readable IDs.

### M7.3 Plan proposal and **deterministic verifier** (M)

Rejects: nonexistent resource IDs, missing/unknown evidence IDs, fabricated decisions, unsupported mappings, implicit secret values, ambiguous ownership, unresolved blocking questions, strategy/ownership mismatches.

### M7.4 `c2c reconstruct` (S)

- Direct entry: `--resource <arn> --include-related --output <dir>`, confined to a confirmed scope (no account-wide crawl).

Tests: hallucinated IDs, fake decisions, injection in tags/descriptions has no effect on tools, resume after provider failure.

## M8. `generator-cdk` (XL)

### M8.1 Project skeleton emitter (M)

- Emits layout from CLAUDE.md section 11 (`bin/`, `lib/stacks`, `lib/constructs`, `test/`, `reports/`, `.c2c/manifest.json`, `package.json`, `tsconfig.json`, `cdk.json`, `README.md`).
- Writes only to a new directory; overwrite needs explicit consent.

### M8.2 Mapping rules (L)

- Rule registry with IDs (provenance): Lambda function (L2 `Function` vs L1 when unsupported props), HTTP API (`HttpApi` L2 / L1 `CfnApi`), DynamoDB `Table` (retain policy preserved, never silently changed), IAM role/policy statements preserved (no silent removal).
- `balanced`: L2 only where behavior is provably preserved; else L1 with a comment citing the rule.
- Unavailable values become CDK parameters / explicit TODOs; physical names never invented.

### M8.3 Reports (M)

- `architecture.md` (with Mermaid), `reconstruction-decisions.md`, `coverage.json` (per-property status: preserved / approximated / unresolved), `migration-plan.md` (recreate vs reference vs adopt warnings).

### M8.4 Generated tests (S)

- CDK assertion tests for stable properties.

Tests: byte-identical output for identical plan; generated project typechecks; golden snapshots; no fabricated required values; stateful-resource retention preserved; every generated resource has a provenance link in the manifest.

## M9. `validator` and repair loop (L)

- Stages: schema check, typecheck, `cdk synth` (only on generated/trusted code, with documented constraints), configuration comparison vs snapshot, residual-risk report.
- Report language always separates **synthesizes** from **equivalent / safely importable**.
- Repair loop: AI proposes fixes, user asked when more than one valid fix, revalidate, never hide remaining issues.
- `c2c validate`, `c2c adoption plan` (advisory, no AWS calls).

**Phase 1 exit:** from the fixture (and optionally a real scoped account) a developer answers questions and gets a reviewable, synthesizable CDK project with explicit unresolved items; no AWS resource modified.

---

# PHASE 2: MCP, Claude Code, Codex

## M10. `mcp` stdio server (L)

- Official MCP TypeScript SDK; one tool per commit with schema + tests: `aws_discover`, `inspect_application`, `start_reconstruction`, `get_pending_questions`, `submit_decisions`, `submit_reconstruction_plan`, `generate_cdk`, `validate_cdk`, `get_migration_plan`.
- Large artifacts as MCP Resources with pagination; short structured tool responses; stable IDs instead of re-sending inventory.
- Policy enforced server-side; no deploy/import/delete/shell/unbounded AWS read; file-writing tools validate destination and overwrite consent.
- Server never calls an AI provider, never blocks waiting for a human.
- Tests: fake client harness, invalid args rejected, forbidden tools absent from the tool list, parity with CLI use cases (same functions).

## M11. Claude Code plugin (M)

- Verify current spec first. Files: `.claude-plugin/plugin.json`, `.mcp.json`, `skills/reconstruct/SKILL.md`, `skills/inspect/SKILL.md`.
- Skill encodes the 8-step host workflow (scope -> discover -> explain -> ask via chat -> submit decisions -> submit plan -> generate -> validate), forbids fabricating answers.
- Tests: manifest/path validation, scripted conversation with fake MCP responses.

## M12. Codex and compatibility adapter (M)

- Verify current OpenAI plugin spec. `plugin.json`, `mcp.json`, `skills/reconstruct/SKILL.md`; MCP-only install doc for other clients.
- Adapter layer isolates host-specific manifest differences; shared skill text generated from one source where possible.

## M13. Parity and demos (M)

- Same approved plan -> identical CDK via CLI and MCP (golden test).
- Same unresolved questions in all hosts.
- **Exit:** one reconstruction finished via CLI, Claude Code, and Codex using stored fixtures.

---

# PHASE 3: Broader coverage and public OSS launch

## M14. More services (XL, split into community-friendly PRs)

| Service     | Adds                                                 | Fixture                       |
| ----------- | ---------------------------------------------------- | ----------------------------- |
| SQS         | queues, redrive, DLQ edges, Lambda ESM               | queue + DLQ                   |
| EventBridge | buses, rules, targets, schedulers                    | cross-app shared bus          |
| IAM         | role trust, sanitized policy facts                   | least-privilege roles         |
| S3          | bucket metadata, notification config (never objects) | bucket -> Lambda notification |

Each: allowlist entries, collector, resolvers, mapping rules, docs matrix row, negative test.

## M15. Grouping and strategies (L)

- Richer application grouping; `faithful` strategy; `reference` ownership only where CDK APIs allow (`fromXxxAttributes`/lookups) and provable; `adopt` advisory: logical IDs, supported import types, retention, downtime, manual steps. `cdk import` is never invoked.

## M16. Packaging and launch (L)

- Package publishing config (publish only with maintainer approval), provider comparison, least-privilege policy page, recorded real demo, `good first issue` set, contributor guides for collectors/resolvers/fixtures/skills.
- **Exit:** three unfamiliar developers complete a reconstruction and understand the report without maintainer help.

---

# PHASE 4: Advanced (post-MVP, not started before Phases 1-2 are done)

Git integration and PR proposals; safe drift detection; multi-account; additional services; optional source linking; more agents (Cursor, Gemini CLI); optional UI; modernization proposals (always a separate artifact).

---

## Cross-cutting workstreams

| Stream            | Cadence                            | Notes                                           |
| ----------------- | ---------------------------------- | ----------------------------------------------- |
| Security review   | each collector, each new data path | allowlist, sanitization, canary tests           |
| Docs sync         | every PR                           | README Status, `resource-support.md`, roadmap   |
| Schema governance | every `schema` commit              | migration + compat fixture + 2nd reviewer       |
| Dependency review | each `build(deps)`                 | rationale + security implication in commit body |
| Spec verification | start of M10-M12                   | re-read official plugin/MCP docs                |
| Threat model      | per phase                          | update `docs/security.md`                       |

## Risk register

| Risk                              | Impact                | Mitigation                                                                   |
| --------------------------------- | --------------------- | ---------------------------------------------------------------------------- |
| Synth mistaken for safe migration | Data loss on adoption | Report wording, mandatory manual review of stateful/shared resources         |
| Partial IAM permissions           | Incomplete graph      | Prominent diagnostics; absence != non-existence                              |
| L2 semantics drift                | Behavior change       | Default to L1 when unproven; coverage report flags approximations            |
| Prompt injection via tags/names   | Unsafe actions        | Untrusted-data wrapping, no tool authority for model output, injection tests |
| Spec churn (plugins/MCP)          | Broken installs       | Adapter layer, verify specs at implementation time                           |
| Scope creep                       | Late core             | Phase gates; Phase 4 locked                                                  |
| LLM cost/privacy                  | Trust loss            | Consent, preview, minimization, local-model route                            |
| Single-maintainer bus factor      | Stalls                | Governance doc, good-first-issues, ADRs                                      |

## Open decisions (default shown)

1. CLI libraries: `commander` + `@clack/prompts`.
2. First AI provider: Bedrock.
3. Changesets vs commit-derived changelog: decide before first npm publish.
4. Cloud-to-code GitHub owner/username: placeholder `OWNER` until provided.
5. Code of Conduct and issue/PR templates: included by default; remove if unwanted.
