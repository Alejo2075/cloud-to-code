import type {
  Answer,
  DeveloperDecision,
  ReconstructionPlan,
  ReconstructionQuestion,
} from '@cloud-to-code/core';
import type { InspectionReport, SessionStatus } from '@cloud-to-code/reconstruction';

function indent(text: string, n = 2): string {
  const pad = ' '.repeat(n);
  return text
    .split('\n')
    .map((l) => (l.length > 0 ? pad + l : l))
    .join('\n');
}

function shortName(id: string): string {
  return id.split('/').slice(3).join('/');
}

export function renderInspection(report: InspectionReport): string {
  const lines: string[] = [];
  lines.push(`Snapshot ${report.snapshotId} (collected ${report.collectedAt})`);
  lines.push(
    `Scope: accounts ${report.scope.accountIds.join(', ') || '-'} | regions ${report.scope.regions.join(', ') || '-'} | services ${report.scope.services.join(', ') || '-'}`,
  );
  lines.push('');
  lines.push(`Resources (${report.resources.length}):`);
  for (const [type, count] of Object.entries(report.resourceCounts))
    lines.push(`  ${count} x ${type}`);
  lines.push('');
  lines.push(`Application candidates (${report.candidates.length}):`);
  for (const c of report.candidates) {
    lines.push(`  - ${c.name}  [${c.resourceIds.length} resources]`);
    if (c.sharedResourceIds.length > 0) {
      lines.push(`      shares: ${c.sharedResourceIds.map(shortName).join(', ')}`);
    }
  }
  if (report.shared.length > 0) {
    lines.push('');
    lines.push('Shared resources (ownership needs your decision):');
    for (const s of report.shared)
      lines.push(`  - ${shortName(s.resourceId)} used by ${s.candidateIds.length} candidates`);
  }
  if (report.unassignedHubs.length > 0) {
    lines.push('');
    lines.push(
      `Unattached shared-type resources: ${report.unassignedHubs.map(shortName).join(', ')}`,
    );
  }
  const byConfidence = { confirmed: 0, derived: 0, hypothesis: 0 };
  for (const r of report.relationships) byConfidence[r.confidence]++;
  lines.push('');
  lines.push(
    `Relationships: ${byConfidence.confirmed} confirmed, ${byConfidence.derived} derived, ${byConfidence.hypothesis} hypotheses`,
  );
  for (const r of report.relationships.filter((x) => x.confidence === 'hypothesis')) {
    lines.push(
      `  ? ${shortName(r.from)} --${r.kind}--> ${shortName(r.to)}  (permission only, not proof of use)`,
    );
  }
  if (report.unresolvedEndpoints.length > 0) {
    lines.push('');
    lines.push('Unresolved references (outside scope, denied or unsupported):');
    for (const u of report.unresolvedEndpoints) lines.push(`  ! ${u.missing}`);
  }
  if (report.diagnostics.length > 0) {
    lines.push('');
    lines.push('Diagnostics:');
    for (const d of report.diagnostics) lines.push(`  [${d.severity}] ${d.code}: ${d.message}`);
  }
  const q = report.questionSummary;
  lines.push('');
  lines.push(
    `Open questions: ${q.blocking} blocking, ${q.important} important, ${q.optional} optional`,
  );
  lines.push('');
  lines.push('Limitations:');
  for (const l of report.limitations) lines.push(`  ! ${l}`);
  return lines.join('\n');
}

export function renderQuestion(
  q: ReconstructionQuestion,
  position?: { index: number; total: number },
): string {
  const head = `${position ? `[${position.index}/${position.total}] ` : ''}${q.priority.toUpperCase()}  ${q.title}`;
  const lines = [head, `  id: ${q.id}`];
  lines.push(`  Found:          ${q.found}`);
  lines.push(`  Uncertain:      ${q.uncertainty}`);
  lines.push(`  Why it matters: ${q.whyItMatters}`);
  lines.push(`  If skipped:     ${q.effectOfSkipping}`);
  if (q.reopenedBecause) lines.push(`  Reopened:       ${q.reopenedBecause}`);
  if (q.options) {
    lines.push('  Options:');
    for (const o of q.options) {
      const rec = o.id === q.suggestedOptionId ? '  [recommended]' : '';
      lines.push(`    ${o.id}${rec}`);
      lines.push(`      ${o.label}`);
      lines.push(`      -> ${o.consequences}`);
    }
  }
  if (q.allowUnknown)
    lines.push("    unknown\n      I don't know (blocking questions then stop the session)");
  return lines.join('\n');
}

export function renderStatus(s: SessionStatus): string {
  const lines = [
    `Session ${s.sessionId}: ${s.state}${s.stateReason ? ` - ${s.stateReason}` : ''}`,
    `  Application: ${s.applicationId ?? '(not selected)'} | strategy: ${s.strategy}`,
    `  Questions: ${s.answered} answered, ${s.pending} pending${s.blocking.length > 0 ? ` (${s.blocking.length} blocking)` : ''}`,
  ];
  return lines.join('\n');
}

export function formatAnswer(a: Answer): string {
  switch (a.kind) {
    case 'choice':
      return a.note ? `${a.optionId} (${a.note})` : a.optionId;
    case 'choices':
      return a.optionIds.join(', ');
    case 'text':
      return a.text;
    case 'confirmation':
      return a.confirmed ? 'yes' : 'no';
    case 'unknown':
      return "I don't know";
  }
}

export function renderDecisions(
  latest: readonly DeveloperDecision[],
  history: readonly DeveloperDecision[],
  showHistory: boolean,
): string {
  if (latest.length === 0) return 'No decisions recorded yet.';
  const rows = (showHistory ? history : latest).map(
    (d) =>
      `  ${d.recordedAt}  ${d.questionId} = ${formatAnswer(d.answer)}  [${d.source}]${d.supersedes ? `  (revises ${d.supersedes})` : ''}${d.redactions > 0 ? `  (${d.redactions} redaction(s))` : ''}`,
  );
  return `${showHistory ? 'Decision history' : 'Current decisions'} (${rows.length}):\n${rows.join('\n')}`;
}

export function renderPlanSummary(plan: ReconstructionPlan): string {
  const lines = [
    `Plan for ${plan.applicationName} (${plan.generation.strategy}, produced by ${plan.producedBy})`,
    `  Owned: ${plan.boundaries.owned.length} | referenced: ${plan.boundaries.referenced.length} | excluded: ${plan.boundaries.excluded.length}`,
    `  Constructs: ${plan.constructs.map((c) => `${c.name} (${c.ownership})`).join(', ')}`,
    `  Unresolved properties: ${plan.unresolved.length} (need manual input)`,
  ];
  for (const a of plan.assumptions.filter((x) => !x.accepted))
    lines.push(`  ! Unaccepted assumption: ${a.statement}`);
  return lines.join('\n');
}

export { indent };
