import { z } from 'zod';
import { IsoDateTime, NonEmpty } from './common.js';

export const SessionStateSchema = z.enum([
  'DISCOVERING',
  'ANALYZING',
  'AWAITING_INPUT',
  'PLANNING',
  'READY_FOR_REVIEW',
  'GENERATING',
  'VALIDATING',
  'COMPLETED',
  'BLOCKED',
  'FAILED',
]);
export type SessionState = z.infer<typeof SessionStateSchema>;

export const StrategySchema = z.enum(['faithful', 'balanced', 'modernized']);
export type Strategy = z.infer<typeof StrategySchema>;

export const SessionSchema = z.object({
  schemaVersion: z.literal('1'),
  id: NonEmpty,
  state: SessionStateSchema,
  snapshotId: NonEmpty,
  applicationId: z.string().optional(),
  strategy: StrategySchema,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /** Why the session is BLOCKED / FAILED, if applicable. */
  stateReason: z.string().optional(),
  history: z.array(
    z.object({
      from: SessionStateSchema.nullable(),
      to: SessionStateSchema,
      at: IsoDateTime,
      reason: z.string().optional(),
    }),
  ),
});
export type Session = z.infer<typeof SessionSchema>;
