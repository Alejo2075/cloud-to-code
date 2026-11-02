import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DeveloperDecision } from '@cloud-to-code/core';
import { generateProject, writeProject } from '@cloud-to-code/generator-cdk';
import { buildPlan } from '@cloud-to-code/reconstruction';
import { buildServerlessOrdersSnapshot } from '@cloud-to-code/testing';
import { adoptionPlan, scrubbedEnv, validateProject } from './index.js';

const tmpRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '.tmp');
const snapshot = buildServerlessOrdersSnapshot();
const decision = (questionId: string, optionId: string, id: string): DeveloperDecision => ({
  id,
  questionId,
  sessionId: 's',
  answer: { kind: 'choice', optionId },
  source: 'interactive-user',
  recordedAt: '2026-02-01T10:00:00Z',
  subjectHash: 'h',
  redactions: 0,
});
const decisions = [decision('q-shared-shared-events', 'reference', 'dec-1')];

function fresh(name: string): string {
  const dir = join(tmpRoot, name);
  rmSync(dir, { recursive: true, force: true });
  const plan = buildPlan({
    snapshot,
    decisions,
    strategy: 'balanced',
    applicationId: 'orders-api',
  });
  writeProject(dir, generateProject({ snapshot, plan, decisions }).files);
  return dir;
}

const byId = (report: Awaited<ReturnType<typeof validateProject>>, id: string) =>
  report.checks.find((c) => c.id === id)!;

beforeAll(() => mkdirSync(tmpRoot, { recursive: true }));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

describe('validateProject', () => {
  it('passes structure and manifest, warns about unresolved items, compiles, and skips synth by default', async () => {
    const report = await validateProject(fresh('ok'));
    expect(byId(report, 'structure').status).toBe('pass');
    expect(byId(report, 'manifest').status).toBe('pass');
    expect(byId(report, 'coverage').status).toBe('warn');
    expect(byId(report, 'typecheck')).toMatchObject({ status: 'pass' });
    expect(byId(report, 'synth')).toMatchObject({ status: 'skipped' });
    expect(report.summary).toBe('passed-with-warnings');
    expect(report.notice).toMatch(/does NOT prove/);
    expect(report.residualRisks.join(' ')).toMatch(/empty/);
  }, 120_000);

  it('fails when required files are missing', async () => {
    const dir = fresh('missing');
    rmSync(join(dir, 'cdk.json'));
    const report = await validateProject(dir, { typecheck: false });
    expect(byId(report, 'structure').status).toBe('fail');
    expect(report.summary).toBe('failed');
  });

  it('reports hand edits as warnings and compile errors as failures', async () => {
    const dir = fresh('edited');
    const file = join(dir, 'lib', 'constructs', 'data.ts');
    writeFileSync(file, `${readFileSync(file, 'utf8')}\nconst broken: number = 'not a number';\n`);
    const report = await validateProject(dir);
    expect(byId(report, 'manifest')).toMatchObject({ status: 'warn' });
    expect(byId(report, 'manifest').detail).toContain('lib/constructs/data.ts');
    expect(byId(report, 'typecheck').status).toBe('fail');
    expect(byId(report, 'typecheck').detail).toMatch(/not assignable|TS2322/);
    expect(report.summary).toBe('failed');
  }, 120_000);

  it('detects deleted generated files', async () => {
    const dir = fresh('deleted');
    rmSync(join(dir, 'lib', 'constructs', 'api.ts'));
    const report = await validateProject(dir, { typecheck: false });
    expect(byId(report, 'manifest').status).toBe('fail');
  });

  it('rejects non-directories', async () => {
    await expect(validateProject(join(tmpRoot, 'nope'))).rejects.toThrow(/not a directory/);
  });
});

describe('controlled synth', () => {
  function installFakeCdk(dir: string): string {
    const bin = join(dir, 'node_modules', '.bin');
    mkdirSync(bin, { recursive: true });
    const marker = join(dir, 'env-dump.json');
    writeFileSync(
      join(bin, 'cdk'),
      `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ env: process.env, argv: process.argv.slice(2) }));\n`,
    );
    chmodSync(join(bin, 'cdk'), 0o755);
    return marker;
  }

  it('runs the project-local cdk with credentials scrubbed from its environment', async () => {
    const dir = fresh('synth-ok');
    const marker = installFakeCdk(dir);
    process.env['AWS_SECRET_ACCESS_KEY'] = 'canary-secret';
    process.env['AWS_PROFILE'] = 'canary-profile';
    try {
      const report = await validateProject(dir, { synth: true, typecheck: false });
      expect(byId(report, 'synth').status).toBe('pass');
      const dump = JSON.parse(readFileSync(marker, 'utf8')) as {
        env: Record<string, string>;
        argv: string[];
      };
      expect(dump.argv[0]).toBe('synth');
      expect(
        Object.keys(dump.env)
          .filter((k) => k.startsWith('AWS_'))
          .sort(),
      ).toEqual(['AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE']);
      expect(JSON.stringify(dump)).not.toContain('canary');
    } finally {
      delete process.env['AWS_SECRET_ACCESS_KEY'];
      delete process.env['AWS_PROFILE'];
    }
  });

  it('refuses to execute code that differs from what was generated unless trusted', async () => {
    const dir = fresh('synth-modified');
    const marker = installFakeCdk(dir);
    writeFileSync(
      join(dir, 'bin', 'app.ts'),
      `${readFileSync(join(dir, 'bin', 'app.ts'), 'utf8')}\n// edited\n`,
    );
    const refused = await validateProject(dir, { synth: true, typecheck: false });
    expect(byId(refused, 'synth').status).toBe('skipped');
    expect(byId(refused, 'synth').detail).toMatch(/Refusing to execute/);
    expect(existsSync(marker)).toBe(false);
    const trusted = await validateProject(dir, { synth: true, trust: true, typecheck: false });
    expect(byId(trusted, 'synth').status).toBe('pass');
  });

  it('fails closed: a missing or unreadable manifest also blocks synth unless trusted', async () => {
    const dir = fresh('synth-nomanifest');
    const marker = installFakeCdk(dir);
    rmSync(join(dir, '.c2c', 'manifest.json'));
    const report = await validateProject(dir, { synth: true, typecheck: false });
    expect(byId(report, 'synth').status).toBe('skipped');
    expect(byId(report, 'synth').detail).toMatch(/Refusing to execute/);
    expect(existsSync(marker)).toBe(false);
  });

  it('gives the synth child a throwaway HOME and null credential files', async () => {
    const dir = fresh('synth-home');
    const marker = installFakeCdk(dir);
    await validateProject(dir, { synth: true, typecheck: false });
    const dump = JSON.parse(readFileSync(marker, 'utf8')) as { env: Record<string, string> };
    expect(dump.env['HOME']).toMatch(/c2c-home-/);
    expect(dump.env['HOME']).not.toBe(process.env['HOME']);
    expect(dump.env['AWS_SHARED_CREDENTIALS_FILE']).toBe('/dev/null');
  });

  it('fails closed: a missing manifest also blocks synth unless trusted', async () => {
    const dir = fresh('synth-nomanifest');
    const marker = installFakeCdk(dir);
    rmSync(join(dir, '.c2c', 'manifest.json'));
    const report = await validateProject(dir, { synth: true, typecheck: false });
    expect(byId(report, 'synth').status).toBe('skipped');
    expect(byId(report, 'synth').detail).toMatch(/Refusing to execute/);
    expect(existsSync(marker)).toBe(false);
  });

  it('gives the synth child a throwaway HOME and null credential files', async () => {
    const dir = fresh('synth-home');
    const marker = installFakeCdk(dir);
    await validateProject(dir, { synth: true, typecheck: false });
    const dump = JSON.parse(readFileSync(marker, 'utf8')) as { env: Record<string, string> };
    expect(dump.env['HOME']).toMatch(/c2c-home-/);
    expect(dump.env['HOME']).not.toBe(process.env['HOME']);
    expect(dump.env['AWS_SHARED_CREDENTIALS_FILE']).toBe('/dev/null');
  });

  it('skips with guidance when dependencies are not installed, and never installs anything', async () => {
    const dir = fresh('synth-nodeps');
    const report = await validateProject(dir, { synth: true, typecheck: false });
    expect(byId(report, 'synth')).toMatchObject({ status: 'skipped' });
    expect(byId(report, 'synth').detail).toMatch(/npm install/);
    expect(existsSync(join(dir, 'node_modules'))).toBe(false);
  });

  it('scrubs the environment', () => {
    const env = scrubbedEnv(
      { PATH: '/bin', AWS_ACCESS_KEY_ID: 'x', GITHUB_TOKEN: 'y', HOME: '/h' },
      '/fake-home',
    );
    expect(env).toMatchObject({
      PATH: '/bin',
      HOME: '/fake-home',
      USERPROFILE: '/fake-home',
      CI: 'true',
    });
    expect(env['AWS_SHARED_CREDENTIALS_FILE']).toBe('/dev/null');
    expect(env['AWS_CONFIG_FILE']).toBe('/dev/null');
    expect(Object.keys(env)).not.toContain('AWS_ACCESS_KEY_ID');
    expect(Object.keys(env)).not.toContain('GITHUB_TOKEN');
  });
});

describe('adoptionPlan', () => {
  it('is advisory, flags stateful resources and never mentions running an import', () => {
    const plan = adoptionPlan(fresh('adopt'));
    expect(plan.mode).toBe('advisory');
    expect(plan.resources.some((r) => r.stateful && r.type === 'AWS::DynamoDB::Table')).toBe(true);
    expect(plan.referenced.some((r) => r.endsWith('shared-events'))).toBe(true);
    expect(plan.warnings.join(' ')).toMatch(/Stateful/);
    expect(plan.manualSteps.join(' ')).toMatch(/never applies changes/);
    expect(JSON.stringify(plan)).not.toMatch(/cdk import --/);
  });

  it('requires a generated project', () => {
    expect(() => adoptionPlan(join(tmpRoot, 'absent'))).toThrow(/not found/);
  });
});
