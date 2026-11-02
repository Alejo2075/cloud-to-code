import {
  EvidenceGraph,
  type CloudResource,
  type CloudSnapshot,
  type ConstructPlan,
  type ReconstructionPlan,
} from '@cloud-to-code/core';
import { GROUP_BY_TYPE, toPascalCase } from '@cloud-to-code/reconstruction';
import type { Out } from './out.js';
import { renderSegments, renderValue, safeVarName, quote, type Segment } from './ts.js';
import { GenerationError, type PropertyCoverage } from './types.js';

export type GroupName = 'references' | 'data' | 'messaging' | 'compute' | 'api' | 'events';

interface TypeInfo {
  /** Name of the Record on the generated construct, e.g. `tables`. */
  map: string;
  /** CDK interface type stored in the map. */
  tsType: string;
  /** Property carrying the ARN on that CDK type. */
  arnProp?: string;
}

export const TYPE_INFO: Record<string, TypeInfo> = {
  'AWS::DynamoDB::Table': { map: 'tables', tsType: 'dynamodb.ITable', arnProp: 'tableArn' },
  'AWS::S3::Bucket': { map: 'buckets', tsType: 's3.IBucket', arnProp: 'bucketArn' },
  'AWS::SQS::Queue': { map: 'queues', tsType: 'sqs.IQueue', arnProp: 'queueArn' },
  'AWS::Events::EventBus': { map: 'buses', tsType: 'events.IEventBus', arnProp: 'eventBusArn' },
  'AWS::IAM::Role': { map: 'roles', tsType: 'iam.IRole', arnProp: 'roleArn' },
  'AWS::Lambda::Function': { map: 'functions', tsType: 'lambda.IFunction', arnProp: 'functionArn' },
  'AWS::ApiGatewayV2::Api': { map: 'apis', tsType: 'apigwv2.IHttpApi' },
  'AWS::Events::Rule': { map: 'rules', tsType: 'events.IRule', arnProp: 'ruleArn' },
};

export const GROUP_NAMESPACES: Record<GroupName, string[]> = {
  references: [],
  data: [],
  messaging: [],
  compute: [],
  api: [],
  events: [],
};

const RESERVED_LOGICAL = new Set(['Resource', 'Default', 'Construct', 'Stack']);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Shared state while generating one project: ownership lookup, deterministic unique names, and the
 * expressions used to reference resources from other constructs (never by guessing physical names).
 */
export class GenContext {
  readonly graph: EvidenceGraph;
  readonly byId = new Map<
    string,
    { resource: CloudResource; construct: ConstructPlan; owned: boolean; group: GroupName }
  >();
  private readonly logicalIds = new Map<string, string>();
  private readonly usedLogical = new Set<string>();
  currentGroup: GroupName = 'references';
  out!: Out;
  /** Property coverage decided by a different resource's rule (e.g. bucket notifications wired in compute). */
  readonly overrides = new Map<string, PropertyCoverage[]>();

  constructor(
    readonly snapshot: CloudSnapshot,
    readonly plan: ReconstructionPlan,
  ) {
    this.graph = new EvidenceGraph(snapshot);
    for (const construct of plan.constructs) {
      for (const id of construct.resourceIds) {
        const resource = this.graph.resources.get(id);
        if (!resource)
          throw new GenerationError(
            'unknown-resource',
            `Plan references ${id}, which is not in the snapshot.`,
          );
        const owned = construct.ownership === 'recreate';
        if (!owned && construct.ownership !== 'reference') {
          throw new GenerationError(
            'unsupported-ownership',
            `Ownership mode "${construct.ownership}" is advisory only and cannot be generated.`,
          );
        }
        const group = owned
          ? (GROUP_BY_TYPE[resource.type] as GroupName | undefined)
          : 'references';
        if (!group || !TYPE_INFO[resource.type]) {
          throw new GenerationError(
            'unsupported-type',
            `Resource type ${resource.type} (${id}) is not supported by the generator.`,
          );
        }
        this.byId.set(id, { resource, construct, owned, group });
      }
    }
    // Deterministic unique logical IDs in resource-ID order.
    for (const id of [...this.byId.keys()].sort()) {
      const { resource } = this.byId.get(id)!;
      let base = toPascalCase(
        resource.type === 'AWS::Events::Rule' ? resource.displayName : resource.physicalId,
      );
      if (RESERVED_LOGICAL.has(base)) base = `${base}Resource`;
      let candidate = base;
      for (let n = 2; this.usedLogical.has(candidate); n++) candidate = `${base}${n}`;
      this.usedLogical.add(candidate);
      this.logicalIds.set(id, candidate);
    }
  }

  entry(id: string) {
    const e = this.byId.get(id);
    if (!e) throw new GenerationError('not-in-plan', `Resource ${id} is not part of the plan.`);
    return e;
  }

  inPlan(id: string): boolean {
    return this.byId.has(id);
  }

  logicalId(id: string): string {
    return this.logicalIds.get(id) ?? toPascalCase(id.split('/').pop() ?? 'Resource');
  }

  varName(id: string): string {
    return safeVarName(this.logicalId(id));
  }

  /** Resolve an ARN (or physical-ID-bearing ARN) to a resource in the plan. */
  resolveArn(arn: string | undefined): string | undefined {
    if (!arn) return undefined;
    const direct = this.graph.resolveArn(arn);
    if (direct && this.byId.has(direct)) return direct;
    return undefined;
  }

  /** TypeScript expression evaluating to the CDK object for a resource in the plan. */
  ref(id: string): string {
    const e = this.entry(id);
    const info = TYPE_INFO[e.resource.type]!;
    if (e.owned && e.group === this.currentGroup) return this.varName(id);
    return `props.${e.group}.${info.map}[${quote(e.resource.physicalId)}]`;
  }

  /** Is `id` created in the construct currently being generated? */
  isLocal(id: string): boolean {
    const e = this.byId.get(id);
    return !!e && e.owned && e.group === this.currentGroup;
  }

  /** Segments for a string with owned-resource ARNs rewired and account/region tokenized. */
  segments(input: string): Segment[] {
    let segs: Segment[] = [{ text: input }];

    const owned = [...this.byId.values()]
      .filter((e) => e.owned && e.resource.arn && TYPE_INFO[e.resource.type]?.arnProp)
      .sort((a, b) => b.resource.arn!.length - a.resource.arn!.length);
    for (const e of owned) {
      const re = new RegExp(`${escapeRegExp(e.resource.arn!)}(?![A-Za-z0-9_.-])`, 'g');
      const expr = `${this.ref(e.resource.id)}.${TYPE_INFO[e.resource.type]!.arnProp}`;
      segs = segs.flatMap((s): Segment[] => {
        if (!('text' in s) || !re.test(s.text)) return [s];
        re.lastIndex = 0;
        const parts = s.text.split(re);
        const out: Segment[] = [];
        parts.forEach((p, i) => {
          if (p) out.push({ text: p });
          if (i < parts.length - 1) out.push({ expr });
        });
        return out;
      });
    }

    const accounts = new Set(this.snapshot.scope.accountIds);
    const regions = new Set(this.snapshot.scope.regions);
    const arnPrefix = /(arn:[a-z-]+:[a-z0-9-]+:)([a-z0-9-]*):(\d{12})?:/g;
    segs = segs.flatMap((s): Segment[] => {
      if (!('text' in s)) return [s];
      const out: Segment[] = [];
      let last = 0;
      for (const m of s.text.matchAll(arnPrefix)) {
        const [whole, prefix, region, account] = m as unknown as [
          string,
          string,
          string,
          string | undefined,
        ];
        out.push({ text: s.text.slice(last, m.index) + prefix });
        out.push(regions.has(region) ? { expr: this.stackToken('region') } : { text: region });
        out.push({ text: ':' });
        if (account && accounts.has(account)) out.push({ expr: this.stackToken('account') });
        else if (account) out.push({ text: account });
        out.push({ text: ':' });
        last = (m.index ?? 0) + whole.length;
      }
      out.push({ text: s.text.slice(last) });
      return out;
    });
    return segs;
  }

  private stackToken(kind: 'region' | 'account'): string {
    this.out.use('cdk');
    return `cdk.Stack.of(this).${kind}`;
  }

  /** TypeScript expression for a string value (quoted literal or template literal with tokens). */
  str(input: string): string {
    return renderSegments(this.segments(input));
  }

  /** TypeScript literal for JSON-like data, with every string passed through {@link str}. */
  value(data: unknown, indent = 0): string {
    return renderValue(data, (s) => this.str(s), indent);
  }
}
