import { z } from 'zod';
import { AnswerSchema, type Answer } from '@cloud-to-code/core';
import type { SubmitItem } from './service.js';

/**
 * `--answers` file format (JSON). Either a map of question ID to a plain option ID / Answer object:
 *   { "q-shared-shared-events": "reference", "q-x": { "kind": "choice", "optionId": "local-dir", "note": "../src" } }
 * or an explicit list: { "answers": [{ "questionId": "...", "answer": { ... } }] }.
 * Unknown IDs and invalid options are rejected later by the service, never silently ignored.
 */
const ListFormat = z.object({
  answers: z.array(
    z.object({ questionId: z.string().min(1), answer: z.union([AnswerSchema, z.string()]) }),
  ),
});
const MapFormat = z.record(z.string().min(1), z.union([AnswerSchema, z.string(), z.boolean()]));

function toAnswer(value: Answer | string | boolean): Answer {
  if (typeof value === 'boolean') return { kind: 'confirmation', confirmed: value };
  if (typeof value === 'string')
    return value === 'unknown' ? { kind: 'unknown' } : { kind: 'choice', optionId: value };
  return value;
}

export function parseAnswersFile(raw: unknown): SubmitItem[] {
  const list = ListFormat.safeParse(raw);
  if (list.success)
    return list.data.answers.map((a) => ({ questionId: a.questionId, answer: toAnswer(a.answer) }));
  const map = MapFormat.safeParse(raw);
  if (map.success)
    return Object.entries(map.data).map(([questionId, v]) => ({ questionId, answer: toAnswer(v) }));
  throw new Error(`Invalid answers file: ${map.error?.message ?? 'unrecognized format'}`);
}
