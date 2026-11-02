import {
  buildResourceId,
  computeSnapshotId,
  GLOBAL_REGION,
  SHAREABLE_HUB_TYPES,
  type CloudResource,
  type CloudSnapshot,
  type Evidence,
  type Relationship,
  type RelationshipKind,
} from '@cloud-to-code/core';

export const FIXTURE_ACCOUNT_ID = '123456789012';
export const FIXTURE_REGION = 'us-east-1';
export const FIXTURE_COLLECTED_AT = '2026-01-15T12:00:00Z';

/** Small helper that builds consistent, deterministic snapshots with evidence for every fact. */
export class FixtureBuilder {
  private readonly resources = new Map<string, CloudResource>();
  private readonly relationships: Relationship[] = [];
  private readonly evidence = new Map<string, Evidence>();

  private evidenceFor(source: string, detail: string): string {
    const id = `ev-${this.evidence.size + 1}`;
    const key = `${source}|${detail}`;
    const existing = [...this.evidence.values()].find((e) => `${e.source}|${e.detail}` === key);
    if (existing) return existing.id;
    this.evidence.set(id, {
      id,
      kind: 'aws-observed',
      source,
      collectedAt: FIXTURE_COLLECTED_AT,
      detail,
    });
    return id;
  }

  add(params: {
    type: string;
    physicalId: string;
    displayName?: string;
    arn?: string;
    global?: boolean;
    operation: string;
    properties: Record<string, unknown>;
    tags?: Record<string, string>;
  }): CloudResource {
    const region = params.global ? GLOBAL_REGION : FIXTURE_REGION;
    const id = buildResourceId({
      accountId: FIXTURE_ACCOUNT_ID,
      region,
      type: params.type,
      physicalId: params.physicalId,
    });
    const resource: CloudResource = {
      id,
      type: params.type,
      accountId: FIXTURE_ACCOUNT_ID,
      region,
      physicalId: params.physicalId,
      ...(params.arn ? { arn: params.arn } : {}),
      displayName: params.displayName ?? params.physicalId,
      observedProperties: params.properties,
      tags: params.tags ?? {},
      evidenceIds: [this.evidenceFor(params.operation, params.physicalId)],
      diagnostics: [],
    };
    this.resources.set(id, resource);
    return resource;
  }

  relate(
    from: CloudResource,
    to: CloudResource,
    kind: RelationshipKind,
    confidence: Relationship['confidence'],
    source: string,
  ): void {
    this.relationships.push({
      from: from.id,
      to: to.id,
      kind,
      confidence,
      evidenceIds: [this.evidenceFor(source, `${from.displayName} -> ${to.displayName}`)],
    });
  }

  /** Derive `same-stack` chains from CloudFormation stack tags (hubs are excluded). */
  deriveSameStack(): void {
    const byStack = new Map<string, CloudResource[]>();
    for (const r of this.resources.values()) {
      const stack = r.tags['aws:cloudformation:stack-name'];
      if (!stack || SHAREABLE_HUB_TYPES.has(r.type)) continue;
      byStack.set(stack, [...(byStack.get(stack) ?? []), r]);
    }
    for (const [stack, members] of byStack) {
      const sorted = members.sort((a, b) => a.id.localeCompare(b.id));
      for (let i = 1; i < sorted.length; i++) {
        this.relate(
          sorted[i - 1]!,
          sorted[i]!,
          'same-stack',
          'derived',
          `tag:aws:cloudformation:stack-name=${stack}`,
        );
      }
    }
  }

  build(): CloudSnapshot {
    const partial = {
      scope: {
        accountIds: [FIXTURE_ACCOUNT_ID],
        regions: [FIXTURE_REGION],
        services: [] as string[],
      },
      resources: [...this.resources.values()].sort((a, b) => a.id.localeCompare(b.id)),
      relationships: this.relationships,
    };
    const services = [
      ...new Set(partial.resources.map((r) => r.type.split('::')[1]!.toLowerCase())),
    ].sort();
    const snapshot: CloudSnapshot = {
      schemaVersion: '1',
      id: '',
      collectedAt: FIXTURE_COLLECTED_AT,
      scope: { ...partial.scope, services },
      resources: partial.resources,
      relationships: partial.relationships,
      evidence: [...this.evidence.values()],
      diagnostics: [],
    };
    snapshot.id = computeSnapshotId(snapshot);
    return snapshot;
  }
}
