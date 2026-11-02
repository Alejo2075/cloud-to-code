import { mkdtempSync, rmSync, symlinkSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildServerlessOrdersSnapshot } from '@cloud-to-code/testing';
import { parseAnswersFile } from './answers-file.js';
import { inspectSnapshot } from './inspect.js';
import { slug, toPascalCase } from './naming.js';
import { WorkspaceStore } from './workspace.js';
import { createSession } from '@cloud-to-code/core';

describe('inspectSnapshot', () => {
  const report = inspectSnapshot(buildServerlessOrdersSnapshot());
  it('summarizes candidates, shared resources and question counts', () => {
    expect(report.candidates.map((c) => c.name)).toEqual(['billing-handler', 'orders-api']);
    expect(report.shared).toHaveLength(1);
    expect(report.questionSummary).toEqual({ blocking: 1, important: 4, optional: 0 });
    expect(report.resourceCounts['AWS::Lambda::Function']).toBe(4);
  });
  it('states limitations prominently', () => {
    expect(report.limitations.join(' ')).toMatch(/possible-access/);
    expect(report.limitations.join(' ')).toMatch(/never collected/);
  });
});

describe('answers file', () => {
  it('parses map and list formats', () => {
    expect(parseAnswersFile({ q1: 'reference', q2: 'unknown', q3: true })).toEqual([
      { questionId: 'q1', answer: { kind: 'choice', optionId: 'reference' } },
      { questionId: 'q2', answer: { kind: 'unknown' } },
      { questionId: 'q3', answer: { kind: 'confirmation', confirmed: true } },
    ]);
    expect(
      parseAnswersFile({ answers: [{ questionId: 'q1', answer: { kind: 'text', text: 'x' } }] }),
    ).toHaveLength(1);
  });
  it('rejects malformed files', () => {
    expect(() => parseAnswersFile([1, 2])).toThrow(/Invalid answers file/);
    expect(() => parseAnswersFile({ q1: 5 })).toThrow(/Invalid answers file/);
  });
});

describe('naming', () => {
  it('converts names', () => {
    expect(toPascalCase('orders-api')).toBe('OrdersApi');
    expect(toPascalCase('9lives')).toBe('A9lives');
    expect(toPascalCase('***')).toBe('Unnamed');
    expect(slug('Orders API!')).toBe('orders-api');
  });
});

describe('WorkspaceStore hardening', () => {
  it('refuses a symlinked workspace directory and reports corrupt decisions', () => {
    const base = mkdtempSync(join(tmpdir(), 'c2c-'));
    const target = mkdtempSync(join(tmpdir(), 'c2c-target-'));
    try {
      symlinkSync(target, join(base, '.c2c'));
      const snap = buildServerlessOrdersSnapshot();
      const session = createSession({
        id: 'sess-a',
        snapshotId: snap.id,
        strategy: 'balanced',
        now: new Date(),
      });
      expect(() => new WorkspaceStore(base).createSession(session, snap)).toThrow(/symlink/);

      const base2 = mkdtempSync(join(tmpdir(), 'c2c-'));
      const store = new WorkspaceStore(base2);
      store.createSession(session, snap);
      writeFileSync(join(base2, '.c2c', 'sessions', 'sess-a', 'decisions.jsonl'), '{not json}\n');
      expect(() => store.loadDecisions('sess-a')).toThrow(/Corrupt decision at line 1/);
      rmSync(base2, { recursive: true, force: true });
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
    void mkdirSync;
  });
});
