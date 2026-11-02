import { toPascalCase } from '@cloud-to-code/reconstruction';
import type { ConstructPlan } from '@cloud-to-code/core';
import type { GenContext } from './context.js';
import { TYPE_INFO, type GroupName } from './context.js';
import { NAMESPACE_MODULES, Out, type Namespace } from './out.js';
import { emitHttpApi } from './rules/api.js';
import type { RuleResult } from './rules/common.js';
import { emitTable } from './rules/dynamodb.js';
import { emitEventBus } from './rules/eventbus.js';
import { emitRule } from './rules/events.js';
import { emitRole } from './rules/iam.js';
import { emitFunction } from './rules/lambda.js';
import { emitReference } from './rules/references.js';
import { emitBucket } from './rules/s3.js';
import { emitQueue, queueDependency } from './rules/sqs.js';
import { quote } from './ts.js';
import { GenerationError, type GeneratedFile } from './types.js';

export const GROUP_ORDER: readonly GroupName[] = [
  'references',
  'data',
  'messaging',
  'compute',
  'api',
  'events',
];

export interface ConstructOutput {
  group: GroupName;
  construct: ConstructPlan;
  file: GeneratedFile;
  className: string;
  results: Map<string, RuleResult>;
  /** Earlier groups whose constructs this one needs in its props. */
  uses: GroupName[];
  hasParameters: boolean;
}

const EMITTERS: Record<string, (ctx: GenContext, id: string) => RuleResult> = {
  'AWS::DynamoDB::Table': emitTable,
  'AWS::S3::Bucket': emitBucket,
  'AWS::SQS::Queue': emitQueue,
  'AWS::Events::EventBus': emitEventBus,
  'AWS::IAM::Role': emitRole,
  'AWS::Lambda::Function': emitFunction,
  'AWS::ApiGatewayV2::Api': emitHttpApi,
  'AWS::Events::Rule': emitRule,
};

/** Order resources inside a construct so every local variable is declared before it is used. */
function orderResources(ctx: GenContext, group: GroupName, ids: string[]): string[] {
  const sorted = [...ids].sort();
  if (group === 'messaging') {
    const result: string[] = [];
    const visiting = new Set<string>();
    const visit = (id: string): void => {
      if (result.includes(id) || visiting.has(id)) return;
      visiting.add(id);
      if (ctx.entry(id).resource.type === 'AWS::SQS::Queue') {
        const dep = queueDependency(ctx, id);
        if (dep && sorted.includes(dep)) visit(dep);
      }
      result.push(id);
    };
    sorted.forEach(visit);
    return result;
  }
  if (group === 'compute') {
    const rank = (id: string) => (ctx.entry(id).resource.type === 'AWS::IAM::Role' ? 0 : 1);
    return sorted.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  }
  return sorted;
}

export function generateConstruct(
  ctx: GenContext,
  construct: ConstructPlan,
  group: GroupName,
  presentGroups: readonly GroupName[],
): ConstructOutput {
  const out = new Out();
  ctx.out = out;
  ctx.currentGroup = group;
  const results = new Map<string, RuleResult>();
  const ids = orderResources(ctx, group, construct.resourceIds);

  const body = new Out();
  ctx.out = body;
  for (const id of ids) {
    const resource = ctx.entry(id).resource;
    const emit = group === 'references' ? emitReference : EMITTERS[resource.type];
    if (!emit)
      throw new GenerationError('unsupported-type', `No generator rule for ${resource.type}.`);
    results.set(id, emit(ctx, id));
    body.line();
  }

  // Maps exposed to other constructs, one per resource type present.
  const types = [...new Set(ids.map((id) => ctx.entry(id).resource.type))].sort();
  const mapLines: string[] = [];
  for (const type of types) {
    const info = TYPE_INFO[type]!;
    body.use(info.tsType.split('.')[0] as Namespace);
    mapLines.push(`  public readonly ${info.map}: Record<string, ${info.tsType}> = {};`);
  }

  const bodyText = body.toString().trimEnd();
  const uses = presentGroups.filter((g) => g !== group && bodyText.includes(`props.${g}.`));
  const hasParameters = group === 'compute' && bodyText.includes('props.parameters.');
  const className = construct.name;

  const propsLines: string[] = [];
  const needsProps = uses.length > 0 || hasParameters;
  if (needsProps) {
    propsLines.push(`export interface ${className}Props {`);
    for (const g of uses) propsLines.push(`  ${g}: ${classNameOf(ctx, g)};`);
    if (hasParameters) propsLines.push(`  parameters: ${className}Parameters;`);
    propsLines.push('}', '');
  }
  if (hasParameters) {
    propsLines.push(
      `/** Deploy-time values that are never collected from AWS: Lambda code locations and environment values. */`,
      `export interface ${className}Parameters {`,
      '  code: Record<string, { bucket: string; key: string }>;',
      '  environment: Record<string, Record<string, string>>;',
      '}',
      '',
    );
  }

  const namespaces = [...body.namespaces].sort((a, b) =>
    a === 'cdk' ? -1 : b === 'cdk' ? 1 : NAMESPACE_MODULES[a].localeCompare(NAMESPACE_MODULES[b]),
  );
  const imports = namespaces.map((ns) => `import * as ${ns} from '${NAMESPACE_MODULES[ns]}';`);
  const siblingImports = uses.map((g) => `import type { ${classNameOf(ctx, g)} } from './${g}';`);

  const lines = [
    '// Generated by Cloud to Code. Review before use; regenerate rather than hand-editing where possible.',
    `// Group: ${group} | rule ${construct.ruleId} | ownership ${construct.ownership}`,
    ...imports,
    "import { Construct } from 'constructs';",
    ...siblingImports,
    '',
    ...propsLines,
    `export class ${className} extends Construct {`,
    ...mapLines,
    '',
    `  constructor(scope: Construct, id: string${needsProps ? `, props: ${className}Props` : ''}) {`,
    '    super(scope, id);',
    '',
    ...bodyText.split('\n').map((l) => (l.length > 0 ? `    ${l}` : l)),
    '  }',
    '}',
    '',
  ];
  return {
    group,
    construct,
    className,
    results,
    uses,
    hasParameters,
    file: { path: `lib/constructs/${group}.ts`, content: lines.join('\n') },
  };
}

function classNameOf(ctx: GenContext, group: GroupName): string {
  const c = ctx.plan.constructs.find((x) => x.id === `${ctx.plan.applicationId}-${group}`);
  return c?.name ?? `${toPascalCase(ctx.plan.applicationName)}${toPascalCase(group)}`;
}

export { quote };
