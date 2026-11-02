import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { buildPlan, computeQuestions, verifyPlan } from '@cloud-to-code/reconstruction';
import type { DeveloperDecision } from '@cloud-to-code/core';
import { buildServerlessOrdersSnapshot } from '@cloud-to-code/testing';
import {
  GenerationError,
  RUNTIME_CONSTANTS,
  buildExpectations,
  checkExpectations,
  generateProject,
  writeProject,
  GenContext,
} from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, '..');
const repoRoot = join(pkgDir, '..', '..');
const tmpRoot = join(pkgDir, '.tmp');
const snapshot = buildServerlessOrdersSnapshot();
const require = createRequire(import.meta.url);

let seq = 0;
const decision = (questionId: string, optionId: string, note?: string): DeveloperDecision => ({
  id: `dec-${++seq}`,
  questionId,
  sessionId: 's1',
  answer: { kind: 'choice', optionId, ...(note ? { note } : {}) },
  source: 'interactive-user',
  recordedAt: '2026-02-01T10:00:00Z',
  subjectHash: 'h',
  redactions: 0,
});

function project(decisions: DeveloperDecision[]) {
  const plan = buildPlan({
    snapshot,
    decisions,
    strategy: 'balanced',
    applicationId: 'orders-api',
  });
  const issues = verifyPlan(plan, { snapshot, decisions, blockingUnresolved: [] });
  expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
  return { plan, generated: generateProject({ snapshot, plan, decisions }) };
}

const base = [
  decision('q-shared-shared-events', 'reference'),
  decision('q-lambda-source-orders-api', 'infra-only'),
];

/** Compile the generated project with tsc and synthesize its stack in-process. */
function compileAndSynth(
  name: string,
  files: { path: string; content: string }[],
  stackFile: string,
  stackName: string,
) {
  const dir = join(tmpRoot, name);
  rmSync(dir, { recursive: true, force: true });
  writeProject(dir, files);
  const tsc = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
  try {
    execFileSync(process.execPath, [tsc, '-p', join(dir, 'tsconfig.json')], { stdio: 'pipe' });
  } catch (error) {
    const e = error as { stdout?: Buffer };
    throw new Error(
      `Generated project does not compile:\n${e.stdout?.toString() ?? String(error)}`,
      { cause: error },
    );
  }
  const mod = require(join(dir, 'dist', 'lib', 'stacks', `${stackFile}.js`)) as Record<
    string,
    new (scope: App, id: string) => never
  >;
  const Stack = mod[stackName]!;
  return Template.fromStack(new Stack(new App(), 'TestStack'));
}

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

describe('generateProject (balanced)', () => {
  const { plan, generated } = project(base);
  const paths = generated.files.map((f) => f.path);

  it('emits the documented project layout', () => {
    expect(paths).toEqual(
      expect.arrayContaining([
        'bin/app.ts',
        'lib/stacks/orders-api-stack.ts',
        'lib/constructs/references.ts',
        'lib/constructs/data.ts',
        'lib/constructs/messaging.ts',
        'lib/constructs/compute.ts',
        'lib/constructs/api.ts',
        'lib/constructs/events.ts',
        'src/README.md',
        'test/infrastructure.test.ts',
        '.c2c/manifest.json',
        'reports/architecture.md',
        'reports/reconstruction-decisions.md',
        'reports/coverage.json',
        'reports/migration-plan.md',
        'package.json',
        'tsconfig.json',
        'cdk.json',
        'README.md',
      ]),
    );
  });

  it('is deterministic: identical inputs give byte-identical files', () => {
    expect(generateProject({ snapshot, plan, decisions: base })).toEqual(generated);
  });

  it('contains no account IDs, regions or invented names in the infrastructure code', () => {
    for (const f of generated.files.filter(
      (x) => x.path.startsWith('lib/') || x.path.startsWith('bin/'),
    )) {
      expect(f.content).not.toContain('123456789012');
      expect(f.content).not.toContain('us-east-1');
      expect(f.content).not.toMatch(
        /tableName:|queueName:|bucketName:|roleName:|functionName:|eventBusName:/,
      );
    }
  });

  it('does not fabricate code locations or environment values', () => {
    const compute = generated.files.find((f) => f.path === 'lib/constructs/compute.ts')!.content;
    expect(compute).toContain('props.parameters.code');
    expect(compute).not.toMatch(/fromInline|fromAsset/);
    const stack = generated.files.find((f) => f.path === 'lib/stacks/orders-api-stack.ts')!.content;
    expect(stack).toContain("new cdk.CfnParameter(this, 'OrdersHandlerCodeBucket'");
    expect(stack).toContain('OrdersHandlerEnvTableName');
  });

  it('records provenance for every generated resource', () => {
    const manifest = JSON.parse(
      generated.files.find((f) => f.path === '.c2c/manifest.json')!.content,
    );
    expect(manifest.resources).toHaveLength(
      plan.boundaries.owned.length + plan.boundaries.referenced.length - 0,
    );
    for (const r of manifest.resources) {
      expect(r.evidenceIds.length).toBeGreaterThan(0);
      expect(r.ruleId).toMatch(/@1$/);
    }
    expect(manifest.files.every((f: { sha256: string }) => /^[0-9a-f]{64}$/.test(f.sha256))).toBe(
      true,
    );
  });

  it('reports coverage honestly, including properties it did not reproduce', () => {
    const coverage = JSON.parse(
      generated.files.find((f) => f.path === 'reports/coverage.json')!.content,
    );
    expect(coverage.summary.preserved).toBeGreaterThan(20);
    const handler = coverage.resources.find((r: { resourceId: string }) =>
      r.resourceId.endsWith('orders-handler'),
    );
    expect(
      handler.properties.find((p: { name: string }) => p.name === 'environmentVariableNames')
        .status,
    ).toBe('approximated');
    const bucket = coverage.resources.find((r: { resourceId: string }) =>
      r.resourceId.endsWith('orders-exports'),
    );
    expect(bucket.properties.find((p: { name: string }) => p.name === 'notifications').status).toBe(
      'preserved',
    );
    const table = coverage.resources.find((r: { resourceId: string }) =>
      r.resourceId.endsWith('orders-table'),
    );
    expect(table.properties.find((p: { name: string }) => p.name === 'tableName').status).toBe(
      'intentionally-omitted',
    );
    expect(coverage.notice).toMatch(/does not prove/);
  });

  it('migration plan separates synthesis from safety and warns about empty stateful resources', () => {
    const text = generated.files.find((f) => f.path === 'reports/migration-plan.md')!.content;
    expect(text).toMatch(/does \*\*not\*\* prove/);
    expect(text).toMatch(/recreated empty/);
    expect(text).toMatch(/Adoption analysis \(planning only\)/);
    expect(text).not.toMatch(/cdk import /);
  });

  it('preserves IAM statements and rewires owned ARNs to the new resources', () => {
    const compute = generated.files.find((f) => f.path === 'lib/constructs/compute.ts')!.content;
    expect(compute).toContain('dynamodb:GetItem');
    expect(compute).toContain("props.data.tables['orders-table'].tableArn");
    expect(compute).toContain('mutable: false');
  });

  it('compiles and synthesizes, matching the observed configuration', () => {
    const template = compileAndSynth('base', generated.files, 'orders-api-stack', 'OrdersApiStack');
    checkExpectations(template, Match, buildExpectations(new GenContext(snapshot, plan)));
    // The shared bus is only referenced, never created; stateful resources are retained.
    template.resourceCountIs('AWS::Events::EventBus', 0);
    template.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Retain' });
    // The immutable role view means CDK added no statements beyond the observed policies.
    const roles = template.findResources('AWS::IAM::Role');
    const orders = Object.values(roles).find((r) =>
      JSON.stringify(r).includes('dynamodb:GetItem'),
    )!;
    expect(JSON.stringify(orders)).toContain('orders-access');
  }, 180_000);
});

describe('ownership variants', () => {
  it('references stateful resources instead of creating them when the developer chooses so', () => {
    const { plan, generated } = project([
      ...base,
      decision('q-stateful-orders-api', 'reference-existing'),
    ]);
    const references = generated.files.find(
      (f) => f.path === 'lib/constructs/references.ts',
    )!.content;
    expect(references).toContain('Table.fromTableAttributes');
    expect(references).toContain('Queue.fromQueueArn');
    expect(references).toContain('Bucket.fromBucketArn');
    expect(references).not.toMatch(/tableName|123456789012/);
    const template = compileAndSynth(
      'referenced',
      generated.files,
      'orders-api-stack',
      'OrdersApiStack',
    );
    template.resourceCountIs('AWS::DynamoDB::Table', 0);
    template.resourceCountIs('AWS::SQS::Queue', 0);
    template.resourceCountIs('AWS::S3::Bucket', 0);
    checkExpectations(template, Match, buildExpectations(new GenContext(snapshot, plan)));
    // Referenced buckets are never reconfigured: their notification is left alone and reported.
    const cov = JSON.parse(
      generated.files.find((f) => f.path === 'reports/coverage.json')!.content,
    );
    expect(
      cov.unresolved.some((u: { property: string }) => u.property.startsWith('notifications')),
    ).toBe(true);
  }, 180_000);

  it('owning the bus creates it', () => {
    const q = computeQuestions(snapshot, 's').find((x) => x.id === 'q-shared-shared-events')!;
    const ownsId = q.options!.find((o) => o.label === 'Include it in orders-api')!.id;
    const { generated } = project([
      decision('q-shared-shared-events', ownsId),
      decision('q-lambda-source-orders-api', 'infra-only'),
    ]);
    const messaging = generated.files.find(
      (f) => f.path === 'lib/constructs/messaging.ts',
    )!.content;
    expect(messaging).toContain('new events.EventBus');
  });
});

describe('safety', () => {
  const { generated, plan } = project(base);

  it('refuses to write into a non-empty directory unless explicitly told to', () => {
    const dir = join(tmpRoot, 'nonempty');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'keep.txt'), 'user file');
    expect(() => writeProject(dir, generated.files)).toThrow(/not empty/);
    expect(readFileSync(join(dir, 'keep.txt'), 'utf8')).toBe('user file');
    expect(existsSync(join(dir, 'bin'))).toBe(false);
    writeProject(dir, generated.files, { overwrite: true });
    expect(existsSync(join(dir, 'bin', 'app.ts'))).toBe(true);
  });

  it('refuses path traversal', () => {
    expect(() =>
      writeProject(join(tmpRoot, 'trav'), [{ path: '../escape.txt', content: 'x' }]),
    ).toThrow(GenerationError);
    expect(() =>
      writeProject(join(tmpRoot, 'trav2'), [{ path: '/etc/passwd', content: 'x' }]),
    ).toThrow(GenerationError);
  });

  it('rejects mismatched snapshots, unsupported strategies and advisory-only ownership', () => {
    expect(() =>
      generateProject({ snapshot: { ...snapshot, id: 'snap-other' }, plan, decisions: base }),
    ).toThrow(/snapshot/);
    expect(() =>
      generateProject({
        snapshot,
        plan: { ...plan, generation: { strategy: 'faithful' } },
        decisions: base,
      }),
    ).toThrow(/not implemented/);
    const adopt = {
      ...plan,
      constructs: plan.constructs.map((c, i) =>
        i === 1 ? { ...c, ownership: 'adopt' as const } : c,
      ),
    };
    expect(() => generateProject({ snapshot, plan: adopt, decisions: base })).toThrow(
      /advisory only/,
    );
  });

  it('never creates unauthenticated routes for authorizer-protected ones', () => {
    const protectedSnapshot = {
      ...snapshot,
      resources: snapshot.resources.map((r) =>
        r.type === 'AWS::ApiGatewayV2::Api'
          ? {
              ...r,
              observedProperties: {
                ...r.observedProperties,
                routes: [
                  {
                    routeKey: 'GET /secure',
                    target: 'integrations/int1',
                    authorizationType: 'JWT',
                  },
                ],
              },
            }
          : r,
      ),
    };
    const p = buildPlan({
      snapshot: protectedSnapshot,
      decisions: base,
      strategy: 'balanced',
      applicationId: 'orders-api',
    });
    const g = generateProject({ snapshot: protectedSnapshot, plan: p, decisions: base });
    const api = g.files.find((f) => f.path === 'lib/constructs/api.ts')!.content;
    expect(api).not.toContain('/secure');
    expect(
      g.unresolved.some((u) => u.property.includes('/secure') && /NOT created/.test(u.reason)),
    ).toBe(true);
  });
});

describe('runtime mapping', () => {
  it('maps only constants that exist in aws-cdk-lib', () => {
    for (const constant of Object.values(RUNTIME_CONSTANTS)) {
      expect(
        (lambda.Runtime as unknown as Record<string, unknown>)[constant],
        constant,
      ).toBeDefined();
    }
  });
});
