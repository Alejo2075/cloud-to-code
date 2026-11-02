import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EvidenceGraph, parseSnapshot, redactSecrets, sanitizeValue } from '@cloud-to-code/core';
import {
  CANARY_SECRETS,
  buildHostileOrdersSnapshot,
  buildServerlessOrdersSnapshot,
} from './index.js';
import { exampleSnapshotPath, serializeSnapshot } from './generate-examples.js';

describe('serverless-orders fixture', () => {
  const snapshot = buildServerlessOrdersSnapshot();

  it('is a valid, integrity-checked snapshot', () => {
    const { warnings } = parseSnapshot(JSON.parse(JSON.stringify(snapshot)));
    expect(warnings).toEqual([]);
    expect(snapshot.resources.length).toBeGreaterThanOrEqual(15);
  });

  it('is deterministic', () => {
    expect(buildServerlessOrdersSnapshot()).toEqual(snapshot);
  });

  it('models two application candidates joined only by a shared event bus', () => {
    const graph = new EvidenceGraph(snapshot);
    const { candidates, shared } = graph.applicationCandidates();
    expect(candidates.map((c) => c.name)).toEqual(['billing-handler', 'orders-api']);
    expect(shared.map((s) => s.resourceId)).toEqual([
      '123456789012/us-east-1/AWS::Events::EventBus/shared-events',
    ]);
  });

  it('records IAM-derived edges only as hypotheses', () => {
    const possible = snapshot.relationships.filter((r) => r.kind === 'possible-access');
    expect(possible.length).toBeGreaterThan(0);
    expect(possible.every((r) => r.confidence === 'hypothesis')).toBe(true);
  });

  it('never contains environment variable values or secret-looking data', () => {
    const json = JSON.stringify(snapshot);
    expect(json).not.toMatch(/AKIA|BEGIN .*PRIVATE KEY|"environment"/);
    expect(redactSecrets(json).redactions).toBe(0);
  });

  it('matches the committed example file', () => {
    const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
    expect(readFileSync(exampleSnapshotPath(root), 'utf8')).toBe(serializeSnapshot());
  });
});

describe('hostile fixture', () => {
  it('carries canary secrets that sanitization removes', () => {
    const hostile = buildHostileOrdersSnapshot();
    const raw = JSON.stringify(hostile);
    for (const canary of CANARY_SECRETS) expect(raw).toContain(canary);
    const sanitized = JSON.stringify(sanitizeValue(hostile));
    for (const canary of CANARY_SECRETS) expect(sanitized).not.toContain(canary);
  });
});
