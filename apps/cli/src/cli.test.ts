import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Answer, ReconstructionQuestion } from '@cloud-to-code/core';
import {
  CANARY_SECRETS,
  buildHostileOrdersSnapshot,
  buildServerlessOrdersSnapshot,
} from '@cloud-to-code/testing';
import { inspectSnapshot } from '@cloud-to-code/reconstruction';
import { ExitCode, main, type Prompter } from './index.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c2c-cli-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  json: () => any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

async function run(args: string[], options: { prompter?: Prompter } = {}): Promise<RunResult> {
  let stdout = '';
  let stderr = '';
  const code = await main([...args, '--dir', dir], {
    stdout: (t) => void (stdout += t),
    stderr: (t) => void (stderr += t),
    cwd: dir,
    env: {},
    interactive: options.prompter !== undefined,
    ...(options.prompter ? { prompter: options.prompter } : {}),
  });
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
}

/** Scripted terminal: answers by question ID; anything unlisted is skipped. */
function scripted(script: Record<string, Answer>): Prompter & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async ask(q: ReconstructionQuestion) {
      asked.push(q.id);
      return script[q.id];
    },
    async confirm() {
      return false;
    },
    async chooseApplication(names) {
      return names.find((n) => n === 'orders-api');
    },
  };
}

describe('demo and inspect (offline)', () => {
  it('demo --json prints only JSON on stdout', async () => {
    const r = await run(['demo', '--json']);
    expect(r.code).toBe(ExitCode.OK);
    const out = r.json();
    expect(out.status).toBe('OK');
    expect(out.report.candidates.map((c: { name: string }) => c.name)).toEqual([
      'billing-handler',
      'orders-api',
    ]);
    expect(r.stdout.trim().startsWith('{')).toBe(true);
  });

  describe('inspection colors', () => {
    async function renderInspectionWithTerminal(tty: boolean, noColor: boolean): Promise<string> {
      const originalTTY = process.stdout.isTTY;
      const originalNoColor = process.env.NO_COLOR;
      Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: tty });
      if (noColor) process.env.NO_COLOR = '1';
      else delete process.env.NO_COLOR;
      vi.resetModules();
      const { renderInspection } = await import('./render.js');
      const output = renderInspection(inspectSnapshot(buildServerlessOrdersSnapshot()));
      Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: originalTTY });
      if (originalNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = originalNoColor;
      return output;
    }

    it('uses ANSI colors in a TTY without NO_COLOR', async () => {
      const output = await renderInspectionWithTerminal(true, false);
      expect(output).toContain('\x1b[32m');
    });

    it('does not use ANSI colors when NO_COLOR is set', async () => {
      const output = await renderInspectionWithTerminal(true, true);
      expect(output).not.toContain('\x1b[');
    });

    it('does not use ANSI colors outside a TTY', async () => {
      const output = await renderInspectionWithTerminal(false, false);
      expect(output).not.toContain('\x1b[');
    });
  });

  it('inspect --demo explains uncertainty and limitations', async () => {
    const r = await run(['inspect', '--demo']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Shared resources (ownership needs your decision)');
    expect(r.stdout).toContain('permission only, not proof of use');
    expect(r.stdout).toContain('Open questions: 1 blocking');
    expect(r.stdout).toContain('never collected');
  });

  it('inspect --format mermaid prints a Mermaid flowchart', async () => {
    const r = await run(['inspect', '--demo', '--format', 'mermaid']);
    expect(r.stdout.startsWith('flowchart LR')).toBe(true);
  });

  it('rejects unknown applications and missing sources with exit 2', async () => {
    const bad = await run(['inspect', 'nope', '--demo']);
    expect(bad.code).toBe(ExitCode.USAGE);
    expect(bad.stderr).toContain('not found');
    const none = await run(['inspect']);
    expect(none.code).toBe(ExitCode.USAGE);
    expect(none.stderr).toContain('hint:');
  });

  it('JSON errors are machine readable', async () => {
    const r = await run(['inspect', '--json']);
    expect(r.code).toBe(ExitCode.USAGE);
    expect(r.json()).toMatchObject({ status: 'FAILED', error: { code: 'no-source' } });
  });

  it('unknown commands exit 2', async () => {
    expect((await run(['frobnicate'])).code).toBe(ExitCode.USAGE);
  });
});

describe('non-interactive reconstruction', () => {
  it('returns NEEDS_INPUT (exit 10) with structured questions and never waits', async () => {
    const r = await run(['reconstruct', 'orders-api', '--demo', '--non-interactive', '--json']);
    expect(r.code).toBe(ExitCode.NEEDS_INPUT);
    const out = r.json();
    expect(out.status).toBe('NEEDS_INPUT');
    expect(out.session.blocking).toEqual(['q-shared-shared-events']);
    expect(out.questions[0]).toMatchObject({
      id: 'q-shared-shared-events',
      priority: 'blocking',
      suggestedOptionId: 'reference',
    });
    expect(out.questions[0].options.length).toBeGreaterThanOrEqual(3);
    expect(out.plan).toBeUndefined();
    expect(r.stderr).toContain('Session sess-');
  });

  it('answer + resume builds a verified plan and does not repeat the answered question', async () => {
    const first = await run(['reconstruct', 'orders-api', '--demo', '--json']);
    const sessionId = first.json().session.sessionId as string;

    const answered = await run([
      'answer',
      'q-shared-shared-events',
      'reference',
      '--session',
      sessionId,
      '--json',
    ]);
    expect(answered.code).toBe(0);
    expect(answered.json().accepted).toHaveLength(1);

    const resumed = await run(['resume', '--session', sessionId, '--json']);
    expect(resumed.code).toBe(ExitCode.OK);
    const out = resumed.json();
    expect(out.status).toBe('OK');
    expect(out.session.state).toBe('READY_FOR_REVIEW');
    expect(out.plan.boundaries.referenced).toHaveLength(1);
    expect(out.questions.map((q: { id: string }) => q.id)).not.toContain('q-shared-shared-events');

    const decisions = await run(['decisions', '--session', sessionId, '--json']);
    expect(decisions.json().latest[0]).toMatchObject({
      questionId: 'q-shared-shared-events',
      source: 'interactive-user',
    });
  });

  it('applies an --answers file with provenance and rejects invalid entries', async () => {
    const file = join(dir, 'answers.json');
    writeFileSync(file, JSON.stringify({ 'q-shared-shared-events': 'reference', 'q-bogus': 'x' }));
    const r = await run(['reconstruct', 'orders-api', '--demo', '--answers', file, '--json']);
    expect(r.code).toBe(ExitCode.OK);
    const out = r.json();
    expect(out.rejected).toEqual([expect.objectContaining({ questionId: 'q-bogus' })]);
    const sessionId = out.session.sessionId;
    const { latest } = (await run(['decisions', '--session', sessionId, '--json'])).json();
    expect(latest[0].source).toBe('answers-file');
  });

  it('an "unknown" answer to a blocking question ends BLOCKED (exit 11) and builds no plan', async () => {
    const first = await run(['reconstruct', 'orders-api', '--demo', '--json']);
    const sessionId = first.json().session.sessionId;
    const r = await run([
      'answer',
      'q-shared-shared-events',
      '--unknown',
      '--session',
      sessionId,
      '--json',
    ]);
    expect(r.json().session.state).toBe('BLOCKED');
    const resumed = await run(['resume', '--session', sessionId, '--json']);
    expect(resumed.code).toBe(ExitCode.BLOCKED);
    expect(resumed.json()).toMatchObject({ status: 'BLOCKED' });
    expect(resumed.json().plan).toBeUndefined();
  });

  it('rejects an invalid option without recording anything (exit 2)', async () => {
    const first = await run(['reconstruct', 'orders-api', '--demo', '--json']);
    const sessionId = first.json().session.sessionId;
    const r = await run([
      'answer',
      'q-shared-shared-events',
      'deploy-now',
      '--session',
      sessionId,
      '--json',
    ]);
    expect(r.code).toBe(ExitCode.USAGE);
    expect(r.json().rejected[0].error).toContain('Unknown option');
    expect((await run(['decisions', '--session', sessionId, '--json'])).json().history).toEqual([]);
  });

  it('requires choosing an application when several candidates exist', async () => {
    const r = await run(['reconstruct', '--demo', '--non-interactive']);
    expect(r.code).toBe(ExitCode.USAGE);
    expect(r.stderr).toContain('Several application candidates');
  });

  it('rejects unimplemented strategies instead of silently downgrading', async () => {
    const r = await run([
      'reconstruct',
      'orders-api',
      '--demo',
      '--strategy',
      'faithful',
      '--answers',
      writeAnswers(),
      '--json',
    ]);
    expect(r.code).toBe(ExitCode.FAILED);
    expect(r.json().issues[0].message).toContain('not implemented');
  });
});

function writeAnswers(): string {
  const file = join(dir, 'a.json');
  writeFileSync(file, JSON.stringify({ 'q-shared-shared-events': 'reference' }));
  return file;
}

describe('interactive reconstruction (scripted terminal)', () => {
  it('asks questions through the prompter, records them and builds the plan', async () => {
    const prompter = scripted({
      'q-shared-shared-events': { kind: 'choice', optionId: 'reference' },
      'q-lambda-source-orders-api': { kind: 'choice', optionId: 'infra-only' },
      'q-stateful-orders-api': { kind: 'choice', optionId: 'recreate-retain' },
      'q-possible-access-orders-handler-orders-table': {
        kind: 'choice',
        optionId: 'document-as-possible',
      },
    });
    const r = await run(['reconstruct', 'orders-api', '--demo'], { prompter });
    expect(r.code).toBe(ExitCode.OK);
    expect(prompter.asked.sort()).toEqual([
      'q-lambda-source-orders-api',
      'q-possible-access-orders-handler-orders-table',
      'q-shared-shared-events',
      'q-stateful-orders-api',
    ]);
    expect(r.stdout).toContain('READY_FOR_REVIEW');
    expect(r.stdout).toContain('No AWS resources were modified');
  });

  it('skipping a blocking question yields NEEDS_INPUT instead of a guess', async () => {
    const prompter = scripted({});
    const r = await run(['reconstruct', 'orders-api', '--demo'], { prompter });
    expect(r.code).toBe(ExitCode.NEEDS_INPUT);
    expect(r.stdout).toContain('NEEDS_INPUT');
  });

  it('--json suppresses prompts even on a terminal', async () => {
    const prompter = scripted({
      'q-shared-shared-events': { kind: 'choice', optionId: 'reference' },
    });
    const r = await run(['reconstruct', 'orders-api', '--demo', '--json'], { prompter });
    expect(prompter.asked).toEqual([]);
    expect(r.code).toBe(ExitCode.NEEDS_INPUT);
  });
});

describe('untrusted and sensitive input', () => {
  it('redacts canary secrets from a user-supplied snapshot before they reach the workspace', async () => {
    const file = join(dir, 'hostile.json');
    writeFileSync(file, JSON.stringify(buildHostileOrdersSnapshot()));
    const r = await run(['reconstruct', 'orders-api', '--snapshot', file, '--json']);
    expect(r.json().session.sessionId).toMatch(/^sess-/);
    const root = join(dir, '.c2c');
    const files = readdirSync(join(root, 'sessions'), {
      recursive: true,
      withFileTypes: true,
    }).filter((e) => e.isFile());
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const text = readFileSync(join(f.parentPath, f.name), 'utf8');
      for (const canary of CANARY_SECRETS) expect(text).not.toContain(canary);
    }
    expect(r.stderr).toContain('redacted');
  });

  it('prompt injection in tags cannot answer questions or change the outcome', async () => {
    const file = join(dir, 'hostile.json');
    writeFileSync(file, JSON.stringify(buildHostileOrdersSnapshot()));
    const r = await run(['reconstruct', 'orders-api', '--snapshot', file, '--json']);
    expect(r.code).toBe(ExitCode.NEEDS_INPUT);
    const sessionId = r.json().session.sessionId;
    expect((await run(['decisions', '--session', sessionId, '--json'])).json().history).toEqual([]);
  });

  it('rejects malformed and non-snapshot files', async () => {
    const file = join(dir, 'bad.json');
    writeFileSync(file, '{"schemaVersion":"1"}');
    const r = await run(['inspect', '--snapshot', file]);
    expect(r.code).toBe(ExitCode.USAGE);
    expect(r.stderr).toContain('Invalid snapshot');
  });

  it('reads a clean snapshot file the same way as the demo', async () => {
    const file = join(dir, 'orders.json');
    writeFileSync(file, JSON.stringify(buildServerlessOrdersSnapshot()));
    const a = (await run(['inspect', '--snapshot', file, '--json'])).json();
    const b = (await run(['inspect', '--demo', '--json'])).json();
    expect(a.report).toEqual(b.report);
  });
});
