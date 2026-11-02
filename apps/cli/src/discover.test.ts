import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  awsError,
  fakeSenderFactory,
  type Handler,
  type RecordedCall,
} from '@cloud-to-code/provider-aws';
import { ExitCode, main } from './index.js';

let dir: string;
let configDir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c2c-disc-'));
  configDir = mkdtempSync(join(tmpdir(), 'c2c-cfg-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
});

const A = '123456789012';
const tableArn = `arn:aws:dynamodb:us-east-1:${A}:table/orders-table`;
const handlers = (over: Record<string, Handler> = {}): Record<string, Handler> => ({
  GetCallerIdentityCommand: () => ({ Account: A, Arn: `arn:aws:sts::${A}:assumed-role/dev/me` }),
  ListTablesCommand: () => ({ TableNames: ['orders-table'] }),
  DescribeTableCommand: () => ({
    Table: {
      TableArn: tableArn,
      KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
      AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
      BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
    },
  }),
  DescribeTimeToLiveCommand: () => ({}),
  DescribeContinuousBackupsCommand: () => ({}),
  ListTagsOfResourceCommand: () => ({ Tags: [] }),
  ...over,
});

async function run(args: string[], over: Record<string, Handler> = {}, calls: RecordedCall[] = []) {
  let stdout = '';
  let stderr = '';
  const code = await main([...args, '--dir', dir], {
    stdout: (t) => void (stdout += t),
    stderr: (t) => void (stderr += t),
    cwd: dir,
    env: { C2C_CONFIG_DIR: configDir },
    interactive: false,
    awsSenderFor: fakeSenderFactory(handlers(over), calls),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { code, stdout, stderr, json: (): any => JSON.parse(stdout) };
}

describe('c2c discover', () => {
  it('reads an explicit scope read-only and writes a private, sanitized snapshot', async () => {
    const calls: RecordedCall[] = [];
    const r = await run(
      ['discover', '--account', A, '--regions', 'us-east-1', '--services', 'dynamodb', '--json'],
      {},
      calls,
    );
    expect(r.code).toBe(ExitCode.OK);
    const out = join(dir, 'c2c-snapshot.json');
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(r.json().report.resourceCounts).toEqual({ 'AWS::DynamoDB::Table': 1 });
    expect(calls.map((c) => c.command)).toEqual(
      expect.arrayContaining([
        'GetCallerIdentityCommand',
        'ListTablesCommand',
        'DescribeTableCommand',
      ]),
    );
    expect(r.stderr).toContain('Read-only discovery');
    // The snapshot is directly usable by the rest of the workflow.
    const inspect = await run(['inspect', '--snapshot', out, '--json']);
    expect(inspect.code).toBe(0);
  });

  it('requires an explicit account and regions', async () => {
    const noAccount = await run(['discover', '--regions', 'us-east-1']);
    expect(noAccount.code).toBe(ExitCode.USAGE);
    expect(noAccount.stderr).toContain('--account');
    const noRegions = await run(['discover', '--account', A]);
    expect(noRegions.code).toBe(ExitCode.USAGE);
    expect(noRegions.stderr).toContain('no implicit all-regions scan');
  });

  it('refuses when the credentials belong to another account, and reads nothing else', async () => {
    const calls: RecordedCall[] = [];
    const r = await run(
      ['discover', '--account', '999999999999', '--regions', 'us-east-1', '--services', 'dynamodb'],
      {},
      calls,
    );
    expect(r.code).toBe(ExitCode.USAGE);
    expect(r.stderr).toContain('not in the declared scope');
    expect(calls.map((c) => c.command)).toEqual(['GetCallerIdentityCommand']);
    expect(existsSync(join(dir, 'c2c-snapshot.json'))).toBe(false);
  });

  it('exits CONSENT_REQUIRED (12) with a sign-in hint when credentials are unusable', async () => {
    const r = await run(
      ['discover', '--account', A, '--regions', 'us-east-1', '--services', 'dynamodb'],
      {
        GetCallerIdentityCommand: () => {
          throw awsError('CredentialsProviderError', 'no credentials');
        },
      },
    );
    expect(r.code).toBe(ExitCode.CONSENT_REQUIRED);
    expect(r.stderr).toContain('hint:');
  });

  it('never overwrites an existing snapshot without --overwrite', async () => {
    writeFileSync(join(dir, 'c2c-snapshot.json'), 'mine');
    const refused = await run([
      'discover',
      '--account',
      A,
      '--regions',
      'us-east-1',
      '--services',
      'dynamodb',
    ]);
    expect(refused.code).toBe(ExitCode.USAGE);
    expect(readFileSync(join(dir, 'c2c-snapshot.json'), 'utf8')).toBe('mine');
    const ok = await run([
      'discover',
      '--account',
      A,
      '--regions',
      'us-east-1',
      '--services',
      'dynamodb',
      '--overwrite',
    ]);
    expect(ok.code).toBe(ExitCode.OK);
  });

  it('rejects unsupported services', async () => {
    const r = await run([
      'discover',
      '--account',
      A,
      '--regions',
      'us-east-1',
      '--services',
      'ec2',
    ]);
    expect(r.code).toBe(ExitCode.USAGE);
    expect(r.stderr).toContain('Unsupported service');
  });
});

describe('c2c init and config show', () => {
  it('stores only non-secret settings with private permissions and uses them for discover', async () => {
    const init = await run([
      'init',
      '--profile',
      'dev',
      '--regions',
      'us-east-1,us-west-2',
      '--json',
    ]);
    expect(init.code).toBe(0);
    const file = join(configDir, 'config.yaml');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('profile: dev');
    expect(text).toContain('externalModelContext: ask-first');
    expect(text).not.toMatch(/key|secret|token|password/i);

    const show = await run(['config', 'show', '--json']);
    expect(show.json().config.aws).toMatchObject({
      profile: 'dev',
      regions: ['us-east-1', 'us-west-2'],
    });

    // Regions now come from the config, so --regions is optional.
    const disc = await run(['discover', '--account', A, '--services', 'dynamodb', '--json']);
    expect(disc.code).toBe(0);
    expect(disc.json().report.scope.regions).toEqual(['us-east-1', 'us-west-2']);
  });

  it('rejects invalid privacy settings', async () => {
    expect((await run(['init', '--external-model-context', 'always'])).code).toBe(ExitCode.USAGE);
  });
});
