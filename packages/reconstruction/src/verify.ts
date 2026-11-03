import {
  EvidenceGraph,
  ReconstructionPlanSchema,
  redactSecrets,
  type CloudSnapshot,
  type DeveloperDecision,
} from '@cloud-to-code/core';
import { slug } from './naming.js';
import { STATEFUL_TYPES, SUPPORTED_GENERATION_TYPES } from './supported-types.js';

export interface PlanIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
}

export interface VerifyContext {
  snapshot: CloudSnapshot;
  decisions: readonly DeveloperDecision[];
  /** IDs of blocking questions that are not resolved. */
  blockingUnresolved: readonly string[];
  /** Rule IDs the generator implements; unknown rules are rejected when provided. */
  knownRuleIds?: ReadonlySet<string>;
  /** Session the decisions must belong to. */
  sessionId?: string;
}

/**
 * Deterministic verification of ANY plan (from the deterministic planner, an AI provider, or an agent host).
 * Proposals are untrusted: nonexistent resources, invented evidence or decisions, unsupported mappings,
 * implicit secrets, ambiguous ownership and unresolved blocking choices are rejected here.
 */
export function verifyPlan(plan: unknown, ctx: VerifyContext): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const err = (code: string, message: string) => issues.push({ severity: 'error', code, message });
  const warn = (code: string, message: string) =>
    issues.push({ severity: 'warning', code, message });

  const parsed = ReconstructionPlanSchema.safeParse(plan);
  if (!parsed.success) {
    err('schema-invalid', `Plan does not match the schema: ${parsed.error.message}`);
    return issues;
  }
  const p = parsed.data;

  if (p.snapshotId !== ctx.snapshot.id) {
    err('snapshot-mismatch', `Plan is for snapshot ${p.snapshotId}, not ${ctx.snapshot.id}.`);
  }

  const resourceIds = new Set(ctx.snapshot.resources.map((r) => r.id));
  const evidenceIds = new Set(ctx.snapshot.evidence.map((e) => e.id));
  const decisionIds = new Set(ctx.decisions.map((d) => d.id));

  const known = (id: string, where: string): void => {
    if (!resourceIds.has(id))
      err('unknown-resource', `${where} references nonexistent resource ${id}.`);
  };
  p.selectedResourceIds.forEach((id) => known(id, 'selectedResourceIds'));
  const { owned, referenced, excluded } = p.boundaries;
  const buckets = new Map<string, string>();
  for (const [bucket, ids] of [
    ['owned', owned],
    ['referenced', referenced],
    ['excluded', excluded],
  ] as const) {
    for (const id of ids) {
      known(id, `boundaries.${bucket}`);
      const previous = buckets.get(id);
      if (previous)
        err('ambiguous-ownership', `Resource ${id} is in both "${previous}" and "${bucket}".`);
      buckets.set(id, bucket);
    }
  }
  for (const id of p.selectedResourceIds) {
    if (!buckets.has(id))
      err(
        'ambiguous-ownership',
        `Selected resource ${id} has no ownership (owned/referenced/excluded).`,
      );
  }
  for (const id of buckets.keys()) {
    if (!p.selectedResourceIds.includes(id))
      err('boundary-not-selected', `Boundary resource ${id} is not in selectedResourceIds.`);
  }

  const stackIds = new Set(p.stacks.map((s) => s.id));
  const constructIds = new Set<string>();
  const covered = new Map<string, string>();
  for (const c of p.constructs) {
    if (constructIds.has(c.id)) err('duplicate-construct', `Duplicate construct ${c.id}.`);
    constructIds.add(c.id);
    if (!stackIds.has(c.stackId))
      err('unknown-stack', `Construct ${c.id} references unknown stack ${c.stackId}.`);
    if (ctx.knownRuleIds && !ctx.knownRuleIds.has(c.ruleId))
      err('unknown-rule', `Construct ${c.id} uses unknown mapping rule ${c.ruleId}.`);
    if (c.ownership === 'adopt')
      warn(
        'adopt-advisory',
        `Construct ${c.id}: "adopt" is advisory only; no import is ever performed.`,
      );
    for (const id of c.resourceIds) {
      known(id, `construct ${c.id}`);
      const r = ctx.snapshot.resources.find((x) => x.id === id);
      if (r && !SUPPORTED_GENERATION_TYPES.has(r.type)) {
        err('unsupported-mapping', `Construct ${c.id} maps unsupported type ${r.type} (${id}).`);
      }
      const bucket = buckets.get(id);
      const expected = c.ownership === 'reference' ? 'referenced' : 'owned';
      if (bucket !== expected) {
        err(
          'ownership-mismatch',
          `Resource ${id} is "${bucket ?? 'unassigned'}" but construct ${c.id} treats it as ${c.ownership}.`,
        );
      }
      if (covered.has(id))
        err(
          'duplicate-coverage',
          `Resource ${id} is mapped by both ${covered.get(id)} and ${c.id}.`,
        );
      covered.set(id, c.id);
    }
    c.evidenceIds.forEach(
      (e) =>
        evidenceIds.has(e) ||
        err('unknown-evidence', `Construct ${c.id} cites nonexistent evidence ${e}.`),
    );
    c.decisionIds.forEach(
      (d) =>
        decisionIds.has(d) ||
        err('unknown-decision', `Construct ${c.id} cites nonexistent decision ${d}.`),
    );
  }
  for (const id of [...owned, ...referenced]) {
    const r = ctx.snapshot.resources.find((x) => x.id === id);
    if (r && SUPPORTED_GENERATION_TYPES.has(r.type) && !covered.has(id)) {
      err('uncovered-resource', `${id} is owned or referenced but no construct generates it.`);
    }
  }
  for (const s of p.stacks) {
    s.constructIds.forEach(
      (c) =>
        constructIds.has(c) ||
        err('unknown-construct', `Stack ${s.id} lists unknown construct ${c}.`),
    );
    s.evidenceIds.forEach(
      (e) =>
        evidenceIds.has(e) ||
        err('unknown-evidence', `Stack ${s.id} cites nonexistent evidence ${e}.`),
    );
  }
  p.evidenceIds.forEach(
    (e) => evidenceIds.has(e) || err('unknown-evidence', `Plan cites nonexistent evidence ${e}.`),
  );
  p.decisionIds.forEach(
    (d) =>
      decisionIds.has(d) ||
      err('unknown-decision', `Plan cites nonexistent (possibly fabricated) decision ${d}.`),
  );
  if (ctx.sessionId) {
    for (const d of ctx.decisions) {
      if (p.decisionIds.includes(d.id) && d.sessionId !== ctx.sessionId) {
        err('foreign-decision', `Decision ${d.id} belongs to session ${d.sessionId}.`);
      }
    }
  }
  p.unresolved.forEach((u) => known(u.resourceId, 'unresolved'));
  for (const a of p.assumptions) {
    if (a.kind === 'ai-hypothesis' && a.accepted) {
      const backed = a.evidenceIds.some(
        (e) => ctx.snapshot.evidence.find((x) => x.id === e)?.kind === 'user-confirmed',
      );
      if (!backed)
        warn(
          'unverified-acceptance',
          `Assumption ${a.id} is marked accepted without user-confirmed evidence.`,
        );
    }
  }

  // The plan must agree with what the developer decided.
  const graph = new EvidenceGraph(ctx.snapshot);
  const app = graph
    .applicationCandidates()
    .candidates.find((c) => slug(c.name) === p.applicationId);
  const choice = (qid: string): string | undefined => {
    const a = ctx.decisions.find((d) => d.questionId === qid)?.answer;
    return a?.kind === 'choice' ? a.optionId : undefined;
  };
  if (app) {
    for (const hubId of app.sharedResourceIds) {
      const hub = graph.resources.get(hubId);
      const c = hub ? choice(`q-shared-${slug(hub.displayName)}`) : undefined;
      if (!c) continue;
      const expected =
        c === 'reference'
          ? 'referenced'
          : c === 'exclude'
            ? 'excluded'
            : c === `own-${app.id}`
              ? 'owned'
              : 'referenced';
      if (buckets.get(hubId) !== expected) {
        err(
          'decision-conflict',
          `Shared resource ${hubId} is "${buckets.get(hubId) ?? 'unassigned'}" but the developer decided "${c}" (expected ${expected}).`,
        );
      }
    }
    const stateful = choice(`q-stateful-${slug(app.name)}`);
    if (stateful) {
      for (const id of app.resourceIds) {
        const type = graph.resources.get(id)?.type;
        if (!type || !STATEFUL_TYPES.has(type) || !buckets.has(id)) continue;
        const expected = stateful === 'reference-existing' ? 'referenced' : 'owned';
        if (buckets.get(id) !== expected) {
          err(
            'decision-conflict',
            `Stateful resource ${id} is "${buckets.get(id)}" but the developer decided "${stateful}".`,
          );
        }
      }
    }
  }

  for (const id of ctx.blockingUnresolved)
    err('blocking-question-unresolved', `Blocking question ${id} is unresolved.`);

  const secrets = redactSecrets(JSON.stringify(p));
  if (secrets.redactions > 0)
    err('secret-in-plan', `Plan contains ${secrets.redactions} secret-like value(s).`);

  return issues;
}

export function hasErrors(issues: readonly PlanIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}
