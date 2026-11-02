import { z } from 'zod';
import { IsoDateTime, NonEmpty } from './common.js';

export const EvidenceKindSchema = z.enum([
  'aws-observed',
  'deterministic',
  'ai-proposed',
  'user-confirmed',
]);
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

export const ConfidenceSchema = z.enum(['confirmed', 'derived', 'hypothesis']);
export type Confidence = z.infer<typeof ConfidenceSchema>;

export const EvidenceSchema = z.object({
  id: NonEmpty,
  kind: EvidenceKindSchema,
  /** AWS operation/field, deterministic rule ID, or decision ID. */
  source: NonEmpty,
  collectedAt: IsoDateTime.optional(),
  /** Sanitized; must never contain secrets. */
  detail: z.string().max(2000).optional(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const DiagnosticSeveritySchema = z.enum(['info', 'warning', 'error']);

export const DiagnosticSchema = z.object({
  code: NonEmpty,
  severity: DiagnosticSeveritySchema,
  message: NonEmpty,
  service: z.string().optional(),
  region: z.string().optional(),
  resourceId: z.string().optional(),
  remediation: z.string().optional(),
});
export type Diagnostic = z.infer<typeof DiagnosticSchema>;
