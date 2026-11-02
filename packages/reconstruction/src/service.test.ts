import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServerlessOrdersSnapshot } from '@cloud-to-code/testing';
import { ReconstructionService } from './service.js';
import { WorkspaceStore } from './workspace.js';

let dir: string;
let n = 0;
const snapshot = buildServerlessOrdersSnapshot();

function makeService() {
  const clock = { now: () => new Date('2026-02-01T10:00:00Z') };
  return new ReconstructionService(new WorkspaceStore(dir), { clock, newId: () => `t${++n}` });
}

const choice = (optionId: string, note?: string) => ({
  kind: 'choice' as const,
  optionId,
  ...(note ? { note } : {}),
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c2c-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('session lifecycle', () => {
  it('starts AWAITING_INPUT with a blocking question and a batch of at most three', () => {
    const svc = makeService();
    const session = svc.startSession(snapshot);
    expect(session.state).toBe('AWAITING_INPUT');
    const pending = svc.pending(session.id);
    expect(pending.questions).toHaveLength(3);
    expect(pending.questions[0]!.id).toBe('q-shared-shared-events');
    expect(pending.remaining).toBe(2);
    expect(pending.status.canGenerate).toBe(false);
    expect(pending.status.blocking).toEqual(['q-shared-shared-events']);
  });

  it('records a decision, persists it, and does not repeat the question on resume', () => {
    const svc = makeService();
    const { id } = svc.startSession(snapshot);
    const result = svc.submit(
      id,
      [{ questionId: 'q-shared-shared-events', answer: choice('reference') }],
      'interactive-user',
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.status.canGenerate).toBe(true);

    const fresh = makeService(); // new process, same workspace
    const resumed = fresh.resume(id);
    expect(resumed.questions.map((q) => q.id)).not.toContain('q-shared-shared-events');
    expect(fresh.decisions(id).latest[0]).toMatchObject({
      questionId: 'q-shared-shared-events',
      source: 'interactive-user',
      answer: { kind: 'choice', optionId: 'reference' },
    });
  });

  it('rejects unknown questions, invalid options and fabricated IDs without recording anything', () => {
    const svc = makeService();
    const { id } = svc.startSession(snapshot);
    const result = svc.submit(
      id,
      [
        { questionId: 'q-does-not-exist', answer: choice('reference') },
        { questionId: 'q-shared-shared-events', answer: choice('delete-everything') },
      ],
      'agent-host-user',
    );
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toHaveLength(2);
    expect(svc.decisions(id).history).toEqual([]);
  });

  it('answering "I don\'t know" to a blocking question blocks the session and prevents planning', () => {
    const svc = makeService();
    const { id } = svc.startSession(snapshot);
    const result = svc.submit(
      id,
      [{ questionId: 'q-shared-shared-events', answer: { kind: 'unknown' } }],
      'interactive-user',
    );
    expect(result.status.state).toBe('BLOCKED');
    expect(result.status.stateReason).toMatch(/q-shared-shared-events/);
    expect(result.status.canGenerate).toBe(false);
    const plan = svc.plan(id, { applicationId: 'orders-api' });
    expect(plan.plan).toBeUndefined();
    expect(plan.issues[0]).toMatchObject({ code: 'blocking-question-unresolved' });
  });

  it('keeps an auditable history when a decision is revised', () => {
    const svc = makeService();
    const { id } = svc.startSession(snapshot);
    svc.submit(
      id,
      [{ questionId: 'q-shared-shared-events', answer: choice('reference') }],
      'interactive-user',
    );
    svc.submit(
      id,
      [{ questionId: 'q-shared-shared-events', answer: choice('exclude') }],
      'interactive-user',
    );
    const { latest, history } = svc.decisions(id);
    expect(history).toHaveLength(2);
    expect(latest).toHaveLength(1);
    expect(latest[0]!.answer).toEqual({ kind: 'choice', optionId: 'exclude' });
    expect(latest[0]!.supersedes).toBe(history[0]!.id);
  });

  it('reopens an answered question and explains why when the evidence changes', () => {
    const svc = makeService();
    const { id } = svc.startSession(snapshot);
    svc.submit(
      id,
      [{ questionId: 'q-stateful-orders-api', answer: choice('recreate-retain') }],
      'interactive-user',
    );
    expect(
      svc.questionStates(id).find((s) => s.question.id === 'q-stateful-orders-api')!.status,
    ).toBe('answered');

    const changed = {
      ...snapshot,
      resources: snapshot.resources.map((r) =>
        r.physicalId === 'orders-table'
          ? { ...r, observedProperties: { ...r.observedProperties, billingMode: 'PROVISIONED' } }
          : r,
      ),
    };
    svc.updateSnapshot(id, changed);
    const state = svc.questionStates(id).find((s) => s.question.id === 'q-stateful-orders-api')!;
    expect(state.status).toBe('reopened');
    expect(state.question.reopenedBecause).toMatch(/changed/);
    expect(svc.pending(id).reopened.map((q) => q.id)).toContain('q-stateful-orders-api');
  });

  it('redacts secrets in free-text notes before they reach disk', () => {
    const svc = makeService();
    const { id } = svc.startSession(snapshot);
    svc.submit(
      id,
      [
        {
          questionId: 'q-lambda-source-orders-api',
          answer: choice(
            'git-repo',
            'https://x.example/r.git token=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
          ),
        },
      ],
      'interactive-user',
    );
    const sessionDir = join(dir, '.c2c', 'sessions', id);
    const written = readFileSync(join(sessionDir, 'decisions.jsonl'), 'utf8');
    expect(written).not.toMatch(/ghp_|abcdefghijklmnop/);
    expect(written).toContain('[REDACTED]');
    expect(svc.decisions(id).latest[0]!.redactions).toBeGreaterThan(0);
  });
});

describe('application-scoped sessions', () => {
  it('only asks questions that apply to the selected application', () => {
    const svc = makeService();
    const { id } = svc.startSession(snapshot, { applicationId: 'billing-handler' });
    const ids = svc.pending(id, { all: true }).questions.map((q) => q.id);
    expect(ids).toEqual(['q-shared-shared-events', 'q-lambda-source-billing-handler']);
  });

  it('rejects an unknown application and never picks one silently', () => {
    const svc = makeService();
    expect(() => svc.startSession(snapshot, { applicationId: 'nope' })).toThrow(/not found/);
  });
});

describe('workspace safety', () => {
  it('uses private permissions and keeps credentials out of the workspace', () => {
    const svc = makeService();
    const { id } = svc.startSession(snapshot);
    const sessionDir = join(dir, '.c2c', 'sessions', id);
    expect(statSync(join(dir, '.c2c')).mode & 0o777).toBe(0o700);
    expect(statSync(sessionDir).mode & 0o777).toBe(0o700);
    for (const file of readdirSync(sessionDir))
      expect(statSync(join(sessionDir, file)).mode & 0o777).toBe(0o600);
    const all = readdirSync(sessionDir)
      .map((f) => readFileSync(join(sessionDir, f), 'utf8'))
      .join('\n');
    expect(all).not.toMatch(/AKIA|aws_secret|BEGIN .*PRIVATE KEY/);
  });

  it('rejects path-traversal session IDs', () => {
    const store = new WorkspaceStore(dir);
    expect(() => store.loadSession('../../etc')).toThrow(/Invalid session ID/);
    expect(() => store.loadSession('a/b')).toThrow(/Invalid session ID/);
  });

  it('reports a clear error for a missing session', () => {
    expect(() => makeService().status('sess-nope')).toThrow(/not found/);
  });
});
