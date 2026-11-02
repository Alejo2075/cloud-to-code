import { buildResourceId } from './ids.js';
import type { CloudResource, CloudSnapshot, Relationship } from './schemas/snapshot.js';

export const ACCOUNT = '123456789012';
export const REGION = 'us-east-1';

export function res(type: string, name: string, extra: Partial<CloudResource> = {}): CloudResource {
  return {
    id: buildResourceId({ accountId: ACCOUNT, region: REGION, type, physicalId: name }),
    type,
    accountId: ACCOUNT,
    region: REGION,
    physicalId: name,
    displayName: name,
    observedProperties: {},
    tags: {},
    evidenceIds: ['ev-1'],
    diagnostics: [],
    ...extra,
  };
}

export function rel(
  from: CloudResource | string,
  to: CloudResource | string,
  kind: Relationship['kind'],
  confidence: Relationship['confidence'] = 'confirmed',
): Relationship {
  return {
    from: typeof from === 'string' ? from : from.id,
    to: typeof to === 'string' ? to : to.id,
    kind,
    confidence,
    evidenceIds: ['ev-1'],
  };
}

export function snap(resources: CloudResource[], relationships: Relationship[]): CloudSnapshot {
  return {
    schemaVersion: '1',
    id: 'snap-test',
    collectedAt: '2026-01-01T00:00:00Z',
    scope: { accountIds: [ACCOUNT], regions: [REGION], services: [] },
    resources,
    relationships,
    evidence: [{ id: 'ev-1', kind: 'aws-observed', source: 'test' }],
    diagnostics: [],
  };
}
