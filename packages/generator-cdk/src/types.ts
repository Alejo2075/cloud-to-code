import type { CloudSnapshot, DeveloperDecision, ReconstructionPlan } from '@cloud-to-code/core';

export interface GenerateInput {
  snapshot: CloudSnapshot;
  plan: ReconstructionPlan;
  decisions: readonly DeveloperDecision[];
  /** Tool version recorded in the manifest. */
  toolVersion?: string;
}

export interface GeneratedFile {
  /** POSIX path relative to the project root. */
  path: string;
  content: string;
}

export type PropertyStatus =
  'preserved' | 'approximated' | 'intentionally-omitted' | 'unresolved' | 'not-mapped';

export interface PropertyCoverage {
  name: string;
  status: PropertyStatus;
  note?: string;
}

export interface ResourceCoverage {
  resourceId: string;
  type: string;
  displayName: string;
  ownership: 'recreate' | 'reference';
  construct: string;
  file: string;
  ruleId: string;
  level: 'L1' | 'L2';
  logicalId: string;
  evidenceIds: string[];
  decisionIds: string[];
  properties: PropertyCoverage[];
}

export interface Expectation {
  /** CloudFormation resource type to assert on. */
  type: string;
  /** Number of resources of that type that must exist (set on the first expectation of a type only). */
  properties?: Record<string, unknown>;
  retain?: boolean;
  description: string;
}

export interface GeneratedProject {
  files: GeneratedFile[];
  coverage: ResourceCoverage[];
  /** Resources that need manual work, merged from the plan and the generator. */
  unresolved: { resourceId: string; property: string; reason: string }[];
}

export class GenerationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GenerationError';
  }
}
