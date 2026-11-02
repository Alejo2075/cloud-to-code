import {
  EvidenceGraph,
  type ApplicationCandidate,
  type CloudSnapshot,
  type Diagnostic,
  type Relationship,
  type SharedResource,
} from '@cloud-to-code/core';
import { computeQuestions } from './questions.js';

export interface InspectionReport {
  snapshotId: string;
  collectedAt: string;
  scope: CloudSnapshot['scope'];
  resourceCounts: Record<string, number>;
  resources: { id: string; type: string; name: string }[];
  relationships: Relationship[];
  candidates: ApplicationCandidate[];
  shared: SharedResource[];
  unassignedHubs: string[];
  unresolvedEndpoints: { relationship: Relationship; missing: string }[];
  diagnostics: Diagnostic[];
  /** Number of questions that would be raised, by priority. */
  questionSummary: Record<'blocking' | 'important' | 'optional', number>;
  limitations: string[];
}

/** Offline inspection of a snapshot: graph, candidates, uncertainty. Pure; touches neither AWS nor disk. */
export function inspectSnapshot(snapshot: CloudSnapshot): InspectionReport {
  const graph = new EvidenceGraph(snapshot);
  const { candidates, shared, unassignedHubs } = graph.applicationCandidates();
  const counts: Record<string, number> = {};
  for (const r of snapshot.resources) counts[r.type] = (counts[r.type] ?? 0) + 1;
  const questions = computeQuestions(snapshot, 'inspect');
  const summary = { blocking: 0, important: 0, optional: 0 };
  for (const q of questions) summary[q.priority]++;
  const limitations: string[] = [];
  if (snapshot.diagnostics.some((d) => d.severity !== 'info')) {
    limitations.push(
      'Some services or regions were skipped or denied; absence of evidence does not prove a resource does not exist.',
    );
  }
  if (graph.relationships.some((r) => r.kind === 'possible-access')) {
    limitations.push(
      'IAM permissions are recorded as possible-access hypotheses, not confirmed runtime use.',
    );
  }
  limitations.push('Lambda source code, environment values, data and secrets are never collected.');
  return {
    snapshotId: snapshot.id,
    collectedAt: snapshot.collectedAt,
    scope: snapshot.scope,
    resourceCounts: Object.fromEntries(
      Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)),
    ),
    resources: snapshot.resources.map((r) => ({ id: r.id, type: r.type, name: r.displayName })),
    relationships: [...graph.relationships],
    candidates,
    shared,
    unassignedHubs,
    unresolvedEndpoints: graph.unresolvedEndpoints(),
    diagnostics: snapshot.diagnostics,
    questionSummary: summary,
    limitations,
  };
}
