import { describe, expect, it } from 'vitest';
import {
  SnapshotValidationError,
  computeSnapshotId,
  parseSnapshot,
  validateSnapshotIntegrity,
} from './snapshot-integrity.js';
import { UnsupportedSchemaVersionError } from './versioning.js';
import { rel, res, snap } from './test-helpers.js';

describe('snapshot integrity', () => {
  const fn = res('AWS::Lambda::Function', 'a');
  const table = res('AWS::DynamoDB::Table', 't');

  it('accepts a consistent snapshot', () => {
    const s = snap([fn, table], [rel(fn, table, 'possible-access', 'hypothesis')]);
    expect(validateSnapshotIntegrity(s)).toEqual([]);
    expect(parseSnapshot(JSON.parse(JSON.stringify(s))).snapshot.resources).toHaveLength(2);
  });

  it('flags duplicate resources, unknown evidence and mismatched IDs as errors', () => {
    const bad = { ...fn, id: 'wrong' };
    const dupEvidence = snap([fn, fn, bad], []);
    dupEvidence.evidence.push(dupEvidence.evidence[0]!);
    const codes = validateSnapshotIntegrity(dupEvidence).map((i) => i.code);
    expect(codes).toEqual(
      expect.arrayContaining(['duplicate-resource-id', 'duplicate-evidence-id', 'id-mismatch']),
    );
    expect(() => parseSnapshot(dupEvidence)).toThrow(SnapshotValidationError);

    const unknownEvidence = snap([{ ...fn, evidenceIds: ['nope'] }], []);
    expect(validateSnapshotIntegrity(unknownEvidence).map((i) => i.code)).toContain(
      'unknown-evidence-id',
    );
  });

  it('reports unresolved relationship endpoints as warnings, not errors', () => {
    const s = snap([fn], [rel(fn, '123456789012/us-east-1/AWS::SQS::Queue/gone', 'triggers')]);
    const issues = validateSnapshotIntegrity(s);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: 'warning', code: 'unresolved-endpoint' });
    expect(parseSnapshot(s).warnings).toHaveLength(1);
  });

  it('rejects malformed and future-version snapshots', () => {
    expect(() => parseSnapshot({ schemaVersion: '1', id: 'x' })).toThrow(SnapshotValidationError);
    expect(() => parseSnapshot({ schemaVersion: '2' })).toThrow(UnsupportedSchemaVersionError);
  });

  it('computes content-based, order-independent snapshot IDs', () => {
    const a = snap([fn, table], [rel(fn, table, 'triggers')]);
    const b = snap([table, fn], [rel(fn, table, 'triggers')]);
    expect(computeSnapshotId(a)).toBe(computeSnapshotId(b));
    expect(computeSnapshotId(a)).not.toBe(computeSnapshotId(snap([fn], [])));
  });
});
