import type { GenContext } from '../context.js';
import { isIdentifier, quote } from '../ts.js';
import { RuleRun, type RuleResult } from './common.js';

interface InlinePolicy {
  name: string;
  document: unknown;
}
interface TrustStatement {
  Effect?: string;
  Action?: string | string[];
  Principal?: { Service?: string | string[] } & Record<string, unknown>;
  Condition?: unknown;
}

/** Service principals when the trust policy is a plain "service may assume this role"; otherwise undefined. */
function simpleServicePrincipals(doc: unknown): string[] | undefined {
  const statements = (doc as { Statement?: TrustStatement | TrustStatement[] } | undefined)
    ?.Statement;
  if (!statements) return undefined;
  const list = Array.isArray(statements) ? statements : [statements];
  const principals: string[] = [];
  for (const s of list) {
    const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
    const keys = Object.keys(s.Principal ?? {});
    if (
      s.Effect !== 'Allow' ||
      actions.length !== 1 ||
      actions[0] !== 'sts:AssumeRole' ||
      s.Condition ||
      keys.length !== 1 ||
      keys[0] !== 'Service'
    ) {
      return undefined;
    }
    const svc = s.Principal!.Service;
    principals.push(...(Array.isArray(svc) ? svc : [svc as string]));
  }
  return principals.length > 0 ? [...new Set(principals)].sort() : undefined;
}

export function managedPolicyExpr(
  ctx: GenContext,
  arn: string,
  scopeId: string,
  index: number,
): string {
  ctx.out.use('iam');
  const aws = /^arn:aws[a-z-]*:iam::aws:policy\/(.+)$/.exec(arn);
  if (aws) return `iam.ManagedPolicy.fromAwsManagedPolicyName(${quote(aws[1]!)})`;
  return `iam.ManagedPolicy.fromManagedPolicyArn(this, ${ctx.str(`${scopeId}Policy${index + 1}`)}, ${ctx.str(arn)})`;
}

export function emitRole(ctx: GenContext, id: string): RuleResult {
  const run = new RuleRun(ctx, id, 'compute/iam-role@1');
  const { t } = run;
  const out = ctx.out;
  const v = ctx.varName(id);
  const logical = ctx.logicalId(id);
  out.use('iam');
  out.use('cdk');

  const trust = t.take('assumeRolePolicy');
  const principals = simpleServicePrincipals(trust);
  const managed = t.take<string[]>('managedPolicyArns') ?? [];
  const inline = t.take<InlinePolicy[]>('inlinePolicies') ?? [];
  const path = t.take<string>('path');
  const description = t.take<string>('description');
  const maxSession = t.take<number>('maxSessionDuration');
  t.omitted(
    'roleName',
    'Physical name not set so the new role cannot collide with the existing one.',
  );
  if (t.has('permissionsBoundary'))
    run.unresolve(
      'permissionsBoundary',
      'Permissions boundaries are not mapped yet; attach it manually.',
    );

  run.header();
  if (principals) {
    const assumedBy =
      principals.length === 1
        ? `new iam.ServicePrincipal(${ctx.str(principals[0]!)})`
        : `new iam.CompositePrincipal(${principals.map((p) => `new iam.ServicePrincipal(${ctx.str(p)})`).join(', ')})`;
    out.line(`const ${v} = new iam.Role(this, ${ctx.str(logical)}, {`);
    out.line(`  assumedBy: ${assumedBy},`);
    if (managed.length > 0) {
      out.line('  managedPolicies: [');
      managed.forEach((arn, i) => out.line(`    ${managedPolicyExpr(ctx, arn, logical, i)},`));
      out.line('  ],');
    }
    if (inline.length > 0) {
      out.line('  inlinePolicies: {');
      for (const p of inline) {
        const key = isIdentifier(p.name) ? p.name : quote(p.name);
        out.line(`    ${key}: iam.PolicyDocument.fromJson(${ctx.value(p.document, 2)}),`);
      }
      out.line('  },');
    }
    if (path && path !== '/') out.line(`  path: ${ctx.str(path)},`);
    if (description) out.line(`  description: ${ctx.str(description)},`);
    if (maxSession && maxSession !== 3600)
      out.line(`  maxSessionDuration: cdk.Duration.seconds(${maxSession}),`);
    out.line('});');
    run.tags(v);
    run.register('roles', v);
    return run.result('L2');
  }

  // Trust policy has principals, conditions or actions the L2 Role cannot express: use the L1 resource.
  t.approximated(
    'assumeRolePolicy',
    'Complex trust policy preserved verbatim through the L1 CfnRole.',
  );
  out.line(`const ${v}Cfn = new iam.CfnRole(this, ${ctx.str(`${logical}Cfn`)}, {`);
  out.line(`  assumeRolePolicyDocument: ${ctx.value(trust, 1)},`);
  if (managed.length > 0)
    out.line(`  managedPolicyArns: [${managed.map((m) => ctx.str(m)).join(', ')}],`);
  if (inline.length > 0) {
    out.line('  policies: [');
    for (const p of inline)
      out.line(
        `    { policyName: ${ctx.str(p.name)}, policyDocument: ${ctx.value(p.document, 2)} },`,
      );
    out.line('  ],');
  }
  if (path && path !== '/') out.line(`  path: ${ctx.str(path)},`);
  if (description) out.line(`  description: ${ctx.str(description)},`);
  out.line('});');
  out.line(
    `const ${v} = iam.Role.fromRoleArn(this, ${ctx.str(logical)}, ${v}Cfn.attrArn, { mutable: false });`,
  );
  run.register('roles', v);
  return run.result('L1');
}
