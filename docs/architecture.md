# Architecture

Cloud to Code is one engine with several front doors. The intelligence/orchestration layer (a person, a host agent, or an optional model) is kept apart from the **trusted execution and validation layer**, which is deterministic. Anything a model or agent proposes is an _untrusted proposal_.

```text
                  STANDALONE CLI                  AGENT HOSTS
                 ┌────────────────┐    ┌────────────────────────────┐
                 │ Terminal       │    │ Claude Code / Codex / ...  │
                 │ (+ optional AI)│    │ Host model asks the user   │
                 └───────┬────────┘    └─────────────┬──────────────┘
                         │                    Plugin / MCP tools
                         └────────────┬───────────────┘
                                      ▼
                       ┌──────────────────────────┐
                       │ reconstruction: sessions,│
                       │ questions, decisions,    │
                       │ planner, plan verifier   │
                       └─────────────┬────────────┘
                                     ▼
   provider-aws ─► snapshot ─► core: evidence graph ─► generator-cdk ─► validator
   (read-only)     (sanitized)  (schemas, sanitize)     (deterministic)   (offline)
```

## Packages

| Package                          | Role                                                                                                                                         | Depends on                               |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `@cloud-to-code/core`            | Versioned Zod models, evidence graph, sanitization, session state machine. Imports **no** AWS, MCP or model SDK (enforced by ESLint).        | zod                                      |
| `@cloud-to-code/reconstruction`  | Shared use cases: inspect, question engine, decisions with provenance, resumable `.c2c` workspace, deterministic planner, **plan verifier**. | core                                     |
| `@cloud-to-code/provider-aws`    | Read-only discovery: SDK command allowlist, collectors, relationship resolvers, snapshot assembly.                                           | core, AWS SDK v3                         |
| `@cloud-to-code/generator-cdk`   | Deterministic CDK v2 generation from a snapshot + verified plan; shared `generateForSession` pipeline.                                       | core, reconstruction                     |
| `@cloud-to-code/validator`       | Offline checks, controlled synth, advisory adoption plan.                                                                                    | core                                     |
| `@cloud-to-code/diagram-mermaid` | Diagrams generated from the graph, never from model prose.                                                                                   | core                                     |
| `@cloud-to-code/ai`              | Optional providers (Bedrock, Anthropic, OpenAI, Ollama), consent gate, schema-validated advisory tasks.                                      | core, reconstruction                     |
| `@cloud-to-code/mcp`             | Local stdio MCP server (9 tools + resources).                                                                                                | all deterministic packages; **not** `ai` |
| `@cloud-to-code/cli`             | `c2c` binary.                                                                                                                                | all of the above                         |
| `@cloud-to-code/testing`         | Synthetic fixtures.                                                                                                                          | core                                     |

Dependency direction: adapters (CLI, MCP, plugins) → `reconstruction` → `core`. Plugins never call AWS and never copy collectors, generators or question state: they are instructions plus a manifest.

## Data flow

1. **Evidence acquisition (deterministic).** `provider-aws` sends only allowlisted List/Get/Describe calls and builds a `CloudSnapshot`: resources, relationships (each with `confirmed | derived | hypothesis` confidence), and evidence records. Everything is sanitized before it is stored.
2. **Graph and candidates (deterministic).** `core` joins ARNs, deduplicates edges and forms application candidates. Hubs that connect two candidates (event buses, topics, IAM roles) are flagged _shared_.
3. **Questions (deterministic).** Detectors in `reconstruction` raise questions only from real uncertainty. Each has an ID, evidence, options with consequences and a safe suggestion.
4. **Decisions.** A person (terminal) or a person via a host agent answers. The service validates every answer and records it with provenance. Changed evidence reopens the question.
5. **Plan.** The deterministic planner builds a `ReconstructionPlan`. A plan proposed by an agent or model must pass `verifyPlan`.
6. **Generation.** `generator-cdk` turns snapshot + verified plan into a CDK project, with a manifest linking every resource to evidence, a rule and decisions.
7. **Validation.** `validator` checks structure, hashes, coverage and optionally typecheck/synth, and always states what that does not prove.

## Where AI fits

_Standalone CLI:_ the configured provider is the AI (optional, consent-gated, advisory). _Agent plugins:_ the host's model is the AI and Cloud to Code never calls another model. Both consume the same `ReconstructionQuestion`, `DeveloperDecision` and `ReconstructionPlan` contracts. See [interaction-model.md](interaction-model.md) and [security.md](security.md).

## Determinism

Same snapshot + same decisions ⇒ byte-identical output: sorted keys and resources, content-hash IDs, no timestamps or randomness in generated code. The committed `examples/serverless-orders/expected` tree is verified byte for byte by a test.
