import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExitCode, main } from './index.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c2c-gen-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function run(args: string[]) {
  let stdout = '';
  let stderr = '';
  const code = await main([...args, '--dir', dir], {
    stdout: (t) => void (stdout += t),
    stderr: (t) => void (stderr += t),
    cwd: dir,
    env: {},
    interactive: false,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { code, stdout, stderr, json: (): any => JSON.parse(stdout) };
}

function answers(extra: Record<string, unknown> = {}): string {
  const file = join(dir, 'answers.json');
  writeFileSync(
    file,
    JSON.stringify({
      'q-shared-shared-events': 'reference',
      'q-lambda-source-orders-api': 'infra-only',
      ...extra,
    }),
  );
  return file;
}

describe('reconstruct --output (offline end to end)', () => {
  it('answers file -> verified plan -> CDK project -> local checks, with no AWS and no AI', async () => {
    const out = join(dir, 'orders-api');
    const r = await run([
      'reconstruct',
      'orders-api',
      '--demo',
      '--answers',
      answers(),
      '--output',
      out,
      '--json',
    ]);
    expect(r.code).toBe(ExitCode.OK);
    const body = r.json();
    expect(body.status).toBe('OK');
    expect(body.session.state).toBe('COMPLETED');
    expect(body.files).toEqual(
      expect.arrayContaining([
        'bin/app.ts',
        'lib/stacks/orders-api-stack.ts',
        'reports/coverage.json',
      ]),
    );
    expect(body.unresolved.length).toBeGreaterThan(0);
    expect(body.validation.checks.find((c: { id: string }) => c.id === 'manifest').status).toBe(
      'pass',
    );
    expect(existsSync(join(out, '.c2c', 'manifest.json'))).toBe(true);
    expect(readFileSync(join(out, 'README.md'), 'utf8')).toMatch(/not verified for deployment/);
  });

  it('generates nothing and exits NEEDS_INPUT while a blocking question is unanswered', async () => {
    const out = join(dir, 'never');
    const r = await run(['reconstruct', 'orders-api', '--demo', '--output', out, '--json']);
    expect(r.code).toBe(ExitCode.NEEDS_INPUT);
    expect(existsSync(out)).toBe(false);
  });

  it('`generate` works on an existing session after answers are recorded', async () => {
    const first = await run(['reconstruct', 'orders-api', '--demo', '--json']);
    const sessionId = first.json().session.sessionId as string;
    await run(['answer', 'q-shared-shared-events', 'reference', '--session', sessionId]);
    const out = join(dir, 'gen');
    const r = await run(['generate', '--output', out, '--session', sessionId, '--json']);
    expect(r.code).toBe(ExitCode.OK);
    expect(existsSync(join(out, 'lib', 'constructs', 'compute.ts'))).toBe(true);
  });

  it('never writes into a non-empty directory without --overwrite', async () => {
    const out = join(dir, 'taken');
    mkdirSync(out);
    writeFileSync(join(out, 'mine.txt'), 'important');
    const refused = await run([
      'reconstruct',
      'orders-api',
      '--demo',
      '--answers',
      answers(),
      '--output',
      out,
    ]);
    expect(refused.code).toBe(ExitCode.USAGE);
    expect(refused.stderr).toContain('not empty');
    expect(refused.stderr).toContain('--overwrite');
    expect(readFileSync(join(out, 'mine.txt'), 'utf8')).toBe('important');
    expect(existsSync(join(out, 'bin'))).toBe(false);
  });

  it('requires --output for generate', async () => {
    const r = await run(['generate']);
    expect(r.code).toBe(ExitCode.USAGE);
  });
});

describe('validate and adoption plan', () => {
  async function project(): Promise<string> {
    const out = join(dir, 'proj');
    await run([
      'reconstruct',
      'orders-api',
      '--demo',
      '--answers',
      answers(),
      '--output',
      out,
      '--json',
    ]);
    return out;
  }

  it('validate reports checks and always states the limits of synthesis', async () => {
    const out = await project();
    const r = await run(['validate', out, '--no-typecheck', '--json']);
    expect(r.code).toBe(ExitCode.OK);
    const body = r.json();
    expect(body.report.checks.map((c: { id: string }) => c.id)).toEqual([
      'structure',
      'manifest',
      'coverage',
      'synth',
    ]);
    expect(body.report.notice).toMatch(/does NOT prove/);
    const human = await run(['validate', out, '--no-typecheck']);
    expect(human.stdout).toContain('Residual risks');
  });

  it('validate fails with exit 1 for a broken project and exit 2 for a missing directory', async () => {
    const out = await project();
    rmSync(join(out, 'cdk.json'));
    expect((await run(['validate', out, '--no-typecheck'])).code).toBe(ExitCode.FAILED);
    expect((await run(['validate', join(dir, 'missing')])).code).toBe(ExitCode.USAGE);
  });

  it('adoption plan is advisory and highlights stateful resources', async () => {
    const out = await project();
    const r = await run(['adoption', 'plan', out]);
    expect(r.code).toBe(ExitCode.OK);
    expect(r.stdout).toContain('ADVISORY ONLY');
    expect(r.stdout).toContain('STATEFUL');
    expect(r.stdout).toContain('never applies changes');
  });
});
