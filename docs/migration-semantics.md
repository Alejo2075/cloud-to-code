# Migration semantics

Three independent axes. Do not conflate them.

## Strategy (how the code is shaped)

| Strategy     | Meaning                                                                                                      | Status                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| `balanced`   | L2 constructs where behavior is preserved; L1 where an L2 cannot express it (for example complex IAM trust). | implemented                            |
| `faithful`   | Maximize observed equivalence, L1 where needed.                                                              | planned; rejected with a clear message |
| `modernized` | A _separate proposal_ of improvements; never presented as an equivalent migration.                           | planned; rejected                      |

## Ownership (what CloudFormation will own)

| Mode        | Meaning                                                   | Status                                                                                        |
| ----------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `recreate`  | A **new** deployment next to the existing one.            | generated                                                                                     |
| `reference` | Look up an existing resource by ARN, without managing it. | generated                                                                                     |
| `adopt`     | Make CloudFormation take over the existing resource.      | **advice only**; `c2c adoption plan` lists prerequisites and risks and never imports anything |

## What `recreate` means in practice

- **Physical names are not set**, so the new stack cannot collide with existing resources. Anything hard-coding old names must change.
- **Stateful resources start empty** (tables, queues, buckets) with `RETAIN`. Existing data is not migrated.
- **Lambda code and environment values** are never collected: they come from CloudFormation parameters you provide.
- **IAM statements are preserved** verbatim; ARNs of recreated resources are rewired to the new ones. CDK is prevented from adding statements (an immutable role view), so permissions are exactly the observed ones.
- **A new API endpoint URL**; custom domains and authorizers are not reproduced unless noted in `coverage.json`.
- Running two copies of event-driven resources can process events twice.

## What `synth` proves

`cdk synth` shows the code produces a CloudFormation template. It does **not** show that the template matches the running infrastructure, that ownership is right, or that anything can be safely imported or deployed. Every report and validation result says so. The generated tests assert only the properties that were observed and reproduced; `reports/coverage.json` lists every property as `preserved`, `approximated`, `intentionally-omitted`, `not-mapped` or `unresolved`.
