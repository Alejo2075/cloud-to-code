import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceStore } from '@cloud-to-code/reconstruction';
import { fakeSenderFactory, type Handler } from '@cloud-to-code/provider-aws';
import { buildServerlessOrdersSnapshot } from '@cloud-to-code/testing';
import { main as cli } from '@cloud-to-code/cli';
import { TOOL_NAMES, createServer } from './index.js';

let dir: string;
let client: Client;
const snapshot = buildServerlessOrdersSnapshot();

async function connect(workspace: string, senderFor?: ReturnType<typeof fakeSenderFactory>) {
  const server = createServer({ workspaceDir: workspace, ...(senderFor ? { senderFor } : {}) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const c = new Client({ name: 'test-host', version: '0' });
  await c.connect(b);
  return c;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(name: string, args: Record<string, unknown>): Promise<any> {
  const res = (await client.callTool({ name, arguments: args })) as {
    content: { text: string }[];
    isError?: boolean;
  };
  const body = JSON.parse(res.content[0]!.text);
  return { ...body, isError: res.isError === true };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'c2c-mcp-'));
  new WorkspaceStore(dir).saveSnapshotFile(snapshot);
  client = await connect(dir);
});
afterEach(async () => {
  await client.close();
  rmSync(dir, { recursive: true, force: true });
});

const answers = [
  { questionId: 'q-shared-shared-events', answer: { kind: 'choice', optionId: 'reference' } },
  { questionId: 'q-lambda-source-orders-api', answer: { kind: 'choice', optionId: 'infra-only' } },
];

async function startSession(): Promise<string> {
  const started = await call('start_reconstruction', {
    snapshotId: snapshot.id,
    application: 'orders-api',
  });
  return started.sessionId as string;
}

describe('tool surface', () => {
  it('exposes exactly the documented tools and nothing that deploys, imports, deletes or runs shell', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const t of tools)
      expect(t.name).not.toMatch(/deploy|import|delete|bootstrap|shell|exec|bash|run_command/i);
  });

  it('declares read-only hints honestly', async () => {
    const { tools } = await client.listTools();
    const hint = (n: string) => tools.find((t) => t.name === n)!.annotations?.readOnlyHint;
    expect(hint('inspect_application')).toBe(true);
    expect(hint('get_pending_questions')).toBe(true);
    expect(hint('generate_cdk')).toBe(false);
    for (const t of tools) expect(t.annotations?.destructiveHint).toBe(false);
  });

  it('never depends on an AI provider', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies)).not.toContain('@cloud-to-code/ai');
  });
});

describe('question-driven flow through MCP', () => {
  it("returns structured questions, records the user's decisions, verifies a plan and generates", async () => {
    const started = await call('start_reconstruction', {
      snapshotId: snapshot.id,
      application: 'orders-api',
    });
    expect(started.status).toBe('NEEDS_INPUT');
    expect(started.questions[0]).toMatchObject({
      id: 'q-shared-shared-events',
      priority: 'blocking',
      suggestedOptionId: 'reference',
    });
    const sessionId = started.sessionId;

    const early = await call('generate_cdk', { sessionId, outputDir: 'out' });
    expect(early.status).toBe('NEEDS_INPUT');
    expect(early.issues[0].code).toBe('blocking-question-unresolved');

    const submitted = await call('submit_decisions', { sessionId, decisions: answers });
    expect(submitted.status).toBe('OK');
    expect(submitted.accepted).toHaveLength(2);

    const pending = await call('get_pending_questions', { sessionId });
    expect(pending.questions.map((q: { id: string }) => q.id)).not.toContain(
      'q-shared-shared-events',
    );

    const plan = await call('submit_reconstruction_plan', { sessionId });
    expect(plan.accepted).toBe(true);
    expect(plan.plan.producedBy).toBe('deterministic-planner');

    const gen = await call('generate_cdk', { sessionId, outputDir: 'orders-api' });
    expect(gen.status).toBe('OK');
    expect(gen.files).toContain('lib/constructs/compute.ts');
    expect(gen.next).toMatch(/does not prove equivalence/);

    const validated = await call('validate_cdk', { directory: 'orders-api', typecheck: false });
    expect(validated.report.checks.find((c: { id: string }) => c.id === 'manifest').status).toBe(
      'pass',
    );

    const migration = await call('get_migration_plan', { directory: 'orders-api' });
    expect(migration.plan.mode).toBe('advisory');
    expect(migration.migrationPlanMarkdown).toMatch(/Migration plan \(advisory\)/);
  });

  it('rejects invalid options and an unknown-answered blocking question blocks generation', async () => {
    const sessionId = await startSession();
    const bad = await call('submit_decisions', {
      sessionId,
      decisions: [
        {
          questionId: 'q-shared-shared-events',
          answer: { kind: 'choice', optionId: 'deploy-now' },
        },
      ],
    });
    expect(bad.status).toBe('FAILED');
    expect(bad.rejected[0].error).toContain('Unknown option');
    const unknown = await call('submit_decisions', {
      sessionId,
      decisions: [{ questionId: 'q-shared-shared-events', answer: { kind: 'unknown' } }],
    });
    expect(unknown.status).toBe('BLOCKED');
    const gen = await call('generate_cdk', { sessionId, outputDir: 'x' });
    expect(gen.status).toBe('BLOCKED');
    expect(readdirSync(dir)).not.toContain('x');
  });

  it('reports unknown sessions and applications as structured errors, not protocol errors', async () => {
    const r = await call('get_pending_questions', { sessionId: 'sess-nope' });
    expect(r.isError).toBe(true);
    expect(r.error.code).toBe('workspace-error');
    const app = await call('start_reconstruction', {
      snapshotId: snapshot.id,
      application: 'nope',
    });
    expect(app.error.code).toBe('application-not-found');
    const several = await call('start_reconstruction', { snapshotId: snapshot.id });
    expect(several.error.code).toBe('application-not-selected');
  });
});

describe('untrusted plans from the host agent', () => {
  async function ready() {
    const sessionId = await startSession();
    await call('submit_decisions', { sessionId, decisions: answers });
    const planned = await call('submit_reconstruction_plan', { sessionId });
    return { sessionId, plan: planned.plan as Record<string, unknown> };
  }

  it('accepts a valid agent plan, stores it and generates from it', async () => {
    const { sessionId, plan } = await ready();
    const res = await call('submit_reconstruction_plan', {
      sessionId,
      plan: { ...plan, producedBy: 'agent-host' },
    });
    expect(res.accepted).toBe(true);
    await call('generate_cdk', { sessionId, outputDir: 'agent-out' });
    const manifest = JSON.parse(
      readFileSync(join(dir, 'agent-out', '.c2c', 'manifest.json'), 'utf8'),
    );
    expect(manifest.producedBy).toBe('agent-host');
  });

  it('rejects hallucinated resources, fabricated decisions and spoofed origins', async () => {
    const { sessionId, plan } = await ready();
    const hallucinated = {
      ...plan,
      producedBy: 'agent-host',
      selectedResourceIds: [...(plan['selectedResourceIds'] as string[]), 'ghost'],
      decisionIds: ['dec-fake'],
    };
    const res = await call('submit_reconstruction_plan', { sessionId, plan: hallucinated });
    expect(res.accepted).toBe(false);
    expect(res.issues.map((i: { code: string }) => i.code)).toEqual(
      expect.arrayContaining(['unknown-resource', 'unknown-decision']),
    );
    const spoof = await call('submit_reconstruction_plan', { sessionId, plan });
    expect(spoof.error.code).toBe('invalid-plan-origin');
  });

  it("a plan that contradicts the user's decision is rejected", async () => {
    const { sessionId, plan } = await ready();
    const boundaries = plan['boundaries'] as {
      owned: string[];
      referenced: string[];
      excluded: string[];
    };
    const bus = boundaries.referenced[0]!;
    const forged = {
      ...plan,
      producedBy: 'agent-host',
      boundaries: { ...boundaries, referenced: [], owned: [...boundaries.owned, bus] },
      constructs: (plan['constructs'] as { resourceIds: string[] }[])
        .map((c) => ({ ...c, resourceIds: c.resourceIds.filter((r) => r !== bus) }))
        .filter((c) => c.resourceIds.length > 0),
    };
    (plan['stacks'] as { constructIds: string[] }[])[0]!.constructIds = (
      forged.constructs as unknown as { id: string }[]
    ).map((c) => c.id);
    const res = await call('submit_reconstruction_plan', {
      sessionId,
      plan: { ...forged, stacks: plan['stacks'] },
    });
    expect(res.accepted).toBe(false);
    expect(res.issues.map((i: { code: string }) => i.code)).toContain('decision-conflict');
  });
});

describe('file safety', () => {
  async function readySession() {
    const sessionId = await startSession();
    await call('submit_decisions', { sessionId, decisions: answers });
    return sessionId;
  }

  it('confines output and inputs to the workspace and protects .c2c', async () => {
    const sessionId = await readySession();
    for (const outputDir of ['../escape', '/tmp/c2c-escape', '.c2c/hack', 'a/../../escape']) {
      const r = await call('generate_cdk', { sessionId, outputDir });
      expect(r.error?.code, outputDir).toMatch(/path-outside-workspace|path-reserved/);
    }
    const v = await call('validate_cdk', { directory: '../..' });
    expect(v.error.code).toBe('path-outside-workspace');
  });

  it('refuses non-empty directories unless overwrite is explicitly set', async () => {
    const sessionId = await readySession();
    mkdirSync(join(dir, 'taken'));
    writeFileSync(join(dir, 'taken', 'mine.txt'), 'keep');
    const refused = await call('generate_cdk', { sessionId, outputDir: 'taken' });
    expect(refused.error.code).toBe('output-not-empty');
    expect(readFileSync(join(dir, 'taken', 'mine.txt'), 'utf8')).toBe('keep');
    const ok = await call('generate_cdk', { sessionId, outputDir: 'taken', overwrite: true });
    expect(ok.status).toBe('OK');
  });

  it('does not accept credentials as arguments', async () => {
    const { tools } = await client.listTools();
    const props = JSON.stringify(tools.find((t) => t.name === 'aws_discover')!.inputSchema);
    expect(props).not.toMatch(/secret|accessKey|password|token/i);
  });
});

describe('resources and discovery', () => {
  it('serves the snapshot and plan as resources', async () => {
    const res = await client.readResource({ uri: `c2c://snapshots/${snapshot.id}` });
    expect(JSON.parse((res.contents[0] as { text: string }).text).id).toBe(snapshot.id);
  });

  it('aws_discover reads read-only through the guard and stores a snapshot', async () => {
    const A = '123456789012';
    const handlers: Record<string, Handler> = {
      GetCallerIdentityCommand: () => ({
        Account: A,
        Arn: `arn:aws:sts::${A}:assumed-role/dev/me`,
      }),
      ListTablesCommand: () => ({ TableNames: [] }),
    };
    const other = mkdtempSync(join(tmpdir(), 'c2c-mcp2-'));
    const c = await connect(other, fakeSenderFactory(handlers));
    const res = JSON.parse(
      (
        (await c.callTool({
          name: 'aws_discover',
          arguments: { account: A, regions: ['us-east-1'], services: ['dynamodb'] },
        })) as { content: { text: string }[] }
      ).content[0]!.text,
    );
    expect(res.status).toBe('OK');
    expect(res.snapshotId).toMatch(/^snap-/);
    expect(res.note).toMatch(/No AWS resources were created/);
    const wrong = JSON.parse(
      (
        (await c.callTool({
          name: 'aws_discover',
          arguments: { account: '999999999999', regions: ['us-east-1'], services: ['dynamodb'] },
        })) as { content: { text: string }[] }
      ).content[0]!.text,
    );
    expect(wrong.error.code).toBe('account-not-in-scope');
    await c.close();
    rmSync(other, { recursive: true, force: true });
  });

  it('inspect_application paginates', async () => {
    const page = await call('inspect_application', {
      snapshotId: snapshot.id,
      limit: 5,
      offset: 5,
    });
    expect(page.resources.items).toHaveLength(5);
    expect(page.resources.total).toBe(snapshot.resources.length);
  });
});

describe('parity with the CLI', () => {
  function tree(root: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const e of readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (!e.isFile()) continue;
      const full = join(e.parentPath, e.name);
      out[relative(root, full)] = readFileSync(full, 'utf8')
        .replace(/dec-[0-9a-f]{10}/g, 'dec-X')
        .replace(/"sha256": "[0-9a-f]{64}"/g, '"sha256": "HASH"')
        .replace(/"planDigest": "[0-9a-f]{16}"/g, '"planDigest": "HASH"')
        // Provenance legitimately differs by channel (answers file vs agent host); nothing else may.
        .replace(/\| (answers-file|agent-host-user|interactive-user) \|/g, '| SOURCE |')
        .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, 'TIME');
    }
    return out;
  }

  it('the same approved decisions produce the same CDK project from the CLI and MCP', async () => {
    const sessionId = await startSession();
    await call('submit_decisions', { sessionId, decisions: answers });
    await call('generate_cdk', { sessionId, outputDir: 'via-mcp' });

    const file = join(dir, 'answers.json');
    writeFileSync(
      file,
      JSON.stringify({
        'q-shared-shared-events': 'reference',
        'q-lambda-source-orders-api': 'infra-only',
      }),
    );
    const code = await cli(
      [
        'reconstruct',
        'orders-api',
        '--snapshot',
        join(dir, '.c2c', 'snapshots', `${snapshot.id}.json`),
        '--answers',
        file,
        '--output',
        join(dir, 'via-cli'),
        '--json',
        '--dir',
        join(dir, 'cli-ws'),
      ],
      {
        stdout: () => undefined,
        stderr: () => undefined,
        cwd: dir,
        env: {},
        interactive: false,
      },
    );
    expect(code).toBe(0);
    const a = tree(join(dir, 'via-mcp'));
    const b = tree(join(dir, 'via-cli'));
    expect(Object.keys(a)).toEqual(Object.keys(b));
    expect(a).toEqual(b);
  });
});
