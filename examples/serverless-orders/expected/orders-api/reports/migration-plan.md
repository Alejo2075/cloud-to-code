# Migration plan (advisory): orders-api

> This document is **advice only**. Cloud to Code never deploys, bootstraps, imports or deletes anything, and made no change to AWS.
> `cdk synth` only proves the generated code produces a CloudFormation template. It does **not** prove the template is equivalent to the running infrastructure, that ownership is correct, or that anything can be safely imported or deployed.

## Ownership summary

- **Recreate** (12): defined in this CDK app. Deploying creates NEW resources next to the existing ones.
- **Reference** (1): looked up by ARN and left untouched.
- **Adopt**: planning only (see below). The app does not import anything.

## Before any deployment

1. **Stateful resources are recreated empty.** `orders-exports`, `orders-table`, `orders-dlq`, `orders-queue` will be new resources with generated names and a RETAIN policy. Existing data is **not** migrated; plan a data migration separately.
2. **Physical names are not set.** CDK generates names so the new stack cannot collide with existing resources; anything that hard-codes the old names must be updated.
3. **Lambda code is not recovered.** 3 function(s) take their code from CloudFormation parameters (`OrdersHandlerCodeBucket`, `OrdersStreamProcessorCodeBucket`, `OrdersWorkerCodeBucket` ...). Upload your own build artifacts first.
4. **Environment variable values are not collected.** Provide them through the generated `OrdersHandlerEnvName`, `OrdersWorkerEnvName` parameters (secrets are marked noEcho; prefer a secret store).
5. **Referenced resources must exist in the target account/region:** `shared-events`.
6. **IAM policies are preserved verbatim**, with ARNs of recreated resources rewired to the new resources. Review them for least privilege; nothing was removed or added.
7. **IAM permissions are not proof of use.** Possible dependencies are documented in `architecture.md` and were not wired as runtime links.
8. **The HTTP API gets a new endpoint URL.** Custom domains, stages beyond those listed, authorizers and throttling were not reproduced unless noted in `coverage.json`.
9. **Costs and duplicate processing:** running two copies of event-driven resources (queues, stream consumers, rules) can process the same events twice.

## Adoption analysis (planning only)

Adopting means making CloudFormation take over the **existing** resources instead of creating new ones (for example with CloudFormation resource import). Cloud to Code does not do this. Prerequisites to evaluate yourself:

- Confirm in the AWS documentation that each resource type below supports import; support is not asserted here.
- Logical IDs and construct paths must match what you import. Run `cdk synth` and read the template to learn the generated logical IDs.
- Imported stateful resources need a deletion/retention policy before any stack changes; take backups first.
- Expect downtime or replacement risk for any property that differs from the live resource (see `coverage.json`).

| Resource | Type | Stateful | Construct | Logical ID (construct id) |
| --- | --- | --- | --- | --- |
| orders-handler-role | AWS::IAM::Role | no | OrdersApiCompute | OrdersHandlerRole |
| orders-stream-role | AWS::IAM::Role | no | OrdersApiCompute | OrdersStreamRole |
| orders-worker-role | AWS::IAM::Role | no | OrdersApiCompute | OrdersWorkerRole |
| orders-exports | AWS::S3::Bucket | yes | OrdersApiData | OrdersExports |
| a1b2c3d4e5 | AWS::ApiGatewayV2::Api | no | OrdersApiApi | A1b2c3d4e5 |
| orders-table | AWS::DynamoDB::Table | yes | OrdersApiData | OrdersTable |
| shared-events/orders-created | AWS::Events::Rule | no | OrdersApiEvents | OrdersCreated |
| orders-handler | AWS::Lambda::Function | no | OrdersApiCompute | OrdersHandler |
| orders-stream-processor | AWS::Lambda::Function | no | OrdersApiCompute | OrdersStreamProcessor |
| orders-worker | AWS::Lambda::Function | no | OrdersApiCompute | OrdersWorker |
| orders-dlq | AWS::SQS::Queue | yes | OrdersApiMessaging | OrdersDlq |
| orders-queue | AWS::SQS::Queue | yes | OrdersApiMessaging | OrdersQueue |

## Constructs

| Construct | File | Ownership | Resources |
| --- | --- | --- | --- |
| OrdersApiReferences | lib/constructs/references.ts | reference | 1 |
| OrdersApiData | lib/constructs/data.ts | recreate | 2 |
| OrdersApiMessaging | lib/constructs/messaging.ts | recreate | 2 |
| OrdersApiCompute | lib/constructs/compute.ts | recreate | 6 |
| OrdersApiApi | lib/constructs/api.ts | recreate | 1 |
| OrdersApiEvents | lib/constructs/events.ts | recreate | 1 |
