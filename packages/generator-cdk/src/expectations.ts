import type { GenContext } from './context.js';
import { quote, renderValue } from './ts.js';
import type { Expectation } from './types.js';

/** Markers rendered as CDK `Match` helpers (and interpreted by {@link checkExpectations}). */
const ARRAY_WITH = '$arrayWith';
const OBJECT_LIKE = '$objectLike';

interface KeyElement {
  attributeName: string;
  keyType: string;
}

const props = (ctx: GenContext, id: string): Record<string, unknown> =>
  ctx.entry(id).resource.observedProperties;

/** Expectations for the CloudFormation template the generated app must synthesize to. Owned resources only. */
export function buildExpectations(ctx: GenContext): Expectation[] {
  const out: Expectation[] = [];
  const owned = [...ctx.byId.entries()]
    .filter(([, e]) => e.owned)
    .sort(([a], [b]) => a.localeCompare(b));
  const counts = new Map<string, number>();
  const COUNTED: Record<string, string> = {
    'AWS::DynamoDB::Table': 'AWS::DynamoDB::Table',
    'AWS::SQS::Queue': 'AWS::SQS::Queue',
    'AWS::S3::Bucket': 'AWS::S3::Bucket',
    'AWS::Events::EventBus': 'AWS::Events::EventBus',
    'AWS::Events::Rule': 'AWS::Events::Rule',
    'AWS::ApiGatewayV2::Api': 'AWS::ApiGatewayV2::Api',
  };
  for (const [, e] of owned) {
    const cfn = COUNTED[e.resource.type];
    if (cfn) counts.set(cfn, (counts.get(cfn) ?? 0) + 1);
  }
  for (const [type, count] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
    out.push({
      type,
      properties: { __count: count },
      description: `creates exactly ${count} ${type} (referenced resources are never created)`,
    });
  }

  for (const [id, e] of owned) {
    const p = props(ctx, id);
    const name = e.resource.displayName;
    switch (e.resource.type) {
      case 'AWS::DynamoDB::Table': {
        const keys = (p['keySchema'] as KeyElement[] | undefined) ?? [];
        const properties: Record<string, unknown> = {
          KeySchema: keys.map((k) => ({ AttributeName: k.attributeName, KeyType: k.keyType })),
          BillingMode: p['billingMode'] ?? 'PAY_PER_REQUEST',
        };
        const gsis = (p['globalSecondaryIndexes'] as { indexName: string }[] | undefined) ?? [];
        if (gsis.length > 0) {
          properties['GlobalSecondaryIndexes'] = {
            [ARRAY_WITH]: gsis.map((g) => ({ [OBJECT_LIKE]: { IndexName: g.indexName } })),
          };
        }
        const stream = p['streamSpecification'] as
          { streamEnabled?: boolean; streamViewType?: string } | undefined;
        if (stream?.streamEnabled && stream.streamViewType)
          properties['StreamSpecification'] = { StreamViewType: stream.streamViewType };
        out.push({
          type: e.resource.type,
          properties,
          retain: true,
          description: `table ${name} keeps its keys, billing mode, indexes and stream, and is retained on delete`,
        });
        break;
      }
      case 'AWS::SQS::Queue': {
        const properties: Record<string, unknown> = {};
        if (typeof p['visibilityTimeout'] === 'number')
          properties['VisibilityTimeout'] = p['visibilityTimeout'];
        if (typeof p['messageRetentionPeriod'] === 'number')
          properties['MessageRetentionPeriod'] = p['messageRetentionPeriod'];
        const redrive = p['redrivePolicy'] as { maxReceiveCount?: number } | undefined;
        if (redrive?.maxReceiveCount)
          properties['RedrivePolicy'] = { maxReceiveCount: redrive.maxReceiveCount };
        out.push({
          type: e.resource.type,
          properties,
          retain: true,
          description: `queue ${name} keeps its timeouts and redrive policy, and is retained on delete`,
        });
        break;
      }
      case 'AWS::S3::Bucket': {
        const properties: Record<string, unknown> = {};
        if (p['versioning'] === 'Enabled')
          properties['VersioningConfiguration'] = { Status: 'Enabled' };
        out.push({
          type: e.resource.type,
          properties,
          retain: true,
          description: `bucket ${name} keeps its versioning and is retained on delete`,
        });
        break;
      }
      case 'AWS::Lambda::Function': {
        const properties: Record<string, unknown> = { Handler: p['handler'] };
        if (typeof p['runtime'] === 'string') properties['Runtime'] = p['runtime'];
        if (typeof p['memorySize'] === 'number') properties['MemorySize'] = p['memorySize'];
        if (typeof p['timeout'] === 'number') properties['Timeout'] = p['timeout'];
        if (Array.isArray(p['architectures']) && p['architectures'][0] === 'arm64')
          properties['Architectures'] = ['arm64'];
        out.push({
          type: e.resource.type,
          properties,
          description: `function ${name} keeps its runtime, handler, memory and timeout`,
        });
        break;
      }
      case 'AWS::ApiGatewayV2::Api': {
        out.push({
          type: e.resource.type,
          properties: {
            ProtocolType: 'HTTP',
            ...(typeof p['name'] === 'string' ? { Name: p['name'] } : {}),
          },
          description: `HTTP API ${name} keeps its protocol and name`,
        });
        const integrations = new Map(
          (
            (p['integrations'] as
              | { integrationId: string; integrationUri?: string; integrationType?: string }[]
              | undefined) ?? []
          ).map((i) => [i.integrationId, i]),
        );
        for (const route of (p['routes'] as
          { routeKey: string; target?: string; authorizationType?: string }[] | undefined) ?? []) {
          const integration = integrations.get(route.target?.replace(/^integrations\//, '') ?? '');
          const fnId = ctx.resolveArn(integration?.integrationUri);
          const generated =
            (!route.authorizationType || route.authorizationType === 'NONE') &&
            integration?.integrationType === 'AWS_PROXY' &&
            !!fnId;
          if (generated)
            out.push({
              type: 'AWS::ApiGatewayV2::Route',
              properties: { RouteKey: route.routeKey },
              description: `route ${route.routeKey} exists on ${name}`,
            });
        }
        break;
      }
      case 'AWS::Events::Rule': {
        const properties: Record<string, unknown> = {};
        const pattern = p['eventPattern'] as Record<string, unknown> | undefined;
        if (pattern) properties['EventPattern'] = pattern;
        properties['State'] = p['state'] === 'DISABLED' ? 'DISABLED' : 'ENABLED';
        out.push({
          type: e.resource.type,
          properties,
          description: `rule ${name} keeps its event pattern and state`,
        });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** Render expectations as a vitest file using CDK assertions. */
export function renderTestFile(
  stackName: string,
  stackFileBase: string,
  expectations: readonly Expectation[],
): string {
  const mapString = (s: string) => quote(s);
  const render = (value: unknown, indent: number): string => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const rec = value as Record<string, unknown>;
      if (ARRAY_WITH in rec)
        return `Match.arrayWith(${renderArray(rec[ARRAY_WITH] as unknown[], indent)})`;
      if (OBJECT_LIKE in rec) return `Match.objectLike(${render(rec[OBJECT_LIKE], indent)})`;
    }
    return renderValue(value, mapString, indent);
  };
  const renderArray = (items: unknown[], indent: number): string =>
    `[${items.map((i) => render(i, indent + 1)).join(', ')}]`;
  // Walk objects so nested markers are rendered too.
  const deep = (value: unknown, indent: number): string => {
    if (Array.isArray(value)) return renderArray(value, indent);
    if (value && typeof value === 'object') {
      const rec = value as Record<string, unknown>;
      if (ARRAY_WITH in rec || OBJECT_LIKE in rec) return render(value, indent);
      const entries = Object.entries(rec).map(
        ([k, v]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : quote(k)}: ${deep(v, indent + 1)}`,
      );
      return `{ ${entries.join(', ')} }`;
    }
    return renderValue(value, mapString, indent);
  };

  const lines = [
    '// Generated by Cloud to Code. These assertions check the properties that WERE observed and reproduced.',
    '// Passing tests do NOT prove equivalence with the running infrastructure or that adoption is safe.',
    "import { App } from 'aws-cdk-lib';",
    "import { Match, Template } from 'aws-cdk-lib/assertions';",
    "import { describe, it } from 'vitest';",
    `import { ${stackName} } from '../lib/stacks/${stackFileBase}';`,
    '',
    `describe(${quote(stackName)}, () => {`,
    `  const template = Template.fromStack(new ${stackName}(new App(), 'TestStack'));`,
    '',
  ];
  for (const x of expectations) {
    lines.push(`  it(${quote(x.description)}, () => {`);
    const properties = x.properties ?? {};
    if ('__count' in properties) {
      lines.push(
        `    template.resourceCountIs(${quote(x.type)}, ${String(properties['__count'])});`,
      );
    } else {
      if (Object.keys(properties).length > 0)
        lines.push(`    template.hasResourceProperties(${quote(x.type)}, ${deep(properties, 2)});`);
      if (x.retain)
        lines.push(
          `    template.hasResource(${quote(x.type)}, { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });`,
        );
      if (Object.keys(properties).length === 0 && !x.retain)
        lines.push(`    template.resourceCountIs(${quote(x.type)}, 1);`);
    }
    lines.push('  });', '');
  }
  lines.push('});', '');
  return lines.join('\n');
}

interface TemplateLike {
  hasResourceProperties(type: string, props: unknown): void;
  hasResource(type: string, props: unknown): void;
  resourceCountIs(type: string, count: number): void;
}
interface MatchLike {
  arrayWith(value: unknown[]): unknown;
  objectLike(value: unknown): unknown;
}

/** Evaluate the same expectations directly against a synthesized template (used by this repo's own tests). */
export function checkExpectations(
  template: TemplateLike,
  match: MatchLike,
  expectations: readonly Expectation[],
): void {
  const revive = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(revive);
    if (value && typeof value === 'object') {
      const rec = value as Record<string, unknown>;
      if (ARRAY_WITH in rec) return match.arrayWith((rec[ARRAY_WITH] as unknown[]).map(revive));
      if (OBJECT_LIKE in rec) return match.objectLike(revive(rec[OBJECT_LIKE]));
      return Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, revive(v)]));
    }
    return value;
  };
  for (const x of expectations) {
    const properties = x.properties ?? {};
    if ('__count' in properties) {
      template.resourceCountIs(x.type, Number(properties['__count']));
      continue;
    }
    if (Object.keys(properties).length > 0)
      template.hasResourceProperties(x.type, revive(properties));
    if (x.retain)
      template.hasResource(x.type, { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
  }
}
