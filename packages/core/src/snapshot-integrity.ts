import { shortHash } from './hash.js';
import { buildResourceId } from './ids.js';
import { CloudSnapshotSchema, type CloudSnapshot } from './schemas/snapshot.js';
import { SCHEMA_VERSION } from './schemas/common.js';
import { defaultMigrations } from './versioning.js';

export interface IntegrityIssue {
  severity: 'error' | 'warning';
  code:
    | 'duplicate-resource-id'
    | 'duplicate-evidence-id'
    | 'unknown-evidence-id'
    | 'id-mismatch'
    | 'unresolved-endpoint';
  message: string;
}

/** Deterministic snapshot ID: depends on content, not on collection time. */
export function computeSnapshotId(
  snapshot: Pick<CloudSnapshot, 'scope' | 'resources' | 'relationships'>,
): string {
  const content = {
    scope: snapshot.scope,
    resources: [...snapshot.resources]
      .map((r) => ({ id: r.id, p: r.observedProperties, t: r.tags }))
      .sort(byId),
    relationships: [...snapshot.relationships]
      .map((r) => `${r.from}|${r.to}|${r.kind}|${r.confidence}`)
      .sort(),
  };
  return `snap-${shortHash(content, 16)}`;
}

function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function validateSnapshotIntegrity(snapshot: CloudSnapshot): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  const evidenceIds = new Set<string>();
  for (const e of snapshot.evidence) {
    if (evidenceIds.has(e.id)) {
      issues.push({
        severity: 'error',
        code: 'duplicate-evidence-id',
        message: `Duplicate evidence ID ${e.id}`,
      });
    }
    evidenceIds.add(e.id);
  }

  const resourceIds = new Set<string>();
  for (const r of snapshot.resources) {
    if (resourceIds.has(r.id)) {
      issues.push({
        severity: 'error',
        code: 'duplicate-resource-id',
        message: `Duplicate resource ID ${r.id}`,
      });
    }
    resourceIds.add(r.id);
    let expected: string | undefined;
    try {
      expected = buildResourceId({
        accountId: r.accountId,
        region: r.region,
        type: r.type,
        physicalId: r.physicalId,
      });
    } catch {
      expected = undefined;
    }
    if (expected !== r.id) {
      issues.push({
        severity: 'error',
        code: 'id-mismatch',
        message: `Resource ID ${r.id} does not match its account/region/type/physicalId`,
      });
    }
    for (const id of r.evidenceIds) {
      if (!evidenceIds.has(id)) {
        issues.push({
          severity: 'error',
          code: 'unknown-evidence-id',
          message: `Resource ${r.id} references unknown evidence ${id}`,
        });
      }
    }
  }

  for (const rel of snapshot.relationships) {
    for (const id of rel.evidenceIds) {
      if (!evidenceIds.has(id)) {
        issues.push({
          severity: 'error',
          code: 'unknown-evidence-id',
          message: `Relationship ${rel.from} -> ${rel.to} references unknown evidence ${id}`,
        });
      }
    }
    for (const end of [rel.from, rel.to]) {
      if (!resourceIds.has(end)) {
        issues.push({
          severity: 'warning',
          code: 'unresolved-endpoint',
          message: `Relationship ${rel.kind} references ${end}, which is not in the snapshot (outside scope, denied, or unsupported)`,
        });
      }
    }
  }
  return issues;
}

export class SnapshotValidationError extends Error {
  constructor(
    message: string,
    readonly issues: IntegrityIssue[],
  ) {
    super(message);
    this.name = 'SnapshotValidationError';
  }
}

/** Migrate, schema-validate and integrity-check untrusted snapshot JSON. Throws on errors. */
export function parseSnapshot(raw: unknown): {
  snapshot: CloudSnapshot;
  warnings: IntegrityIssue[];
} {
  const migrated = defaultMigrations.migrate('snapshot', raw, SCHEMA_VERSION);
  const result = CloudSnapshotSchema.safeParse(migrated);
  if (!result.success) {
    throw new SnapshotValidationError(`Invalid snapshot: ${result.error.message}`, []);
  }
  const issues = validateSnapshotIntegrity(result.data);
  const errors = issues.filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    throw new SnapshotValidationError(
      `Snapshot integrity errors:\n${errors.map((e) => `- ${e.message}`).join('\n')}`,
      issues,
    );
  }
  return { snapshot: result.data, warnings: issues.filter((i) => i.severity === 'warning') };
}
