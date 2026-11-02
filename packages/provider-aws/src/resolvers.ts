import { SHAREABLE_HUB_TYPES, type CloudResource } from '@cloud-to-code/core';
import type { Sink } from './sink.js';

interface PolicyStatement {
  Effect?: string;
  Resource?: string | string[];
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

/** Does an IAM Resource pattern cover this ARN (exactly, by wildcard, or as a sub-resource path)? */
export function arnCovers(pattern: string, arn: string): boolean {
  if (pattern === '*') return false; // too broad to say anything about a specific resource
  if (pattern === arn || globToRegExp(pattern).test(arn)) return true;
  return pattern.startsWith(`${arn}/`) || pattern.startsWith(`${arn}:`);
}

/**
 * IAM allow statements become `possible-access` HYPOTHESES from the role to the resources they cover. A permission
 * proves only potential authorization, never that a function reads or writes the resource.
 */
export function resolvePossibleAccess(sink: Sink): void {
  const targets = [...sink.resources.values()].filter((r) => r.arn && r.type !== 'AWS::IAM::Role');
  for (const role of [...sink.resources.values()].filter((r) => r.type === 'AWS::IAM::Role')) {
    const policies =
      (role.observedProperties['inlinePolicies'] as
        | { name: string; document?: { Statement?: PolicyStatement | PolicyStatement[] } }[]
        | undefined) ?? [];
    const seen = new Set<string>();
    let wildcard = false;
    for (const policy of policies) {
      const raw = policy.document?.Statement;
      const statements = Array.isArray(raw) ? raw : raw ? [raw] : [];
      for (const st of statements) {
        if (st.Effect !== 'Allow') continue;
        const patterns = Array.isArray(st.Resource)
          ? st.Resource
          : st.Resource
            ? [st.Resource]
            : [];
        for (const pattern of patterns) {
          if (pattern === '*') wildcard = true;
          for (const target of targets) {
            const key = `${target.id}|${policy.name}`;
            if (seen.has(key) || !target.arn || !arnCovers(pattern, target.arn)) continue;
            seen.add(key);
            sink.relate(
              role.id,
              target.id,
              'possible-access',
              'hypothesis',
              `iam:GetRolePolicy(${policy.name})`,
              `${role.displayName} allows ${target.displayName}`,
            );
          }
        }
      }
    }
    if (wildcard) {
      sink.diag({
        code: 'wildcard-resource-policy',
        severity: 'info',
        message: `Role ${role.displayName} has a policy statement on Resource "*"; it was not turned into per-resource hypotheses.`,
        resourceId: role.id,
      });
    }
  }
}

/** Resources tagged with the same CloudFormation stack form a `same-stack` chain (hub types excluded). */
export function resolveSameStack(sink: Sink): void {
  const byStack = new Map<string, CloudResource[]>();
  for (const r of sink.resources.values()) {
    const stack = r.tags['aws:cloudformation:stack-name'];
    if (!stack || SHAREABLE_HUB_TYPES.has(r.type)) continue;
    byStack.set(stack, [...(byStack.get(stack) ?? []), r]);
  }
  for (const [stack, members] of [...byStack].sort(([a], [b]) => a.localeCompare(b))) {
    const sorted = members.sort((a, b) => a.id.localeCompare(b.id));
    for (let i = 1; i < sorted.length; i++) {
      sink.relate(
        sorted[i - 1]!.id,
        sorted[i]!.id,
        'same-stack',
        'derived',
        `tag:aws:cloudformation:stack-name=${stack}`,
        `${sorted[i - 1]!.displayName} ~ ${sorted[i]!.displayName}`,
      );
    }
  }
}
