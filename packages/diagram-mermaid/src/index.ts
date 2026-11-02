import { EvidenceGraph, type CloudSnapshot, type Relationship } from '@cloud-to-code/core';

export interface DiagramOptions {
  /** Include `same-stack` edges (off by default: they are derived grouping hints, not data flow). */
  includeSameStack?: boolean;
  /** Include IAM `possible-access` hypotheses as dotted, labeled edges (on by default). */
  includePossibleAccess?: boolean;
}

/** Escape text for a quoted Mermaid label. AWS names and tags are untrusted, so nothing is passed through raw. */
export function escapeLabel(text: string): string {
  const cleaned = text
    // eslint-disable-next-line no-control-regex -- strip control characters from untrusted labels
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/&/g, '#amp;')
    .replace(/"/g, '#quot;')
    .replace(/</g, '#lt;')
    .replace(/>/g, '#gt;')
    .replace(/`/g, '#96;')
    .replace(/\|/g, '#124;')
    .replace(/[[\]{}()]/g, (c) => `#${c.charCodeAt(0)};`)
    .trim();
  return cleaned.length > 60 ? `${cleaned.slice(0, 57)}...` : cleaned;
}

const SHAPES: Record<string, [string, string]> = {
  'AWS::ApiGatewayV2::Api': ['([', '])'],
  'AWS::Lambda::Function': ['[', ']'],
  'AWS::DynamoDB::Table': ['[(', ')]'],
  'AWS::SQS::Queue': ['[[', ']]'],
  'AWS::Events::EventBus': ['{{', '}}'],
  'AWS::Events::Rule': ['>', ']'],
  'AWS::IAM::Role': ['(', ')'],
  'AWS::S3::Bucket': ['[(', ')]'],
};

function shortType(type: string): string {
  return type.split('::').slice(1).join(' ');
}

function edgeLine(from: string, to: string, rel: Relationship): string {
  if (rel.confidence === 'hypothesis')
    return `${from} -. "${escapeLabel(`${rel.kind} (hypothesis)`)}" .-> ${to}`;
  if (rel.confidence === 'derived') return `${from} -. "${escapeLabel(rel.kind)}" .-> ${to}`;
  return `${from} -- "${escapeLabel(rel.kind)}" --> ${to}`;
}

/**
 * Deterministic architecture diagram. Node IDs are assigned by sorted resource ID, so equal graphs always
 * render identically. Application candidates are subgraphs; resources shared by several candidates are drawn
 * outside every subgraph. Solid edges are confirmed, dotted are derived or hypotheses.
 */
export function renderMermaid(snapshot: CloudSnapshot, options: DiagramOptions = {}): string {
  const graph = new EvidenceGraph(snapshot);
  const { candidates, shared } = graph.applicationCandidates();
  const ids = new Map<string, string>();
  [...graph.resources.keys()].forEach((id, index) => ids.set(id, `n${index + 1}`));

  const node = (id: string): string => {
    const r = graph.resources.get(id)!;
    const [open, close] = SHAPES[r.type] ?? ['[', ']'];
    return `${ids.get(id)}${open}"${escapeLabel(r.displayName)}<br/>${escapeLabel(shortType(r.type))}"${close}`;
  };

  const lines: string[] = ['flowchart LR'];
  const drawn = new Set<string>();
  candidates.forEach((c, index) => {
    lines.push(`  subgraph app${index + 1}["${escapeLabel(c.name)}"]`);
    for (const id of c.resourceIds) {
      lines.push(`    ${node(id)}`);
      drawn.add(id);
    }
    lines.push('  end');
  });
  for (const s of shared) {
    lines.push(`  ${node(s.resourceId)}`);
    drawn.add(s.resourceId);
  }
  for (const id of graph.resources.keys()) {
    if (!drawn.has(id)) lines.push(`  ${node(id)}`);
  }

  const includePossible = options.includePossibleAccess ?? true;
  for (const rel of graph.relationships) {
    if (rel.kind === 'same-stack' && !options.includeSameStack) continue;
    if (rel.confidence === 'hypothesis' && !includePossible) continue;
    const from = ids.get(rel.from);
    const to = ids.get(rel.to);
    if (!from || !to) continue; // unresolved endpoints are reported in the inspection output, not drawn
    lines.push(`  ${edgeLine(from, to, rel)}`);
  }
  return `${lines.join('\n')}\n`;
}
