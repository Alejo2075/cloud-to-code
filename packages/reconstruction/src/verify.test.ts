import { describe, expect, it } from 'vitest';
import type { DeveloperDecision, ReconstructionPlan } from '@cloud-to-code/core';
import { buildServerlessOrdersSnapshot } from '@cloud-to-code/testing';
import { buildPlan } from './planner.js';
import { hasErrors, verifyPlan, type VerifyContext } from './verify.js';

const snapshot = buildServerlessOrdersSnapshot();
const d = (questionId: string, optionId: string, id: string): DeveloperDecision => ({
  id,
  questionId,
  sessionId: 's1',
  answer: { kind: 'choice', optionId },
  source: 'interactive-user',
  recordedAt: '2026-02-01T10:00:00Z',
  subjectHash: 'h',
  redactions: 0,
});
const decisions = [d('q-shared-shared-events', 'reference', 'dec-a')];
const good = buildPlan({ snapshot, decisions, strategy: 'balanced', applicationId: 'orders-api' });
const ctx: VerifyContext = { snapshot, decisions, blockingUnresolved: [] };
const codes = (plan: unknown, c = ctx) => verifyPlan(plan, c).map((i) => i.code);
const clone = (): ReconstructionPlan => structuredClone(good);

describe('verifyPlan rejects untrusted proposals', () => {
  it('accepts a valid plan', () => {
    expect(hasErrors(verifyPlan(good, ctx))).toBe(false);
  });

  it('rejects hallucinated resource IDs', () => {
    const p = clone();
    p.selectedResourceIds.push('123456789012/us-east-1/AWS::Lambda::Function/ghost');
    p.boundaries.owned.push('123456789012/us-east-1/AWS::Lambda::Function/ghost');
    expect(codes(p)).toContain('unknown-resource');
  });

  it('rejects missing evidence IDs and fabricated decisions', () => {
    const p = clone();
    p.evidenceIds.push('ev-9999');
    p.decisionIds.push('dec-fake');
    p.constructs[0]!.decisionIds.push('dec-fake');
    const c = codes(p);
    expect(c).toContain('unknown-evidence');
    expect(c).toContain('unknown-decision');
  });

  it('rejects decisions from another session', () => {
    const foreign = { ...decisions[0]!, sessionId: 'other' };
    const p = clone();
    p.decisionIds = [foreign.id];
    expect(codes(p, { ...ctx, decisions: [foreign], sessionId: 's1' })).toContain(
      'foreign-decision',
    );
  });

  it('rejects ambiguous ownership and uncovered resources', () => {
    const p = clone();
    p.boundaries.referenced.push(p.boundaries.owned[0]!);
    expect(codes(p)).toContain('ambiguous-ownership');
    const q = clone();
    q.constructs = q.constructs.filter((c) => c.id !== 'orders-api-data');
    q.stacks[0]!.constructIds = q.stacks[0]!.constructIds.filter((c) => c !== 'orders-api-data');
    expect(codes(q)).toContain('uncovered-resource');
  });

  it('rejects unsupported mappings and unknown rules', () => {
    const p = clone();
    const lambda = snapshot.resources.find((r) => r.physicalId === 'orders-handler')!;
    const snap2 = {
      ...snapshot,
      resources: snapshot.resources.map((r) =>
        r.id === lambda.id ? { ...r, type: 'AWS::Batch::JobQueue' } : r,
      ),
    };
    expect(codes(p, { ...ctx, snapshot: snap2 })).toContain('unsupported-mapping');
    expect(codes(p, { ...ctx, knownRuleIds: new Set(['x']) })).toContain('unknown-rule');
  });

  it('rejects plans containing secret-like values', () => {
    const p = clone();
    p.assumptions.push({
      id: 'a',
      statement: 'use password=hunter2',
      kind: 'default',
      accepted: false,
      evidenceIds: [],
    });
    expect(codes(p)).toContain('secret-in-plan');
  });

  it('rejects plans with unresolved blocking questions and snapshot mismatches', () => {
    expect(codes(good, { ...ctx, blockingUnresolved: ['q-shared-shared-events'] })).toContain(
      'blocking-question-unresolved',
    );
    expect(codes({ ...good, snapshotId: 'snap-other' })).toContain('snapshot-mismatch');
  });

  it('rejects structurally invalid proposals', () => {
    expect(codes({ nonsense: true })).toEqual(['schema-invalid']);
    expect(codes(null)).toEqual(['schema-invalid']);
  });

  it('warns that adopt is advisory and that AI hypotheses are not accepted without confirmation', () => {
    const p = clone();
    p.constructs[0]!.ownership = 'adopt';
    p.assumptions.push({
      id: 'h',
      statement: 'looks like a queue worker',
      kind: 'ai-hypothesis',
      accepted: true,
      evidenceIds: [],
    });
    const issues = verifyPlan(p, ctx);
    expect(issues.map((i) => i.code)).toEqual(
      expect.arrayContaining(['adopt-advisory', 'unverified-acceptance']),
    );
  });
});
