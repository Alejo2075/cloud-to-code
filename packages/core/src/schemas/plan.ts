import { z } from 'zod';
import { NonEmpty } from './common.js';
import { StrategySchema } from './session.js';

export const OwnershipModeSchema = z.enum(['recreate', 'reference', 'adopt']);
export type OwnershipMode = z.infer<typeof OwnershipModeSchema>;

export const ConstructLevelSchema = z.enum(['L1', 'L2', 'custom']);

export const StackPlanSchema = z.object({
  id: NonEmpty,
  name: NonEmpty,
  constructIds: z.array(NonEmpty),
  rationale: NonEmpty,
  evidenceIds: z.array(NonEmpty),
});
export type StackPlan = z.infer<typeof StackPlanSchema>;

export const ConstructPlanSchema = z.object({
  id: NonEmpty,
  /** Construct ID in the generated code (PascalCase identifier). */
  name: NonEmpty,
  resourceIds: z.array(NonEmpty).min(1),
  level: ConstructLevelSchema,
  /** Deterministic mapping rule that produces this construct (provenance). */
  ruleId: NonEmpty,
  ownership: OwnershipModeSchema,
  stackId: NonEmpty,
  evidenceIds: z.array(NonEmpty),
  decisionIds: z.array(NonEmpty),
});
export type ConstructPlan = z.infer<typeof ConstructPlanSchema>;

export const AssumptionSchema = z.object({
  id: NonEmpty,
  statement: NonEmpty,
  kind: z.enum(['ai-hypothesis', 'default']),
  /** True only when the developer explicitly accepted it. */
  accepted: z.boolean(),
  evidenceIds: z.array(NonEmpty),
});
export type Assumption = z.infer<typeof AssumptionSchema>;

export const UnresolvedPropertySchema = z.object({
  resourceId: NonEmpty,
  property: NonEmpty,
  reason: NonEmpty,
  requiredFor: z.enum(['generation', 'adoption', 'optimization']),
});
export type UnresolvedProperty = z.infer<typeof UnresolvedPropertySchema>;

export const ReconstructionPlanSchema = z.object({
  schemaVersion: z.literal('1'),
  snapshotId: NonEmpty,
  applicationId: NonEmpty,
  /** Human-readable application name (derived, not an AWS physical ID). */
  applicationName: NonEmpty,
  producedBy: z.enum(['deterministic-planner', 'ai-provider', 'agent-host']),
  selectedResourceIds: z.array(NonEmpty).min(1),
  boundaries: z.object({
    owned: z.array(NonEmpty),
    referenced: z.array(NonEmpty),
    excluded: z.array(NonEmpty),
  }),
  stacks: z.array(StackPlanSchema).min(1),
  constructs: z.array(ConstructPlanSchema).min(1),
  generation: z.object({ strategy: StrategySchema }),
  evidenceIds: z.array(NonEmpty),
  decisionIds: z.array(NonEmpty),
  assumptions: z.array(AssumptionSchema),
  unresolved: z.array(UnresolvedPropertySchema),
});
export type ReconstructionPlan = z.infer<typeof ReconstructionPlanSchema>;
