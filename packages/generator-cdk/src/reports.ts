import {
  sha256Hex,
  stableStringify,
  type CloudSnapshot,
  type DeveloperDecision,
  type ReconstructionPlan,
} from '@cloud-to-code/core';
import { renderMermaid } from '@cloud-to-code/diagram-mermaid';
import { computeQuestions, STATEFUL_TYPES } from '@cloud-to-code/reconstruction';
import type { ConstructOutput } from './constructs.js';
import type { GenContext } from './context.js';
import { envParameterName, parameterNames } from './rules/lambda.js';
import type { GeneratedFile, GeneratedProject, ResourceCoverage } from './types.js';

const SYNTH_NOTICE =
  '`cdk synth` only proves the generated code produces a CloudFormation template. It does **not** prove the template is equivalent to the running infrastructure, that ownership is correct, or that anything can be safely imported or deployed.';

function table(headers: string[], rows: string[][]): string {
  const line = (cells: string[]) =>
    `| ${cells.map((c) => c.replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`;
  return [line(headers), line(headers.map(() => '---')), ...rows.map(line)].join('\n');
}

function shortId(id: string): string {
  return id.split('/').slice(3).join('/');
}

export function planDigest(plan: ReconstructionPlan): string {
  return sha256Hex(stableStringify(plan)).slice(0, 16);
}

function subSnapshot(snapshot: CloudSnapshot, plan: ReconstructionPlan): CloudSnapshot {
  const ids = new Set(plan.selectedResourceIds);
  return {
    ...snapshot,
    resources: snapshot.resources.filter((r) => ids.has(r.id)),
    relationships: snapshot.relationships.filter((r) => ids.has(r.from) && ids.has(r.to)),
  };
}

function answerLabel(d: DeveloperDecision): string {
  const a = d.answer;
  switch (a.kind) {
    case 'choice':
      return a.note ? `${a.optionId} (${a.note})` : a.optionId;
    case 'choices':
      return a.optionIds.join(', ');
    case 'text':
      return a.text;
    case 'confirmation':
      return a.confirmed ? 'yes' : 'no';
    case 'unknown':
      return "I don't know";
  }
}

export function architectureReport(
  ctx: GenContext,
  coverage: readonly ResourceCoverage[],
): GeneratedFile {
  const { plan, snapshot } = ctx;
  const lines = [
    `# Architecture: ${plan.applicationName}`,
    '',
    `Reconstructed from snapshot \`${snapshot.id}\` (collected ${snapshot.collectedAt}) using the **${plan.generation.strategy}** strategy. Plan produced by \`${plan.producedBy}\`.`,
    '',
    '> Every relationship below is labeled by confidence. Dotted edges are derived or **hypotheses** (for example an IAM permission is not proof of use).',
    '',
    '## Diagram',
    '',
    '```mermaid',
    renderMermaid(subSnapshot(snapshot, plan)).trimEnd(),
    '```',
    '',
    '## Resources',
    '',
    table(
      ['Resource', 'Type', 'Ownership', 'Construct', 'Rule'],
      coverage.map((c) => [shortId(c.resourceId), c.type, c.ownership, c.construct, c.ruleId]),
    ),
    '',
    '## Excluded from this reconstruction',
    '',
    plan.boundaries.excluded.length === 0
      ? 'Nothing was excluded.'
      : plan.boundaries.excluded
          .map(
            (id) =>
              `- \`${shortId(id)}\` (${snapshot.resources.find((r) => r.id === id)?.type ?? 'unknown'})`,
          )
          .join('\n'),
    '',
    '## What this report does not tell you',
    '',
    '- It reflects only what the read-only discovery observed; missing permissions or skipped services are not evidence of absence.',
    '- Application source code, environment values, data and secrets were never collected.',
    `- ${SYNTH_NOTICE}`,
    '',
  ];
  return { path: 'reports/architecture.md', content: lines.join('\n') };
}

export function decisionsReport(
  ctx: GenContext,
  decisions: readonly DeveloperDecision[],
): GeneratedFile {
  const { plan, snapshot } = ctx;
  const questions = computeQuestions(snapshot, 'report');
  const used = decisions.filter((d) => plan.decisionIds.includes(d.id));
  const rows = used.map((d) => {
    const q = questions.find((x) => x.id === d.questionId);
    return [q?.title ?? d.questionId, answerLabel(d), d.source, d.recordedAt, d.id];
  });
  const lines = [
    `# Reconstruction decisions: ${plan.applicationName}`,
    '',
    'Every decision below was made by a person (or relayed from one by an agent host). Nothing was decided by a model.',
    '',
    rows.length === 0
      ? 'No decisions were required.'
      : table(['Question', 'Answer', 'Source', 'Recorded at', 'Decision ID'], rows),
    '',
    '## Assumptions',
    '',
    plan.assumptions.length === 0
      ? 'None.'
      : table(
          ['Assumption', 'Kind', 'Accepted by developer'],
          plan.assumptions.map((a) => [a.statement, a.kind, a.accepted ? 'yes' : 'NO - review']),
        ),
    '',
    '## Unresolved properties',
    '',
    plan.unresolved.length === 0
      ? 'None recorded by the planner (see `coverage.json` for generator-level gaps).'
      : table(
          ['Resource', 'Property', 'Why', 'Needed for'],
          plan.unresolved.map((u) => [shortId(u.resourceId), u.property, u.reason, u.requiredFor]),
        ),
    '',
  ];
  return { path: 'reports/reconstruction-decisions.md', content: lines.join('\n') };
}

export function coverageReport(
  ctx: GenContext,
  coverage: readonly ResourceCoverage[],
  unresolved: GeneratedProject['unresolved'],
): GeneratedFile {
  const summary: Record<string, number> = {
    preserved: 0,
    approximated: 0,
    'intentionally-omitted': 0,
    unresolved: 0,
    'not-mapped': 0,
  };
  for (const c of coverage)
    for (const p of c.properties) summary[p.status] = (summary[p.status] ?? 0) + 1;
  const doc = {
    schemaVersion: '1',
    snapshotId: ctx.snapshot.id,
    planDigest: planDigest(ctx.plan),
    strategy: ctx.plan.generation.strategy,
    notice: SYNTH_NOTICE.replace(/[`*]/g, ''),
    summary,
    resources: coverage,
    unresolved,
  };
  return { path: 'reports/coverage.json', content: `${JSON.stringify(doc, null, 2)}\n` };
}

export function migrationPlan(
  ctx: GenContext,
  coverage: readonly ResourceCoverage[],
  outputs: readonly ConstructOutput[],
): GeneratedFile {
  const { plan, snapshot } = ctx;
  const owned = coverage.filter((c) => c.ownership === 'recreate');
  const referenced = coverage.filter((c) => c.ownership === 'reference');
  const stateful = owned.filter((c) => STATEFUL_TYPES.has(c.type));
  const fns = owned.filter((c) => c.type === 'AWS::Lambda::Function');
  const lines: string[] = [
    `# Migration plan (advisory): ${plan.applicationName}`,
    '',
    '> This document is **advice only**. Cloud to Code never deploys, bootstraps, imports or deletes anything, and made no change to AWS.',
    `> ${SYNTH_NOTICE}`,
    '',
    '## Ownership summary',
    '',
    `- **Recreate** (${owned.length}): defined in this CDK app. Deploying creates NEW resources next to the existing ones.`,
    `- **Reference** (${referenced.length}): looked up by ARN and left untouched.`,
    `- **Adopt**: planning only (see below). The app does not import anything.`,
    '',
    '## Before any deployment',
    '',
  ];
  const warnings: string[] = [];
  if (stateful.length > 0) {
    warnings.push(
      `**Stateful resources are recreated empty.** ${stateful.map((s) => `\`${shortId(s.resourceId)}\``).join(', ')} will be new resources with generated names and a RETAIN policy. Existing data is **not** migrated; plan a data migration separately.`,
    );
  }
  warnings.push(
    '**Physical names are not set.** CDK generates names so the new stack cannot collide with existing resources; anything that hard-codes the old names must be updated.',
  );
  if (fns.length > 0) {
    warnings.push(
      `**Lambda code is not recovered.** ${fns.length} function(s) take their code from CloudFormation parameters (${fns.map((f) => `\`${parameterNames(ctx, f.resourceId).bucket}\``).join(', ')} ...). Upload your own build artifacts first.`,
    );
    const withEnv = fns.filter(
      (f) =>
        ((
          snapshot.resources.find((r) => r.id === f.resourceId)?.observedProperties[
            'environmentVariableNames'
          ] as string[] | undefined
        )?.length ?? 0) > 0,
    );
    if (withEnv.length > 0) {
      warnings.push(
        `**Environment variable values are not collected.** Provide them through the generated \`${withEnv
          .map((f) => envParameterName(ctx, f.resourceId, 'NAME'))
          .join('`, `')
          .replace(
            /NAME/g,
            '<VAR>',
          )}\` parameters (secrets are marked noEcho; prefer a secret store).`,
      );
    }
  }
  if (referenced.length > 0) {
    warnings.push(
      `**Referenced resources must exist in the target account/region:** ${referenced.map((r) => `\`${shortId(r.resourceId)}\``).join(', ')}.`,
    );
  }
  warnings.push(
    '**IAM policies are preserved verbatim**, with ARNs of recreated resources rewired to the new resources. Review them for least privilege; nothing was removed or added.',
  );
  if (snapshot.relationships.some((r) => r.kind === 'possible-access')) {
    warnings.push(
      '**IAM permissions are not proof of use.** Possible dependencies are documented in `architecture.md` and were not wired as runtime links.',
    );
  }
  if (owned.some((c) => c.type === 'AWS::ApiGatewayV2::Api')) {
    warnings.push(
      '**The HTTP API gets a new endpoint URL.** Custom domains, stages beyond those listed, authorizers and throttling were not reproduced unless noted in `coverage.json`.',
    );
  }
  if (coverage.some((c) => c.properties.some((p) => p.status === 'unresolved'))) {
    warnings.push(
      '**Some properties are unresolved** and need manual work: see `coverage.json` and `reconstruction-decisions.md`.',
    );
  }
  warnings.push(
    '**Costs and duplicate processing:** running two copies of event-driven resources (queues, stream consumers, rules) can process the same events twice.',
  );
  warnings.forEach((w, i) => lines.push(`${i + 1}. ${w}`));

  lines.push(
    '',
    '## Adoption analysis (planning only)',
    '',
    'Adopting means making CloudFormation take over the **existing** resources instead of creating new ones (for example with CloudFormation resource import). Cloud to Code does not do this. Prerequisites to evaluate yourself:',
    '',
    '- Confirm in the AWS documentation that each resource type below supports import; support is not asserted here.',
    '- Logical IDs and construct paths must match what you import. Run `cdk synth` and read the template to learn the generated logical IDs.',
    '- Imported stateful resources need a deletion/retention policy before any stack changes; take backups first.',
    '- Expect downtime or replacement risk for any property that differs from the live resource (see `coverage.json`).',
    '',
    table(
      ['Resource', 'Type', 'Stateful', 'Construct', 'Logical ID (construct id)'],
      owned.map((c) => [
        shortId(c.resourceId),
        c.type,
        STATEFUL_TYPES.has(c.type) ? 'yes' : 'no',
        `${c.construct}`,
        c.logicalId,
      ]),
    ),
    '',
    '## Constructs',
    '',
    table(
      ['Construct', 'File', 'Ownership', 'Resources'],
      outputs.map((o) => [
        o.className,
        o.file.path,
        o.construct.ownership,
        String(o.construct.resourceIds.length),
      ]),
    ),
    '',
  );
  return { path: 'reports/migration-plan.md', content: lines.join('\n') };
}

export function projectReadme(ctx: GenContext, outputs: readonly ConstructOutput[]): GeneratedFile {
  const { plan } = ctx;
  const params = outputs.some((o) => o.hasParameters);
  const lines = [
    `# ${plan.applicationName} (reconstructed CDK app)`,
    '',
    '> **Status: generated, not verified for deployment.** Produced by [Cloud to Code](https://github.com/Alejo2075/cloud-to-code) from read-only AWS discovery. Review every file. No AWS resource was modified to create this project.',
    '',
    '## Use',
    '',
    '```bash',
    'npm install',
    'npm run build   # typecheck',
    'npm test        # CDK assertions on the properties that were reproduced',
    'npx cdk synth   # produce the CloudFormation template (needs no AWS credentials)',
    '```',
    '',
    SYNTH_NOTICE,
    '',
    '## What is where',
    '',
    '- `lib/stacks/`: the stack; `lib/constructs/`: one construct per group of resources',
    '- `reports/`: architecture, decisions, coverage (`coverage.json`) and an advisory migration plan',
    '- `.c2c/manifest.json`: which AWS evidence, rule and decision produced each resource',
    '- `src/README.md`: application source code is **not** recovered; see there',
    '',
  ];
  if (params) {
    lines.push(
      '## Required deploy-time parameters',
      '',
      'Code locations and environment values are never collected from AWS, so the stack declares CloudFormation parameters for them (see the stack file). `cdk synth` succeeds without them; a deployment needs real values.',
      '',
    );
  }
  lines.push(
    '## Unresolved items',
    '',
    plan.unresolved.length === 0
      ? 'None recorded.'
      : `${plan.unresolved.length} item(s): see \`reports/reconstruction-decisions.md\` and \`reports/coverage.json\`.`,
    '',
  );
  return { path: 'README.md', content: lines.join('\n') };
}

export function sourceReadme(
  ctx: GenContext,
  decisions: readonly DeveloperDecision[],
): GeneratedFile {
  const linked = decisions.filter(
    (d) =>
      d.questionId.startsWith('q-lambda-source-') &&
      d.answer.kind === 'choice' &&
      d.answer.optionId !== 'infra-only',
  );
  const lines = [
    '# Application source code',
    '',
    'Cloud to Code reads deployed **configuration only**. It never downloads Lambda deployment packages, and deployed code cannot reconstruct your original repository, so no application source is included or invented.',
    '',
    'Each Lambda function in the stack reads its code location from CloudFormation parameters. Build and upload your own artifacts, then pass the bucket and key at deploy time.',
    '',
  ];
  if (linked.length > 0) {
    lines.push(
      '## Sources you told us about',
      '',
      'These were recorded as decisions. Automatic source wiring is not implemented yet; they are listed here for your reference only.',
      '',
    );
    for (const d of linked) {
      if (d.answer.kind === 'choice')
        lines.push(
          `- ${d.questionId.replace('q-lambda-source-', '')}: ${d.answer.optionId}${d.answer.note ? ` - ${d.answer.note}` : ''}`,
        );
    }
    lines.push('');
  }
  void ctx;
  return { path: 'src/README.md', content: lines.join('\n') };
}
