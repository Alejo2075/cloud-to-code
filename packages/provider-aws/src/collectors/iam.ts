import {
  GetRoleCommand,
  GetRolePolicyCommand,
  ListAttachedRolePoliciesCommand,
  ListRolePoliciesCommand,
  ListRoleTagsCommand,
  type GetRoleCommandOutput,
  type GetRolePolicyCommandOutput,
  type ListAttachedRolePoliciesCommandOutput,
  type ListRolePoliciesCommandOutput,
  type ListRoleTagsCommandOutput,
} from '@aws-sdk/client-iam';
import { GLOBAL_REGION, parseArn } from '@cloud-to-code/core';
import type { CollectContext } from '../sink.js';
import { paginate } from '../util.js';

function decodePolicy(doc: string | undefined): unknown {
  if (!doc) return undefined;
  try {
    return JSON.parse(decodeURIComponent(doc));
  } catch {
    return undefined;
  }
}

/** Role name from a role ARN (`arn:aws:iam::123:role/path/Name` -> `Name`). */
export function roleNameFromArn(arn: string): string | undefined {
  const p = parseArn(arn);
  const m = p && p.service === 'iam' ? /^role\/(?:.+\/)?([^/]+)$/.exec(p.resource) : undefined;
  return m?.[1];
}

/**
 * Only roles that discovered functions actually use are read (no account-wide ListRoles crawl). Trust and
 * policy documents are IAM metadata, not secrets, but they are still sanitized and treated as sensitive.
 */
export async function collectIamRoles(
  ctx: CollectContext,
  roleArns: readonly string[],
): Promise<void> {
  const { sink } = ctx;
  const unique = [...new Set(roleArns)].sort();
  await ctx.map(unique, async (arn) => {
    const name = roleNameFromArn(arn);
    if (!name) return;
    const role = await ctx.soft<GetRoleCommandOutput>(`iam:GetRole(${name})`, () =>
      ctx.send(new GetRoleCommand({ RoleName: name })),
    );
    if (!role?.Role) return;
    const [inlineNames, attached, tags] = await Promise.all([
      ctx.soft(`iam:ListRolePolicies(${name})`, () =>
        paginate(async (marker) => {
          const out = await ctx.send<ListRolePoliciesCommandOutput>(
            new ListRolePoliciesCommand({ RoleName: name, Marker: marker }),
          );
          return { items: out.PolicyNames ?? [], next: out.IsTruncated ? out.Marker : undefined };
        }),
      ),
      ctx.soft(`iam:ListAttachedRolePolicies(${name})`, () =>
        paginate(async (marker) => {
          const out = await ctx.send<ListAttachedRolePoliciesCommandOutput>(
            new ListAttachedRolePoliciesCommand({ RoleName: name, Marker: marker }),
          );
          return {
            items: out.AttachedPolicies ?? [],
            next: out.IsTruncated ? out.Marker : undefined,
          };
        }),
      ),
      ctx.soft<ListRoleTagsCommandOutput>(`iam:ListRoleTags(${name})`, () =>
        ctx.send(new ListRoleTagsCommand({ RoleName: name })),
      ),
    ]);
    const inline = await ctx.map(inlineNames ?? [], async (policyName) => {
      const out = await ctx.soft<GetRolePolicyCommandOutput>(
        `iam:GetRolePolicy(${name}/${policyName})`,
        () => ctx.send(new GetRolePolicyCommand({ RoleName: name, PolicyName: policyName })),
      );
      return { name: policyName, document: decodePolicy(out?.PolicyDocument) };
    });

    sink.addResource({
      type: 'AWS::IAM::Role',
      region: GLOBAL_REGION,
      physicalId: name,
      arn: role.Role.Arn ?? arn,
      operation: 'iam:GetRole',
      tags: Object.fromEntries(
        (tags?.Tags ?? []).filter((t) => t.Key).map((t) => [t.Key!, t.Value ?? '']),
      ),
      properties: {
        roleName: name,
        path: role.Role.Path,
        description: role.Role.Description || undefined,
        maxSessionDuration: role.Role.MaxSessionDuration,
        assumeRolePolicy: decodePolicy(role.Role.AssumeRolePolicyDocument),
        managedPolicyArns: (attached ?? []).map((p) => p.PolicyArn).filter(Boolean),
        inlinePolicies: inline.filter((p) => p.document !== undefined),
        permissionsBoundary: role.Role.PermissionsBoundary?.PermissionsBoundaryArn,
      },
    });
  });
}
