import { describe, expect, it } from 'vitest';
import { EvidenceGraph } from '@cloud-to-code/core';
import {
  awsError,
  discover,
  fakeSenderFactory,
  ScopeError,
  ALLOWED_COMMANDS,
  validateScope,
  type Handler,
  type RecordedCall,
} from './index.js';

const A = '123456789012';
const R = 'us-east-1';
const ENV_CANARY = 'super-secret-db-password-canary';
const POLICY_CANARY = 'queue-policy-canary';
const fnArn = (n: string) => `arn:aws:lambda:${R}:${A}:function:${n}`;
const roleArn = (n: string) => `arn:aws:iam::${A}:role/${n}`;
const tableArn = `arn:aws:dynamodb:${R}:${A}:table/orders-table`;
const queueArn = (n: string) => `arn:aws:sqs:${R}:${A}:${n}`;
const stackTag = { 'aws:cloudformation:stack-name': 'orders-stack' };
const enc = (doc: unknown) => encodeURIComponent(JSON.stringify(doc));
const now = new Date('2026-03-01T00:00:00Z');
const NOW = { now };

function account(overrides: Record<string, Handler> = {}): Record<string, Handler> {
  const fnBase = {
    Runtime: 'nodejs22.x',
    Handler: 'index.handler',
    MemorySize: 256,
    Timeout: 15,
    Architectures: ['arm64'],
    PackageType: 'Zip',
    TracingConfig: { Mode: 'PassThrough' },
    EphemeralStorage: { Size: 512 },
  };
  return {
    GetCallerIdentityCommand: () => ({ Account: A, Arn: `arn:aws:sts::${A}:assumed-role/dev/me` }),
    ListFunctionsCommand: (input) =>
      input.Marker === undefined
        ? {
            Functions: [
              {
                ...fnBase,
                FunctionName: 'orders-handler',
                FunctionArn: fnArn('orders-handler'),
                Role: roleArn('orders-handler-role'),
                Environment: { Variables: { TABLE_NAME: 'orders-table', DB_PASSWORD: ENV_CANARY } },
              },
            ],
            NextMarker: 'page2',
          }
        : {
            Functions: [
              {
                ...fnBase,
                FunctionName: 'orders-stream',
                FunctionArn: fnArn('orders-stream'),
                Role: roleArn('orders-stream-role'),
              },
            ],
          },
    ListEventSourceMappingsCommand: (input) =>
      input.FunctionName === 'orders-stream'
        ? {
            EventSourceMappings: [
              {
                EventSourceArn: `${tableArn}/stream/2026`,
                BatchSize: 100,
                StartingPosition: 'LATEST',
                State: 'Enabled',
              },
              {
                EventSourceArn: `arn:aws:kinesis:${R}:${A}:stream/clicks`,
                BatchSize: 5,
                State: 'Enabled',
              },
            ],
          }
        : { EventSourceMappings: [] },
    ListTagsCommand: () => ({ Tags: stackTag }),
    GetApisCommand: () => ({
      Items: [
        {
          ApiId: 'abc123',
          Name: 'orders-api',
          ProtocolType: 'HTTP',
          ApiEndpoint: `https://abc123.execute-api.${R}.amazonaws.com`,
          Tags: stackTag,
          CorsConfiguration: { AllowOrigins: ['https://x.example'], AllowMethods: ['GET'] },
        },
      ],
    }),
    GetRoutesCommand: () => ({
      Items: [{ RouteKey: 'GET /orders', Target: 'integrations/i1', AuthorizationType: 'NONE' }],
    }),
    GetIntegrationsCommand: () => ({
      Items: [
        {
          IntegrationId: 'i1',
          IntegrationType: 'AWS_PROXY',
          IntegrationUri: fnArn('orders-handler'),
          PayloadFormatVersion: '2.0',
        },
      ],
    }),
    GetStagesCommand: () => ({ Items: [{ StageName: '$default', AutoDeploy: true }] }),
    ListTablesCommand: () => ({ TableNames: ['orders-table'] }),
    DescribeTableCommand: () => ({
      Table: {
        TableArn: tableArn,
        KeySchema: [{ AttributeName: 'orderId', KeyType: 'HASH' }],
        AttributeDefinitions: [{ AttributeName: 'orderId', AttributeType: 'S' }],
        BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
        StreamSpecification: { StreamEnabled: true, StreamViewType: 'NEW_AND_OLD_IMAGES' },
        LatestStreamArn: `${tableArn}/stream/2026`,
        DeletionProtectionEnabled: true,
      },
    }),
    DescribeTimeToLiveCommand: () => ({
      TimeToLiveDescription: { TimeToLiveStatus: 'ENABLED', AttributeName: 'expiresAt' },
    }),
    DescribeContinuousBackupsCommand: () => ({
      ContinuousBackupsDescription: {
        PointInTimeRecoveryDescription: { PointInTimeRecoveryStatus: 'ENABLED' },
      },
    }),
    ListTagsOfResourceCommand: () => ({
      Tags: [{ Key: 'aws:cloudformation:stack-name', Value: 'orders-stack' }],
    }),
    ListQueuesCommand: () => ({
      QueueUrls: [
        `https://sqs.${R}.amazonaws.com/${A}/orders-queue`,
        `https://sqs.${R}.amazonaws.com/${A}/orders-dlq`,
      ],
    }),
    GetQueueAttributesCommand: (input) =>
      input.QueueUrl.endsWith('orders-queue')
        ? {
            Attributes: {
              QueueArn: queueArn('orders-queue'),
              VisibilityTimeout: '60',
              RedrivePolicy: JSON.stringify({
                deadLetterTargetArn: queueArn('orders-dlq'),
                maxReceiveCount: 5,
              }),
              SqsManagedSseEnabled: 'true',
              Policy: POLICY_CANARY,
            },
          }
        : { Attributes: { QueueArn: queueArn('orders-dlq'), VisibilityTimeout: '30' } },
    ListQueueTagsCommand: () => ({ Tags: stackTag }),
    ListEventBusesCommand: () => ({
      EventBuses: [
        { Name: 'default', Arn: `arn:aws:events:${R}:${A}:event-bus/default` },
        { Name: 'shared-events', Arn: `arn:aws:events:${R}:${A}:event-bus/shared-events` },
      ],
    }),
    ListRulesCommand: (input) =>
      input.EventBusName === 'shared-events'
        ? {
            Rules: [
              {
                Name: 'orders-created',
                Arn: `arn:aws:events:${R}:${A}:rule/shared-events/orders-created`,
                State: 'ENABLED',
                EventPattern: JSON.stringify({ source: ['orders'] }),
              },
              { Name: 'aws-managed', Arn: 'arn:x', ManagedBy: 'events.amazonaws.com' },
            ],
          }
        : { Rules: [] },
    ListTargetsByRuleCommand: () => ({
      Targets: [{ Id: 't1', Arn: fnArn('orders-handler'), Input: '{"token":"data"}' }],
    }),
    ListTagsForResourceCommand: () => ({ Tags: [] }),
    ListBucketsCommand: () => ({
      Buckets: [{ Name: 'orders-exports' }, { Name: 'other-region-bucket' }],
    }),
    GetBucketLocationCommand: (input) => ({
      LocationConstraint: input.Bucket === 'other-region-bucket' ? 'eu-west-1' : '',
    }),
    GetBucketVersioningCommand: () => ({ Status: 'Enabled' }),
    GetBucketEncryptionCommand: () => ({
      ServerSideEncryptionConfiguration: {
        Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
      },
    }),
    GetPublicAccessBlockCommand: () => ({
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true,
      },
    }),
    GetBucketNotificationConfigurationCommand: () => ({
      LambdaFunctionConfigurations: [
        {
          Id: 'n1',
          Events: ['s3:ObjectCreated:*'],
          LambdaFunctionArn: fnArn('orders-handler'),
          Filter: { Key: { FilterRules: [{ Name: 'Prefix', Value: 'exports/' }] } },
        },
      ],
    }),
    GetBucketTaggingCommand: () => ({ TagSet: [] }),
    GetRoleCommand: (input) => ({
      Role: {
        Arn: roleArn(input.RoleName),
        Path: '/',
        AssumeRolePolicyDocument: enc({
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: { Service: 'lambda.amazonaws.com' },
              Action: 'sts:AssumeRole',
            },
          ],
        }),
      },
    }),
    ListRolePoliciesCommand: (input) => ({
      PolicyNames: input.RoleName === 'orders-handler-role' ? ['orders-access'] : [],
    }),
    ListAttachedRolePoliciesCommand: () => ({
      AttachedPolicies: [
        { PolicyArn: 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole' },
      ],
    }),
    GetRolePolicyCommand: () => ({
      PolicyDocument: enc({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Action: ['dynamodb:GetItem'],
            Resource: [tableArn, `${tableArn}/index/*`],
          },
          { Effect: 'Allow', Action: 's3:GetObject', Resource: '*' },
        ],
      }),
    }),
    ListRoleTagsCommand: () => ({ Tags: [] }),
    ...overrides,
  };
}

const scope = {
  accountIds: [A],
  regions: [R],
  services: ['lambda', 'apigatewayv2', 'dynamodb', 'sqs', 'eventbridge', 's3', 'iam'],
};

async function run(overrides: Record<string, Handler> = {}, s = scope, calls: RecordedCall[] = []) {
  return discover({ scope: s, senderFor: fakeSenderFactory(account(overrides), calls), ...NOW });
}

describe('discover (fake AWS)', () => {
  it('builds a valid snapshot covering every supported service, following pagination', async () => {
    const { snapshot, caller } = await run();
    expect(caller.accountId).toBe(A);
    const types = snapshot.resources.map((r) => r.type);
    expect(types.filter((t) => t === 'AWS::Lambda::Function')).toHaveLength(2); // two pages
    for (const t of [
      'AWS::ApiGatewayV2::Api',
      'AWS::DynamoDB::Table',
      'AWS::SQS::Queue',
      'AWS::Events::EventBus',
      'AWS::Events::Rule',
      'AWS::S3::Bucket',
      'AWS::IAM::Role',
    ]) {
      expect(types).toContain(t);
    }
    expect(snapshot.resources.find((r) => r.physicalId === 'other-region-bucket')).toBeUndefined(); // out of region scope
    expect(snapshot.scope).toEqual({
      accountIds: [A],
      regions: [R],
      services: [...scope.services].sort(),
    });
    expect(snapshot.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('derives relationships with the right direction and confidence', async () => {
    const { snapshot } = await run();
    const kinds = (kind: string) => snapshot.relationships.filter((r) => r.kind === kind);
    const name = (id: string) => id.split('/').pop();
    expect(kinds('routes-to').map((r) => [name(r.from), name(r.to)])).toEqual([
      ['abc123', 'orders-handler'],
    ]);
    expect(kinds('triggers').map((r) => [name(r.from), name(r.to)])).toEqual([
      ['orders-table', 'orders-stream'],
    ]);
    expect(kinds('dead-letters-to').map((r) => [name(r.from), name(r.to)])).toEqual([
      ['orders-queue', 'orders-dlq'],
    ]);
    expect(kinds('notifies').map((r) => name(r.to))).toEqual(['orders-handler']);
    expect(kinds('rule-on-bus')).toHaveLength(1);
    expect(kinds('targets')).toHaveLength(1);
    expect(kinds('assumes-role')).toHaveLength(2);
    expect(kinds('same-stack').every((r) => r.confidence === 'derived')).toBe(true);
    const possible = kinds('possible-access');
    expect(possible.length).toBeGreaterThan(0);
    expect(possible.every((r) => r.confidence === 'hypothesis')).toBe(true);
    // The wildcard "*" statement does not create edges; it is explained instead.
    expect(snapshot.diagnostics.map((d) => d.code)).toContain('wildcard-resource-policy');
    expect(snapshot.diagnostics.map((d) => d.code)).toContain('unsupported-event-source');
  });

  it('feeds the evidence graph: IAM alone never counts as a runtime link', async () => {
    const { snapshot } = await run();
    const graph = new EvidenceGraph(snapshot);
    const handler = snapshot.resources.find((r) => r.physicalId === 'orders-handler')!;
    const table = snapshot.resources.find((r) => r.physicalId === 'orders-table')!;
    expect(graph.directlyConnected(handler.id, table.id)).toBe(false);
  });

  it('never stores environment values, queue policies or rule target inputs', async () => {
    const { snapshot } = await run();
    const json = JSON.stringify(snapshot);
    expect(json).not.toContain(ENV_CANARY);
    expect(json).not.toContain(POLICY_CANARY);
    expect(json).not.toContain('"token":"data"');
    const fn = snapshot.resources.find((r) => r.physicalId === 'orders-handler')!;
    expect(fn.observedProperties['environmentVariableNames']).toEqual([
      'DB_PASSWORD',
      'TABLE_NAME',
    ]);
  });

  it('only sends allowlisted read-only commands, and never touches data', async () => {
    const calls: RecordedCall[] = [];
    await run({}, scope, calls);
    const allowed = new Set(Object.values(ALLOWED_COMMANDS).flat());
    expect(calls.length).toBeGreaterThan(20);
    expect(calls.filter((c) => !allowed.has(c.command))).toEqual([]);
    expect(calls.map((c) => c.command)).not.toContain('GetObjectCommand');
    // IAM is queried only for roles the discovered functions use.
    expect(
      calls
        .filter((c) => c.command === 'GetRoleCommand')
        .map((c) => (c.input as { RoleName: string }).RoleName)
        .sort(),
    ).toEqual(['orders-handler-role', 'orders-stream-role']);
  });

  it('is deterministic for the same inputs', async () => {
    const a = await run();
    const b = await run();
    expect(a.snapshot).toEqual(b.snapshot);
  });

  it('produces the same snapshot regardless of the order AWS returns items in', async () => {
    const reversed = await run({
      ListEventBusesCommand: () => ({
        EventBuses: [
          { Name: 'shared-events', Arn: `arn:aws:events:${R}:${A}:event-bus/shared-events` },
          { Name: 'default', Arn: `arn:aws:events:${R}:${A}:event-bus/default` },
        ],
      }),
      ListQueuesCommand: () => ({
        QueueUrls: [
          `https://sqs.${R}.amazonaws.com/${A}/orders-dlq`,
          `https://sqs.${R}.amazonaws.com/${A}/orders-queue`,
        ],
      }),
    });
    expect(reversed.snapshot).toEqual((await run()).snapshot);
  });
});

describe('partial failure and edge cases', () => {
  it('turns access-denied into a warning diagnostic and keeps the resource', async () => {
    const { snapshot } = await run({
      DescribeContinuousBackupsCommand: () => {
        throw awsError('AccessDeniedException');
      },
    });
    const d = snapshot.diagnostics.find((x) => x.code === 'access-denied');
    expect(d).toMatchObject({ severity: 'warning', service: 'dynamodb' });
    expect(d!.message).toMatch(/absence of evidence/);
    const table = snapshot.resources.find((r) => r.physicalId === 'orders-table')!;
    expect(table.observedProperties['pointInTimeRecoveryEnabled']).toBeUndefined();
  });

  it('records a whole service denied as a diagnostic and still returns the others', async () => {
    const { snapshot } = await run({
      ListQueuesCommand: () => {
        throw awsError('AccessDenied');
      },
    });
    expect(snapshot.resources.some((r) => r.type === 'AWS::SQS::Queue')).toBe(false);
    expect(snapshot.resources.some((r) => r.type === 'AWS::DynamoDB::Table')).toBe(true);
    expect(
      snapshot.diagnostics.some((d) => d.code === 'access-denied' && /sqs/.test(d.message)),
    ).toBe(true);
  });

  it('reports throttling after retries as a warning rather than failing', async () => {
    const { snapshot } = await run({
      ListTablesCommand: () => {
        throw awsError('ThrottlingException', 'Rate exceeded', 400);
      },
    });
    expect(snapshot.diagnostics.find((d) => d.code === 'throttled')).toMatchObject({
      severity: 'warning',
    });
  });

  it('propagates cancellation instead of swallowing it', async () => {
    await expect(
      run({
        ListTablesCommand: () => {
          throw awsError('AbortError');
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('handles an empty region', async () => {
    const empty: Record<string, Handler> = {
      ListFunctionsCommand: () => ({ Functions: [] }),
      GetApisCommand: () => ({ Items: [] }),
      ListTablesCommand: () => ({ TableNames: [] }),
      ListQueuesCommand: () => ({}),
      ListEventBusesCommand: () => ({ EventBuses: [] }),
      ListBucketsCommand: () => ({ Buckets: [] }),
    };
    const { snapshot } = await run(empty);
    expect(snapshot.resources).toEqual([]);
    expect(snapshot.relationships).toEqual([]);
  });

  it('fails soft on unknown errors with an error diagnostic', async () => {
    const { snapshot } = await run({
      GetApisCommand: () => {
        throw new Error('boom');
      },
    });
    expect(snapshot.diagnostics.find((d) => d.code === 'collector-error')).toMatchObject({
      severity: 'error',
    });
  });
});

describe('scope and identity', () => {
  it('refuses to read anything when the credentials belong to another account', async () => {
    const calls: RecordedCall[] = [];
    await expect(
      discover({
        scope: { ...scope, accountIds: ['999999999999'] },
        senderFor: fakeSenderFactory(account(), calls),
        ...NOW,
      }),
    ).rejects.toMatchObject({ code: 'account-not-in-scope' });
    expect(calls.map((c) => c.command)).toEqual(['GetCallerIdentityCommand']);
  });

  it('reports unusable credentials clearly', async () => {
    await expect(
      run({
        GetCallerIdentityCommand: () => {
          throw awsError('CredentialsProviderError', 'Could not load credentials');
        },
      }),
    ).rejects.toMatchObject({ code: 'credentials-unavailable' });
  });

  it.each([
    [{ ...scope, accountIds: [] }, /at least one account/],
    [{ ...scope, accountIds: ['123'] }, /Invalid account/],
    [{ ...scope, regions: [] }, /no implicit account-wide crawl/],
    [{ ...scope, regions: ['mars-1'] }, /Invalid region/],
    [{ ...scope, services: [] }, /at least one service/],
    [{ ...scope, services: ['ec2'] }, /Unsupported service/],
  ])('rejects invalid scope %#', (s, message) => {
    expect(() => validateScope(s)).toThrow(ScopeError);
    expect(() => validateScope(s)).toThrow(message);
  });

  it('only reads the services that were asked for', async () => {
    const calls: RecordedCall[] = [];
    await run({}, { ...scope, services: ['dynamodb'] }, calls);
    expect([...new Set(calls.map((c) => c.service))].sort()).toEqual(['dynamodb', 'sts']);
  });
});
