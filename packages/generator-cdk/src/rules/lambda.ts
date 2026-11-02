import type { GenContext } from '../context.js';
import { isIdentifier, quote } from '../ts.js';
import { GenerationError } from '../types.js';
import { RuleRun, type RuleResult } from './common.js';

interface EventSourceMapping {
  eventSourceArn?: string;
  batchSize?: number;
  startingPosition?: string;
  enabled?: boolean;
  maximumBatchingWindowInSeconds?: number;
}

/** Observed runtime identifier -> `lambda.Runtime` constant (verified against aws-cdk-lib by a test). */
export const RUNTIME_CONSTANTS: Readonly<Record<string, string>> = {
  'nodejs18.x': 'NODEJS_18_X',
  'nodejs20.x': 'NODEJS_20_X',
  'nodejs22.x': 'NODEJS_22_X',
  'python3.9': 'PYTHON_3_9',
  'python3.10': 'PYTHON_3_10',
  'python3.11': 'PYTHON_3_11',
  'python3.12': 'PYTHON_3_12',
  'python3.13': 'PYTHON_3_13',
  java11: 'JAVA_11',
  java17: 'JAVA_17',
  java21: 'JAVA_21',
  dotnet8: 'DOTNET_8',
  'ruby3.2': 'RUBY_3_2',
  'ruby3.3': 'RUBY_3_3',
  'provided.al2': 'PROVIDED_AL2',
  'provided.al2023': 'PROVIDED_AL2023',
};

const SECRETISH = /(secret|password|passwd|token|api[_-]?key|private[_-]?key|credential)/i;

export function parameterNames(ctx: GenContext, id: string): { bucket: string; key: string } {
  const base = ctx.logicalId(id);
  return { bucket: `${base}CodeBucket`, key: `${base}CodeKey` };
}

export function envParameterName(ctx: GenContext, id: string, envName: string): string {
  const safe = envName.replace(/[^A-Za-z0-9]+/g, ' ');
  const pascal = safe
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('');
  return `${ctx.logicalId(id)}Env${pascal || 'Value'}`;
}

export function isSecretishEnvName(name: string): boolean {
  return SECRETISH.test(name);
}

export function emitFunction(ctx: GenContext, id: string): RuleResult {
  const run = new RuleRun(ctx, id, 'compute/lambda-function@1');
  const { t } = run;
  const out = ctx.out;
  const v = ctx.varName(id);
  const logical = ctx.logicalId(id);
  const key = quote(run.r.physicalId);
  out.use('lambda');
  out.use('cdk');
  out.use('s3');
  out.use('iam');

  const runtime = t.take<string>('runtime');
  const handler = t.take<string>('handler');
  if (!runtime || !handler) {
    run.unresolve(
      'runtime',
      'Runtime/handler were not observed (container image or missing permission); the function cannot be generated.',
    );
    throw new GenerationError(
      'function-incomplete',
      `Function ${run.r.displayName} has no runtime/handler in the snapshot.`,
    );
  }
  const constant = RUNTIME_CONSTANTS[runtime];
  let runtimeExpr: string;
  if (constant) runtimeExpr = `lambda.Runtime.${constant}`;
  else {
    runtimeExpr = `new lambda.Runtime(${quote(runtime)})`;
    t.approximated(
      'runtime',
      `Runtime ${runtime} has no named constant in this generator; a generic Runtime is used.`,
    );
  }

  const props: string[] = [
    `runtime: ${runtimeExpr},`,
    `handler: ${ctx.str(handler)},`,
    `code: lambda.Code.fromBucket(s3.Bucket.fromBucketName(this, ${ctx.str(`${logical}CodeBucketRef`)}, props.parameters.code[${key}].bucket), props.parameters.code[${key}].key),`,
  ];

  // Immutable role view: CDK must not add statements; the observed IAM policies are the source of truth.
  const roleArn = t.take<string>('roleArn');
  if (!roleArn) {
    run.unresolve('roleArn', 'Execution role was not observed.');
    throw new GenerationError(
      'function-incomplete',
      `Function ${run.r.displayName} has no execution role in the snapshot.`,
    );
  }
  const roleId = ctx.resolveArn(roleArn);
  const roleArnExpr = roleId ? `${ctx.ref(roleId)}.roleArn` : ctx.str(roleArn);
  props.push(
    `role: iam.Role.fromRoleArn(this, ${ctx.str(`${logical}RoleRef`)}, ${roleArnExpr}, { mutable: false }),`,
  );
  if (!roleId)
    t.approximated(
      'roleArn',
      'The execution role is outside this plan and is referenced by ARN, not managed.',
    );

  const memory = t.take<number>('memorySize');
  if (typeof memory === 'number') props.push(`memorySize: ${memory},`);
  const timeout = t.take<number>('timeout');
  if (typeof timeout === 'number') props.push(`timeout: cdk.Duration.seconds(${timeout}),`);
  const arch = t.take<string[]>('architectures');
  if (arch?.[0] === 'arm64') props.push('architecture: lambda.Architecture.ARM_64,');
  const description = t.take<string>('description');
  if (description) props.push(`description: ${ctx.str(description)},`);
  const tracing = t.take<string>('tracingMode');
  if (tracing === 'Active') props.push('tracing: lambda.Tracing.ACTIVE,');
  else if (tracing === 'PassThrough') props.push('tracing: lambda.Tracing.PASS_THROUGH,');
  const ephemeral = t.take<number>('ephemeralStorageSize');
  if (typeof ephemeral === 'number' && ephemeral !== 512)
    props.push(`ephemeralStorageSize: cdk.Size.mebibytes(${ephemeral}),`);
  const concurrency = t.take<number>('reservedConcurrentExecutions');
  if (typeof concurrency === 'number') props.push(`reservedConcurrentExecutions: ${concurrency},`);
  t.take('packageType');

  const layers = t.take<string[]>('layers') ?? [];
  if (layers.length > 0) {
    props.push(
      `layers: [${layers.map((arn, i) => `lambda.LayerVersion.fromLayerVersionArn(this, ${ctx.str(`${logical}Layer${i + 1}`)}, ${ctx.str(arn)})`).join(', ')}],`,
    );
  }

  const envNames = t.take<string[]>('environmentVariableNames') ?? [];
  if (envNames.length > 0) {
    props.push(`environment: props.parameters.environment[${key}],`);
    t.approximated(
      'environmentVariableNames',
      'Names kept; values are never collected and come from CloudFormation parameters.',
    );
  }

  run.header();
  out.line(`const ${v} = new lambda.Function(this, ${ctx.str(logical)}, {`);
  for (const p of props) out.line(`  ${p}`);
  out.line('});');

  const mappings = t.take<EventSourceMapping[]>('eventSourceMappings') ?? [];
  mappings.forEach((m, i) => emitEventSource(ctx, run, v, m, i));
  emitBucketNotifications(ctx, run, id, v);

  run.tags(v);
  run.register('functions', v);
  return run.result('L2');
}

function emitEventSource(
  ctx: GenContext,
  run: RuleRun,
  fn: string,
  m: EventSourceMapping,
  index: number,
): void {
  const out = ctx.out;
  const arn = m.eventSourceArn ?? '';
  const opts: string[] = [];
  if (typeof m.batchSize === 'number') opts.push(`batchSize: ${m.batchSize},`);
  if (typeof m.maximumBatchingWindowInSeconds === 'number') {
    opts.push(`maxBatchingWindow: cdk.Duration.seconds(${m.maximumBatchingWindowInSeconds}),`);
  }
  if (m.enabled === false) opts.push('enabled: false,');

  const queueId = ctx.resolveArn(arn);
  if (queueId && ctx.entry(queueId).resource.type === 'AWS::SQS::Queue') {
    out.use('eventsources');
    out.line(
      `${fn}.addEventSource(new eventsources.SqsEventSource(${ctx.ref(queueId)}, { ${opts.join(' ').replace(/,$/, '')} }));`,
    );
    return;
  }
  const streamMatch = /^(arn:[^:]+:dynamodb:[^:]*:\d{12}:table\/[^/]+)\/stream\//.exec(arn);
  const tableId = streamMatch ? ctx.resolveArn(streamMatch[1]) : undefined;
  if (tableId && ctx.entry(tableId).resource.type === 'AWS::DynamoDB::Table') {
    out.use('eventsources');
    out.use('lambda');
    const position = m.startingPosition === 'TRIM_HORIZON' ? 'TRIM_HORIZON' : 'LATEST';
    if (m.startingPosition && m.startingPosition !== position) {
      run.unresolve(
        `eventSourceMappings[${index}].startingPosition`,
        `Starting position ${m.startingPosition} is not mapped; LATEST was not assumed silently—review it.`,
      );
    }
    out.line(
      `${fn}.addEventSource(new eventsources.DynamoEventSource(${ctx.ref(tableId)}, { startingPosition: lambda.StartingPosition.${position}, ${opts.join(' ')} }));`,
    );
    return;
  }
  run.unresolve(
    `eventSourceMappings[${index}]`,
    `Event source ${arn || '(unknown)'} is not an SQS queue or DynamoDB stream in this plan; wire this trigger manually.`,
  );
}

interface BucketNotification {
  id?: string;
  events?: string[];
  prefix?: string;
  suffix?: string;
  lambdaArn?: string;
}

const S3_EVENTS: Record<string, string> = {
  's3:ObjectCreated:*': 'OBJECT_CREATED',
  's3:ObjectRemoved:*': 'OBJECT_REMOVED',
};

/**
 * S3 -> Lambda notifications are wired where the function is created. Only buckets this plan owns are touched:
 * adding a notification to an imported bucket could overwrite its existing notification configuration.
 */
function emitBucketNotifications(ctx: GenContext, run: RuleRun, fnId: string, fnVar: string): void {
  const out = ctx.out;
  const fnArn = ctx.entry(fnId).resource.arn;
  for (const entry of ctx.byId.values()) {
    if (entry.resource.type !== 'AWS::S3::Bucket') continue;
    const notes =
      (entry.resource.observedProperties['notifications'] as BucketNotification[] | undefined) ??
      [];
    for (const n of notes) {
      if (!fnArn || n.lambdaArn !== fnArn) continue;
      const bucketId = entry.resource.id;
      const note = (status: 'preserved' | 'unresolved', text: string) =>
        ctx.overrides.set(bucketId, [
          ...(ctx.overrides.get(bucketId) ?? []),
          { name: 'notifications', status, note: text },
        ]);
      const events = n.events ?? [];
      const mapped = events.map((e) => S3_EVENTS[e]);
      if (!entry.owned) {
        note(
          'unresolved',
          'The bucket is referenced, not managed; its notification was NOT touched to avoid overwriting existing configuration.',
        );
        run.unresolve(
          `notifications(${entry.resource.displayName})`,
          'Bucket is referenced; notification wiring skipped on purpose.',
        );
        continue;
      }
      if (mapped.length === 0 || mapped.some((m) => !m)) {
        note('unresolved', `Unsupported S3 event type(s): ${events.join(', ')}.`);
        run.unresolve(
          `notifications(${entry.resource.displayName})`,
          `Unsupported S3 event type(s): ${events.join(', ')}.`,
        );
        continue;
      }
      out.use('s3');
      out.use('s3n');
      const filter = [
        n.prefix ? `prefix: ${ctx.str(n.prefix)}` : '',
        n.suffix ? `suffix: ${ctx.str(n.suffix)}` : '',
      ]
        .filter(Boolean)
        .join(', ');
      for (const e of [...new Set(mapped as string[])]) {
        out.line(
          `${ctx.ref(bucketId)}.addEventNotification(s3.EventType.${e}, new s3n.LambdaDestination(${fnVar})${filter ? `, { ${filter} }` : ''});`,
        );
      }
      note(
        'preserved',
        'Wired in the compute construct via the CDK bucket-notification custom resource (adds a helper Lambda).',
      );
    }
  }
}

export { isIdentifier };
