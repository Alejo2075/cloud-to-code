import { describe, expect, it } from 'vitest';
import { sanitizeSnapshot } from './snapshot-sanitize.js';
import { res, snap } from './test-helpers.js';

describe('sanitizeSnapshot', () => {
  it('returns the same object when nothing needs redacting', () => {
    const s = snap([res('AWS::Lambda::Function', 'a')], []);
    const out = sanitizeSnapshot(s);
    expect(out.redactions).toBe(0);
    expect(out.snapshot).toBe(s);
  });

  it('redacts secrets in properties, tags, names and evidence, records a diagnostic and changes the ID', () => {
    const s = snap(
      [
        res('AWS::Lambda::Function', 'a', {
          displayName: 'a AKIAIOSFODNN7EXAMPLE',
          observedProperties: { description: 'password=hunter2', apiKey: 'zzz' },
          tags: { owner: 'x', deployToken: 'abc' },
        }),
      ],
      [],
    );
    s.evidence[0] = { ...s.evidence[0]!, detail: 'Bearer abcdefghijklmnopqrstuvwxyz012345' };
    const out = sanitizeSnapshot(s);
    const json = JSON.stringify(out.snapshot);
    expect(json).not.toMatch(/AKIA|hunter2|zzz|abcdefghijklmnop/);
    expect(out.snapshot.resources[0]!.tags['owner']).toBe('x');
    expect(out.redactions).toBeGreaterThanOrEqual(5);
    expect(out.snapshot.diagnostics.map((d) => d.code)).toContain('sanitized-input');
    expect(out.snapshot.id).not.toBe(s.id);
  });
});
