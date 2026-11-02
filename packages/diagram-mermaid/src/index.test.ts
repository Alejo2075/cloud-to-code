import { describe, expect, it } from 'vitest';
import { buildHostileOrdersSnapshot, buildServerlessOrdersSnapshot } from '@cloud-to-code/testing';
import { escapeLabel, renderMermaid } from './index.js';

const snapshot = buildServerlessOrdersSnapshot();

describe('renderMermaid', () => {
  const out = renderMermaid(snapshot);

  it('is deterministic and independent of input order', () => {
    const reversed = {
      ...snapshot,
      resources: [...snapshot.resources].reverse(),
      relationships: [...snapshot.relationships].reverse(),
    };
    expect(renderMermaid(reversed)).toBe(out);
  });

  it('draws one subgraph per application candidate and the shared bus outside them', () => {
    expect(out.match(/subgraph /g)).toHaveLength(2);
    expect(out).toContain('subgraph app1["billing-handler"]');
    expect(out).toContain('subgraph app2["orders-api"]');
    const busLine = out.split('\n').find((l) => l.includes('shared-events<br/>'))!;
    expect(busLine.startsWith('  n')).toBe(true); // top-level, not indented into a subgraph
  });

  it('distinguishes confirmed edges from hypotheses and hides same-stack by default', () => {
    expect(out).toMatch(/-- "routes-to" -->/);
    expect(out).toMatch(/-\. "possible-access #40;hypothesis#41;" \.->/);
    expect(out).not.toContain('same-stack');
    expect(renderMermaid(snapshot, { includeSameStack: true })).toContain('same-stack');
    expect(renderMermaid(snapshot, { includePossibleAccess: false })).not.toContain('hypothesis');
  });

  it('matches the golden diagram', () => {
    expect(out).toMatchSnapshot();
  });
});

describe('untrusted labels', () => {
  it('escapes Mermaid syntax and control characters', () => {
    expect(escapeLabel('a"b<c>|d[e]{f}`g`\n')).toBe(
      'a#quot;b#lt;c#gt;#124;d#91;e#93;#123;f#125;#96;g#96;',
    );
    expect(escapeLabel('x'.repeat(100))).toHaveLength(60);
  });

  it('renders hostile names and tags inert', () => {
    const out2 = renderMermaid(buildHostileOrdersSnapshot());
    expect(out2).not.toContain('</untrusted>');
    expect(out2).not.toMatch(/<(?!br\/>)/);
    expect(out2).not.toContain('Ignore all previous');
  });
});
