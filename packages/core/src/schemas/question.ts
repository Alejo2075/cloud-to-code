import { z } from 'zod';
import { IsoDateTime, NonEmpty } from './common.js';

export const UNKNOWN_OPTION_ID = 'unknown';

export const QuestionTypeSchema = z.enum(['single-choice', 'multi-choice', 'text', 'confirmation']);
export type QuestionType = z.infer<typeof QuestionTypeSchema>;

export const QuestionPrioritySchema = z.enum(['blocking', 'important', 'optional']);
export type QuestionPriority = z.infer<typeof QuestionPrioritySchema>;

export const QuestionOptionSchema = z.object({
  id: NonEmpty,
  label: NonEmpty,
  consequences: NonEmpty,
});
export type QuestionOption = z.infer<typeof QuestionOptionSchema>;

export const ReconstructionQuestionSchema = z.object({
  /** Deterministic: depends on the detector and the subject resources, never on evidence content. */
  id: NonEmpty,
  sessionId: NonEmpty,
  /** Detector that produced the question (for auditing). */
  detector: NonEmpty,
  priority: QuestionPrioritySchema,
  type: QuestionTypeSchema,
  title: NonEmpty,
  /** What was found. */
  found: NonEmpty,
  /** What is uncertain. */
  uncertainty: NonEmpty,
  /** Why the answer matters. */
  whyItMatters: NonEmpty,
  /** What happens if the question is skipped. */
  effectOfSkipping: NonEmpty,
  /** Short combined evidence + reason text for hosts that render a single field. */
  context: NonEmpty,
  relatedResourceIds: z.array(NonEmpty),
  evidenceIds: z.array(NonEmpty),
  options: z.array(QuestionOptionSchema).optional(),
  /** Only for demonstrably safe defaults. */
  suggestedOptionId: z.string().optional(),
  allowUnknown: z.boolean(),
  requiredFor: z.enum(['generation', 'adoption', 'optimization']),
  /** Hash of the evidence this question depends on; a change reopens answered questions. */
  subjectHash: NonEmpty,
  /** Set when a previously answered question was reopened because evidence changed. */
  reopenedBecause: z.string().optional(),
});
export type ReconstructionQuestion = z.infer<typeof ReconstructionQuestionSchema>;

export const AnswerSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('choice'),
    optionId: NonEmpty,
    note: z.string().max(2000).optional(),
  }),
  z.object({ kind: z.literal('choices'), optionIds: z.array(NonEmpty).min(1) }),
  z.object({ kind: z.literal('text'), text: z.string().min(1).max(4000) }),
  z.object({ kind: z.literal('confirmation'), confirmed: z.boolean() }),
  z.object({ kind: z.literal('unknown') }),
]);
export type Answer = z.infer<typeof AnswerSchema>;

export const DecisionSourceSchema = z.enum(['interactive-user', 'answers-file', 'agent-host-user']);

export const DeveloperDecisionSchema = z.object({
  id: NonEmpty,
  questionId: NonEmpty,
  sessionId: NonEmpty,
  answer: AnswerSchema,
  source: DecisionSourceSchema,
  recordedAt: IsoDateTime,
  /** subjectHash of the question at answer time. */
  subjectHash: NonEmpty,
  /** Decision this one replaces (revision history is append-only). */
  supersedes: z.string().optional(),
  /** Number of secret-like fragments redacted from free text before saving. */
  redactions: z.number().int().nonnegative().default(0),
});
export type DeveloperDecision = z.infer<typeof DeveloperDecisionSchema>;
