# serverless-orders example

A synthetic, fully sanitized AWS application used by the demo and the tests. It contains **no real AWS data**.

- HTTP API `orders-api` → Lambda `orders-handler` → DynamoDB `orders-table` (stream → `orders-stream-processor`)
- SQS `orders-queue` (+ DLQ) → `orders-worker`; S3 `orders-exports` notifies `orders-worker`
- EventBridge bus `shared-events` used by the Orders **and** Billing stacks (the ownership question)
- `orders-handler`'s IAM role allows DynamoDB access that nothing corroborates (the `possible-access` question)

Files:

- `snapshot.json`: the sanitized snapshot (`c2c inspect --snapshot examples/serverless-orders/snapshot.json`)
- `answers.json`: answers a person would give; used for the non-interactive run
- `expected/orders-api/`: the CDK project generated from them. A test fails if it drifts from what the tools produce; regenerate with `pnpm build && pnpm examples:generate`

```bash
c2c reconstruct orders-api --snapshot examples/serverless-orders/snapshot.json \
  --answers examples/serverless-orders/answers.json --output /tmp/orders-api
```
