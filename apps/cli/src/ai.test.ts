import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeProvider } from '@cloud-to-code/ai';
import { buildPlan } from '@cloud-to-code/reconstruction';
import { buildServerlessOrdersSnapshot } from '@cloud-to-code/testing';
import { ExitCode, main, type Prompter } from './index.js';

let dir: string;
let cfg: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c2c-ai-'));
  cfg = mkdtempSync(join(tmpdir(), 'c2c-aicfg-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(cfg, { recursive: true, force: true });
});

const snapshot = buildServerlessOrdersSnapshot();
const handlerId = snapshot.resources.find((r) => r.physicalId === 'orders-handler')!.id;
const decisions = [
  {
    id: 'x',
    questionId: 'q-shared-shared-events',
    sessionId: 's',
    answer: { kind: 'choice' as const, optionId: 'reference' },
    source: 'interactive-user' as const,
    recordedAt: '2026-01-01T00:00:00Z',
    subjectHash: 'h',
    redactions: 0,
  },
];
void buildPlan;
void decisions;

const reply = JSON.stringify({
  summary: 'Orders API.',
  components: [{ resourceId: handlerId, purpose: 'Handles requests' }],
  risks: ['shared bus'],
  suggestedQuestions: [],
});

async function run(args: string[], extra: { provider?: FakeProvider; prompter?: Prompter } = {}) {
  let stdout = '';
  let stderr = '';
  const code = await main([...args, '--dir', dir], {
    stdout: (t) => void (stdout += t),
    stderr: (t) => void (stderr += t),
    cwd: dir,
    env: { C2C_CONFIG_DIR: cfg },
    interactive: extra.prompter !== undefined,
    ...(extra.prompter ? { prompter: extra.prompter } : {}),
    ...(extra.provider ? { aiProvider: extra.provider } : {}),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { code, stdout, stderr, json: (): any => JSON.parse(stdout) };
}

function answers(): string {
  const f = join(dir, 'a.json');
  writeFileSync(f, JSON.stringify({ 'q-shared-shared-events': 'reference' }));
  return f;
}

describe('c2c ai', () => {
  it('connect stores no secrets and requires an explicit model', async () => {
    expect((await run(['ai', 'connect', '--provider', 'anthropic'])).code).toBe(ExitCode.USAGE);
    const ok = await run(['ai', 'connect', '--provider', 'anthropic', '--model', 'some-model']);
    expect(ok.code).toBe(0);
    expect(readFileSync(join(cfg, 'config.yaml'), 'utf8')).not.toMatch(
      /sk-[A-Za-z0-9]{10,}|api[_-]?key:/i,
    );
    expect(ok.stdout).toContain('ANTHROPIC_API_KEY');
  });

  it('is clearly unavailable until configured, while deterministic workflows keep working', async () => {
    const r = await run(['ai', 'test']);
    expect(r.code).toBe(ExitCode.USAGE);
    expect(r.stderr).toContain('Deterministic workflows keep working');
    const det = await run([
      'reconstruct',
      'orders-api',
      '--demo',
      '--answers',
      answers(),
      '--output',
      join(dir, 'out'),
      '--json',
    ]);
    expect(det.code).toBe(0);
  });

  it('ai test sends a fixed prompt with no inventory data', async () => {
    const p = new FakeProvider(() => 'ok');
    const r = await run(['ai', 'test', '--json'], { provider: p });
    expect(r.code).toBe(0);
    expect(p.requests[0]!.user).not.toMatch(/orders|AWS::/);
  });

  it('ai preview shows what would be sent and sends nothing', async () => {
    const p = new FakeProvider(() => 'ok');
    const r = await run(['ai', 'preview', '--demo', '--show-data', '--json'], { provider: p });
    const body = r.json();
    expect(body.excluded.join(' ')).toMatch(/environment values/);
    expect(body.data).toContain('orders-handler');
    expect(p.requests).toEqual([]);
  });
});

describe('reconstruct --ai', () => {
  const base = () => [
    'reconstruct',
    'orders-api',
    '--demo',
    '--answers',
    answers(),
    '--ai',
    '--json',
  ];

  it('without consent: exit 12, nothing sent, nothing generated', async () => {
    const p = new FakeProvider(() => reply);
    const out = join(dir, 'out');
    const r = await run([...base(), '--output', out], { provider: p });
    expect(r.code).toBe(ExitCode.CONSENT_REQUIRED);
    expect(p.requests).toEqual([]);
    expect(existsSync(out)).toBe(false);
    expect(r.json().error.code).toBe('consent-required');
  });

  it('with explicit consent: writes labeled hypotheses and still generates from the deterministic plan', async () => {
    const p = new FakeProvider((req) =>
      /Propose a reconstruction plan/.test(req.user) ? 'not a plan' : reply,
    );
    const out = join(dir, 'out');
    const r = await run([...base(), '--output', out, '--allow-external-model'], { provider: p });
    expect(r.code).toBe(0);
    const md = readFileSync(join(out, 'reports', 'ai-interpretation.md'), 'utf8');
    expect(md).toContain('unverified hypotheses');
    expect(md).toContain('Nothing here is evidence');
    expect(md).toContain('rejected by the verifier');
    expect(existsSync(join(out, 'lib', 'stacks', 'orders-api-stack.ts'))).toBe(true);
  });

  it('a local provider needs no external consent', async () => {
    const p = new FakeProvider(() => reply, {
      provider: 'Local',
      endpoint: 'http://localhost:11434',
      local: true,
    });
    const r = await run([...base(), '--output', join(dir, 'out')], { provider: p });
    expect(r.code).toBe(0);
    expect(p.requests.length).toBeGreaterThan(0);
  });

  it('honors the never policy', async () => {
    await run(['init', '--external-model-context', 'never']);
    const p = new FakeProvider(() => reply);
    const r = await run([...base(), '--output', join(dir, 'out'), '--allow-external-model'], {
      provider: p,
    });
    expect(r.code).toBe(ExitCode.CONSENT_REQUIRED);
    expect(p.requests).toEqual([]);
  });

  it('asks interactively and defaults to no', async () => {
    const asked: string[] = [];
    const prompter: Prompter = {
      async ask() {
        return undefined;
      },
      async chooseApplication() {
        return 'orders-api';
      },
      async confirm(m) {
        asked.push(m);
        return false;
      },
    };
    const p = new FakeProvider(() => reply);
    const r = await run(
      [
        'reconstruct',
        'orders-api',
        '--demo',
        '--answers',
        answers(),
        '--ai',
        '--output',
        join(dir, 'out'),
      ],
      { provider: p, prompter },
    );
    expect(asked).toHaveLength(1);
    expect(p.requests).toEqual([]);
    expect(r.code).toBe(ExitCode.CONSENT_REQUIRED);
  });

  it('a provider failure never loses the deterministic result', async () => {
    const p = new FakeProvider(() => new Error('network down'));
    const out = join(dir, 'out');
    const r = await run([...base(), '--output', out, '--allow-external-model'], { provider: p });
    expect(r.code).toBe(0);
    expect(existsSync(join(out, 'reports', 'ai-interpretation.md'))).toBe(false);
    expect(r.stderr).toContain('untouched');
  });
});
