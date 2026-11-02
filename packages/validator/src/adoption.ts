import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface AdoptionResource {
  resourceId: string;
  type: string;
  construct: string;
  logicalId: string;
  stateful: boolean;
  unresolved: string[];
}

export interface AdoptionPlan {
  directory: string;
  /** Always "advisory": this tool never imports, deploys or modifies anything. */
  mode: 'advisory';
  resources: AdoptionResource[];
  referenced: string[];
  prerequisites: string[];
  warnings: string[];
  manualSteps: string[];
}

const STATEFUL = new Set(['AWS::DynamoDB::Table', 'AWS::SQS::Queue', 'AWS::S3::Bucket']);

interface CoverageFile {
  resources?: {
    resourceId: string;
    type: string;
    ownership: string;
    construct: string;
    logicalId: string;
    properties?: { name: string; status: string }[];
  }[];
  unresolved?: { resourceId: string; property: string }[];
}

/**
 * Read a generated project and describe what adopting the EXISTING resources would involve. It never calls
 * AWS and never runs `cdk import`; it only reads the reports already in the project.
 */
export function adoptionPlan(directory: string): AdoptionPlan {
  const dir = resolve(directory);
  const path = join(dir, 'reports', 'coverage.json');
  if (!existsSync(path)) throw new Error(`${path} not found; generate a project first.`);
  const coverage = JSON.parse(readFileSync(path, 'utf8')) as CoverageFile;
  const resources = (coverage.resources ?? []).filter((r) => r.ownership === 'recreate');
  const referenced = (coverage.resources ?? [])
    .filter((r) => r.ownership === 'reference')
    .map((r) => r.resourceId);
  const unresolved = coverage.unresolved ?? [];
  const mapped: AdoptionResource[] = resources.map((r) => ({
    resourceId: r.resourceId,
    type: r.type,
    construct: r.construct,
    logicalId: r.logicalId,
    stateful: STATEFUL.has(r.type),
    unresolved: [
      ...unresolved.filter((u) => u.resourceId === r.resourceId).map((u) => u.property),
      ...(r.properties ?? [])
        .filter((p) => p.status === 'not-mapped' || p.status === 'unresolved')
        .map((p) => p.name),
    ].filter((v, i, a) => a.indexOf(v) === i),
  }));
  return {
    directory: dir,
    mode: 'advisory',
    resources: mapped,
    referenced,
    prerequisites: [
      'Check in the AWS documentation that every resource type below supports CloudFormation resource import; Cloud to Code does not assert support.',
      'Run `cdk synth` and read the template: the generated logical IDs (with hashes) are what an import would have to match.',
      'The generated code sets no physical names. An import maps existing physical resources to template resources, so any property that differs from the live resource is a replacement or update risk.',
      'Stateful resources need a retention/deletion policy and a backup before any stack operation.',
    ],
    warnings: [
      ...(mapped.some((m) => m.stateful)
        ? [
            'Stateful resources are present; a mistake can lose data. Treat them as the highest-risk step.',
          ]
        : []),
      ...(mapped.some((m) => m.unresolved.length > 0)
        ? [
            'Some properties are unresolved or not mapped; an import with a template that differs from the live resource may fail or change it.',
          ]
        : []),
      'Lambda code and environment values come from parameters; the live functions must be matched on those values.',
      'Referenced (shared) resources are not managed by this stack and are never imported by it.',
    ],
    manualSteps: [
      'Decide per resource: leave as is (reference), recreate next to it, or import it.',
      'Back up stateful resources.',
      'Resolve every item in reports/coverage.json and reports/reconstruction-decisions.md.',
      'Perform any import yourself, outside this tool, after reviewing a change set. This tool never applies changes.',
    ],
  };
}
