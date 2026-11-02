import { redactSecrets } from './sanitize.js';
import { UNKNOWN_OPTION_ID, type Answer, type ReconstructionQuestion } from './schemas/question.js';

export type AnswerValidation =
  { ok: true; answer: Answer; redactions: number } | { ok: false; error: string };

/**
 * Validate an answer against its question's type and options. Free text and notes are redacted for secrets
 * before they can be persisted. `unknown` is accepted only when the question allows it.
 */
export function validateAnswer(question: ReconstructionQuestion, answer: Answer): AnswerValidation {
  if (
    answer.kind === 'unknown' ||
    (answer.kind === 'choice' && answer.optionId === UNKNOWN_OPTION_ID)
  ) {
    if (!question.allowUnknown)
      return { ok: false, error: `Question ${question.id} does not accept "I don't know"` };
    return { ok: true, answer: { kind: 'unknown' }, redactions: 0 };
  }

  const optionIds = new Set((question.options ?? []).map((o) => o.id));
  switch (question.type) {
    case 'single-choice': {
      if (answer.kind !== 'choice') return { ok: false, error: 'Expected a single choice answer' };
      if (!optionIds.has(answer.optionId)) {
        return {
          ok: false,
          error: `Unknown option "${answer.optionId}"; valid: ${[...optionIds].join(', ')}`,
        };
      }
      if (answer.note === undefined) return { ok: true, answer, redactions: 0 };
      const note = redactSecrets(answer.note);
      return { ok: true, answer: { ...answer, note: note.text }, redactions: note.redactions };
    }
    case 'multi-choice': {
      if (answer.kind !== 'choices')
        return { ok: false, error: 'Expected a multiple choice answer' };
      const bad = answer.optionIds.find((id) => !optionIds.has(id));
      if (bad)
        return { ok: false, error: `Unknown option "${bad}"; valid: ${[...optionIds].join(', ')}` };
      return {
        ok: true,
        answer: { ...answer, optionIds: [...new Set(answer.optionIds)].sort() },
        redactions: 0,
      };
    }
    case 'text': {
      if (answer.kind !== 'text') return { ok: false, error: 'Expected a text answer' };
      const text = redactSecrets(answer.text);
      if (text.text.trim().length === 0) return { ok: false, error: 'Text answer is empty' };
      return { ok: true, answer: { kind: 'text', text: text.text }, redactions: text.redactions };
    }
    case 'confirmation': {
      if (answer.kind !== 'confirmation')
        return { ok: false, error: 'Expected a confirmation answer' };
      return { ok: true, answer, redactions: 0 };
    }
  }
}
