import { describe, expect, it } from 'vitest';
import {
  CloudSnapshotSchema,
  DeveloperDecisionSchema,
  ReconstructionPlanSchema,
  SessionSchema,
} from './index.js';
import { createSession } from '../session-machine.js';
import { res, snap } from '../test-helpers.js';

describe('schemas', () => {
  it('round-trips a snapshot through JSON', () => {
    const s = snap([res('AWS::Lambda::Function', 'a')], []);
    expect(CloudSnapshotSchema.parse(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it('rejects invalid resource types, account IDs and versions', () => {
    const s = snap([res('AWS::Lambda::Function', 'a')], []);
    expect(CloudSnapshotSchema.safeParse({ ...s, schemaVersion: '2' }).success).toBe(false);
    expect(
      CloudSnapshotSchema.safeParse({ ...s, resources: [{ ...s.resources[0], type: 'lambda' }] })
        .success,
    ).toBe(false);
    expect(
      CloudSnapshotSchema.safeParse({ ...s, resources: [{ ...s.resources[0], accountId: '12' }] })
        .success,
    ).toBe(false);
  });

  it('validates sessions and decisions', () => {
    const session = createSession({
      id: 's',
      snapshotId: 'x',
      strategy: 'balanced',
      now: new Date(),
    });
    expect(SessionSchema.safeParse(session).success).toBe(true);
    const decision = {
      id: 'd1',
      questionId: 'q',
      sessionId: 's',
      answer: { kind: 'choice', optionId: 'a' },
      source: 'interactive-user',
      recordedAt: new Date().toISOString(),
      subjectHash: 'h',
    };
    expect(DeveloperDecisionSchema.parse(decision).redactions).toBe(0);
    expect(DeveloperDecisionSchema.safeParse({ ...decision, source: 'model' }).success).toBe(false);
  });

  it('requires at least one stack and construct in a plan', () => {
    const base = {
      schemaVersion: '1',
      snapshotId: 's',
      applicationId: 'a',
      applicationName: 'n',
      producedBy: 'deterministic-planner',
      selectedResourceIds: ['r'],
      boundaries: { owned: [], referenced: [], excluded: [] },
      stacks: [],
      constructs: [],
      generation: { strategy: 'balanced' },
      evidenceIds: [],
      decisionIds: [],
      assumptions: [],
      unresolved: [],
    };
    expect(ReconstructionPlanSchema.safeParse(base).success).toBe(false);
  });
});
