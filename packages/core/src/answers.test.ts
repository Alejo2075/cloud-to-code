import { describe, expect, it } from 'vitest';
import { validateAnswer } from './answers.js';
import type { ReconstructionQuestion } from './schemas/question.js';

const q = (over: Partial<ReconstructionQuestion> = {}): ReconstructionQuestion => ({
  id: 'q1',
  sessionId: 's1',
  detector: 'test',
  priority: 'blocking',
  type: 'single-choice',
  title: 't',
  found: 'f',
  uncertainty: 'u',
  whyItMatters: 'w',
  effectOfSkipping: 'e',
  context: 'c',
  relatedResourceIds: [],
  evidenceIds: [],
  options: [
    { id: 'a', label: 'A', consequences: 'a' },
    { id: 'b', label: 'B', consequences: 'b' },
  ],
  allowUnknown: true,
  requiredFor: 'generation',
  subjectHash: 'h',
  ...over,
});

describe('validateAnswer', () => {
  it('accepts a valid option and rejects unknown option IDs', () => {
    expect(validateAnswer(q(), { kind: 'choice', optionId: 'a' })).toMatchObject({ ok: true });
    expect(validateAnswer(q(), { kind: 'choice', optionId: 'zzz' })).toMatchObject({ ok: false });
  });

  it('rejects answers of the wrong kind', () => {
    expect(validateAnswer(q(), { kind: 'text', text: 'x' })).toMatchObject({ ok: false });
    expect(
      validateAnswer(q({ type: 'confirmation' }), { kind: 'choice', optionId: 'a' }),
    ).toMatchObject({ ok: false });
  });

  it('supports unknown only when allowed', () => {
    expect(validateAnswer(q(), { kind: 'unknown' })).toMatchObject({
      ok: true,
      answer: { kind: 'unknown' },
    });
    expect(validateAnswer(q(), { kind: 'choice', optionId: 'unknown' })).toMatchObject({
      ok: true,
    });
    expect(validateAnswer(q({ allowUnknown: false }), { kind: 'unknown' })).toMatchObject({
      ok: false,
    });
  });

  it('redacts secrets in free text and notes before they can be saved', () => {
    const text = validateAnswer(q({ type: 'text', options: undefined }), {
      kind: 'text',
      text: 'repo uses password=hunter2 AKIAIOSFODNN7EXAMPLE',
    });
    expect(text).toMatchObject({ ok: true });
    if (text.ok && text.answer.kind === 'text') {
      expect(text.answer.text).not.toMatch(/hunter2|AKIA/);
      expect(text.redactions).toBe(2);
    }
    const note = validateAnswer(q(), { kind: 'choice', optionId: 'a', note: 'token=abc123' });
    expect(note.ok && note.redactions).toBe(1);
  });

  it('validates multi-choice and confirmation', () => {
    const m = q({ type: 'multi-choice' });
    expect(validateAnswer(m, { kind: 'choices', optionIds: ['b', 'a', 'a'] })).toMatchObject({
      ok: true,
      answer: { optionIds: ['a', 'b'] },
    });
    expect(validateAnswer(m, { kind: 'choices', optionIds: ['x'] })).toMatchObject({ ok: false });
    expect(
      validateAnswer(q({ type: 'confirmation', options: undefined }), {
        kind: 'confirmation',
        confirmed: false,
      }),
    ).toMatchObject({ ok: true });
  });
});
