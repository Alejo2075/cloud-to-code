import { describe, expect, it } from 'vitest';
import { ReconstructionQuestionSchema } from '@cloud-to-code/core';
import { buildHostileOrdersSnapshot, buildServerlessOrdersSnapshot } from '@cloud-to-code/testing';
import { MAX_QUESTIONS_PER_BATCH, computeQuestions, selectBatch } from './questions.js';

const snapshot = buildServerlessOrdersSnapshot();

describe('computeQuestions on serverless-orders', () => {
  const questions = computeQuestions(snapshot, 's1');

  it('raises questions from real graph uncertainty, blocking first', () => {
    expect(questions.map((q) => q.id)).toEqual([
      'q-shared-shared-events',
      'q-lambda-source-billing-handler',
      'q-lambda-source-orders-api',
      'q-stateful-orders-api',
      'q-possible-access-orders-handler-orders-table',
    ]);
    expect(questions[0]).toMatchObject({
      priority: 'blocking',
      requiredFor: 'generation',
      suggestedOptionId: 'reference',
    });
  });

  it('does not ask about permissions that runtime links corroborate', () => {
    const ids = questions.map((q) => q.id).join(' ');
    expect(ids).not.toContain('orders-stream-processor');
    expect(ids).not.toContain('orders-worker');
  });

  it('satisfies the question contract: evidence, consequences, unknown, safe suggestion', () => {
    for (const q of questions) {
      expect(ReconstructionQuestionSchema.safeParse(q).success).toBe(true);
      expect(q.evidenceIds.length).toBeGreaterThan(0);
      expect(q.allowUnknown).toBe(true);
      expect(q.options!.length).toBeGreaterThanOrEqual(2);
      expect(q.options!.every((o) => o.consequences.length > 10)).toBe(true);
      expect(q.options!.some((o) => o.id === q.suggestedOptionId)).toBe(true);
      expect(q.effectOfSkipping.length).toBeGreaterThan(10);
    }
  });

  it('offers reference, per-candidate ownership and exclude for the shared bus', () => {
    const shared = questions.find((q) => q.id === 'q-shared-shared-events')!;
    const ids = shared.options!.map((o) => o.id);
    expect(ids).toContain('reference');
    expect(ids).toContain('exclude');
    expect(ids.filter((i) => i.startsWith('own-app-'))).toHaveLength(2);
  });

  it('is deterministic and independent of resource order', () => {
    const reversed = {
      ...snapshot,
      resources: [...snapshot.resources].reverse(),
      relationships: [...snapshot.relationships].reverse(),
    };
    expect(computeQuestions(reversed, 's1')).toEqual(questions);
  });

  it('batches at most three questions, highest priority first', () => {
    const batch = selectBatch(questions);
    expect(batch).toHaveLength(MAX_QUESTIONS_PER_BATCH);
    expect(batch[0]!.priority).toBe('blocking');
  });

  it('changes subjectHash when the underlying evidence changes but keeps the question ID', () => {
    const changed = {
      ...snapshot,
      resources: snapshot.resources.map((r) =>
        r.physicalId === 'orders-table'
          ? { ...r, observedProperties: { ...r.observedProperties, billingMode: 'PROVISIONED' } }
          : r,
      ),
    };
    const before = questions.find((q) => q.id === 'q-stateful-orders-api')!;
    const after = computeQuestions(changed, 's1').find((q) => q.id === 'q-stateful-orders-api')!;
    expect(after.subjectHash).not.toBe(before.subjectHash);
  });
});

describe('untrusted input', () => {
  it('prompt injection in tags/descriptions does not change which questions are raised', () => {
    const clean = computeQuestions(snapshot, 's1');
    const hostile = computeQuestions(buildHostileOrdersSnapshot(), 's1');
    expect(hostile.map((q) => q.detector)).toEqual(clean.map((q) => q.detector));
    expect(
      hostile.every((q) => q.priority === clean.find((c) => c.detector === q.detector)!.priority),
    ).toBe(true);
  });
});
