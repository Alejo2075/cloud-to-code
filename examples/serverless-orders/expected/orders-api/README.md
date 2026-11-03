# orders-api (reconstructed CDK app)

> **Status: generated, not verified for deployment.** Produced by [Cloud to Code](https://github.com/Alejo2075/cloud-to-code) from read-only AWS discovery. Review every file. No AWS resource was modified to create this project.

## Use

```bash
npm install
npm run build   # typecheck
npm test        # CDK assertions on the properties that were reproduced
npx cdk synth   # produce the CloudFormation template (needs no AWS credentials)
```

`cdk synth` only proves the generated code produces a CloudFormation template. It does **not** prove the template is equivalent to the running infrastructure, that ownership is correct, or that anything can be safely imported or deployed.

## What is where

- `lib/stacks/`: the stack; `lib/constructs/`: one construct per group of resources
- `reports/`: architecture, decisions, coverage (`coverage.json`) and an advisory migration plan
- `.c2c/manifest.json`: which AWS evidence, rule and decision produced each resource
- `src/README.md`: application source code is **not** recovered; see there

## Required deploy-time parameters

Code locations and environment values are never collected from AWS, so the stack declares CloudFormation parameters for them (see the stack file). `cdk synth` succeeds without them; a deployment needs real values.

## Unresolved items

5 item(s): see `reports/reconstruction-decisions.md` and `reports/coverage.json`.
