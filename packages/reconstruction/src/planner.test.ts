import { describe, expect, it } from 'vitest';
import { EvidenceGraph, type DeveloperDecision } from '@cloud-to-code/core';
import { buildServerlessOrdersSnapshot } from '@cloud-to-code/testing';
import { buildPlan, PlanningError } from './planner.js';
import { verifyPlan } from './verify.js';

const snapshot = buildServerlessOrdersSnapshot();
let seq = 0;
const decision = (questionId: string, optionId: string): DeveloperDecision => ({
  id: `dec-${++seq}`,
  questionId,
  sessionId: 's1',
  answer: { kind: 'choice', optionId },
  source: 'interactive-user',
  recordedAt: '2026-02-01T10:00:00Z',
  subjectHash: 'h',
  redactions: 0,
});
const BUS = '123456789012/us-east-1/AWS::Events::EventBus/shared-events';

describe('buildPlan', () => {
  const decisions = [
    decision('q-shared-shared-events', 'reference'),
    decision('q-lambda-source-orders-api', 'infra-only'),
  ];
  const plan = buildPlan({
    snapshot,
    decisions,
    strategy: 'balanced',
    applicationId: 'orders-api',
  });

  it('produces a schema-valid plan that passes verification', () => {
    expect(plan.applicationId).toBe('orders-api');
    expect(verifyPlan(plan, { snapshot, decisions, blockingUnresolved: [] })).toEqual([]);
  });

  it('references the shared bus and owns the application resources', () => {
    expect(plan.boundaries.referenced).toEqual([BUS]);
    expect(plan.boundaries.owned.some((id) => id.includes('orders-table'))).toBe(true);
    expect(plan.boundaries.owned.some((id) => id.includes('billing-handler'))).toBe(false);
    expect(plan.constructs.map((c) => c.id)).toEqual([
      'orders-api-references',
      'orders-api-data',
      'orders-api-messaging',
      'orders-api-compute',
      'orders-api-api',
    ]);
    expect(plan.constructs.find((c) => c.id === 'orders-api-references')!.ownership).toBe(
      'reference',
    );
  });

  it('lists unrecoverable facts instead of inventing them', () => {
    const codes = plan.unresolved.filter((u) => u.property === 'code');
    expect(codes).toHaveLength(3); // handler, stream-processor, worker
    expect(
      plan.unresolved.some((u) => u.property === 'environment' && /TABLE_NAME/.test(u.reason)),
    ).toBe(true);
    expect(plan.assumptions.find((a) => a.id === 'assume-code-parameters')!.accepted).toBe(true);
    expect(plan.assumptions.find((a) => a.id === 'assume-stateful-retain')!.accepted).toBe(false);
  });

  it('is deterministic', () => {
    expect(
      buildPlan({ snapshot, decisions, strategy: 'balanced', applicationId: 'orders-api' }),
    ).toEqual(plan);
  });

  it('turns stateful resources into references when the developer chooses to reference them', () => {
    const p = buildPlan({
      snapshot,
      decisions: [...decisions, decision('q-stateful-orders-api', 'reference-existing')],
      strategy: 'balanced',
      applicationId: 'orders-api',
    });
    expect(p.boundaries.referenced.some((id) => id.includes('orders-table'))).toBe(true);
    expect(p.boundaries.referenced.some((id) => id.includes('orders-queue'))).toBe(true);
    expect(p.assumptions.some((a) => a.id === 'assume-stateful-retain')).toBe(false);
  });

  it('honors exclude and ownership by another application', () => {
    const excluded = buildPlan({
      snapshot,
      decisions: [decision('q-shared-shared-events', 'exclude')],
      strategy: 'balanced',
      applicationId: 'orders-api',
    });
    expect(excluded.boundaries.excluded).toEqual([BUS]);
    const other = buildPlan({
      snapshot,
      decisions: [decision('q-shared-shared-events', `own-${buildApp('billing-handler')}`)],
      strategy: 'balanced',
      applicationId: 'orders-api',
    });
    expect(other.boundaries.referenced).toEqual([BUS]);
  });

  it('refuses to guess: unanswered ownership, missing selection, unknown app and unimplemented strategies', () => {
    expect(() =>
      buildPlan({ snapshot, decisions: [], strategy: 'balanced', applicationId: 'orders-api' }),
    ).toThrow(PlanningError);
    expect(() => buildPlan({ snapshot, decisions, strategy: 'balanced' })).toThrow(
      /Several application candidates/,
    );
    expect(() =>
      buildPlan({ snapshot, decisions, strategy: 'balanced', applicationId: 'nope' }),
    ).toThrow(/not found/);
    expect(() =>
      buildPlan({ snapshot, decisions, strategy: 'faithful', applicationId: 'orders-api' }),
    ).toThrow(/not implemented/);
    expect(() =>
      buildPlan({ snapshot, decisions, strategy: 'modernized', applicationId: 'orders-api' }),
    ).toThrow(/not implemented/);
  });

  it('excludes unsupported resource types explicitly', () => {
    const sm = {
      ...snapshot.resources[0]!,
      id: '123456789012/us-east-1/AWS::StepFunctions::StateMachine/flow',
      type: 'AWS::StepFunctions::StateMachine',
      physicalId: 'flow',
      displayName: 'flow',
      arn: undefined,
    };
    const withSm = {
      ...snapshot,
      resources: [...snapshot.resources, sm],
      relationships: [
        ...snapshot.relationships,
        {
          from: sm.id,
          to: snapshot.resources.find((r) => r.physicalId === 'orders-handler')!.id,
          kind: 'triggers' as const,
          confidence: 'confirmed' as const,
          evidenceIds: ['ev-1'],
        },
      ],
    };
    const p = buildPlan({
      snapshot: withSm,
      decisions,
      strategy: 'balanced',
      applicationId: 'orders-api',
    });
    expect(p.boundaries.excluded).toContain(sm.id);
    expect(p.unresolved.find((u) => u.resourceId === sm.id)!.reason).toMatch(/not supported/);
  });
});

function buildApp(name: string): string {
  const { candidates } = new EvidenceGraph(snapshot).applicationCandidates();
  return candidates.find((c) => c.name === name)!.id;
}
