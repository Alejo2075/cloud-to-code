import type { GenContext } from '../context.js';
import { Tracker } from '../tracker.js';
import { quote } from '../ts.js';
import type { PropertyCoverage } from '../types.js';

export interface UnresolvedItem {
  resourceId: string;
  property: string;
  reason: string;
}

export interface RuleResult {
  ruleId: string;
  level: 'L1' | 'L2';
  properties: PropertyCoverage[];
  unresolved: UnresolvedItem[];
}

export class RuleRun {
  readonly t: Tracker;
  readonly unresolved: UnresolvedItem[] = [];
  readonly r;

  constructor(
    readonly ctx: GenContext,
    readonly id: string,
    readonly ruleId: string,
  ) {
    this.r = ctx.entry(id).resource;
    this.t = new Tracker(this.r);
  }

  header(): void {
    const e = this.ctx.entry(this.id);
    this.ctx.out.line(`// ${e.resource.displayName} (${e.resource.type})  rule ${this.ruleId}`);
    if (e.resource.evidenceIds.length > 0)
      this.ctx.out.line(`// evidence: ${e.resource.evidenceIds.join(', ')}`);
  }

  unresolve(property: string, reason: string): void {
    this.t.unresolved(property, reason);
    this.unresolved.push({ resourceId: this.id, property, reason });
  }

  /** Emit `cdk.Tags.of(target).add(...)` for user tags; AWS-reserved `aws:` tags cannot be set. */
  tags(target: string): void {
    const user = Object.entries(this.r.tags)
      .filter(([k]) => !k.startsWith('aws:'))
      .sort(([a], [b]) => a.localeCompare(b));
    if (user.length === 0) return;
    this.ctx.out.use('cdk');
    for (const [k, v] of user)
      this.ctx.out.line(`cdk.Tags.of(${target}).add(${quote(k)}, ${quote(v)});`);
    this.t.mark('tags', 'preserved', 'aws:* tags are reserved and not set');
  }

  /** Register the created object in the construct's lookup map for other constructs. */
  register(mapName: string, variable: string): void {
    this.ctx.out.line(`this.${mapName}[${quote(this.r.physicalId)}] = ${variable};`);
  }

  result(level: 'L1' | 'L2'): RuleResult {
    return { ruleId: this.ruleId, level, properties: this.t.finish(), unresolved: this.unresolved };
  }
}

export function assertString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
