import { shortHash } from './hash.js';
import type { Confidence } from './schemas/evidence.js';
import type {
  CloudResource,
  CloudSnapshot,
  Relationship,
  RelationshipKind,
} from './schemas/snapshot.js';

/**
 * Resource types that commonly span applications. They are excluded when forming application candidates,
 * then attached to the candidate(s) they connect to. A hub touching two or more candidates is *shared*.
 */
export const SHAREABLE_HUB_TYPES: ReadonlySet<string> = new Set([
  'AWS::Events::EventBus',
  'AWS::SNS::Topic',
  'AWS::IAM::Role',
]);

const CONFIDENCE_RANK: Record<Confidence, number> = { hypothesis: 0, derived: 1, confirmed: 2 };

/** Relationships that prove structure (execution/data flow or ownership), as opposed to mere permission. */
export function isStructural(rel: Pick<Relationship, 'confidence'>): boolean {
  return rel.confidence === 'confirmed' || rel.confidence === 'derived';
}

/** Merge duplicate (from, to, kind) relationships keeping the strongest confidence and all evidence. */
export function normalizeRelationships(relationships: readonly Relationship[]): Relationship[] {
  const merged = new Map<string, Relationship>();
  for (const rel of relationships) {
    if (rel.from === rel.to) continue;
    const key = `${rel.from}|${rel.to}|${rel.kind}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...rel, evidenceIds: [...new Set(rel.evidenceIds)].sort() });
      continue;
    }
    const confidence =
      CONFIDENCE_RANK[rel.confidence] > CONFIDENCE_RANK[existing.confidence]
        ? rel.confidence
        : existing.confidence;
    merged.set(key, {
      ...existing,
      confidence,
      evidenceIds: [...new Set([...existing.evidenceIds, ...rel.evidenceIds])].sort(),
    });
  }
  return [...merged.values()].sort((a, b) =>
    `${a.from}|${a.to}|${a.kind}`.localeCompare(`${b.from}|${b.to}|${b.kind}`),
  );
}

export interface ApplicationCandidate {
  id: string;
  name: string;
  /** Resource IDs owned by the candidate (including hubs used by this candidate alone). */
  resourceIds: string[];
  /** Hubs this candidate touches that are also touched by another candidate. */
  sharedResourceIds: string[];
}

export interface SharedResource {
  resourceId: string;
  candidateIds: string[];
}

export class EvidenceGraph {
  readonly resources: ReadonlyMap<string, CloudResource>;
  readonly relationships: readonly Relationship[];
  private readonly byArn = new Map<string, string>();

  constructor(snapshot: Pick<CloudSnapshot, 'resources' | 'relationships'>) {
    const resources = new Map<string, CloudResource>();
    for (const r of [...snapshot.resources].sort((a, b) => a.id.localeCompare(b.id))) {
      resources.set(r.id, r);
      if (r.arn) this.byArn.set(r.arn, r.id);
    }
    this.resources = resources;
    this.relationships = normalizeRelationships(snapshot.relationships);
  }

  resolveArn(arn: string): string | undefined {
    return this.byArn.get(arn);
  }

  outgoing(id: string, kinds?: readonly RelationshipKind[]): Relationship[] {
    return this.relationships.filter((r) => r.from === id && (!kinds || kinds.includes(r.kind)));
  }

  incoming(id: string, kinds?: readonly RelationshipKind[]): Relationship[] {
    return this.relationships.filter((r) => r.to === id && (!kinds || kinds.includes(r.kind)));
  }

  /** Relationship endpoints that are not present in the snapshot. */
  unresolvedEndpoints(): { relationship: Relationship; missing: string }[] {
    const out: { relationship: Relationship; missing: string }[] = [];
    for (const rel of this.relationships) {
      for (const end of [rel.from, rel.to]) {
        if (!this.resources.has(end)) out.push({ relationship: rel, missing: end });
      }
    }
    return out;
  }

  /** True when a direct non-`same-stack` structural edge links the two resources, in either direction. */
  directlyConnected(a: string, b: string): boolean {
    return this.relationships.some(
      (r) =>
        isStructural(r) &&
        r.kind !== 'same-stack' &&
        ((r.from === a && r.to === b) || (r.from === b && r.to === a)),
    );
  }

  private structuralNeighbors(id: string, excluded: ReadonlySet<string>): string[] {
    const out: string[] = [];
    for (const r of this.relationships) {
      if (!isStructural(r)) continue;
      const other = r.from === id ? r.to : r.to === id ? r.from : undefined;
      if (other && this.resources.has(other) && !excluded.has(other)) out.push(other);
    }
    return out;
  }

  /**
   * Form application candidates.
   * 1. Remove shareable hubs (event buses, topics, IAM roles).
   * 2. Connected components over structural edges are candidates.
   * 3. A hub adjacent to exactly one candidate belongs to it; adjacent to two or more is *shared*.
   * This is a documented heuristic; AI interpretation may refine it but cannot override user decisions.
   */
  applicationCandidates(): {
    candidates: ApplicationCandidate[];
    shared: SharedResource[];
    unassignedHubs: string[];
  } {
    const hubs = new Set<string>();
    for (const [id, r] of this.resources) if (SHAREABLE_HUB_TYPES.has(r.type)) hubs.add(id);

    const componentOf = new Map<string, number>();
    const components: string[][] = [];
    for (const id of this.resources.keys()) {
      if (hubs.has(id) || componentOf.has(id)) continue;
      const members: string[] = [];
      const stack = [id];
      componentOf.set(id, components.length);
      while (stack.length > 0) {
        const current = stack.pop()!;
        members.push(current);
        for (const n of this.structuralNeighbors(current, hubs)) {
          if (!componentOf.has(n)) {
            componentOf.set(n, components.length);
            stack.push(n);
          }
        }
      }
      components.push(members.sort());
    }

    const hubTouches = new Map<string, Set<number>>();
    for (const hub of hubs) {
      const touched = new Set<number>();
      for (const rel of this.relationships) {
        if (!isStructural(rel)) continue;
        const other = rel.from === hub ? rel.to : rel.to === hub ? rel.from : undefined;
        if (other === undefined) continue;
        const comp = componentOf.get(other);
        if (comp !== undefined) touched.add(comp);
      }
      hubTouches.set(hub, touched);
    }

    const owned = components.map((c) => [...c]);
    const sharedPerComponent = components.map(() => new Set<string>());
    const unassignedHubs: string[] = [];
    const sharedHubs: { hub: string; comps: number[] }[] = [];
    for (const hub of [...hubs].sort()) {
      const comps = [...(hubTouches.get(hub) ?? [])].sort((a, b) => a - b);
      if (comps.length === 0) unassignedHubs.push(hub);
      else if (comps.length === 1) owned[comps[0]!]!.push(hub);
      else {
        sharedHubs.push({ hub, comps });
        for (const c of comps) sharedPerComponent[c]!.add(hub);
      }
    }

    const candidates: ApplicationCandidate[] = components.map((_, index) => {
      const resourceIds = owned[index]!.sort();
      return {
        id: `app-${shortHash(resourceIds, 10)}`,
        name: this.candidateName(resourceIds),
        resourceIds,
        sharedResourceIds: [...sharedPerComponent[index]!].sort(),
      };
    });
    candidates.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

    const idOfComponent = (index: number): string => {
      const members = [...owned[index]!].sort();
      return `app-${shortHash(members, 10)}`;
    };
    const shared: SharedResource[] = sharedHubs.map(({ hub, comps }) => ({
      resourceId: hub,
      candidateIds: comps.map(idOfComponent).sort(),
    }));
    return { candidates, shared, unassignedHubs };
  }

  private candidateName(resourceIds: readonly string[]): string {
    const typed = (type: string): string[] =>
      resourceIds
        .map((id) => this.resources.get(id))
        .filter((r): r is CloudResource => r?.type === type)
        .map((r) => r.displayName)
        .sort();
    return (
      typed('AWS::ApiGatewayV2::Api')[0] ??
      typed('AWS::Lambda::Function')[0] ??
      this.resources.get(resourceIds[0]!)?.displayName ??
      'unnamed'
    );
  }
}
