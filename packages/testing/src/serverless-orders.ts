import type { CloudSnapshot } from '@cloud-to-code/core';
import { FIXTURE_ACCOUNT_ID, FIXTURE_REGION, FixtureBuilder } from './fixture-builder.js';

const A = FIXTURE_ACCOUNT_ID;
const R = FIXTURE_REGION;

const arn = {
  fn: (n: string) => `arn:aws:lambda:${R}:${A}:function:${n}`,
  table: (n: string) => `arn:aws:dynamodb:${R}:${A}:table/${n}`,
  queue: (n: string) => `arn:aws:sqs:${R}:${A}:${n}`,
  role: (n: string) => `arn:aws:iam::${A}:role/${n}`,
  bus: (n: string) => `arn:aws:events:${R}:${A}:event-bus/${n}`,
  rule: (bus: string, n: string) => `arn:aws:events:${R}:${A}:rule/${bus}/${n}`,
};

const ORDERS_TAGS = { 'aws:cloudformation:stack-name': 'orders-stack', Team: 'commerce' };
const BILLING_TAGS = { 'aws:cloudformation:stack-name': 'billing-stack', Team: 'finance' };

const BASIC_EXECUTION = 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole';

function lambdaProps(opts: {
  name: string;
  description: string;
  memorySize: number;
  timeout: number;
  role: string;
  envNames: string[];
}): Record<string, unknown> {
  return {
    runtime: 'nodejs22.x',
    handler: 'index.handler',
    memorySize: opts.memorySize,
    timeout: opts.timeout,
    architectures: ['arm64'],
    packageType: 'Zip',
    description: opts.description,
    roleArn: arn.role(opts.role),
    tracingMode: 'PassThrough',
    ephemeralStorageSize: 512,
    // Names only: environment *values* are never collected.
    environmentVariableNames: opts.envNames,
    layers: [],
  };
}

function lambdaRole(
  name: string,
  inlinePolicies: { name: string; statements: unknown[] }[],
): Record<string, unknown> {
  return {
    path: '/',
    assumeRolePolicy: {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { Service: 'lambda.amazonaws.com' },
          Action: 'sts:AssumeRole',
        },
      ],
    },
    managedPolicyArns: [BASIC_EXECUTION],
    inlinePolicies: inlinePolicies.map((p) => ({
      name: p.name,
      document: { Version: '2012-10-17', Statement: p.statements },
    })),
    roleName: name,
  };
}

/**
 * Synthetic, fully sanitized "serverless-orders" snapshot. Contains no real AWS data.
 *
 * Intentional ambiguities (they drive the interview):
 * - Event bus `shared-events` is wired to rules in both the Orders and Billing stacks (shared ownership).
 * - `orders-handler`'s IAM role allows DynamoDB access to `orders-table`, but nothing proves the function uses it
 *   (possible-access).
 * - No Lambda source can be linked to deployed code.
 */
export function buildServerlessOrdersSnapshot(): CloudSnapshot {
  const b = new FixtureBuilder();

  const api = b.add({
    type: 'AWS::ApiGatewayV2::Api',
    physicalId: 'a1b2c3d4e5',
    displayName: 'orders-api',
    arn: `arn:aws:apigateway:${R}::/apis/a1b2c3d4e5`,
    operation: 'apigatewayv2:GetApis',
    tags: ORDERS_TAGS,
    properties: {
      name: 'orders-api',
      protocolType: 'HTTP',
      apiEndpoint: `https://a1b2c3d4e5.execute-api.${R}.amazonaws.com`,
      routeSelectionExpression: '$request.method $request.path',
      corsConfiguration: {
        allowOrigins: ['https://shop.example.com'],
        allowMethods: ['GET', 'POST'],
        allowHeaders: ['content-type'],
      },
      integrations: [
        {
          integrationId: 'int1',
          integrationType: 'AWS_PROXY',
          integrationUri: arn.fn('orders-handler'),
          payloadFormatVersion: '2.0',
        },
      ],
      routes: [
        { routeKey: 'POST /orders', target: 'integrations/int1', authorizationType: 'NONE' },
        { routeKey: 'GET /orders/{id}', target: 'integrations/int1', authorizationType: 'NONE' },
      ],
      stages: [{ stageName: '$default', autoDeploy: true }],
    },
  });

  const handler = b.add({
    type: 'AWS::Lambda::Function',
    physicalId: 'orders-handler',
    arn: arn.fn('orders-handler'),
    operation: 'lambda:GetFunctionConfiguration',
    tags: ORDERS_TAGS,
    properties: lambdaProps({
      name: 'orders-handler',
      description: 'Handles order API requests',
      memorySize: 256,
      timeout: 15,
      role: 'orders-handler-role',
      envNames: ['TABLE_NAME'],
    }),
  });
  const streamProcessor = b.add({
    type: 'AWS::Lambda::Function',
    physicalId: 'orders-stream-processor',
    arn: arn.fn('orders-stream-processor'),
    operation: 'lambda:GetFunctionConfiguration',
    tags: ORDERS_TAGS,
    properties: lambdaProps({
      name: 'orders-stream-processor',
      description: 'Processes order table change events',
      memorySize: 128,
      timeout: 30,
      role: 'orders-stream-role',
      envNames: [],
    }),
  });
  const worker = b.add({
    type: 'AWS::Lambda::Function',
    physicalId: 'orders-worker',
    arn: arn.fn('orders-worker'),
    operation: 'lambda:GetFunctionConfiguration',
    tags: ORDERS_TAGS,
    properties: lambdaProps({
      name: 'orders-worker',
      description: 'Consumes queued orders and order events',
      memorySize: 512,
      timeout: 60,
      role: 'orders-worker-role',
      envNames: ['QUEUE_URL'],
    }),
  });
  const billing = b.add({
    type: 'AWS::Lambda::Function',
    physicalId: 'billing-handler',
    arn: arn.fn('billing-handler'),
    operation: 'lambda:GetFunctionConfiguration',
    tags: BILLING_TAGS,
    properties: lambdaProps({
      name: 'billing-handler',
      description: 'Creates invoices from order events',
      memorySize: 256,
      timeout: 30,
      role: 'billing-handler-role',
      envNames: [],
    }),
  });

  const table = b.add({
    type: 'AWS::DynamoDB::Table',
    physicalId: 'orders-table',
    arn: arn.table('orders-table'),
    operation: 'dynamodb:DescribeTable',
    tags: ORDERS_TAGS,
    properties: {
      tableName: 'orders-table',
      keySchema: [{ attributeName: 'orderId', keyType: 'HASH' }],
      attributeDefinitions: [
        { attributeName: 'orderId', attributeType: 'S' },
        { attributeName: 'status', attributeType: 'S' },
        { attributeName: 'createdAt', attributeType: 'S' },
      ],
      billingMode: 'PAY_PER_REQUEST',
      globalSecondaryIndexes: [
        {
          indexName: 'status-index',
          keySchema: [
            { attributeName: 'status', keyType: 'HASH' },
            { attributeName: 'createdAt', keyType: 'RANGE' },
          ],
          projection: { projectionType: 'ALL' },
        },
      ],
      streamSpecification: { streamEnabled: true, streamViewType: 'NEW_AND_OLD_IMAGES' },
      latestStreamArn: `${arn.table('orders-table')}/stream/2026-01-01T00:00:00.000`,
      deletionProtectionEnabled: true,
      pointInTimeRecoveryEnabled: true,
      timeToLive: { attributeName: 'expiresAt', enabled: true },
    },
  });

  const queue = b.add({
    type: 'AWS::SQS::Queue',
    physicalId: 'orders-queue',
    arn: arn.queue('orders-queue'),
    operation: 'sqs:GetQueueAttributes',
    tags: ORDERS_TAGS,
    properties: {
      queueName: 'orders-queue',
      fifoQueue: false,
      visibilityTimeout: 60,
      messageRetentionPeriod: 345600,
      delaySeconds: 0,
      maximumMessageSize: 262144,
      receiveMessageWaitTimeSeconds: 0,
      sqsManagedSseEnabled: true,
      redrivePolicy: { deadLetterTargetArn: arn.queue('orders-dlq'), maxReceiveCount: 5 },
    },
  });
  const dlq = b.add({
    type: 'AWS::SQS::Queue',
    physicalId: 'orders-dlq',
    arn: arn.queue('orders-dlq'),
    operation: 'sqs:GetQueueAttributes',
    tags: ORDERS_TAGS,
    properties: {
      queueName: 'orders-dlq',
      fifoQueue: false,
      visibilityTimeout: 30,
      messageRetentionPeriod: 1209600,
      delaySeconds: 0,
      maximumMessageSize: 262144,
      receiveMessageWaitTimeSeconds: 0,
      sqsManagedSseEnabled: true,
    },
  });

  const bus = b.add({
    type: 'AWS::Events::EventBus',
    physicalId: 'shared-events',
    arn: arn.bus('shared-events'),
    operation: 'events:DescribeEventBus',
    tags: { 'aws:cloudformation:stack-name': 'shared-infra' },
    properties: { name: 'shared-events' },
  });
  const ordersRule = b.add({
    type: 'AWS::Events::Rule',
    physicalId: 'shared-events/orders-created',
    displayName: 'orders-created',
    arn: arn.rule('shared-events', 'orders-created'),
    operation: 'events:DescribeRule',
    tags: ORDERS_TAGS,
    properties: {
      name: 'orders-created',
      eventBusName: 'shared-events',
      state: 'ENABLED',
      eventPattern: { source: ['orders'], 'detail-type': ['OrderCreated'] },
      targets: [{ id: 'worker', arn: arn.fn('orders-worker') }],
    },
  });
  const billingRule = b.add({
    type: 'AWS::Events::Rule',
    physicalId: 'shared-events/billing-invoice',
    displayName: 'billing-invoice',
    arn: arn.rule('shared-events', 'billing-invoice'),
    operation: 'events:DescribeRule',
    tags: BILLING_TAGS,
    properties: {
      name: 'billing-invoice',
      eventBusName: 'shared-events',
      state: 'ENABLED',
      eventPattern: { source: ['orders'], 'detail-type': ['OrderCreated'] },
      targets: [{ id: 'billing', arn: arn.fn('billing-handler') }],
    },
  });

  const handlerRole = b.add({
    type: 'AWS::IAM::Role',
    physicalId: 'orders-handler-role',
    arn: arn.role('orders-handler-role'),
    global: true,
    operation: 'iam:GetRole',
    properties: lambdaRole('orders-handler-role', [
      {
        name: 'orders-access',
        statements: [
          {
            Effect: 'Allow',
            Action: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query'],
            Resource: [arn.table('orders-table'), `${arn.table('orders-table')}/index/*`],
          },
        ],
      },
    ]),
  });
  const streamRole = b.add({
    type: 'AWS::IAM::Role',
    physicalId: 'orders-stream-role',
    arn: arn.role('orders-stream-role'),
    global: true,
    operation: 'iam:GetRole',
    properties: lambdaRole('orders-stream-role', [
      {
        name: 'stream-read',
        statements: [
          {
            Effect: 'Allow',
            Action: [
              'dynamodb:DescribeStream',
              'dynamodb:GetRecords',
              'dynamodb:GetShardIterator',
              'dynamodb:ListStreams',
            ],
            Resource: `${arn.table('orders-table')}/stream/*`,
          },
        ],
      },
    ]),
  });
  const workerRole = b.add({
    type: 'AWS::IAM::Role',
    physicalId: 'orders-worker-role',
    arn: arn.role('orders-worker-role'),
    global: true,
    operation: 'iam:GetRole',
    properties: lambdaRole('orders-worker-role', [
      {
        name: 'queue-consume',
        statements: [
          {
            Effect: 'Allow',
            Action: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes'],
            Resource: arn.queue('orders-queue'),
          },
        ],
      },
    ]),
  });
  const billingRole = b.add({
    type: 'AWS::IAM::Role',
    physicalId: 'billing-handler-role',
    arn: arn.role('billing-handler-role'),
    global: true,
    operation: 'iam:GetRole',
    properties: lambdaRole('billing-handler-role', []),
  });

  // Confirmed: observed integrations and mappings.
  b.relate(api, handler, 'routes-to', 'confirmed', 'apigatewayv2:GetIntegrations');
  b.relate(table, streamProcessor, 'triggers', 'confirmed', 'lambda:ListEventSourceMappings');
  b.relate(queue, worker, 'triggers', 'confirmed', 'lambda:ListEventSourceMappings');
  b.relate(queue, dlq, 'dead-letters-to', 'confirmed', 'sqs:GetQueueAttributes.RedrivePolicy');
  b.relate(ordersRule, bus, 'rule-on-bus', 'confirmed', 'events:ListRules');
  b.relate(billingRule, bus, 'rule-on-bus', 'confirmed', 'events:ListRules');
  b.relate(ordersRule, worker, 'targets', 'confirmed', 'events:ListTargetsByRule');
  b.relate(billingRule, billing, 'targets', 'confirmed', 'events:ListTargetsByRule');
  b.relate(
    handler,
    handlerRole,
    'assumes-role',
    'confirmed',
    'lambda:GetFunctionConfiguration.Role',
  );
  b.relate(
    streamProcessor,
    streamRole,
    'assumes-role',
    'confirmed',
    'lambda:GetFunctionConfiguration.Role',
  );
  b.relate(worker, workerRole, 'assumes-role', 'confirmed', 'lambda:GetFunctionConfiguration.Role');
  b.relate(
    billing,
    billingRole,
    'assumes-role',
    'confirmed',
    'lambda:GetFunctionConfiguration.Role',
  );

  // Hypotheses: IAM allows access; this is NOT proof the function uses the resource.
  b.relate(
    handlerRole,
    table,
    'possible-access',
    'hypothesis',
    'iam:GetRole.inlinePolicies(orders-access)',
  );
  b.relate(
    streamRole,
    table,
    'possible-access',
    'hypothesis',
    'iam:GetRole.inlinePolicies(stream-read)',
  );
  b.relate(
    workerRole,
    queue,
    'possible-access',
    'hypothesis',
    'iam:GetRole.inlinePolicies(queue-consume)',
  );

  b.deriveSameStack();
  return b.build();
}
