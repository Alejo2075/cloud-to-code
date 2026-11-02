import { z } from 'zod';
import { IsoDateTime, NonEmpty } from './common.js';
import { ConfidenceSchema, DiagnosticSchema, EvidenceSchema } from './evidence.js';

export const RelationshipKindSchema = z.enum([
  'routes-to', // API route -> integration target
  'triggers', // event source (stream/queue/bucket) -> consumer
  'dead-letters-to', // queue -> dead-letter queue
  'assumes-role', // compute -> IAM role
  'possible-access', // IAM allows access; NOT proof of runtime use
  'rule-on-bus', // EventBridge rule -> bus
  'targets', // EventBridge rule -> target
  'notifies', // S3 bucket -> notification target
  'same-stack', // resources tagged by the same CloudFormation stack
]);
export type RelationshipKind = z.infer<typeof RelationshipKindSchema>;

export const CloudResourceSchema = z.object({
  /** Stable `account/region/type/physicalId`. */
  id: NonEmpty,
  /** CloudFormation-style type, e.g. AWS::Lambda::Function. */
  type: z.string().regex(/^[A-Za-z0-9]+::[A-Za-z0-9]+::[A-Za-z0-9]+$/),
  accountId: z.string().regex(/^\d{12}$/),
  region: NonEmpty,
  physicalId: NonEmpty,
  arn: z.string().optional(),
  displayName: NonEmpty,
  /** Allowlisted and sanitized properties only. */
  observedProperties: z.record(z.string(), z.unknown()),
  tags: z.record(z.string(), z.string()),
  evidenceIds: z.array(NonEmpty),
  diagnostics: z.array(DiagnosticSchema),
});
export type CloudResource = z.infer<typeof CloudResourceSchema>;

export const RelationshipSchema = z.object({
  from: NonEmpty,
  to: NonEmpty,
  kind: RelationshipKindSchema,
  confidence: ConfidenceSchema,
  evidenceIds: z.array(NonEmpty),
});
export type Relationship = z.infer<typeof RelationshipSchema>;

export const SnapshotScopeSchema = z.object({
  accountIds: z.array(z.string()),
  regions: z.array(z.string()),
  services: z.array(z.string()),
});

export const CloudSnapshotSchema = z.object({
  schemaVersion: z.literal('1'),
  id: NonEmpty,
  collectedAt: IsoDateTime,
  scope: SnapshotScopeSchema,
  resources: z.array(CloudResourceSchema),
  relationships: z.array(RelationshipSchema),
  evidence: z.array(EvidenceSchema),
  diagnostics: z.array(DiagnosticSchema),
});
export type CloudSnapshot = z.infer<typeof CloudSnapshotSchema>;
