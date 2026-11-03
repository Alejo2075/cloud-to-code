# Reconstruction decisions: orders-api

Every decision below was made by a person (or relayed from one by an agent host). Nothing was decided by a model.

| Question | Answer | Source | Recorded at | Decision ID |
| --- | --- | --- | --- | --- |
| Who should own 'shared-events'? | reference | answers-file | 2026-01-20T09:00:00.000Z | dec-efb0fdc5d2 |
| Where is the source code for orders-api's Lambda functions? | infra-only | answers-file | 2026-01-20T09:00:00.000Z | dec-29f04c546e |
| How should orders-api's stateful resources be handled? | recreate-retain | answers-file | 2026-01-20T09:00:00.000Z | dec-a6f5a68994 |
| Does 'orders-handler' actually use 'orders-table'? | document-as-possible | answers-file | 2026-01-20T09:00:00.000Z | dec-edfc05776f |

## Assumptions

| Assumption | Kind | Accepted by developer |
| --- | --- | --- |
| Lambda code comes from CloudFormation parameters; no source repository is assumed. | default | yes |
| Physical names of recreated resources are not set, so CDK generates them and cannot collide with the existing resources. | default | NO - review |

## Unresolved properties

| Resource | Property | Why | Needed for |
| --- | --- | --- | --- |
| orders-handler | code | Deployed code packages are never downloaded and cannot reconstruct your repository. Code is taken from deploy-time CloudFormation parameters. | generation |
| orders-handler | environment | Environment variable values are never collected. Names observed: TABLE_NAME. Provide values at deploy time. | generation |
| orders-stream-processor | code | Deployed code packages are never downloaded and cannot reconstruct your repository. Code is taken from deploy-time CloudFormation parameters. | generation |
| orders-worker | code | Deployed code packages are never downloaded and cannot reconstruct your repository. Code is taken from deploy-time CloudFormation parameters. | generation |
| orders-worker | environment | Environment variable values are never collected. Names observed: QUEUE_URL. Provide values at deploy time. | generation |
